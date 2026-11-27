// صيدليات الكريم — notify-dispatch
// Sends the waiting notifications (table «notifications») to the phones that allowed them (Web Push).
// The database timer (notif_tick, every minute) calls it with a secret header; nobody else can.
// The first call creates the VAPID keys and keeps them in «notif_private» — no key to copy anywhere.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function getPrivate(k: string): Promise<string | null> {
  const { data } = await sb.from("notif_private").select("v").eq("k", k).maybeSingle();
  return data?.v ?? null;
}

Deno.serve(async (req) => {
  const secret = await getPrivate("cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);

  let pub = await getPrivate("vapid_public");
  let prv = await getPrivate("vapid_private");
  if (!pub || !prv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; prv = k.privateKey;
    await sb.from("notif_private").upsert([{ k: "vapid_private", v: prv }, { k: "vapid_public", v: pub }]);
  }
  webpush.setVapidDetails(Deno.env.get("SUPABASE_URL")!, pub, prv);

  const { data: rows, error } = await sb.from("notifications")
    .select("id,user_id,kind,title,body,url")
    .is("push_sent_at", null).lte("send_after", new Date().toISOString())
    .order("id").limit(300);
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0, waiting: 0 });

  const { data: subs } = await sb.from("push_subscriptions")
    .select("id,user_id,endpoint,p256dh,auth")
    .in("user_id", [...new Set(rows.map((r) => r.user_id))]);

  let sent = 0;
  const dead = new Set<number>();
  for (const r of rows) {
    const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url || "./", tag: `${r.kind}-${r.id}` });
    const mine = (subs || []).filter((s) => s.user_id === r.user_id && !dead.has(s.id));
    await Promise.all(mine.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { TTL: 24 * 3600, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.add(s.id);   // the phone removed the permission / uninstalled
      }
    }));
  }
  await sb.from("notifications").update({ push_sent_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
  if (dead.size) await sb.from("push_subscriptions").delete().in("id", [...dead]);
  return json({ sent, notifications: rows.length, removed: dead.size });
});

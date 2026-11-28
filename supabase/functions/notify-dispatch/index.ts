// صيدليات الكريم — notify-dispatch
// Sends the waiting notifications (table «notifications») to:
//   • the phones that allowed them (Web Push), and
//   • Telegram, for everyone who linked it (free) — when the secret TELEGRAM_BOT_TOKEN is set.
// The database timer (notif_tick, every minute) calls it with a secret header; nobody else can.
// The first call creates the VAPID keys and keeps them in «notif_private» — no key to copy anywhere.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const TG = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function getPrivate(k: string): Promise<string | null> {
  const { data } = await sb.from("notif_private").select("v").eq("k", k).maybeSingle();
  return data?.v ?? null;
}
const setPrivate = (k: string, v: string) => sb.from("notif_private").upsert({ k, v });

async function tg(method: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json() as { ok: boolean; result?: any; error_code?: number; description?: string };
}

// «Start» pressed in the bot: link that Telegram chat to the app user who asked for the code
async function telegramLinks() {
  if (!(await getPrivate("tg_bot"))) {
    const me = await tg("getMe");
    if (me.ok) await setPrivate("tg_bot", me.result.username);
  }
  let offset = Number(await getPrivate("tg_offset") || 0);
  const up = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
  if (!up.ok || !up.result?.length) return;
  for (const u of up.result) {
    offset = u.update_id + 1;
    const m = u.message;
    const text = String(m?.text || "");
    if (!m?.chat?.id || !text.startsWith("/start")) continue;
    const code = text.split(/\s+/)[1] || "";
    const { data: link } = code
      ? await sb.from("tg_links").select("code,user_id,created_at,used_at").eq("code", code).maybeSingle()
      : { data: null };
    const fresh = link && !link.used_at && Date.now() - new Date(link.created_at).getTime() < 15 * 60 * 1000;
    if (!fresh) {
      await tg("sendMessage", { chat_id: m.chat.id, text: "افتح تطبيق صيدليات الكريم ← 🔔 ← «✈️ ربط تيليجرام» ثم اضغط Start هنا." });
      continue;
    }
    await sb.from("tg_chats").upsert({
      user_id: link.user_id, chat_id: m.chat.id,
      tg_name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || null, linked_at: new Date().toISOString(),
    });
    await sb.from("tg_links").update({ used_at: new Date().toISOString() }).eq("code", code);
    await tg("sendMessage", { chat_id: m.chat.id, text: "✅ تم ربط حسابك — ستصلك إشعارات صيدليات الكريم هنا." });
  }
  await setPrivate("tg_offset", String(offset));
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
  if (TG) { try { await telegramLinks(); } catch (e) { console.error("telegram links", e); } }

  const { data: rows, error } = await sb.from("notifications")
    .select("id,user_id,kind,title,body,url")
    .is("push_sent_at", null).lte("send_after", new Date().toISOString())
    .order("id").limit(300);
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0, waiting: 0 });

  const users = [...new Set(rows.map((r) => r.user_id))];
  const { data: subs } = await sb.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", users);
  const { data: chats } = TG ? await sb.from("tg_chats").select("user_id,chat_id").in("user_id", users) : { data: [] };
  const site = TG ? await getPrivate("site_url") : null;

  let sent = 0, telegram = 0;
  const dead = new Set<number>(), gone = new Set<string>(), tgDone: number[] = [];
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
    const chat = (chats || []).find((c) => c.user_id === r.user_id && !gone.has(r.user_id));
    if (chat) {
      let button: unknown = undefined;
      try { if (site) button = { inline_keyboard: [[{ text: "فتح التطبيق", url: new URL(r.url || "./", site).href }]] }; } catch { /* no button */ }
      const res = await tg("sendMessage", {
        chat_id: chat.chat_id, parse_mode: "HTML", disable_web_page_preview: true,
        text: `<b>${esc(r.title)}</b>\n${esc(r.body)}`, reply_markup: button,
      });
      if (res.ok) { telegram++; tgDone.push(r.id); }
      else if (res.error_code === 403) { gone.add(r.user_id); await sb.from("tg_chats").delete().eq("user_id", r.user_id); }  // blocked the bot
    }
  }
  const now = new Date().toISOString();
  await sb.from("notifications").update({ push_sent_at: now }).in("id", rows.map((r) => r.id));
  if (tgDone.length) await sb.from("notifications").update({ tg_sent_at: now }).in("id", tgDone);
  if (dead.size) await sb.from("push_subscriptions").delete().in("id", [...dead]);
  return json({ sent, telegram, notifications: rows.length, removed: dead.size });
});

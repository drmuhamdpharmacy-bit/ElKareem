// ════════════════════════════════════════════════════════════════════
//  صيدليات الكريم — الإشعارات (🔔 inside the app + phone notifications)
//  Table «notifications» (supabase-notifications.sql). Phones get them through the
//  «notify-dispatch» Edge Function; quiet hours 22:00–09:00 are handled by the database.
//  Uses the app's globals: sb, state, render, showToast, esc.
// ════════════════════════════════════════════════════════════════════
const NOTIF = (() => {
  const S = {rows: [], open: false, loaded: false, channel: null, pushState: null, pendingPage: null, tg: null, tgWait: 0};
  const uid = () => state.user && state.user.id;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const unread = () => S.rows.filter((r) => !r.read_at).length;
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'الآن'; if (m < 60) return `منذ ${m} د`;
    const h = Math.round(m / 60); if (h < 24) return `منذ ${h} س`;
    return new Date(t).toLocaleDateString('ar-EG', {day: 'numeric', month: 'short'});
  };

  // ---------------------------------------------------------------- deep links (?p=page) from a notification
  (() => { const p = new URLSearchParams(location.search).get('p'); if (p && /^[a-z_]{2,30}$/.test(p)) { S.pendingPage = p; history.replaceState(null, '', location.pathname); } })();
  function openUrl(url) {
    try { const p = new URL(url, location.href).searchParams.get('p'); if (p) { state.page = p; state.modal = null; } } catch {}
    S.open = false; render(); window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- service worker (needed for phone notifications)
  let swReg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch((e) => console.warn('sw', e));
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') openUrl(e.data.url); });
  }

  async function refreshPushState() {
    if (!pushSupported()) { S.pushState = isIOS() && !standalone() ? 'ios-install' : 'unsupported'; return; }
    if (Notification.permission === 'denied') { S.pushState = 'blocked'; return; }
    const reg = swReg || await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    S.pushState = sub && Notification.permission === 'granted' ? 'on' : 'off';
  }
  const b64ToBytes = (s) => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

  async function enablePush() {
    try {
      if (!pushSupported()) { S.pushState = isIOS() && !standalone() ? 'ios-install' : 'unsupported'; render(); return; }
      const {data: key, error: ke} = await sb.rpc('push_public_key');
      if (ke || !key) { showToast('نظام الإشعارات لم يكتمل إعداده بعد — حاول بعد دقيقتين', 'error'); return; }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { S.pushState = perm === 'denied' ? 'blocked' : 'off'; render(); showToast('لم يتم السماح بالإشعارات', 'error'); return; }
      const reg = swReg || await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64ToBytes(key)});
      const j = sub.toJSON();
      const {error} = await sb.rpc('push_subscribe', {p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent});
      if (error) throw error;
      S.pushState = 'on'; render(); showToast('تم تفعيل الإشعارات على هذا الجهاز ✓');
    } catch (e) { console.error(e); showToast('تعذّر تفعيل الإشعارات: ' + (e.message || e), 'error'); }
  }
  async function disablePush() {
    try {
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await sb.rpc('push_unsubscribe', {p_endpoint: sub.endpoint}); await sub.unsubscribe(); }
      S.pushState = 'off'; render(); showToast('تم إيقاف الإشعارات على هذا الجهاز');
    } catch (e) { showToast(String(e.message || e), 'error'); }
  }

  // ---------------------------------------------------------------- Telegram (free messages)
  async function refreshTg() { const {data, error} = await sb.rpc('tg_status'); S.tg = error ? null : data; }
  async function linkTelegram() {
    const w = window.open('', '_blank');   // opened now (inside the tap) so the browser does not block it
    const {data, error} = await sb.rpc('tg_link_start', {p_site: location.origin + location.pathname});
    if (error) { if (w) w.close(); showToast(/tg_not_ready/.test(error.message) ? 'تيليجرام لم يُفعَّل بعد من الإدارة' : String(error.message), 'error'); return; }
    const url = `https://t.me/${data.bot}?start=${data.code}`;
    if (w) w.location.href = url; else location.href = url;
    showToast('اضغط «Start» في تيليجرام — يتم الربط خلال دقيقة', 'info');
    const t0 = Date.now(); S.tgWait = t0;
    const poll = async () => {
      if (S.tgWait !== t0 || Date.now() - t0 > 4 * 60 * 1000) return;
      await refreshTg();
      if (S.tg && S.tg.linked) { S.tgWait = 0; render(); showToast('✅ تم ربط تيليجرام — ستصلك الإشعارات هناك'); return; }
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 5000);
  }
  async function unlinkTelegram() {
    if (!confirm('إلغاء ربط تيليجرام؟ لن تصلك الإشعارات هناك.')) return;
    await sb.rpc('tg_unlink'); await refreshTg(); render(); showToast('تم إلغاء ربط تيليجرام');
  }
  function tgBox() {
    if (!S.tg || !S.tg.ready) return '';
    return `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)">${S.tg.linked
      ? '<div style="font-size:12px;color:#0369a1;display:flex;justify-content:space-between;align-items:center;gap:6px">✈️ تيليجرام مربوط — تصلك الإشعارات هناك أيضاً <button class="btn btn-ghost btn-xs" id="tg-unlink">إلغاء</button></div>'
      : `<button class="btn btn-ghost btn-sm" id="tg-link" style="width:100%;border-color:#229ED9;color:#0369a1">✈️ ربط تيليجرام — رسائل مجانية على تيليجرام</button>${S.tgWait ? '<div style="font-size:11px;color:var(--text3);margin-top:4px;text-align:center">⏳ في انتظار ضغط «Start» في تيليجرام…</div>' : ''}`}</div>`;
  }

  // ---------------------------------------------------------------- the list
  async function load() {
    if (!uid()) return;
    const {data, error} = await sb.from('notifications').select('id,kind,title,body,url,created_at,read_at')
      .order('created_at', {ascending: false}).limit(40);
    if (error) { S.loaded = 'missing'; return; }   // supabase-notifications.sql not run yet: the bell stays quiet
    S.rows = data || []; S.loaded = true;
  }
  function onLogin() {
    S.rows = []; S.open = false; S.loaded = false;
    load().then(() => render());
    refreshPushState().then(() => {
      render();
      if (S.pushState === 'off' && state.user.role !== 'kiosk' && !sessionStorage.getItem('ek_notif_hint')) {
        sessionStorage.setItem('ek_notif_hint', '1');
        setTimeout(() => showToast('🔔 فعّل الإشعارات ليصلك كل جديد — اضغط الجرس أعلى الصفحة'), 2500);
      }
    });
    if (S.pendingPage) { state.page = S.pendingPage; S.pendingPage = null; }
    try {
      if (S.channel) sb.removeChannel(S.channel);
      S.channel = sb.channel('notif-' + uid()).on('postgres_changes',
        {event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + uid()},
        (p) => { S.rows.unshift(p.new); S.rows = S.rows.slice(0, 40); if (!state.modal) render(); showToast('🔔 ' + p.new.title); }).subscribe();
    } catch (e) { console.warn(e); }
  }
  function reset() { if (S.channel) { try { sb.removeChannel(S.channel); } catch {} } S.channel = null; S.rows = []; S.open = false; S.loaded = false; }

  async function markRead(id) {
    const r = S.rows.find((x) => x.id === id); if (r && !r.read_at) r.read_at = new Date().toISOString();
    await sb.rpc('notif_mark_read', {p_id: id ?? null});
    if (id == null) S.rows.forEach((x) => { x.read_at = x.read_at || new Date().toISOString(); });
  }

  // ---------------------------------------------------------------- UI
  function bell() {
    if (!state.user || state.user.role === 'kiosk' || S.loaded === 'missing') return '';
    const n = unread(), off = S.pushState === 'off' || S.pushState === 'ios-install';
    return `<button class="btn btn-ghost btn-sm" id="notif-bell" title="الإشعارات" style="position:relative;font-size:16px;padding:6px 10px">🔔${n ? `<span style="position:absolute;top:-4px;left:-4px;background:var(--danger);color:#fff;border-radius:10px;font-size:10px;padding:1px 6px;font-weight:800">${n > 9 ? '9+' : n}</span>` : off ? '<span style="position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--gold)"></span>' : ''}</button>`;
  }
  function pushBox() {
    const st = S.pushState;
    if (st === 'on') return `<div style="font-size:12px;color:#15803d;display:flex;justify-content:space-between;align-items:center;gap:6px">✅ الإشعارات مفعّلة على هذا الجهاز <button class="btn btn-ghost btn-xs" id="notif-off">إيقاف</button></div>`;
    if (st === 'off') return `<button class="btn btn-primary btn-sm" id="notif-on" style="width:100%">🔔 تفعيل الإشعارات على هذا الجهاز</button>`;
    if (st === 'blocked') return `<div style="font-size:12px;color:var(--danger)">الإشعارات محظورة لهذا الموقع. افتح إعدادات المتصفح ← الموقع ← الإشعارات ← «سماح»، ثم أعد فتح الصفحة.</div>`;
    if (st === 'ios-install') return `<div style="font-size:12px;line-height:1.7;background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.3);border-radius:8px;padding:8px 10px"><strong>📱 على الآيفون:</strong> الإشعارات تعمل فقط بعد إضافة الموقع للشاشة الرئيسية:<br>1. افتح الموقع في <strong>Safari</strong>.<br>2. اضغط زر المشاركة <strong>⬆️</strong> ← <strong>«إضافة إلى الشاشة الرئيسية»</strong>.<br>3. افتح التطبيق من الأيقونة الجديدة، ثم اضغط 🔔 ← «تفعيل الإشعارات».<br><span style="color:var(--text3)">يحتاج iOS 16.4 أو أحدث.</span></div>`;
    if (st === 'unsupported') return `<div style="font-size:12px;color:var(--text3)">هذا المتصفح لا يدعم إشعارات الهاتف — استخدم Chrome على أندرويد. الإشعارات تظهر هنا داخل التطبيق دائماً.</div>`;
    return '';
  }
  function panel() {
    if (!S.open) return '';
    return `<div id="notif-panel" style="position:fixed;top:64px;left:12px;width:min(380px,calc(100vw - 24px));max-height:75vh;overflow:auto;background:var(--bg2);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);z-index:500;padding:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><strong>🔔 الإشعارات</strong><div style="display:flex;gap:6px">${unread() ? '<button class="btn btn-ghost btn-xs" id="notif-readall">تعليم الكل كمقروء</button>' : ''}<button class="btn btn-ghost btn-xs" id="notif-close">✕</button></div></div>
      <div style="margin-bottom:10px">${pushBox()}${tgBox()}</div>
      ${S.rows.length ? S.rows.map((r) => `<div class="notif-item" data-notif="${r.id}" style="padding:10px;border-radius:10px;margin-bottom:6px;cursor:pointer;background:${r.read_at ? 'transparent' : 'rgba(59,110,245,.07)'};border:1px solid ${r.read_at ? 'var(--border)' : 'rgba(59,110,245,.25)'}">
          <div style="display:flex;justify-content:space-between;gap:8px"><strong style="font-size:13px">${esc(r.title)}</strong><span style="font-size:11px;color:var(--text3);white-space:nowrap">${ago(r.created_at)}</span></div>
          <div style="font-size:12px;color:var(--text2);margin-top:3px;line-height:1.6">${esc(r.body)}</div></div>`).join('')
        : '<p style="color:var(--text3);font-size:13px;text-align:center;padding:20px 0">لا توجد إشعارات بعد</p>'}
    </div>`;
  }
  function bind() {
    const b = document.getElementById('notif-bell');
    if (b) b.onclick = (e) => { e.stopPropagation(); S.open = !S.open; if (S.open) { load().then(render); refreshPushState().then(render); refreshTg().then(render); } render(); };
    document.getElementById('notif-close')?.addEventListener('click', () => { S.open = false; render(); });
    document.getElementById('notif-on')?.addEventListener('click', enablePush);
    document.getElementById('notif-off')?.addEventListener('click', disablePush);
    document.getElementById('tg-link')?.addEventListener('click', linkTelegram);
    document.getElementById('tg-unlink')?.addEventListener('click', unlinkTelegram);
    bindCoverage();
    document.getElementById('notif-readall')?.addEventListener('click', async () => { await markRead(null); render(); });
    document.querySelectorAll('.notif-item').forEach((el) => {
      el.onclick = async () => { const id = +el.dataset.notif, r = S.rows.find((x) => x.id === id); await markRead(id); if (r && r.url) openUrl(r.url); else render(); };
    });
  }

  // ---------------------------------------------------------------- sending (owner / supervisor actions)
  function send(empId, kind, title, body, url, ref) {
    if (!empId || !sb) return;
    sb.rpc('notify_emp', {p_emp: empId, p_branch: state.branch, p_kind: kind, p_title: title, p_body: body, p_url: url || null, p_ref: ref || null})
      .then(({error}) => { if (error && !/function .* does not exist|schema cache/i.test(error.message)) console.warn('notify', error.message); });
  }

  // ---------------------------------------------------------------- who turned notifications on (owner / supervisors)
  const cov = {};   // branch → rows | 'loading' | 'missing'
  function loadCoverage(force) {
    const br = state.branch; if (!br || (!force && cov[br])) return;
    cov[br] = 'loading';
    sb.rpc('notif_coverage', {p_branch: br}).then(({data, error}) => { cov[br] = error ? 'missing' : (data || []); render(); });
  }
  function coverageCard() {
    if (!state.user || !['owner', 'senior'].includes(state.user.role)) return '';
    loadCoverage(false);
    const rows = cov[state.branch];
    if (rows === 'missing') return '';
    const ok = (r) => r.push_devices > 0 || r.telegram;
    const yes = (t) => `<span class="badge badge-green">✅ ${t}</span>`, no = '<span class="badge badge-gray">—</span>';
    const body = !Array.isArray(rows) ? '<p style="color:var(--text3);font-size:13px">⏳ جاري التحميل…</p>'
      : !rows.length ? '<p style="color:var(--text3);font-size:13px">لا يوجد موظفون في هذا الفرع</p>'
      : `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>إشعارات الموبايل</th><th>تيليجرام</th><th>الحالة</th></tr></thead><tbody>${[...rows].sort((a, b) => ok(a) - ok(b)).map((r) => `<tr>
          <td style="font-weight:700">${esc(r.name || r.emp_id)}</td>
          <td>${r.push_devices > 0 ? yes(r.push_devices > 1 ? r.push_devices + ' أجهزة' : 'مفعّلة') : no}</td>
          <td>${r.telegram ? yes('مربوط') : no}</td>
          <td>${!r.has_account ? '<span class="badge badge-red">⚠️ ليس له حساب</span>' : ok(r) ? '<span class="badge badge-green">تصله الإشعارات</span>' : '<span class="badge badge-red">❌ لم يفعّل شيئاً</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    const n = Array.isArray(rows) ? rows.filter(ok).length : 0, t = Array.isArray(rows) ? rows.length : 0;
    return `<div class="card" style="margin-bottom:16px"><div class="section-header"><h3>📶 من فعّل الإشعارات؟ ${Array.isArray(rows) && t ? `<span class="badge ${n === t ? 'badge-green' : 'badge-gold'}" style="margin-right:6px">${n} من ${t}</span>` : ''}</h3><button class="btn btn-ghost btn-sm" id="notif-cov-refresh">🔄 تحديث</button></div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:10px">كل موظف يفعّل بنفسه من حسابه: 🔔 ← «تفعيل الإشعارات على هذا الجهاز» و/أو «✈️ ربط تيليجرام». من لم يفعّل شيئاً يرى الإشعارات فقط عند فتح التطبيق.</p>${body}</div>`;
  }
  function bindCoverage() { document.getElementById('notif-cov-refresh')?.addEventListener('click', () => loadCoverage(true)); }

  return {bell, panel, bind, onLogin, reset, send, openUrl, coverageCard, bindCoverage, _S: S};
})();

// ════════════════════════════════════════════════════════════════════
//  صيدليات الكريم — متابعة العملاء (CRM)
//  Follow-up of chronic patients, prescriptions and personal-care products.
//  Loaded BEFORE the main script; it only uses the main script's globals
//  (state, sb, render, lazy, cache, esc, showToast, …) when it runs.
//  Database: supabase-crm-setup.sql (crm_* tables and functions).
// ════════════════════════════════════════════════════════════════════
const CRM = (() => {
  // ---------------------------------------------------------------- constants
  const CARE = {
    chronic:       {label: 'مرض مزمن',            short: 'مزمن',        icon: '🫀', cls: 'badge-red'},
    prescription:  {label: 'روشتة / كورس علاج',   short: 'روشتة',       icon: '💊', cls: 'badge-blue'},
    personal_care: {label: 'عناية شخصية',         short: 'عناية شخصية', icon: '🧴', cls: 'badge-pink'},
    other:         {label: 'أخرى',                short: 'أخرى',        icon: '📦', cls: 'badge-gray'},
  };
  const STATUS = {
    open: ['مفتوحة', 'badge-blue'], postponed: ['مؤجلة', 'badge-gold'], done: ['تمت', 'badge-green'],
    no_answer: ['لا يرد', 'badge-red'], cancelled: ['ملغاة', 'badge-gray'],
  };
  const OUTCOMES = {
    chronic: ['تم صرف العلاج', 'مستمر على العلاج', 'يحتاج إعادة شراء', 'غيّر الطبيب العلاج', 'يحتاج زيارة طبيب', 'أوقف العلاج'],
    prescription: ['تحسن', 'لم يتحسن', 'أكمل الكورس', 'يحتاج زيارة طبيب', 'أوقف العلاج'],
    personal_care: ['راضٍ عن النتيجة', 'غير راضٍ', 'يحتاج إعادة شراء', 'يحتاج منتجاً آخر', 'أوقف الاستخدام'],
    other: ['تم', 'يحتاج متابعة', 'غير متأكد'],
  };
  const CHANNELS = ['اتصال', 'واتساب', 'زيارة داخل الصيدلية', 'رسالة SMS'];
  const PAGES = {
    crm_followups: {label: 'متابعات العملاء', icon: '📞'},
    crm_customers: {label: 'العملاء', icon: '🧑‍⚕️'},
    crm_customer:  {label: 'ملف العميل', icon: '🗂️', hidden: true},
    crm_dashboard: {label: 'لوحة المتابعة', icon: '📈', staff: true},
    crm_settings:  {label: 'إعدادات المتابعة', icon: '🛠️', owner: true},
  };
  const ERR = {
    not_allowed: 'غير مسموح لك بهذا الإجراء', date_in_past: 'اختر تاريخاً اليوم أو بعده',
    same_customer: 'لا يمكن دمج العميل مع نفسه', crm_customers_erp_id_key: 'رقم العميل (ERP) مسجل لعميل آخر',
    crm_customers_name_check: 'اسم العميل قصير جداً', crm_customers_gender_check: 'قيمة الجنس غير صحيحة',
    crm_protocols_name_key: 'يوجد بروتوكول بنفس الاسم',
  };

  // view state (kept between renders)
  const S = {
    fu: {scope: 'now', branch: undefined, emp: '', type: '', q: '', mine: false},
    cust: {q: '', filter: '', branch: ''},
    custId: null, tab: 'followups', dashBranch: undefined, focus: null,
    kpi: {}, kpiYear: null, kpiLoading: false, imp: null,
  };

  // ---------------------------------------------------------------- helpers
  const isStaffU = () => typeof isStaff === 'function' && isStaff();
  const isOwnerU = () => typeof isOwner === 'function' && isOwner();
  const canUse = () => !!state.user && ['owner', 'senior', 'employee'].includes(state.user.role);
  const todayISO = () => cairo(Date.now()).date;
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtD = iso => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
  const fmtDT = ts => { if (!ts) return '—'; const c = cairo(ts); return `${fmtD(c.date)} ${c.time}`; };
  const crmErr = e => { const m = (e && (e.message || e.details)) || String(e); for (const k in ERR) if (m.includes(k)) return ERR[k]; return errMsg(e); };
  const v = id => (document.getElementById(id)?.value ?? '').trim();
  const checked = id => !!document.getElementById(id)?.checked;
  const ar2en = s => String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  function normPhone(p) {
    let d = ar2en(p).replace(/\D/g, '');
    if (d.startsWith('0020')) d = '0' + d.slice(4); else if (d.startsWith('20') && d.length === 12) d = '0' + d.slice(2);
    if (d.length === 10 && /^1[0125]/.test(d)) d = '0' + d;
    return d;
  }
  const validMobile = p => /^01[0125]\d{8}$/.test(normPhone(p));
  const telLink = p => validMobile(p) ? `tel:${normPhone(p)}` : '';
  const waLink = p => validMobile(p) ? `https://wa.me/2${normPhone(p)}` : '';
  async function rpc(fn, args) { const {data, error} = await sb.rpc(fn, args || {}); if (error) throw error; return data; }
  function load(name, key, fn) {
    return lazy(name, key, async () => { const rows = await fn(); cache[name] = {key, rows}; return rows; });
  }
  function invalidate() { Object.keys(cache).forEach(k => { if (k.startsWith('crm_')) delete cache[k]; }); }
  function refresh(msg) { invalidate(); state.modal = null; render(); if (msg) showToast(msg); scheduleKpi(); }
  async function act(fn, okMsg) {
    try { await fn(); refresh(okMsg); } catch (e) { console.error(e); showToast(crmErr(e), 'error'); }
  }
  function branchList() {
    if (typeof branches !== 'undefined' && branches.length) return branches.filter(b => b.id);
    if (S.branches) return S.branches;
    if (!S.branchesLoading) { S.branchesLoading = true; rpc('crm_branches').then(r => { S.branches = r || []; render(); }).catch(() => { S.branches = []; }); }
    return [{id: state.branch, name: state.branch}].filter(b => b.id);
  }
  const bName = id => (branchList().find(b => b.id === id) || {}).name || (typeof branchName === 'function' ? branchName(id) : id) || '';
  const branchOpts = (sel, allLabel) => (allLabel ? `<option value="">${allLabel}</option>` : '') +
    branchList().map(b => `<option value="${esc(b.id)}"${b.id === sel ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  function staffList() {
    if (isStaffU()) { try { return allEmployees().filter(e => !e.leftMk); } catch { return employees || []; } }
    return state.user.empId ? [{id: state.user.empId, name: state.user.name}] : [];
  }
  function empName(id) {
    if (!id) return '—';
    if (id === state.user?.empId) return 'أنا';
    const e = staffList().find(x => x.id === id);
    return e ? e.name : id;
  }
  const careBadge = t => t && CARE[t] ? `<span class="badge ${CARE[t].cls}">${CARE[t].icon} ${CARE[t].short}</span>` : '';
  const statusBadge = s => `<span class="badge ${(STATUS[s] || ['', 'badge-gray'])[1]}">${(STATUS[s] || [s])[0]}</span>`;
  function dueBadge(due, status) {
    if (!['open', 'postponed'].includes(status)) return `<span style="color:var(--text3)">${fmtD(due)}</span>`;
    const late = Math.round((new Date(todayISO()) - new Date(String(due).slice(0, 10))) / 864e5);
    if (late > 7) return `<span class="badge badge-red">متأخرة ${late} يوم</span>`;
    if (late > 0) return `<span class="badge badge-gold">متأخرة ${late} يوم</span>`;
    if (late === 0) return `<span class="badge badge-blue">اليوم</span>`;
    return `<span class="badge badge-gray">${fmtD(due)}</span>`;
  }
  const empty = (text, icon = '📭') => `<div class="card" style="text-align:center;color:var(--text3);padding:34px"><div style="font-size:30px;margin-bottom:8px">${icon}</div>${text}</div>`;
  const errorCard = name => cache[name]?.error ? `<div class="card" style="color:var(--danger)">⚠️ ${esc(cache[name].error)}<div style="font-size:12px;color:var(--text3);margin-top:6px">إذا ظهرت هذه الرسالة لأول مرة: يجب تشغيل ملف supabase-crm-setup.sql في Supabase.</div></div>` : '';
  const sel = (id, opts, cur, attrs = '') => `<select id="${id}" ${attrs}>${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(cur ?? '') ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  const field = (label, html, extra = '') => `<div class="form-group" ${extra}><label>${label}</label>${html}</div>`;
  const STYLE = `<style id="crm-style">
    .crm-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
    .crm-tab{padding:7px 14px;border-radius:20px;border:1px solid var(--border2);background:var(--bg2);cursor:pointer;font-size:12px;font-weight:700;color:var(--text2);font-family:inherit}
    .crm-tab.on{background:var(--brand);border-color:var(--brand);color:#fff}
    .crm-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
    .crm-bar input,.crm-bar select{width:auto;min-width:150px}
    .crm-bar .grow{flex:1;min-width:220px}
    .crm-fu{background:var(--card);border:1px solid var(--border);border-radius:var(--radius2);padding:14px;margin-bottom:10px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;box-shadow:var(--shadow2)}
    .crm-fu.late{border-right:4px solid var(--danger)} .crm-fu.warn{border-right:4px solid var(--warn)} .crm-fu.today{border-right:4px solid var(--accent)}
    .crm-fu .who{flex:1;min-width:220px} .crm-fu .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .crm-name{font-weight:800;font-size:15px;cursor:pointer;color:var(--text)} .crm-name:hover{color:var(--accent)}
    .crm-meta{font-size:12px;color:var(--text2);margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .crm-allergy{background:var(--danger2);color:var(--danger);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:800}
    .crm-row{cursor:pointer} .crm-row:hover td{background:var(--bg3)}
    .crm-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px 18px}
    .crm-kv div span{display:block;font-size:11px;color:var(--text3)} .crm-kv div b{font-size:13px}
    .crm-plan{border:1px solid var(--border);border-radius:var(--radius2);padding:12px;margin-bottom:8px;background:var(--card2)}
    .crm-choice{display:flex;gap:8px;flex-wrap:wrap}.crm-choice label{display:flex;align-items:center;gap:6px;border:1px solid var(--border2);border-radius:20px;padding:6px 12px;cursor:pointer;margin:0;font-weight:700;color:var(--text)}
    .crm-choice input{width:auto;margin:0} .crm-hint{font-size:12px;color:var(--text3);margin-top:4px}
    .crm-preview{background:rgba(21,128,61,.07);border:1px solid rgba(21,128,61,.25);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--brand);font-weight:700}
    .crm-warn{background:var(--warn2);border:1px solid rgba(217,119,6,.35);border-radius:8px;padding:10px 12px;font-size:12px;color:#92400e}
  </style>`;
  // styles live in <head> (page content is redrawn on every render)
  const withStyle = html => { if (!document.getElementById('crm-style')) document.head.insertAdjacentHTML('beforeend', STYLE); return html; };

  // ---------------------------------------------------------------- navigation hooks
  function nav(groups) {
    if (!canUse()) return groups;
    const items = Object.entries(PAGES).filter(([, p]) => !p.hidden && (!p.staff || isStaffU()) && (!p.owner || isOwnerU()))
      .map(([id, p]) => ({id, icon: p.icon, label: p.label, badge: id === 'crm_followups' ? (S.dueCount || 0) || '' : ''}));
    const g = {group: 'متابعة العملاء', items};
    const at = groups.findIndex(x => x.group === 'حسابي');
    if (state.user.role === 'employee') return [g, ...groups];
    groups.splice(at < 0 ? groups.length : at + (at === 0 ? 1 : 0), 0, g);   // supervisors have «حسابي» first
    return groups;
  }
  const label = page => PAGES[page]?.label || '';

  function renderPage(page) {
    if (!PAGES[page]) return '';
    if (!canUse()) return empty('غير متاح لهذا الحساب', '🔒');
    if (PAGES[page].staff && !isStaffU()) return '';
    if (PAGES[page].owner && !isOwnerU()) return '';
    let html = '';
    try {
      html = {crm_followups: pageFollowups, crm_customers: pageCustomers, crm_customer: pageCustomer,
              crm_dashboard: pageDashboard, crm_settings: pageSettings}[page]();
    } catch (e) { console.error(e); html = `<div class="card" style="color:var(--danger)">⚠️ ${esc(e.message)}</div>`; }
    return withStyle(html);
  }
  function open(page, extra) { Object.assign(S, extra || {}); state.page = page; render(); window.scrollTo(0, 0); }

  // ---------------------------------------------------------------- page: follow-ups
  function fuBranch() {
    if (S.fu.branch === undefined) S.fu.branch = state.user.role === 'owner' ? '' : (state.branch || state.user.branch || '');
    return S.fu.branch || null;
  }
  function pageFollowups() {
    const f = S.fu, br = fuBranch(), emp = f.mine ? state.user.empId : (f.emp || null);
    const key = [f.scope, br, emp, f.type, f.q].join('|');
    const rows = load('crm_fu', key, () => rpc('crm_followup_list', {p_scope: f.scope, p_branch: br, p_emp: emp, p_q: f.q, p_type: f.type || null}));
    const dash = load('crm_fu_dash', br || 'all', () => rpc('crm_dashboard', {p_branch: br}));
    if (dash) S.dueCount = (dash.overdue || 0) + (dash.today || 0);
    const scopes = [['now', 'المطلوب الآن'], ['overdue', 'المتأخرة'], ['today', 'اليوم'], ['upcoming', 'القادمة'], ['closed', 'المنتهية (60 يوم)']];
    const stat = (lab, val, color, scope) => `<div class="stat-card" style="cursor:pointer" data-crm-scope="${scope}"><div class="sc-label">${lab}</div><div class="sc-val" style="color:${color}">${val ?? '…'}</div></div>`;
    return `
      <div class="grid-4" style="margin-bottom:14px">
        ${stat('متأخرة', dash?.overdue, 'var(--danger)', 'overdue')}${stat('مستحقة اليوم', dash?.today, 'var(--accent)', 'today')}
        ${stat('خلال 3 أيام', dash?.soon, 'var(--warn)', 'now')}${stat('تمت هذا الشهر', dash?.done_month, 'var(--success)', 'closed')}
      </div>
      <div class="crm-tabs">${scopes.map(([k, l]) => `<button class="crm-tab${f.scope === k ? ' on' : ''}" data-crm-scope="${k}">${l}</button>`).join('')}</div>
      <div class="crm-bar">
        <input class="grow" id="crm-fu-q" placeholder="🔍 بحث باسم العميل أو رقم الهاتف…" value="${esc(f.q)}">
        ${state.user.role === 'owner' ? `<select id="crm-fu-branch">${branchOpts(f.branch, 'كل الفروع')}</select>` : ''}
        ${sel('crm-fu-type', [['', 'كل الأنواع'], ...Object.entries(CARE).map(([k, c]) => [k, c.label])], f.type)}
        ${isStaffU() ? sel('crm-fu-emp', [['', 'كل الموظفين'], ...staffList().map(e => [e.id, e.name])], f.emp)
                     : `<label style="display:flex;gap:6px;align-items:center;margin:0;font-size:12px"><input type="checkbox" id="crm-fu-mine" style="width:auto"${f.mine ? ' checked' : ''}> متابعاتي فقط</label>`}
        <button class="btn btn-primary btn-sm" id="crm-fu-new">+ متابعة لعميل</button>
      </div>
      ${errorCard('crm_fu') || (rows === null ? loadingHTML : rows.length ? rows.map(fuCard).join('') :
        empty(f.scope === 'now' ? 'لا توجد متابعات مطلوبة الآن 👏' : 'لا توجد متابعات في هذا العرض'))}`;
  }
  function fuCard(r) {
    const open = ['open', 'postponed'].includes(r.status), late = r.days_late;
    const cls = !open ? '' : late > 7 ? 'late' : late > 0 ? 'warn' : late === 0 ? 'today' : '';
    const tel = telLink(r.phone), wa = waLink(r.whatsapp || r.phone);
    return `<div class="crm-fu ${cls}">
      <div class="who">
        <div><span class="crm-name" data-crm-open="${r.customer_id}">${r.is_vip ? '⭐ ' : ''}${esc(r.customer_name)}</span>
          <span style="color:var(--text3);font-size:12px;margin-right:6px" dir="ltr">${esc(r.phone || '')}</span></div>
        <div class="crm-meta">${careBadge(r.care_type)}<b>${esc(r.title || 'متابعة')}</b>${r.product ? `<span>· ${esc(r.product)}</span>` : ''}
          ${r.kind === 'refill' ? '<span class="badge badge-purple">تذكير صرف</span>' : `<span>· مرحلة ${r.stage}</span>`}
          ${dueBadge(r.due_date, r.status)}${open ? '' : statusBadge(r.status)}
          ${r.allergies ? `<span class="crm-allergy">⚠️ حساسية: ${esc(r.allergies)}</span>` : ''}</div>
        ${r.instructions ? `<div class="crm-hint">💡 ${esc(r.instructions)}</div>` : ''}
        ${r.notes ? `<div class="crm-hint" style="white-space:pre-line">📝 ${esc(r.notes)}</div>` : ''}
        <div class="crm-hint">${isStaffU() || r.assigned_emp !== state.user.empId ? `المسؤول: ${esc(empName(r.assigned_emp))}` : ''}
          ${r.outcome ? ` · النتيجة: ${esc(r.outcome)}` : ''}${r.done_by_name ? ` · سجّلها: ${esc(r.done_by_name)} ${fmtDT(r.done_at)}` : ''}</div>
      </div>
      <div class="acts">
        ${tel ? `<a class="btn btn-ghost btn-sm" href="${tel}">📞 اتصال</a>` : ''}
        ${wa ? `<a class="btn btn-success btn-sm" href="${wa}" target="_blank" rel="noopener">💬 واتساب</a>` : ''}
        ${open ? `<button class="btn btn-primary btn-sm" data-crm-result="${r.id}">✓ تسجيل النتيجة</button>
                  <button class="btn btn-gold btn-sm" data-crm-noanswer="${r.id}">لا يرد</button>
                  <button class="btn btn-ghost btn-sm" data-crm-postpone="${r.id}">⏰ تأجيل</button>` : ''}
      </div></div>`;
  }

  // ---------------------------------------------------------------- page: customers
  function pageCustomers() {
    const c = S.cust, key = [c.q, c.filter, c.branch].join('|');
    const rows = load('crm_cust', key, () => rpc('crm_customer_list', {p_q: c.q, p_branch: c.branch || null, p_filter: c.filter || null, p_limit: 300}));
    const filters = [['', 'الكل'], ['chronic', '🫀 مزمن'], ['prescription', '💊 روشتة'], ['personal_care', '🧴 عناية شخصية'],
                     ['vip', '⭐ VIP'], ['overdue', '⏰ متابعات متأخرة'], ['no_plan', 'بدون خطة متابعة'], ...(isStaffU() ? [['archived', '🗄️ الأرشيف']] : [])];
    return `
      <div class="crm-bar">
        <input class="grow" id="crm-cust-q" placeholder="🔍 ابحث بالاسم أو جزء منه، رقم الهاتف، أو رقم العميل…" value="${esc(c.q)}">
        <select id="crm-cust-branch">${branchOpts(c.branch, 'كل الفروع')}</select>
        <button class="btn btn-primary" id="crm-cust-new">+ عميل جديد</button>
      </div>
      <div class="crm-tabs">${filters.map(([k, l]) => `<button class="crm-tab${c.filter === k ? ' on' : ''}" data-crm-filter="${k}">${l}</button>`).join('')}</div>
      ${errorCard('crm_cust') || (rows === null ? loadingHTML : !rows.length ? empty(c.q ? 'لا يوجد عميل مطابق — يمكنك إضافته كعميل جديد' : 'لا يوجد عملاء بعد') : `
      <div class="card" style="padding:0"><div class="table-wrap" style="border:none"><table>
        <thead><tr><th>العميل</th><th>الهاتف</th><th>رقم العميل</th><th>المتابعة</th><th>المتابعة القادمة</th><th>الفروع</th><th>آخر تواصل</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="crm-row" data-crm-open="${r.id}">
          <td style="font-weight:700">${r.is_vip ? '⭐ ' : ''}${esc(r.name)}${r.archived ? ' <span class="badge badge-gray">مؤرشف</span>' : ''}</td>
          <td dir="ltr" style="text-align:right">${esc(r.phone || '')}</td><td>${esc(r.erp_id || '')}</td>
          <td>${(r.care_types || []).map(careBadge).join(' ') || '<span style="color:var(--text3)">—</span>'}</td>
          <td>${r.next_due ? dueBadge(r.next_due, 'open') : '—'}${r.overdue_fu > 1 ? ` <span class="badge badge-red">${r.overdue_fu}</span>` : ''}</td>
          <td style="font-size:12px">${(r.branches || []).map(b => esc(bName(b))).join(' + ') || '—'}</td>
          <td style="font-size:12px;color:var(--text2)">${r.last_contact ? fmtDT(r.last_contact) : '—'}</td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="crm-hint" style="margin-top:8px">${rows.length >= 300 ? 'يُعرض أول 300 عميل — اكتب في البحث للتضييق' : `${rows.length} عميل`}</div>`)}`;
  }

  // ---------------------------------------------------------------- page: customer profile
  function pageCustomer() {
    if (!S.custId) { state.page = 'crm_customers'; return pageCustomers(); }
    const d = load('crm_detail', String(S.custId), () => rpc('crm_customer_detail', {p_id: S.custId}));
    if (d === null) return loadingHTML;
    if (cache.crm_detail?.error) return errorCard('crm_detail');
    if (!d || !d.customer) return empty('العميل غير موجود');
    const c = d.customer, m = d.medical || {}, plans = d.plans || [], fus = d.followups || [];
    const active = plans.filter(p => p.status === 'active'), ended = plans.filter(p => p.status !== 'active');
    const tel = telLink(c.phone), wa = waLink(c.whatsapp || c.phone);
    const openFu = fus.filter(f => ['open', 'postponed'].includes(f.status));
    const tabs = [['followups', `المتابعات (${openFu.length} مفتوحة)`], ['contacts', `سجل التواصل (${(d.contacts || []).length})`],
                  ...(isStaffU() ? [['history', 'سجل التغييرات']] : [])];
    return `
      <button class="btn btn-ghost btn-sm" id="crm-back" style="margin-bottom:12px">→ العودة للعملاء</button>
      ${c.merged_into ? `<div class="crm-warn" style="margin-bottom:12px">هذا السجل مدمج في عميل آخر. <a href="#" data-crm-open="${c.merged_into}">فتح العميل الأساسي</a></div>` : ''}
      <div class="card" style="margin-bottom:14px">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
          <div style="flex:1;min-width:240px">
            <div style="font-size:21px;font-weight:800">${c.is_vip ? '⭐ ' : ''}${esc(c.name)}
              ${c.is_vip ? '<span class="badge badge-gold">VIP</span>' : ''}${c.archived ? ' <span class="badge badge-gray">مؤرشف</span>' : ''}</div>
            <div class="crm-meta">${active.map(p => careBadge(p.care_type)).join(' ')}
              <span>رقم العميل: <b>${esc(c.erp_id || '—')}</b></span>${(c.alias_erp || []).length ? `<span>· أرقام مدمجة: ${esc(c.alias_erp.join('، '))}</span>` : ''}</div>
            <div class="crm-meta"><span dir="ltr">📱 ${esc(c.phone || 'بدون هاتف')}</span>${c.whatsapp && c.whatsapp !== c.phone ? `<span dir="ltr">💬 ${esc(c.whatsapp)}</span>` : ''}
              <span>· الفروع: ${(c.branches || []).map(b => (b === c.primary_branch ? '★ ' : '') + esc(bName(b))).join(' + ') || '—'}</span></div>
            ${c.vip_note ? `<div class="crm-hint">⭐ ${esc(c.vip_note)}</div>` : ''}
          </div>
          <div class="acts" style="display:flex;gap:6px;flex-wrap:wrap">
            ${tel ? `<a class="btn btn-ghost btn-sm" href="${tel}">📞 اتصال</a>` : ''}${wa ? `<a class="btn btn-success btn-sm" href="${wa}" target="_blank" rel="noopener">💬 واتساب</a>` : ''}
            <button class="btn btn-primary btn-sm" id="crm-plan-new">+ خطة متابعة</button>
            <button class="btn btn-ghost btn-sm" id="crm-single-new">+ متابعة واحدة</button>
            <button class="btn btn-ghost btn-sm" id="crm-contact-new">📝 تسجيل تواصل</button>
            <button class="btn btn-ghost btn-sm" id="crm-cust-edit">✏️ تعديل</button>
            ${isStaffU() ? `<button class="btn btn-gold btn-sm" id="crm-vip">${c.is_vip ? 'إلغاء VIP' : '⭐ تمييز VIP'}</button>
              <button class="btn btn-ghost btn-sm" id="crm-archive">${c.archived ? '♻️ استعادة' : '🗄️ أرشفة'}</button>` : ''}
            ${isOwnerU() ? `<button class="btn btn-ghost btn-sm" id="crm-merge">🔗 دمج مكرر</button>` : ''}
          </div>
        </div>
        <div class="crm-kv" style="margin-top:14px">
          ${[['الجنس', c.gender], ['تاريخ الميلاد', c.birth_date && fmtD(c.birth_date)], ['المنطقة', c.area], ['العنوان', c.address],
             ['أُضيف بواسطة', c.created_by], ['تاريخ الإضافة', fmtD(String(c.created_at).slice(0, 10))]]
             .map(([k, val]) => `<div><span>${k}</span><b>${esc(val || '—')}</b></div>`).join('')}
        </div>
        ${c.notes ? `<div class="crm-hint" style="margin-top:10px;white-space:pre-line">📝 ${esc(c.notes)}</div>` : ''}
      </div>
      <div class="grid-2" style="margin-bottom:14px;align-items:start">
        <div class="card">
          <div class="section-header"><h3>🩺 الملف الطبي</h3><button class="btn btn-ghost btn-sm" id="crm-med-edit">✏️ تعديل</button></div>
          ${m.drug_allergies ? `<div class="crm-allergy" style="font-size:13px;padding:8px 10px;margin-bottom:10px">⚠️ حساسية دوائية: ${esc(m.drug_allergies)}</div>` : ''}
          <div class="crm-kv">${[['الأمراض المزمنة', m.chronic_diseases], ['الأدوية الحالية', m.current_medications], ['الطبيب المعالج', m.treating_doctor], ['ملاحظات صحية', m.health_notes]]
            .map(([k, val]) => `<div><span>${k}</span><b style="white-space:pre-line">${esc(val || '—')}</b></div>`).join('')}</div>
        </div>
        <div class="card">
          <div class="section-header"><h3>📋 خطط المتابعة</h3><span class="badge badge-green">${active.length} نشطة</span></div>
          ${active.length ? active.map(p => planCard(p, fus)).join('') : '<div style="color:var(--text3);font-size:13px">لا توجد خطة متابعة نشطة — أضف خطة لمرض مزمن أو روشتة أو منتج.</div>'}
          ${ended.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text2)">خطط منتهية (${ended.length})</summary>${ended.map(p => planCard(p, fus)).join('')}</details>` : ''}
        </div>
      </div>
      <div class="crm-tabs">${tabs.map(([k, l]) => `<button class="crm-tab${S.tab === k ? ' on' : ''}" data-crm-tab="${k}">${l}</button>`).join('')}</div>
      <div class="card" style="padding:0"><div class="table-wrap" style="border:none">${profileTab(d)}</div></div>`;
  }
  function planCard(p, fus) {
    const next = fus.filter(f => f.plan_id === p.id && ['open', 'postponed'].includes(f.status)).sort((a, b) => a.due_date < b.due_date ? -1 : 1)[0];
    return `<div class="crm-plan">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
        <div>${careBadge(p.care_type)} <b>${esc(p.title)}</b>${p.product ? ` — ${esc(p.product)}` : ''}</div>
        ${p.status === 'active' ? `<button class="btn btn-ghost btn-xs" data-crm-endplan="${p.id}">إنهاء الخطة</button>` : `<span class="badge badge-gray">${esc(p.end_reason || 'منتهية')}</span>`}
      </div>
      <div class="crm-hint">بدأت ${fmtD(p.start_date)}${p.refill_days ? ` · يُصرف كل ${p.refill_days} يوم` : ''} · المسؤول: ${esc(empName(p.assigned_emp))}${p.branch ? ` · ${esc(bName(p.branch))}` : ''}</div>
      ${next ? `<div class="crm-hint">المتابعة القادمة: ${dueBadge(next.due_date, next.status)}</div>` : ''}
      ${p.notes ? `<div class="crm-hint">📝 ${esc(p.notes)}</div>` : ''}
    </div>`;
  }
  function profileTab(d) {
    if (S.tab === 'contacts') {
      const rows = d.contacts || [];
      return rows.length ? `<table><thead><tr><th>الوقت</th><th>الوسيلة</th><th>النتيجة</th><th>الموظف</th><th>الفرع</th><th>ملاحظات</th></tr></thead><tbody>
        ${rows.map(k => `<tr><td style="white-space:nowrap">${fmtDT(k.at)}</td><td>${esc(k.channel || '')}</td><td>${esc(k.outcome || '')}</td><td>${esc(k.emp_name || '')}</td>
          <td>${esc(bName(k.branch) || '')}</td><td style="white-space:pre-line">${esc(k.notes || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div style="padding:20px;color:var(--text3)">لا يوجد تواصل مسجل بعد</div>';
    }
    if (S.tab === 'history') {
      const rows = d.history || [], ent = {crm_customers: 'بيانات العميل', crm_medical: 'الملف الطبي', crm_plans: 'خطة متابعة', crm_followups: 'متابعة'};
      const actAr = {insert: 'إضافة', update: 'تعديل', delete: 'حذف'};
      const detail = h => {
        if (h.action !== 'update' || !h.details) return '';
        return Object.entries(h.details).map(([k, x]) => `${esc(k)}: ${esc(JSON.stringify(x['من']))} ← ${esc(JSON.stringify(x['إلى']))}`).join(' · ');
      };
      return rows.length ? `<table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>
        ${rows.map(h => `<tr><td style="white-space:nowrap">${fmtDT(h.at)}</td><td>${esc(h.user_name || '—')}</td><td>${actAr[h.action] || esc(h.action)} ${ent[h.entity] || ''}</td>
          <td style="font-size:11px;color:var(--text2)">${detail(h)}</td></tr>`).join('')}</tbody></table>`
        : '<div style="padding:20px;color:var(--text3)">لا يوجد</div>';
    }
    const rows = d.followups || [];
    return rows.length ? `<table><thead><tr><th>الاستحقاق</th><th>المتابعة</th><th>الحالة</th><th>النتيجة</th><th>المسؤول / سجّلها</th><th>ملاحظات</th><th></th></tr></thead><tbody>
      ${rows.map(f => { const open = ['open', 'postponed'].includes(f.status); return `<tr>
        <td style="white-space:nowrap">${dueBadge(f.due_date, f.status)}</td>
        <td>${esc(f.title || 'متابعة')}${f.kind === 'refill' ? ' <span class="badge badge-purple">صرف</span>' : ''}</td>
        <td>${statusBadge(f.status)}</td><td>${esc(f.outcome || '')}</td>
        <td style="font-size:12px">${esc(f.done_by_name || empName(f.assigned_emp))}</td>
        <td style="font-size:12px;white-space:pre-line;max-width:280px">${esc(f.notes || '')}</td>
        <td style="white-space:nowrap">${open ? `<button class="btn btn-primary btn-xs" data-crm-result="${f.id}">✓ نتيجة</button> <button class="btn btn-ghost btn-xs" data-crm-postpone="${f.id}">تأجيل</button>` : ''}
          ${isStaffU() ? ` <button class="btn btn-danger btn-xs" data-crm-delfu="${f.id}" title="حذف">✕</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`
      : '<div style="padding:20px;color:var(--text3)">لا توجد متابعات بعد</div>';
  }

  // ---------------------------------------------------------------- page: dashboard (owner / senior)
  function pageDashboard() {
    if (S.dashBranch === undefined) S.dashBranch = isOwnerU() ? '' : (state.branch || '');
    const br = S.dashBranch || null;
    const d = load('crm_dash', br || 'all', () => rpc('crm_dashboard', {p_branch: br}));
    const [from, to] = monthBounds(state.year, state.month);
    const k = load('crm_kpi_month', `${from}|${br}`, () => rpc('crm_kpi', {p_from: from, p_to: to}));
    const card = (icon, lab, val, color, sub = '') => `<div class="stat-card"><span class="sc-icon">${icon}</span><div class="sc-label">${lab}</div><div class="sc-val" style="color:${color}">${val ?? '…'}</div>${sub ? `<div class="sc-sub">${sub}</div>` : ''}</div>`;
    const plans = d?.plans || {};
    const staff = staffList().filter(e => !br || (e.branch || state.branch) === br);
    const kmap = Object.fromEntries((k || []).map(r => [r.emp_id, r]));
    const ids = [...new Set([...staff.map(e => e.id), ...(k || []).map(r => r.emp_id)])];
    return `${errorCard('crm_dash')}
      <div class="crm-bar"><select id="crm-dash-branch">${branchOpts(S.dashBranch, 'كل الفروع')}</select>
        <span class="crm-hint">الأرقام من قاعدة البيانات مباشرة · KPI الموظفين لشهر ${MONTHS_AR[state.month]} ${state.year}</span></div>
      <div class="grid-4" style="margin-bottom:14px">
        ${card('🧑‍⚕️', 'العملاء', d?.customers, 'var(--accent3)', d ? `${d.shared} مشترك بين الفرعين · ${d.vip} VIP` : '')}
        ${card('🫀', 'مرضى مزمنون نشطون', d?.patients_chronic, 'var(--danger)')}
        ${card('💊', 'روشتات تحت المتابعة', d ? plans.prescription || 0 : null, 'var(--accent)')}
        ${card('🧴', 'متابعات عناية شخصية', d ? plans.personal_care || 0 : null, 'var(--pink)')}
        ${card('⏰', 'متابعات متأخرة', d?.overdue, 'var(--danger)', d ? `${d.today} اليوم · ${d.soon} خلال 3 أيام` : '')}
        ${card('✅', 'تمت هذا الشهر', d?.done_month, 'var(--success)')}
        ${card('📵', 'لا يرد هذا الشهر', d?.no_answer_month, 'var(--warn)')}
        ${card('⛔', 'أوقفوا العلاج هذا الشهر', d?.stopped_month, 'var(--text2)', d ? `${d.new_month} عميل جديد هذا الشهر` : '')}
      </div>
      <div class="card"><div class="section-header"><h3>⭐ أداء الموظفين في المتابعة — ${MONTHS_AR[state.month]} ${state.year}</h3>
        <span class="crm-hint">تدخل في KPI بدل «رضا العملاء» (${typeof kpiWeights !== 'undefined' ? kpiWeights.satisfaction : 10}%)</span></div>
        ${k === null ? loadingHTML : `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>متابعات مستحقة</th><th>في موعدها</th><th>متأخرة</th><th>لا يرد</th><th>مؤجلة</th><th>لم تُنفذ</th><th>الدرجة</th></tr></thead><tbody>
        ${ids.map(id => { const r = kmap[id]; return `<tr><td style="font-weight:700">${esc(empName(id))}</td>
          ${r ? `<td>${r.due}</td><td style="color:var(--success)">${r.on_time}</td><td style="color:var(--warn)">${r.late}</td><td>${r.no_answer}</td><td>${r.postponed}</td><td style="color:var(--danger)">${r.overdue}</td>
               <td style="font-weight:800;font-size:18px;color:${kpiColor(r.score)}">${r.score}</td>` : '<td colspan="7" style="color:var(--text3)">لا متابعات هذا الشهر — تبقى درجة KPI المحايدة (75)</td>'}</tr>`; }).join('')}
        </tbody></table></div>
        <div class="crm-hint" style="margin-top:8px">في موعدها = 100 · متأخرة = 60 · «لا يرد» مسجلة في موعدها = 80 · مؤجلة = 70 · لم تُنفذ بعد موعدها = 0. الدرجة لمن سجّل النتيجة، والمتأخرة على الموظف المسؤول.</div>`}
      </div>`;
  }
  function monthBounds(y, m) { const s = new Date(Date.UTC(y, m, 1)), e = new Date(Date.UTC(y, m + 1, 0)); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]; }

  // ---------------------------------------------------------------- page: settings (owner)
  function pageSettings() {
    const prot = load('crm_prot', 'all', async () => { const {data, error} = await sb.from('crm_protocols').select('*').order('sort'); if (error) throw error; return data; });
    const nob = load('crm_nobranch', 'n', () => rpc('crm_unassigned_count'));
    const imp = S.imp;
    return `${errorCard('crm_prot')}
      <div class="grid-2" style="margin-bottom:14px;align-items:start">
        <div class="card"><div class="section-header"><h3>📥 استيراد العملاء من Excel</h3></div>
          <div class="crm-hint" style="margin-bottom:10px">ملف Excel بنفس أعمدة ملف الـ CRM القديم (رقم العميل، الاسم، رقم الهاتف…). العملاء الموجودون بنفس رقم ERP لا يتكررون.</div>
          ${field('الفرع الذي ينتمي له العملاء', `<select id="crm-imp-branch">${branchOpts(imp?.branch ?? state.branch, '— بدون فرع —')}</select>`)}
          <input type="file" id="crm-imp-file" accept=".xlsx,.xls,.csv">
          ${imp?.rows ? `<div class="crm-preview" style="margin-top:10px">الملف: ${esc(imp.file)} — ${imp.rows.length} عميل صالح
            ${imp.problems.length ? `<div style="color:#92400e;margin-top:6px">${imp.problems.slice(0, 6).map(esc).join('<br>')}${imp.problems.length > 6 ? `<br>… و${imp.problems.length - 6} ملاحظة أخرى` : ''}</div>` : ''}</div>
            <button class="btn btn-primary" id="crm-imp-go" style="margin-top:10px"${imp.busy ? ' disabled' : ''}>${imp.busy ? `⏳ ${imp.progress || ''}` : '📥 استيراد الآن'}</button>` : ''}
          ${imp?.result ? `<div class="crm-preview" style="margin-top:10px">✓ تمت إضافة ${imp.result.added} عميل · ${imp.result.skipped} موجود مسبقاً</div>` : ''}
        </div>
        <div class="card"><div class="section-header"><h3>📤 تصدير ونقل</h3></div>
          <button class="btn btn-success" id="crm-export">📊 تصدير كل بيانات المتابعة إلى Excel</button>
          ${nob ? `<div class="crm-warn" style="margin-top:14px">${nob} عميل غير مرتبط بأي فرع.
            <div style="display:flex;gap:6px;margin-top:8px"><select id="crm-assign-branch" style="width:auto">${branchOpts(state.branch)}</select>
            <button class="btn btn-primary btn-sm" id="crm-assign-go">ربطهم بهذا الفرع</button></div></div>` : ''}
        </div>
      </div>
      <div class="card"><div class="section-header"><h3>🩺 بروتوكولات المتابعة</h3><button class="btn btn-primary btn-sm" id="crm-prot-new">+ بروتوكول</button></div>
        <div class="crm-hint" style="margin-bottom:10px">المزمن: تذكير قبل انتهاء الدواء بـ 5 أيام ثم يتكرر تلقائياً. الروشتة والعناية الشخصية: متابعة بعد الأيام المحددة من تاريخ البدء.</div>
        ${prot === null ? loadingHTML : `<div class="table-wrap"><table><thead><tr><th>البروتوكول</th><th>النوع</th><th>الجدول</th><th>تعليمات</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${prot.map(p => `<tr><td style="font-weight:700">${esc(p.name)}</td><td>${careBadge(p.care_type)}</td>
          <td>${p.care_type === 'chronic' ? `كل ${p.refill_days || 30} يوم` : (p.fu_days || []).map(x => `يوم ${x}`).join(' · ')}</td>
          <td style="font-size:12px">${esc(p.instructions || '')}</td><td>${p.active ? '<span class="badge badge-green">مستخدم</span>' : '<span class="badge badge-gray">موقوف</span>'}</td>
          <td><button class="btn btn-ghost btn-xs" data-crm-prot="${p.id}">✏️</button></td></tr>`).join('')}</tbody></table></div>`}
      </div>`;
  }

  // ---------------------------------------------------------------- modals
  function modal(m) {
    const head = t => `<div class="modal-header"><h3>${t}</h3><button class="modal-close" id="modal-cancel">✕</button></div>`;
    const foot = (saveLabel = '💾 حفظ') => `<div class="modal-footer"><button class="btn btn-ghost" id="modal-cancel-2">إلغاء</button><button class="btn btn-primary" id="crm-save">${saveLabel}</button></div>`;
    switch (m.type) {
      case 'crm-customer': {
        const c = m.customer || {};
        const brs = c.branches || [state.user.branch || state.branch].filter(Boolean);
        return head(c.id ? '✏️ تعديل بيانات العميل' : '🧑‍⚕️ عميل جديد') + `
          <div class="form-row">${field('الاسم *', `<input id="crm-c-name" value="${esc(c.name || m.preset?.name || '')}">`)}
            ${field('رقم الهاتف', `<input id="crm-c-phone" dir="ltr" placeholder="01xxxxxxxxx" value="${esc(c.phone || m.preset?.phone || '')}">`)}</div>
          <div id="crm-dups"></div>
          <div class="form-row">${field('رقم واتساب (إن كان مختلفاً)', `<input id="crm-c-wa" dir="ltr" value="${esc(c.whatsapp || '')}">`)}
            ${field('رقم العميل في ERP', `<input id="crm-c-erp" dir="ltr" value="${esc(c.erp_id || '')}">`)}</div>
          <div class="form-row">${field('الجنس', sel('crm-c-gender', [['', '—'], ['ذكر', 'ذكر'], ['أنثى', 'أنثى']], c.gender))}
            ${field('تاريخ الميلاد', `<input id="crm-c-birth" type="date" value="${esc(c.birth_date || '')}">`)}</div>
          <div class="form-row">${field('المنطقة', `<input id="crm-c-area" value="${esc(c.area || '')}">`)}
            ${field('العنوان (للتوصيل)', `<input id="crm-c-addr" value="${esc(c.address || '')}">`)}</div>
          ${field('الفروع التي يتعامل معها', `<div class="crm-choice">${branchList().map(b => `<label><input type="checkbox" class="crm-c-br" value="${esc(b.id)}"${brs.includes(b.id) ? ' checked' : ''}> ${esc(b.name)}</label>`).join('')}</div>`)}
          ${isStaffU() ? field('ملاحظة VIP (اختياري)', `<input id="crm-c-vipnote" value="${esc(c.vip_note || '')}">`) : ''}
          ${field('ملاحظات', `<textarea id="crm-c-notes" rows="2">${esc(c.notes || '')}</textarea>`)}` + foot();
      }
      case 'crm-medical': {
        const x = m.medical || {};
        return head('🩺 الملف الطبي') + `
          ${field('الحساسية الدوائية ⚠️', `<input id="crm-m-allergy" value="${esc(x.drug_allergies || '')}">`)}
          ${field('الأمراض المزمنة', `<textarea id="crm-m-chronic" rows="2">${esc(x.chronic_diseases || '')}</textarea>`)}
          ${field('الأدوية الحالية', `<textarea id="crm-m-meds" rows="2">${esc(x.current_medications || '')}</textarea>`)}
          <div class="form-row">${field('الطبيب المعالج', `<input id="crm-m-doc" value="${esc(x.treating_doctor || '')}">`)}
            ${field('ملاحظات صحية', `<input id="crm-m-notes" value="${esc(x.health_notes || '')}">`)}</div>
          <div class="crm-hint">بيانات حساسة — تُستخدم للتحقق من التداخلات الدوائية فقط.</div>` + foot();
      }
      case 'crm-plan': {
        const t = m.care || 'chronic', prots = (m.protocols || []).filter(p => p.care_type === t && p.active);
        const p = prots.find(x => String(x.id) === String(m.protocol)) || prots[0];
        return head('📋 خطة متابعة جديدة') + `
          ${field('نوع المتابعة', `<div class="crm-choice">${Object.entries(CARE).map(([k, c]) => `<label><input type="radio" name="crm-p-type" value="${k}"${k === t ? ' checked' : ''}> ${c.icon} ${c.label}</label>`).join('')}</div>`)}
          <div class="form-row">${field(t === 'chronic' ? 'المرض' : 'التصنيف', sel('crm-p-prot', prots.map(x => [x.id, x.name]), p?.id))}
            ${field(t === 'personal_care' ? 'المنتج' : 'الدواء / المنتج', `<input id="crm-p-product" placeholder="${t === 'chronic' ? 'مثال: Concor 5mg' : 'اختياري'}">`)}</div>
          <div class="form-row">${field(t === 'chronic' ? 'تاريخ الصرف' : 'تاريخ البدء', `<input id="crm-p-start" type="date" value="${todayISO()}">`)}
            ${t === 'chronic' ? field('العلبة تكفي (يوم)', `<input id="crm-p-refill" type="number" min="5" max="365" value="${p?.refill_days || 30}">`)
                              : field('أيام المتابعة (بعد البدء)', `<input id="crm-p-days" placeholder="مثال: 7, 14, 30" value="${(p?.fu_days || [14]).join(', ')}">`)}</div>
          <div class="form-row">${field('الفرع', `<select id="crm-p-branch">${branchOpts(state.user.branch || state.branch)}</select>`)}
            ${field('الموظف المسؤول', sel('crm-p-emp', staffList().map(e => [e.id, e.name]), state.user.empId || staffList()[0]?.id))}</div>
          ${field('ملاحظات', `<input id="crm-p-notes">`)}
          ${p?.instructions ? `<div class="crm-hint">💡 ${esc(p.instructions)}</div>` : ''}
          <div class="crm-preview" id="crm-p-preview" style="margin-top:10px"></div>` + foot('💾 إنشاء الخطة');
      }
      case 'crm-result': {
        const f = m.fu, outs = OUTCOMES[f.care_type] || OUTCOMES.other, st = m.status || 'done';
        return head('✓ تسجيل نتيجة المتابعة') + `
          <div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:14px">
            <div style="font-weight:800">${esc(f.customer_name || '')} <span dir="ltr" style="font-weight:400;color:var(--text2)">${esc(f.phone || '')}</span></div>
            <div class="crm-meta">${careBadge(f.care_type)} ${esc(f.title || 'متابعة')} ${f.product ? '· ' + esc(f.product) : ''} · ${dueBadge(f.due_date, 'open')}</div>
            ${f.instructions ? `<div class="crm-hint">💡 ${esc(f.instructions)}</div>` : ''}
            ${f.allergies ? `<div class="crm-allergy" style="margin-top:6px;display:inline-block">⚠️ حساسية: ${esc(f.allergies)}</div>` : ''}
          </div>
          ${field('ماذا حدث؟', `<div class="crm-choice">${[['done', '✅ تم التواصل'], ['no_answer', '📵 لا يرد'], ['cancelled', '✕ إلغاء المتابعة']]
              .map(([k, l]) => `<label><input type="radio" name="crm-r-status" value="${k}"${k === st ? ' checked' : ''}> ${l}</label>`).join('')}</div>`)}
          <div class="form-row">${field('النتيجة', sel('crm-r-outcome', [['', '—'], ...outs.map(o => [o, o])], ''))}
            ${field('وسيلة التواصل', sel('crm-r-channel', CHANNELS.map(c => [c, c]), 'اتصال'))}</div>
          ${field('ملاحظات', `<textarea id="crm-r-notes" rows="2" placeholder="ماذا قال العميل؟"></textarea>`)}
          <label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" id="crm-r-next-on" style="width:auto"${st === 'no_answer' ? ' checked' : ''}> جدولة متابعة أخرى بتاريخ:</label>
          <input type="date" id="crm-r-next" value="${addDays(todayISO(), st === 'no_answer' ? 1 : 7)}" style="margin-top:6px">
          <div class="crm-hint">${f.kind === 'refill' ? '🔁 عند «تم التواصل» يُجدول تذكير الصرف التالي تلقائياً حسب مدة العلبة. «أوقف العلاج» يُنهي الخطة.' : '«لا يرد» يُعيد المحاولة غداً تلقائياً إن لم تحدد تاريخاً.'}</div>` + foot('💾 حفظ النتيجة');
      }
      case 'crm-postpone':
        return head('⏰ تأجيل المتابعة') + field('التاريخ الجديد', `<input id="crm-pp-date" type="date" value="${addDays(todayISO(), 3)}" min="${todayISO()}">`) +
          field('السبب', `<input id="crm-pp-reason" placeholder="مثال: مسافر، طلب الاتصال لاحقاً">`) + foot('💾 تأجيل');
      case 'crm-single':
        return head('📅 متابعة واحدة') + `<div class="form-row">${field('التاريخ', `<input id="crm-s-date" type="date" value="${addDays(todayISO(), 7)}">`)}
          ${field('الموظف المسؤول', sel('crm-s-emp', staffList().map(e => [e.id, e.name]), state.user.empId || staffList()[0]?.id))}</div>` +
          field('السبب / ملاحظات', `<input id="crm-s-notes" placeholder="مثال: الاتصال لتأكيد وصول الدواء">`) + foot();
      case 'crm-contact':
        return head('📝 تسجيل تواصل') + `<div class="form-row">${field('الوسيلة', sel('crm-k-channel', CHANNELS.map(c => [c, c]), 'زيارة داخل الصيدلية'))}
          ${field('النتيجة', `<input id="crm-k-outcome" placeholder="مثال: استفسر عن دواء">`)}</div>` + field('ملاحظات', `<textarea id="crm-k-notes" rows="3"></textarea>`) + foot();
      case 'crm-endplan':
        return head('إنهاء خطة المتابعة') + field('السبب', sel('crm-e-reason', ['أوقف العلاج', 'انتقل لصيدلية أخرى', 'غيّر الطبيب العلاج', 'اكتمل العلاج', 'توفي', 'أخرى'].map(x => [x, x]), 'أوقف العلاج')) +
          `<div class="crm-hint">تُلغى المتابعات المفتوحة لهذه الخطة.</div>` + foot('إنهاء الخطة');
      case 'crm-protocol': {
        const p = m.protocol || {care_type: 'prescription', active: true, fu_days: [14]};
        return head(p.id ? '✏️ تعديل بروتوكول' : '+ بروتوكول جديد') + `
          <div class="form-row">${field('الاسم', `<input id="crm-pr-name" value="${esc(p.name || '')}">`)}
            ${field('النوع', sel('crm-pr-type', Object.entries(CARE).map(([k, c]) => [k, c.label]), p.care_type))}</div>
          <div class="form-row">${field('المزمن: العلبة تكفي (يوم)', `<input id="crm-pr-refill" type="number" value="${p.refill_days || ''}">`)}
            ${field('غير المزمن: أيام المتابعة', `<input id="crm-pr-days" value="${(p.fu_days || []).join(', ')}" placeholder="7, 14, 30">`)}</div>
          ${field('تعليمات للموظف', `<input id="crm-pr-instr" value="${esc(p.instructions || '')}">`)}
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="crm-pr-active" style="width:auto"${p.active ? ' checked' : ''}> مستخدم</label>` + foot();
      }
      case 'crm-merge':
        return head('🔗 دمج عميل مكرر') + `<div class="crm-hint" style="margin-bottom:10px">ابحث عن السجل المكرر لـ «${esc(m.name)}». تنتقل كل خطط المتابعة والمكالمات إليه، ويُحفظ رقم ERP القديم.</div>
          <input id="crm-mg-q" placeholder="اسم أو هاتف السجل المكرر" value="${esc(m.q || '')}">
          <div id="crm-mg-results" style="margin-top:10px">${(m.results || []).filter(r => r.id !== m.keep).map(r => `<div class="crm-plan" style="display:flex;justify-content:space-between;align-items:center">
            <div><b>${esc(r.name)}</b> <span dir="ltr" style="color:var(--text2)">${esc(r.phone || '')}</span> · ${esc(r.erp_id || '—')}</div>
            <button class="btn btn-danger btn-sm" data-crm-mergewith="${r.id}" data-name="${esc(r.name)}">دمج في هذا العميل</button></div>`).join('')}</div>
          <div class="modal-footer"><button class="btn btn-ghost" id="modal-cancel-2">إغلاق</button></div>`;
    }
    return '';
  }
  function planPreview() {
    const el = document.getElementById('crm-p-preview'); if (!el) return;
    const t = document.querySelector('input[name="crm-p-type"]:checked')?.value, start = v('crm-p-start') || todayISO();
    if (t === 'chronic') {
      const r = Math.max(5, +v('crm-p-refill') || 30);
      el.textContent = `🔁 أول تذكير صرف: ${fmtD(addDays(start, r - 5))} — ثم كل ${r} يوم تلقائياً بعد كل صرف`;
    } else {
      const days = parseDays(v('crm-p-days'));
      el.textContent = `📅 ${days.length} متابعة: ` + days.map(d => fmtD(addDays(start, d))).join('، ');
    }
  }
  const parseDays = s => [...new Set(ar2en(s).split(/[^0-9]+/).map(Number).filter(n => n > 0 && n <= 365))].sort((a, b) => a - b);

  // ---------------------------------------------------------------- events
  let _deb = null;
  function onSearch(id, setter) {
    const el = document.getElementById(id); if (!el) return;
    el.onfocus = () => { S.focus = id; };
    el.oninput = () => { S.focus = id; clearTimeout(_deb); _deb = setTimeout(() => { setter(el.value.trim()); render(); }, 350); };
  }
  // the page is re-drawn when results arrive: keep typing in the same box until the user clicks elsewhere
  document.addEventListener('mousedown', e => { if (S.focus && e.target?.id !== S.focus) S.focus = null; }, true);
  function on(sel, ev, fn) { document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e))); }
  async function openResult(id, status) {
    try {
      let f = (cache.crm_fu?.rows || []).find(r => r.id === +id);
      if (!f) {   // from the profile page
        const d = cache.crm_detail?.rows, x = d?.followups?.find(r => r.id === +id), plan = d?.plans?.find(p => p.id === x?.plan_id);
        f = x && {...x, customer_name: d.customer.name, phone: d.customer.phone, care_type: plan?.care_type, product: plan?.product, allergies: d.medical?.drug_allergies};
      }
      if (!f) return;
      state.modal = {type: 'crm-result', fu: f, status}; render();
    } catch (e) { showToast(crmErr(e), 'error'); }
  }
  async function quickNoAnswer(id) {
    await act(() => rpc('crm_record_result', {p_followup: +id, p_status: 'no_answer', p_channel: 'اتصال'}), 'سُجّل «لا يرد» — ستظهر المتابعة غداً مرة أخرى');
  }
  async function checkDuplicates() {
    const box = document.getElementById('crm-dups'); if (!box) return;
    const name = v('crm-c-name'), phone = v('crm-c-phone');
    if (!name && !phone) { box.innerHTML = ''; return; }
    try {
      const list = await rpc('crm_find_similar', {p_name: name, p_phone: phone, p_exclude: state.modal?.customer?.id || null});
      box.innerHTML = list.length ? `<div class="crm-warn" style="margin-bottom:12px">⚠️ قد يكون مسجلاً بالفعل — لا تسجّله مرة ثانية إذا كان يتعامل مع فرع آخر:<br>${list.map(x =>
        `• <a href="#" data-crm-open-modal="${x.id}">${esc(x.name)}</a> <span dir="ltr">${esc(x.phone || '')}</span> (${esc(x.reason)})`).join('<br>')}</div>` : '';
      box.querySelectorAll('[data-crm-open-modal]').forEach(a => a.onclick = e => { e.preventDefault(); state.modal = null; open('crm_customer', {custId: +a.dataset.crmOpenModal, tab: 'followups'}); });
      return list;
    } catch (e) { console.warn(e); return []; }
  }

  function bind() {
    if (!canUse()) return;
    // navigation inside the CRM
    on('[data-crm-open]', 'click', (el, e) => { e.preventDefault(); open('crm_customer', {custId: +el.dataset.crmOpen, tab: 'followups'}); });
    on('[data-crm-scope]', 'click', el => { S.fu.scope = el.dataset.crmScope; render(); });
    on('[data-crm-filter]', 'click', el => { S.cust.filter = el.dataset.crmFilter; render(); });
    on('[data-crm-tab]', 'click', el => { S.tab = el.dataset.crmTab; render(); });
    on('[data-crm-result]', 'click', el => openResult(el.dataset.crmResult, 'done'));
    on('[data-crm-noanswer]', 'click', el => quickNoAnswer(el.dataset.crmNoanswer));
    on('[data-crm-postpone]', 'click', el => { state.modal = {type: 'crm-postpone', id: +el.dataset.crmPostpone}; render(); });
    on('[data-crm-delfu]', 'click', el => { if (confirm('حذف هذه المتابعة نهائياً؟ (يُفضّل «إلغاء المتابعة» بدلاً من الحذف)')) act(async () => { const {error} = await sb.from('crm_followups').delete().eq('id', +el.dataset.crmDelfu); if (error) throw error; }, 'تم الحذف'); });
    on('[data-crm-endplan]', 'click', el => { state.modal = {type: 'crm-endplan', id: +el.dataset.crmEndplan}; render(); });
    on('[data-crm-prot]', 'click', el => { const p = (cache.crm_prot?.rows || []).find(x => x.id === +el.dataset.crmProt); state.modal = {type: 'crm-protocol', protocol: p}; render(); });
    on('[data-crm-mergewith]', 'click', el => {
      const keep = state.modal.keep, drop = +el.dataset.crmMergewith;
      if (!confirm(`دمج «${el.dataset.name}» في «${state.modal.name}»؟\nتنتقل كل بياناته إلى العميل الحالي.`)) return;
      act(() => rpc('crm_merge', {p_keep: keep, p_drop: drop}), 'تم الدمج ✓');
    });
    // follow-ups page
    onSearch('crm-fu-q', x => { S.fu.q = x; });
    document.getElementById('crm-fu-branch')?.addEventListener('change', e => { S.fu.branch = e.target.value; render(); });
    document.getElementById('crm-fu-type')?.addEventListener('change', e => { S.fu.type = e.target.value; render(); });
    document.getElementById('crm-fu-emp')?.addEventListener('change', e => { S.fu.emp = e.target.value; render(); });
    document.getElementById('crm-fu-mine')?.addEventListener('change', e => { S.fu.mine = e.target.checked; render(); });
    document.getElementById('crm-fu-new')?.addEventListener('click', () => open('crm_customers', {}));
    // customers page
    onSearch('crm-cust-q', x => { S.cust.q = x; });
    document.getElementById('crm-cust-branch')?.addEventListener('change', e => { S.cust.branch = e.target.value; render(); });
    document.getElementById('crm-cust-new')?.addEventListener('click', () => {
      const q = S.cust.q, digits = ar2en(q).replace(/\D/g, '');
      state.modal = {type: 'crm-customer', preset: digits.length >= 10 ? {phone: q} : {name: /\d/.test(q) ? '' : q}}; render();
    });
    // profile
    document.getElementById('crm-back')?.addEventListener('click', () => open('crm_customers'));
    const det = () => cache.crm_detail?.rows;
    document.getElementById('crm-cust-edit')?.addEventListener('click', () => { state.modal = {type: 'crm-customer', customer: det().customer}; render(); });
    document.getElementById('crm-med-edit')?.addEventListener('click', () => { state.modal = {type: 'crm-medical', medical: det().medical, id: det().customer.id}; render(); });
    document.getElementById('crm-plan-new')?.addEventListener('click', async () => {
      try { const {data, error} = await sb.from('crm_protocols').select('*').order('sort'); if (error) throw error;
        state.modal = {type: 'crm-plan', protocols: data, care: 'chronic'}; render(); } catch (e) { showToast(crmErr(e), 'error'); }
    });
    document.getElementById('crm-single-new')?.addEventListener('click', () => { state.modal = {type: 'crm-single'}; render(); });
    document.getElementById('crm-contact-new')?.addEventListener('click', () => { state.modal = {type: 'crm-contact'}; render(); });
    document.getElementById('crm-vip')?.addEventListener('click', () => {
      const c = det().customer;
      act(async () => { const {error} = await sb.from('crm_customers').update({is_vip: !c.is_vip}).eq('id', c.id); if (error) throw error; }, c.is_vip ? 'أُلغي تمييز VIP' : 'تم تمييز العميل VIP ⭐');
    });
    document.getElementById('crm-archive')?.addEventListener('click', () => {
      const c = det().customer, reason = c.archived ? null : prompt('سبب الأرشفة (اختياري) — يختفي العميل من القوائم ويمكن استعادته:');
      if (!c.archived && reason === null) return;
      act(async () => {
        const {error} = await sb.from('crm_customers').update({archived: !c.archived, archived_reason: reason || null}).eq('id', c.id); if (error) throw error;
        if (!c.archived) { const r = await sb.from('crm_followups').update({status: 'cancelled'}).eq('customer_id', c.id).in('status', ['open', 'postponed']); if (r.error) throw r.error; }
      }, c.archived ? 'تمت الاستعادة' : 'تمت الأرشفة');
    });
    document.getElementById('crm-merge')?.addEventListener('click', () => { const c = det().customer; state.modal = {type: 'crm-merge', keep: c.id, name: c.name, results: []}; render(); });
    // dashboard / settings
    document.getElementById('crm-dash-branch')?.addEventListener('change', e => { S.dashBranch = e.target.value; render(); });
    document.getElementById('crm-prot-new')?.addEventListener('click', () => { state.modal = {type: 'crm-protocol'}; render(); });
    document.getElementById('crm-export')?.addEventListener('click', exportExcel);
    document.getElementById('crm-imp-file')?.addEventListener('change', e => readImport(e.target.files[0]));
    document.getElementById('crm-imp-branch')?.addEventListener('change', e => { S.imp = {...(S.imp || {}), branch: e.target.value}; });
    document.getElementById('crm-imp-go')?.addEventListener('click', runImport);
    document.getElementById('crm-assign-go')?.addEventListener('click', () => act(() => rpc('crm_assign_unassigned', {p_branch: v('crm-assign-branch')}), 'تم ربط العملاء بالفرع ✓'));
    // restore the cursor in the search box after a re-render
    if (S.focus && !state.modal) { const el = document.getElementById(S.focus); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    bindModal();
  }

  function bindModal() {
    const m = state.modal; if (!m || !String(m.type).startsWith('crm-')) return;
    const save = document.getElementById('crm-save');
    const busy = async fn => { if (save) { save.disabled = true; } try { await fn(); } finally { if (save) save.disabled = false; } };
    if (m.type === 'crm-customer') {
      ['crm-c-name', 'crm-c-phone'].forEach(id => document.getElementById(id)?.addEventListener('blur', checkDuplicates));
      if (m.preset) checkDuplicates();
      save.onclick = () => busy(async () => {
        const brs = [...document.querySelectorAll('.crm-c-br:checked')].map(x => x.value);
        const phone = v('crm-c-phone'), wa = v('crm-c-wa');
        if (v('crm-c-name').length < 2) return showToast('اكتب اسم العميل', 'error');
        if (phone && !validMobile(phone) && !confirm('رقم الهاتف لا يبدو رقم موبايل مصري صحيح (11 رقماً يبدأ بـ 01). حفظ على أي حال؟')) return;
        const row = {name: v('crm-c-name'), phone: phone ? (validMobile(phone) ? normPhone(phone) : phone) : null,
          whatsapp: wa ? (validMobile(wa) ? normPhone(wa) : wa) : null, erp_id: v('crm-c-erp') || null, gender: v('crm-c-gender') || null,
          birth_date: v('crm-c-birth') || null, area: v('crm-c-area') || null, address: v('crm-c-addr') || null, notes: v('crm-c-notes') || null,
          branches: brs, primary_branch: m.customer?.primary_branch && brs.includes(m.customer.primary_branch) ? m.customer.primary_branch : (brs[0] || null)};
        if (isStaffU()) row.vip_note = v('crm-c-vipnote') || null;
        if (!m.customer) {
          const dups = await checkDuplicates();
          if (dups?.some(x => x.reason === 'نفس رقم الهاتف') && !confirm('يوجد عميل بنفس رقم الهاتف. حفظ كعميل جديد رغم ذلك؟')) return;
          const {data, error} = await sb.from('crm_customers').insert(row).select('id').single(); if (error) return showToast(crmErr(error), 'error');
          invalidate(); state.modal = null; open('crm_customer', {custId: data.id, tab: 'followups'}); showToast('تمت إضافة العميل ✓ — أضف له خطة متابعة');
        } else {
          await act(async () => { const {error} = await sb.from('crm_customers').update(row).eq('id', m.customer.id); if (error) throw error; }, 'تم الحفظ ✓');
        }
      });
    } else if (m.type === 'crm-medical') {
      save.onclick = () => busy(() => act(async () => {
        const row = {customer_id: m.id, drug_allergies: v('crm-m-allergy') || null, chronic_diseases: v('crm-m-chronic') || null,
          current_medications: v('crm-m-meds') || null, treating_doctor: v('crm-m-doc') || null, health_notes: v('crm-m-notes') || null,
          updated_by: state.user.name, updated_at: new Date().toISOString()};
        const {error} = await sb.from('crm_medical').upsert(row); if (error) throw error;
      }, 'تم حفظ الملف الطبي ✓'));
    } else if (m.type === 'crm-plan') {
      document.querySelectorAll('input[name="crm-p-type"]').forEach(r => r.onchange = () => { m.care = r.value; m.protocol = null; render(); });
      document.getElementById('crm-p-prot')?.addEventListener('change', e => { m.protocol = e.target.value; render(); });
      ['crm-p-start', 'crm-p-refill', 'crm-p-days'].forEach(id => document.getElementById(id)?.addEventListener('input', planPreview));
      planPreview();
      save.onclick = () => busy(() => {
        const t = m.care, prot = m.protocols.find(x => String(x.id) === v('crm-p-prot'));
        if (!prot) return showToast('اختر التصنيف', 'error');
        const days = parseDays(v('crm-p-days'));
        if (t !== 'chronic' && !days.length) return showToast('اكتب أيام المتابعة', 'error');
        return act(() => rpc('crm_create_plan', {p_customer: S.custId, p_care_type: t, p_title: prot.name, p_product: v('crm-p-product') || null,
          p_protocol: prot.id, p_start: v('crm-p-start') || todayISO(), p_refill_days: t === 'chronic' ? Math.max(5, +v('crm-p-refill') || 30) : null,
          p_branch: v('crm-p-branch') || null, p_assigned: v('crm-p-emp') || null, p_notes: v('crm-p-notes') || null, p_days: t === 'chronic' ? null : days}),
          'تم إنشاء خطة المتابعة ✓');
      });
    } else if (m.type === 'crm-result') {
      document.querySelectorAll('input[name="crm-r-status"]').forEach(r => r.onchange = () => {
        if (r.value === 'no_answer') { document.getElementById('crm-r-next-on').checked = true; document.getElementById('crm-r-next').value = addDays(todayISO(), 1); }
      });
      save.onclick = () => busy(() => {
        const st = document.querySelector('input[name="crm-r-status"]:checked')?.value || 'done';
        const next = checked('crm-r-next-on') ? v('crm-r-next') : null;
        if (next && next < todayISO()) return showToast('تاريخ المتابعة التالية يجب ألا يكون في الماضي', 'error');
        if (st === 'done' && !v('crm-r-outcome') && !v('crm-r-notes')) return showToast('اختر النتيجة أو اكتب ملاحظة', 'error');
        return act(() => rpc('crm_record_result', {p_followup: m.fu.id, p_status: st, p_outcome: v('crm-r-outcome') || null,
          p_notes: v('crm-r-notes') || null, p_channel: v('crm-r-channel'), p_next: next}), 'تم حفظ النتيجة ✓');
      });
    } else if (m.type === 'crm-postpone') {
      save.onclick = () => busy(() => act(() => rpc('crm_reschedule', {p_followup: m.id, p_date: v('crm-pp-date'), p_reason: v('crm-pp-reason') || null}), 'تم التأجيل ✓'));
    } else if (m.type === 'crm-single') {
      save.onclick = () => busy(() => act(() => rpc('crm_add_followup', {p_customer: S.custId, p_date: v('crm-s-date'), p_notes: v('crm-s-notes') || null,
        p_branch: state.user.branch || state.branch || null, p_assigned: v('crm-s-emp') || null}), 'تمت إضافة المتابعة ✓'));
    } else if (m.type === 'crm-contact') {
      save.onclick = () => busy(() => act(async () => {
        const {error} = await sb.from('crm_contacts').insert({customer_id: S.custId, channel: v('crm-k-channel'), outcome: v('crm-k-outcome') || null,
          notes: v('crm-k-notes') || null, emp_id: state.user.empId, emp_name: state.user.name, branch: state.user.branch || state.branch || null});
        if (error) throw error;
      }, 'تم تسجيل التواصل ✓'));
    } else if (m.type === 'crm-endplan') {
      save.onclick = () => busy(() => act(async () => {
        const {error} = await sb.from('crm_plans').update({status: 'ended', end_reason: v('crm-e-reason')}).eq('id', m.id); if (error) throw error;
        const r = await sb.from('crm_followups').update({status: 'cancelled'}).eq('plan_id', m.id).in('status', ['open', 'postponed']); if (r.error) throw r.error;
      }, 'تم إنهاء الخطة'));
    } else if (m.type === 'crm-protocol') {
      save.onclick = () => busy(() => act(async () => {
        const row = {name: v('crm-pr-name'), care_type: v('crm-pr-type'), refill_days: +v('crm-pr-refill') || null, fu_days: parseDays(v('crm-pr-days')),
          instructions: v('crm-pr-instr') || null, active: checked('crm-pr-active')};
        if (!row.name) throw new Error('اكتب اسم البروتوكول');
        const q = m.protocol?.id ? sb.from('crm_protocols').update(row).eq('id', m.protocol.id) : sb.from('crm_protocols').insert({...row, sort: 100});
        const {error} = await q; if (error) throw error;
      }, 'تم الحفظ ✓'));
    } else if (m.type === 'crm-merge') {
      const inp = document.getElementById('crm-mg-q');
      inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
      inp.oninput = () => { clearTimeout(_deb); _deb = setTimeout(async () => {
        m.q = inp.value; m.results = inp.value.trim().length < 2 ? [] : (await rpc('crm_customer_list', {p_q: inp.value, p_limit: 10})); render(); }, 400); };
    }
  }

  // ---------------------------------------------------------------- Excel import / export
  async function readImport(file) {
    if (!file) return;
    try {
      await loadScript(XLSX_LIB);
      const wb = XLSX.read(await file.arrayBuffer(), {type: 'array'});
      let rows = null;
      for (const name of wb.SheetNames) {
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], {header: 1, raw: false, defval: ''});
        const hi = grid.slice(0, 8).findIndex(r => r.some(c => String(c).trim() === 'الاسم') && r.some(c => /الهاتف/.test(c)));
        if (hi < 0) continue;
        const h = grid[hi].map(x => String(x).trim()), col = (...names) => h.findIndex(x => names.some(n => x.startsWith(n)));
        const idx = {erp_id: col('رقم العميل'), name: col('الاسم'), phone: col('رقم الهاتف', 'الهاتف'), whatsapp: col('رقم واتساب'),
          gender: col('الجنس'), area: col('المنطقة'), address: col('عنوان'), notes: col('ملاحظات'), alias_erp: col('أرقام ERP مدمجة'),
          chronic_diseases: col('الأمراض المزمنة'), drug_allergies: col('الحساسية الدوائية'), current_medications: col('الأدوية الحالية')};
        rows = grid.slice(hi + 1).map((r, i) => { const o = {_row: hi + i + 2}; for (const k in idx) if (idx[k] >= 0) o[k] = String(r[idx[k]] ?? '').trim(); return o; })
          .filter(o => Object.keys(o).some(k => k !== '_row' && o[k]));
        break;
      }
      if (!rows) { showToast('لم يتم العثور على ورقة عملاء (أعمدة: الاسم، رقم الهاتف)', 'error'); return; }
      const problems = [], seen = new Set(), ok = [];
      rows.forEach(o => {
        if (!o.name || o.name.length < 2) { problems.push(`صف ${o._row}: الاسم فارغ — تم تخطيه`); return; }
        if (o.erp_id) { if (seen.has(o.erp_id)) { problems.push(`صف ${o._row}: رقم العميل ${o.erp_id} مكرر في الملف — تم تخطيه`); return; } seen.add(o.erp_id); }
        if (o.phone) { const n = normPhone(o.phone); if (validMobile(n)) o.phone = n; else problems.push(`صف ${o._row}: رقم الهاتف «${o.phone}» يحتاج مراجعة (حُفظ كما هو)`); }
        if (o.whatsapp && validMobile(o.whatsapp)) o.whatsapp = normPhone(o.whatsapp);
        o.alias_erp = o.alias_erp ? o.alias_erp.split(/[،,\s]+/).filter(Boolean) : [];
        delete o._row; ok.push(o);
      });
      S.imp = {file: file.name, rows: ok, problems, branch: S.imp?.branch ?? state.branch};
      render();
    } catch (e) { console.error(e); showToast('تعذّر قراءة الملف: ' + e.message, 'error'); }
  }
  async function runImport() {
    const imp = S.imp; if (!imp?.rows?.length) return;
    const br = v('crm-imp-branch') || null;
    if (!confirm(`استيراد ${imp.rows.length} عميل${br ? ` إلى «${bName(br)}»` : ' بدون فرع'}؟ العملاء الموجودون لا يتكررون.`)) return;
    imp.busy = true; const total = {added: 0, skipped: 0};
    try {
      for (let i = 0; i < imp.rows.length; i += 250) {
        imp.progress = `${Math.min(i + 250, imp.rows.length)} / ${imp.rows.length}`; render();
        const r = await rpc('crm_import', {p_rows: imp.rows.slice(i, i + 250), p_branch: br});
        total.added += r.added; total.skipped += r.skipped;
      }
      S.imp = {result: total, branch: br}; invalidate(); render(); showToast(`تم الاستيراد ✓ — ${total.added} عميل جديد`);
    } catch (e) { imp.busy = false; render(); showToast(crmErr(e), 'error'); }
  }
  async function fetchAll(table, cols) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const {data, error} = await sb.from(table).select(cols).order('id').range(from, from + 999);
      if (error) throw error; out.push(...data); if (data.length < 1000) break;
    }
    return out;
  }
  async function exportExcel() {
    showToast('⏳ جاري تجهيز ملف Excel…', 'info');
    try {
      await loadScript(XLSX_LIB);
      const [cs, med, plans, fus, ks] = await Promise.all([fetchAll('crm_customers', '*'), (async () => { const {data, error} = await sb.from('crm_medical').select('*'); if (error) throw error; return data; })(),
        fetchAll('crm_plans', '*'), fetchAll('crm_followups', '*'), fetchAll('crm_contacts', '*')]);
      const byId = Object.fromEntries(cs.map(c => [c.id, c])), medBy = Object.fromEntries(med.map(x => [x.customer_id, x]));
      const plan = Object.fromEntries(plans.map(p => [p.id, p]));
      const wb = XLSX.utils.book_new(); wb.Workbook = {Views: [{RTL: true}]};
      const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{'—': 'لا توجد بيانات'}]), name);
      add('العملاء', cs.filter(c => !c.merged_into).map(c => ({'رقم العميل (ERP)': c.erp_id || '', 'الاسم': c.name, 'رقم الهاتف': c.phone || '', 'رقم واتساب': c.whatsapp || '',
        'الجنس': c.gender || '', 'المنطقة': c.area || '', 'العنوان': c.address || '', 'VIP': c.is_vip ? 'نعم' : '', 'الفروع': (c.branches || []).map(branchName).join(' + '),
        'الأمراض المزمنة': medBy[c.id]?.chronic_diseases || '', 'الحساسية الدوائية': medBy[c.id]?.drug_allergies || '', 'الأدوية الحالية': medBy[c.id]?.current_medications || '',
        'ملاحظات': c.notes || '', 'أرقام ERP مدمجة': (c.alias_erp || []).join(', '), 'مؤرشف': c.archived ? 'نعم' : ''})));
      add('خطط المتابعة', plans.map(p => ({'العميل': byId[p.customer_id]?.name, 'النوع': CARE[p.care_type]?.label, 'المرض / التصنيف': p.title, 'الدواء / المنتج': p.product || '',
        'البدء': p.start_date, 'مدة العلبة': p.refill_days || '', 'الحالة': p.status === 'active' ? 'نشطة' : 'منتهية', 'سبب الإنهاء': p.end_reason || '', 'المسؤول': empName(p.assigned_emp), 'الفرع': bName(p.branch)})));
      add('المتابعات', fus.map(f => ({'العميل': byId[f.customer_id]?.name, 'الهاتف': byId[f.customer_id]?.phone || '', 'المتابعة': plan[f.plan_id]?.title || 'متابعة', 'الاستحقاق': f.due_date,
        'الحالة': (STATUS[f.status] || [f.status])[0], 'النتيجة': f.outcome || '', 'المسؤول': empName(f.assigned_emp), 'سجّلها': f.done_by_name || '', 'ملاحظات': f.notes || '', 'الفرع': bName(f.branch)})));
      add('سجل التواصل', ks.map(k => ({'الوقت': fmtDT(k.at), 'العميل': byId[k.customer_id]?.name, 'الوسيلة': k.channel, 'النتيجة': k.outcome || '', 'الموظف': k.emp_name || '', 'ملاحظات': k.notes || ''})));
      XLSX.writeFile(wb, `elkareem-crm-${todayISO()}.xlsx`);
      showToast('تم تحميل ملف Excel ✓');
    } catch (e) { console.error(e); showToast(crmErr(e), 'error'); }
  }

  // ---------------------------------------------------------------- KPI link
  // Scores for the selected year: {"2026-10": {"EK007": {score, …}}} (month index 0-based, like monthKey()).
  async function loadKpi(force) {
    if (!canUse() || !isStaffU() || S.kpiLoading || (!force && S.kpiYear === state.year)) return;
    S.kpiLoading = true;
    try {
      const rows = await rpc('crm_kpi', {p_from: `${state.year}-01-01`, p_to: `${state.year}-12-31`});
      const out = {};
      (rows || []).forEach(r => { (out[`${r.year}-${r.month0}`] ||= {})[r.emp_id] = r; });
      const changed = JSON.stringify(out) !== JSON.stringify(S.kpi);
      S.kpi = out; S.kpiYear = state.year;
      if (changed) { if (typeof saveAll === 'function') saveAll(); if (!state.modal) render(); }   // republish employees' snapshots
    } catch (e) { console.warn('CRM KPI', e); } finally { S.kpiLoading = false; }
  }
  let _kpiTimer = null;
  function scheduleKpi() { clearTimeout(_kpiTimer); _kpiTimer = setTimeout(() => loadKpi(true), 1500); }
  function kpiScore(empId, mk) {
    if (S.kpiYear !== state.year && isStaffU()) loadKpi();
    const r = S.kpi[mk]?.[empId];
    return r ? r.score : null;
  }
  function kpiDetail(empId, mk) { return S.kpi[mk]?.[empId] || null; }
  // card on "أدائي الشهري"
  function perfCard(empId) {
    if (!canUse() || !empId) return '';
    const [from, to] = monthBounds(state.year, state.month);
    const rows = load('crm_myperf', `${empId}|${from}`, () => rpc('crm_kpi', {p_from: from, p_to: to}));
    const r = (rows || []).find(x => x.emp_id === empId);
    return withStyle(`<div class="card" style="margin-top:16px"><div class="section-header"><h3>📞 متابعة العملاء — ${MONTHS_AR[state.month]}</h3>
      ${r ? `<span class="badge" style="background:${kpiColor(r.score)}22;color:${kpiColor(r.score)}">${r.score} — ${kpiLabel(r.score)}</span>` : ''}</div>
      ${rows === null ? loadingHTML : !r ? '<div style="color:var(--text3);font-size:13px">لا توجد متابعات مستحقة عليك هذا الشهر — درجة المتابعة في KPI محايدة (75).</div>' :
      `<div class="grid-4">${[['مستحقة', r.due, 'var(--text)'], ['في موعدها', r.on_time, 'var(--success)'], ['متأخرة', r.late, 'var(--warn)'], ['لم تُنفذ', r.overdue, 'var(--danger)']]
        .map(([l, val, c]) => `<div class="card-sm" style="text-align:center"><div class="crm-hint">${l}</div><div style="font-size:22px;font-weight:800;color:${c}">${val}</div></div>`).join('')}</div>
      <div class="crm-hint" style="margin-top:8px">تمثل ${typeof kpiWeights !== 'undefined' && kpiWeights?.satisfaction != null ? kpiWeights.satisfaction : 10}% من درجة KPI. سجّل نتيجة كل متابعة في يومها لتحصل على الدرجة الكاملة.</div>`}</div>`);
  }

  function onLogin() { S.kpi = {}; S.kpiYear = null; S.fu.branch = undefined; S.dashBranch = undefined; S.imp = null; if (canUse()) loadKpi(true); }
  function reset() { S.kpi = {}; S.kpiYear = null; S.custId = null; S.dueCount = 0; }

  return {nav, label, renderPage, modal, bind, kpiScore, kpiDetail, perfCard, onLogin, reset, loadKpi, open, _S: S};
})();

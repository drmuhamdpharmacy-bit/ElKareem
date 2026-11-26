// ════════════════════════════════════════════════════════════════════
//  صيدليات الكريم — المالية (Financial system) — OWNERS ONLY
//  Branch P&L, consolidated P&L, comparison, sales, inventory turnover, expenses, stock losses,
//  assets & depreciation, payroll cost, reconciliation checks — replaces the three Excel workbooks.
//
//  • Only users with role 'owner' ever see this section. It is NOT in the pages list that can be
//    ticked for supervisors, and the database refuses every fin_* row to anyone else
//    (supabase-finance.sql — row level security on profiles.role = 'owner').
//  • All calculations come from finance-engine.js (built from finance/src, tested against the
//    Excel golden results). It is loaded only after an owner opens this section.
//  • Linked to the app: monthly sales / GP / NP («الإدخال الشهري») are shown next to the ERP figures,
//    and from the chosen month on the P&L salaries come from «كشف الرواتب» (payrollRows) + owners' fixed salaries.
//  Loaded BEFORE the main script, like crm.js; it only uses the main script's globals when it runs.
// ════════════════════════════════════════════════════════════════════
const FIN = (() => {
  const ENGINE_URL = 'finance-engine.js?v=2';
  const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
  const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REASONS_EN = {'منتهي الصلاحية': 'Expired', 'تالف': 'Damaged', 'سرقة': 'Theft', 'خطأ جرد': 'Count error', 'أخرى': 'Other', 'غير محدد': 'Unspecified'};
  const PAGES = {
    fin_dashboard:    {icon: '💹', label: 'لوحة المالية', en: 'Finance dashboard'},
    fin_consolidated: {icon: '🧾', label: 'قائمة الدخل المجمعة', en: 'Consolidated P&L'},
    fin_comparison:   {icon: '⚖️', label: 'مقارنة الفروع', en: 'Branch comparison'},
    fin_branch:       {icon: '🏪', label: 'دفاتر وتقارير الفروع', en: 'Branch books & reports'},
    fin_shared:       {icon: '🏢', label: 'المصروفات المشتركة', en: 'Shared expenses'},
    fin_checks:       {icon: '✅', label: 'اختبارات المطابقة', en: 'Reconciliation checks'},
    fin_settings:     {icon: '🛠️', label: 'إعدادات المالية', en: 'Finance settings'},
    fin_audit:        {icon: '📜', label: 'سجل تعديلات المالية', en: 'Finance audit log'},
  };
  const TABS = [
    ['overview', 'نظرة عامة', 'Overview'], ['inputs', 'المدخلات الشهرية', 'Monthly inputs'], ['expenses', 'المصروفات', 'Expenses'],
    ['stock', 'التوالف والتسويات', 'Stock adjustments'], ['assets', 'الأصول', 'Assets'], ['payroll', 'تكلفة المرتبات', 'Payroll cost'],
    ['lateness', 'الموظفون والتأخير', 'Staff & lateness'], ['analysis', 'التحليل', 'Analysis'], ['sales', 'تحليل المبيعات', 'Sales analysis'],
    ['turnover', 'دوران المخزون', 'Inventory turnover'], ['pl', 'قائمة الدخل', 'P&L'], ['history', 'السجل التاريخي', 'History'],
  ];

  const S = {lang: 'ar', branch: null, tab: 'overview', payM: null, rm: null, data: null, loading: false, error: null,
             engine: null, enginePromise: null, filters: {}, preview: null, pkg: null, busy: false};

  // ---------------------------------------------------------------- access: owners only, always
  const canUse = () => !!state.user && state.user.role === 'owner';
  const T = (ar, en) => (S.lang === 'en' ? en : ar);
  const ar = () => S.lang !== 'en';
  const E = () => S.engine;
  const fmt = (v, f = 'money') => (S.engine ? S.engine.formatValue(v, f) : String(v ?? ''));
  const MN = () => (ar() ? MONTHS_AR : MONTHS_EN);

  // ---------------------------------------------------------------- loading
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('تعذر تحميل ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureEngine() {
    if (S.engine) return Promise.resolve(S.engine);
    if (!S.enginePromise) S.enginePromise = loadScript(ENGINE_URL).then(() => (S.engine = window.ElkFin));
    return S.enginePromise;
  }

  /** Reads a whole table (PostgREST returns at most 1000 rows per request). RLS: owners only. */
  async function all(table, build) {
    let out = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select('*');
      if (build) q = build(q);
      const {data, error} = await q.order('id', {ascending: true}).range(from, from + 999);
      if (error) throw error;
      out = out.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  async function rows(table, build) {          // tables without an `id` column
    let q = sb.from(table).select('*');
    if (build) q = build(q);
    const {data, error} = await q;
    if (error) throw error;
    return data || [];
  }

  // The app's current pay month (26 → 25), so future months never pull an empty payroll.
  function currentPayMonth() {
    try { const p = payMonthOf(cairo(Date.now()).date); return {y: p.y, m: p.m + 1}; } catch { const d = new Date(); return {y: d.getFullYear(), m: d.getMonth() + 1}; }
  }

  /**
   * Live link to the app for one finance branch: monthly sales/GP/NP («الإدخال الشهري») for every month,
   * and the payroll page lines from `fromMonth` on (only for pay months that have started).
   */
  async function appLink(appB, year, fromMonth) {
    if (!appB || typeof withBranch !== 'function' || typeof branchData === 'undefined' || !branchData[appB]) return null;
    try { if (typeof loadAttDays === 'function' && !attDays[`${appB}|${year}`]) await loadAttDays(appB, year); } catch (e) { console.warn('FIN attendance', e); }
    const now = currentPayMonth();
    return withBranch(appB, () => {
      const months = [];
      for (let m = 1; m <= 12; m++) {
        const mk = `${year}-${m - 1}`, md = getMonthData(mk);
        const x = {month: m, sales: +md.sales || null, gp: +md.gp || null, np: +md.np || null, payroll: null};
        const started = year < now.y || (year === now.y && m <= now.m);
        if (fromMonth && m >= fromMonth && started) {
          const pr = payrollRows(mk);
          x.payroll = {month: m, sales: +md.sales || null, commissionPool: pr.commData.pool, commissionLabel: pr.commData.label,
            lines: pr.rows.map(r => ({empId: r.e.id, employee: r.e.name, role: r.e.role || null, hours: r.hrs, salary: r.sal,
              commission: r.comm, bonuses: r.bt, penalties: r.pt, withdrawals: r.wd, net: r.net}))};
        }
        months.push(x);
      }
      return months;
    });
  }

  async function loadData() {
    const Eng = await ensureEngine();
    const [settings] = await rows('fin_settings');
    if (!settings) return {empty: true};
    const years = await rows('fin_years', q => q.order('year', {ascending: false}));
    const Y = S.year && years.some(y => y.year === S.year) ? S.year : settings.current_year;
    const fy = years.find(y => y.year === Y);
    if (!fy) return {empty: true};
    const [cats, acats, reasons, branchesRows, bsettings] = await Promise.all([
      rows('fin_expense_categories', q => q.order('sort_order')), rows('fin_asset_categories', q => q.order('sort_order')),
      rows('fin_adjustment_reasons', q => q.order('sort_order')), rows('fin_branches', q => q.order('sort_order')),
      rows('fin_branch_settings', q => q.eq('year', Y)),
    ]);
    const act = branchesRows.filter(b => b.active);
    const [opening, monthly, expenses, stock, assets, lateness, pmonths, plines, owners, shares, history, staff, assigns, shared, closings] = await Promise.all([
      all('fin_opening_balances', q => q.eq('year', Y)), all('fin_monthly_inputs', q => q.eq('year', Y)),
      all('fin_expenses', q => q.eq('fiscal_year', Y)), all('fin_stock_adjustments', q => q.eq('year', Y)), all('fin_assets'),
      all('fin_lateness'), all('fin_payroll_months', q => q.eq('year', Y)), all('fin_payroll_lines', q => q.eq('year', Y)),
      all('fin_payroll_owner_lines', q => q.eq('year', Y)), all('fin_commission_shares', q => q.eq('year', Y)),
      all('fin_history_monthly', q => q.lt('year', Y)), all('fin_staff'), all('fin_staff_assignments', q => q.lte('year', Y)),
      all('fin_shared_expenses', q => q.eq('fiscal_year', Y)), all('fin_month_closings', q => q.eq('year', Y)),
    ]);
    const by = (list, id) => list.filter(r => r.branch_id === id);
    const sortBy = (list, ...keys) => [...list].sort((a, b) => { for (const k of keys) { if ((a[k] ?? 0) < (b[k] ?? 0)) return -1; if ((a[k] ?? 0) > (b[k] ?? 0)) return 1; } return a.id - b.id; });
    // staff per branch per month (latest assignment at or before the month wins — decision S2)
    const staffBy = {};
    for (const st of staff) {
      const mine = assigns.filter(a => a.staff_id === st.id).sort((a, b) => a.year - b.year || a.from_month - b.from_month);
      const per = {};
      for (let m = 1; m <= 12; m++) {
        const cur = [...mine].reverse().find(a => a.year < Y || a.from_month <= m);
        if (cur) (per[cur.branch_id] = per[cur.branch_id] || []).push(m);
      }
      for (const [bid, ms] of Object.entries(per)) (staffBy[bid] = staffBy[bid] || []).push({id: st.id, latenessName: st.lateness_name, payrollName: st.payroll_name, role: st.role, appEmpId: st.app_emp_id, months: ms.length === 12 ? undefined : ms});
    }
    const fromMonth = fy.app_payroll_from_month || null;
    const links = {};
    for (const b of act) links[b.id] = await appLink(b.app_branch, Y, fromMonth);

    const ds = {
      companyNameAr: settings.name_ar, companyNameEn: settings.name_en,
      settings: {
        year: Y, startDay: fy.start_day, reportMonth: S.rm || fy.report_month, latenessAutoFromMonth: fy.lateness_auto_from_month,
        latenessHalfDayFromMinutes: fy.lateness_half_day_from_minutes, latenessTwoDaysAboveMinutes: fy.lateness_two_days_above_minutes,
        latenessDayHours: +fy.lateness_day_hours, commissionTierMode: fy.commission_tier_mode, bottomLine: fy.bottom_line,
      },
      expenseCategories: cats.map(c => ({key: c.key, nameAr: c.name_ar, nameEn: c.name_en, plClass: c.pl_class})),
      assetCategories: acats.map(c => ({name: c.name, usefulLifeMonths: c.useful_life_months})),
      adjustmentReasons: reasons.map(r => r.name_ar),
      branches: act.map(b => {
        const bs = bsettings.find(x => x.branch_id === b.id), ob = by(opening, b.id)[0], link = links[b.id];
        return {
          branch: {id: b.id, nameAr: b.name_ar, nameEn: b.name_en, color: b.color, depreciationRegisterFromMonth: bs?.depreciation_register_from_month ?? 1, openedMonth: bs?.opened_month ?? null},
          opening: ob ? {inventoryValue: ob.inventory_value, skuCount: ob.sku_count, inventoryQty: ob.inventory_qty} : null,
          monthly: by(monthly, b.id).map(r => ({month: r.month, grossSales: r.gross_sales, returns: r.returns, grossProfit: r.gross_profit, invoices: r.invoices, itemsSold: r.items_sold,
            loyaltyPoints: r.loyalty_points, salariesRecordedLegacy: r.salaries_recorded_legacy, purchasesGross: r.purchases_gross, purchaseReturns: r.purchase_returns,
            inventoryEndValue: r.inventory_end_value, skuEnd: r.sku_end, inventoryEndQty: r.inventory_end_qty, notes: r.notes})),
          expenses: by(expenses, b.id).map(r => ({id: r.id, date: r.date, description: r.description, categoryKey: r.category_key, amount: r.amount, periodOverride: r.period_override, source: r.source})),
          stockAdjustments: sortBy(by(stock, b.id), 'month').map(r => ({id: r.id, month: r.month, itemCode: r.item_code, itemName: r.item_name, qty: r.qty, unit: r.unit, unitCost: r.unit_cost, manualAmount: r.manual_amount, reason: r.reason, source: r.source})),
          assets: by(assets, b.id).map(r => ({id: r.id, name: r.name, cost: r.cost, category: r.category, customMonths: r.custom_months, dateAdded: r.date_added, notes: r.notes})),
          staff: staffBy[b.id] || [],
          lateness: sortBy(by(lateness, b.id), 'date').map(r => ({id: r.id, date: r.date, employee: r.employee, minutesLate: r.minutes_late, notes: r.notes})),
          payrollMonths: by(pmonths, b.id).map(r => ({month: r.month, salesForCommission: r.sales_for_commission, target: r.target, threshold1pct: r.threshold_1pct, threshold15pct: r.threshold_1_5pct, threshold2pct: r.threshold_2pct})),
          payrollLines: sortBy(by(plines, b.id), 'month', 'sort_order').map(r => ({id: r.id, month: r.month, employee: r.employee, role: r.role, baseHours: r.base_hours, actualHours: r.actual_hours, ratePer26h: r.rate_per_26h,
            deductions: r.deductions, additions: r.additions, additionsDetails: r.additions_details, deductionsDetails: r.deductions_details, latenessDaysRecorded: r.lateness_days_recorded, latenessAmountRecorded: r.lateness_amount_recorded, sortOrder: r.sort_order})),
          owners: by(owners, b.id).map(r => ({id: r.id, month: r.month, name: r.name, fixedAmount: r.fixed_amount})),
          commissionShares: sortBy(by(shares, b.id), 'month', 'sort_order').map(r => ({id: r.id, month: r.month, employee: r.employee, sharePct: r.share_pct})),
          history: sortBy(by(history, b.id), 'year', 'month').map(r => ({id: r.id, year: r.year, month: r.month, days: r.days, grossSales: r.gross_sales, returns: r.returns, netSales: r.net_sales, grossProfit: r.gross_profit,
            invoices: r.invoices, itemsSold: r.items_sold, loyaltyPoints: r.loyalty_points, purchasesGross: r.purchases_gross, purchaseReturns: r.purchase_returns, salaries: r.salaries, opex: r.opex, maintenance: r.maintenance})),
          linkedPayroll: fromMonth && link ? {fromMonth, months: link.filter(x => x.payroll).map(x => x.payroll)} : null,
        };
      }),
      sharedExpenses: shared.map(r => ({id: r.id, date: r.date, description: r.description, categoryKey: r.category_key, amount: r.amount, periodOverride: r.period_override, notes: r.notes})),
    };
    const result = Eng.computeCompany(ds);
    return {
      ds, result, checks: Eng.allChecks(result), gaps: Eng.dataGaps(result), settings, fy, years, branchesRows, reasons, acats, cats,
      closings: closings.map(c => ({branchId: c.branch_id, month: c.month})), links, year: Y, reportMonth: ds.settings.reportMonth, defaultReportMonth: fy.report_month,
    };
  }

  function data() {
    if (S.data) return S.data;
    if (!S.loading) {
      S.loading = true; S.error = null;
      loadData().then(d => { S.data = d; }).catch(e => { console.error(e); S.error = errText(e); })
        .finally(() => { S.loading = false; if (state.loggedIn && state.page && state.page.startsWith('fin_')) render(); });
    }
    return null;
  }
  function invalidate() { S.data = null; }
  function refresh(msg) { invalidate(); state.modal = null; S.preview = null; render(); if (msg) showToast(msg); }

  function errText(e) {
    const m = (e && (e.message || e.details || e.hint)) || String(e);
    if (/MONTH_CLOSED/.test(m)) return T('هذا الشهر مُغلق – يجب أن يعيد المالك فتحه أولًا', 'This month is closed – reopen it first');
    if (/row-level security|permission denied|not_allowed/.test(m)) return T('غير مسموح (للمالك فقط)', 'Not allowed (owners only)');
    if (/foreign key/.test(m)) return T('قيمة غير موجودة في القوائم المرجعية', 'Value not found in the reference lists');
    if (/duplicate key/.test(m)) return T('السطر موجود بالفعل', 'This row already exists');
    if (/fin_settings|relation .* does not exist|schema cache/.test(m)) return T('جداول المالية غير موجودة — شغّل ملف supabase-finance.sql في Supabase أولًا', 'Finance tables are missing — run supabase-finance.sql in Supabase first');
    return m;
  }
  async function act(fn, okMsg) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); refresh(okMsg || T('تم الحفظ ✓', 'Saved ✓')); }
    catch (e) { console.error(e); showToast(errText(e), 'error'); }
    finally { S.busy = false; }
  }
  const check = ({error}) => { if (error) throw error; };

  // ---------------------------------------------------------------- navigation hooks
  function nav(groups) {
    if (!canUse()) return groups;                     // supervisors / employees / kiosk: never listed
    const items = Object.entries(PAGES).map(([id, p]) => ({id, icon: p.icon, label: p.label}));
    const at = groups.findIndex(g => g.group === 'حسابي');
    groups.splice(at < 0 ? groups.length : at, 0, {group: 'المالية (للمالك فقط)', items});
    return groups;
  }
  const label = page => PAGES[page]?.label || '';

  function renderPage(page) {
    if (!PAGES[page]) return '';
    if (!canUse()) return `<div class="card" style="text-align:center;padding:40px;color:var(--text2)">🔒 ${T('هذا القسم للمالك فقط', 'Owners only')}</div>`;
    let html;
    try {
      const d = data();
      if (S.error) html = errorCard(S.error);
      else if (!d) html = typeof loadingHTML !== 'undefined' ? loadingHTML : '⏳';
      else if (d.empty && page !== 'fin_settings') html = emptyState();
      else html = ({fin_dashboard: pageDashboard, fin_consolidated: pageConsolidated, fin_comparison: pageComparison, fin_branch: pageBranch,
        fin_shared: pageShared, fin_checks: pageChecks, fin_settings: pageSettings, fin_audit: pageAudit})[page](d);
    } catch (e) { console.error(e); html = errorCard(e.message); }
    return withStyle(`<div class="fin" dir="${ar() ? 'rtl' : 'ltr'}">${header(page)}${html}</div>`);
  }
  const errorCard = m => `<div class="card" style="color:var(--danger)">⚠️ ${esc(m)} <button class="btn btn-ghost btn-sm" data-fin-reload>↻</button></div>`;
  const emptyState = () => `<div class="card" style="text-align:center;padding:40px"><div style="font-size:40px">📥</div>
    <div style="font-size:17px;font-weight:800;margin:8px 0">${T('لا توجد بيانات مالية بعد', 'No financial data yet')}</div>
    <div style="color:var(--text2);font-size:13px;margin-bottom:14px">${T('استورد حزمة البيانات (ملفات CSV و settings.json) من إعدادات المالية.', 'Import the data package (CSV files + settings.json) from Finance settings.')}</div>
    <button class="btn btn-primary" data-fin-go="fin_settings">🛠️ ${T('إعدادات المالية', 'Finance settings')}</button></div>`;

  function header(page) {
    const d = S.data;
    let right = `<button class="btn btn-ghost btn-sm" data-fin-lang>${ar() ? 'English' : 'العربية'}</button>`;
    if (d && !d.empty) {
      const fails = d.checks.checks.filter(c => c.status === 'fail').length, warns = d.checks.checks.filter(c => c.status === 'warn').length;
      right = `<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center">${T('شهر التقرير', 'Report month')}
          <select id="fin-rm" style="width:auto;padding:4px 8px">${MN().map((m, i) => `<option value="${i + 1}"${i + 1 === d.reportMonth ? ' selected' : ''}>${m}${i + 1 === d.defaultReportMonth ? ' •' : ''}</option>`).join('')}</select>
          <select id="fin-year" style="width:auto;padding:4px 8px">${d.years.map(y => `<option${y.year === d.year ? ' selected' : ''}>${y.year}</option>`).join('')}</select></label>
        <span class="badge ${fails ? 'badge-red' : 'badge-green'}" data-fin-go="fin_checks" style="cursor:pointer">${fails ? `✖ ${fails}` : '✔'}${warns ? ` · ⚠ ${warns}` : ''}</span>` + right;
    }
    return `<div class="fin-head no-print"><span class="badge badge-gray">🔒 ${T('للمالك فقط', 'Owners only')}</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${right}</div></div>`;
  }

  // ---------------------------------------------------------------- rendering helpers
  /** Renders an engine ReportTable. Calculated cells are read-only; key rows bold on a tint; negatives in red parentheses. */
  function table(t, opts = {}) {
    const a = ar();
    const notes = (a ? t.notesAr : t.notesEn) || [];
    return `<div class="fin-tw"${opts.max ? ` style="max-height:${opts.max}px"` : ''}><table class="fin-rt"><thead><tr><th class="lbl">${esc(a ? t.labelAr || '' : t.labelEn || '')}</th>
      ${t.columns.map(c => `<th class="${c.emphasis ? 'emph' : ''}">${esc(a ? c.ar : c.en)}</th>`).join('')}</tr></thead><tbody>
      ${t.rows.map(r => `<tr class="${r.style || ''}"><td class="lbl">${esc(a ? r.ar : r.en)}</td>${r.style === 'section' ? `<td colspan="${t.columns.length}"></td>`
        : r.values.map((v, j) => { const f = (r.fmts && r.fmts[j]) || t.columns[j]?.fmt || r.fmt, num = typeof v === 'number';
            return `<td class="${num ? 'n' : ''}${t.columns[j]?.emphasis ? ' emph' : ''}${num && v < 0 ? ' neg' : ''}">${esc(fmt(v, f))}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>${notes.length ? `<ul class="fin-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
  }
  const card = (title, body, actions = '') => `<div class="card fin-card"><div class="section-header"><h3>${title}</h3><div class="no-print" style="display:flex;gap:6px;flex-wrap:wrap">${actions}</div></div>${body}</div>`;
  const xbtn = (report, extra = {}) => `<button class="btn btn-ghost btn-sm" data-fin-export="${report}" data-fin-args='${esc(JSON.stringify(extra))}'>📊 ${T('تصدير Excel', 'Export Excel')}</button>`;
  const pbtn = () => `<button class="btn btn-ghost btn-sm" data-fin-print>🖨️ ${T('طباعة', 'Print')}</button>`;
  const bname = (d, id) => { const b = d.branchesRows.find(x => x.id === id); return b ? (ar() ? b.name_ar : b.name_en) : String(id); };
  const closed = (d, branchId, m) => m != null && d.closings.some(c => c.branchId === branchId && c.month === m);

  // ---- charts (plain SVG; brand green/sky pass the colour-blind checks: ΔE 23.9) -------------------
  const GREEN = '#0E6B30', SKY = '#038DD6';
  const short = v => { const a = Math.abs(v), s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a)); return v < 0 ? `(${s})` : s; };
  function ticks(min, max) {
    const span = Math.max(1, max - min), step0 = Math.pow(10, Math.floor(Math.log10(span / 4))), step = [1, 2, 2.5, 5, 10].map(k => k * step0).find(s => span / s <= 5);
    const out = []; for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) out.push(v); return out;
  }
  /** Column chart. series: [{name,color,values[12]}]; stacked or grouped. Months run right→left in Arabic. */
  function columnChart(series, {stacked = false, h = 240} = {}) {
    const W = 640, H = h, pl = 46, pr = 8, pt = 8, pb = 24, n = 12, rtl = ar();
    const tots = [...Array(n)].map((_, i) => stacked ? series.reduce((t, s) => t + Math.max(0, s.values[i]), 0) : Math.max(...series.map(s => s.values[i])));
    const mins = [...Array(n)].map((_, i) => Math.min(0, ...series.map(s => s.values[i])));
    const tk = ticks(Math.min(0, ...mins), Math.max(1, ...tots)), lo = tk[0], hi = tk[tk.length - 1];
    const y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo)), bw = (W - pl - pr) / n;
    const x = i => pl + (rtl ? n - 1 - i : i) * bw;
    let g = tk.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/><text x="${pl - 4}" y="${y(v) + 4}" text-anchor="end" class="ax">${short(v)}</text>`).join('');
    for (let i = 0; i < n; i++) {
      g += `<text x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${MN()[i]}</text>`;
      if (stacked) {
        let base = 0;
        series.forEach((s, k) => { const v = Math.max(0, s.values[i]); if (!v) return; const top = y(base + v), bot = y(base);
          g += `<rect x="${x(i) + bw * .18}" y="${top}" width="${bw * .64}" height="${Math.max(0, bot - top - (k ? 2 : 0))}" fill="${s.color}" rx="${k === series.length - 1 ? 3 : 0}"><title>${esc(s.name)} — ${MN()[i]}: ${fmt(s.values[i])}</title></rect>`; base += v; });
      } else {
        const gw = bw * .72 / series.length;
        series.forEach((s, k) => { const v = s.values[i], t = y(Math.max(0, v)), b = y(Math.min(0, v));
          g += `<rect x="${x(i) + bw * .14 + k * (gw + 1)}" y="${t}" width="${gw - 1}" height="${Math.max(0, b - t)}" fill="${s.color}" rx="3"><title>${esc(s.name)} — ${MN()[i]}: ${fmt(v)}</title></rect>`; });
      }
    }
    const legend = series.length > 1 ? `<div class="fin-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" class="fin-chart" role="img">${g}<line x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8"/></svg>${legend}`;
  }
  function barList(items) {          // horizontal bars, single series (slot 1 = green)
    const max = Math.max(1, ...items.map(i => i.value));
    return `<div class="fin-bars">${items.map(i => `<div class="fin-bar"><span class="l">${esc(i.label)}</span><span class="t"><b style="width:${(i.value / max * 100).toFixed(1)}%"></b></span><span class="v">${fmt(i.value, 'money0')}</span></div>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- pages: company level
  function gapsCard(d, branchId) {
    const gaps = d.gaps.filter(g => branchId === undefined || g.branchId === branchId);
    if (!gaps.length) return '';
    return card(`⚠️ ${T('بيانات ناقصة (لم يتم اختراع قيم لها)', 'Known data gaps (no values invented)')}`,
      `<div class="fin-gaps">${gaps.map(g => `<div><b>${esc(bname(d, g.branchId))}:</b> ${esc(ar() ? g.ar : g.en)} — ${g.months.map(m => MN()[m - 1]).join('، ')}</div>`).join('')}</div>`);
  }

  function pageDashboard(d) {
    const Eng = E(), r = d.result, R = d.reportMonth;
    const kpis = Eng.dashboardKpis(r);
    const cal = r.branches[0]?.calendar[R - 1];
    const cards = kpis.map(k => `<div class="stat-card${k.key === 'NET_RESULT' ? ' fin-key' : ''}"><div class="sc-label">${esc(ar() ? k.ar : k.en)} — ${MN()[R - 1]}</div>
      <div class="sc-val fin-n${k.month < 0 ? ' neg' : ''}">${fmt(k.month, 'money0')}</div>
      <div class="fin-sub">${k.monthPct != null ? `${T('من المبيعات', 'of sales')} <b class="fin-n">${fmt(k.monthPct, 'pct')}</b>` : ''}
      ${k.mom != null ? ` · ${T('عن الشهر السابق', 'vs prev.')} <b class="fin-n ${k.mom < 0 ? 'neg' : 'pos'}">${fmt(k.mom, 'pct')}</b>` : ''}</div>
      <div class="fin-sub">${T('من بداية السنة', 'YTD')}: <b class="fin-n">${fmt(k.ytd, 'money0')}</b>${k.ytdPct != null ? ` <span class="fin-n">(${fmt(k.ytdPct, 'pct')})</span>` : ''}</div></div>`).join('');
    const sales = columnChart(r.branches.map(b => ({name: ar() ? b.dataset.branch.nameAr : b.dataset.branch.nameEn, color: b.dataset.branch.color, values: b.series.NET_SALES.map(x => x.toNumber())})), {stacked: true});
    const gpnr = columnChart([{name: T('مجمل الربح', 'Gross profit'), color: GREEN, values: r.consolidated.GP.map(x => x.toNumber())},
      {name: T('صافي النتيجة', 'Net result'), color: SKY, values: r.consolidated.NET_RESULT.map(x => x.toNumber())}]);
    const exp = Eng.ytdExpenseBreakdown(r).filter(x => x.value > 0).map(x => ({label: ar() ? x.ar : x.en, value: x.value}));
    return `<div class="fin-title"><h2>💹 ${T('لوحة المالية', 'Finance dashboard')} — ${esc(ar() ? d.ds.companyNameAr : d.ds.companyNameEn)}</h2>
        <span>${T('شهر التقرير', 'Report month')}: ${MN()[R - 1]} ${d.year}${cal ? ` · ${cal.from} → ${cal.to}` : ''}</span><span style="flex:1"></span>${xbtn('dashboard')}${pbtn()}</div>
      <div class="grid-3 fin-kpis">${cards}</div>
      <div class="grid-2">${card(T('صافي المبيعات الشهري حسب الفرع', 'Monthly net sales by branch'), sales)}${card(T('مجمل الربح مقابل صافي النتيجة (المجمع)', 'Consolidated GP vs net result'), gpnr)}</div>
      <div class="grid-2">${card(T('مقارنة الفروع', 'Branch comparison'), table(Eng.comparisonTable(r)))}${card(T('المصروفات من بداية السنة حسب التصنيف (بدون المرتبات)', 'YTD expenses by category (excl. salaries)'), barList(exp))}</div>
      ${linkCard(d)}${gapsCard(d)}
      <p class="fin-foot">${T('صافي النتيجة = مجمل الربح − كل المصروفات − التوالف (قرار D1، قابل للتغيير من الإعدادات). جميع المبالغ بالجنيه المصري، والأرقام السالبة بين قوسين.',
        'Net result = gross profit − all expenses − expired/damaged (decision D1, configurable). All amounts in EGP; negatives in parentheses.')}</p>`;
  }

  /** The live link with the app: sales entered in «الإدخال الشهري» vs ERP net sales, and where salaries come from. */
  function linkCard(d) {
    const R = d.reportMonth, from = d.fy.app_payroll_from_month;
    const rowsH = d.result.branches.map(b => {
      const fb = d.branchesRows.find(x => x.id === b.branchId), link = d.links[b.branchId];
      if (!link) return `<tr><td>${esc(bname(d, b.branchId))}</td><td colspan="5" style="color:var(--text3)">${fb?.app_branch ? T('فرع التطبيق غير متاح', 'App branch not available') : T('غير مربوط بفرع في التطبيق — اربطه من إعدادات المالية', 'Not linked to an app branch — link it in Finance settings')}</td></tr>`;
      const x = link[R - 1], erp = b.series.NET_SALES[R - 1].toNumber(), p = b.payroll[R - 1];
      return `<tr><td>${esc(bname(d, b.branchId))} <span class="badge badge-gray">${esc(fb.app_branch)}</span></td><td class="n">${fmt(x.sales, 'money0')}</td><td class="n">${fmt(erp, 'money0')}</td>
        <td class="n${x.sales != null && Math.abs(x.sales - erp) > 0.5 ? ' warnc' : ''}">${x.sales == null ? '—' : fmt(x.sales - erp, 'money0')}</td>
        <td class="n">${fmt(x.gp, 'money0')}</td><td>${p.source === 'app' ? `🔗 ${T('من كشف الرواتب في التطبيق', 'from the app payroll')}` : T('من دفتر المالية (Excel)', 'from the finance payroll (Excel)')}</td></tr>`;
    }).join('');
    return card(`🔗 ${T('الربط مع التطبيق', 'Link with the app')} — ${MN()[R - 1]}`,
      `<div class="table-wrap"><table class="fin-rt"><thead><tr><th>${T('الفرع', 'Branch')}</th><th>${T('المبيعات في «الإدخال الشهري»', 'Sales in «Monthly input»')}</th><th>${T('صافي المبيعات (البرنامج/ERP)', 'Net sales (ERP)')}</th><th>${T('الفرق', 'Difference')}</th><th>${T('إجمالي الربح في التطبيق', 'GP in the app')}</th><th>${T('مصدر المرتبات', 'Salaries source')}</th></tr></thead><tbody>${rowsH}</tbody></table></div>
       <p class="fin-foot">${from ? T(`المرتبات في قائمة الدخل من شهر ${MN()[from - 1]}: من «كشف الرواتب» في التطبيق + مرتبات الملاك الثابتة. الشهور قبله: كما سُجلت في ملفات Excel.`, `P&L salaries from ${MN()[from - 1]}: the app's payroll page + owners' fixed salaries. Earlier months: as recorded in Excel.`)
         : T('الربط مع كشف الرواتب متوقف (إعدادات المالية).', 'Payroll link is off (Finance settings).')}</p>`);
  }

  function pageConsolidated(d) {
    const Eng = E(), r = d.result;
    const alloc = Eng.simulateSharedAllocation(r);
    return `<div class="fin-title"><h2>🧾 ${T('قائمة الدخل المجمعة', 'Consolidated P&L')}</h2><span>${T('الفروع + المصروفات المشتركة (عمود مستقل – لا توزيع تلقائي)', 'Branches + shared expenses (separate column – never allocated)')}</span><span style="flex:1"></span>${xbtn('consolidated')}${pbtn()}</div>
      <div class="grid-2">${card(T('شهر التقرير', 'Report month'), table(Eng.consolidatedSideBySide(r, 'month')))}${card(T('من بداية السنة', 'Year to date'), table(Eng.consolidatedSideBySide(r, 'ytd')))}</div>
      ${card(T('قائمة الدخل المجمعة شهريًا', 'Monthly consolidated P&L'), table(Eng.consolidatedMonthlyTable(r)))}
      ${card(`📦 ${T('دوران المخزون المجمع', 'Consolidated inventory turnover')}`, table(Eng.consolidatedTurnoverTable(r, S.lang)), xbtn('turnover-consolidated'))}
      ${card(T('دوران المخزون المجمع ربع السنوي', 'Consolidated quarterly turnover'), table(Eng.consolidatedTurnoverQuarterTable(r, S.lang)))}
      ${card(`${T('توزيع المشترك حسب حصة المبيعات', 'Shared allocation by share of sales')} — <span style="color:var(--warn)">${T('محاكاة فقط – لا تُسجل', 'simulation only – never posted')}</span>`,
        `<div class="table-wrap"><table class="fin-rt"><thead><tr><th>${T('الفرع', 'Branch')}</th><th>${T('صافي المبيعات YTD', 'Net sales YTD')}</th><th>${T('الحصة', 'Share')}</th><th>${T('نصيب المشترك', 'Allocated')}</th></tr></thead><tbody>
        ${alloc.map(a => `<tr><td>${esc(bname(d, a.branchId))}</td><td class="n">${fmt(a.netSales.toNumber())}</td><td class="n">${fmt(a.share.toNumber(), 'pct')}</td><td class="n">${fmt(a.allocated.toNumber())}</td></tr>`).join('')}</tbody></table></div>`)}`;
  }

  function pageComparison(d) {
    return `<div class="fin-title"><h2>⚖️ ${T('مقارنة الفروع', 'Branch comparison')}</h2><span>${T('النسب في الأعمدة المجمعة محسوبة من الإجماليات', 'Ratios in total columns are recomputed from totals')}</span><span style="flex:1"></span>${xbtn('comparison')}${pbtn()}</div>
      ${card('', table(E().comparisonTable(d.result)))}`;
  }

  function pageChecks(d) {
    const cs = d.checks.checks, fails = cs.filter(c => c.status === 'fail').length, warns = cs.filter(c => c.status === 'warn').length;
    const icon = {ok: '✔', warn: '⚠', fail: '✖'}, cls = {ok: 'badge-green', warn: 'badge-gold', fail: 'badge-red'};
    const groups = [...d.result.branches.map(b => [`branch:${b.branchId}`, bname(d, b.branchId)]), ['company', T('المجمع', 'Consolidated')]];
    const v = (c, x) => x == null ? '' : fmt(x, /^(B9|B10|B11|C7)/.test(c.id) ? 'int' : 'money');
    return `<div class="fin-title"><h2>✅ ${T('اختبارات المطابقة', 'Reconciliation checks')}</h2><span style="flex:1"></span>${xbtn('checks')}${pbtn()}</div>
      <div class="card" style="border:2px solid ${fails ? 'var(--danger)' : 'var(--success)'};font-size:17px;font-weight:800;color:${fails ? 'var(--danger)' : 'var(--success)'}">
        ${fails ? `✖ ${fails} ${T('اختبار يحتاج مراجعة', 'failing checks')}` : `✔ ${T('كل الاختبارات سليمة', 'All checks pass')}`}${warns ? ` <span style="color:var(--warn);font-size:14px">· ⚠ ${warns} ${T('تنبيهات', 'warnings')}</span>` : ''}
        <div style="font-size:12px;font-weight:400;color:var(--text2)">${T('النتيجة العامة ✔ فقط عند عدم وجود ✖ – التنبيهات لا تمنع الاعتماد.', 'Overall is ✔ only when there is no ✖ – warnings do not block.')}</div></div>
      ${groups.map(([scope, title]) => card(esc(title), `<div class="table-wrap"><table class="fin-rt"><thead><tr><th class="lbl">${T('الاختبار', 'Test')}</th><th>${T('القيمة أ', 'A')}</th><th>${T('القيمة ب', 'B')}</th><th>${T('الفرق', 'Diff')}</th><th>${T('النتيجة', 'Result')}</th></tr></thead><tbody>
        ${cs.filter(c => c.scope === scope).map(c => `<tr><td class="lbl" style="white-space:normal"><span style="color:var(--text3);font-size:11px">${c.id}</span> ${esc(ar() ? c.labelAr : c.labelEn)}${(ar() ? c.detailAr : c.detailEn) ? `<div style="color:var(--warn);font-size:11px">${esc(ar() ? c.detailAr : c.detailEn)}</div>` : ''}</td>
          <td class="n">${v(c, c.a)}</td><td class="n">${v(c, c.b)}</td><td class="n">${v(c, c.diff)}</td><td><span class="badge ${cls[c.status]}">${icon[c.status]}</span></td></tr>`).join('')}</tbody></table></div>`)).join('')}
      ${gapsCard(d)}`;
  }

  // ---------------------------------------------------------------- generic ledger table (add / edit / delete / import / export)
  const WARN = {
    no_category: ['⚠ بدون تصنيف', '⚠ No category'], unknown_category: ['⚠ تصنيف غير معروف', '⚠ Unknown category'], no_date: ['⚠ أدخل التاريخ', '⚠ Enter the date'],
    out_of_year: ['⚠ خارج السنة المالية', '⚠ Outside the fiscal year'], date_mismatch: ['⚠ التاريخ لا يطابق الشهر', '⚠ Date does not match the period'],
    unknown_reason: ['⚠ سبب غير معروف', '⚠ Unknown reason'], no_period: ['⚠ بدون شهر', '⚠ No period'], unknown_employee: ['⚠ الاسم غير موجود في قائمة الموظفين', '⚠ Name not in the staff list'],
  };
  const warnText = w => (w ? (WARN[w] || [w, w])[ar() ? 0 : 1] : '');
  S.ledgers = {};   // key → {rows, branchId, month} of the last render (edit modal looks rows up here)

  function options(d, type, branchId) {
    if (type === 'category') return d.cats.map(c => ({value: c.key, label: ar() ? c.name_ar : c.name_en}));
    if (type === 'reason') return d.reasons.map(r => ({value: r.name_ar, label: ar() ? r.name_ar : `${r.name_en || r.name_ar}`}));
    if (type === 'assetCategory') return d.acats.map(c => ({value: c.name, label: `${c.name}${c.useful_life_months ? ` (${c.useful_life_months})` : ''}`}));
    if (type === 'staffLateness') { const b = d.ds.branches.find(x => x.branch.id === branchId); return (b?.staff || []).map(s => ({value: s.latenessName, label: s.latenessName === s.payrollName ? s.latenessName : `${s.latenessName} – ${s.payrollName}`})); }
    return null;
  }
  function shown(d, f, v, branchId) {
    if (v === null || v === undefined || v === '') return '';
    const o = options(d, f.type, branchId);
    if (o) return (o.find(x => x.value === v) || {label: v}).label;
    if (f.type === 'number') return fmt(+v, 'money');
    if (f.type === 'pct') return fmt(+v, 'pct');
    return String(v);
  }

  function ledger(d, key, o) {
    const def = E().LEDGERS[key], fields = def.fields.filter(f => !f.hidden), id = `${key}-${o.branchId ?? 'c'}-${o.month ?? ''}`;
    S.ledgers[key] = {rows: o.rows, branchId: o.branchId ?? null, month: o.month};
    const f = S.filters[id] || (S.filters[id] = {q: '', p: '', w: false});
    const warnCol = (o.extras || []).find(x => x.warn);
    const list = o.rows.filter(r => {
      if (f.p && String(r.values[o.periodKey] ?? r.extra?.[o.periodKey] ?? '') !== f.p) return false;
      if (f.w && warnCol && !r.extra?.[warnCol.key]) return false;
      if (f.q) { const hay = [...Object.values(r.values), ...Object.values(r.extra || {})].map(x => String(x ?? '')).join(' ').toLowerCase(); if (!hay.includes(f.q.toLowerCase())) return false; }
      return true;
    });
    const total = o.totalKey ? list.reduce((t, r) => t + (+(r.values[o.totalKey] ?? r.extra?.[o.totalKey]) || 0), 0) : null;
    const args = esc(JSON.stringify({key, branchId: o.branchId ?? null, month: o.month ?? null}));
    return `<div class="fin-ledger">
      <div class="fin-bar-tools no-print">
        <input type="search" placeholder="${T('بحث…', 'Search…')}" value="${esc(f.q)}" data-fin-q="${id}" style="max-width:220px">
        ${o.periodKey ? `<select data-fin-p="${id}" style="width:auto"><option value="">${T('كل الشهور', 'All periods')}</option>${MN().map((m, i) => `<option value="${i + 1}"${f.p === String(i + 1) ? ' selected' : ''}>${i + 1} – ${m}</option>`).join('')}</select>` : ''}
        ${warnCol ? `<label class="fin-chk"><input type="checkbox" data-fin-w="${id}"${f.w ? ' checked' : ''}> ${T('التنبيهات فقط', 'Warnings only')}</label>` : ''}
        <span style="color:var(--text3);font-size:12px">${list.length} / ${o.rows.length}</span><span style="flex:1"></span>
        ${o.canWrite === false ? '' : `<button class="btn btn-primary btn-sm" data-fin-add='${args}'>➕ ${T('إضافة سطر', 'Add line')}</button>`}
        ${o.canWrite === false || o.noImport ? '' : `<button class="btn btn-ghost btn-sm" data-fin-import='${args}'>📥 ${T('استيراد Excel/CSV', 'Import Excel/CSV')}</button>`}
        <button class="btn btn-ghost btn-sm" data-fin-lexport='${args}'>📊 Excel</button><button class="btn btn-ghost btn-sm" data-fin-lexport='${args}' data-csv="1">CSV</button>
      </div>
      <div class="fin-tw"${o.compact ? '' : ' style="max-height:62vh"'}><table class="fin-rt fin-led"><thead><tr>
        ${fields.map(x => `<th>${esc(ar() ? x.ar : x.en)}${x.required ? ' *' : ''}</th>`).join('')}
        ${(o.extras || []).map(x => `<th class="calc">${esc(ar() ? x.ar : x.en)}</th>`).join('')}<th></th></tr></thead><tbody>
        ${list.map(r => `<tr${warnCol && r.extra?.[warnCol.key] ? ' class="warnrow"' : ''}>
          ${fields.map(x => `<td class="in${['number', 'int', 'pct', 'month', 'date'].includes(x.type) ? ' n' : ''}">${esc(shown(d, x, r.values[x.name], o.branchId))}</td>`).join('')}
          ${(o.extras || []).map(x => { const v = r.extra?.[x.key]; return `<td class="${typeof v === 'number' ? 'n' : ''}${x.warn && v ? ' warnc' : ''}">${typeof v === 'number' ? fmt(v, x.fmt || 'money') : esc(v ?? '')}</td>`; }).join('')}
          <td class="acts">${r.locked ? '🔒' : o.canWrite === false ? '' : `<button class="btn btn-ghost btn-sm" data-fin-edit="${key}|${r.id}">✏️</button><button class="btn btn-ghost btn-sm" data-fin-del="${key}|${r.id}">🗑</button>`}</td></tr>`).join('')
          || `<tr><td colspan="${fields.length + (o.extras || []).length + 1}" style="text-align:center;color:var(--text3);padding:18px">${T('لا توجد سطور', 'No lines')}</td></tr>`}
      </tbody>${total !== null ? `<tfoot><tr class="total"><td colspan="${fields.length + (o.extras || []).length + 1}">${T('الإجمالي (حسب التصفية)', 'Total (filtered)')}: <b class="fin-n">${fmt(total)}</b></td></tr></tfoot>` : ''}</table></div></div>`;
  }

  function closingStrip(d, branchId) {
    const isClosed = m => closed(d, branchId, m);
    return `<div class="fin-close no-print"><span>${T('إغلاق الشهور:', 'Month closing:')}</span>${MN().map((m, i) => `<button class="fin-mc${isClosed(i + 1) ? ' on' : ''}" data-fin-close="${branchId ?? ''}|${i + 1}" title="${isClosed(i + 1) ? T('إعادة فتح (يُسجل)', 'Reopen (audited)') : T('إغلاق – يصبح للقراءة فقط', 'Close – becomes read-only')}">${isClosed(i + 1) ? '🔒' : '○'} ${m}</button>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- page: branch workspace
  function pageBranch(d) {
    const brs = d.result.branches;
    if (!brs.length) return emptyState();
    if (!brs.some(b => b.branchId === S.branch)) S.branch = brs[0].branchId;
    const b = brs.find(x => x.branchId === S.branch), fb = d.branchesRows.find(x => x.id === S.branch);
    const tabs = TABS.map(([k, a, e]) => `<button class="fin-tab${S.tab === k ? ' on' : ''}" data-fin-tab="${k}">${ar() ? a : e}</button>`).join('');
    const chips = brs.map(x => `<button class="fin-bchip${x.branchId === S.branch ? ' on' : ''}" data-fin-branch="${x.branchId}" style="--c:${x.dataset.branch.color}"><i></i>${esc(bname(d, x.branchId))}</button>`).join('');
    const fn = {overview: tabOverview, inputs: tabInputs, expenses: tabExpenses, stock: tabStock, assets: tabAssets, payroll: tabPayroll, lateness: tabLateness,
      analysis: tabAnalysis, sales: tabSales, turnover: tabTurnover, pl: tabPl, history: tabHistory}[S.tab] || tabOverview;
    return `<div class="card fin-card" style="border-top:4px solid ${fb.color}"><div class="fin-chips">${chips}<span style="flex:1"></span>${xbtn('branch-all', {b: b.branchId})}</div>
        <div style="font-size:12px;color:var(--text2);margin:6px 0">${esc(ar() ? fb.name_en : fb.name_ar)} · ${T('شهر التقرير', 'Report month')}: ${MN()[d.reportMonth - 1]} ${d.year}
          · ${T('الإهلاك من سجل الأصول بدءًا من شهر', 'Register depreciation from month')} ${b.dataset.branch.depreciationRegisterFromMonth}
          · ${fb.app_branch ? `🔗 ${T('مربوط بفرع التطبيق', 'linked to app branch')} <b>${esc(fb.app_branch)}</b>` : T('غير مربوط بالتطبيق', 'not linked to the app')}</div>
        ${closingStrip(d, b.branchId)}<div class="fin-tabs no-print">${tabs}</div></div>${fn(d, b)}`;
  }

  function tabOverview(d, b) {
    const Eng = E(), R = d.reportMonth, s = b.series;
    const k = (code, a, e) => ({a, e, m: s[code][R - 1].toNumber(), y: Eng.ytd(s[code], R).toNumber()});
    const ks = [k('NET_SALES', 'صافي المبيعات', 'Net sales'), k('GP', 'مجمل الربح', 'Gross profit'), k('TOTAL_EXP', 'إجمالي المصروفات', 'Total expenses'),
      k('OP_RESULT', 'النتيجة التشغيلية', 'Operating result'), k('EXPIRED', 'التوالف', 'Expired'), k('NET_RESULT', 'صافي النتيجة', 'Net result')];
    const pl = Eng.branchPLTable(b), keep = ['NET_SALES', 'GP', 'GP_PCT', 'SALARIES', 'STAFF_OPEX', 'OPEX', 'DEP', 'POINTS', 'TOTAL_EXP', 'OP_RESULT', 'EXPIRED', 'NET_RESULT', 'NET_MARGIN'];
    const idx = pl.columns.map((c, i) => [c.key, i]).filter(([kk]) => ['rm', 'ytd', 'fy', 'pct'].includes(kk)).map(([, i]) => i);
    const small = {...pl, columns: idx.map(i => pl.columns[i]), rows: pl.rows.filter(r => keep.includes(r.key)).map(r => ({...r, values: idx.map(i => r.values[i]), fmts: r.fmts ? idx.map(i => r.fmts[i]) : undefined}))};
    const checks = d.checks.checks.filter(c => c.scope === `branch:${b.branchId}`);
    return `<div class="grid-3 fin-kpis">${ks.map(x => `<div class="stat-card"><div class="sc-label">${ar() ? x.a : x.e} — ${MN()[R - 1]}</div><div class="sc-val fin-n${x.m < 0 ? ' neg' : ''}">${fmt(x.m, 'money0')}</div><div class="fin-sub">${T('من بداية السنة', 'YTD')}: <b class="fin-n">${fmt(x.y, 'money0')}</b></div></div>`).join('')}</div>
      <div class="grid-2">${card(T('ملخص قائمة الدخل', 'P&L summary'), table(small))}
        ${card(T('اختبارات الفرع', 'Branch checks'), `<div class="fin-checklist">${checks.map(c => `<div><span class="badge ${c.status === 'ok' ? 'badge-green' : c.status === 'warn' ? 'badge-gold' : 'badge-red'}">${c.status === 'ok' ? '✔' : c.status === 'warn' ? '⚠' : '✖'}</span> ${esc(ar() ? c.labelAr : c.labelEn)}${c.status === 'warn' && c.a != null ? ` — <b class="fin-n">${fmt(c.a, Number.isInteger(c.a) ? 'int' : 'money')}</b>` : ''}</div>`).join('')}</div>`)}</div>
      ${gapsCard(d, b.branchId)}`;
  }

  const INPUT_COLS = [
    ['gross_sales', 'grossSales', 'إجمالي المبيعات', 'Gross sales'], ['returns', 'returns', 'المرتجعات', 'Returns'], ['gross_profit', 'grossProfit', 'قيمة الربحية (مجمل الربح)', 'Gross profit'],
    ['invoices', 'invoices', 'عدد الفواتير', 'Invoices', 1], ['items_sold', 'itemsSold', 'عدد الأصناف المباعة', 'Items sold', 1], ['loyalty_points', 'loyaltyPoints', 'النقاط', 'Loyalty points'],
    ['salaries_recorded_legacy', 'salariesRecordedLegacy', 'المرتبات المسجلة سابقًا (للمطابقة)', 'Salaries recorded (reconciliation)'],
    ['purchases_gross', 'purchasesGross', 'إجمالي المشتريات', 'Purchases (gross)'], ['purchase_returns', 'purchaseReturns', 'مرتجع المشتريات', 'Purchase returns'],
    ['inventory_end_value', 'inventoryEndValue', 'مخزون آخر الشهر (قيمة)', 'Ending inventory'], ['sku_end', 'skuEnd', 'عدد الأصناف بالمخزون', 'SKUs at end', 1],
    ['inventory_end_qty', 'inventoryEndQty', 'كمية المخزون', 'Qty at end'], ['notes', 'notes', 'ملاحظات', 'Notes', 2],
  ];
  function tabInputs(d, b) {
    const link = d.links[b.branchId], ob = b.dataset.opening || {}, lockedOb = closed(d, b.branchId, 1), from = d.fy.app_payroll_from_month;
    const rowsH = b.monthly.map((m, i) => {
      const lk = closed(d, b.branchId, i + 1), app = link?.[i];
      return `<tr><td class="lbl">${MN()[i]}</td><td class="n" style="color:var(--text3)">${b.calendar[i].days}</td>
        ${INPUT_COLS.map(([col, prop, , , t]) => {
          // From the payroll-link month on, salaries come from «كشف الرواتب»: the old recorded figure is no longer used.
          const linkedLegacy = col === 'salaries_recorded_legacy' && from && i + 1 >= from;
          return `<td><input class="fin-cell${t === 2 ? '' : ' n'}${linkedLegacy ? ' fin-off' : ''}" ${lk || linkedLegacy ? 'disabled' : ''} data-fin-in="${i + 1}|${col}" value="${esc(m?.[prop] ?? '')}"${t === 2 ? '' : ' dir="ltr" inputmode="decimal"'}${linkedLegacy ? ` title="${T('غير مستخدم – المرتبات من «كشف الرواتب» في التطبيق', 'Not used – salaries come from the app\'s payroll')}" placeholder="🔗"` : ''}></td>`;
        }).join('')}
        <td class="n calc">${app?.sales != null ? fmt(app.sales, 'money0') : ''}</td>
        <td>${lk ? '🔒' : `<button class="btn btn-success btn-sm" data-fin-insave="${i + 1}">💾</button>`}</td></tr>`;
    }).join('');
    return card(`📅 ${T('المدخلات الشهرية من البرنامج (ERP) – تُدخل مرة واحدة هنا فقط', 'Monthly ERP inputs – entered once, here only')}`,
      `<div class="fin-ob"><b>${T('أرصدة أول السنة:', 'Opening balances:')}</b>
        ${[['inventory_value', 'inventoryValue', 'قيمة المخزون', 'Inventory value'], ['sku_count', 'skuCount', 'عدد الأصناف', 'SKU count'], ['inventory_qty', 'inventoryQty', 'كمية المخزون', 'Inventory qty']]
          .map(([col, p, a, e]) => `<label>${ar() ? a : e}<input class="fin-cell n" dir="ltr" data-fin-ob="${col}" value="${esc(ob[p] ?? '')}" ${lockedOb ? 'disabled' : ''}></label>`).join('')}
        ${lockedOb ? '🔒' : `<button class="btn btn-success btn-sm" data-fin-obsave>💾 ${T('حفظ', 'Save')}</button>`}</div>
      <p class="fin-foot">${T('الخلايا الصفراء = مدخلات. اترك الخلية فارغة إذا لم يُدخل الرقم بعد (الفارغ ليس صفرًا). العمود الأخير للمقارنة: المبيعات المسجلة في «الإدخال الشهري» بالتطبيق.',
        'Yellow cells are inputs. Leave a cell empty when not entered yet (empty ≠ zero). Last column, for comparison: sales recorded in the app\'s «Monthly input».')}</p>
      ${from ? `<p class="fin-foot">🔗 ${T(`«المرتبات المسجلة سابقًا» رمادية بدءًا من ${MN()[from - 1]}: المرتبات تأتي تلقائيًا من «كشف الرواتب»، والعمود للمطابقة مع ملفات Excel القديمة فقط.`, `«Salaries recorded» is greyed out from ${MN()[from - 1]}: salaries come automatically from the app's payroll; the column is only for reconciling the old Excel files.`)}</p>` : ''}
      <div class="fin-tw"><table class="fin-rt"><thead><tr><th class="lbl">${T('الشهر', 'Month')}</th><th>${T('الأيام', 'Days')}</th>${INPUT_COLS.map(c => `<th${c[0] === 'salaries_recorded_legacy' && from ? ` title="${T(`لا يُستخدم بدءًا من ${MN()[from - 1]}`, `Not used from ${MN()[from - 1]}`)}"` : ''}>${ar() ? c[2] : c[3]}</th>`).join('')}<th class="calc">🔗 ${T('مبيعات التطبيق', 'App sales')}</th><th></th></tr></thead><tbody>${rowsH}</tbody></table></div>`,
      xbtn('inputs', {b: b.branchId}));
  }

  function tabExpenses(d, b) {
    const cls = {OPEX: T('تشغيل', 'Opex'), STAFF: T('عاملين', 'Staff'), DEP: T('إهلاك', 'Depreciation')};
    const tot = b.expenses.reduce((t, e) => t + (e.expense.amount || 0), 0), inc = b.expenses.filter(e => e.inPl).reduce((t, e) => t + (e.expense.amount || 0), 0);
    const review = b.expenses.filter(e => e.warning).length;
    return card(`🧾 ${T('دفتر المصروفات التشغيلية', 'Operating expenses ledger')}`,
      `<div class="fin-sums"><span>${T('إجمالي الدفتر', 'Ledger total')}: <b class="fin-n">${fmt(tot)}</b></span><span>${T('يدخل قائمة الدخل', 'In P&L')}: <b class="fin-n">${fmt(inc)}</b></span>
        <span>${T('مستبعد (من سجل الأصول)', 'Excluded (asset register)')}: <b class="fin-n">${fmt(tot - inc)}</b></span><span class="${review ? 'warnc' : ''}">⚠ ${T('بنود تحتاج مراجعة', 'Lines to review')}: ${review}</span></div>
       <p class="fin-foot">${T('الشهر المالي يُحسب من التاريخ (26 → 25) ما لم يُكتب «تعديل يدوي». القيم السالبة = استردادات. الإهلاك المكتوب يدويًا يُستبعد بدءًا من شهر سجل الأصول.',
         'The fiscal period comes from the date (26 → 25) unless overridden. Negative amounts are recoveries. Manual depreciation is excluded from the register start month.')}</p>
       ${ledger(d, 'expenses', {branchId: b.branchId, periodKey: 'period', totalKey: 'amount',
         extras: [{key: 'period', ar: 'الشهر المالي', en: 'Period', fmt: 'int'}, {key: 'cls', ar: 'نوع البند', en: 'Class'}, {key: 'inpl', ar: 'يدخل قائمة الدخل؟', en: 'In P&L?'}, {key: 'warning', ar: 'تنبيه', en: 'Check', warn: true}],
         rows: b.expenses.map(e => ({id: e.expense.id, locked: closed(d, b.branchId, e.period),
           values: {date: e.expense.date, description: e.expense.description, category_key: e.expense.categoryKey, amount: e.expense.amount, period_override: e.expense.periodOverride, source: e.expense.source},
           extra: {period: e.period, cls: e.plClass ? cls[e.plClass] : '?', inpl: e.inPl ? T('نعم', 'Yes') : T('لا – من سجل الأصول', 'No – asset register'), warning: warnText(e.warning)}}))})}`);
  }

  function tabStock(d, b) {
    return card(`🗑️ ${T('التوالف والإكسبير وتسويات المخزون', 'Expired, damaged & stock adjustments')}`,
      `<p class="fin-foot">${T('القيمة = المبلغ اليدوي إن وجد، وإلا الكمية × تكلفة الوحدة. تقرير البرنامج تراكمي: عند الاستيراد اختر الشهر ثم علّم سطوره فقط.', 'Value = manual amount if present, else qty × unit cost. The ERP report is cumulative: when importing, pick the month and tick only its lines.')}</p>
       <div class="fin-erp no-print"><b>📥 ${T('استيراد تقرير تسويات البرنامج (ERP)', 'Import an ERP adjustments export')}</b>
         <label>${T('الشهر المالي', 'Fiscal month')} <select id="fin-erp-m" style="width:auto">${MN().map((m, i) => `<option value="${i + 1}"${i + 1 === d.reportMonth ? ' selected' : ''}>${i + 1} – ${m}</option>`).join('')}</select></label>
         <label>${T('السبب الافتراضي', 'Default reason')} <select id="fin-erp-r" style="width:auto">${d.reasons.map(r => `<option${r.name_ar === 'غير محدد' ? ' selected' : ''}>${esc(r.name_ar)}</option>`).join('')}</select></label>
         <button class="btn btn-primary btn-sm" data-fin-erp="${b.branchId}">${T('اختيار الملف / لصق', 'Choose file / paste')}</button></div>
       ${ledger(d, 'stock', {branchId: b.branchId, periodKey: 'month', totalKey: 'value',
         extras: [{key: 'value', ar: 'القيمة (ج.م)', en: 'Value EGP', fmt: 'money'}, {key: 'warning', ar: 'تنبيه', en: 'Check', warn: true}],
         rows: b.stock.map(x => ({id: x.adjustment.id, locked: closed(d, b.branchId, x.adjustment.month),
           values: {month: x.adjustment.month, item_code: x.adjustment.itemCode, item_name: x.adjustment.itemName, qty: x.adjustment.qty, unit: x.adjustment.unit, unit_cost: x.adjustment.unitCost, manual_amount: x.adjustment.manualAmount, reason: x.adjustment.reason, source: x.adjustment.source},
           extra: {value: x.value ? x.value.toNumber() : null, warning: warnText(x.warning)}}))})}`, xbtn('analysis', {b: b.branchId}))
      + card(T('التوالف حسب السبب', 'By reason × month'), table(E().stockByReasonTable(b, d.ds.adjustmentReasons, REASONS_EN)));
  }

  function tabAssets(d, b) {
    const st = s => E().assetStatusLabel(s, S.lang);
    return card(`🏷️ ${T('سجل الأصول والإهلاك', 'Asset & depreciation register')}`,
      `<p class="fin-foot">${T('القسط الشهري = التكلفة ÷ المدة. يبدأ في الشهر المالي لتاريخ الإضافة ويستمر عدد شهور المدة بالضبط. التاريخ ثابت – لا يُستخدم «اليوم» أبدًا.', 'Monthly = cost ÷ months; starts in the fiscal period of the date added and runs exactly that many periods. Dates are fixed – "today" is never used.')}</p>
       ${ledger(d, 'assets', {branchId: b.branchId, totalKey: 'cost',
         extras: [{key: 'months', ar: 'المدة', en: 'Life', fmt: 'int'}, {key: 'monthly', ar: 'القسط الشهري', en: 'Monthly'}, {key: 'first', ar: 'أول شهر', en: 'First period', fmt: 'int'},
           {key: 'acc', ar: 'المتراكم', en: 'Accumulated'}, {key: 'book', ar: 'القيمة الدفترية', en: 'Book value'}, {key: 'status', ar: 'الحالة', en: 'Status'}],
         rows: b.assets.map(a => ({id: a.asset.id, values: {name: a.asset.name, cost: a.asset.cost, category: a.asset.category, custom_months: a.asset.customMonths, date_added: a.asset.dateAdded, notes: a.asset.notes},
           extra: {months: a.months, monthly: a.monthly?.toNumber() ?? null, first: a.firstPeriod, acc: a.accumulated?.toNumber() ?? null, book: a.bookValue?.toNumber() ?? null, status: st(a.status)}}))})}`, xbtn('assets', {b: b.branchId}))
      + card(T('جدول الإهلاك الشهري', '12-month depreciation grid'), table(E().assetsTable(b, S.lang)));
  }

  function tabPayroll(d, b) {
    const Eng = E(), from = d.fy.app_payroll_from_month;
    const m = S.payM === 'summary' ? null : Math.min(12, Math.max(1, +S.payM || d.reportMonth));
    const chips = [...MN().map((x, i) => [String(i + 1), x + (from && i + 1 >= from ? ' 🔗' : '')]), ['summary', T('ملخص المرتبات', 'Payroll summary')]]
      .map(([k, l]) => `<button class="fin-tab${(m ? String(m) : 'summary') === k ? ' on' : ''}" data-fin-paym="${k}">${l}</button>`).join('');
    if (!m) return `<div class="fin-tabs no-print" style="margin-bottom:10px">${chips}</div>` + card(T('ملخص المرتبات (الموظف × الشهر، مكونات المرتب، مطابقة مع المسجل سابقًا)', 'Payroll summary (employee × month, make-up, reconciliation)'),
      table(Eng.payrollSummaryTable(b)), xbtn('payroll-summary', {b: b.branchId}) + xbtn('payroll-all', {b: b.branchId}));
    const p = b.payroll[m - 1], lk = closed(d, b.branchId, m), cal = b.calendar[m - 1];
    const owners = card(T('مرتبات الملاك (ثابتة)', 'Owner salaries (fixed)'), ledger(d, 'owners', {branchId: b.branchId, month: m, compact: true, noImport: true,
      rows: p.owners.map(o => ({id: o.line.id, locked: lk, values: {name: o.line.name, fixed_amount: o.line.fixedAmount}}))}));
    const head = `<div class="fin-tabs no-print" style="margin-bottom:10px">${chips}</div>${lk ? `<div class="card" style="padding:10px">🔒 ${T('هذا الشهر مُغلق – للقراءة فقط', 'This month is closed – read only')}</div>` : ''}`;
    if (p.source === 'app') {
      return head + card(`🔗 ${MN()[m - 1]} ${d.year} — ${T('كشف المرتبات من التطبيق', 'Payroll from the app')} · ${cal.from} → ${cal.to}`,
        `<p class="fin-foot">${T('هذه السطور تُقرأ مباشرة من صفحة «كشف الرواتب» (الراتب + العمولة + المكافآت − الجزاءات − المسحوبات) — عدّلها من هناك. تُضاف مرتبات الملاك الثابتة أدناه.', 'These lines are read live from the app\'s «Payroll» page (salary + commission + bonuses − penalties − withdrawals) — edit them there. Owners\' fixed salaries are added below.')}
          ${p.appMonth?.commissionLabel ? ` · ${T('العمولة', 'Commission')}: ${esc(p.appMonth.commissionLabel)}` : ''}</p>
         ${p.appLines.length ? table(Eng.payrollMonthTable(b, m)) : `<div style="color:var(--text3);padding:14px">${T('لا يوجد كشف رواتب في التطبيق لهذا الشهر بعد (أو الفرع غير مربوط).', 'No app payroll for this month yet (or the branch is not linked).')}</div>`}`,
        xbtn('payroll-month', {b: b.branchId, m})) + owners;
    }
    const h = p.header || {}, act = Eng.toNum(b.series.NET_SALES[m - 1]);
    const hf = [['sales_for_commission', 'salesForCommission', 'المبيعات المستخدمة للعمولة', 'Sales for commission'], ['target', 'target', 'الهدف (Target)', 'Target'],
      ['threshold_1pct', 'threshold1pct', 'حد 1%', '1% threshold'], ['threshold_1_5pct', 'threshold15pct', 'حد 1.5%', '1.5% threshold'], ['threshold_2pct', 'threshold2pct', 'حد 2%', '2% threshold']];
    return head + card(`${MN()[m - 1]} ${d.year} — ${T('كشف المرتبات (دفتر المالية)', 'Payroll (finance ledger)')} · ${cal.from} → ${cal.to}`,
        `<p class="fin-foot">${T('المرتب = (سعر الساعة ÷ 26) × الساعات الفعلية · قيمة خصم اليوم = تقريب(سعر الساعة ÷ 26 × 8) · الصافي = المرتب + العمولة + الإضافات − الخصومات − خصم التأخير', 'Salary = rate ÷ 26 × hours · day value = round(rate ÷ 26 × 8) · net = salary + commission + additions − deductions − lateness')}</p>${table(Eng.payrollMonthTable(b, m))}`,
        xbtn('payroll-month', {b: b.branchId, m}))
      + card(T('تعديل سطور الكشف', 'Edit payroll lines'), ledger(d, 'payroll_lines', {branchId: b.branchId, month: m, compact: true,
          extras: [{key: 'salary', ar: 'المرتب', en: 'Salary'}, {key: 'comm', ar: 'العمولة', en: 'Commission'}, {key: 'latA', ar: 'خصم التأخير', en: 'Lateness'}, {key: 'net', ar: 'الصافي', en: 'Net'}],
          rows: p.lines.map(l => ({id: l.line.id, locked: lk, values: {employee: l.line.employee, role: l.line.role, base_hours: l.line.baseHours, actual_hours: l.line.actualHours, rate_per_26h: l.line.ratePer26h,
            deductions: l.line.deductions, additions: l.line.additions, additions_details: l.line.additionsDetails, deductions_details: l.line.deductionsDetails,
            lateness_days_recorded: l.line.latenessDaysRecorded, lateness_amount_recorded: l.line.latenessAmountRecorded, sort_order: l.line.sortOrder},
            extra: {salary: Eng.toNum(l.salaryByHours), comm: l.commission.toNumber(), latA: Eng.toNum(l.latenessAmount), net: l.netPay.toNumber()}}))}))
      + `<div class="grid-2">${card(T('توزيع العمولات', 'Commission distribution'),
          `<div class="fin-ob">${hf.map(([col, prop, a, e]) => `<label>${ar() ? a : e}<input class="fin-cell n" dir="ltr" data-fin-ph="${col}" value="${esc(h[prop] ?? '')}" ${lk ? 'disabled' : ''}></label>`).join('')}
            ${lk ? '' : `<button class="btn btn-success btn-sm" data-fin-phsave="${m}">💾</button>`}</div>
           ${h.salesForCommission != null && Math.abs(h.salesForCommission - act) >= 0.01 ? `<div class="fin-warn">⚠ ${T('مبيعات العمولة تختلف عن صافي المبيعات الفعلي بمقدار', 'Sales for commission differ from actual net sales by')} <b class="fin-n">${fmt(h.salesForCommission - act)}</b> ${T('(محفوظ كما أُدخل)', '(kept as typed)')}</div>` : ''}
           ${p.calculatedNotPaid.abs().gte('0.01') ? `<div class="fin-warn">⚠ ${T('عمولة محسوبة لم تدخل أي راتب', 'Commission calculated but not paid')}: <b class="fin-n">${fmt(p.calculatedNotPaid.toNumber())}</b></div>` : ''}
           ${table(Eng.commissionTable(b, m))}`)}
        <div>${card(T('نسب العمولة', 'Commission shares'), ledger(d, 'shares', {branchId: b.branchId, month: m, compact: true, noImport: true,
          extras: [{key: 'amount', ar: 'قيمة العمولة', en: 'Amount'}, {key: 'warn', ar: 'تنبيه', en: 'Check', warn: true}],
          rows: p.shares.map(x => ({id: x.share.id, locked: lk, values: {employee: x.share.employee, share_pct: x.share.sharePct},
            extra: {amount: Eng.toNum(x.amount), warn: x.unmatched ? T('⚠ الاسم لا يطابق أي موظف', '⚠ Name matches no employee') : ''}}))}))}${owners}</div></div>`;
  }

  function tabLateness(d, b) {
    const st = d.ds.settings;
    return card(`⏰ ${T('الموظفون وأيام خصم التأخير', 'Staff & lateness days')}`,
      `<p class="fin-foot">${T(`ملاحظة: الحضور والتأخير اليومي يُسجل في صفحات التطبيق (QR). هذا السجل للأشهر السابقة كما في ملفات Excel؛ يدخل الكشف تلقائيًا من شهر ${st.latenessAutoFromMonth} في دفتر المالية فقط.`,
        `Note: daily attendance and lateness are recorded in the app (QR). This log keeps the earlier months from Excel; it flows into the finance payroll from month ${st.latenessAutoFromMonth} only.`)}</p>
       ${table(E().latenessTable(b))}`, xbtn('lateness', {b: b.branchId}))
      + card(T('سجل التأخير (المالية)', 'Lateness log (finance)'), ledger(d, 'lateness', {branchId: b.branchId, periodKey: 'period',
        extras: [{key: 'ded', ar: 'الخصم', en: 'Deduction'}, {key: 'days', ar: 'أيام الخصم', en: 'Days', fmt: 'num2'}, {key: 'period', ar: 'الشهر المالي', en: 'Period', fmt: 'int'}, {key: 'warn', ar: 'تنبيه', en: 'Check', warn: true}],
        rows: b.lateness.map(x => ({id: x.entry.id, locked: closed(d, b.branchId, x.period), values: {date: x.entry.date, employee: x.entry.employee, minutes_late: x.entry.minutesLate, notes: x.entry.notes},
          extra: {ded: x.deduction === 'two_days' ? T('خصم يومين', 'Two days') : x.deduction === 'half_day' ? T('نصف يوم', 'Half day') : '', days: x.days, period: x.period, warn: warnText(x.warning)}}))}));
  }

  function tabAnalysis(d, b) {
    return card(T('المصروفات حسب التصنيف × الشهر', 'Expenses by category × month'), table(E().expenseAnalysisTable(b, d.ds.expenseCategories)), xbtn('analysis', {b: b.branchId}))
      + card(T('التوالف حسب السبب × الشهر', 'Stock adjustments by reason × month'), table(E().stockByReasonTable(b, d.ds.adjustmentReasons, REASONS_EN)));
  }
  function tabSales(d, b) {
    const link = d.links[b.branchId];
    const cmp = link ? `<div class="fin-tw"><table class="fin-rt"><thead><tr><th class="lbl">${T('الشهر', 'Month')}</th><th>${T('صافي المبيعات (ERP)', 'Net sales (ERP)')}</th><th class="calc">🔗 ${T('المبيعات في التطبيق', 'Sales in the app')}</th><th>${T('الفرق', 'Difference')}</th><th>${T('مجمل الربح (ERP)', 'GP (ERP)')}</th><th class="calc">🔗 ${T('إجمالي الربح في التطبيق', 'GP in the app')}</th><th class="calc">🔗 ${T('صافي الربح في التطبيق', 'NP in the app')}</th></tr></thead><tbody>
      ${link.map((x, i) => { const erp = b.series.HAS_SALES[i].isZero() ? null : b.series.NET_SALES[i].toNumber(); return `<tr><td class="lbl">${MN()[i]}</td><td class="n">${fmt(erp)}</td><td class="n">${fmt(x.sales)}</td>
        <td class="n${erp != null && x.sales != null && Math.abs(x.sales - erp) > 0.5 ? ' warnc' : ''}">${erp != null && x.sales != null ? fmt(x.sales - erp) : ''}</td><td class="n">${b.series.HAS_SALES[i].isZero() ? '' : fmt(b.series.GP[i].toNumber())}</td><td class="n">${fmt(x.gp)}</td><td class="n">${fmt(x.np)}</td></tr>`; }).join('')}</tbody></table></div>` : '';
    return card(T('تحليل المبيعات والمشتريات', 'Sales & purchases analysis'), table(E().salesTable(b)), xbtn('sales', {b: b.branchId}) + pbtn())
      + (cmp ? card(`🔗 ${T('مقارنة مع مبيعات التطبيق («الإدخال الشهري»)', 'Compared with the app\'s sales («Monthly input»)')}`, cmp) : '');
  }
  const tabTurnover = (d, b) => card(T('دوران المخزون', 'Inventory turnover'), table(E().turnoverTable(b)), xbtn('turnover', {b: b.branchId}) + pbtn()) + card(T('دوران المخزون ربع السنوي', 'Quarterly turnover'), table(E().turnoverQuarterTable(b)));
  const tabPl = (d, b) => card(T('قائمة الدخل الشهرية', 'Monthly P&L'), table(E().branchPLTable(b)), xbtn('pl', {b: b.branchId}) + pbtn());
  function tabHistory(d, b) {
    const yrs = [...new Set(b.dataset.history.map(h => h.year))].sort((x, y) => y - x);
    return `<p class="fin-foot">${T('أرقام كما سُجلت في ملف Yearly Sales. سنة 2025 استخدمت شهورًا ميلادية (ديسمبر 2025 = 1–25 ديسمبر).', 'As recorded in the Yearly Sales file. 2025 used calendar months (December 2025 = 1–25 Dec).')}</p>`
      + yrs.map(y => card(`${T('سنة', 'Year')} ${y}`, table(E().historyTable(b, y)), xbtn('history', {b: b.branchId}))).join('')
      + card(T('تعديل السجل التاريخي', 'Edit history'), ledger(d, 'history', {branchId: b.branchId, compact: true,
        rows: b.dataset.history.map(h => ({id: h.id, values: {year: h.year, month: h.month, days: h.days, gross_sales: h.grossSales, returns: h.returns, net_sales: h.netSales, gross_profit: h.grossProfit,
          invoices: h.invoices, items_sold: h.itemsSold, loyalty_points: h.loyaltyPoints, purchases_gross: h.purchasesGross, purchase_returns: h.purchaseReturns, salaries: h.salaries, opex: h.opex, maintenance: h.maintenance}}))}));
  }

  // ---------------------------------------------------------------- shared, audit
  function pageShared(d) {
    const r = d.result;
    return `<div class="fin-title"><h2>🏢 ${T('المصروفات المشتركة', 'Shared company expenses')}</h2><span>${T('لا تخص فرعًا بعينه – عمود مستقل، ولا تُوزع على الفروع (قرار D7)', 'Belong to no single branch – own column, never allocated (D7)')}</span></div>
      ${card('', `${closingStrip(d, null)}<div class="fin-sums">${r.sharedSeries.map((v, i) => `<span>${MN()[i]}: <b class="fin-n">${fmt(v.toNumber(), 'money0')}</b></span>`).join('')}</div>
        ${ledger(d, 'shared', {branchId: null, periodKey: 'period', totalKey: 'amount',
          extras: [{key: 'period', ar: 'الشهر المالي', en: 'Period', fmt: 'int'}, {key: 'warn', ar: 'تنبيه', en: 'Check', warn: true}],
          rows: r.shared.map(x => ({id: x.expense.id, locked: closed(d, null, x.period), values: {date: x.expense.date, description: x.expense.description, category_key: x.expense.categoryKey, amount: x.expense.amount, period_override: x.expense.periodOverride, notes: x.expense.notes},
            extra: {period: x.period, warn: warnText(x.warning)}}))})}`)}`;
  }

  function pageAudit() {
    const key = S.auditTable || '';
    const list = lazy('fin_audit', key, async () => {
      let q = sb.from('fin_audit').select('*').order('id', {ascending: false}).limit(300);
      if (key) q = q.eq('table_name', key);
      const {data, error} = await q; if (error) throw error;
      const ids = [...new Set((data || []).map(r => r.changed_by).filter(Boolean))];
      const names = {}; (typeof users !== 'undefined' ? users : []).forEach(u => { if (ids.includes(u.id)) names[u.id] = u.name || u.username; });
      cache.fin_audit = {key, rows: (data || []).map(r => ({...r, who: names[r.changed_by] || (r.changed_by === state.user.id ? state.user.name : r.changed_by?.slice(0, 8))}))};
      return cache.fin_audit.rows;
    });
    const SKIP = new Set(['created_at', 'updated_at', 'created_by', 'updated_by']);
    const diff = r => { const ks = new Set([...Object.keys(r.old_data || {}), ...Object.keys(r.new_data || {})]);
      return [...ks].filter(k => !SKIP.has(k) && JSON.stringify(r.old_data?.[k] ?? null) !== JSON.stringify(r.new_data?.[k] ?? null)).slice(0, 8)
        .map(k => `<div><b>${esc(k)}</b>: <s style="color:var(--danger)">${esc(r.old_data?.[k] ?? '∅')}</s> → <span style="color:var(--success)">${esc(r.new_data?.[k] ?? '∅')}</span></div>`).join(''); };
    const tables = ['', 'fin_expenses', 'fin_monthly_inputs', 'fin_stock_adjustments', 'fin_assets', 'fin_payroll_lines', 'fin_payroll_owner_lines', 'fin_commission_shares', 'fin_shared_expenses', 'fin_month_closings', 'fin_years', 'fin_branches'];
    return `<div class="fin-title"><h2>📜 ${T('سجل تعديلات المالية', 'Finance audit log')}</h2><span>${T('كل إضافة أو تعديل أو حذف: من، ومتى، والقيم القديمة والجديدة', 'Every create/update/delete: who, when, old and new values')}</span></div>
      <div class="fin-tabs" style="margin-bottom:10px">${tables.map(t => `<button class="fin-tab${t === key ? ' on' : ''}" data-fin-audit="${t}">${t || T('الكل', 'All')}</button>`).join('')}</div>
      ${!list ? loadingHTML : card('', `<div class="fin-tw"><table class="fin-rt"><thead><tr><th>${T('الوقت', 'When')}</th><th>${T('المستخدم', 'User')}</th><th>${T('الجدول', 'Table')}</th><th>#</th><th>${T('الفرع', 'Branch')}</th><th>${T('العملية', 'Action')}</th><th>${T('التغييرات', 'Changes')}</th></tr></thead><tbody>
        ${list.map(r => `<tr><td class="n">${esc(new Date(r.changed_at).toLocaleString('en-GB'))}</td><td>${esc(r.who || '—')}</td><td>${esc(r.table_name)}</td><td class="n">${esc(r.row_id ?? '')}</td><td class="n">${r.branch_id ?? ''}</td>
          <td><span class="badge ${r.action === 'DELETE' ? 'badge-red' : r.action === 'INSERT' ? 'badge-green' : 'badge-blue'}">${r.action}</span></td><td style="font-size:11px;white-space:normal">${diff(r)}</td></tr>`).join('')
          || `<tr><td colspan="7" style="text-align:center;color:var(--text3)">${T('لا توجد تعديلات', 'No changes')}</td></tr>`}</tbody></table></div>`)}`;
  }

  // ---------------------------------------------------------------- settings (fiscal rules, branch ↔ app link, lists, data import)
  function pageSettings(d) {
    const appBranches = typeof branches !== 'undefined' ? branches.filter(b => b.id) : [];
    if (d.empty) return card(`📥 ${T('استيراد حزمة البيانات', 'Import the data package')}`, pkgIntro(), '');
    const fy = d.fy, sel = (name, val, opts) => `<select data-fin-fy="${name}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const num = (name, val, a, e) => `<div class="form-group"><label>${ar() ? a : e}</label><input data-fin-fy="${name}" value="${esc(val ?? '')}" dir="ltr"></div>`;
    const monthOpts = MN().map((m, i) => [i + 1, `${i + 1} – ${m}`]);
    return `<div class="fin-title"><h2>🛠️ ${T('إعدادات المالية', 'Finance settings')}</h2><span>${T('السنة المالية', 'Fiscal year')} ${d.year}</span></div>
      ${card(T('السنة المالية والقواعد', 'Fiscal year & rules'), `<div class="grid-3">
        <div class="form-group"><label>${T('شهر التقرير الافتراضي', 'Default report month')}</label>${sel('report_month', fy.report_month, monthOpts)}</div>
        ${num('start_day', fy.start_day, 'يوم بداية الشهر المالي (26 → 25)', 'Fiscal month start day')}
        <div class="form-group"><label>🔗 ${T('المرتبات من «كشف الرواتب» في التطبيق بدءًا من شهر', 'Salaries from the app\'s payroll from month')}</label>${sel('app_payroll_from_month', fy.app_payroll_from_month, [['', T('لا – دفتر المالية دائمًا', 'Never – finance payroll')], ...monthOpts])}</div>
        <div class="form-group"><label>${T('خصم التأخير من السجل بدءًا من شهر (دفتر المالية)', 'Lateness from the log from month (finance payroll)')}</label>${sel('lateness_auto_from_month', fy.lateness_auto_from_month, [...monthOpts, [13, T('أبدًا', 'Never')]])}</div>
        ${num('lateness_half_day_from_minutes', fy.lateness_half_day_from_minutes, 'نصف يوم من (دقيقة)', 'Half day from (min)')}
        ${num('lateness_two_days_above_minutes', fy.lateness_two_days_above_minutes, 'يومان إذا أكثر من (دقيقة)', 'Two days if more than (min)')}
        ${num('lateness_day_hours', fy.lateness_day_hours, 'ساعات قيمة اليوم (D6)', 'Day-value hours (D6)')}
        <div class="form-group"><label>${T('شريحة 1% في العمولة (دفتر المالية)', 'Commission 1% tier (finance payroll)')}</label>${sel('commission_tier_mode', fy.commission_tier_mode, [['original', T('كما في المعادلة الأصلية', 'Original formula')], ['tier1_from_96pct_target', T('1% من 96% من الهدف', '1% from 96% of target')]])}</div>
        <div class="form-group"><label>${T('النتيجة النهائية في اللوحة (D1)', 'Dashboard bottom line (D1)')}</label>${sel('bottom_line', fy.bottom_line, [['net_after_stock_losses', T('صافي النتيجة بعد خسائر المخزون', 'Net result after stock losses')], ['operating_result', T('النتيجة التشغيلية', 'Operating result')]])}</div>
       </div><button class="btn btn-primary" data-fin-fysave>💾 ${T('حفظ', 'Save')}</button>
       <button class="btn btn-ghost" data-fin-newyear>➕ ${T('بدء السنة المالية', 'Start fiscal year')} ${d.year + 1}</button>`)}
      ${card(T('الفروع والربط مع فروع التطبيق', 'Branches & link to the app\'s branches'), `<div class="fin-tw"><table class="fin-rt"><thead><tr><th>#</th><th>${T('الاسم بالعربي', 'Arabic name')}</th><th>${T('الاسم بالإنجليزي', 'English name')}</th><th>${T('اللون', 'Colour')}</th><th>🔗 ${T('فرع التطبيق', 'App branch')}</th><th>${T('الإهلاك من السجل بدءًا من شهر', 'Register dep. from month')}</th><th>${T('شهر الافتتاح', 'Opened in')}</th><th></th></tr></thead><tbody>
        ${d.branchesRows.map(b => { const bs = d.ds.branches.find(x => x.branch.id === b.id)?.branch; return `<tr data-fin-brow="${b.id}"><td>${b.id}</td><td><input data-k="name_ar" value="${esc(b.name_ar)}"></td><td><input data-k="name_en" dir="ltr" value="${esc(b.name_en)}"></td>
          <td><input type="color" data-k="color" value="${esc(b.color)}" style="width:50px;padding:0"></td>
          <td><select data-k="app_branch"><option value="">—</option>${appBranches.map(a => `<option value="${esc(a.id)}"${a.id === b.app_branch ? ' selected' : ''}>${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('')}${b.app_branch && !appBranches.some(a => a.id === b.app_branch) ? `<option selected>${esc(b.app_branch)}</option>` : ''}</select></td>
          <td><select data-k="dep">${[...Array(13)].map((_, i) => `<option${(bs?.depreciationRegisterFromMonth ?? 1) === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></td>
          <td><select data-k="opened"><option value="">—</option>${[...Array(12)].map((_, i) => `<option${bs?.openedMonth === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></td>
          <td><button class="btn btn-success btn-sm" data-fin-bsave="${b.id}">💾</button></td></tr>`; }).join('')}</tbody></table></div>
        <p class="fin-foot">${T('ربط الفرع بفرع التطبيق يُظهر مبيعات «الإدخال الشهري» بجانب أرقام البرنامج، ويأخذ المرتبات من «كشف الرواتب» من الشهر المحدد أعلاه.', 'Linking shows «Monthly input» sales next to the ERP figures and takes salaries from «Payroll» from the month chosen above.')}</p>`)}
      ${card(T('تصنيفات المصروفات ونوعها في قائمة الدخل', 'Expense categories & P&L class'), listEditor('cat', d.cats.map(c => ({id: c.key, cells: [c.key, c.name_ar, c.name_en, c.pl_class]})), [['key', 'الكود', 'Key'], ['name_ar', 'بالعربي', 'Arabic'], ['name_en', 'بالإنجليزي', 'English'], ['pl_class', 'النوع OPEX/STAFF/DEP', 'Class OPEX/STAFF/DEP']]))}
      <div class="grid-2">${card(T('فئات الأصول ومدة الإهلاك (شهور)', 'Asset categories & useful life'), listEditor('acat', d.acats.map(c => ({id: c.id, cells: [c.name, c.useful_life_months ?? '']})), [['name', 'الفئة', 'Category'], ['useful_life_months', 'شهور', 'Months']]))}
        ${card(T('أسباب تسويات المخزون', 'Stock-adjustment reasons'), listEditor('reason', d.reasons.map(r => ({id: r.id, cells: [r.name_ar, r.name_en ?? '']})), [['name_ar', 'بالعربي', 'Arabic'], ['name_en', 'بالإنجليزي', 'English']]))}</div>
      ${card(`📥 ${T('حزمة البيانات', 'Data package')}`, pkgIntro(true))}`;
  }
  function listEditor(kind, items, cols) {
    return `<div class="fin-tw"><table class="fin-rt"><thead><tr>${cols.map(c => `<th>${ar() ? c[1] : c[2]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${[...items, {id: '', cells: cols.map(() => '')}].map(it => `<tr data-fin-list="${kind}|${esc(it.id)}">${it.cells.map((v, i) => `<td><input data-k="${cols[i][0]}" value="${esc(v)}"${kind === 'cat' && i === 0 && it.id ? ' disabled' : ''}${/name_en|key|useful|pl_class/.test(cols[i][0]) ? ' dir="ltr"' : ''}></td>`).join('')}
        <td><button class="btn btn-success btn-sm" data-fin-listsave="${kind}|${esc(it.id)}">${it.id ? '💾' : '➕'}</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  const pkgIntro = existing => `<p style="font-size:13px;color:var(--text2)">${T('اختر ملفات حزمة البيانات معًا: settings.json وملفات CSV (monthly_inputs, operating_expenses, stock_adjustments, assets, staff, lateness_log, payroll_lines, payroll_owners, commission_months, commission_shares, history_monthly, opening_balances). الملفات تُقرأ في المتصفح وتُحفظ في قاعدة البيانات المحمية — لا تُرفع إلى GitHub أبدًا.',
      'Select the data-package files together: settings.json and the CSV files. They are read in the browser and saved to the protected database — never to GitHub.')}</p>
    <button class="btn btn-primary" data-fin-pkg>📥 ${T('استيراد حزمة البيانات', 'Import the data package')}</button>
    ${existing ? `<button class="btn btn-danger" data-fin-reset style="margin-inline-start:8px">🗑 ${T('مسح كل بيانات المالية', 'Delete all finance data')}</button>` : ''}`;

  // ---------------------------------------------------------------- modals
  function modal(m) {
    if (!canUse()) return '';
    const html = m.type === 'fin-row' ? rowModal(m) : m.type === 'fin-import' ? importModal(m) : m.type === 'fin-pkg' ? pkgModal(m) : '';
    return html && withStyle(`<div class="fin" dir="${ar() ? 'rtl' : 'ltr'}">${html}</div>`);
  }
  function lookups(d, branchId) {
    return {categories: d.ds.expenseCategories, reasons: d.ds.adjustmentReasons, assetCategories: d.ds.assetCategories.map(a => a.name),
      staffLatenessNames: (d.ds.branches.find(b => b.branch.id === branchId)?.staff || []).map(s => s.latenessName)};
  }
  function rowModal(m) {
    const d = S.data, def = E().LEDGERS[m.key], v = m.values || {};
    const input = f => {
      const o = options(d, f.type, m.branchId), val = v[f.name] ?? '';
      if (o) return `<select data-fin-f="${f.name}"><option value="">—</option>${o.map(x => `<option value="${esc(x.value)}"${x.value === val ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
      if (f.type === 'month') return `<select data-fin-f="${f.name}"><option value="">—</option>${MN().map((x, i) => `<option value="${i + 1}"${+val === i + 1 ? ' selected' : ''}>${i + 1} – ${x}</option>`).join('')}</select>`;
      return `<input data-fin-f="${f.name}" type="${f.type === 'date' ? 'date' : 'text'}" value="${esc(val)}"${f.type === 'text' ? '' : ' dir="ltr"'}${f.type === 'pct' ? ' placeholder="0.15"' : ''}>`;
    };
    return `<div class="modal-header"><h3>${m.id ? '✏️' : '➕'} ${esc(ar() ? def.ar : def.en)}${m.month ? ` — ${MN()[m.month - 1]}` : ''}</h3><button class="modal-close" data-fin-close-modal>✕</button></div>
      <div class="grid-2">${def.fields.filter(f => !f.hidden).map(f => `<div class="form-group"><label>${esc(ar() ? f.ar : f.en)}${f.required ? ' *' : ''}</label>${input(f)}</div>`).join('')}</div>
      ${m.error ? `<div class="fin-warn" style="color:var(--danger)">${esc(m.error)}</div>` : ''}
      <div class="modal-footer"><button class="btn btn-ghost" data-fin-close-modal>${T('إلغاء', 'Cancel')}</button><button class="btn btn-primary" data-fin-rowsave>💾 ${T('حفظ', 'Save')}</button></div>`;
  }
  function importModal(m) {
    const def = E().LEDGERS[m.key], fields = def.fields.filter(f => !f.hidden), p = S.preview;
    const valid = p ? p.rows.filter(r => r.data).length : 0;
    return `<div class="modal-header"><h3>📥 ${T('استيراد', 'Import')} — ${esc(ar() ? def.ar : def.en)}${m.defaults?.month ? ` — ${T('شهر', 'period')} ${m.defaults.month}` : ''}</h3><button class="modal-close" data-fin-close-modal>✕</button></div>
      <p style="font-size:12px;color:var(--text2)">${m.defaults ? T('تقرير التسويات في البرنامج تراكمي: ارفع الملف أو الصقه ثم اترك علامة ✓ على سطور هذا الشهر فقط. الأعمدة الناقصة (الشهر/السبب) تؤخذ من اختيارك.', 'The ERP report is cumulative: upload or paste it, then keep ✓ only on this month\'s lines. Missing columns (period/reason) come from your choice.')
        : T('ملف Excel (.xlsx) أو CSV، أو الصق جدولًا من Excel. الصف الأول = أسماء الأعمدة (عربي أو إنجليزي كما في ملف التصدير). يتم التحقق من كل سطر قبل الحفظ.', 'Excel (.xlsx) or CSV, or paste a table from Excel. First row = headers (Arabic or English, as in the export). Every row is validated before saving.')}
        <br><span style="color:var(--text3)">${T('الأعمدة', 'Columns')}: ${fields.map(f => esc(ar() ? f.ar : f.en)).join(' · ')}</span></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start"><input type="file" id="fin-imp-file" accept=".xlsx,.csv" style="width:auto">
        <textarea id="fin-imp-paste" rows="2" placeholder="${T('…أو الصق الجدول هنا مع صف العناوين', '…or paste the table here with its header row')}" style="flex:1;min-width:220px"></textarea>
        <button class="btn btn-ghost" data-fin-preview>${T('معاينة', 'Preview')}</button></div>
      ${p ? `<p style="margin:10px 0 6px"><b style="color:var(--success)">${valid} ${T('سطور سليمة', 'valid')}</b> · <b style="color:var(--danger)">${p.rows.length - valid} ${T('بها أخطاء', 'with errors')}</b></p>
        <div class="fin-tw" style="max-height:45vh"><table class="fin-rt"><thead><tr><th>✓</th><th>#</th>${fields.map(f => `<th>${esc(ar() ? f.ar : f.en)}</th>`).join('')}<th>${T('الأخطاء', 'Errors')}</th></tr></thead><tbody>
        ${p.rows.map(r => `<tr${r.data ? '' : ' class="warnrow"'}><td><input type="checkbox" data-fin-sel="${r.index}"${r.data ? '' : ' disabled'}${p.selected.has(r.index) ? ' checked' : ''} style="width:auto"></td><td>${r.index + 2}</td>
          ${fields.map(f => `<td>${esc(r.data ? r.data[f.name] ?? '' : '')}</td>`).join('')}<td style="color:var(--danger);font-size:11px;white-space:normal">${esc(r.errors.join(' · '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="modal-footer"><button class="btn btn-ghost" data-fin-close-modal>${T('إغلاق', 'Close')}</button>${p ? `<button class="btn btn-primary" data-fin-commit>${T('استيراد السطور المحددة', 'Import selected rows')} (${p.selected.size})</button>` : ''}</div>`;
  }
  function pkgModal(m) {
    const p = S.pkg;
    return `<div class="modal-header"><h3>📥 ${T('استيراد حزمة البيانات', 'Import the data package')}</h3><button class="modal-close" data-fin-close-modal>✕</button></div>
      <input type="file" id="fin-pkg-files" multiple accept=".csv,.json" style="width:auto"> <button class="btn btn-ghost" data-fin-pkgread>${T('قراءة الملفات', 'Read files')}</button>
      ${p?.error ? `<div class="fin-warn" style="color:var(--danger)">${esc(p.error)}</div>` : ''}
      ${p?.summary ? `<div class="fin-sums" style="margin-top:10px">${p.summary.map(([l, n]) => `<span>${esc(l)}: <b>${n}</b></span>`).join('')}</div>
        <div class="fin-warn">${T('ملخص الأرقام قبل الحفظ', 'Figures before saving')}: ${esc(p.check)}</div>
        ${S.data && !S.data.empty ? `<label class="fin-chk" style="margin-top:8px"><input type="checkbox" id="fin-pkg-replace"> ${T('توجد بيانات مالية بالفعل — امسحها واستبدلها بهذه الحزمة', 'Finance data exists — delete it and replace it with this package')}</label>` : ''}` : ''}
      ${p?.progress ? `<div style="margin-top:8px;color:var(--text2)">⏳ ${esc(p.progress)}</div>` : ''}
      <div class="modal-footer"><button class="btn btn-ghost" data-fin-close-modal>${T('إغلاق', 'Close')}</button>${p?.ds ? `<button class="btn btn-primary" data-fin-pkgsave${S.busy ? ' disabled' : ''}>💾 ${T('حفظ في قاعدة البيانات', 'Save to the database')}</button>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- writes
  const nz = v => (v === '' || v === undefined ? null : v);
  const toNum = v => { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Number(String(v).replace(/,/g, '').trim()); if (!Number.isFinite(n)) throw new Error(T(`رقم غير صحيح: ${v}`, `Invalid number: ${v}`)); return n; };
  function scopeValues(def, ctx) {
    const v = {};
    if (def.scope === 'branch') v.branch_id = ctx.branchId;
    if (def.yearColumn) v[def.yearColumn] = S.data.year;
    if (def.monthColumn && ctx.month) v[def.monthColumn] = ctx.month;
    return v;
  }
  async function saveRow(m, values) {
    const d = S.data, def = E().LEDGERS[m.key];
    const [r] = E().validateRows(def, lookups(d, m.branchId), [values]);
    if (!r.data) throw new Error(r.errors.join(' · '));
    if (m.id) check(await sb.from(def.table).update(r.data).eq('id', m.id));
    else check(await sb.from(def.table).insert({...r.data, ...scopeValues(def, m)}));
  }
  async function insertChunks(table, list, onProgress) {
    for (let i = 0; i < list.length; i += 400) {
      check(await sb.from(table).insert(list.slice(i, i + 400)));
      if (onProgress) onProgress(Math.min(list.length, i + 400), list.length);
    }
  }
  async function readUpload(file, pasted) {
    if (pasted && pasted.trim()) {
      const text = pasted.includes('\t') ? pasted.split(/\r?\n/).map(l => l.split('\t').map(c => /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n') : pasted;
      return E().parseCsv(text);
    }
    if (!file) throw new Error(T('اختر ملفًا أو الصق جدولًا', 'Choose a file or paste a table'));
    if (/\.csv$/i.test(file.name)) return E().parseCsv(await file.text());
    await ensureExcel();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0]; if (!ws) return [];
    let header = null; const out = [];
    ws.eachRow({includeEmpty: false}, row => {
      const vals = row.values.slice(1).map(v => v && typeof v === 'object' ? ('result' in v ? v.result : 'richText' in v ? v.richText.map(x => x.text).join('') : 'text' in v ? v.text : v instanceof Date ? v.toISOString().slice(0, 10) : v) : v);
      if (!header) { header = vals.map(v => String(v ?? '').trim()); return; }
      const o = {}; header.forEach((h, i) => { if (h) o[h] = vals[i] ?? null; });
      if (Object.values(o).some(v => v !== null && v !== '')) out.push(o);
    });
    return out;
  }
  function withDefaults(rowsIn, defaults) {
    if (!defaults) return rowsIn;
    return rowsIn.map(r => { const o = {...r}; for (const [k, v] of Object.entries(defaults)) if (o[k] === undefined || o[k] === null || o[k] === '') o[k] = v; return o; });
  }

  /** Data package → fin_* tables (in the browser; the files never leave the owner's computer except to Supabase). */
  async function readPackage(fileList) {
    const want = ['settings.json', 'opening_balances.csv', 'monthly_inputs.csv', 'operating_expenses.csv', 'stock_adjustments.csv', 'assets.csv', 'staff.csv', 'lateness_log.csv',
      'payroll_lines.csv', 'payroll_owners.csv', 'commission_months.csv', 'commission_shares.csv', 'history_monthly.csv', 'shared_expenses.csv'];
    const files = {};
    for (const f of fileList) { const k = want.find(w => f.name === w || f.name.endsWith('-' + w) || f.name.endsWith('_' + w)); if (k) files[k] = await f.text(); }
    const missing = want.filter(w => !files[w] && w !== 'shared_expenses.csv');
    if (missing.length) throw new Error(T('ملفات ناقصة: ', 'Missing files: ') + missing.join(', '));
    const ds = E().loadDatasetFromFiles(files), cfg = JSON.parse(files['settings.json']);
    const c = E().computeCompany(ds);
    const s = ds.branches.reduce((a, b) => ({e: a.e + b.expenses.length, st: a.st + b.stockAdjustments.length, p: a.p + b.payrollLines.length, as: a.as + b.assets.length, l: a.l + b.lateness.length}), {e: 0, st: 0, p: 0, as: 0, l: 0});
    return {ds, cfg, summary: [[T('الفروع', 'Branches'), ds.branches.length], [T('المصروفات', 'Expenses'), s.e], [T('التوالف', 'Stock lines'), s.st], [T('سطور المرتبات', 'Payroll lines'), s.p], [T('الأصول', 'Assets'), s.as], [T('سجل التأخير', 'Lateness'), s.l]],
      check: `${T('صافي المبيعات YTD', 'Net sales YTD')} ${fmt(E().ytd(c.consolidated.NET_SALES, 10).toNumber())} · ${T('صافي النتيجة YTD', 'Net result YTD')} ${fmt(E().ytd(c.consolidated.NET_RESULT, 10).toNumber())}`};
  }
  async function savePackage({ds, cfg}, replace) {
    const Y = ds.settings.year, prog = t => { S.pkg.progress = t; render(); };
    if (replace) { prog(T('مسح البيانات القديمة…', 'Deleting old data…')); check(await sb.rpc('fin_reset_data')); }
    const appB = typeof branches !== 'undefined' ? branches.map(b => b.id) : [];
    prog(T('الإعدادات…', 'Settings…'));
    check(await sb.from('fin_settings').insert({id: 1, name_ar: cfg.company.name_ar, name_en: cfg.company.name_en, currency: cfg.company.currency, current_year: Y}));
    check(await sb.from('fin_years').insert({year: Y, start_day: cfg.fiscal_month.start_day, report_month: 10, lateness_auto_from_month: cfg.lateness_rules.auto_into_payroll_from_month ?? 11,
      lateness_half_day_from_minutes: cfg.lateness_rules.half_day_from_minutes, lateness_two_days_above_minutes: cfg.lateness_rules.two_days_if_more_than_minutes,
      lateness_day_hours: 8, commission_tier_mode: 'original', bottom_line: 'net_after_stock_losses', app_payroll_from_month: 11}));
    check(await sb.from('fin_expense_categories').insert(cfg.expense_categories.map((c, i) => ({key: c.key, name_ar: c.name_ar, name_en: c.name_en, pl_class: c.pl_class, sort_order: i}))));
    check(await sb.from('fin_asset_categories').insert(cfg.asset_categories.map((c, i) => ({name: c.name, useful_life_months: c.useful_life_months, sort_order: i}))));
    check(await sb.from('fin_adjustment_reasons').insert(cfg.stock_adjustment_reasons.map((r, i) => ({name_ar: r, name_en: REASONS_EN[r] || null, sort_order: i}))));
    check(await sb.from('fin_branches').insert(cfg.branches.map((b, i) => ({id: b.id, name_ar: b.name_ar, name_en: b.name_en, color: b.color, sort_order: i, app_branch: appB.includes('b' + b.id) ? 'b' + b.id : null}))));
    check(await sb.from('fin_branch_settings').insert(ds.branches.map(b => ({branch_id: b.branch.id, year: Y, depreciation_register_from_month: b.branch.depreciationRegisterFromMonth, opened_month: b.branch.openedMonth ?? null}))));
    for (const b of ds.branches) {
      const id = b.branch.id, step = (t, f) => async () => { prog(`${b.branch.nameAr}: ${t}`); await f(); };
      const jobs = [
        step(T('أرصدة أول السنة', 'opening'), async () => { if (b.opening) check(await sb.from('fin_opening_balances').insert({branch_id: id, year: Y, inventory_value: b.opening.inventoryValue, sku_count: b.opening.skuCount, inventory_qty: b.opening.inventoryQty})); }),
        step(T('المدخلات الشهرية', 'inputs'), () => insertChunks('fin_monthly_inputs', b.monthly.map(m => ({branch_id: id, year: Y, month: m.month, gross_sales: m.grossSales, returns: m.returns, gross_profit: m.grossProfit, invoices: m.invoices,
          items_sold: m.itemsSold, loyalty_points: m.loyaltyPoints, salaries_recorded_legacy: m.salariesRecordedLegacy, purchases_gross: m.purchasesGross, purchase_returns: m.purchaseReturns,
          inventory_end_value: m.inventoryEndValue, sku_end: m.skuEnd, inventory_end_qty: m.inventoryEndQty, notes: m.notes || null})))),
        step(T('المصروفات', 'expenses'), () => insertChunks('fin_expenses', b.expenses.map(e => ({branch_id: id, fiscal_year: Y, date: e.date, description: e.description, category_key: e.categoryKey, amount: e.amount, period_override: e.periodOverride, source: e.source || null})))),
        step(T('التوالف', 'stock'), () => insertChunks('fin_stock_adjustments', b.stockAdjustments.map(x => ({branch_id: id, year: Y, month: x.month, item_code: x.itemCode || null, item_name: x.itemName || null, qty: x.qty, unit: x.unit || null, unit_cost: x.unitCost, manual_amount: x.manualAmount, reason: x.reason, source: x.source || null})))),
        step(T('الأصول', 'assets'), () => insertChunks('fin_assets', b.assets.map(a => ({branch_id: id, name: a.name, cost: a.cost, category: a.category, custom_months: a.customMonths, date_added: a.dateAdded, notes: a.notes || null})))),
        step(T('الموظفون', 'staff'), async () => {
          if (!b.staff.length) return;
          const appEmps = (() => { try { const bd = branchData['b' + id]; return (bd?.employees || []); } catch { return []; } })();
          const {data, error} = await sb.from('fin_staff').insert(b.staff.map(s => ({lateness_name: s.latenessName, payroll_name: s.payrollName, role: s.role,
            app_emp_id: (appEmps.find(e => e.name === s.latenessName || e.name === s.payrollName) || {}).id || null}))).select('id');
          if (error) throw error;
          check(await sb.from('fin_staff_assignments').insert(data.map(r => ({staff_id: r.id, branch_id: id, year: Y, from_month: 1}))));
        }),
        step(T('سجل التأخير', 'lateness'), () => insertChunks('fin_lateness', b.lateness.map(l => ({branch_id: id, date: l.date, employee: l.employee, minutes_late: l.minutesLate, notes: l.notes || null})))),
        step(T('العمولة', 'commission'), () => insertChunks('fin_payroll_months', b.payrollMonths.map(p => ({branch_id: id, year: Y, month: p.month, sales_for_commission: p.salesForCommission, target: p.target, threshold_1pct: p.threshold1pct, threshold_1_5pct: p.threshold15pct, threshold_2pct: p.threshold2pct})))),
        step(T('كشوف المرتبات', 'payroll'), () => insertChunks('fin_payroll_lines', b.payrollLines.map(l => ({branch_id: id, year: Y, month: l.month, sort_order: l.sortOrder || 0, employee: l.employee, role: l.role, base_hours: l.baseHours, actual_hours: l.actualHours,
          rate_per_26h: l.ratePer26h, deductions: l.deductions, additions: l.additions, additions_details: l.additionsDetails || null, deductions_details: l.deductionsDetails || null, lateness_days_recorded: l.latenessDaysRecorded, lateness_amount_recorded: l.latenessAmountRecorded})))),
        step(T('مرتبات الملاك', 'owners'), () => insertChunks('fin_payroll_owner_lines', b.owners.map(o => ({branch_id: id, year: Y, month: o.month, name: o.name, fixed_amount: o.fixedAmount})))),
        step(T('نسب العمولة', 'shares'), () => insertChunks('fin_commission_shares', b.commissionShares.map((s, i) => ({branch_id: id, year: Y, month: s.month, sort_order: i, employee: s.employee, share_pct: s.sharePct})))),
        step(T('السجل التاريخي', 'history'), () => insertChunks('fin_history_monthly', b.history.map(h => ({branch_id: id, year: h.year, month: h.month, days: h.days, gross_sales: h.grossSales, returns: h.returns, net_sales: h.netSales, gross_profit: h.grossProfit,
          invoices: h.invoices, items_sold: h.itemsSold, loyalty_points: h.loyaltyPoints ?? null, purchases_gross: h.purchasesGross ?? null, purchase_returns: h.purchaseReturns ?? null, salaries: h.salaries ?? null, opex: h.opex ?? null, maintenance: h.maintenance ?? null})))),
      ];
      for (const j of jobs) await j();
    }
    if (ds.sharedExpenses.length) await insertChunks('fin_shared_expenses', ds.sharedExpenses.map(e => ({fiscal_year: Y, date: e.date, description: e.description, category_key: e.categoryKey, amount: e.amount, period_override: e.periodOverride, notes: e.notes || null})));
  }

  // ---------------------------------------------------------------- Excel export (in the browser, ExcelJS from the CDN)
  function ensureExcel() { return typeof ExcelJS !== 'undefined' ? Promise.resolve() : (S.excelP = S.excelP || loadScript(EXCELJS_URL)); }
  let logoPng = null;
  async function logo() {
    if (logoPng !== null) return logoPng;
    try {
      const img = new Image(); img.src = LOGO_B64; await img.decode();
      const w = 420, h = Math.round(img.naturalHeight * w / img.naturalWidth), c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
      logoPng = {data: c.toDataURL('image/png'), w, h};
    } catch { logoPng = false; }
    return logoPng;
  }
  function inputsTable(b) {
    const cols = INPUT_COLS.map(([k, , a, e, t]) => ({key: k, ar: a, en: e, fmt: t === 2 ? 'text' : t ? 'int' : 'money'}));
    return {id: 'inputs', titleAr: 'المدخلات الشهرية من البرنامج', titleEn: 'Monthly ERP inputs', labelAr: 'الشهر', labelEn: 'Month', columns: cols,
      rows: b.monthly.map((m, i) => ({ar: MONTHS_AR[i], en: MONTHS_EN[i], fmt: 'money', fmts: cols.map(c => c.fmt), values: INPUT_COLS.map(([, p]) => m?.[p] ?? null)}))};
  }
  function checksTable(cs) {
    const icon = {ok: '✔', warn: '⚠', fail: '✖'};
    return {id: 'checks', titleAr: 'اختبارات المطابقة', titleEn: 'Reconciliation checks', labelAr: 'الاختبار', labelEn: 'Test',
      columns: [{key: 's', ar: 'النطاق', en: 'Scope', fmt: 'text'}, {key: 'a', ar: 'القيمة أ', en: 'A', fmt: 'money'}, {key: 'b', ar: 'القيمة ب', en: 'B', fmt: 'money'}, {key: 'd', ar: 'الفرق', en: 'Diff', fmt: 'money'}, {key: 'r', ar: 'النتيجة', en: 'Result', fmt: 'text'}],
      rows: cs.map(c => ({ar: `${c.id} · ${c.labelAr}`, en: `${c.id} · ${c.labelEn}`, fmt: 'money', fmts: ['text', 'money', 'money', 'money', 'text'], values: [c.scope, c.a, c.b, c.diff, `${icon[c.status]} ${c.detailEn || ''}`.trim()]}))};
  }
  function reportTables(id, args) {
    const d = S.data, r = d.result, Eng = E(), b = args.b ? r.branches.find(x => x.branchId === args.b) : null, cats = d.ds.expenseCategories, rs = d.ds.adjustmentReasons;
    switch (id) {
      case 'dashboard': return [Eng.consolidatedSideBySide(r, 'month'), Eng.consolidatedSideBySide(r, 'ytd'), Eng.comparisonTable(r)];
      case 'consolidated': return [Eng.consolidatedSideBySide(r, 'month'), Eng.consolidatedSideBySide(r, 'ytd'), Eng.consolidatedMonthlyTable(r), Eng.consolidatedTurnoverTable(r, S.lang), Eng.consolidatedTurnoverQuarterTable(r, S.lang)];
      case 'turnover-consolidated': return [Eng.consolidatedTurnoverTable(r, S.lang), Eng.consolidatedTurnoverQuarterTable(r, S.lang)];
      case 'comparison': return [Eng.comparisonTable(r)];
      case 'checks': return [checksTable(d.checks.checks)];
      case 'pl': return [Eng.branchPLTable(b)];
      case 'inputs': return [inputsTable(b)];
      case 'sales': return [Eng.salesTable(b)];
      case 'turnover': return [Eng.turnoverTable(b), Eng.turnoverQuarterTable(b)];
      case 'analysis': return [Eng.expenseAnalysisTable(b, cats), Eng.stockByReasonTable(b, rs, REASONS_EN)];
      case 'assets': return [Eng.assetsTable(b, S.lang)];
      case 'lateness': return [Eng.latenessTable(b)];
      case 'history': return [...new Set(b.dataset.history.map(h => h.year))].sort((x, y) => y - x).map(y => Eng.historyTable(b, y));
      case 'payroll-summary': return [Eng.payrollSummaryTable(b)];
      case 'payroll-month': return b.payroll[args.m - 1].source === 'app' ? [Eng.payrollMonthTable(b, args.m)] : [Eng.payrollMonthTable(b, args.m), Eng.commissionTable(b, args.m)];
      case 'payroll-all': return [Eng.payrollSummaryTable(b), ...[...Array(12)].map((_, i) => Eng.payrollMonthTable(b, i + 1))];
      case 'branch-all': return [inputsTable(b), Eng.branchPLTable(b), Eng.salesTable(b), Eng.turnoverTable(b), Eng.turnoverQuarterTable(b), Eng.expenseAnalysisTable(b, cats),
        Eng.stockByReasonTable(b, rs, REASONS_EN), Eng.payrollSummaryTable(b), Eng.assetsTable(b, S.lang), Eng.latenessTable(b), checksTable(d.checks.checks.filter(c => c.scope === `branch:${b.branchId}`))];
    }
    return [];
  }
  function download(buf, name, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], {type})); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function exportReport(id, args) {
    await ensureExcel();
    const d = S.data, a = ar(), lg = await logo(), wb = new ExcelJS.Workbook(), used = new Set(), FMT = E().EXCEL_FMT;
    const logoId = lg ? wb.addImage({base64: lg.data, extension: 'png'}) : null;
    const sub = `${a ? d.ds.companyNameAr : d.ds.companyNameEn}${args.b ? ' – ' + bname(d, args.b) : ''} · ${d.year} · ${T('شهر التقرير', 'Report month')}: ${MN()[d.reportMonth - 1]}`;
    for (const t of reportTables(id, args)) {
      let nm = String(a ? t.titleAr : t.titleEn).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet', base = nm, i = 2;
      while (used.has(nm)) nm = `${base.slice(0, 25)} ${i++}`; used.add(nm);
      const ws = wb.addWorksheet(nm, {views: [{rightToLeft: a, state: 'frozen', xSplit: 1, ySplit: 6}], pageSetup: {orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0}});
      if (logoId !== null) ws.addImage(logoId, {tl: {col: 0, row: 0}, ext: {width: 150, height: Math.round(150 * lg.h / lg.w)}});
      ws.getCell(1, 3).value = a ? t.titleAr : t.titleEn; ws.getCell(1, 3).font = {bold: true, size: 14, color: {argb: 'FF003392'}};
      ws.getCell(2, 3).value = sub; ws.getCell(2, 3).font = {size: 10, color: {argb: 'FF475569'}};
      const hr = ws.getRow(6); hr.values = [a ? t.labelAr || '' : t.labelEn || '', ...t.columns.map(c => (a ? c.ar : c.en))]; hr.height = 30;
      hr.eachCell(c => { c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF003392'}}; c.font = {bold: true, color: {argb: 'FFFFFFFF'}}; c.alignment = {horizontal: 'center', vertical: 'middle', wrapText: true}; });
      let rn = 7;
      for (const row of t.rows) {
        const xr = ws.getRow(rn++); xr.getCell(1).value = a ? row.ar : row.en;
        if (row.style === 'section') { xr.getCell(1).font = {bold: true, color: {argb: 'FF003392'}}; continue; }
        row.values.forEach((v, j) => { const c = xr.getCell(j + 2); c.value = v; if (typeof v === 'number') c.numFmt = FMT[(row.fmts && row.fmts[j]) || t.columns[j]?.fmt || row.fmt]; });
        if (row.style === 'key' || row.style === 'total') for (let c = 1; c <= t.columns.length + 1; c++) { const cell = xr.getCell(c); cell.font = {bold: true}; if (row.style === 'key') cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEAF5EE'}}; }
      }
      ((a ? t.notesAr : t.notesEn) || []).forEach(n => { const c = ws.getCell(++rn, 1); c.value = n; c.font = {italic: true, color: {argb: 'FF64748B'}}; });
      ws.getColumn(1).width = 42; for (let c = 2; c <= t.columns.length + 1; c++) ws.getColumn(c).width = 15;
    }
    download(await wb.xlsx.writeBuffer(), `ElKareem_${id}${args.b ? '_branch' + args.b : ''}${args.m ? '_m' + args.m : ''}_${d.year}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  async function exportLedger(args, csv) {
    const def = E().LEDGERS[args.key], L = S.ledgers[args.key], a = ar(), fields = def.fields;
    const rowsOut = (L?.rows || []).map(r => fields.map(f => r.values[f.name] ?? null));
    const name = `ElKareem_${args.key}${args.branchId ? '_branch' + args.branchId : ''}${args.month ? '_m' + args.month : ''}_${S.data.year}`;
    if (csv) {
      const cell = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      return download('﻿' + [fields.map(f => cell(a ? f.ar : f.en)).join(','), ...rowsOut.map(r => r.map(cell).join(','))].join('\n'), name + '.csv', 'text/csv;charset=utf-8');
    }
    await ensureExcel();
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet((a ? def.ar : def.en).slice(0, 28), {views: [{rightToLeft: a, state: 'frozen', ySplit: 1}]});
    ws.columns = fields.map(f => ({header: a ? f.ar : f.en, width: f.type === 'text' ? 34 : 16}));
    rowsOut.forEach(r => ws.addRow(r));
    ws.getRow(1).eachCell(c => { c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF003392'}}; c.font = {bold: true, color: {argb: 'FFFFFFFF'}}; });
    download(await wb.xlsx.writeBuffer(), name + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ---------------------------------------------------------------- events
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));
  const J = s => JSON.parse(s || '{}');
  function recompute() {
    const d = S.data; if (!d || d.empty) return;
    d.ds.settings.reportMonth = S.rm || d.defaultReportMonth;
    d.result = E().computeCompany(d.ds); d.checks = E().allChecks(d.result); d.gaps = E().dataGaps(d.result); d.reportMonth = d.ds.settings.reportMonth;
  }
  function bind() {
    if (!canUse()) return;
    on('[data-fin-go]', 'click', el => { state.page = el.dataset.finGo; render(); });
    on('[data-fin-reload]', 'click', () => { S.error = null; refresh(); });
    on('[data-fin-lang]', 'click', () => { S.lang = ar() ? 'en' : 'ar'; render(); });
    on('#fin-rm', 'change', el => { S.rm = +el.value; recompute(); render(); });
    on('#fin-year', 'change', el => { S.year = +el.value; S.rm = null; refresh(); });
    on('[data-fin-print]', 'click', () => window.print());
    on('[data-fin-export]', 'click', el => exportReport(el.dataset.finExport, J(el.dataset.finArgs)).catch(e => showToast(errText(e), 'error')));
    on('[data-fin-lexport]', 'click', el => exportLedger(J(el.dataset.finLexport), !!el.dataset.csv).catch(e => showToast(errText(e), 'error')));
    on('[data-fin-branch]', 'click', el => { S.branch = +el.dataset.finBranch; render(); });
    on('[data-fin-tab]', 'click', el => { S.tab = el.dataset.finTab; render(); });
    on('[data-fin-paym]', 'click', el => { S.payM = el.dataset.finPaym; render(); });
    on('[data-fin-audit]', 'click', el => { S.auditTable = el.dataset.finAudit; render(); });
    // ledger filters
    on('[data-fin-q]', 'change', el => { S.filters[el.dataset.finQ].q = el.value; render(); });
    on('[data-fin-p]', 'change', el => { S.filters[el.dataset.finP].p = el.value; render(); });
    on('[data-fin-w]', 'change', el => { S.filters[el.dataset.finW].w = el.checked; render(); });
    // ledger rows
    on('[data-fin-add]', 'click', el => { const a = J(el.dataset.finAdd); state.modal = {type: 'fin-row', ...a, id: null, values: {}}; render(); });
    on('[data-fin-edit]', 'click', el => { const [key, id] = el.dataset.finEdit.split('|'), L = S.ledgers[key], r = L.rows.find(x => String(x.id) === id);
      state.modal = {type: 'fin-row', key, branchId: L.branchId, month: L.month, id: +id, values: {...r.values}}; render(); });
    on('[data-fin-del]', 'click', el => { const [key, id] = el.dataset.finDel.split('|');
      if (confirm(T('حذف هذا السطر؟ (يُسجل في سجل التعديلات)', 'Delete this line? (recorded in the audit log)'))) act(async () => check(await sb.from(E().LEDGERS[key].table).delete().eq('id', +id)), T('تم الحذف', 'Deleted')); });
    on('[data-fin-close-modal]', 'click', () => { state.modal = null; S.preview = null; S.pkg = null; render(); });
    on('[data-fin-rowsave]', 'click', () => {
      const m = state.modal, values = {};
      document.querySelectorAll('[data-fin-f]').forEach(i => { values[i.dataset.finF] = nz(i.value); });
      m.values = values;
      saveRow(m, values).then(() => refresh(T('تم الحفظ ✓', 'Saved ✓'))).catch(e => { m.error = errText(e); render(); });
    });
    // import
    on('[data-fin-import]', 'click', el => { S.preview = null; state.modal = {type: 'fin-import', ...J(el.dataset.finImport)}; render(); });
    on('[data-fin-erp]', 'click', el => { S.preview = null; state.modal = {type: 'fin-import', key: 'stock', branchId: +el.dataset.finErp, month: null,
      defaults: {month: +document.getElementById('fin-erp-m').value, reason: document.getElementById('fin-erp-r').value}}; render(); });
    on('[data-fin-preview]', 'click', async () => {
      const m = state.modal;
      try {
        S.file = document.getElementById('fin-imp-file').files[0] || S.file; S.pasted = document.getElementById('fin-imp-paste').value || '';
        const raw = withDefaults(await readUpload(S.file, S.pasted), m.defaults);
        const rowsV = E().validateRows(E().LEDGERS[m.key], lookups(S.data, m.branchId), raw);
        S.preview = {rows: rowsV, selected: new Set(rowsV.filter(r => r.data).map(r => r.index))}; render();
      } catch (e) { showToast(errText(e), 'error'); }
    });
    on('[data-fin-sel]', 'change', el => { const i = +el.dataset.finSel; if (el.checked) S.preview.selected.add(i); else S.preview.selected.delete(i); render(); });
    on('[data-fin-commit]', 'click', () => {
      const m = state.modal, def = E().LEDGERS[m.key], sc = scopeValues(def, m);
      const list = S.preview.rows.filter(r => r.data && S.preview.selected.has(r.index)).map(r => ({...r.data, ...sc}));
      act(() => insertChunks(def.table, list), `${T('تم استيراد', 'Imported')} ${list.length}`);
    });
    // monthly inputs / opening balances / commission header
    on('[data-fin-insave]', 'click', el => {
      const m = +el.dataset.finInsave, row = {branch_id: S.branch, year: S.data.year, month: m};
      try { document.querySelectorAll(`[data-fin-in^="${m}|"]:not(.fin-off)`).forEach(i => { const col = i.dataset.finIn.split('|')[1]; row[col] = col === 'notes' ? nz(i.value) : toNum(i.value);
        if (['invoices', 'items_sold', 'sku_end'].includes(col) && row[col] !== null && !Number.isInteger(row[col])) throw new Error(T('عدد صحيح فقط', 'Whole number only')); }); }
      catch (e) { return showToast(e.message, 'error'); }
      act(async () => check(await sb.from('fin_monthly_inputs').upsert(row, {onConflict: 'branch_id,year,month'})));
    });
    on('[data-fin-obsave]', 'click', () => {
      const row = {branch_id: S.branch, year: S.data.year};
      try { document.querySelectorAll('[data-fin-ob]').forEach(i => { row[i.dataset.finOb] = toNum(i.value); }); } catch (e) { return showToast(e.message, 'error'); }
      act(async () => check(await sb.from('fin_opening_balances').upsert(row, {onConflict: 'branch_id,year'})));
    });
    on('[data-fin-phsave]', 'click', el => {
      const row = {branch_id: S.branch, year: S.data.year, month: +el.dataset.finPhsave};
      try { document.querySelectorAll('[data-fin-ph]').forEach(i => { row[i.dataset.finPh] = toNum(i.value); }); } catch (e) { return showToast(e.message, 'error'); }
      act(async () => check(await sb.from('fin_payroll_months').upsert(row, {onConflict: 'branch_id,year,month'})));
    });
    // month closing (owners; reopening is audited)
    on('[data-fin-close]', 'click', el => {
      const [b, m] = el.dataset.finClose.split('|'), branchId = b === '' ? null : +b, month = +m, isC = closed(S.data, branchId, month);
      if (!confirm(isC ? T(`إعادة فتح ${MN()[month - 1]}؟ (يُسجل في سجل التعديلات)`, `Reopen ${MN()[month - 1]}? (audited)`) : T(`إغلاق ${MN()[month - 1]}؟ يصبح للقراءة فقط.`, `Close ${MN()[month - 1]}? It becomes read-only.`))) return;
      act(async () => {
        if (isC) { let q = sb.from('fin_month_closings').delete().eq('year', S.data.year).eq('month', month); q = branchId === null ? q.is('branch_id', null) : q.eq('branch_id', branchId); check(await q); }
        else check(await sb.from('fin_month_closings').insert({branch_id: branchId, year: S.data.year, month, closed_by: state.user.id}));
      }, isC ? T('تمت إعادة الفتح', 'Reopened') : T('تم الإغلاق 🔒', 'Closed 🔒'));
    });
    // settings
    on('[data-fin-fysave]', 'click', () => {
      const row = {};
      document.querySelectorAll('[data-fin-fy]').forEach(i => { row[i.dataset.finFy] = i.value === '' ? null : (/^\d+(\.\d+)?$/.test(i.value) ? +i.value : i.value); });
      S.rm = null;
      act(async () => check(await sb.from('fin_years').update(row).eq('year', S.data.year)));
    });
    on('[data-fin-newyear]', 'click', () => {
      const Y = S.data.year + 1;
      if (!confirm(T(`بدء السنة المالية ${Y}؟ (نفس الإعدادات والفروع، بدون أرقام)`, `Start fiscal year ${Y}? (same settings and branches, no figures)`))) return;
      act(async () => {
        const {year, created_at, created_by, updated_at, updated_by, ...rest} = S.data.fy;
        check(await sb.from('fin_years').insert({...rest, year: Y, report_month: 1, app_payroll_from_month: rest.app_payroll_from_month ? 1 : null}));
        check(await sb.from('fin_branch_settings').insert(S.data.ds.branches.map(b => ({branch_id: b.branch.id, year: Y, depreciation_register_from_month: 1}))));
      });
    });
    on('[data-fin-bsave]', 'click', el => {
      const id = +el.dataset.finBsave, tr = document.querySelector(`[data-fin-brow="${id}"]`), g = k => tr.querySelector(`[data-k="${k}"]`).value;
      act(async () => {
        check(await sb.from('fin_branches').update({name_ar: g('name_ar'), name_en: g('name_en'), color: g('color'), app_branch: nz(g('app_branch'))}).eq('id', id));
        check(await sb.from('fin_branch_settings').upsert({branch_id: id, year: S.data.year, depreciation_register_from_month: +g('dep'), opened_month: g('opened') ? +g('opened') : null}, {onConflict: 'branch_id,year'}));
      });
    });
    on('[data-fin-listsave]', 'click', el => {
      const [kind, id] = el.dataset.finListsave.split('|'), tr = el.closest('tr'), v = {};
      tr.querySelectorAll('[data-k]').forEach(i => { v[i.dataset.k] = nz(i.value.trim()); });
      const table = {cat: 'fin_expense_categories', acat: 'fin_asset_categories', reason: 'fin_adjustment_reasons'}[kind];
      if (kind === 'cat') { v.key = (v.key || '').toUpperCase(); v.pl_class = (v.pl_class || '').toUpperCase(); if (!/^[A-Z_]+$/.test(v.key) || !['OPEX', 'STAFF', 'DEP'].includes(v.pl_class)) return showToast(T('الكود حروف إنجليزية كبيرة والنوع OPEX أو STAFF أو DEP', 'Key A–Z/_ and class OPEX/STAFF/DEP'), 'error'); }
      if (kind === 'acat' && v.useful_life_months !== null) v.useful_life_months = +v.useful_life_months;
      act(async () => {
        if (!id) check(await sb.from(table).insert({...v, sort_order: 999}));
        else if (kind === 'cat') { delete v.key; check(await sb.from(table).update(v).eq('key', id)); }
        else check(await sb.from(table).update(v).eq('id', +id));
      });
    });
    // data package
    on('[data-fin-pkg]', 'click', () => { S.pkg = {}; state.modal = {type: 'fin-pkg'}; render(); });
    on('[data-fin-pkgread]', 'click', async () => {
      try { await ensureEngine(); S.pkg = await readPackage(document.getElementById('fin-pkg-files').files); } catch (e) { S.pkg = {error: errText(e)}; }
      render();
    });
    on('[data-fin-pkgsave]', 'click', () => {
      const replace = !!document.getElementById('fin-pkg-replace')?.checked;
      if (S.data && !S.data.empty && !replace) return showToast(T('علّم خيار المسح والاستبدال أولًا', 'Tick «delete and replace» first'), 'error');
      S.busy = true;
      savePackage(S.pkg, replace).then(() => { S.busy = false; S.pkg = null; refresh(T('تم استيراد بيانات المالية ✓', 'Finance data imported ✓')); })
        .catch(e => { S.busy = false; console.error(e); S.pkg.error = errText(e); S.pkg.progress = null; render(); });
    });
    on('[data-fin-reset]', 'click', () => {
      if (prompt(T('اكتب «مسح» لتأكيد مسح كل بيانات المالية', 'Type DELETE to confirm deleting all finance data')) !== T('مسح', 'DELETE')) return;
      act(async () => check(await sb.rpc('fin_reset_data')), T('تم المسح', 'Deleted'));
    });
  }

  // ---------------------------------------------------------------- lifecycle
  function onLogin() { S.data = null; S.error = null; S.rm = null; S.year = null; S.branch = null; if (canUse()) ensureEngine().catch(() => {}); }
  function reset() { S.data = null; S.error = null; S.preview = null; S.pkg = null; S.ledgers = {}; S.filters = {}; }

  // ---------------------------------------------------------------- styles (scoped under .fin)
  const STYLE = `<style id="fin-style">
    .fin .fin-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .fin .fin-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}.fin .fin-title h2{font-size:18px;margin:0}.fin .fin-title>span{color:var(--text2);font-size:12px}
    .fin .fin-card{margin-bottom:14px}.fin .grid-2>.fin-card,.fin .grid-2>div>.fin-card{min-width:0}
    .fin .fin-n,.fin td.n{font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:plaintext}.fin .neg{color:var(--danger)}.fin .pos{color:var(--success)}
    .fin .fin-kpis{margin-bottom:14px}.fin .fin-key{border:1px solid rgba(21,128,61,.4);background:rgba(21,128,61,.05)}.fin .fin-sub{font-size:12px;color:var(--text2);margin-top:4px}
    .fin .fin-tw{overflow:auto;border:1px solid var(--border);border-radius:var(--radius2)}
    .fin table.fin-rt{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
    .fin .fin-rt th,.fin .fin-rt td{padding:5px 8px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:start}
    .fin .fin-rt thead th{position:sticky;top:0;background:#003392;color:#fff;font-weight:700;z-index:2;text-align:center}
    .fin .fin-rt thead th.emph{background:#0E6B30}.fin .fin-rt thead th.calc{background:#475569}
    .fin .fin-rt td.n{text-align:end}.fin .fin-rt td.emph{background:#eef4ff}
    .fin .fin-rt td.lbl,.fin .fin-rt th.lbl{position:sticky;inset-inline-start:0;background:#fff;z-index:1;min-width:200px}.fin .fin-rt thead th.lbl{background:#003392;z-index:3}
    .fin .fin-rt tr.key td{font-weight:800;background:#eaf5ee}.fin .fin-rt tr.total td{font-weight:800;border-top:2px solid #94a3b8}
    .fin .fin-rt tr.section td{background:var(--bg3);color:#003392;font-weight:800}.fin .fin-rt tr.ratio td{color:var(--text2);font-style:italic}.fin .fin-rt tr.subtle td{color:var(--text3)}
    .fin .fin-rt td.in{color:#1d4ed8;background:#fffdf0}.fin .fin-rt tr.warnrow td{background:#fffbeb}.fin .warnc{color:var(--warn);font-weight:700}
    .fin .fin-rt td.acts{white-space:nowrap}.fin .fin-rt td.acts .btn{padding:2px 6px}
    .fin .fin-cell{background:#fffbe6;color:#1d4ed8;border:1px solid #f1e3a6;border-radius:6px;padding:3px 6px;min-width:90px;width:100%}.fin .fin-cell:disabled{background:var(--bg3);color:var(--text3)}.fin .fin-cell.fin-off{background:#e5e7eb;border-color:#d1d5db;color:#9ca3af;cursor:not-allowed}
    .fin .fin-notes,.fin .fin-foot{font-size:12px;color:var(--text3);margin:6px 0}.fin .fin-notes{padding-inline-start:18px}
    .fin .fin-chart{width:100%;height:auto}.fin .fin-chart .ax{font-size:10px;fill:#475569}
    .fin .fin-legend{display:flex;gap:14px;justify-content:center;font-size:12px;color:var(--text2)}.fin .fin-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-inline-end:5px}
    .fin .fin-bars{display:flex;flex-direction:column;gap:6px}.fin .fin-bar{display:grid;grid-template-columns:minmax(120px,38%) 1fr 90px;gap:8px;align-items:center;font-size:12px}
    .fin .fin-bar .t{background:var(--bg3);border-radius:4px;height:14px;overflow:hidden}.fin .fin-bar .t b{display:block;height:100%;background:#0E6B30;border-radius:4px}.fin .fin-bar .v{text-align:end;font-variant-numeric:tabular-nums;direction:ltr}
    .fin .fin-gaps{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:6px}.fin .fin-gaps>div{background:var(--warn2);color:#92400e;border-radius:8px;padding:6px 10px;font-size:12.5px}
    .fin .fin-tabs{display:flex;gap:4px;flex-wrap:wrap}.fin .fin-tab{border:1px solid var(--border);background:var(--card);border-radius:8px;padding:5px 10px;font-size:13px;cursor:pointer;font-weight:600;color:var(--text2)}
    .fin .fin-tab.on{background:#003392;color:#fff;border-color:#003392}
    .fin .fin-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.fin .fin-bchip{border:2px solid var(--border);background:var(--card);border-radius:20px;padding:5px 12px;cursor:pointer;font-weight:800}
    .fin .fin-bchip i{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--c);margin-inline-end:6px}.fin .fin-bchip.on{border-color:var(--c);color:var(--c)}
    .fin .fin-close{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;margin:8px 0;color:var(--text2)}.fin .fin-mc{border:1px solid var(--border);background:var(--card);border-radius:14px;padding:2px 8px;cursor:pointer;font-size:11px}.fin .fin-mc.on{background:#1e293b;color:#fff}
    .fin .fin-ob,.fin .fin-erp,.fin .fin-bar-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px}.fin .fin-ob label,.fin .fin-erp label{display:flex;flex-direction:column;font-size:11px;color:var(--text2);gap:3px}
    .fin .fin-erp{border:1px dashed var(--border2);border-radius:var(--radius2);padding:8px;background:var(--card2);align-items:center}
    .fin .fin-sums{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;margin-bottom:6px}.fin .fin-warn{background:var(--warn2);border-radius:8px;padding:6px 10px;font-size:12px;color:#92400e;margin:6px 0}
    .fin .fin-chk{display:flex;align-items:center;gap:6px;font-size:12px}.fin .fin-chk input{width:auto}.fin .fin-checklist{display:flex;flex-direction:column;gap:6px;font-size:13px}
    .modal .fin-rt{font-size:12px}.modal .fin-tw{overflow:auto}
    @media print{.fin .no-print{display:none!important}.fin .fin-tw{max-height:none!important;overflow:visible}.fin .fin-rt thead th,.fin .fin-rt td.lbl{position:static}}
  </style>`;
  const withStyle = html => { if (!document.getElementById('fin-style')) document.head.insertAdjacentHTML('beforeend', STYLE); return html; };

  return {nav, label, renderPage, modal, bind, onLogin, reset, _S: S};
})();

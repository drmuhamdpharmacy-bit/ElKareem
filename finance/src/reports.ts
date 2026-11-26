/**
 * Report table models. Every screen and every Excel export is rendered from these, so a figure is
 * computed exactly once (in the engine) and only formatted here. Ratios in total columns are
 * always recomputed from the totals, never summed or averaged.
 */
import type { BranchResult, Series } from './branch';
import { consolidatedTurnover, type CompanyResult } from './company';
import { D, Decimal, ZERO, div, sum, toNum } from './decimal';
import { MONTHS_AR, MONTHS_EN } from './fiscal';
import type { Fmt } from './i18n';
import type { PayrollMonthResult } from './payroll';

export type Cell = number | string | null;
export type RowStyle = 'normal' | 'key' | 'section' | 'ratio' | 'subtle' | 'total';

export interface ReportColumn {
  key: string;
  ar: string;
  en: string;
  fmt?: Fmt;
  /** Highlight (e.g. report month / YTD). */
  emphasis?: boolean;
}

export interface ReportRow {
  key?: string;
  ar: string;
  en: string;
  values: Cell[];
  fmt: Fmt;
  /** Per-cell format override (same length as values). */
  fmts?: (Fmt | undefined)[];
  style?: RowStyle;
}

export interface ReportTable {
  id: string;
  titleAr: string;
  titleEn: string;
  labelAr?: string;
  labelEn?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  notesAr?: string[];
  notesEn?: string[];
}

const n = (x: Decimal | null | undefined): number | null => toNum(x ?? null);
const monthCols = (): ReportColumn[] => MONTHS_AR.map((ar, i) => ({ key: `m${i + 1}`, ar, en: MONTHS_EN[i] }));
const Y = (xs: Series, R: number) => sum(xs.slice(0, R));
const FY = (xs: Series) => sum(xs);

// ================================================================================================
// Branch P&L (§4.8)
// ================================================================================================

export function plColumns(R: number): ReportColumn[] {
  return [
    ...monthCols(),
    { key: 'ytd', ar: 'حتى شهر التقرير', en: 'YTD', emphasis: true },
    { key: 'fy', ar: 'السنة', en: 'Full year' },
    { key: 'pct', ar: '% من صافي المبيعات (YTD)', en: '% of net sales (YTD)', fmt: 'pct' },
    { key: 'rm', ar: `شهر التقرير (${MONTHS_AR[R - 1]})`, en: `Report month (${MONTHS_EN[R - 1]})`, emphasis: true },
  ];
}


function plRows(src: Record<string, Series>, R: number, opts: { shared?: Series } = {}): ReportRow[] {
  const s = src;
  const ns = s.NET_SALES;
  const nsY = Y(ns, R);
  const line = (key: string, ar: string, en: string, xs: Series, style: RowStyle = 'normal'): ReportRow => ({
    key, ar, en, fmt: 'money', style,
    values: [...xs.map(n), n(Y(xs, R)), n(FY(xs)), n(div(Y(xs, R), nsY)), n(xs[R - 1])],
    fmts: [...Array(15).fill(undefined), 'pct', undefined],
  });
  const ratio = (key: string, ar: string, en: string, num: Series, den: Series = ns): ReportRow => ({
    key, ar, en, fmt: 'pct', style: 'ratio',
    values: [
      ...num.map((x, i) => n(div(x, den[i]))),
      n(div(Y(num, R), Y(den, R))), n(div(FY(num), FY(den))), null, n(div(num[R - 1], den[R - 1])),
    ],
  });
  const add = (a: Series, b: Series) => a.map((x, i) => x.plus(b[i]));
  const rows: ReportRow[] = [
    line('GROSS_SALES', 'إجمالي المبيعات', 'Gross sales', s.GROSS_SALES),
    line('RETURNS', 'المرتجعات', 'Returns', s.RETURNS),
    line('NET_SALES', 'صافي المبيعات', 'Net sales', s.NET_SALES, 'key'),
    line('COGS', 'تكلفة المبيعات', 'Cost of goods sold', s.COGS),
    line('GP', 'مجمل الربح', 'Gross profit', s.GP, 'key'),
    ratio('GP_PCT', 'نسبة مجمل الربح', 'Gross margin %', s.GP),
    { ar: 'المصروفات', en: 'Expenses', fmt: 'text', style: 'section', values: [] },
    line('SALARIES', 'المرتبات', 'Salaries', s.SALARIES),
    line('STAFF_OPEX', 'مصروفات عاملين ضمن التشغيل', 'Staff-related (in opex)', s.STAFF_OPEX),
    line('OPEX', 'مصروفات التشغيل', 'Operating expenses', s.OPEX),
  ];
  if (opts.shared) rows.push(line('SHARED', 'مصروفات مشتركة', 'Shared company expenses', opts.shared));
  rows.push(
    line('DEP', 'الإهلاك والاستهلاك', 'Depreciation & amortisation', s.DEP),
    line('POINTS', 'النقاط', 'Loyalty points', s.POINTS),
    line('TOTAL_EXP', 'إجمالي المصروفات', 'Total expenses', s.TOTAL_EXP, 'total'),
    line('OP_RESULT', 'النتيجة التشغيلية (الطريقة الحالية)', 'Operating result (current method)', s.OP_RESULT, 'key'),
    line('EXPIRED', 'التوالف والإكسبير', 'Expired & damaged', s.EXPIRED),
    line('NET_RESULT', 'صافي النتيجة بعد خسائر المخزون', 'Net result after stock losses', s.NET_RESULT, 'key'),
    ratio('NET_MARGIN', 'هامش صافي النتيجة', 'Net margin %', s.NET_RESULT),
    { ar: 'مؤشرات', en: 'Ratios', fmt: 'text', style: 'section', values: [] },
    ratio('SAL_PCT', 'المرتبات ÷ صافي المبيعات', 'Salaries %', s.SALARIES),
    ratio('OPEX_PCT', 'التشغيل + العاملين ÷ المبيعات', 'Opex incl. staff %', add(s.OPEX, s.STAFF_OPEX)),
    ratio('EXP_PCT', 'إجمالي المصروفات ÷ المبيعات', 'Total expenses %', s.TOTAL_EXP),
    ratio('EXPIRED_PCT', 'التوالف ÷ المبيعات', 'Expired %', s.EXPIRED),
    ratio('POINTS_PCT', 'النقاط ÷ المبيعات', 'Points %', s.POINTS),
    {
      key: 'INVOICES', ar: 'عدد الفواتير', en: 'Invoices', fmt: 'int', style: 'ratio',
      values: [...s.INVOICES.map(n), n(Y(s.INVOICES, R)), n(FY(s.INVOICES)), null, n(s.INVOICES[R - 1])],
    },
    {
      key: 'AVG_TICKET', ar: 'متوسط الفاتورة', en: 'Average ticket', fmt: 'money', style: 'ratio',
      values: [
        ...s.NET_SALES.map((x, i) => n(div(x, s.INVOICES[i]))),
        n(div(Y(s.NET_SALES, R), Y(s.INVOICES, R))), n(div(FY(s.NET_SALES), FY(s.INVOICES))), null,
        n(div(s.NET_SALES[R - 1], s.INVOICES[R - 1])),
      ],
    },
  );
  return rows;
}

export function branchPLTable(b: BranchResult): ReportTable {
  const R = b.reportMonth;
  return {
    id: `pl-b${b.branchId}`,
    titleAr: `قائمة الدخل الشهرية – ${b.dataset.branch.nameAr}`,
    titleEn: `Monthly P&L – ${b.dataset.branch.nameEn}`,
    labelAr: 'البند', labelEn: 'Line item',
    columns: plColumns(R),
    rows: plRows(b.series, R),
  };
}

export function consolidatedMonthlyTable(c: CompanyResult): ReportTable {
  const R = c.reportMonth;
  return {
    id: 'pl-consolidated-monthly',
    titleAr: 'قائمة الدخل المجمعة شهريًا (الفروع + المشترك)',
    titleEn: 'Monthly consolidated P&L (branches + shared)',
    labelAr: 'البند', labelEn: 'Line item',
    columns: plColumns(R),
    rows: plRows(c.consolidated, R, { shared: c.sharedSeries }),
  };
}

/** Branch 1 | Branch 2 | … | Shared | Consolidated – for one period kind ('month' or 'ytd'). */
export function consolidatedSideBySide(c: CompanyResult, kind: 'month' | 'ytd'): ReportTable {
  const R = c.reportMonth;
  const pick = (xs: Series) => (kind === 'month' ? xs[R - 1] : Y(xs, R));
  const cols: ReportColumn[] = [
    ...c.branches.map((b) => ({ key: `b${b.branchId}`, ar: b.dataset.branch.nameAr, en: b.dataset.branch.nameEn })),
    { key: 'shared', ar: 'مشترك', en: 'Shared' },
    { key: 'cons', ar: 'المجمع', en: 'Consolidated', emphasis: true },
  ];
  const sh = pick(c.sharedSeries);
  const money = (key: string, ar: string, en: string, sharedVal: Decimal, style: RowStyle = 'normal'): ReportRow => {
    const vals = c.branches.map((b) => pick((b.series as Record<string, Series>)[key]));
    return { key, ar, en, fmt: 'money', style, values: [...vals.map(n), n(sharedVal), n(sum(vals).plus(sharedVal))] };
  };
  const ratio = (key: string, ar: string, en: string, numKey: string, extraShared = ZERO): ReportRow => {
    const nums = c.branches.map((b) => pick((b.series as Record<string, Series>)[numKey]));
    const dens = c.branches.map((b) => pick(b.series.NET_SALES));
    return {
      key, ar, en, fmt: 'pct', style: 'ratio',
      values: [...nums.map((x, i) => n(div(x, dens[i]))), null, n(div(sum(nums).plus(extraShared), sum(dens)))],
    };
  };
  const rows: ReportRow[] = [
    money('GROSS_SALES', 'إجمالي المبيعات', 'Gross sales', ZERO),
    money('RETURNS', 'المرتجعات', 'Returns', ZERO),
    money('NET_SALES', 'صافي المبيعات', 'Net sales', ZERO, 'key'),
    money('COGS', 'تكلفة المبيعات', 'COGS', ZERO),
    money('GP', 'مجمل الربح', 'Gross profit', ZERO, 'key'),
    ratio('GP_PCT', 'نسبة مجمل الربح', 'GP %', 'GP'),
    money('SALARIES', 'المرتبات', 'Salaries', ZERO),
    money('STAFF_OPEX', 'مصروفات عاملين ضمن التشغيل', 'Staff-related', ZERO),
    money('OPEX', 'مصروفات التشغيل', 'Operating expenses', ZERO),
    {
      key: 'SHARED', ar: 'مصروفات مشتركة', en: 'Shared expenses', fmt: 'money',
      values: [...c.branches.map(() => 0), n(sh), n(sh)],
    },
    money('DEP', 'الإهلاك والاستهلاك', 'Depreciation', ZERO),
    money('POINTS', 'النقاط', 'Loyalty points', ZERO),
    money('TOTAL_EXP', 'إجمالي المصروفات', 'Total expenses', sh, 'total'),
    money('OP_RESULT', 'النتيجة التشغيلية (الطريقة الحالية)', 'Operating result', sh.neg(), 'key'),
    money('EXPIRED', 'التوالف والإكسبير', 'Expired & damaged', ZERO),
    money('NET_RESULT', 'صافي النتيجة بعد خسائر المخزون', 'Net result', sh.neg(), 'key'),
    ratio('NET_MARGIN', 'هامش صافي النتيجة', 'Net margin %', 'NET_RESULT', sh.neg()),
    money('PURCH_NET', 'صافي المشتريات', 'Net purchases', ZERO),
    {
      // Ending inventory is a balance at the report month, not a sum (§4.11).
      key: 'INV_END', ar: 'مخزون آخر الشهر', en: 'Ending inventory (balance)', fmt: 'money',
      values: [...c.branches.map((b) => n(b.series.INV_END[R - 1])), 0, n(sum(c.branches.map((b) => b.series.INV_END[R - 1])))],
    },
    money('INVOICES', 'عدد الفواتير', 'Invoices', ZERO),
    {
      key: 'AVG_TICKET', ar: 'متوسط الفاتورة', en: 'Average ticket', fmt: 'money', style: 'ratio',
      values: [
        ...c.branches.map((b) => n(div(pick(b.series.NET_SALES), pick(b.series.INVOICES)))), null,
        n(div(sum(c.branches.map((b) => pick(b.series.NET_SALES))), sum(c.branches.map((b) => pick(b.series.INVOICES))))),
      ],
    },
  ];
  rows.find((r) => r.key === 'INVOICES')!.fmt = 'int';
  return {
    id: `pl-consolidated-${kind}`,
    titleAr: kind === 'month' ? `قائمة الدخل المجمعة – ${MONTHS_AR[R - 1]}` : `قائمة الدخل المجمعة – من بداية السنة حتى ${MONTHS_AR[R - 1]}`,
    titleEn: kind === 'month' ? `Consolidated P&L – ${MONTHS_EN[R - 1]}` : `Consolidated P&L – YTD to ${MONTHS_EN[R - 1]}`,
    labelAr: 'البند', labelEn: 'Line item',
    columns: cols,
    rows,
  };
}

// ================================================================================================
// Branch comparison (Master!Comparison)
// ================================================================================================

export function comparisonTable(c: CompanyResult): ReportTable {
  const R = c.reportMonth;
  const days = c.branches[0]?.calendar.map((x) => x.days) ?? [];
  const daysM = days[R - 1] ?? 0;
  const daysY = days.slice(0, R).reduce((a, x) => a + x, 0);
  const cols: ReportColumn[] = [];
  for (const kind of ['month', 'ytd'] as const) {
    for (const b of c.branches) cols.push({ key: `${kind}-b${b.branchId}`, ar: `${b.dataset.branch.nameAr}${kind === 'ytd' ? ' YTD' : ''}`, en: `${b.dataset.branch.nameEn}${kind === 'ytd' ? ' YTD' : ''}` });
    cols.push({ key: `${kind}-cons`, ar: kind === 'ytd' ? 'المجمع YTD' : 'المجمع', en: kind === 'ytd' ? 'Consolidated YTD' : 'Consolidated', emphasis: true });
  }
  type Get = (b: BranchResult, kind: 'month' | 'ytd') => { num: Decimal; den: Decimal | null };
  const pick = (xs: Series, kind: 'month' | 'ytd') => (kind === 'month' ? xs[R - 1] : Y(xs, R));
  const row = (ar: string, en: string, fmt: Fmt, get: Get, consolidate: 'ratio' | 'sum' = 'ratio'): ReportRow => {
    const values: Cell[] = [];
    for (const kind of ['month', 'ytd'] as const) {
      const parts = c.branches.map((b) => get(b, kind));
      for (const p of parts) values.push(p.den === null ? n(p.num) : n(div(p.num, p.den)));
      if (consolidate === 'sum' || parts.every((p) => p.den === null)) values.push(n(sum(parts.map((p) => p.num))));
      else values.push(n(div(sum(parts.map((p) => p.num)), sum(parts.map((p) => p.den ?? ZERO)))));
    }
    return { ar, en, fmt, values, style: fmt === 'pct' ? 'ratio' : 'normal' };
  };
  const totNS = (kind: 'month' | 'ytd') => sum(c.branches.map((b) => pick(b.series.NET_SALES, kind)));
  const rows: ReportRow[] = [
    row('صافي المبيعات', 'Net sales', 'money', (b, k) => ({ num: pick(b.series.NET_SALES, k), den: null }), 'sum'),
    { ...row('حصة الفرع من المبيعات', 'Share of sales', 'pct', (b, k) => ({ num: pick(b.series.NET_SALES, k), den: totNS(k) })) },
    row('نسبة مجمل الربح', 'GP %', 'pct', (b, k) => ({ num: pick(b.series.GP, k), den: pick(b.series.NET_SALES, k) })),
    row('المرتبات ÷ المبيعات', 'Salaries %', 'pct', (b, k) => ({ num: pick(b.series.SALARIES, k), den: pick(b.series.NET_SALES, k) })),
    row('التشغيل + العاملين ÷ المبيعات', 'Opex %', 'pct', (b, k) => ({ num: pick(b.series.OPEX, k).plus(pick(b.series.STAFF_OPEX, k)), den: pick(b.series.NET_SALES, k) })),
    row('إجمالي المصروفات ÷ المبيعات', 'Expense ratio', 'pct', (b, k) => ({ num: pick(b.series.TOTAL_EXP, k), den: pick(b.series.NET_SALES, k) })),
    row('التوالف ÷ المبيعات', 'Expired %', 'pct', (b, k) => ({ num: pick(b.series.EXPIRED, k), den: pick(b.series.NET_SALES, k) })),
    row('النقاط ÷ المبيعات', 'Points %', 'pct', (b, k) => ({ num: pick(b.series.POINTS, k), den: pick(b.series.NET_SALES, k) })),
    row('هامش صافي النتيجة', 'Net margin', 'pct', (b, k) => ({ num: pick(b.series.NET_RESULT, k), den: pick(b.series.NET_SALES, k) })),
    row('صافي النتيجة', 'Net result', 'money', (b, k) => ({ num: pick(b.series.NET_RESULT, k), den: null }), 'sum'),
    row('عدد الفواتير', 'Invoices', 'int', (b, k) => ({ num: pick(b.series.INVOICES, k), den: null }), 'sum'),
    row('متوسط الفاتورة', 'Average ticket', 'money', (b, k) => ({ num: pick(b.series.NET_SALES, k), den: pick(b.series.INVOICES, k) })),
    row('دوران المخزون', 'Inventory turnover', 'num4', (b, k) => ({
      num: pick(b.series.COGS, k),
      den: k === 'month'
        ? b.series.INV_BEG[R - 1].plus(b.series.INV_END[R - 1]).div(2)
        : b.series.INV_BEG[0].plus(b.series.INV_END[R - 1]).div(2),
    })),
  ];
  // The consolidated share of sales is 100% by definition (not a sum of the branch denominators).
  const share = rows[1];
  const nb = c.branches.length;
  share.values[nb] = totNS('month').isZero() ? null : 1;
  share.values[2 * nb + 1] = totNS('ytd').isZero() ? null : 1;
  // DSI = days / turnover; growth vs prior year.
  const turnoverRow = rows[rows.length - 1];
  rows.push({
    ar: 'أيام المخزون (DSI)', en: 'Days of inventory (DSI)', fmt: 'num2', style: 'ratio',
    values: turnoverRow.values.map((t, i) => {
      const d = i < c.branches.length + 1 ? daysM : daysY;
      return typeof t === 'number' && t !== 0 ? d / t : null;
    }),
  });
  rows.push(row('النمو عن نفس الفترة 2025', 'Growth vs prior year', 'pct', (b, k) => {
    const py = pick(b.series.NS_PY, k === 'month' ? 'month' : 'ytd');
    // Comparable months only: prior-year months where this year has sales.
    const pyComparable = k === 'month' ? (b.series.HAS_SALES[R - 1].isZero() ? ZERO : py)
      : sum(b.series.NS_PY.slice(0, R).map((x, i) => (b.series.HAS_SALES[i].isZero() ? ZERO : x)));
    return { num: pick(b.series.NET_SALES, k).minus(pyComparable), den: pyComparable };
  }));
  return {
    id: 'comparison', titleAr: 'مقارنة الفروع', titleEn: 'Branch comparison',
    labelAr: 'المؤشر', labelEn: 'KPI', columns: cols, rows,
  };
}

// ================================================================================================
// Sales analysis (§4.9) – months as rows
// ================================================================================================

export function salesTable(b: BranchResult): ReportTable {
  const cols: ReportColumn[] = [
    { key: 'days', ar: 'الأيام', en: 'Days', fmt: 'days' },
    { key: 'gross', ar: 'إجمالي المبيعات', en: 'Gross sales', fmt: 'money' },
    { key: 'returns', ar: 'المرتجعات', en: 'Returns', fmt: 'money' },
    { key: 'net', ar: 'صافي المبيعات', en: 'Net sales', fmt: 'money', emphasis: true },
    { key: 'daily', ar: 'متوسط المبيعات اليومي', en: 'Daily average', fmt: 'money' },
    { key: 'retPct', ar: 'نسبة المرتجعات', en: 'Returns %', fmt: 'pct' },
    { key: 'gp', ar: 'مجمل الربح', en: 'Gross profit', fmt: 'money' },
    { key: 'gpPct', ar: 'نسبة مجمل الربح', en: 'GP %', fmt: 'pct' },
    { key: 'cogs', ar: 'تكلفة المبيعات', en: 'COGS', fmt: 'money' },
    { key: 'inv', ar: 'عدد الفواتير', en: 'Invoices', fmt: 'int' },
    { key: 'ticket', ar: 'متوسط الفاتورة', en: 'Avg ticket', fmt: 'money' },
    { key: 'upi', ar: 'وحدات/فاتورة', en: 'Units / invoice', fmt: 'num2' },
    { key: 'momNs', ar: 'نمو صافي المبيعات (شهري)', en: 'Net sales MoM', fmt: 'pct' },
    { key: 'momGp', ar: 'نمو مجمل الربح (شهري)', en: 'GP MoM', fmt: 'pct' },
    { key: 'py', ar: 'صافي مبيعات نفس الشهر العام السابق', en: 'Same month last year', fmt: 'money' },
    { key: 'yoy', ar: 'النمو عن العام السابق', en: 'YoY growth', fmt: 'pct' },
    { key: 'purch', ar: 'صافي المشتريات', en: 'Net purchases', fmt: 'money' },
    { key: 'pRetPct', ar: 'نسبة مرتجع المشتريات', en: 'Purchase returns %', fmt: 'pct' },
    { key: 'pToS', ar: 'المشتريات ÷ صافي المبيعات', en: 'Purchases / net sales', fmt: 'pct' },
  ];
  const toRow = (ar: string, en: string, r: BranchResult['sales'][number], style: RowStyle = 'normal'): ReportRow => ({
    ar, en, style, fmt: 'money', fmts: cols.map((c) => c.fmt),
    values: [
      r.days, n(r.gross), n(r.returns), n(r.net), n(r.dailyAvg), n(r.returnsPct), n(r.gp), n(r.gpPct), n(r.cogs), n(r.invoices),
      n(r.avgTicket), n(r.unitsPerInvoice), n(r.momNet), n(r.momGp), n(r.netPy), n(r.yoy), n(r.netPurchases), n(r.purchaseReturnsPct),
      n(r.purchasesToSales),
    ],
  });
  return {
    id: `sales-b${b.branchId}`,
    titleAr: `تحليل المبيعات والمشتريات – ${b.dataset.branch.nameAr}`,
    titleEn: `Sales & purchases analysis – ${b.dataset.branch.nameEn}`,
    labelAr: 'الشهر', labelEn: 'Month',
    columns: cols,
    rows: [
      ...b.sales.map((r) => toRow(MONTHS_AR[r.month - 1], MONTHS_EN[r.month - 1], r)),
      toRow('حتى شهر التقرير', 'YTD', b.salesYtd, 'total'),
      toRow('السنة', 'Full year', b.salesFullYear, 'total'),
    ],
    notesAr: [
      'الإجماليات تشمل فقط الشهور التي بها مبيعات، والمقارنة بالعام السابق على نفس الشهور فقط.',
      'ملاحظة: سنة 2025 استخدمت شهورًا ميلادية (ديسمبر 2025 = 1–25 ديسمبر)، وسنة 2026 تستخدم شهورًا من 26 إلى 25.',
    ],
    notesEn: [
      'Totals include only months with sales; the prior-year comparison uses the same months only.',
      'Note: 2025 used calendar months (December 2025 = 1–25 Dec); 2026 uses 26→25 months.',
    ],
  };
}

// ================================================================================================
// Inventory turnover (§4.10)
// ================================================================================================

export function turnoverTable(b: BranchResult): ReportTable {
  const cols: ReportColumn[] = [
    { key: 'days', ar: 'الأيام', en: 'Days', fmt: 'days' },
    { key: 'open', ar: 'مخزون أول المدة', en: 'Opening inventory', fmt: 'money' },
    { key: 'purch', ar: 'صافي المشتريات', en: 'Net purchases', fmt: 'money' },
    { key: 'close', ar: 'مخزون آخر المدة', en: 'Closing inventory', fmt: 'money' },
    { key: 'avg', ar: 'متوسط المخزون', en: 'Average inventory', fmt: 'money' },
    { key: 'cogs', ar: 'تكلفة المبيعات (قائمة الدخل)', en: 'COGS (P&L)', fmt: 'money' },
    { key: 'scogs', ar: 'تكلفة المبيعات من المخزون', en: 'Stock-based COGS', fmt: 'money' },
    { key: 'diff', ar: 'الفرق (تسويات/عجز)', en: 'Difference (adjustments/shrinkage)', fmt: 'money' },
    { key: 'turn', ar: 'معدل الدوران', en: 'Turnover', fmt: 'num4', emphasis: true },
    { key: 'ann', ar: 'الدوران السنوي', en: 'Annualised', fmt: 'num2' },
    { key: 'dsi', ar: 'أيام المخزون DSI', en: 'DSI', fmt: 'num2' },
    { key: 'skuO', ar: 'أصناف أول المدة', en: 'SKUs open', fmt: 'int' },
    { key: 'skuC', ar: 'أصناف آخر المدة', en: 'SKUs close', fmt: 'int' },
    { key: 'skuD', ar: 'فرق الأصناف', en: 'SKU change', fmt: 'int' },
    { key: 'qtyO', ar: 'كمية أول المدة', en: 'Qty open', fmt: 'num2' },
    { key: 'qtyC', ar: 'كمية آخر المدة', en: 'Qty close', fmt: 'num2' },
    { key: 'qtyD', ar: 'فرق الكمية', en: 'Qty change', fmt: 'num2' },
    { key: 'smp', ar: 'صافي المبيعات − صافي المشتريات', en: 'Net sales − net purchases', fmt: 'money' },
    { key: 'smpPct', ar: 'النسبة من المبيعات', en: '% of sales', fmt: 'pct' },
  ];
  return {
    id: `turnover-b${b.branchId}`,
    titleAr: `دوران المخزون – ${b.dataset.branch.nameAr}`,
    titleEn: `Inventory turnover – ${b.dataset.branch.nameEn}`,
    labelAr: 'الشهر', labelEn: 'Month',
    columns: cols,
    rows: b.turnover.map((t) => ({
      ar: MONTHS_AR[t.month - 1], en: MONTHS_EN[t.month - 1], fmt: 'money', fmts: cols.map((c) => c.fmt),
      values: [
        t.days, n(t.opening), n(t.netPurchases), n(t.closing), n(t.average), n(t.cogs), n(t.stockCogs), n(t.difference),
        n(t.turnover), n(t.annualised), n(t.dsi), n(t.skuOpen), n(t.skuClose), n(t.skuDiff), n(t.qtyOpen), n(t.qtyClose),
        n(t.qtyDiff), n(t.salesMinusPurchases), n(t.salesMinusPurchasesPct),
      ],
    })),
    notesAr: ['الدوران = تكلفة المبيعات ÷ متوسط المخزون. أيام المخزون = أيام الشهر ÷ الدوران. «صافي المبيعات − صافي المشتريات» ليس تدفقًا نقديًا.'],
    notesEn: ['Turnover = COGS ÷ average inventory. DSI = days ÷ turnover. "Net sales − net purchases" is not cash flow.'],
  };
}

export function turnoverQuarterTable(b: BranchResult): ReportTable {
  const cols: ReportColumn[] = [
    { key: 'days', ar: 'الأيام', en: 'Days', fmt: 'days' },
    { key: 'open', ar: 'مخزون أول الربع', en: 'Opening', fmt: 'money' },
    { key: 'purch', ar: 'صافي المشتريات', en: 'Net purchases', fmt: 'money' },
    { key: 'close', ar: 'مخزون آخر الربع', en: 'Closing', fmt: 'money' },
    { key: 'avg', ar: 'متوسط المخزون', en: 'Average', fmt: 'money' },
    { key: 'cogs', ar: 'تكلفة المبيعات', en: 'COGS', fmt: 'money' },
    { key: 'turn', ar: 'دوران الربع', en: 'Quarter turnover', fmt: 'num4', emphasis: true },
    { key: 'ann', ar: 'الدوران السنوي', en: 'Annualised', fmt: 'num2' },
    { key: 'dsi', ar: 'أيام المخزون DSI', en: 'DSI', fmt: 'num2' },
    { key: 'smp', ar: 'صافي المبيعات − صافي المشتريات', en: 'Net sales − net purchases', fmt: 'money' },
    { key: 'smpPct', ar: 'النسبة من المبيعات', en: '% of sales', fmt: 'pct' },
  ];
  const names = [['Q1 (يناير–مارس)', 'Q1 (Jan–Mar)'], ['Q2 (أبريل–يونيو)', 'Q2 (Apr–Jun)'], ['Q3 (يوليو–سبتمبر)', 'Q3 (Jul–Sep)'], ['Q4 (أكتوبر–ديسمبر)', 'Q4 (Oct–Dec)']];
  return {
    id: `turnover-q-b${b.branchId}`,
    titleAr: 'دوران المخزون ربع السنوي', titleEn: 'Quarterly inventory turnover',
    labelAr: 'الربع', labelEn: 'Quarter',
    columns: cols,
    rows: b.quarters.map((q) => ({
      ar: names[q.quarter - 1][0], en: names[q.quarter - 1][1], fmt: 'money', fmts: cols.map((c) => c.fmt),
      values: [q.days, n(q.opening), n(q.netPurchases), n(q.closing), n(q.average), n(q.cogs), n(q.turnover), n(q.annualised), n(q.dsi),
        n(q.salesMinusPurchases), n(q.salesMinusPurchasesPct)],
    })),
    notesAr: ['دوران الربع = تكلفة مبيعات الربع ÷ متوسط (مخزون أول شهر، مخزون آخر شهر). يظهر الربع فقط بعد إدخال مخزون آخر شهوره.'],
    notesEn: ['Quarter turnover = quarter COGS ÷ average(opening of first month, closing of last month). Shown once the last month has a closing inventory.'],
  };
}

// ================================================================================================
// Analysis: expenses by category × month, stock adjustments by reason × month
// ================================================================================================

const ytdCols = (R: number): ReportColumn[] => [
  ...monthCols(),
  { key: 'ytd', ar: 'حتى شهر التقرير', en: 'YTD', emphasis: true },
  { key: 'fy', ar: 'السنة', en: 'Full year' },
];
const seriesRow = (ar: string, en: string, xs: Series, R: number, style: RowStyle = 'normal', key?: string): ReportRow => ({
  key, ar, en, fmt: 'money', style, values: [...xs.map(n), n(Y(xs, R)), n(FY(xs))],
});

export function expenseAnalysisTable(b: BranchResult, cats: { key: string; nameAr: string; nameEn: string }[]): ReportTable {
  const R = b.reportMonth;
  const rows = cats.map((c) => seriesRow(c.nameAr, c.nameEn, b.categories[`CAT_${c.key}`], R, 'normal', `CAT_${c.key}`));
  rows.push(seriesRow('إهلاك محسوب من سجل الأصول', 'Depreciation from the asset register', b.categories.CAT_REG, R, 'normal', 'CAT_REG'));
  const total = Array.from({ length: 12 }, (_, i) => sum(Object.values(b.categories).map((s) => s[i])));
  rows.push(seriesRow('الإجمالي', 'Total', total, R, 'total'));
  rows.push(seriesRow('منها: إهلاك مكتوب في الدفتر ومستبعد (يحسب من السجل)', 'Excluded manual depreciation (comes from the register)', b.excludedManualDep, R, 'subtle', 'EXCLUDED_DEP'));
  return {
    id: `expense-analysis-b${b.branchId}`,
    titleAr: 'المصروفات حسب التصنيف', titleEn: 'Expenses by category',
    labelAr: 'التصنيف', labelEn: 'Category', columns: ytdCols(R), rows,
  };
}

export function stockByReasonTable(b: BranchResult, reasons: string[], reasonsEn?: Record<string, string>): ReportTable {
  const R = b.reportMonth;
  const rows = reasons.map((r) => seriesRow(r, reasonsEn?.[r] ?? r, b.expiredByReason[r], R));
  rows.push(seriesRow('الإجمالي', 'Total', b.series.EXPIRED, R, 'total'));
  return {
    id: `stock-reason-b${b.branchId}`,
    titleAr: 'التوالف حسب السبب', titleEn: 'Stock adjustments by reason',
    labelAr: 'السبب', labelEn: 'Reason', columns: ytdCols(R), rows,
  };
}

// ================================================================================================
// Payroll
// ================================================================================================

export function payrollSummaryTable(b: BranchResult): ReportTable {
  const R = b.reportMonth;
  const names: string[] = [];
  for (const st of b.dataset.staff) if (!names.includes(st.payrollName)) names.push(st.payrollName);
  for (const o of b.dataset.owners) if (!names.includes(o.name)) names.push(o.name);
  for (const p of b.payroll) for (const l of p.appLines) if (!names.includes(l.employee)) names.push(l.employee);
  // Lines whose name isn't in the staff list are shown separately (they make check B7b fail).
  const unmatched = [...new Set(b.payroll.flatMap((p) => p.lines.map((l) => l.line.employee)).filter((x) => !names.includes(x)))];
  const per = (name: string) =>
    b.payroll.map((p) => sum([
      ...p.lines.filter((l) => l.line.employee === name).map((l) => l.netPay),
      ...p.appLines.filter((l) => l.employee === name).map((l) => D(l.net)),
      ...p.owners.filter((o) => o.line.name === name).map((o) => o.amount),
    ]));
  const pick = (f: (p: PayrollMonthResult) => Decimal) => b.payroll.map(f);
  const rows: ReportRow[] = names.map((name) => seriesRow(name, name, per(name), R));
  for (const u of unmatched) rows.push({ ...seriesRow(`⚠ ${u}`, `⚠ ${u}`, per(u), R), style: 'subtle' });
  const sheet = pick((p) => p.totals.payroll);
  const legacy = b.legacySalaries;
  rows.push(
    seriesRow('إجمالي كشف المرتبات (الصافي المدفوع)', 'Payroll total (net paid)', sheet, R, 'total'),
    seriesRow('منها: المرتب بالساعات', 'of which: salary by hours', pick((p) => p.totals.salaryByHours), R, 'subtle'),
    seriesRow('منها: العمولات', 'of which: commission', pick((p) => p.totals.commission), R, 'subtle'),
    seriesRow('منها: الإضافات (انتقالات/بونص)', 'of which: additions', pick((p) => p.totals.additions), R, 'subtle'),
    seriesRow('منها: الخصومات (مسحوبات/سلف/جزاءات)', 'of which: deductions', pick((p) => p.totals.deductions.neg()), R, 'subtle'),
    seriesRow('منها: خصم التأخير', 'of which: lateness', pick((p) => p.totals.lateness.neg()), R, 'subtle'),
    seriesRow('منها: مرتبات الملاك', 'of which: owners', pick((p) => p.totals.owners), R, 'subtle'),
    { ...seriesRow('ساعات العمل الفعلية', 'Actual hours', pick((p) => p.totals.actualHours), R), fmt: 'num2' },
    seriesRow('المسجل سابقًا في Yearly Sales (للمطابقة)', 'Legacy recorded salaries (reconciliation)', legacy, R),
    seriesRow('الفرق (الكشف − المسجل)', 'Difference (payroll − legacy)', sheet.map((x, i) => x.minus(legacy[i])), R),
    seriesRow('المرتبات المستخدمة في قائمة الدخل', 'Salaries used in the P&L', b.series.SALARIES, R, 'key'),
  );
  return {
    id: `payroll-summary-b${b.branchId}`,
    titleAr: 'ملخص المرتبات', titleEn: 'Payroll summary',
    labelAr: 'الموظف', labelEn: 'Employee', columns: ytdCols(R), rows,
    notesAr: ['قرار S1: قائمة الدخل تستخدم كشف المرتبات؛ الفرق مع المسجل سابقًا معروض هنا للمطابقة.'],
    notesEn: ['Decision S1: the P&L uses payroll; the difference with the legacy recorded totals is shown here for reconciliation.'],
  };
}

/** App-linked month: the existing app's payroll columns (read-only here) + owners' fixed salaries. */
export function appPayrollMonthTable(b: BranchResult, month: number): ReportTable {
  const p = b.payroll[month - 1];
  const cols: ReportColumn[] = [
    { key: 'role', ar: 'الوظيفة', en: 'Role', fmt: 'text' },
    { key: 'hours', ar: 'الساعات', en: 'Hours', fmt: 'num2' },
    { key: 'salary', ar: 'الراتب', en: 'Salary', fmt: 'money' },
    { key: 'comm', ar: 'العمولة', en: 'Commission', fmt: 'money' },
    { key: 'bon', ar: 'المكافآت', en: 'Bonuses', fmt: 'money' },
    { key: 'pen', ar: 'الجزاءات', en: 'Penalties', fmt: 'money' },
    { key: 'wd', ar: 'المسحوبات', en: 'Withdrawals', fmt: 'money' },
    { key: 'net', ar: 'الصافي', en: 'Net', fmt: 'money', emphasis: true },
  ];
  const fmts = cols.map((c) => c.fmt);
  const rows: ReportRow[] = p.appLines.map((l) => ({
    ar: l.employee, en: l.employee, fmt: 'money', fmts,
    values: [l.role ?? null, l.hours, l.salary, l.commission, l.bonuses, l.penalties, l.withdrawals, l.net],
  }));
  for (const o of p.owners) rows.push({ ar: o.line.name, en: o.line.name, fmt: 'money', fmts, style: 'subtle', values: ['مرتب ثابت (مالك)', null, null, null, null, null, null, n(o.amount)] });
  const S = (f: (l: (typeof p.appLines)[number]) => number) => n(sum(p.appLines.map((l) => D(f(l)))));
  rows.push({ ar: 'إجمالي المرتبات الكلي', en: 'Total payroll', fmt: 'money', fmts, style: 'total',
    values: [null, S((l) => l.hours ?? 0), S((l) => l.salary), S((l) => l.commission), S((l) => l.bonuses), S((l) => l.penalties), S((l) => l.withdrawals), n(p.totals.payroll)] });
  return {
    id: `payroll-app-b${b.branchId}-m${month}`,
    titleAr: `كشف المرتبات (من التطبيق) – ${MONTHS_AR[month - 1]}`, titleEn: `Payroll (from the app) – ${MONTHS_EN[month - 1]}`,
    labelAr: 'اسم الموظف', labelEn: 'Employee', columns: cols, rows,
    notesAr: ['مصدر هذه السطور: صفحة «كشف الرواتب» في التطبيق (الراتب + العمولة + المكافآت − الجزاءات − المسحوبات). تُضاف مرتبات الملاك الثابتة من قسم المالية.'],
    notesEn: ['Source: the app\'s payroll page (salary + commission + bonuses − penalties − withdrawals). Owners\' fixed salaries are added from the finance section.'],
  };
}

export function payrollMonthTable(b: BranchResult, month: number): ReportTable {
  const p = b.payroll[month - 1];
  if (p.source === 'app') return appPayrollMonthTable(b, month);
  const cols: ReportColumn[] = [
    { key: 'role', ar: 'الوظيفة', en: 'Role', fmt: 'text' },
    { key: 'base', ar: 'عدد الساعات الأساسي', en: 'Base hours', fmt: 'num2' },
    { key: 'actual', ar: 'عدد الساعات الفعلي', en: 'Actual hours', fmt: 'num2' },
    { key: 'rate', ar: 'سعر الساعة (×26 ساعة)', en: 'Rate (×26 h)', fmt: 'money' },
    { key: 'salary', ar: 'المرتب (حساب الساعة)', en: 'Salary by hours', fmt: 'money' },
    { key: 'comm', ar: 'العمولة', en: 'Commission', fmt: 'money' },
    { key: 'net', ar: 'إجمالي المرتب (الصافي)', en: 'Total (net)', fmt: 'money', emphasis: true },
    { key: 'ded', ar: 'خصومات (مسحوبات/سلف/جزاءات)', en: 'Deductions', fmt: 'money' },
    { key: 'add', ar: 'إضافات (انتقالات/بونص)', en: 'Additions', fmt: 'money' },
    { key: 'addD', ar: 'تفاصيل الإضافات', en: 'Additions details', fmt: 'text' },
    { key: 'dedD', ar: 'تفاصيل الخصومات', en: 'Deductions details', fmt: 'text' },
    { key: 'dayV', ar: 'قيمة خصم اليوم', en: 'Day value', fmt: 'money0' },
    { key: 'latD', ar: 'أيام خصم التأخير', en: 'Lateness days', fmt: 'num2' },
    { key: 'latA', ar: 'خصم التأخير', en: 'Lateness deduction', fmt: 'money' },
    { key: 'hDiff', ar: 'فرق الساعات (فعلي − أساسي)', en: 'Hours difference', fmt: 'num2' },
  ];
  const fmts = cols.map((c) => c.fmt);
  const rows: ReportRow[] = p.lines.map((l) => ({
    ar: l.line.employee, en: l.line.employee, fmt: 'money', fmts,
    values: [
      l.line.role, l.line.baseHours, l.line.actualHours, l.line.ratePer26h, n(l.salaryByHours), n(l.commission), n(l.netPay),
      l.line.deductions, l.line.additions, l.line.additionsDetails ?? null, l.line.deductionsDetails ?? null, n(l.dayValue),
      n(l.latenessDays), n(l.latenessAmount), n(l.hoursDifference),
    ],
  }));
  for (const o of p.owners) {
    rows.push({ ar: o.line.name, en: o.line.name, fmt: 'money', fmts, style: 'subtle',
      values: ['مرتب ثابت (مالك)', null, null, null, null, null, n(o.amount), null, null, null, null, null, null, null, null] });
  }
  rows.push({
    ar: 'إجمالي المرتبات الكلي', en: 'Total payroll', fmt: 'money', fmts, style: 'total',
    values: [null, null, n(p.totals.actualHours), null, n(p.totals.salaryByHours), n(p.totals.commission), n(p.totals.payroll),
      n(p.totals.deductions), n(p.totals.additions), null, null, null, null, n(p.totals.lateness), null],
  });
  return {
    id: `payroll-b${b.branchId}-m${month}`,
    titleAr: `كشف المرتبات – ${MONTHS_AR[month - 1]}`, titleEn: `Payroll – ${MONTHS_EN[month - 1]}`,
    labelAr: 'اسم الموظف', labelEn: 'Employee', columns: cols, rows,
  };
}

export function commissionTable(b: BranchResult, month: number): ReportTable {
  const p = b.payroll[month - 1];
  const h = p.header;
  const actual = b.series.NET_SALES[month - 1];
  const rows: ReportRow[] = [
    { ar: 'المبيعات الشهرية المستخدمة للعمولة', en: 'Sales for commission', fmt: 'money', values: [h?.salesForCommission ?? null] },
    { ar: 'صافي المبيعات الفعلي (قائمة الدخل)', en: 'Actual net sales (P&L)', fmt: 'money', values: [n(actual)] },
    { ar: 'الفرق', en: 'Difference', fmt: 'money', values: [h?.salesForCommission == null ? null : n(D(h.salesForCommission).minus(actual))] },
    { ar: 'الهدف الأساسي (Target) – لا عمولة أقل من 96% منه', en: 'Target (no commission below 96%)', fmt: 'money', values: [h?.target ?? null] },
    { ar: 'حد عمولة 1%', en: '1% threshold', fmt: 'money', values: [h?.threshold1pct ?? null] },
    { ar: 'حد عمولة 1.5%', en: '1.5% threshold', fmt: 'money', values: [h?.threshold15pct ?? null] },
    { ar: 'حد عمولة 2%', en: '2% threshold', fmt: 'money', values: [h?.threshold2pct ?? null] },
    { ar: 'إجمالي عمولة الفريق', en: 'Team commission', fmt: 'money', style: 'key', values: [n(p.teamCommission)] },
    { ar: 'توزيع العمولات', en: 'Distribution', fmt: 'text', style: 'section', values: [] },
    ...p.shares.map((x) => ({
      ar: `${x.unmatched ? '⚠ ' : ''}${x.share.employee} (${x.share.sharePct === null ? '—' : `${(x.share.sharePct * 100).toFixed(1)}%`})`,
      en: `${x.unmatched ? '⚠ ' : ''}${x.share.employee} (${x.share.sharePct === null ? '—' : `${(x.share.sharePct * 100).toFixed(1)}%`})`,
      fmt: 'money' as Fmt, values: [n(x.amount)],
    })),
    { ar: 'الإجمالي', en: 'Total distributed', fmt: 'money', style: 'total', values: [n(p.sharesTotal)] },
    { ar: 'عمولة غير موزعة (100% − مجموع النسب)', en: 'Undistributed commission', fmt: 'money', values: [n(p.undistributed)] },
    { ar: 'عمولة محسوبة لكن لم تدخل أي راتب (اسم غير مطابق)', en: 'Commission calculated but not paid (unmatched name)', fmt: 'money',
      style: p.calculatedNotPaid.abs().gte('0.01') ? 'key' : 'normal', values: [n(p.calculatedNotPaid)] },
  ];
  return {
    id: `commission-b${b.branchId}-m${month}`,
    titleAr: 'توزيع العمولات', titleEn: 'Commission distribution',
    labelAr: 'البند', labelEn: 'Item', columns: [{ key: 'v', ar: 'القيمة', en: 'Value' }], rows,
  };
}

// ================================================================================================
// Assets, lateness, history
// ================================================================================================

const STATUS: Record<string, [string, string]> = {
  not_started: ['لم يبدأ', 'Not started'], active: ['نشط', 'Active'], ending: ['قارب على الانتهاء', 'Ending'],
  finished: ['منتهي', 'Finished'], incomplete: ['ناقص البيانات', 'Incomplete'],
};
export const assetStatusLabel = (s: string, lang: 'ar' | 'en') => (STATUS[s] ?? [s, s])[lang === 'ar' ? 0 : 1];

export function assetsTable(b: BranchResult, lang: 'ar' | 'en' = 'ar'): ReportTable {
  const cols: ReportColumn[] = [
    { key: 'cost', ar: 'التكلفة', en: 'Cost', fmt: 'money' },
    { key: 'cat', ar: 'الفئة', en: 'Category', fmt: 'text' },
    { key: 'date', ar: 'تاريخ الإضافة', en: 'Date added', fmt: 'text' },
    { key: 'months', ar: 'عدد شهور الإهلاك', en: 'Useful life (m)', fmt: 'int' },
    { key: 'monthly', ar: 'القسط الشهري', en: 'Monthly', fmt: 'money' },
    { key: 'first', ar: 'أول شهر مالي', en: 'First period', fmt: 'int' },
    { key: 'end', ar: 'نهاية الإهلاك', en: 'End date', fmt: 'text' },
    { key: 'acc', ar: 'المتراكم حتى شهر التقرير', en: 'Accumulated', fmt: 'money' },
    { key: 'book', ar: 'القيمة الدفترية', en: 'Book value', fmt: 'money' },
    { key: 'left', ar: 'الشهور المتبقية', en: 'Months left', fmt: 'int' },
    { key: 'status', ar: 'الحالة', en: 'Status', fmt: 'text' },
    ...monthCols().map((c) => ({ ...c, fmt: 'money' as Fmt })),
  ];
  const fmts = cols.map((c) => c.fmt);
  const rows: ReportRow[] = b.assets.map((a) => ({
    ar: a.asset.name, en: a.asset.name, fmt: 'money', fmts,
    values: [a.asset.cost, a.asset.category, a.asset.dateAdded, a.months, n(a.monthly), a.firstPeriod, a.endDate, n(a.accumulated),
      n(a.bookValue), a.monthsLeft, assetStatusLabel(a.status, lang), ...a.charges.map(n)],
  }));
  rows.push({
    ar: 'الإجمالي', en: 'Total', fmt: 'money', fmts, style: 'total',
    values: [n(sum(b.assets.map((a) => D(a.asset.cost)))), null, null, null, null, null, null, n(sum(b.assets.map((a) => a.accumulated))),
      n(sum(b.assets.map((a) => a.bookValue))), null, null, ...b.registerDep.map(n)],
  });
  return {
    id: `assets-b${b.branchId}`, titleAr: 'سجل الأصول والإهلاك', titleEn: 'Asset & depreciation register',
    labelAr: 'الأصل', labelEn: 'Asset', columns: cols, rows,
  };
}

export function latenessTable(b: BranchResult): ReportTable {
  const R = b.reportMonth;
  const cols: ReportColumn[] = [
    { key: 'payroll', ar: 'الاسم في كشف المرتبات', en: 'Payroll name', fmt: 'text' },
    { key: 'role', ar: 'الوظيفة', en: 'Role', fmt: 'text' },
    ...monthCols().map((c) => ({ ...c, fmt: 'num2' as Fmt })),
    { key: 'ytd', ar: 'إجمالي الأيام', en: 'Days YTD', fmt: 'num2', emphasis: true },
    { key: 'rm', ar: 'أيام شهر التقرير', en: 'Report month', fmt: 'num2' },
  ];
  const fmts = cols.map((c) => c.fmt);
  return {
    id: `lateness-b${b.branchId}`, titleAr: 'الموظفون وأيام خصم التأخير', titleEn: 'Staff & lateness days',
    labelAr: 'الاسم في سجل التأخير', labelEn: 'Name (lateness log)', columns: cols,
    rows: b.dataset.staff.map((st) => {
      const days = b.latenessDaysByStaff[st.latenessName] ?? Array(12).fill(0);
      return {
        ar: st.latenessName, en: st.latenessName, fmt: 'num2', fmts,
        values: [st.payrollName, st.role, ...days, days.slice(0, R).reduce((a, x) => a + x, 0), days[R - 1]],
      };
    }),
  };
}

export function historyTable(b: BranchResult, year: number): ReportTable {
  const cols: ReportColumn[] = [
    { key: 'days', ar: 'الأيام', en: 'Days', fmt: 'days' },
    { key: 'gross', ar: 'إجمالي المبيعات', en: 'Gross sales', fmt: 'money' },
    { key: 'ret', ar: 'المرتجعات', en: 'Returns', fmt: 'money' },
    { key: 'net', ar: 'صافي المبيعات', en: 'Net sales', fmt: 'money', emphasis: true },
    { key: 'gp', ar: 'مجمل الربح', en: 'Gross profit', fmt: 'money' },
    { key: 'gpPct', ar: 'نسبة مجمل الربح', en: 'GP %', fmt: 'pct' },
    { key: 'inv', ar: 'عدد الفواتير', en: 'Invoices', fmt: 'int' },
    { key: 'items', ar: 'عدد الأصناف', en: 'Items sold', fmt: 'int' },
    { key: 'pts', ar: 'النقاط', en: 'Points', fmt: 'money' },
    { key: 'purch', ar: 'المشتريات', en: 'Purchases', fmt: 'money' },
    { key: 'pret', ar: 'مرتجع المشتريات', en: 'Purchase returns', fmt: 'money' },
    { key: 'sal', ar: 'المرتبات', en: 'Salaries', fmt: 'money' },
    { key: 'opex', ar: 'مصروفات', en: 'Opex', fmt: 'money' },
    { key: 'maint', ar: 'صيانة', en: 'Maintenance', fmt: 'money' },
  ];
  const fmts = cols.map((c) => c.fmt);
  const hs = Array.from({ length: 12 }, (_, i) => b.dataset.history.find((h) => h.year === year && h.month === i + 1) ?? null);
  const rows: ReportRow[] = hs.map((h, i) => ({
    ar: MONTHS_AR[i], en: MONTHS_EN[i], fmt: 'money', fmts,
    values: h ? [h.days, h.grossSales, h.returns, h.netSales, h.grossProfit, n(div(D(h.grossProfit), DNum(h.netSales))), h.invoices, h.itemsSold,
      h.loyaltyPoints ?? null, h.purchasesGross ?? null, h.purchaseReturns ?? null, h.salaries ?? null, h.opex ?? null, h.maintenance ?? null] : Array(cols.length).fill(null),
  }));
  const tot = (f: (h: NonNullable<(typeof hs)[number]>) => number | null | undefined) => n(sum(hs.filter(Boolean).map((h) => D(f(h!) ?? null))));
  const net = sum(hs.filter(Boolean).map((h) => D(h!.netSales)));
  const gp = sum(hs.filter(Boolean).map((h) => D(h!.grossProfit)));
  rows.push({
    ar: 'الإجمالي', en: 'Total', fmt: 'money', fmts, style: 'total',
    values: [tot((h) => h.days), tot((h) => h.grossSales), tot((h) => h.returns), n(net), n(gp), n(div(gp, net)), tot((h) => h.invoices),
      tot((h) => h.itemsSold), tot((h) => h.loyaltyPoints), tot((h) => h.purchasesGross), tot((h) => h.purchaseReturns), tot((h) => h.salaries),
      tot((h) => h.opex), tot((h) => h.maintenance)],
  });
  return {
    id: `history-b${b.branchId}-${year}`, titleAr: `السجل التاريخي ${year}`, titleEn: `History ${year}`,
    labelAr: 'الشهر', labelEn: 'Month', columns: cols, rows,
  };
}
const DNum = (x: number | null) => (x === null ? null : D(x));

// ================================================================================================
// Dashboard KPIs
// ================================================================================================

export interface Kpi {
  key: string;
  ar: string;
  en: string;
  month: number;
  ytd: number;
  monthPct: number | null; // of net sales
  ytdPct: number | null;
  mom?: number | null;
}

export function dashboardKpis(c: CompanyResult): Kpi[] {
  const R = c.reportMonth;
  const s = c.consolidated;
  const ns = s.NET_SALES;
  const bottom = c.dataset.settings.bottomLine === 'operating_result' ? s.OP_RESULT : s.NET_RESULT;
  const k = (key: string, ar: string, en: string, xs: Series, withPct = true): Kpi => ({
    key, ar, en,
    month: xs[R - 1].toNumber(),
    ytd: Y(xs, R).toNumber(),
    monthPct: withPct ? n(div(xs[R - 1], ns[R - 1])) : null,
    ytdPct: withPct ? n(div(Y(xs, R), Y(ns, R))) : null,
    mom: R > 1 ? n(div(xs[R - 1], xs[R - 2])?.minus(1) ?? null) : null,
  });
  const bottomLabel = c.dataset.settings.bottomLine === 'operating_result'
    ? ['النتيجة التشغيلية', 'Operating result'] : ['صافي النتيجة', 'Net result'];
  return [
    k('NET_SALES', 'صافي المبيعات', 'Net sales', ns, false),
    k('GP', 'مجمل الربح', 'Gross profit', s.GP),
    k('TOTAL_EXP', 'إجمالي المصروفات', 'Total expenses', s.TOTAL_EXP),
    k('NET_RESULT', bottomLabel[0], bottomLabel[1], bottom),
    k('EXPIRED', 'التوالف والإكسبير', 'Expired & damaged', s.EXPIRED),
    k('POINTS', 'النقاط', 'Loyalty points', s.POINTS),
  ];
}

/** YTD expenses by category (consolidated), excluding salaries – for the dashboard bar chart. */
export function ytdExpenseBreakdown(c: CompanyResult): { key: string; ar: string; en: string; value: number }[] {
  const R = c.reportMonth;
  const out = c.dataset.expenseCategories.map((cat) => ({
    key: cat.key, ar: cat.nameAr, en: cat.nameEn, value: Y(c.consolidatedCategories[`CAT_${cat.key}`] ?? [], R).toNumber(),
  }));
  out.push({ key: 'REG', ar: 'إهلاك من سجل الأصول', en: 'Register depreciation', value: Y(c.consolidatedCategories.CAT_REG ?? [], R).toNumber() });
  out.push({ key: 'POINTS', ar: 'النقاط', en: 'Loyalty points', value: Y(c.consolidated.POINTS, R).toNumber() });
  out.push({ key: 'EXPIRED', ar: 'التوالف والإكسبير', en: 'Expired & damaged', value: Y(c.consolidated.EXPIRED, R).toNumber() });
  out.push({ key: 'SHARED', ar: 'مصروفات مشتركة', en: 'Shared', value: Y(c.sharedSeries, R).toNumber() });
  return out.filter((x) => x.value !== 0).sort((a, b) => b.value - a.value);
}

// ================================================================================================
// Consolidated inventory turnover (company level)
// ================================================================================================

const TURN_COLS: ReportColumn[] = [
  { key: 'days', ar: 'الأيام', en: 'Days', fmt: 'days' },
  { key: 'open', ar: 'مخزون أول المدة', en: 'Opening inventory', fmt: 'money' },
  { key: 'purch', ar: 'صافي المشتريات', en: 'Net purchases', fmt: 'money' },
  { key: 'close', ar: 'مخزون آخر المدة', en: 'Closing inventory', fmt: 'money' },
  { key: 'avg', ar: 'متوسط المخزون', en: 'Average inventory', fmt: 'money' },
  { key: 'cogs', ar: 'تكلفة المبيعات', en: 'COGS', fmt: 'money' },
  { key: 'scogs', ar: 'تكلفة المبيعات من المخزون', en: 'Stock-based COGS', fmt: 'money' },
  { key: 'diff', ar: 'الفرق (تسويات/عجز)', en: 'Difference', fmt: 'money' },
  { key: 'turn', ar: 'معدل الدوران', en: 'Turnover', fmt: 'num4', emphasis: true },
  { key: 'ann', ar: 'الدوران السنوي', en: 'Annualised', fmt: 'num2' },
  { key: 'dsi', ar: 'أيام المخزون DSI', en: 'DSI', fmt: 'num2' },
  { key: 'branches', ar: 'الفروع المحسوبة', en: 'Branches included', fmt: 'text' },
];
const branchLabel = (c: CompanyResult, ids: number[], lang: 'ar' | 'en') =>
  ids.length ? ids.map((id) => { const b = c.branches.find((x) => x.branchId === id)!.dataset.branch; return lang === 'ar' ? b.nameAr : b.nameEn; }).join(' + ') : '—';
const turnRow = (c: CompanyResult, ar: string, en: string, r: ReturnType<typeof consolidatedTurnover>['months'][number], style: RowStyle = 'normal'): ReportRow => ({
  ar, en, style, fmt: 'money', fmts: TURN_COLS.map((x) => x.fmt),
  values: [r.days, n(r.opening), n(r.netPurchases), n(r.closing), n(r.average), n(r.cogs), n(r.stockCogs), n(r.difference), n(r.turnover), n(r.annualised), n(r.dsi), branchLabel(c, r.branchIds, 'ar')],
});

export function consolidatedTurnoverTable(c: CompanyResult, lang: 'ar' | 'en' = 'ar'): ReportTable {
  const t = consolidatedTurnover(c);
  return {
    id: 'turnover-consolidated', titleAr: 'دوران المخزون المجمع', titleEn: 'Consolidated inventory turnover',
    labelAr: 'الشهر', labelEn: 'Month', columns: TURN_COLS,
    rows: t.months.map((r, i) => {
      const row = turnRow(c, MONTHS_AR[i], MONTHS_EN[i], r);
      row.values[11] = branchLabel(c, r.branchIds, lang);
      return row;
    }),
    notesAr: [
      'الدوران المجمع = مجموع تكلفة المبيعات ÷ ((مجموع مخزون أول المدة + مجموع مخزون آخر المدة) ÷ 2) — وليس متوسط نسب الفروع.',
      'يدخل الفرع في الحساب فقط في الشهور التي أُدخل له فيها مخزون أول وآخر المدة؛ الفرع بدون مخزون لا يُحسب لا في التكلفة ولا في المخزون.',
      'التحويلات بين الفروع لا تؤثر على الرقم المجمع.',
    ],
    notesEn: [
      'Consolidated turnover = Σ COGS ÷ ((Σ opening + Σ closing) ÷ 2) — not an average of the branch ratios.',
      'A branch is included only in periods where its opening and closing inventory are entered; a branch without inventory is left out of both COGS and inventory.',
      'Transfers between branches do not affect the consolidated figure.',
    ],
  };
}

export function consolidatedTurnoverQuarterTable(c: CompanyResult, lang: 'ar' | 'en' = 'ar'): ReportTable {
  const t = consolidatedTurnover(c);
  const names = [['Q1 (يناير–مارس)', 'Q1 (Jan–Mar)'], ['Q2 (أبريل–يونيو)', 'Q2 (Apr–Jun)'], ['Q3 (يوليو–سبتمبر)', 'Q3 (Jul–Sep)'], ['Q4 (أكتوبر–ديسمبر)', 'Q4 (Oct–Dec)']];
  return {
    id: 'turnover-consolidated-q', titleAr: 'دوران المخزون المجمع ربع السنوي', titleEn: 'Consolidated quarterly turnover',
    labelAr: 'الربع', labelEn: 'Quarter', columns: TURN_COLS,
    rows: t.quarters.map((q) => {
      const row = turnRow(c, names[q.quarter - 1][0], names[q.quarter - 1][1], q);
      row.values[11] = branchLabel(c, q.branchIds, lang);
      return row;
    }),
    notesAr: ['يظهر الربع بعد إدخال مخزون آخر شهوره لفرع واحد على الأقل.'],
    notesEn: ['A quarter appears once at least one branch has the closing inventory of its last month.'],
  };
}

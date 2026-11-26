import { AssetRow, computeAsset } from './assets';
import { D, DN, Decimal, ZERO, div, months12, sum } from './decimal';
import { fiscalCalendar, periodOf, periodOrNull, PeriodRange, parseISODate } from './fiscal';
import { computeLateness, computePayrollMonth, linkedPayrollMonth, LatenessRow, PayrollMonthResult } from './payroll';
import { adjustmentValue } from './rules';
import type {
  BranchDataset, CompanyDataset, Expense, ExpenseCategory, MonthlyInput, PlClass, StockAdjustment,
} from './types';

export type ExpenseWarning = '' | 'no_category' | 'unknown_category' | 'no_date' | 'out_of_year' | 'date_mismatch';

export interface ExpenseRow {
  expense: Expense;
  period: number | null;
  /** Period implied by the date alone (ignores override). */
  datePeriod: number | null;
  plClass: PlClass | null;
  /** false = manual DEP line at/after the register start month (comes from the asset register). */
  inPl: boolean;
  warning: ExpenseWarning;
}

export interface StockRow {
  adjustment: StockAdjustment;
  value: Decimal | null;
  warning: '' | 'unknown_reason' | 'no_period' | 'out_of_year';
}

export type Series = Decimal[]; // 12 months
type NSeries = (Decimal | null)[];

/** Export codes, as in the workbook's Export sheet (and expected_results.json). */
export const EXPORT_CODES = [
  'GROSS_SALES', 'RETURNS', 'NET_SALES', 'COGS', 'GP', 'SALARIES', 'STAFF_OPEX', 'OPEX', 'DEP', 'POINTS',
  'TOTAL_EXP', 'OP_RESULT', 'EXPIRED', 'NET_RESULT', 'INVOICES', 'ITEMS', 'PURCH_NET', 'INV_BEG', 'INV_END',
  'DAYS', 'HAS_SALES', 'HAS_INV', 'NS_PY', 'GP_PY',
] as const;
export type ExportCode = (typeof EXPORT_CODES)[number];

export interface SalesRow {
  month: number;
  hasSales: boolean;
  days: number;
  gross: Decimal | null;
  returns: Decimal | null;
  net: Decimal | null;
  dailyAvg: Decimal | null;
  returnsPct: Decimal | null;
  gp: Decimal | null;
  gpPct: Decimal | null;
  cogs: Decimal | null;
  invoices: Decimal | null;
  avgTicket: Decimal | null;
  unitsPerInvoice: Decimal | null;
  momNet: Decimal | null;
  momGp: Decimal | null;
  netPy: Decimal | null;
  yoy: Decimal | null;
  netPurchases: Decimal | null;
  purchaseReturnsPct: Decimal | null;
  purchasesToSales: Decimal | null;
}

export interface TurnoverRow {
  month: number;
  days: number;
  opening: Decimal | null;
  netPurchases: Decimal | null;
  closing: Decimal | null;
  average: Decimal | null;
  cogs: Decimal | null;
  stockCogs: Decimal | null;
  difference: Decimal | null;
  turnover: Decimal | null;
  annualised: Decimal | null;
  dsi: Decimal | null;
  skuOpen: Decimal | null;
  skuClose: Decimal | null;
  skuDiff: Decimal | null;
  qtyOpen: Decimal | null;
  qtyClose: Decimal | null;
  qtyDiff: Decimal | null;
  salesMinusPurchases: Decimal | null;
  salesMinusPurchasesPct: Decimal | null;
}

export interface QuarterRow {
  quarter: number;
  months: [number, number, number];
  days: number;
  available: boolean;
  opening: Decimal | null;
  netPurchases: Decimal | null;
  closing: Decimal | null;
  average: Decimal | null;
  cogs: Decimal | null;
  turnover: Decimal | null;
  annualised: Decimal | null;
  dsi: Decimal | null;
  salesMinusPurchases: Decimal | null;
  salesMinusPurchasesPct: Decimal | null;
}

export interface BranchResult {
  branchId: number;
  dataset: BranchDataset;
  calendar: PeriodRange[];
  reportMonth: number;
  monthly: (MonthlyInput | null)[];
  expenses: ExpenseRow[];
  stock: StockRow[];
  assets: AssetRow[];
  lateness: LatenessRow[];
  payroll: PayrollMonthResult[];
  /** Export codes → 12 monthly values. */
  series: Record<ExportCode, Series>;
  /** CAT_<KEY> → 12 monthly included amounts; plus CAT_REG (register, from start month). */
  categories: Record<string, Series>;
  /** Manual DEP lines excluded because the asset register is used. */
  excludedManualDep: Series;
  /** Register charge per month regardless of start month. */
  registerDep: Series;
  expiredByReason: Record<string, Series>;
  payrollTotal: Series;
  legacySalaries: Series;
  latenessDaysByStaff: Record<string, number[]>;
  sales: SalesRow[];
  salesYtd: SalesRow;
  salesFullYear: SalesRow;
  turnover: TurnoverRow[];
  quarters: QuarterRow[];
  turnoverMonthly: (Decimal | null)[];
}

const ymdOK = (s: string | null) => parseISODate(s) !== null;

export function classify(categoryKey: string | null, cats: ExpenseCategory[]): PlClass | null {
  if (!categoryKey) return null;
  return cats.find((c) => c.key === categoryKey)?.plClass ?? null;
}

export function computeExpenseRows(
  expenses: Expense[], cats: ExpenseCategory[], year: number, startDay: number, depFrom: number,
): ExpenseRow[] {
  return expenses.map((expense) => {
    const datePeriod = ymdOK(expense.date) ? periodOf(expense.date!, year, startDay) : null;
    const period = expense.periodOverride ?? datePeriod;
    const plClass = classify(expense.categoryKey, cats);
    const inPl = !(plClass === 'DEP' && period !== null && period >= depFrom);
    let warning: ExpenseWarning = '';
    if (!expense.categoryKey) warning = 'no_category';
    else if (!plClass) warning = 'unknown_category';
    else if (period === null) warning = 'no_date';
    else if (period < 1 || period > 12) warning = 'out_of_year';
    else if (datePeriod !== null && expense.periodOverride !== null && expense.periodOverride !== datePeriod) warning = 'date_mismatch';
    return { expense, period, datePeriod, plClass, inPl, warning };
  });
}

const inYear = (p: number | null): p is number => p !== null && p >= 1 && p <= 12;

export function computeBranch(ds: BranchDataset, company: CompanyDataset): BranchResult {
  const s = company.settings;
  const R = s.reportMonth;
  const depFrom = ds.branch.depreciationRegisterFromMonth;
  const calendar = fiscalCalendar(s.year, s.startDay);
  const monthly = months12((m) => ds.monthly.find((x) => x.month === m) ?? null);

  // ---- Expenses ---------------------------------------------------------------------------
  const expenses = computeExpenseRows(ds.expenses, company.expenseCategories, s.year, s.startDay, depFrom);
  const categories: Record<string, Series> = {};
  for (const c of company.expenseCategories) {
    categories[`CAT_${c.key}`] = months12((m) =>
      sum(expenses.filter((e) => e.inPl && e.period === m && e.expense.categoryKey === c.key).map((e) => D(e.expense.amount))),
    );
  }
  const excludedManualDep = months12((m) =>
    sum(expenses.filter((e) => !e.inPl && e.period === m).map((e) => D(e.expense.amount))),
  );
  const classTotal = (cls: PlClass) =>
    months12((m) => sum(company.expenseCategories.filter((c) => c.plClass === cls).map((c) => categories[`CAT_${c.key}`][m - 1])));

  // ---- Asset register ---------------------------------------------------------------------
  const assets = ds.assets.map((a) => computeAsset(a, company.assetCategories, s));
  const registerDep = months12((m) => sum(assets.map((a) => a.charges[m - 1])));
  categories.CAT_REG = months12((m) => (m >= depFrom ? registerDep[m - 1] : ZERO));

  // ---- Stock adjustments ------------------------------------------------------------------
  const stock: StockRow[] = ds.stockAdjustments.map((adjustment) => ({
    adjustment,
    value: adjustmentValue(adjustment),
    warning:
      adjustment.month === null ? 'no_period'
      : !inYear(adjustment.month) ? 'out_of_year'
      : !adjustment.reason || !company.adjustmentReasons.includes(adjustment.reason) ? 'unknown_reason'
      : '',
  }));
  const expired = months12((m) => sum(stock.filter((x) => x.adjustment.month === m).map((x) => x.value)));
  const expiredByReason: Record<string, Series> = {};
  for (const reason of company.adjustmentReasons) {
    expiredByReason[reason] = months12((m) =>
      sum(stock.filter((x) => x.adjustment.month === m && x.adjustment.reason === reason).map((x) => x.value)),
    );
  }

  // ---- Lateness & payroll -----------------------------------------------------------------
  const lateness = computeLateness(ds.lateness, ds.staff, s);
  const link = ds.linkedPayroll ?? null;
  const payroll = months12((m) =>
    link && m >= link.fromMonth
      ? linkedPayrollMonth(m, link.months.find((x) => x.month === m) ?? null, ds.owners.filter((o) => o.month === m))
      : computePayrollMonth({
      month: m,
      header: ds.payrollMonths.find((h) => h.month === m) ?? null,
      lines: ds.payrollLines.filter((l) => l.month === m),
      owners: ds.owners.filter((o) => o.month === m),
      shares: ds.commissionShares.filter((x) => x.month === m),
      staff: ds.staff.filter((st) => !st.months || st.months.includes(m)),
      lateness,
      settings: s,
    }),
  );
  const payrollTotal = payroll.map((p) => p.totals.payroll);
  const legacySalaries = monthly.map((x) => D(x?.salariesRecordedLegacy));
  // Workbook rule (Salaries!B59): payroll total if non-zero, else the legacy recorded salaries.
  const salaries = months12((m) => (!payrollTotal[m - 1].isZero() ? payrollTotal[m - 1] : legacySalaries[m - 1]));

  const latenessDaysByStaff: Record<string, number[]> = {};
  for (const st of ds.staff) {
    latenessDaysByStaff[st.latenessName] = months12((m) =>
      sum(lateness.filter((r) => r.period === m && r.entry.employee === st.latenessName).map((r) => D(r.days))).toNumber(),
    );
  }

  // ---- P&L --------------------------------------------------------------------------------
  const v = (f: (x: MonthlyInput) => number | null) => monthly.map((x) => (x ? D(f(x)) : ZERO));
  const gross = v((x) => x.grossSales);
  const returns = v((x) => x.returns);
  const net = months12((m) => gross[m - 1].minus(returns[m - 1]));
  const gp = v((x) => x.grossProfit);
  const cogs = months12((m) => net[m - 1].minus(gp[m - 1]));
  const staffOpex = classTotal('STAFF');
  const opex = classTotal('OPEX');
  const dep = months12((m) => classTotal('DEP')[m - 1].plus(categories.CAT_REG[m - 1]));
  const points = v((x) => x.loyaltyPoints);
  const totalExp = months12((m) =>
    sum([salaries[m - 1], staffOpex[m - 1], opex[m - 1], dep[m - 1], points[m - 1]]),
  );
  const opResult = months12((m) => gp[m - 1].minus(totalExp[m - 1]));
  const netResult = months12((m) => opResult[m - 1].minus(expired[m - 1]));
  const hasSales = monthly.map((x) => x !== null && x.grossSales !== null);
  const hasInv = monthly.map((x) => x !== null && x.inventoryEndValue !== null);
  const netPurch = monthly.map((x) => (x ? D(x.purchasesGross).minus(D(x.purchaseReturns)) : ZERO));
  const invEnd = v((x) => x.inventoryEndValue);
  const invBeg = months12((m) => (m === 1 ? D(ds.opening?.inventoryValue) : invEnd[m - 2]));
  const py = (m: number) => ds.history.find((h) => h.year === s.year - 1 && h.month === m) ?? null;

  const series: Record<ExportCode, Series> = {
    GROSS_SALES: gross, RETURNS: returns, NET_SALES: net, COGS: cogs, GP: gp, SALARIES: salaries,
    STAFF_OPEX: staffOpex, OPEX: opex, DEP: dep, POINTS: points, TOTAL_EXP: totalExp, OP_RESULT: opResult,
    EXPIRED: expired, NET_RESULT: netResult,
    INVOICES: v((x) => x.invoices), ITEMS: v((x) => x.itemsSold), PURCH_NET: netPurch,
    INV_BEG: invBeg, INV_END: invEnd,
    DAYS: calendar.map((c) => D(c.days)),
    HAS_SALES: hasSales.map((h) => D(h ? 1 : 0)), HAS_INV: hasInv.map((h) => D(h ? 1 : 0)),
    NS_PY: months12((m) => D(py(m)?.netSales)), GP_PY: months12((m) => D(py(m)?.grossProfit)),
  };

  // ---- Sales analysis (§4.9) ----------------------------------------------------------------
  const sales: SalesRow[] = months12((m) => {
    const x = monthly[m - 1];
    const has = hasSales[m - 1];
    const days = calendar[m - 1].days;
    const n = has ? net[m - 1] : null;
    const prevHas = m > 1 && hasSales[m - 2];
    const nPy = DN(py(m)?.netSales ?? null);
    const purchases = x && x.purchasesGross !== null ? D(x.purchasesGross).minus(D(x.purchaseReturns)) : null;
    return {
      month: m, hasSales: has, days,
      gross: has ? gross[m - 1] : null,
      returns: has ? returns[m - 1] : null,
      net: n,
      dailyAvg: has ? net[m - 1].div(days) : null,
      returnsPct: has ? div(returns[m - 1], gross[m - 1]) : null,
      gp: has ? gp[m - 1] : null,
      gpPct: has ? div(gp[m - 1], net[m - 1]) : null,
      cogs: has ? cogs[m - 1] : null,
      invoices: has ? D(x!.invoices) : null,
      avgTicket: has ? div(net[m - 1], D(x!.invoices)) : null,
      unitsPerInvoice: has ? div(D(x!.itemsSold), D(x!.invoices)) : null,
      momNet: has && prevHas ? div(net[m - 1], net[m - 2])?.minus(1) ?? null : null,
      momGp: has && prevHas ? div(gp[m - 1], gp[m - 2])?.minus(1) ?? null : null,
      netPy: nPy,
      yoy: has && nPy !== null ? div(net[m - 1], nPy)?.minus(1) ?? null : null,
      netPurchases: purchases,
      purchaseReturnsPct: x && x.purchasesGross !== null ? div(D(x.purchaseReturns), D(x.purchasesGross)) : null,
      purchasesToSales: has && purchases !== null ? div(purchases, net[m - 1]) : null,
    };
  });
  const salesTotal = (upTo: number): SalesRow => {
    const rows = sales.filter((r) => r.hasSales && r.month <= upTo);
    const xs = rows.map((r) => monthly[r.month - 1]!);
    const S = (f: (r: SalesRow) => Decimal | null) => sum(rows.map(f));
    const days = rows.reduce((a, r) => a + r.days, 0);
    const g = S((r) => r.gross), rt = S((r) => r.returns), n = S((r) => r.net), p = S((r) => r.gp);
    const inv = S((r) => r.invoices);
    const nPy = S((r) => r.netPy);
    const purch = S((r) => r.netPurchases);
    const purchGross = sum(xs.map((x) => D(x.purchasesGross)));
    const purchRet = sum(xs.map((x) => D(x.purchaseReturns)));
    return {
      month: upTo, hasSales: rows.length > 0, days,
      gross: g, returns: rt, net: n, dailyAvg: days ? n.div(days) : null, returnsPct: div(rt, g),
      gp: p, gpPct: div(p, n), cogs: S((r) => r.cogs), invoices: inv, avgTicket: div(n, inv),
      unitsPerInvoice: div(sum(xs.map((x) => D(x.itemsSold))), inv),
      momNet: null, momGp: null,
      netPy: nPy, yoy: nPy.isZero() ? null : n.div(nPy).minus(1),
      netPurchases: purch, purchaseReturnsPct: div(purchRet, purchGross), purchasesToSales: div(purch, n),
    };
  };

  // ---- Inventory turnover (§4.10) -----------------------------------------------------------
  const turnover: TurnoverRow[] = months12((m) => {
    const x = monthly[m - 1];
    const prev = m > 1 ? monthly[m - 2] : null;
    const opening = m === 1 ? DN(ds.opening?.inventoryValue ?? null) : DN(prev?.inventoryEndValue ?? null);
    const closing = DN(x?.inventoryEndValue ?? null);
    const purchases = x && x.purchasesGross !== null ? D(x.purchasesGross).minus(D(x.purchaseReturns)) : null;
    const average = opening !== null && closing !== null ? opening.plus(closing).div(2) : null;
    const c = hasSales[m - 1] ? cogs[m - 1] : null;
    const stockCogs = opening !== null && purchases !== null && closing !== null ? opening.plus(purchases).minus(closing) : null;
    const t = average !== null && c !== null ? div(c, average) : null;
    const days = calendar[m - 1].days;
    const skuOpen = m === 1 ? DN(ds.opening?.skuCount ?? null) : DN(prev?.skuEnd ?? null);
    const skuClose = DN(x?.skuEnd ?? null);
    const qtyOpen = m === 1 ? DN(ds.opening?.inventoryQty ?? null) : DN(prev?.inventoryEndQty ?? null);
    const qtyClose = DN(x?.inventoryEndQty ?? null);
    const smp = hasSales[m - 1] && purchases !== null ? net[m - 1].minus(purchases) : null;
    return {
      month: m, days, opening, netPurchases: purchases, closing, average, cogs: c, stockCogs,
      difference: stockCogs !== null && c !== null ? stockCogs.minus(c) : null,
      turnover: t,
      annualised: t !== null ? t.times(365).div(days) : null,
      dsi: t !== null ? div(D(days), t) : null,
      skuOpen, skuClose, skuDiff: skuOpen !== null && skuClose !== null ? skuClose.minus(skuOpen) : null,
      qtyOpen, qtyClose, qtyDiff: qtyOpen !== null && qtyClose !== null ? qtyClose.minus(qtyOpen) : null,
      salesMinusPurchases: smp,
      salesMinusPurchasesPct: smp !== null ? div(smp, net[m - 1]) : null,
    };
  });
  const quarters: QuarterRow[] = [1, 2, 3, 4].map((q) => {
    const ms: [number, number, number] = [q * 3 - 2, q * 3 - 1, q * 3];
    const rows = ms.map((m) => turnover[m - 1]);
    const days = rows.reduce((a, r) => a + r.days, 0);
    const available = rows[2].closing !== null;
    if (!available) {
      return {
        quarter: q, months: ms, days, available, opening: null, netPurchases: null, closing: null, average: null,
        cogs: null, turnover: null, annualised: null, dsi: null, salesMinusPurchases: null, salesMinusPurchasesPct: null,
      };
    }
    const opening = rows[0].opening;
    const closing = rows[2].closing;
    const average = opening !== null && closing !== null ? opening.plus(closing).div(2) : null;
    const c = sum(rows.map((r) => r.cogs));
    const t = div(c, average);
    const smp = sum(rows.map((r) => r.salesMinusPurchases));
    return {
      quarter: q, months: ms, days, available, opening, netPurchases: sum(rows.map((r) => r.netPurchases)), closing, average,
      cogs: c, turnover: t, annualised: t ? t.times(365).div(days) : null, dsi: t ? div(D(days), t) : null,
      salesMinusPurchases: smp, salesMinusPurchasesPct: div(smp, sum(ms.map((m) => net[m - 1]))),
    };
  });

  return {
    branchId: ds.branch.id, dataset: ds, calendar, reportMonth: R, monthly, expenses, stock, assets, lateness, payroll,
    series, categories, excludedManualDep, registerDep, expiredByReason, payrollTotal, legacySalaries,
    latenessDaysByStaff, sales, salesYtd: salesTotal(R), salesFullYear: salesTotal(12), turnover, quarters,
    turnoverMonthly: turnover.map((t) => t.turnover),
  };
}

// ---- Column helpers used by all reports ---------------------------------------------------------

/** YTD = Σ months ≤ report month. */
export const ytd = (xs: Series, R: number): Decimal => sum(xs.slice(0, R));
export const fullYear = (xs: Series): Decimal => sum(xs);
export const atMonth = (xs: Series, R: number): Decimal => xs[R - 1];
export { periodOrNull };

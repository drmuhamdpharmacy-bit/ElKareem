import type { BranchResult } from './branch';
import type { CompanyResult } from './company';
import { D, Decimal, sum } from './decimal';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  scope: string; // 'branch:1' | 'company'
  labelAr: string;
  labelEn: string;
  a: number | null;
  b: number | null;
  diff: number | null;
  status: CheckStatus;
  detailAr?: string;
  detailEn?: string;
}

const TOL = new Decimal('0.01');

function eq(id: string, scope: string, labelAr: string, labelEn: string, a: Decimal, b: Decimal): CheckResult {
  const diff = a.minus(b);
  return { id, scope, labelAr, labelEn, a: a.toNumber(), b: b.toNumber(), diff: diff.toNumber(), status: diff.abs().lt(TOL) ? 'ok' : 'fail' };
}

function count(id: string, scope: string, labelAr: string, labelEn: string, n: number, failing: CheckStatus = 'fail'): CheckResult {
  return { id, scope, labelAr, labelEn, a: n, b: 0, diff: n, status: n === 0 ? 'ok' : failing };
}

export function branchChecks(r: BranchResult, reasons: string[]): CheckResult[] {
  const scope = `branch:${r.branchId}`;
  const s = r.series;
  const FY = (xs: Decimal[]) => sum(xs);
  const depFrom = r.dataset.branch.depreciationRegisterFromMonth;
  const included = sum(r.expenses.filter((e) => e.inPl && e.period !== null && e.period >= 1 && e.period <= 12).map((e) => D(e.expense.amount)));
  const excluded = sum(r.expenses.filter((e) => !e.inPl).map((e) => D(e.expense.amount)));
  const ledgerTotal = sum(r.expenses.map((e) => D(e.expense.amount)));
  const registerUsed = sum(r.registerDep.filter((_, i) => i + 1 >= depFrom));
  const plExp = FY(s.STAFF_OPEX).plus(FY(s.OPEX)).plus(FY(s.DEP));
  const stockLedger = sum(r.stock.map((x) => x.value));
  const byReason = sum(reasons.map((k) => FY(r.expiredByReason[k] ?? [])));
  const inputsNet = sum(r.monthly.map((x) => (x ? D(x.grossSales).minus(D(x.returns)) : D(0))));
  const turnoverCogs = sum(r.turnover.map((t) => t.cogs));
  const notPaid = sum(r.payroll.map((p) => p.calculatedNotPaid));
  const review = r.expenses.filter((e) => e.warning !== '').length;
  const noCategory = r.expenses.filter((e) => !e.expense.categoryKey || e.plClass === null).length;
  const assetsIncomplete = r.assets.filter((a) => a.firstPeriod === null || a.months === null).length;
  const unknownLateness = r.lateness.filter((l) => l.warning === 'unknown_employee').length;
  const catSum = sum(Object.values(r.categories).map(FY));

  // Payroll summary: employee rows are the staff payroll names + owner names (as in the workbook's Salaries sheet).
  const known = new Set([...r.dataset.staff.map((x) => x.payrollName), ...r.dataset.owners.map((o) => o.name)]);
  const summaryEmployees = sum(
    r.payroll.flatMap((p) => [
      ...p.lines.filter((l) => known.has(l.line.employee)).map((l) => l.netPay),
      ...p.owners.filter((o) => known.has(o.line.name)).map((o) => o.amount),
      // Months linked to the app: its employee list is the source of truth.
      ...p.appLines.map((l) => D(l.net)),
    ]),
  );
  const payrollSheets = sum(r.payroll.map((p) => p.totals.payroll));
  const summarySalaries = sum(r.payroll.map((p, i) => (!p.totals.payroll.isZero() ? p.totals.payroll : r.legacySalaries[i])));
  const fyDays = r.calendar.reduce((a, c) => a + c.days, 0);
  const fy = Number(r.calendar[11].to.slice(0, 4));
  const expectedDays = (fy % 4 === 0 && fy % 100 !== 0) || fy % 400 === 0 ? 366 : 365;

  const checks: CheckResult[] = [
    eq('B1', scope, 'الدفتر (البنود الداخلة) + إهلاك السجل = مصروفات قائمة الدخل (العاملين+التشغيل+الإهلاك)',
      'Included expense lines + register depreciation = P&L staff + opex + depreciation', included.plus(registerUsed), plExp),
    eq('B2', scope, 'إجمالي الدفتر = البنود الداخلة + الإهلاك المستبعد (لا يوجد بند ضائع)',
      'Expense ledger total = included lines + excluded manual depreciation', ledgerTotal, included.plus(excluded)),
    eq('B3a', scope, 'سجل التوالف = سطر التوالف في قائمة الدخل', 'Stock-adjustment ledger = P&L expired line', stockLedger, FY(s.EXPIRED)),
    eq('B3b', scope, 'تحليل التوالف حسب السبب = إجمالي السجل', 'Expired by reason = stock-adjustment ledger', byReason, stockLedger),
    eq('B4a', scope, 'صافي المبيعات (قائمة الدخل) = إجمالي − مرتجعات (المدخلات)', 'Net sales: P&L = inputs', FY(s.NET_SALES), inputsNet),
    eq('B4b', scope, 'صافي المبيعات (تحليل المبيعات) = قائمة الدخل', 'Net sales: sales analysis = P&L', D(r.salesFullYear.net), FY(s.NET_SALES)),
    eq('B5', scope, 'تكلفة المبيعات في الدوران = قائمة الدخل', 'Turnover COGS = P&L COGS', turnoverCogs, FY(s.COGS)),
    eq('B6a', scope, 'مجموع الشهور = عمود السنة (صافي النتيجة)', 'Sum of months = full-year column (net result)',
      s.NET_RESULT.reduce((a, x) => a.plus(x), D(0)), FY(s.NET_RESULT)),
    eq('B6b', scope, 'مجموع التصنيفات = مصروفات العاملين+التشغيل+الإهلاك', 'Σ categories = staff + opex + depreciation', catSum, plExp),
    eq('B7a', scope, 'المرتبات في قائمة الدخل = ملخص المرتبات', 'P&L salaries = payroll summary', FY(s.SALARIES), summarySalaries),
    eq('B7b', scope, 'مجموع الموظفين في الملخص = إجمالي كشوف المرتبات (لا يوجد اسم ناقص)',
      'Σ employees in summary = payroll totals (no unmatched names)', summaryEmployees, payrollSheets),
    {
      id: 'B8', scope,
      labelAr: 'عمولات محسوبة ولم تدخل أي راتب (السنة)', labelEn: 'Commission calculated but not paid (year)',
      a: notPaid.toNumber(), b: 0, diff: notPaid.toNumber(),
      status: notPaid.abs().lt(TOL) ? 'ok' : 'warn',
      detailAr: r.payroll.filter((p) => !p.calculatedNotPaid.abs().lt(TOL)).map((p) => `شهر ${p.month}: ${p.calculatedNotPaid.toFixed(2)}`).join(' · '),
      detailEn: r.payroll.filter((p) => !p.calculatedNotPaid.abs().lt(TOL)).map((p) => `month ${p.month}: ${p.calculatedNotPaid.toFixed(2)}`).join(' · '),
    },
    count('B9', scope, 'بنود دفتر المصروفات التي تحتاج مراجعة (عدد)', 'Expense lines needing review (count)', review, 'warn'),
    count('B10a', scope, 'بنود بدون تصنيف (عدد)', 'Expense lines without a category (count)', noCategory),
    count('B10b', scope, 'أصول بدون تاريخ أو مدة (عدد)', 'Assets without a date or useful life (count)', assetsIncomplete),
    count('B10c', scope, 'سطور تأخير لموظفين غير موجودين بالقائمة (عدد)', 'Lateness names not in the staff list (count)', unknownLateness),
    eq('B11', scope, `أيام السنة المالية = ${expectedDays}`, `Fiscal-year days = ${expectedDays}`, D(fyDays), D(expectedDays)),
  ];
  return checks;
}

export function companyChecks(c: CompanyResult): CheckResult[] {
  const R = c.reportMonth;
  const scope = 'company';
  const FY = (xs: Decimal[]) => sum(xs);
  const Y = (xs: Decimal[]) => sum(xs.slice(0, R));
  const branchSum = (code: 'NET_SALES' | 'NET_RESULT', f: (xs: Decimal[]) => Decimal) => sum(c.branches.map((b) => f(b.series[code])));
  const sharedFY = FY(c.sharedSeries);
  const sharedY = Y(c.sharedSeries);
  const plYtdExpenses = Y(c.consolidated.SALARIES).plus(Y(c.consolidated.STAFF_OPEX)).plus(Y(c.consolidated.OPEX))
    .plus(Y(c.consolidated.DEP)).plus(Y(c.consolidated.POINTS)).plus(Y(c.consolidated.EXPIRED)).plus(sharedY);
  const breakdown = Y(c.consolidated.SALARIES).plus(sum(Object.values(c.consolidatedCategories).map(Y)))
    .plus(Y(c.consolidated.POINTS)).plus(Y(c.consolidated.EXPIRED)).plus(sharedY);
  const sharedBad = c.shared.filter((r) => r.warning === 'no_date' || r.warning === 'out_of_year').length;
  return [
    eq('C1', scope, 'صافي المبيعات المجمع (السنة) = الفرع 1 + الفرع 2', 'Consolidated net sales (year) = Σ branches',
      FY(c.consolidated.NET_SALES), branchSum('NET_SALES', FY)),
    eq('C2', scope, 'صافي النتيجة المجمعة (السنة) = الفروع − المشترك', 'Consolidated net result (year) = Σ branches − shared',
      FY(c.consolidated.NET_RESULT), branchSum('NET_RESULT', FY).minus(sharedFY)),
    eq('C3', scope, 'YTD: المجمع = مجموع الأعمدة (صافي النتيجة)', 'YTD consolidated = Σ columns (net result)',
      Y(c.consolidated.NET_RESULT), branchSum('NET_RESULT', Y).minus(sharedY)),
    eq('C4', scope, 'YTD المجمع = مجموع الشهور حتى شهر التقرير', 'YTD = Σ months up to the report month',
      Y(c.consolidated.NET_RESULT), c.consolidated.NET_RESULT.slice(0, R).reduce((a, x) => a.plus(x), D(0))),
    eq('C5', scope, 'شهر التقرير: المجمع = الجدول الشهري', 'Report month = monthly table',
      sum(c.branches.map((b) => b.series.NET_RESULT[R - 1])).minus(c.sharedSeries[R - 1]), c.consolidated.NET_RESULT[R - 1]),
    eq('C6', scope, 'تحليل المصروفات حسب التصنيف = مصروفات قائمة الدخل (YTD)', 'Category breakdown = P&L expense lines (YTD)',
      breakdown, plYtdExpenses),
    count('C7', scope, 'المصروفات المشتركة: كل السطور لها شهر داخل السنة', 'Shared expenses: every line has a period in the year', sharedBad),
  ];
}

export interface ChecksSummary {
  checks: CheckResult[];
  overall: CheckStatus; // 'ok' unless any fail (warnings don't block)
  fails: number;
  warnings: number;
}

export function allChecks(c: CompanyResult): ChecksSummary {
  const checks = [...c.branches.flatMap((b) => branchChecks(b, c.dataset.adjustmentReasons)), ...companyChecks(c)];
  const fails = checks.filter((x) => x.status === 'fail').length;
  const warnings = checks.filter((x) => x.status === 'warn').length;
  return { checks, overall: fails ? 'fail' : 'ok', fails, warnings };
}

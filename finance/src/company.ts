import { BranchResult, computeBranch, EXPORT_CODES, ExportCode, Series } from './branch';
import { D, Decimal, ZERO, div, months12, sum } from './decimal';
import { periodOf, parseISODate } from './fiscal';
import type { CompanyDataset, SharedExpense } from './types';

export interface SharedRow {
  expense: SharedExpense;
  period: number | null;
  warning: '' | 'no_date' | 'out_of_year' | 'date_mismatch';
}

/** Codes that are summed across branches. Ratios/flags are recomputed, never summed. */
const ADDITIVE: ExportCode[] = EXPORT_CODES.filter((c) => !['DAYS', 'HAS_SALES', 'HAS_INV'].includes(c));

export interface CompanyResult {
  dataset: CompanyDataset;
  branches: BranchResult[];
  shared: SharedRow[];
  sharedSeries: Series;
  /** Branch sum + shared column (TOTAL_EXP += shared, OP_RESULT / NET_RESULT −= shared). */
  consolidated: Record<ExportCode, Series>;
  /** Per category key (CAT_*) consolidated across branches. */
  consolidatedCategories: Record<string, Series>;
  reportMonth: number;
}

export function computeSharedRows(rows: SharedExpense[], year: number, startDay: number): SharedRow[] {
  return rows.map((expense) => {
    const datePeriod = parseISODate(expense.date) ? periodOf(expense.date!, year, startDay) : null;
    const period = expense.periodOverride ?? datePeriod;
    return {
      expense,
      period,
      warning:
        period === null ? 'no_date'
        : period < 1 || period > 12 ? 'out_of_year'
        : datePeriod !== null && expense.periodOverride !== null && datePeriod !== expense.periodOverride ? 'date_mismatch'
        : '',
    };
  });
}

export function computeCompany(company: CompanyDataset): CompanyResult {
  const s = company.settings;
  const branches = company.branches.map((b) => computeBranch(b, company));
  const shared = computeSharedRows(company.sharedExpenses, s.year, s.startDay);
  const sharedSeries = months12((m) => sum(shared.filter((r) => r.period === m).map((r) => D(r.expense.amount))));

  const consolidated = {} as Record<ExportCode, Series>;
  for (const code of EXPORT_CODES) {
    if (ADDITIVE.includes(code)) {
      consolidated[code] = months12((m) => sum(branches.map((b) => b.series[code][m - 1])));
    } else if (code === 'DAYS') {
      consolidated[code] = branches[0]?.series.DAYS ?? months12(() => ZERO);
    } else {
      consolidated[code] = months12((m) => (branches.some((b) => !b.series[code][m - 1].isZero()) ? D(1) : ZERO));
    }
  }
  consolidated.TOTAL_EXP = consolidated.TOTAL_EXP.map((x, i) => x.plus(sharedSeries[i]));
  consolidated.OP_RESULT = consolidated.OP_RESULT.map((x, i) => x.minus(sharedSeries[i]));
  consolidated.NET_RESULT = consolidated.NET_RESULT.map((x, i) => x.minus(sharedSeries[i]));

  const consolidatedCategories: Record<string, Series> = {};
  const keys = new Set(branches.flatMap((b) => Object.keys(b.categories)));
  for (const k of keys) consolidatedCategories[k] = months12((m) => sum(branches.map((b) => b.categories[k]?.[m - 1] ?? ZERO)));

  return { dataset: company, branches, shared, sharedSeries, consolidated, consolidatedCategories, reportMonth: s.reportMonth };
}

/**
 * Optional allocation of shared expenses by share of net sales (D7: simulation only – never posted).
 */
export function simulateSharedAllocation(r: CompanyResult, upToMonth = r.reportMonth) {
  const sharedTotal = sum(r.sharedSeries.slice(0, upToMonth));
  const sales = r.branches.map((b) => sum(b.series.NET_SALES.slice(0, upToMonth)));
  const total = sum(sales);
  return r.branches.map((b, i) => {
    const share = div(sales[i], total) ?? ZERO;
    return { branchId: b.branchId, netSales: sales[i], share, allocated: sharedTotal.times(share) };
  });
}

export type { Decimal };

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

// ---------------------------------------------------------------- consolidated inventory turnover
export interface ConsolidatedTurnoverRow {
  month: number;
  days: number;
  /** Branch ids whose inventory is complete for the period (opening AND closing entered). */
  branchIds: number[];
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
}

/**
 * Company-wide turnover = Σ COGS ÷ ((Σ opening + Σ closing) ÷ 2) over the branches that have a complete
 * inventory for the period — never an average of the branch ratios. A branch without opening/closing
 * inventory (e.g. a new branch) is left out of BOTH the COGS and the inventory, so it cannot distort the ratio.
 */
export function consolidatedTurnover(c: CompanyResult): { months: ConsolidatedTurnoverRow[]; quarters: (ConsolidatedTurnoverRow & { quarter: number; available: boolean })[] } {
  const days = c.branches[0]?.calendar.map((x) => x.days) ?? Array(12).fill(30);
  const build = (month: number, d: number, parts: { id: number; opening: Decimal; closing: Decimal; cogs: Decimal | null; purchases: Decimal | null; stockCogs: Decimal | null }[]): ConsolidatedTurnoverRow => {
    if (!parts.length) {
      return { month, days: d, branchIds: [], opening: null, netPurchases: null, closing: null, average: null, cogs: null, stockCogs: null, difference: null, turnover: null, annualised: null, dsi: null };
    }
    const opening = sum(parts.map((p) => p.opening));
    const closing = sum(parts.map((p) => p.closing));
    const average = opening.plus(closing).div(2);
    const withCogs = parts.filter((p) => p.cogs !== null);
    const cogs = withCogs.length ? sum(withCogs.map((p) => p.cogs)) : null;
    const allPurch = parts.every((p) => p.purchases !== null);
    const stockCogs = parts.every((p) => p.stockCogs !== null) ? sum(parts.map((p) => p.stockCogs)) : null;
    const t = cogs !== null ? div(cogs, average) : null;
    return {
      month, days: d, branchIds: parts.map((p) => p.id), opening, closing, average, cogs,
      netPurchases: allPurch ? sum(parts.map((p) => p.purchases)) : null,
      stockCogs, difference: stockCogs !== null && cogs !== null ? stockCogs.minus(cogs) : null,
      turnover: t, annualised: t ? t.times(365).div(d) : null, dsi: t ? div(D(d), t) : null,
    };
  };
  const months = months12((m) => build(m, days[m - 1], c.branches.flatMap((b) => {
    const t = b.turnover[m - 1];
    return t.opening !== null && t.closing !== null
      ? [{ id: b.branchId, opening: t.opening, closing: t.closing, cogs: t.cogs, purchases: t.netPurchases, stockCogs: t.stockCogs }] : [];
  })));
  const quarters = [1, 2, 3, 4].map((q) => {
    const ms = [q * 3 - 2, q * 3 - 1, q * 3];
    const d = ms.reduce((a, m) => a + days[m - 1], 0);
    const parts = c.branches.flatMap((b) => {
      const qq = b.quarters[q - 1];
      if (!qq.available || qq.opening === null || qq.closing === null) return [];
      const rows = ms.map((m) => b.turnover[m - 1]);
      return [{ id: b.branchId, opening: qq.opening, closing: qq.closing, cogs: qq.cogs,
        purchases: qq.netPurchases, stockCogs: rows.every((r) => r.stockCogs !== null) ? sum(rows.map((r) => r.stockCogs)) : null }];
    });
    return { ...build(ms[2], d, parts), quarter: q, available: parts.length > 0 };
  });
  return { months, quarters };
}

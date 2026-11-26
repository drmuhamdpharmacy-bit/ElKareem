import { describe, expect, it } from 'vitest';
import {
  assetsTable, branchPLTable, commissionTable, comparisonTable, computeCompany, consolidatedMonthlyTable, consolidatedSideBySide,
  dashboardKpis, expenseAnalysisTable, formatValue, historyTable, latenessTable, payrollMonthTable, payrollSummaryTable, salesTable,
  stockByReasonTable, turnoverQuarterTable, turnoverTable, ytdExpenseBreakdown,
} from '../src';
import { extra, loadSeed } from './helpers';

const c = computeCompany(loadSeed());
const b1 = c.branches[0];
const val = (t: { rows: { key?: string; values: unknown[] }[]; columns: { key: string }[] }, row: string, col: string) =>
  t.rows.find((r) => r.key === row)!.values[t.columns.findIndex((x) => x.key === col)] as number;

describe('report tables', () => {
  it('all tables build with consistent widths', () => {
    const tables = [
      branchPLTable(b1), consolidatedMonthlyTable(c), consolidatedSideBySide(c, 'month'), consolidatedSideBySide(c, 'ytd'), comparisonTable(c),
      salesTable(b1), turnoverTable(b1), turnoverQuarterTable(b1), expenseAnalysisTable(b1, c.dataset.expenseCategories),
      stockByReasonTable(b1, c.dataset.adjustmentReasons), payrollSummaryTable(b1), payrollMonthTable(b1, 5), commissionTable(b1, 5),
      assetsTable(b1), latenessTable(b1), historyTable(b1, 2025), historyTable(b1, 2024),
      ...c.branches.slice(1).flatMap((b) => [branchPLTable(b), salesTable(b), turnoverTable(b), assetsTable(b), payrollSummaryTable(b)]),
    ];
    for (const t of tables) for (const r of t.rows) if (r.style !== 'section') expect(r.values.length, `${t.id}/${r.en}`).toBe(t.columns.length);
  });
  it('P&L YTD and % of sales columns', () => {
    const t = branchPLTable(b1);
    expect(val(t, 'NET_RESULT', 'ytd')).toBeCloseTo(extra.branch1Ytd.NET_RESULT, 1);
    expect(val(t, 'NET_SALES', 'pct')).toBe(1);
    expect(val(t, 'GP_PCT', 'ytd')).toBeCloseTo(extra.branch1Ytd.GP / extra.branch1Ytd.NET_SALES, 9);
  });
  it('consolidated YTD side by side: B1 + B2 + shared = consolidated', () => {
    const t = consolidatedSideBySide(c, 'ytd');
    expect(Math.abs(val(t, 'NET_RESULT', 'cons') - extra.consolidatedYtd.NET_RESULT)).toBeLessThanOrEqual(0.01);
    expect(val(t, 'NET_SALES', 'cons')).toBeCloseTo(extra.consolidatedYtd.NET_SALES, 2);
    expect(val(t, 'INV_END', 'cons')).toBeCloseTo(extra.consolidatedYtd.INV_END, 2); // balance at report month, not a sum
  });
  it('dashboard KPIs', () => {
    const k = Object.fromEntries(dashboardKpis(c).map((x) => [x.key, x]));
    expect(k.NET_SALES.ytd).toBeCloseTo(extra.consolidatedYtd.NET_SALES, 2);
    expect(Math.abs(k.NET_RESULT.ytd - extra.consolidatedYtd.NET_RESULT)).toBeLessThanOrEqual(0.01);
    expect(ytdExpenseBreakdown(c).find((x) => x.key === 'SALARIES')).toBeUndefined();
  });
  it('formatting: thousands separators, parentheses for negatives', () => {
    expect(formatValue(-14466.333, 'money')).toBe('(14,466.33)');
    expect(formatValue(1234567.05, 'money')).toBe('1,234,567.05');
    expect(formatValue(0.3123, 'pct')).toBe('31.2%');
    expect(formatValue(-0.0001, 'money')).toBe('0.00');
    expect(formatValue(null, 'money')).toBe('');
  });
});

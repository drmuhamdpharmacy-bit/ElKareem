import { describe, expect, it } from 'vitest';
import { allChecks, computeCompany, dataGaps, sum, ytd } from '../src';
import { extra, loadSeed } from './helpers';

const c = computeCompany(loadSeed());
const b1 = c.branches[0];
const R = 10;
const Y = (code: keyof typeof b1.series) => ytd(b1.series[code], R).toNumber();

describe('YTD Branch 1 Jan–Oct', () => {
  it.each(Object.entries(extra.branch1Ytd))('%s = expected YTD', (code, v) => expect(Y(code as keyof typeof b1.series)).toBeCloseTo(v, 1));
  it('Branch 2 net result Oct/Nov/Dec', () => {
    const nr = c.branches[1].series.NET_RESULT.map((x) => x.toNumber());
    for (const [m, v] of Object.entries(extra.branch2NetResult)) expect(nr[Number(m) - 1]).toBeCloseTo(v, 2);
  });
  it('consolidated YTD net sales and net result (±0.01)', () => {
    expect(ytd(c.consolidated.NET_SALES, R).toNumber()).toBeCloseTo(extra.consolidatedYtd.NET_SALES, 2);
    expect(Math.abs(ytd(c.consolidated.NET_RESULT, R).toNumber() - extra.consolidatedYtd.NET_RESULT)).toBeLessThanOrEqual(0.01);
  });
  it('ratios in total columns are recomputed from totals', () => {
    const gpPct = ytd(b1.series.GP, R).div(ytd(b1.series.NET_SALES, R)).toNumber();
    expect(b1.salesYtd.gpPct!.toNumber()).toBeCloseTo(gpPct, 12);
  });
  it('sales YTD only counts months with sales; YoY uses the same months', () => {
    expect(b1.salesFullYear.days).toBe(304); // Jan–Oct
    expect(b1.salesFullYear.netPy!.toNumber()).toBeCloseTo(sum(b1.series.NS_PY.slice(0, 10)).toNumber(), 2);
  });
  it('quarterly turnover only once the last month has a closing inventory', () => {
    expect(b1.quarters.map((q) => q.available)).toEqual([true, true, true, false]);
    const q1 = b1.quarters[0];
    expect(q1.turnover!.toNumber()).toBeCloseTo(
      (527462.01 + 517215.61 + 446274.11) / ((1713656.24 + 1837303.7) / 2), 10,
    );
  });
});

describe('checks after seeding', () => {
  const s = allChecks(c);
  it('overall ✔ with exactly two warnings (4 expense lines, unpaid commission)', () => {
    const fails = s.checks.filter((x) => x.status === 'fail');
    expect(fails, JSON.stringify(fails, null, 1)).toHaveLength(0);
    expect(s.overall).toBe('ok');
    const warns = s.checks.filter((x) => x.status === 'warn');
    expect(warns.map((w) => [w.scope, w.id])).toEqual([['branch:1', 'B8'], ['branch:1', 'B9']]);
    expect(warns[0].a).toBeCloseTo(extra.unpaidCommission.amount, 2);
    expect(warns[1].a).toBe(4);
  });
  it('the 4 lines to review are the period-override mismatches', () => {
    const w = b1.expenses.filter((e) => e.warning);
    expect(w).toHaveLength(4);
    expect(w.every((e) => e.warning === 'date_mismatch' && e.expense.periodOverride !== null)).toBe(true);
  });
});

describe('data gaps (§11)', () => {
  const gaps = dataGaps(c);
  it('expired values missing for fiscal Sep and Oct (Branch 1)', () => {
    expect(gaps.find((g) => g.branchId === 1 && g.kind === 'missing_expired')?.months).toEqual([9, 10]);
  });
  it('items sold missing for October', () => {
    expect(gaps.find((g) => g.branchId === 1 && g.kind === 'missing_items')?.months).toEqual([10]);
  });
  it('Branch 2: sales, purchases, inventory and payroll missing', () => {
    const kinds = gaps.filter((g) => g.branchId === 2).map((g) => g.kind);
    expect(kinds).toEqual(expect.arrayContaining(['missing_sales', 'missing_purchases', 'missing_inventory', 'missing_payroll']));
  });
  it('one possible duplicate in Branch 2', () => {
    const d = gaps.filter((g) => g.kind === 'possible_duplicate');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ branchId: 2, months: [10, 11] });
  });
});

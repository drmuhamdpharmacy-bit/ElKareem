import { describe, expect, it } from 'vitest';
import { computeCompany, consolidatedTurnover, consolidatedTurnoverQuarterTable, consolidatedTurnoverTable, type CompanyDataset } from '../src';
import { loadSeed } from './helpers';

describe('consolidated inventory turnover', () => {
  it('a branch without inventory is left out entirely (= Branch 1 alone today)', () => {
    const c = computeCompany(loadSeed());
    const t = consolidatedTurnover(c);
    const b1 = c.branches[0];
    for (let m = 1; m <= 12; m++) {
      const r = t.months[m - 1];
      expect(r.turnover?.toNumber() ?? null, `month ${m}`).toBe(b1.turnover[m - 1].turnover?.toNumber() ?? null);
      if (r.opening) expect(r.branchIds).toEqual([1]);
    }
    expect(t.quarters.map((q) => q.available)).toEqual(b1.quarters.map((q) => q.available));
    expect(t.quarters[0].turnover!.toNumber()).toBeCloseTo(b1.quarters[0].turnover!.toNumber(), 12);
  });

  it('with two branches: Σ COGS ÷ average of Σ inventory — not the average of the two ratios', () => {
    const d: CompanyDataset = structuredClone(loadSeed());
    const b2 = d.branches[1];
    // synthetic Branch 2: small inventory, fast turnover
    b2.opening = { inventoryValue: 100000, skuCount: null, inventoryQty: null };
    b2.monthly = [{ month: 1, grossSales: 80000, returns: 0, grossProfit: 20000, invoices: 500, itemsSold: null, loyaltyPoints: 0, salariesRecordedLegacy: null,
      purchasesGross: 70000, purchaseReturns: 0, inventoryEndValue: 110000, skuEnd: null, inventoryEndQty: null }];
    const c = computeCompany(d);
    const [b1r, b2r] = [c.branches[0].turnover[0], c.branches[1].turnover[0]];
    const r = consolidatedTurnover(c).months[0];
    const expected = (b1r.cogs!.toNumber() + b2r.cogs!.toNumber()) / ((b1r.opening!.toNumber() + b2r.opening!.toNumber() + b1r.closing!.toNumber() + b2r.closing!.toNumber()) / 2);
    expect(r.branchIds).toEqual([1, 2]);
    expect(r.turnover!.toNumber()).toBeCloseTo(expected, 12);
    const naive = (b1r.turnover!.toNumber() + b2r.turnover!.toNumber()) / 2;
    expect(Math.abs(r.turnover!.toNumber() - naive)).toBeGreaterThan(0.01);   // the wrong method gives a different number
    expect(r.dsi!.toNumber()).toBeCloseTo(31 / expected, 10);
    // February: Branch 2 has no closing inventory → back to Branch 1 only
    expect(consolidatedTurnover(c).months[1].branchIds).toEqual([1]);
  });

  it('report tables build with consistent widths', () => {
    const c = computeCompany(loadSeed());
    for (const t of [consolidatedTurnoverTable(c), consolidatedTurnoverQuarterTable(c, 'en')]) {
      for (const r of t.rows) expect(r.values.length).toBe(t.columns.length);
    }
  });
});

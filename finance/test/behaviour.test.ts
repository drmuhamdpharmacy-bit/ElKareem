import { describe, expect, it } from 'vitest';
import { computeCompany, CompanyDataset } from '../src';
import { loadSeed } from './helpers';

const clone = (d: CompanyDataset): CompanyDataset => structuredClone(d);

describe('behaviour', () => {
  it('a manual DEP expense at/after the register start month does not change the P&L', () => {
    const base = loadSeed();
    const before = computeCompany(base).branches[0];
    const changed = clone(base);
    changed.branches[0].expenses.push({ date: '2026-10-05', description: 'manual dep test', categoryKey: 'DEP', amount: 999, periodOverride: null });
    const after = computeCompany(changed).branches[0];
    expect(after.series.DEP.map(Number)).toEqual(before.series.DEP.map(Number));
    expect(after.series.NET_RESULT.map(Number)).toEqual(before.series.NET_RESULT.map(Number));
    expect(after.excludedManualDep[9].toNumber() - before.excludedManualDep[9].toNumber()).toBeCloseTo(999, 6);
  });

  it('a manual DEP expense before the register start month IS included', () => {
    const base = loadSeed();
    const changed = clone(base);
    changed.branches[0].expenses.push({ date: '2026-08-05', description: 'x', categoryKey: 'DEP', amount: 100, periodOverride: null });
    const d = computeCompany(changed).branches[0].series.DEP[7].minus(computeCompany(base).branches[0].series.DEP[7]);
    expect(d.toNumber()).toBe(100);
  });

  it('an 8,400 asset with an 84-month life dated 26 Sep 2026 adds 100/month from fiscal October', () => {
    const base = loadSeed();
    const changed = clone(base);
    changed.branches[0].assets.push({ name: 'test fridge', cost: 8400, category: 'ثلاجات وتبريد أدوية', customMonths: null, dateAdded: '2026-09-26' });
    const a = computeCompany(base).branches[0];
    const b = computeCompany(changed).branches[0];
    const diff = b.series.DEP.map((x, i) => x.minus(a.series.DEP[i]).toNumber());
    expect(diff).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100, 100]);
  });

  it('a 40-minute lateness entry in November deducts 2 × round(6000/26×8) = 3,692', () => {
    const base = loadSeed();
    const changed = clone(base);
    const b1 = changed.branches[0];
    const line = b1.payrollLines.find((l) => l.month === 11 && b1.staff.some((st) => st.payrollName === l.employee && st.latenessName !== st.payrollName))!;
    const latenessName = b1.staff.find((st) => st.payrollName === line.employee)!.latenessName;
    line.ratePer26h = 6000;
    const before = computeCompany(clone(changed)).branches[0].payroll[10];
    b1.lateness.push({ date: '2026-11-10', employee: latenessName, minutesLate: 40 });
    const after = computeCompany(changed).branches[0].payroll[10];
    const l = after.lines.find((x) => x.line.employee === line.employee)!;
    expect(l.dayValue!.toNumber()).toBe(1846);
    expect(l.latenessDays!.toNumber()).toBe(2);
    expect(l.latenessAmount!.toNumber()).toBe(3692);
    expect(before.totals.payroll.minus(after.totals.payroll).toNumber()).toBe(3692);
  });

  it('a lateness entry before the auto month does not change payroll (recorded values are used)', () => {
    const base = loadSeed();
    const changed = clone(base);
    changed.branches[0].lateness.push({ date: '2026-09-10', employee: changed.branches[0].staff[0].latenessName, minutesLate: 40 });
    expect(computeCompany(changed).branches[0].payrollTotal[8].toNumber()).toBe(computeCompany(base).branches[0].payrollTotal[8].toNumber());
  });

  it('shared expenses go to their own column and reduce the consolidated result only', () => {
    const base = loadSeed();
    const changed = clone(base);
    changed.sharedExpenses.push({ date: '2026-10-01', description: 'shared test', categoryKey: 'FEES', amount: 1000, periodOverride: null });
    const a = computeCompany(base);
    const b = computeCompany(changed);
    expect(b.sharedSeries[9].toNumber()).toBe(1000);
    expect(a.consolidated.NET_RESULT[9].minus(b.consolidated.NET_RESULT[9]).toNumber()).toBe(1000);
    expect(b.branches[0].series.NET_RESULT[9].equals(a.branches[0].series.NET_RESULT[9])).toBe(true);
  });

  it('moving an employee to branch 2 from a month (S2) uses that branch for lateness', () => {
    const base = loadSeed();
    const changed = clone(base);
    const st = changed.branches[0].staff[changed.branches[0].staff.length - 1];
    st.months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    changed.branches[1].staff.push({ ...st, months: [11, 12] });
    const r = computeCompany(changed);
    expect(r.branches[1].latenessDaysByStaff[st.latenessName]).toHaveLength(12);
  });
});

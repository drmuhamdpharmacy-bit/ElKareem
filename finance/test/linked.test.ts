import { describe, expect, it } from 'vitest';
import { allChecks, computeCompany, payrollMonthTable, payrollSummaryTable, type CompanyDataset } from '../src';
import { loadSeed } from './helpers';

const appLines = [
  { empId: 'EK900', employee: 'Test Employee A', role: 'Assistant', hours: 200, salary: 4230.77, commission: 1000, bonuses: 500, penalties: 100, withdrawals: 300, net: 5330.77 },
  { empId: 'EK901', employee: 'Test Employee B', role: 'Assistant', hours: 180, salary: 3461.54, commission: 800, bonuses: 0, penalties: 0, withdrawals: 0, net: 4261.54 },
];

function linked(): CompanyDataset {
  const d = structuredClone(loadSeed());
  d.branches[0].linkedPayroll = { fromMonth: 11, months: [{ month: 11, lines: appLines, sales: 930000, commissionPool: 13950 }] };
  return d;
}

describe('salaries linked to the app payroll from November', () => {
  const base = computeCompany(loadSeed()).branches[0];
  const c = computeCompany(linked());
  const b = c.branches[0];
  it('Jan–Oct unchanged (still the finance / Excel payroll)', () => {
    for (let m = 0; m < 10; m++) expect(b.series.SALARIES[m].equals(base.series.SALARIES[m])).toBe(true);
  });
  const owners = (m: number) => b.dataset.owners.filter((o) => o.month === m).reduce((t, o) => t + (o.fixedAmount ?? 0), 0);
  it('November = Σ app net + owners\' fixed salaries', () => {
    expect(b.payroll[10].source).toBe('app');
    expect(b.series.SALARIES[10].toNumber()).toBeCloseTo(5330.77 + 4261.54 + owners(11), 6);
  });
  it('December with no app data yet = owners only', () => {
    expect(b.series.SALARIES[11].toNumber()).toBe(owners(12));
  });
  it('net result moves by the salary difference only', () => {
    const d = base.series.SALARIES[10].minus(b.series.SALARIES[10]);
    expect(b.series.NET_RESULT[10].minus(base.series.NET_RESULT[10]).equals(d)).toBe(true);
  });
  it('checks stay green and the report tables include the app lines', () => {
    expect(allChecks(c).overall).toBe('ok');
    const t = payrollMonthTable(b, 11);
    const ownerNames = b.dataset.owners.filter((o) => o.month === 11).map((o) => o.name);
    expect(t.rows.map((r) => r.en)).toEqual(['Test Employee A', 'Test Employee B', ...ownerNames, 'Total payroll']);
    const sum = payrollSummaryTable(b);
    expect(sum.rows.find((r) => r.en === 'Test Employee A')!.values[10]).toBeCloseTo(5330.77, 6);
  });
});

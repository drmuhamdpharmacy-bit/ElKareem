import { describe, expect, it } from 'vitest';
import { computeCompany, EXPORT_CODES, toNum } from '../src';
import { expected, loadSeed, near } from './helpers';

const result = computeCompany(loadSeed());

for (const b of result.branches) {
  const exp = expected[`branch_${b.branchId}`];
  describe(`golden – branch ${b.branchId}`, () => {
    it('has every expected code', () => {
      for (const code of Object.keys(exp)) expect(code).toBeTruthy();
    });

    for (const code of Object.keys(exp)) {
      const values = exp[code];
      if (code === 'STAFF_LATENESS_DAYS') {
        it(code, () => {
          const want = values as Record<string, number[]>;
          expect(Object.keys(b.latenessDaysByStaff).sort()).toEqual(Object.keys(want).sort());
          for (const [name, arr] of Object.entries(want)) expect(b.latenessDaysByStaff[name], name).toEqual(arr);
        });
        continue;
      }
      it(code, () => {
        const want = values as (number | null)[];
        let got: (number | null)[];
        if ((EXPORT_CODES as readonly string[]).includes(code)) got = b.series[code as (typeof EXPORT_CODES)[number]].map(toNum);
        else if (code.startsWith('CAT_')) got = b.categories[code].map(toNum);
        else if (code === 'PAYROLL_TOTAL') got = b.payrollTotal.map(toNum);
        else if (code === 'ASSET_DEP_REGISTER') got = b.registerDep.map(toNum);
        else if (code === 'TURNOVER_MONTHLY') got = b.turnoverMonthly.map(toNum);
        else throw new Error(`Unhandled golden code ${code}`);
        expect(got).toHaveLength(12);
        want.forEach((w, i) => {
          const tol = code === 'TURNOVER_MONTHLY' ? 1e-9 : 0.01;
          expect(near(got[i], w, tol), `${code}[${i + 1}] got ${got[i]} want ${w}`).toBe(true);
        });
      });
    }
  });
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCompany, parseCsv, num } from '../src';
import { DATA_DIR, extra, loadSeed, near } from './helpers';

const rows = parseCsv(readFileSync(join(DATA_DIR, 'payroll_lines.csv'), 'utf8'));
const b1 = computeCompany(loadSeed()).branches[0];

describe('payroll lines (payroll_lines.csv → expected_net_pay / expected_commission)', () => {
  it('has 158 lines', () => expect(rows).toHaveLength(158));
  rows.forEach((r, i) => {
    it(`#${i + 1} ${r.month}/${r.employee}`, () => {
      const month = b1.payroll[Number(r.month) - 1];
      const line = month.lines.find((l) => l.line.id === i + 1)!;
      expect(line, 'line found').toBeTruthy();
      expect(near(line.netPay.toNumber(), num(r.expected_net_pay)), `net ${line.netPay} vs ${r.expected_net_pay}`).toBe(true);
      expect(near(line.commission.toNumber(), num(r.expected_commission)), `comm ${line.commission} vs ${r.expected_commission}`).toBe(true);
    });
  });
});

describe('commission block', () => {
  const expectedTeam = parseCsv(readFileSync(join(DATA_DIR, 'commission_months.csv'), 'utf8'));
  it('team commission per month matches commission_months.csv', () => {
    for (const r of expectedTeam) {
      expect(near(b1.payroll[Number(r.month) - 1].teamCommission.toNumber(), num(r.expected_team_commission))).toBe(true);
    }
  });
  it('commission calculated but not paid only in the expected month', () => {
    b1.payroll.forEach((p) => {
      if (p.month === extra.unpaidCommission.month) expect(p.calculatedNotPaid.toNumber()).toBeCloseTo(extra.unpaidCommission.amount, 6);
      else expect(p.calculatedNotPaid.abs().toNumber()).toBeLessThan(0.01);
    });
  });
  it('undistributed = team − Σ shares', () => {
    for (const p of b1.payroll) expect(p.undistributed.equals(p.teamCommission.minus(p.sharesTotal))).toBe(true);
  });
});

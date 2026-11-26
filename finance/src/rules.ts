import { D, DN, Decimal, ZERO, roundExcel } from './decimal';
import type { CommissionTierMode, FiscalSettings } from './types';

/**
 * Team commission – copied from the original Sal_MM!C37 formula:
 * =IF(OR(S="",T=""),0,IF(S<T*0.96,0,IF(S>=t2,S*2%,IF(S>=t1.5,S*1.5%,IF(S>=t1,S*1%,0)))))
 * A missing threshold disables that tier (the workbook would treat a blank as 0).
 */
export function teamCommission(
  input: {
    salesForCommission: number | null;
    target: number | null;
    threshold1pct: number | null;
    threshold15pct: number | null;
    threshold2pct: number | null;
  },
  mode: CommissionTierMode = 'original',
): Decimal {
  const S = DN(input.salesForCommission);
  const T = DN(input.target);
  if (S === null || T === null) return ZERO;
  const floor = T.times('0.96');
  if (S.lt(floor)) return ZERO;
  const t2 = DN(input.threshold2pct);
  const t15 = DN(input.threshold15pct);
  const t1 = DN(input.threshold1pct);
  if (t2 !== null && S.gte(t2)) return S.times('0.02');
  if (t15 !== null && S.gte(t15)) return S.times('0.015');
  if (mode === 'tier1_from_96pct_target') return S.times('0.01');
  if (t1 !== null && S.gte(t1)) return S.times('0.01');
  return ZERO;
}

/** Lateness deduction days (§4.7): > twoDaysAbove → 2; ≥ halfDayFrom → 0.5; else 0. */
export function latenessDays(
  minutes: number | null,
  s: Pick<FiscalSettings, 'latenessHalfDayFromMinutes' | 'latenessTwoDaysAboveMinutes'>,
): number {
  if (minutes === null || minutes === undefined) return 0;
  if (minutes > s.latenessTwoDaysAboveMinutes) return 2;
  if (minutes >= s.latenessHalfDayFromMinutes) return 0.5;
  return 0;
}

/** Day value = ROUND(rate / 26 × hours, 0) (decision D6). */
export function dayValue(ratePer26h: number | null, hours = 8): Decimal | null {
  if (ratePer26h === null || ratePer26h === undefined) return null;
  return roundExcel(D(ratePer26h).div(26).times(hours), 0);
}

/** Salary by hours = rate / 26 × actual hours (blank if either is blank). */
export function salaryByHours(ratePer26h: number | null, actualHours: number | null): Decimal | null {
  if (ratePer26h === null || actualHours === null) return null;
  return D(ratePer26h).div(26).times(actualHours);
}

/** Stock adjustment value = manual amount if present, else qty × unit cost. */
export function adjustmentValue(a: { qty: number | null; unitCost: number | null; manualAmount: number | null }): Decimal | null {
  if (a.manualAmount !== null && a.manualAmount !== undefined) return D(a.manualAmount);
  if (a.qty === null || a.unitCost === null) return null;
  return D(a.qty).times(a.unitCost);
}

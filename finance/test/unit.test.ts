import { describe, expect, it } from 'vitest';
import {
  computeAsset, dayValue, daysInPeriod, fiscalCalendar, latenessDays, periodOf, teamCommission, D,
} from '../src';
import { loadSeed } from './helpers';

const s = loadSeed().settings;

describe('period()', () => {
  it('25th belongs to the same month, 26th to the next', () => {
    expect(periodOf('2026-09-25', 2026, 26)).toBe(9);
    expect(periodOf('2026-09-26', 2026, 26)).toBe(10);
    expect(periodOf('2026-10-25', 2026, 26)).toBe(10);
  });
  it('December of the previous year → January', () => {
    expect(periodOf('2025-12-26', 2026, 26)).toBe(1);
    expect(periodOf('2025-12-31', 2026, 26)).toBe(1);
    expect(periodOf('2025-12-25', 2026, 26)).toBe(0); // previous fiscal year
  });
  it('26 Dec of the fiscal year → next fiscal year (13)', () => {
    expect(periodOf('2026-12-25', 2026, 26)).toBe(12);
    expect(periodOf('2026-12-26', 2026, 26)).toBe(13);
  });
  it('days per period 2026 and total 365', () => {
    const days = fiscalCalendar(2026, 26).map((c) => c.days);
    expect(days).toEqual([31, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30]);
    expect(days.reduce((a, b) => a + b, 0)).toBe(365);
    expect(daysInPeriod(2026, 10, 26)).toBe(30);
    expect(fiscalCalendar(2026, 26)[0]).toMatchObject({ from: '2025-12-26', to: '2026-01-25' });
    expect(fiscalCalendar(2026, 26)[9]).toMatchObject({ from: '2026-09-26', to: '2026-10-25' });
  });
});

describe('commission tiers', () => {
  const base = { target: 840000, threshold1pct: 841000, threshold15pct: 900000, threshold2pct: 960000 };
  const c = (S: number | null) => teamCommission({ ...base, salesForCommission: S }).toNumber();
  it('empty sales → 0', () => expect(c(null)).toBe(0));
  it('below 96% of target → 0', () => expect(c(806399.99)).toBe(0));
  it('between 96% of target and 1% threshold → 0 (original formula)', () => {
    expect(c(806400)).toBe(0);
    expect(c(840999.99)).toBe(0);
  });
  it('1% at the threshold', () => expect(c(841000)).toBeCloseTo(8410, 6));
  it('1.5% at the threshold', () => {
    expect(c(899999.99)).toBeCloseTo(8999.9999, 6);
    expect(c(900000)).toBeCloseTo(13500, 6);
  });
  it('2% at the threshold', () => {
    expect(c(959999)).toBeCloseTo(14399.985, 6);
    expect(c(960000)).toBeCloseTo(19200, 6);
  });
  it('alternative mode: 1% from 96% of target', () => {
    expect(teamCommission({ ...base, salesForCommission: 806400 }, 'tier1_from_96pct_target').toNumber()).toBeCloseTo(8064, 6);
    expect(teamCommission({ ...base, salesForCommission: 806399 }, 'tier1_from_96pct_target').toNumber()).toBe(0);
  });
});

describe('lateness thresholds', () => {
  it.each([
    [0, 0], [10, 0], [11, 0.5], [30, 0.5], [31, 2], [85, 2], [null, 0],
  ])('%s min → %s days', (m, d) => expect(latenessDays(m as number | null, s)).toBe(d));
  it('day value = round(rate/26×8)', () => {
    expect(dayValue(6000)!.toNumber()).toBe(1846);
    expect(dayValue(1200)!.toNumber()).toBe(369);
    expect(dayValue(1000)!.toNumber()).toBe(308);
    expect(dayValue(null)).toBeNull();
  });
});

describe('depreciation start/end', () => {
  const cats = loadSeed().assetCategories;
  it('starts in the period of date_added and runs exactly `months` periods', () => {
    const a = computeAsset({ name: 't', cost: 600, category: null, customMonths: 6, dateAdded: '2026-05-26' }, cats, s);
    expect(a.firstPeriod).toBe(6);
    expect(a.charges.map((x) => x.toNumber())).toEqual([0, 0, 0, 0, 0, 100, 100, 100, 100, 100, 100, 0]);
  });
  it('a 25th date starts in that month', () => {
    const a = computeAsset({ name: 't', cost: 300, category: null, customMonths: 3, dateAdded: '2026-05-25' }, cats, s);
    expect(a.charges.map((x) => x.toNumber())).toEqual([0, 0, 0, 0, 100, 100, 100, 0, 0, 0, 0, 0]);
  });
  it('accumulated / book value / status at the report month', () => {
    const a = computeAsset({ name: 'test', cost: 4000, category: 'مستلزمات طباعة وتغليف', customMonths: 4, dateAdded: '2026-05-26' }, cats, { ...s, reportMonth: 10 });
    expect(a.accumulated!.toNumber()).toBe(4000);
    expect(a.bookValue!.toNumber()).toBe(0);
    expect(a.status).toBe('finished');
    const b = computeAsset({ name: 'x', cost: 3600, category: 'إلكترونيات وأجهزة كمبيوتر', customMonths: null, dateAdded: '2026-11-01' }, cats, { ...s, reportMonth: 10 });
    expect(b.months).toBe(36);
    expect(b.status).toBe('not_started');
    expect(b.accumulated!.toNumber()).toBe(0);
  });
  it('uses the category useful life when there is no custom period', () => {
    const a = computeAsset({ name: 'x', cost: 1200, category: 'تكييف وتهوية', customMonths: null, dateAdded: '2026-07-26' }, cats, s);
    expect(a.months).toBe(60);
    expect(a.monthly!.toNumber()).toBeCloseTo(20, 6);
  });
  it('decimal sums are exact', () => expect(D(0.1).plus(0.2).toNumber()).toBe(0.3));
});

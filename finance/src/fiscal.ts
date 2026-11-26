/**
 * Fiscal month rule (§4.1): month M of fiscal year Y runs from day START_DAY of month M-1
 * to day START_DAY-1 of month M. Dates are handled as plain YYYY-MM-DD strings (no time zones).
 */

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export function parseISODate(s: string | null | undefined): YMD | null {
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** period(d) = (year(d) − Y) × 12 + month(d) + (day(d) ≥ START_DAY ? 1 : 0) */
export function periodOf(date: string | YMD, fiscalYear: number, startDay: number): number {
  const p = typeof date === 'string' ? parseISODate(date) : date;
  if (!p) throw new Error(`Invalid date: ${String(date)}`);
  return (p.y - fiscalYear) * 12 + p.m + (p.d >= startDay ? 1 : 0);
}

export function periodOrNull(date: string | null | undefined, fiscalYear: number, startDay: number): number | null {
  const p = parseISODate(date ?? null);
  return p ? periodOf(p, fiscalYear, startDay) : null;
}

/** Excel DATE(y, m, d) with month/day overflow, returned as a UTC epoch day number. */
function excelDate(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function fmt(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

export interface PeriodRange {
  month: number;
  from: string;
  to: string;
  days: number;
}

/** from = DATE(Y, M−1, START_DAY); to = DATE(Y, M, START_DAY−1); days = to − from + 1 */
export function periodRange(fiscalYear: number, month: number, startDay: number): PeriodRange {
  const from = excelDate(fiscalYear, month - 1, startDay);
  const to = excelDate(fiscalYear, month, startDay - 1);
  return { month, from: fmt(from), to: fmt(to), days: to - from + 1 };
}

export function fiscalCalendar(fiscalYear: number, startDay: number): PeriodRange[] {
  return Array.from({ length: 12 }, (_, i) => periodRange(fiscalYear, i + 1, startDay));
}

export function daysInPeriod(fiscalYear: number, month: number, startDay: number): number {
  return periodRange(fiscalYear, month, startDay).days;
}

export const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

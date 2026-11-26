import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Dec = Decimal;

export const ZERO = new Decimal(0);

/** Convert an input number (or null) to Decimal. null/undefined → 0. */
export function D(x: number | string | Decimal | null | undefined): Decimal {
  if (x === null || x === undefined || x === '') return ZERO;
  if (x instanceof Decimal) return x;
  return new Decimal(typeof x === 'number' ? String(x) : x);
}

/** Decimal or null (keeps the "blank cell" meaning). */
export function DN(x: number | string | Decimal | null | undefined): Decimal | null {
  if (x === null || x === undefined || x === '') return null;
  return D(x);
}

export function sum(xs: Iterable<Decimal | null | undefined>): Decimal {
  let s = ZERO;
  for (const x of xs) if (x) s = s.plus(x);
  return s;
}

/** a / b, or null if b is zero/null (Excel IFERROR(…,"")). */
export function div(a: Decimal | null, b: Decimal | null): Decimal | null {
  if (a === null || b === null || b.isZero()) return null;
  return a.div(b);
}

/** Excel ROUND(x, 0): half away from zero. */
export function roundExcel(x: Decimal, dp = 0): Decimal {
  return x.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

export function toNum(x: Decimal | null | undefined): number | null {
  return x === null || x === undefined ? null : x.toNumber();
}

export const months12 = <T>(f: (m: number) => T): T[] => Array.from({ length: 12 }, (_, i) => f(i + 1));

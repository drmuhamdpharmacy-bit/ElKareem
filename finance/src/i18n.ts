/** Number formatting: Western digits, thousands separators, negatives in parentheses (§2.5). */
export type Fmt = 'money' | 'money0' | 'int' | 'pct' | 'num2' | 'num4' | 'text' | 'days';

export function formatValue(v: number | string | null | undefined, fmt: Fmt): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '';
  const neg = v < 0;
  const a = Math.abs(v);
  let s: string;
  switch (fmt) {
    case 'pct':
      s = `${(a * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      break;
    case 'int':
    case 'money0':
    case 'days':
      s = a.toLocaleString('en-US', { maximumFractionDigits: 0 });
      break;
    case 'num4':
      s = a.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
      break;
    case 'num2':
    case 'money':
    default:
      s = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Avoid "(0.00)" for tiny negative rounding noise.
  if (neg && /[1-9]/.test(s)) return `(${s})`;
  return s;
}

/** Excel number formats matching formatValue (parentheses for negatives). */
export const EXCEL_FMT: Record<Fmt, string> = {
  money: '#,##0.00;(#,##0.00);"-"',
  money0: '#,##0;(#,##0);"-"',
  int: '#,##0;(#,##0);"-"',
  days: '0',
  pct: '0.0%;(0.0%);"-"',
  num2: '#,##0.00;(#,##0.00)',
  num4: '0.0000',
  text: '@',
};

export type Lang = 'ar' | 'en';
export interface Bi {
  ar: string;
  en: string;
}
export const bi = (ar: string, en: string): Bi => ({ ar, en });

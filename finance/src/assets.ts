import { D, Decimal, ZERO, months12 } from './decimal';
import { periodOrNull } from './fiscal';
import type { Asset, AssetCategory, FiscalSettings } from './types';

export type AssetStatus = 'not_started' | 'active' | 'ending' | 'finished' | 'incomplete';

export interface AssetRow {
  asset: Asset;
  months: number | null;
  monthly: Decimal | null;
  firstPeriod: number | null;
  /** Calendar date the depreciation ends (Excel EDATE(date_added, months)). */
  endDate: string | null;
  /** Charge for fiscal periods 1..12 of the year. */
  charges: Decimal[];
  accumulated: Decimal | null;
  bookValue: Decimal | null;
  monthsLeft: number | null;
  status: AssetStatus;
  warnings: string[];
}

function edate(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function usefulLife(asset: Asset, categories: AssetCategory[]): number | null {
  if (asset.customMonths !== null && asset.customMonths !== undefined) return asset.customMonths;
  if (!asset.category) return null;
  const cat = categories.find((c) => c.name === asset.category);
  return cat?.usefulLifeMonths ?? null;
}

/**
 * Straight-line register (§4.4): charge in period P = monthly if first ≤ P < first + months.
 * Accumulated at report month R = monthly × min(months, max(0, R − first + 1)).
 * Never uses "today".
 */
export function computeAsset(asset: Asset, categories: AssetCategory[], s: FiscalSettings): AssetRow {
  const months = usefulLife(asset, categories);
  const warnings: string[] = [];
  const firstPeriod = periodOrNull(asset.dateAdded, s.year, s.startDay);
  if (firstPeriod === null) warnings.push('no_date');
  if (months === null) warnings.push('no_useful_life');
  const monthly = asset.cost !== null && months ? D(asset.cost).div(months) : null;
  const charges = months12((p) =>
    monthly !== null && firstPeriod !== null && months !== null && p >= firstPeriod && p < firstPeriod + months ? monthly : ZERO,
  );
  if (monthly === null || firstPeriod === null || months === null) {
    return {
      asset, months, monthly, firstPeriod, endDate: null, charges,
      accumulated: null, bookValue: null, monthsLeft: null, status: 'incomplete', warnings,
    };
  }
  const elapsed = Math.min(months, Math.max(0, s.reportMonth - firstPeriod + 1));
  const accumulated = monthly.times(elapsed);
  const monthsLeft = months - elapsed;
  // Same order of tests as the workbook (Assets!M).
  const status: AssetStatus =
    monthsLeft === 0 ? 'finished' : monthsLeft <= 1 ? 'ending' : s.reportMonth < firstPeriod ? 'not_started' : 'active';
  return {
    asset, months, monthly, firstPeriod,
    endDate: asset.dateAdded ? edate(asset.dateAdded, months) : null,
    charges, accumulated, bookValue: D(asset.cost).minus(accumulated), monthsLeft, status, warnings,
  };
}

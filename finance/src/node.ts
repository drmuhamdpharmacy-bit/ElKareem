import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatasetFromFiles, SeedFiles } from './csv';
import type { CompanyDataset, FiscalSettings } from './types';

const FILES: (keyof SeedFiles)[] = [
  'settings.json', 'opening_balances.csv', 'monthly_inputs.csv', 'operating_expenses.csv', 'stock_adjustments.csv',
  'assets.csv', 'staff.csv', 'lateness_log.csv', 'payroll_lines.csv', 'payroll_owners.csv', 'commission_months.csv',
  'commission_shares.csv', 'history_monthly.csv', 'shared_expenses.csv',
];

export function readSeedFiles(dir: string): SeedFiles {
  const out: Record<string, string> = {};
  for (const f of FILES) {
    const p = join(dir, f);
    if (existsSync(p)) out[f] = readFileSync(p, 'utf8');
  }
  return out as unknown as SeedFiles;
}

export function loadDatasetFromDir(dir: string, overrides: Partial<FiscalSettings> = {}): CompanyDataset {
  return loadDatasetFromFiles(readSeedFiles(dir), overrides);
}

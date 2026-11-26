import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDatasetFromDir } from '../src/node';
import type { CompanyDataset } from '../src/types';

export const DATA_DIR = join(__dirname, '../data');
export const loadSeed = (): CompanyDataset => loadDatasetFromDir(DATA_DIR);
export const expected = JSON.parse(readFileSync(join(DATA_DIR, 'expected_results.json'), 'utf8')) as Record<
  string,
  Record<string, (number | null)[] | Record<string, number[]>>
>;
export const near = (a: number | null, b: number | null, tol = 0.01) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol;

/** Private expected figures (finance/data/expected_extra.json – never committed). */
export const extra = JSON.parse(readFileSync(join(DATA_DIR, 'expected_extra.json'), 'utf8')) as {
  branch1Ytd: Record<string, number>; branch2NetResult: Record<string, number>; consolidatedYtd: Record<string, number>;
  unpaidCommission: { month: number; amount: number }; e2e: Record<string, string>;
};

import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// The golden tests need the private seed package in finance/data/ (never committed – the repo is public).
const hasData = existsSync(new URL('./data/expected_results.json', import.meta.url));
if (!hasData) console.warn('\n⚠ finance/data/ is missing – data-based tests are skipped. Copy the private seed package there to run them.\n');

export default defineConfig({ test: { include: hasData ? ['test/**/*.test.ts'] : [], passWithNoTests: true } });

/**
 * CSV / JSON loading of the seed package (data/*.csv, settings.json) into a CompanyDataset.
 * Pure (string in, object out) so it can run in Node, the browser or the seed script.
 */
import type {
  AssetCategory, BranchDataset, CompanyDataset, ExpenseCategory, FiscalSettings, PlClass,
} from './types';

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, UTF-8 BOM). Returns objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** Empty cell → null (never 0). */
export const num = (s: string | undefined): number | null => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`Not a number: "${s}"`);
  return n;
};
export const str = (s: string | undefined): string | null => (s === undefined || s.trim() === '' ? null : s.trim());

export interface SeedSettingsJson {
  company: { name_ar: string; name_en: string; currency: string; fiscal_year: number; brand_colors: Record<string, string> };
  branches: { id: number; name_ar: string; name_en: string; color: string; depreciation_register_from_month: number; opened?: string }[];
  fiscal_month: { start_day: number };
  lateness_rules: { half_day_from_minutes: number; two_days_if_more_than_minutes: number; auto_into_payroll_from_month: number };
  expense_categories: { key: string; name_ar: string; name_en: string; pl_class: PlClass }[];
  asset_categories: { name: string; useful_life_months: number | null }[];
  stock_adjustment_reasons: string[];
}

export interface SeedFiles {
  'settings.json': string;
  'opening_balances.csv': string;
  'monthly_inputs.csv': string;
  'operating_expenses.csv': string;
  'stock_adjustments.csv': string;
  'assets.csv': string;
  'staff.csv': string;
  'lateness_log.csv': string;
  'payroll_lines.csv': string;
  'payroll_owners.csv': string;
  'commission_months.csv': string;
  'commission_shares.csv': string;
  'history_monthly.csv': string;
  'shared_expenses.csv'?: string;
}

export function openedMonthFrom(opened: string | undefined, year: number): number | null {
  if (!opened) return null;
  const m = /^(\d{4})-(\d{2})/.exec(opened);
  if (!m) return null;
  return Number(m[1]) === year ? Number(m[2]) : null;
}

export function loadDatasetFromFiles(files: SeedFiles, overrides: Partial<FiscalSettings> = {}): CompanyDataset {
  const cfg = JSON.parse(files['settings.json']) as SeedSettingsJson;
  const year = cfg.company.fiscal_year;
  const settings: FiscalSettings = {
    year,
    startDay: cfg.fiscal_month.start_day,
    reportMonth: 10,
    latenessAutoFromMonth: cfg.lateness_rules.auto_into_payroll_from_month,
    latenessHalfDayFromMinutes: cfg.lateness_rules.half_day_from_minutes,
    latenessTwoDaysAboveMinutes: cfg.lateness_rules.two_days_if_more_than_minutes,
    latenessDayHours: 8,
    commissionTierMode: 'original',
    bottomLine: 'net_after_stock_losses',
    ...overrides,
  };
  const expenseCategories: ExpenseCategory[] = cfg.expense_categories.map((c) => ({
    key: c.key, nameAr: c.name_ar, nameEn: c.name_en, plClass: c.pl_class,
  }));
  const assetCategories: AssetCategory[] = cfg.asset_categories.map((c) => ({ name: c.name, usefulLifeMonths: c.useful_life_months }));
  const csv = (k: keyof SeedFiles) => (files[k] ? parseCsv(files[k] as string) : []);

  const opening = csv('opening_balances.csv');
  const monthly = csv('monthly_inputs.csv');
  const expenses = csv('operating_expenses.csv');
  const stock = csv('stock_adjustments.csv');
  const assets = csv('assets.csv');
  const staff = csv('staff.csv');
  const lateness = csv('lateness_log.csv');
  const payroll = csv('payroll_lines.csv');
  const owners = csv('payroll_owners.csv');
  const cmonths = csv('commission_months.csv');
  const shares = csv('commission_shares.csv');
  const history = csv('history_monthly.csv');
  const shared = csv('shared_expenses.csv');

  const forBranch = (rows: Record<string, string>[], id: number) => rows.filter((r) => Number(r.branch) === id);
  const forYear = (rows: Record<string, string>[]) => rows.filter((r) => !r.year || Number(r.year) === year);

  const branches: BranchDataset[] = cfg.branches.map((b) => {
    const ob = forBranch(opening, b.id).find((r) => Number(r.year) === year);
    let sort = 0;
    return {
      branch: {
        id: b.id, nameAr: b.name_ar, nameEn: b.name_en, color: b.color,
        depreciationRegisterFromMonth: b.depreciation_register_from_month,
        openedMonth: openedMonthFrom(b.opened, year),
      },
      opening: ob ? { inventoryValue: num(ob.inventory_value), skuCount: num(ob.sku_count), inventoryQty: num(ob.inventory_qty) } : null,
      monthly: forYear(forBranch(monthly, b.id)).map((r) => ({
        month: Number(r.month),
        grossSales: num(r.gross_sales), returns: num(r.returns), grossProfit: num(r.gross_profit),
        invoices: num(r.invoices), itemsSold: num(r.items_sold), loyaltyPoints: num(r.loyalty_points),
        salariesRecordedLegacy: num(r.salaries_recorded_legacy), purchasesGross: num(r.purchases_gross),
        purchaseReturns: num(r.purchase_returns), inventoryEndValue: num(r.inventory_end_value),
        skuEnd: num(r.sku_end), inventoryEndQty: num(r.inventory_end_qty), notes: str(r.notes),
      })),
      expenses: forBranch(expenses, b.id).map((r, i) => ({
        id: i + 1, date: str(r.date), description: r.description, categoryKey: str(r.category_key),
        amount: num(r.amount), periodOverride: num(r.period_override), source: str(r.source),
      })),
      stockAdjustments: forYear(forBranch(stock, b.id)).map((r, i) => ({
        id: i + 1, month: num(r.month), itemCode: str(r.item_code), itemName: str(r.item_name), qty: num(r.qty),
        unit: str(r.unit), unitCost: num(r.unit_cost), manualAmount: num(r.manual_amount), reason: str(r.reason), source: str(r.source),
      })),
      assets: forBranch(assets, b.id).map((r, i) => ({
        id: i + 1, name: r.name, cost: num(r.cost), category: str(r.category), customMonths: num(r.custom_months),
        dateAdded: str(r.date_added), notes: str(r.notes),
      })),
      staff: forBranch(staff, b.id).map((r, i) => ({ id: i + 1, latenessName: r.lateness_name, payrollName: r.payroll_name, role: str(r.role) })),
      lateness: forBranch(lateness, b.id).map((r, i) => ({
        id: i + 1, date: str(r.date), employee: r.employee, minutesLate: num(r.minutes_late), notes: str(r.notes),
      })),
      payrollMonths: forYear(forBranch(cmonths, b.id)).map((r) => ({
        month: Number(r.month), salesForCommission: num(r.sales_for_commission), target: num(r.target),
        threshold1pct: num(r.threshold_1pct), threshold15pct: num(r.threshold_1_5pct), threshold2pct: num(r.threshold_2pct),
      })),
      payrollLines: forYear(forBranch(payroll, b.id)).map((r, i) => ({
        id: i + 1, month: Number(r.month), employee: r.employee, role: str(r.role), baseHours: num(r.base_hours),
        actualHours: num(r.actual_hours), ratePer26h: num(r.rate_per_26h), deductions: num(r.deductions), additions: num(r.additions),
        additionsDetails: str(r.additions_details), deductionsDetails: str(r.deductions_details),
        latenessDaysRecorded: num(r.lateness_days_recorded), latenessAmountRecorded: num(r.lateness_amount_recorded),
        sortOrder: sort++,
      })),
      owners: forYear(forBranch(owners, b.id)).map((r) => ({ month: Number(r.month), name: r.name, fixedAmount: num(r.fixed_amount) })),
      commissionShares: forYear(forBranch(shares, b.id)).map((r) => ({ month: Number(r.month), employee: r.employee, sharePct: num(r.share_pct) })),
      history: forBranch(history, b.id).map((r) => ({
        year: Number(r.year), month: Number(r.month), days: num(r.days), grossSales: num(r.gross_sales), returns: num(r.returns),
        netSales: num(r.net_sales), grossProfit: num(r.gross_profit), invoices: num(r.invoices), itemsSold: num(r.items_sold),
        loyaltyPoints: num(r.loyalty_points), purchasesGross: num(r.purchases_gross), purchaseReturns: num(r.purchase_returns),
        salaries: num(r.salaries), opex: num(r.opex), maintenance: num(r.maintenance),
      })),
    };
  });

  return {
    companyNameAr: cfg.company.name_ar,
    companyNameEn: cfg.company.name_en,
    settings,
    expenseCategories,
    assetCategories,
    adjustmentReasons: cfg.stock_adjustment_reasons,
    branches,
    sharedExpenses: shared.map((r, i) => ({
      id: i + 1, date: str(r.date), description: r.description, categoryKey: str(r.category_key),
      amount: num(r.amount), periodOverride: num(r.period_override), notes: str(r.notes),
    })),
  };
}

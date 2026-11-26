/**
 * Input types for the finance engine. These mirror the database tables one-to-one
 * (camelCase instead of snake_case) so the web app can map rows straight in.
 * All money/quantity inputs are `number | null`: null means "not entered" (a blank
 * Excel cell), which matters for several rules (e.g. HAS_SALES, turnover blanks).
 */

export type PlClass = 'OPEX' | 'STAFF' | 'DEP';

export type CommissionTierMode =
  /** Copy of the original Excel formula: below 96% of target → 0, then 2% / 1.5% / 1% thresholds. */
  | 'original'
  /** Alternative (open decision): the 1% tier starts at 96% of target instead of threshold_1pct. */
  | 'tier1_from_96pct_target';

export type BottomLine = 'net_after_stock_losses' | 'operating_result';

export interface FiscalSettings {
  year: number;
  /** Fiscal month starts on this day of the previous calendar month (26). */
  startDay: number;
  /** Report month 1..12 – drives YTD columns, asset status, checks. */
  reportMonth: number;
  /** From this fiscal month on, lateness deductions come from the lateness log (11). */
  latenessAutoFromMonth: number;
  /** Lateness: half-day from this many minutes (inclusive) – 11. */
  latenessHalfDayFromMinutes: number;
  /** Lateness: two days if MORE than this many minutes – 30. */
  latenessTwoDaysAboveMinutes: number;
  /** Day value = round(rate_per_26h / 26 × latenessDayHours) – 8 (decision D6). */
  latenessDayHours: number;
  /** Commission 96% rule (open decision). Default 'original'. */
  commissionTierMode: CommissionTierMode;
  /** Decision D1: which line the dashboard treats as the bottom line. */
  bottomLine: BottomLine;
}

export interface ExpenseCategory {
  key: string;
  nameAr: string;
  nameEn: string;
  plClass: PlClass;
}

export interface AssetCategory {
  name: string;
  usefulLifeMonths: number | null;
}

export interface Branch {
  id: number;
  nameAr: string;
  nameEn: string;
  color: string;
  /** Manual DEP expenses are included before this month; the asset register is used from it on. */
  depreciationRegisterFromMonth: number;
  /** First fiscal month the branch operates in this year (null = operating all year). Used for data-gap hints only. */
  openedMonth?: number | null;
}

export interface OpeningBalance {
  inventoryValue: number | null;
  skuCount: number | null;
  inventoryQty: number | null;
}

export interface MonthlyInput {
  month: number;
  grossSales: number | null;
  returns: number | null;
  grossProfit: number | null;
  invoices: number | null;
  itemsSold: number | null;
  loyaltyPoints: number | null;
  /** Reconciliation only – used as the P&L salary when a month has no payroll. */
  salariesRecordedLegacy: number | null;
  purchasesGross: number | null;
  purchaseReturns: number | null;
  inventoryEndValue: number | null;
  skuEnd: number | null;
  inventoryEndQty: number | null;
  notes?: string | null;
}

export interface Expense {
  id?: string | number;
  /** ISO date YYYY-MM-DD or null. */
  date: string | null;
  description: string;
  categoryKey: string | null;
  amount: number | null;
  periodOverride: number | null;
  source?: string | null;
}

export interface StockAdjustment {
  id?: string | number;
  month: number | null;
  itemCode?: string | null;
  itemName?: string | null;
  qty: number | null;
  unit?: string | null;
  unitCost: number | null;
  manualAmount: number | null;
  reason: string | null;
  source?: string | null;
}

export interface Asset {
  id?: string | number;
  name: string;
  cost: number | null;
  category: string | null;
  customMonths: number | null;
  dateAdded: string | null;
  notes?: string | null;
}

export interface StaffMember {
  id?: string | number;
  latenessName: string;
  payrollName: string;
  role: string | null;
  /** Fiscal months (1..12) this person belongs to this branch. Undefined = all months. (Decision S2) */
  months?: number[];
}

export interface LatenessEntry {
  id?: string | number;
  date: string | null;
  employee: string;
  minutesLate: number | null;
  notes?: string | null;
}

export interface PayrollMonthHeader {
  month: number;
  salesForCommission: number | null;
  target: number | null;
  threshold1pct: number | null;
  threshold15pct: number | null;
  threshold2pct: number | null;
}

export interface PayrollLine {
  id?: string | number;
  month: number;
  employee: string;
  role: string | null;
  baseHours: number | null;
  actualHours: number | null;
  ratePer26h: number | null;
  deductions: number | null;
  additions: number | null;
  additionsDetails?: string | null;
  deductionsDetails?: string | null;
  latenessDaysRecorded: number | null;
  latenessAmountRecorded: number | null;
  sortOrder?: number;
}

export interface OwnerLine {
  id?: string | number;
  month: number;
  name: string;
  fixedAmount: number | null;
}

export interface CommissionShare {
  id?: string | number;
  month: number;
  employee: string;
  sharePct: number | null;
}

export interface HistoryRow {
  id?: string | number;
  year: number;
  month: number;
  days: number | null;
  grossSales: number | null;
  returns: number | null;
  netSales: number | null;
  grossProfit: number | null;
  invoices: number | null;
  itemsSold: number | null;
  loyaltyPoints?: number | null;
  purchasesGross?: number | null;
  purchaseReturns?: number | null;
  salaries?: number | null;
  opex?: number | null;
  maintenance?: number | null;
}

export interface SharedExpense {
  id?: string | number;
  date: string | null;
  description: string;
  categoryKey: string | null;
  amount: number | null;
  periodOverride: number | null;
  notes?: string | null;
}

/** One employee line of the existing app's payroll page (ElKareem app → كشف الرواتب). */
export interface LinkedPayrollLine {
  empId?: string | null;
  employee: string;
  role?: string | null;
  hours: number | null;
  salary: number;
  commission: number;
  bonuses: number;
  penalties: number;
  withdrawals: number;
  net: number;
}

export interface LinkedPayrollMonth {
  month: number;
  lines: LinkedPayrollLine[];
  /** The app's monthly sales and commission pool, shown for reference. */
  sales?: number | null;
  commissionPool?: number | null;
  commissionLabel?: string | null;
}

/**
 * Decision (owners, Nov 2026): from `fromMonth` on, the P&L salaries of this branch come from the
 * app's payroll (Σ net of its lines) + the owners' fixed salaries. Earlier months keep the finance payroll.
 */
export interface LinkedPayroll {
  fromMonth: number;
  months: LinkedPayrollMonth[];
}

export interface BranchDataset {
  branch: Branch;
  opening: OpeningBalance | null;
  monthly: MonthlyInput[];
  expenses: Expense[];
  stockAdjustments: StockAdjustment[];
  assets: Asset[];
  staff: StaffMember[];
  lateness: LatenessEntry[];
  payrollMonths: PayrollMonthHeader[];
  payrollLines: PayrollLine[];
  owners: OwnerLine[];
  commissionShares: CommissionShare[];
  history: HistoryRow[];
  /** Payroll taken from the existing app (null/undefined = finance payroll for every month). */
  linkedPayroll?: LinkedPayroll | null;
}

export interface CompanyDataset {
  companyNameAr: string;
  companyNameEn: string;
  settings: FiscalSettings;
  expenseCategories: ExpenseCategory[];
  assetCategories: AssetCategory[];
  adjustmentReasons: string[];
  branches: BranchDataset[];
  sharedExpenses: SharedExpense[];
}

/**
 * Ledger definitions (tables fin_*): one description per editable table drives the generic grid, add/edit forms,
 * Excel/CSV import (with per-row validation) and export. Validation is done with Zod.
 */
import { z } from 'zod';

export type FieldType = 'text' | 'number' | 'int' | 'date' | 'month' | 'pct' | 'category' | 'reason' | 'assetCategory' | 'staffLateness';

export interface LedgerField {
  name: string;
  ar: string;
  en: string;
  type: FieldType;
  required?: boolean;
  /** Hidden in the grid (still imported/exported). */
  hidden?: boolean;
  /** Accepted import header aliases (lower-cased). */
  aliases?: string[];
}

export interface LedgerDef {
  key: string;
  table: string;
  scope: 'branch' | 'company';
  ar: string;
  en: string;
  /** Column holding the fiscal year (set automatically). */
  yearColumn?: 'year' | 'fiscal_year';
  /** Ledger is filtered to one month (payroll tabs). */
  monthColumn?: 'month';
  fields: LedgerField[];
  orderBy: string;
}

const F = (name: string, ar: string, en: string, type: FieldType, extra: Partial<LedgerField> = {}): LedgerField => ({ name, ar, en, type, ...extra });

export const LEDGERS: Record<string, LedgerDef> = {
  expenses: {
    key: 'expenses', table: 'fin_expenses', scope: 'branch', yearColumn: 'fiscal_year', ar: 'دفتر المصروفات التشغيلية', en: 'Operating expenses',
    orderBy: 'coalesce(period_override, 0), date nulls last, id',
    fields: [
      F('date', 'التاريخ', 'Date', 'date'),
      F('description', 'البيان', 'Description', 'text', { required: true }),
      F('category_key', 'التصنيف', 'Category', 'category', { required: true, aliases: ['category', 'التصنيف', 'category_ar'] }),
      F('amount', 'القيمة (ج.م)', 'Amount EGP', 'number', { required: true }),
      F('period_override', 'الشهر (تعديل يدوي)', 'Period override', 'month'),
      F('source', 'المصدر / ملاحظات', 'Source / notes', 'text'),
    ],
  },
  stock: {
    key: 'stock', table: 'fin_stock_adjustments', scope: 'branch', yearColumn: 'year', ar: 'التوالف وتسويات المخزون', en: 'Stock adjustments',
    orderBy: 'month, id',
    fields: [
      F('month', 'الشهر المالي', 'Period', 'month', { required: true }),
      F('item_code', 'كود الصنف', 'Item code', 'text'),
      F('item_name', 'اسم الصنف', 'Item', 'text'),
      F('qty', 'الكمية', 'Qty', 'number'),
      F('unit', 'الوحدة', 'Unit', 'text'),
      F('unit_cost', 'تكلفة الوحدة', 'Unit cost', 'number'),
      F('manual_amount', 'مبلغ يدوي', 'Manual amount', 'number'),
      F('reason', 'السبب', 'Reason', 'reason', { required: true }),
      F('source', 'المصدر', 'Source', 'text'),
    ],
  },
  assets: {
    key: 'assets', table: 'fin_assets', scope: 'branch', ar: 'سجل الأصول', en: 'Asset register', orderBy: 'date_added nulls last, id',
    fields: [
      F('name', 'اسم الأصل', 'Asset', 'text', { required: true }),
      F('cost', 'التكلفة', 'Cost', 'number', { required: true }),
      F('category', 'الفئة', 'Category', 'assetCategory', { required: true }),
      F('custom_months', 'مدة مخصصة (شهور)', 'Custom months', 'int'),
      F('date_added', 'تاريخ الإضافة', 'Date added', 'date', { required: true }),
      F('notes', 'ملاحظات', 'Notes', 'text'),
    ],
  },
  lateness: {
    key: 'lateness', table: 'fin_lateness', scope: 'branch', ar: 'سجل التأخير', en: 'Lateness log', orderBy: 'date, id',
    fields: [
      F('date', 'التاريخ', 'Date', 'date', { required: true }),
      F('employee', 'اسم الموظف', 'Employee', 'staffLateness', { required: true }),
      F('minutes_late', 'دقائق التأخير', 'Minutes late', 'int', { required: true }),
      F('notes', 'ملاحظات', 'Notes', 'text'),
    ],
  },
  payroll_lines: {
    key: 'payroll_lines', table: 'fin_payroll_lines', scope: 'branch', yearColumn: 'year', monthColumn: 'month', ar: 'كشف المرتبات', en: 'Payroll lines',
    orderBy: 'sort_order, id',
    fields: [
      F('employee', 'اسم الموظف', 'Employee', 'text', { required: true }),
      F('role', 'الوظيفة', 'Role', 'text'),
      F('base_hours', 'عدد الساعات الأساسي', 'Base hours', 'number'),
      F('actual_hours', 'عدد الساعات الفعلي', 'Actual hours', 'number'),
      F('rate_per_26h', 'سعر الساعة (×26 ساعة)', 'Rate (×26 h)', 'number'),
      F('deductions', 'خصومات', 'Deductions', 'number'),
      F('additions', 'إضافات', 'Additions', 'number'),
      F('additions_details', 'تفاصيل الإضافات', 'Additions details', 'text'),
      F('deductions_details', 'تفاصيل الخصومات', 'Deductions details', 'text'),
      F('lateness_days_recorded', 'أيام التأخير (مسجلة)', 'Lateness days (recorded)', 'number'),
      F('lateness_amount_recorded', 'خصم التأخير (مسجل)', 'Lateness amount (recorded)', 'number'),
      F('sort_order', 'الترتيب', 'Order', 'int', { hidden: true }),
    ],
  },
  owners: {
    key: 'owners', table: 'fin_payroll_owner_lines', scope: 'branch', yearColumn: 'year', monthColumn: 'month', ar: 'مرتبات الملاك', en: 'Owner salaries',
    orderBy: 'id',
    fields: [F('name', 'الاسم', 'Name', 'text', { required: true }), F('fixed_amount', 'المبلغ الثابت', 'Fixed amount', 'number', { required: true })],
  },
  shares: {
    key: 'shares', table: 'fin_commission_shares', scope: 'branch', yearColumn: 'year', monthColumn: 'month', ar: 'نسب العمولة', en: 'Commission shares',
    orderBy: 'sort_order, id',
    fields: [F('employee', 'اسم الموظف', 'Employee', 'text', { required: true }), F('share_pct', 'النسبة', 'Share %', 'pct'), F('sort_order', 'الترتيب', 'Order', 'int', { hidden: true })],
  },
  history: {
    key: 'history', table: 'fin_history_monthly', scope: 'branch', ar: 'السجل التاريخي', en: 'History', orderBy: 'year, month',
    fields: [
      F('year', 'السنة', 'Year', 'int', { required: true }), F('month', 'الشهر', 'Month', 'month', { required: true }), F('days', 'الأيام', 'Days', 'int'),
      F('gross_sales', 'إجمالي المبيعات', 'Gross sales', 'number'), F('returns', 'المرتجعات', 'Returns', 'number'),
      F('net_sales', 'صافي المبيعات', 'Net sales', 'number'), F('gross_profit', 'مجمل الربح', 'Gross profit', 'number'),
      F('invoices', 'عدد الفواتير', 'Invoices', 'int'), F('items_sold', 'عدد الأصناف', 'Items sold', 'int'),
      F('loyalty_points', 'النقاط', 'Points', 'number'), F('purchases_gross', 'المشتريات', 'Purchases', 'number'),
      F('purchase_returns', 'مرتجع المشتريات', 'Purchase returns', 'number'), F('salaries', 'المرتبات', 'Salaries', 'number'),
      F('opex', 'مصروفات', 'Opex', 'number'), F('maintenance', 'صيانة', 'Maintenance', 'number'),
    ],
  },
  shared: {
    key: 'shared', table: 'fin_shared_expenses', scope: 'company', yearColumn: 'fiscal_year', ar: 'المصروفات المشتركة', en: 'Shared company expenses',
    orderBy: 'coalesce(period_override, 0), date nulls last, id',
    fields: [
      F('date', 'التاريخ', 'Date', 'date'),
      F('description', 'البيان', 'Description', 'text', { required: true }),
      F('category_key', 'التصنيف', 'Category', 'category'),
      F('amount', 'القيمة (ج.م)', 'Amount EGP', 'number', { required: true }),
      F('period_override', 'الشهر (تعديل يدوي)', 'Period override', 'month'),
      F('notes', 'ملاحظات / أساس التوزيع المقترح', 'Notes / suggested allocation basis', 'text'),
    ],
  },
};

// ------------------------------------------------------------------------------------ parsing

export interface Lookups {
  categories: { key: string; nameAr: string; nameEn: string }[];
  reasons: string[];
  assetCategories: string[];
  staffLatenessNames: string[];
}

const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '') return null;
  // Arabic-Indic digits → Western, thousands separators, parentheses negatives
  s = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٫/g, '.').replace(/[,٬\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? (neg ? -n : n) / 100 : NaN;
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
};

const toDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return 'invalid';
};

/** Builds the Zod schema for a ledger row from its field list + lookups. */
export function ledgerSchema(def: LedgerDef, lk: Lookups) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of def.fields) {
    let s: z.ZodTypeAny;
    switch (f.type) {
      case 'number':
        s = z.preprocess(toNumber, z.number({ error: 'رقم غير صحيح / invalid number' }).nullable());
        break;
      case 'pct':
        s = z.preprocess(toNumber, z.number().min(0).max(1, 'النسبة بين 0 و 1 / share must be 0–1').nullable());
        break;
      case 'int':
        s = z.preprocess(toNumber, z.number().int('عدد صحيح / whole number').nullable());
        break;
      case 'month':
        s = z.preprocess(toNumber, z.number().int().min(1, 'الشهر 1–12 / month 1–12').max(12, 'الشهر 1–12 / month 1–12').nullable());
        break;
      case 'date':
        s = z.preprocess(toDate, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صحيح / invalid date').nullable());
        break;
      case 'category':
        s = z.preprocess((v) => {
          if (v === null || v === undefined || String(v).trim() === '') return null;
          const t = String(v).trim();
          const hit = lk.categories.find((c) => c.key === t || c.nameAr === t || c.nameEn.toLowerCase() === t.toLowerCase());
          return hit ? hit.key : `?${t}`;
        }, z.string().refine((x) => !x.startsWith('?'), 'تصنيف غير معروف / unknown category').nullable());
        break;
      case 'reason':
        s = z.preprocess((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()),
          z.string().refine((x) => lk.reasons.includes(x), 'سبب غير معروف / unknown reason').nullable());
        break;
      case 'assetCategory':
        s = z.preprocess((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()),
          z.string().refine((x) => lk.assetCategories.includes(x), 'فئة غير معروفة / unknown asset category').nullable());
        break;
      case 'staffLateness':
        s = z.preprocess((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()),
          z.string().refine((x) => lk.staffLatenessNames.length === 0 || lk.staffLatenessNames.includes(x),
            'الاسم غير موجود في قائمة الموظفين / name not in the staff list').nullable());
        break;
      default:
        s = z.preprocess((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()), z.string().nullable());
    }
    if (f.required) s = s.refine((x) => x !== null && x !== undefined, 'مطلوب / required');
    shape[f.name] = s;
  }
  return z.object(shape);
}

export interface ParsedRow {
  index: number;
  data: Record<string, unknown> | null;
  errors: string[];
  raw: Record<string, unknown>;
}

/** Maps imported rows (header → value) to ledger fields and validates each row. */
export function validateRows(def: LedgerDef, lk: Lookups, rows: Record<string, unknown>[]): ParsedRow[] {
  const schema = ledgerSchema(def, lk);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return rows.map((raw, index) => {
    const mapped: Record<string, unknown> = {};
    for (const f of def.fields) {
      const keys = [f.name, f.ar, f.en, ...(f.aliases ?? [])].map(norm);
      const hit = Object.keys(raw).find((k) => keys.includes(norm(k)) || keys.includes(norm(k.split('\n')[0])));
      mapped[f.name] = hit === undefined ? null : raw[hit];
    }
    const r = schema.safeParse(mapped);
    if (r.success) return { index, data: r.data, errors: [], raw };
    return {
      index, data: null, raw,
      errors: r.error.issues.map((i) => {
        const f = def.fields.find((x) => x.name === i.path[0]);
        return `${f ? `${f.ar} / ${f.en}` : i.path.join('.')}: ${i.message}`;
      }),
    };
  });
}


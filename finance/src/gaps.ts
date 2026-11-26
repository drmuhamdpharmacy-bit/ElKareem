import type { CompanyResult } from './company';

export interface DataGap {
  branchId: number | null;
  kind: 'missing_expired' | 'missing_items' | 'missing_sales' | 'missing_purchases' | 'missing_inventory' | 'missing_payroll' | 'possible_duplicate';
  months: number[];
  ar: string;
  en: string;
}

/**
 * Known data gaps (§11). Never invents values – it only lists what is missing so the user can see it.
 */
export function dataGaps(c: CompanyResult): DataGap[] {
  const gaps: DataGap[] = [];
  const R = c.reportMonth;
  for (const b of c.branches) {
    const id = b.branchId;
    const from = b.dataset.branch.openedMonth ?? 1;
    const range = Array.from({ length: Math.max(0, R - from + 1) }, (_, i) => from + i);
    const monthsWhere = (f: (m: number) => boolean) => range.filter(f);
    const push = (kind: DataGap['kind'], months: number[], ar: string, en: string) => {
      if (months.length) gaps.push({ branchId: id, kind, months, ar, en });
    };
    const mi = (m: number) => b.monthly[m - 1];
    push('missing_sales', monthsWhere((m) => !mi(m) || mi(m)!.grossSales === null), 'لا توجد أرقام مبيعات', 'No sales figures');
    push('missing_purchases', monthsWhere((m) => !mi(m) || mi(m)!.purchasesGross === null), 'لا توجد أرقام مشتريات', 'No purchases figures');
    push('missing_inventory', monthsWhere((m) => !mi(m) || mi(m)!.inventoryEndValue === null), 'لا يوجد مخزون آخر الشهر', 'No closing inventory');
    push('missing_items', monthsWhere((m) => !!mi(m) && mi(m)!.grossSales !== null && mi(m)!.itemsSold === null),
      'عدد الأصناف المباعة غير مُدخل', 'Items sold not entered');
    push('missing_expired', monthsWhere((m) => !!mi(m) && mi(m)!.grossSales !== null && !b.stock.some((s) => s.adjustment.month === m)),
      'لا توجد قيمة توالف/إكسبير', 'No expired/damaged value');
    push('missing_payroll', monthsWhere((m) => !b.payroll[m - 1].hasLines && !(mi(m)?.salariesRecordedLegacy)),
      'لا يوجد كشف مرتبات', 'No payroll');

    // Possible duplicates: an undated (override-only) line matching a dated line with the same
    // description, category and amount in the same or an adjacent period.
    for (const e of b.expenses) {
      if (e.expense.date || e.period === null) continue;
      const twin = b.expenses.find(
        (o) => o !== e && o.expense.date && o.expense.description.trim() === e.expense.description.trim() &&
          o.expense.amount === e.expense.amount && o.expense.categoryKey === e.expense.categoryKey &&
          o.period !== null && Math.abs(o.period - e.period!) <= 1,
      );
      if (twin) {
        gaps.push({
          branchId: id, kind: 'possible_duplicate', months: [e.period, twin.period!].sort((a, z) => a - z),
          ar: `تكرار محتمل: «${e.expense.description} ${e.expense.amount}»`,
          en: `Possible duplicate: "${e.expense.description} ${e.expense.amount}"`,
        });
      }
    }
  }
  return gaps;
}

import { D, DN, Decimal, ZERO, sum } from './decimal';
import { periodOrNull } from './fiscal';
import { dayValue, latenessDays, salaryByHours, teamCommission } from './rules';
import type {
  LinkedPayrollLine, LinkedPayrollMonth,
  CommissionShare, FiscalSettings, LatenessEntry, OwnerLine, PayrollLine, PayrollMonthHeader, StaffMember,
} from './types';

export interface LatenessRow {
  entry: LatenessEntry;
  period: number | null;
  days: number;
  /** 'half_day' | 'two_days' | '' */
  deduction: '' | 'half_day' | 'two_days';
  /** Staff payroll name this entry maps to (null = not in the staff list). */
  payrollName: string | null;
  warning: '' | 'unknown_employee' | 'no_date';
}

export function computeLateness(entries: LatenessEntry[], staff: StaffMember[], s: FiscalSettings): LatenessRow[] {
  return entries.map((entry) => {
    const period = periodOrNull(entry.date, s.year, s.startDay);
    const days = latenessDays(entry.minutesLate, s);
    const member = staff.find(
      (m) => m.latenessName === entry.employee && (period === null || !m.months || m.months.includes(period)),
    ) ?? staff.find((m) => m.latenessName === entry.employee);
    return {
      entry,
      period,
      days,
      deduction: days === 2 ? 'two_days' : days === 0.5 ? 'half_day' : '',
      payrollName: member?.payrollName ?? null,
      warning: !member ? 'unknown_employee' : period === null ? 'no_date' : '',
    };
  });
}

export interface PayrollLineResult {
  line: PayrollLine;
  salaryByHours: Decimal | null;
  commission: Decimal;
  dayValue: Decimal | null;
  latenessDays: Decimal | null;
  latenessAmount: Decimal | null;
  netPay: Decimal;
  hoursDifference: Decimal | null;
  /** true if lateness came from the log (month ≥ latenessAutoFromMonth). */
  latenessFromLog: boolean;
}

export interface ShareResult {
  share: CommissionShare;
  amount: Decimal | null;
  /** The share's name matches no payroll line this month. */
  unmatched: boolean;
}

export interface PayrollMonthResult {
  month: number;
  header: PayrollMonthHeader | null;
  lines: PayrollLineResult[];
  owners: { line: OwnerLine; amount: Decimal }[];
  shares: ShareResult[];
  teamCommission: Decimal;
  totals: {
    salaryByHours: Decimal;
    commission: Decimal;
    additions: Decimal;
    deductions: Decimal;
    lateness: Decimal;
    owners: Decimal;
    employees: Decimal;
    /** Σ net pay + Σ owners – the P&L "Salaries" line when non-zero. */
    payroll: Decimal;
    actualHours: Decimal;
  };
  sharesPct: Decimal;
  sharesTotal: Decimal;
  /** Team commission − Σ distributed shares. */
  undistributed: Decimal;
  /** Σ shares − Σ commission in salaries (non-zero when a share name matches no employee). */
  calculatedNotPaid: Decimal;
  hasLines: boolean;
  /** 'finance' = this module's payroll lines; 'app' = taken from the existing app's payroll page. */
  source: 'finance' | 'app';
  /** Lines from the app (source = 'app'). */
  appLines: LinkedPayrollLine[];
  appMonth: LinkedPayrollMonth | null;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase(); // Excel SUMIF is case-insensitive

export function computePayrollMonth(args: {
  month: number;
  header: PayrollMonthHeader | null;
  lines: PayrollLine[];
  owners: OwnerLine[];
  shares: CommissionShare[];
  staff: StaffMember[];
  lateness: LatenessRow[];
  settings: FiscalSettings;
}): PayrollMonthResult {
  const { month, header, settings: s } = args;
  const team = header ? teamCommission(header, s.commissionTierMode) : ZERO;
  const shares: ShareResult[] = args.shares.map((share) => ({
    share,
    amount: share.sharePct === null ? null : team.times(share.sharePct),
    unmatched: !args.lines.some((l) => sameName(l.employee, share.employee)),
  }));
  const auto = month >= s.latenessAutoFromMonth;

  const lines: PayrollLineResult[] = [...args.lines]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((line) => {
      const salary = salaryByHours(line.ratePer26h, line.actualHours);
      const commission = sum(shares.filter((x) => sameName(x.share.employee, line.employee)).map((x) => x.amount));
      const dv = dayValue(line.ratePer26h, s.latenessDayHours);
      let lDays: Decimal | null;
      let lAmount: Decimal | null;
      if (auto) {
        const member = args.staff.find((m) => m.payrollName === line.employee);
        lDays = member
          ? sum(args.lateness.filter((r) => r.period === month && r.entry.employee === member.latenessName).map((r) => D(r.days)))
          : ZERO;
        lAmount = dv === null ? null : dv.times(lDays);
      } else {
        lDays = DN(line.latenessDaysRecorded);
        lAmount = DN(line.latenessAmountRecorded);
      }
      const net = D(salary).plus(commission).plus(D(line.additions)).minus(D(line.deductions)).minus(D(lAmount));
      return {
        line,
        salaryByHours: salary,
        commission,
        dayValue: dv,
        latenessDays: lDays,
        latenessAmount: lAmount,
        netPay: net,
        hoursDifference: line.baseHours !== null && line.actualHours !== null ? D(line.actualHours).minus(line.baseHours) : null,
        latenessFromLog: auto,
      };
    });

  const owners = args.owners.map((line) => ({ line, amount: D(line.fixedAmount) }));
  const ownersTotal = sum(owners.map((o) => o.amount));
  const employees = sum(lines.map((l) => l.netPay));
  const commissionTotal = sum(lines.map((l) => l.commission));
  const sharesTotal = sum(shares.map((x) => x.amount));

  return {
    month,
    header,
    lines,
    owners,
    shares,
    teamCommission: team,
    totals: {
      salaryByHours: sum(lines.map((l) => l.salaryByHours)),
      commission: commissionTotal,
      additions: sum(lines.map((l) => D(l.line.additions))),
      deductions: sum(lines.map((l) => D(l.line.deductions))),
      lateness: sum(lines.map((l) => l.latenessAmount)),
      owners: ownersTotal,
      employees,
      payroll: employees.plus(ownersTotal),
      actualHours: sum(lines.map((l) => D(l.line.actualHours))),
    },
    sharesPct: sum(args.shares.map((x) => D(x.sharePct))),
    sharesTotal,
    undistributed: team.minus(sharesTotal),
    calculatedNotPaid: sharesTotal.minus(commissionTotal),
    hasLines: lines.length + owners.length > 0,
    source: 'finance',
    appLines: [],
    appMonth: null,
  };
}

/** A month whose employee payroll comes from the existing app; owners' fixed salaries are added here. */
export function linkedPayrollMonth(month: number, app: LinkedPayrollMonth | null, ownerLines: OwnerLine[]): PayrollMonthResult {
  const lines = app?.lines ?? [];
  const owners = ownerLines.map((line) => ({ line, amount: D(line.fixedAmount) }));
  const ownersTotal = sum(owners.map((o) => o.amount));
  const employees = sum(lines.map((l) => D(l.net)));
  const commission = sum(lines.map((l) => D(l.commission)));
  return {
    month,
    header: null,
    lines: [],
    owners,
    shares: [],
    teamCommission: D(app?.commissionPool ?? 0),
    totals: {
      salaryByHours: sum(lines.map((l) => D(l.salary))),
      commission,
      additions: sum(lines.map((l) => D(l.bonuses))),
      deductions: sum(lines.map((l) => D(l.penalties).plus(D(l.withdrawals)))),
      lateness: ZERO,
      owners: ownersTotal,
      employees,
      payroll: employees.plus(ownersTotal),
      actualHours: sum(lines.map((l) => D(l.hours))),
    },
    sharesPct: ZERO,
    sharesTotal: commission,
    undistributed: ZERO,
    calculatedNotPaid: ZERO,
    hasLines: lines.length + owners.length > 0,
    source: 'app',
    appLines: lines,
    appMonth: app,
  };
}

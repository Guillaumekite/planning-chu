// Domain types for the scheduling engine.
// The engine is PURE and DETERMINISTIC: no Date.now(), no Math.random(), no locale.
// All time-relative facts (weekday, holidays, carryover) are passed in as data.

export type DoctorId = string;

/** 0 = Monday … 6 = Sunday (ISO-ish, Monday-first to match French planning). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One calendar day inside a generated month. `day` is 1-based. */
export interface CalendarDay {
  day: number;
  weekday: Weekday;
  isWeekend: boolean; // Saturday or Sunday — used for the "≥1 WE garde / month" rule
  isHoliday: boolean;
  /** Pénibilité weight for an on-call (garde) that day. */
  penibility: number;
}

export interface GardeWeights {
  /** Penibility per weekday (index 0 = Monday … 6 = Sunday). Calibrable. */
  perWeekday: [number, number, number, number, number, number, number];
  /** Holidays are treated at least as heavy as this. */
  holiday: number;
  /** Penalty per doctor lacking a weekend garde in the month (soft). */
  weekendDeficit: number;
  /** Reward (negative cost) for honoring an explicit "garde svp" wish. */
  wishHonored: number;
}

export const DEFAULT_WEIGHTS: GardeWeights = {
  perWeekday: [1, 1, 1, 2, 2, 3, 3], // Mon-Wed=1, Thu/Fri=2, Sat/Sun=3
  holiday: 3,
  weekendDeficit: 4,
  wishHonored: 0.5,
};

export interface GardeInput {
  year: number;
  month: number; // 1-12
  doctors: DoctorId[];
  /** Days (1-based) that are public holidays. */
  holidays?: number[];
  /** Per doctor: set of days (1-based) where a garde is forbidden (congé, indispo garde, nouveau, absent). */
  gardeBlocked?: Record<DoctorId, number[]>;
  /** Per doctor: cumulative garde COUNT from previous months (count fairness across months). */
  carryCount?: Record<DoctorId, number>;
  /** Per doctor: cumulative "heavy" (Thu→Sun) garde count from previous months. */
  carryHeavy?: Record<DoctorId, number>;
  /** Per doctor: cumulative weekend (Sat/Sun) garde count from previous months (WE rotation). */
  carryWeekend?: Record<DoctorId, number>;
  /** Per doctor: days (1-based) the doctor explicitly WISHES a garde (garde svp). */
  wishes?: Record<DoctorId, number[]>;
  /** Per doctor: full-time-equivalent fraction (0-1). Part-timers get proportionally fewer gardes. Default 1. */
  fte?: Record<DoctorId, number>;
  weights?: Partial<GardeWeights>;
  /** Solver time budget per month (seconds). Default 6. */
  timeLimitSec?: number;
  /** Relative MIP gap tolerance for early stop. Default 0.03. */
  mipGap?: number;
}

/** One garde assignment: doctor `id` is on garde of `role` on `day`. */
export interface GardeAssignment {
  day: number;
  role: 'G1' | 'G2';
  doctorId: DoctorId;
  /** Human-readable explanation feeding the trust layer ("pourquoi cette garde"). */
  reason: string;
}

export interface EquityReport {
  /** Garde count per doctor THIS month. */
  count: Record<DoctorId, number>;
  /** Weekend (Sat/Sun) gardes per doctor this month. */
  weekendCount: Record<DoctorId, number>;
  /** "Heavy" (Thu→Sun) gardes per doctor this month. */
  heavyCount: Record<DoctorId, number>;
  /** Cumulative garde count (carry + this month) — feeds next month's carryCount. */
  cumulativeCount: Record<DoctorId, number>;
  /** Cumulative heavy count (carry + this month) — feeds next month's carryHeavy. */
  cumulativeHeavy: Record<DoctorId, number>;
  /** Cumulative weekend count (carry + this month) — feeds next month's carryWeekend. */
  cumulativeWeekend: Record<DoctorId, number>;
  /** Max - min cumulative garde count across doctors — headline fairness metric (lower = fairer). */
  spread: number;
}

export type GardeResult =
  | { status: 'feasible'; assignments: GardeAssignment[]; equity: EquityReport }
  | {
      status: 'infeasible';
      day: number;
      reason: string;
      /** Doctors that were eligible that day (the minimal conflict hint). */
      eligible: DoctorId[];
    };

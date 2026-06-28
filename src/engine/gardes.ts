// Phase A — Garde (on-call) skeleton. Hybrid engine:
//   1. GLPK (MILP, WASM) decides FEASIBILITY and returns a legal starting schedule fast.
//      Hard constraints (1 G1+1 G2/day, RS rest, blocked days, weekend coverage) are guaranteed
//      by the model. Infeasibility is a first-class result (UNSAT), never a broken schedule.
//   2. Deterministic local search (steepest descent, no wall-clock, no RNG) polishes the soft
//      EQUITY objective by swapping gardes between doctors while preserving every hard constraint.
// This avoids the symmetry blow-up of solving minimax-equity to MILP optimality, while keeping
// output fully deterministic (same input ⇒ same result, Node ↔ browser).

import GLPKFactory from 'glpk.js/node';
import { buildMonth } from './calendar';
import {
  DEFAULT_WEIGHTS,
  type GardeInput,
  type GardeResult,
  type GardeAssignment,
  type GardeWeights,
  type DoctorId,
  type EquityReport,
  type CalendarDay,
} from './types';

const FR_WEEKDAY = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

type GLPK = Awaited<ReturnType<typeof GLPKFactory>>;
let glpkPromise: Promise<GLPK> | null = null;
function getGlpk(): Promise<GLPK> {
  if (!glpkPromise) glpkPromise = Promise.resolve(GLPKFactory());
  return glpkPromise;
}

function gv(day: number, doctor: DoctorId): string {
  return `g_${day}_${doctor}`;
}

export async function solveGardes(input: GardeInput): Promise<GardeResult> {
  const weights: GardeWeights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const days = buildMonth(input.year, input.month, weights, input.holidays ?? []);
  const doctors = input.doctors;
  const blocked = input.gardeBlocked ?? {};
  const carryCount = input.carryCount ?? {};
  const carryHeavy = input.carryHeavy ?? {};
  const carryWeekend = input.carryWeekend ?? {};
  const wishes = input.wishes ?? {};

  const isBlocked = (d: number, doc: DoctorId) => (blocked[doc] ?? []).includes(d);
  const wants = (d: number, doc: DoctorId) => (wishes[doc] ?? []).includes(d);

  // Pre-check: each day needs ≥ 2 eligible doctors, else provably infeasible.
  for (const cd of days) {
    const eligible = doctors.filter((doc) => !isBlocked(cd.day, doc));
    if (eligible.length < 2) {
      return {
        status: 'infeasible',
        day: cd.day,
        reason: `Le ${cd.day} (${FR_WEEKDAY[cd.weekday]}) : 2 gardes requises (G1+G2) mais ${eligible.length} médecin(s) éligible(s).`,
        eligible,
      };
    }
  }

  // ---- Step 1: feasibility MILP (fast) ----
  const feasible = await solveFeasibility(input, days, weights);
  if (!feasible) {
    let tightest = days[0];
    let minEligible = Infinity;
    for (const cd of days) {
      const e = doctors.filter((doc) => !isBlocked(cd.day, doc)).length;
      if (e < minEligible) {
        minEligible = e;
        tightest = cd;
      }
    }
    return {
      status: 'infeasible',
      day: tightest.day,
      reason:
        `Aucun planning légal de gardes trouvé (souvent une contrainte de repos sur une période tendue). ` +
        `Jour le plus contraint : ${tightest.day} (${FR_WEEKDAY[tightest.weekday]}), ${minEligible} médecin(s) éligible(s).`,
      eligible: doctors.filter((doc) => !isBlocked(tightest.day, doc)),
    };
  }

  // ---- Step 2: deterministic local-search equity polishing ----
  // `assigned[dayIndex]` = the 2 doctor ids on garde that day (from the feasible solution).
  const assigned: DoctorId[][] = days.map((cd) =>
    doctors.filter((doc) => !isBlocked(cd.day, doc) && feasible[gv(cd.day, doc)]),
  );
  polishEquity(days, doctors, assigned, blocked, carryCount, carryHeavy, carryWeekend, input.fte ?? {});

  // ---- Build result ----
  const count: Record<DoctorId, number> = {};
  const weekendCount: Record<DoctorId, number> = {};
  const heavyCount: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    count[doc] = 0;
    weekendCount[doc] = 0;
    heavyCount[doc] = 0;
  }
  const assignments: GardeAssignment[] = [];
  days.forEach((cd, di) => {
    const heavy = isHeavy(cd);
    const chosen = [...assigned[di]].sort((a, b) => a.localeCompare(b));
    chosen.forEach((doc, idx) => {
      const role = idx === 0 ? 'G1' : 'G2';
      const reason =
        `${role} le ${cd.day} (${FR_WEEKDAY[cd.weekday]}${heavy ? ', jour pénible' : ''})` +
        (wants(cd.day, doc) ? ' — vœu honoré' : ' — répartition équilibrée parmi les éligibles');
      assignments.push({ day: cd.day, role, doctorId: doc, reason });
      count[doc] += 1;
      if (cd.isWeekend) weekendCount[doc] += 1;
      if (heavy) heavyCount[doc] += 1;
    });
  });

  const cumulativeCount: Record<DoctorId, number> = {};
  const cumulativeHeavy: Record<DoctorId, number> = {};
  const cumulativeWeekend: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    cumulativeCount[doc] = (carryCount[doc] ?? 0) + count[doc];
    cumulativeHeavy[doc] = (carryHeavy[doc] ?? 0) + heavyCount[doc];
    cumulativeWeekend[doc] = (carryWeekend[doc] ?? 0) + weekendCount[doc];
  }
  const cums = Object.values(cumulativeCount);
  const equity: EquityReport = {
    count,
    weekendCount,
    heavyCount,
    cumulativeCount,
    cumulativeHeavy,
    cumulativeWeekend,
    spread: Math.max(...cums) - Math.min(...cums),
  };
  return { status: 'feasible', assignments, equity };
}

/** A "heavy" (penible) garde day: Thursday→Sunday (weekday index 3..6). */
function isHeavy(cd: CalendarDay): boolean {
  return cd.weekday >= 3;
}

/** Solve the feasibility MILP. Returns a map of chosen g-vars, or null if infeasible. */
async function solveFeasibility(
  input: GardeInput,
  days: CalendarDay[],
  weights: GardeWeights,
): Promise<Record<string, boolean> | null> {
  const glpk = await getGlpk();
  const doctors = input.doctors;
  const blocked = input.gardeBlocked ?? {};
  const isBlocked = (d: number, doc: DoctorId) => (blocked[doc] ?? []).includes(d);

  type Term = { name: string; coef: number };
  const dayVars: Record<number, Term[]> = {};
  const wedefVars: Record<DoctorId, Term[]> = {};
  const rsRows: { name: string; vars: Term[] }[] = [];
  const binaries: string[] = [];
  const objVars: Term[] = [];

  for (const cd of days) dayVars[cd.day] = [];
  for (const doc of doctors) {
    wedefVars[doc] = [{ name: `deficit_${doc}`, coef: 1 }];
    objVars.push({ name: `deficit_${doc}`, coef: weights.weekendDeficit });
  }
  for (const cd of days) {
    for (const doc of doctors) {
      if (isBlocked(cd.day, doc)) continue;
      const name = gv(cd.day, doc);
      binaries.push(name);
      dayVars[cd.day].push({ name, coef: 1 });
      if (cd.isWeekend) wedefVars[doc].push({ name, coef: 1 });
    }
  }
  // Rest rule: garde → RS → worked day (not garde). So in ANY 3 consecutive calendar days a
  // doctor may hold at most ONE garde → minimum gap of 3 days between a doctor's gardes.
  for (let k = 0; k < days.length; k++) {
    const window = [days[k], days[k + 1], days[k + 2]].filter(Boolean);
    if (window.length < 2) continue;
    for (const doc of doctors) {
      const vars = window.filter((cd) => !isBlocked(cd.day, doc)).map((cd) => ({ name: gv(cd.day, doc), coef: 1 }));
      if (vars.length >= 2) rsRows.push({ name: `gap_${days[k].day}_${doc}`, vars });
    }
  }

  const subjectTo: { name: string; vars: Term[]; bnds: { type: number; lb: number; ub: number } }[] = [];
  for (const cd of days) subjectTo.push({ name: `day_${cd.day}`, vars: dayVars[cd.day], bnds: { type: glpk.GLP_FX, lb: 2, ub: 2 } });
  for (const doc of doctors) subjectTo.push({ name: `wedef_${doc}`, vars: wedefVars[doc], bnds: { type: glpk.GLP_LO, lb: 1, ub: 0 } });
  for (const row of rsRows) subjectTo.push({ name: row.name, vars: row.vars, bnds: { type: glpk.GLP_UP, lb: 0, ub: 1 } });

  const lp = {
    name: 'gardes-feasibility',
    objective: { direction: glpk.GLP_MIN, name: 'weekend', vars: objVars },
    subjectTo,
    binaries,
  };
  const out = await glpk.solve(lp, { msglev: glpk.GLP_MSG_OFF, presol: true });
  const r = out.result;
  if (r.status !== glpk.GLP_OPT && r.status !== glpk.GLP_FEAS) return null;

  const chosen: Record<string, boolean> = {};
  for (const cd of days)
    for (const doc of doctors)
      if (!isBlocked(cd.day, doc) && Math.round(r.vars[gv(cd.day, doc)] ?? 0) === 1) chosen[gv(cd.day, doc)] = true;
  return chosen;
}

/**
 * Deterministic steepest-descent local search minimising the sum of squared deviations of
 * pénibilité load from the mean (drives all doctors toward equal load). Every move is a single
 * reassignment of one garde slot from doctor `a` to doctor `b` on a given day, applied only if it
 * preserves all hard constraints (eligibility + RS spacing). No RNG, no clock ⇒ deterministic.
 */
function polishEquity(
  days: CalendarDay[],
  doctors: DoctorId[],
  assigned: DoctorId[][],
  blocked: Record<DoctorId, number[]>,
  carryCount: Record<DoctorId, number>,
  carryHeavy: Record<DoctorId, number>,
  carryWeekend: Record<DoctorId, number>,
  fte: Record<DoctorId, number>,
) {
  const isBlocked = (d: number, doc: DoctorId) => (blocked[doc] ?? []).includes(d);
  const dayList: Record<DoctorId, Set<number>> = {};
  // CUMULATIVE counts (carry from previous months + this month), so fairness is judged over the
  // whole horizon on three axes: total garde COUNT, HEAVY (Thu→Sun) count, and WEEKEND (Sat/Sun)
  // count — so both the number of gardes and the painful/weekend ones ROTATE across people & months.
  const cumCount: Record<DoctorId, number> = {};
  const cumHeavy: Record<DoctorId, number> = {};
  const cumWe: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    dayList[doc] = new Set();
    cumCount[doc] = carryCount[doc] ?? 0;
    cumHeavy[doc] = carryHeavy[doc] ?? 0;
    cumWe[doc] = carryWeekend[doc] ?? 0;
  }
  days.forEach((cd, di) => {
    const heavy = isHeavy(cd);
    for (const doc of assigned[di]) {
      dayList[doc].add(cd.day);
      cumCount[doc] += 1;
      if (heavy) cumHeavy[doc] += 1;
      if (cd.isWeekend) cumWe[doc] += 1;
    }
  });

  const N = days.length; // number of calendar days in the month
  const hasGarde = (doc: DoctorId, day: number) => dayList[doc].has(day);
  // b can take day d only if it keeps a ≥3-day gap: no garde on d-2,d-1,d+1,d+2 (and not on d).
  const canTake = (b: DoctorId, d: number) =>
    !isBlocked(d, b) &&
    !hasGarde(b, d) &&
    !hasGarde(b, d - 1) && !hasGarde(b, d + 1) &&
    !hasGarde(b, d - 2) && !hasGarde(b, d + 2);

  // Spread cost: how UNEVENLY a doctor's gardes are spaced over the whole month. Even spacing
  // (≈ one every (N+1)/(k+1) days) → cost 0; clustering (e.g. all at month end) → high cost.
  const spreadCost = (set: Set<number>): number => {
    if (set.size === 0) return 0;
    const pts = [0, ...[...set].sort((x, y) => x - y), N + 1];
    const ideal = (N + 1) / (set.size + 1);
    let c = 0;
    for (let i = 1; i < pts.length; i++) {
      const gap = pts[i] - pts[i - 1];
      c += (gap - ideal) * (gap - ideal);
    }
    return c;
  };

  // Per-doctor fairness TARGETS, proportional to full-time-equivalent (FTE). A 50% doctor's
  // target is half a full-timer's → part-timers get proportionally fewer gardes/weekends.
  const w = (doc: DoctorId) => fte[doc] ?? 1;
  const W = doctors.reduce((s, d) => s + w(d), 0) || 1;
  const sum = (m: Record<DoctorId, number>) => Object.values(m).reduce((s, v) => s + v, 0);
  const totalCount = sum(cumCount);
  const totalHeavy = sum(cumHeavy);
  const totalWe = sum(cumWe);
  const tgtCount: Record<DoctorId, number> = {};
  const tgtHeavy: Record<DoctorId, number> = {};
  const tgtWe: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    tgtCount[doc] = (totalCount * w(doc)) / W;
    tgtHeavy[doc] = (totalHeavy * w(doc)) / W;
    tgtWe[doc] = (totalWe * w(doc)) / W;
  }
  const sq = (x: number) => x * x;
  // Priority of fairness objectives (count must dominate so spacing never unbalances workload).
  const W_COUNT = 10; // equal NUMBER of gardes — most important
  const W_WE = 3; // Sat/Sun fairness
  const W_HEAVY = 1.5; // Thu→Sun fairness
  const W_SPREAD = 0.3; // even monthly spacing (secondary refinement)

  const sc: Record<DoctorId, number> = {};
  for (const doc of doctors) sc[doc] = spreadCost(dayList[doc]);

  const MAX_ITER = 8000;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let bestDelta = -1e-9; // require strict improvement
    let best: { di: number; a: DoctorId; b: DoctorId; scA: number; scB: number } | null = null;

    days.forEach((cd, di) => {
      const heavy = isHeavy(cd);
      const we = cd.isWeekend;
      for (const a of assigned[di]) {
        for (const b of doctors) {
          if (b === a) continue;
          if (assigned[di].includes(b)) continue;
          if (!canTake(b, cd.day)) continue;
          // Fairness deltas vs each doctor's FTE-proportional target (count always; heavy/weekend on those days).
          let delta =
            W_COUNT * (sq(cumCount[a] - 1 - tgtCount[a]) + sq(cumCount[b] + 1 - tgtCount[b]) - sq(cumCount[a] - tgtCount[a]) - sq(cumCount[b] - tgtCount[b]));
          if (heavy) {
            delta += W_HEAVY * (sq(cumHeavy[a] - 1 - tgtHeavy[a]) + sq(cumHeavy[b] + 1 - tgtHeavy[b]) - sq(cumHeavy[a] - tgtHeavy[a]) - sq(cumHeavy[b] - tgtHeavy[b]));
          }
          if (we) {
            delta += W_WE * (sq(cumWe[a] - 1 - tgtWe[a]) + sq(cumWe[b] + 1 - tgtWe[b]) - sq(cumWe[a] - tgtWe[a]) - sq(cumWe[b] - tgtWe[b]));
          }
          // Spread delta: recompute the two doctors' spacing cost with the garde moved a→b.
          const aSet = new Set(dayList[a]); aSet.delete(cd.day);
          const bSet = new Set(dayList[b]); bSet.add(cd.day);
          const scA = spreadCost(aSet);
          const scB = spreadCost(bSet);
          delta += W_SPREAD * (scA + scB - sc[a] - sc[b]);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = { di, a, b, scA, scB };
          }
        }
      }
    });

    if (!best) break;
    const { di, a, b, scA, scB } = best;
    const cd = days[di];
    assigned[di] = assigned[di].map((x) => (x === a ? b : x));
    dayList[a].delete(cd.day);
    dayList[b].add(cd.day);
    sc[a] = scA;
    sc[b] = scB;
    cumCount[a] -= 1;
    cumCount[b] += 1;
    if (isHeavy(cd)) {
      cumHeavy[a] -= 1;
      cumHeavy[b] += 1;
    }
    if (cd.isWeekend) {
      cumWe[a] -= 1;
      cumWe[b] += 1;
    }
  }
}

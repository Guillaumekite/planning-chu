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
import { mulberry32 } from './rng';
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

/** Hard monthly cap: no doctor takes more than 7 gardes/month — unless they explicitly
 * wished (G+) more than 7 days, in which case their cap is their wish count. */
const MAX_GARDES_PER_MONTH = 7;

/** Wish-forcing decisions derived from G+ days, handed to the MILP and the local search. */
type WishPlan = {
  /** `${day}|${doc}` — garde REQUIRED (wisher with ≤2 wishers that day, or drawn by lot at ≥3). */
  forced: Set<string>;
  /** Per-doctor monthly cap (7, or the wish count when > 7). */
  cap: Record<DoctorId, number>;
};

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

  // ---- G+ (souhait_garde) preprocessing: wishes become HARD where consistent ----
  // Per doctor: dedupe, drop wishes on blocked days, drop a wish closer than 3 days to the
  // previous kept one (the rest rule makes both impossible). Every drop produces a warning.
  const warnings: string[] = [];
  const keptWishes: Record<DoctorId, number[]> = {};
  for (const doc of doctors) {
    const asked = [...new Set(wishes[doc] ?? [])].filter((d) => d >= 1 && d <= days.length).sort((a, b) => a - b);
    const kept: number[] = [];
    for (const d of asked) {
      if (isBlocked(d, doc)) {
        warnings.push(`G+ de ${doc} le ${d} ignoré : jour indisponible pour une garde (congé, G−, temps partiel…).`);
        continue;
      }
      if (kept.length && d - kept[kept.length - 1] < 3) {
        warnings.push(`G+ de ${doc} le ${d} non garanti : à moins de 3 jours de son G+ du ${kept[kept.length - 1]} (règle de repos).`);
        continue;
      }
      kept.push(d);
    }
    if (kept.length) keptWishes[doc] = kept;
  }
  // Per day: ≤2 wishers → each is FORCED; ≥3 → the 2 winners are DRAWN BY LOT (deterministic,
  // seeded by year/month/day so regenerating the same month gives the same draw) and forced.
  const wishersByDay: Record<number, DoctorId[]> = {};
  for (const [doc, ds] of Object.entries(keptWishes)) for (const d of ds) (wishersByDay[d] ??= []).push(doc);
  const forced = new Set<string>();
  for (const [dStr, docsW] of Object.entries(wishersByDay)) {
    const d = Number(dStr);
    if (docsW.length <= 2) {
      for (const doc of docsW) forced.add(`${d}|${doc}`);
    } else {
      const pool = [...docsW].sort(); // stable base order, then seeded Fisher-Yates shuffle
      const rng = mulberry32(((input.year * 100 + input.month) * 100 + d) >>> 0);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const winners = pool.slice(0, 2).sort();
      const losers = pool.slice(2).sort();
      for (const doc of winners) forced.add(`${d}|${doc}`);
      warnings.push(
        `${docsW.length} G+ le ${d} pour 2 places : tirage au sort → retenus ${winners.join(' et ')} ; non retenu(s) : ${losers.join(', ')}.`,
      );
    }
  }
  // Monthly cap: 7, lifted to the doctor's kept-wish count when they asked for more.
  const cap: Record<DoctorId, number> = {};
  for (const doc of doctors) cap[doc] = Math.max(MAX_GARDES_PER_MONTH, keptWishes[doc]?.length ?? 0);

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

  // Pre-check: the monthly cap must leave enough capacity to cover 2 gardes/day.
  const totalSlots = 2 * days.length;
  const capacity = doctors.reduce((s, doc) => {
    const unblocked = days.filter((cd) => !isBlocked(cd.day, doc)).length;
    return s + Math.min(cap[doc], unblocked);
  }, 0);
  if (capacity < totalSlots) {
    return {
      status: 'infeasible',
      day: days[0].day,
      reason:
        `Effectif insuffisant : ${totalSlots} gardes à couvrir dans le mois mais capacité maximale ${capacity} ` +
        `(limite de ${MAX_GARDES_PER_MONTH} gardes/médecin/mois, indisponibilités déduites). ` +
        `Ajoute des médecins au roster ou réduis les indisponibilités.`,
      eligible: doctors,
    };
  }

  // ---- Step 1: feasibility MILP (fast), G+ forcés ; retry sans forçage si infaisable ----
  let plan: WishPlan = { forced, cap };
  let feasible = await solveFeasibility(input, days, weights, plan);
  if (!feasible && forced.size > 0) {
    plan = { forced: new Set(), cap };
    feasible = await solveFeasibility(input, days, weights, plan);
    if (feasible) {
      warnings.push(
        `Impossible d'honorer tous les G+ en même temps (règle de repos / effectif) — planning généré sans les garantir. ` +
          `Revois les G+ en conflit ou les indisponibilités.`,
      );
    }
  }
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
  polishEquity(days, doctors, assigned, blocked, carryCount, carryHeavy, carryWeekend, input.fte ?? {}, plan);

  // ---- Build result ----
  const count: Record<DoctorId, number> = {};
  const weekendCount: Record<DoctorId, number> = {};
  const heavyCount: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    count[doc] = 0;
    weekendCount[doc] = 0;
    heavyCount[doc] = 0;
  }
  // Role (G1/G2) assignment — INTRA-MONTH balancing so each doctor alternates roles across their
  // gardes (|G1 − G2| ≤ 1), instead of the old alphabetical tie-break that froze a doctor into one role.
  const forceG2 = new Set(input.forceG2 ?? []);
  const g1PerDay = assignRoles(assigned, forceG2);

  const assignments: GardeAssignment[] = [];
  days.forEach((cd, di) => {
    const heavy = isHeavy(cd);
    const g1 = g1PerDay[di];
    const g2 = assigned[di][0] === g1 ? assigned[di][1] : assigned[di][0];
    for (const [doc, role] of [[g1, 'G1'], [g2, 'G2']] as [DoctorId, 'G1' | 'G2'][]) {
      const reason =
        `${role} le ${cd.day} (${FR_WEEKDAY[cd.weekday]}${heavy ? ', jour pénible' : ''})` +
        (wants(cd.day, doc) ? ' — vœu honoré' : ' — répartition équilibrée parmi les éligibles');
      assignments.push({ day: cd.day, role, doctorId: doc, reason });
      count[doc] += 1;
      if (isGardeWeekend(cd)) weekendCount[doc] += 1;
      if (heavy) heavyCount[doc] += 1;
    }
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
  return { status: 'feasible', assignments, equity, warnings };
}

/** A "heavy" (penible) garde day: Thursday→Sunday (weekday index 3..6). */
function isHeavy(cd: CalendarDay): boolean {
  return cd.weekday >= 3;
}

/**
 * A "week-end de garde" day for EQUITY purposes only: Friday→Sunday (weekday index 4..6).
 * Deliberately NOT the same as `CalendarDay.isWeekend` (Sat/Sun only), which stays scoped to
 * the regular consultation planning (`planning.ts`) and the UI grids/exports — those must keep
 * treating Friday as a normal working day.
 */
function isGardeWeekend(cd: CalendarDay): boolean {
  return cd.weekday >= 4;
}

/**
 * Assign G1/G2 to each day's garde pair, balancing every doctor's G1 vs G2 count over the month
 * (|G1 − G2| ≤ 1), so a doctor doing several gardes ALTERNATES roles instead of being frozen into
 * one (the old alphabetical tie-break froze early-sorted names into G1).
 *
 * Modeled as a balanced graph orientation: each garde-day is an EDGE between its two doctors.
 * Orienting an edge = choosing which endpoint is G1 (tail, +1) vs G2 (head, −1). We find an Eulerian
 * circuit (adding a virtual vertex joined to every odd-degree doctor so one is guaranteed to exist)
 * and orient each edge by its traversal direction. An Eulerian circuit enters and leaves each vertex
 * equally ⇒ balance 0 at even-degree doctors and ±1 at the odd ones. Fully deterministic (sorted
 * adjacency + sorted component starts). Doctors in `forceG2` are then pinned to G2 by flipping any
 * day where they came out G1 (only affects those doctors; the acupuncturist is the sole real case).
 *
 * `pairs[di]` holds the 2 doctors on garde on day index `di`. Returns, per day, the G1 doctor.
 */
function assignRoles(pairs: DoctorId[][], forceG2: Set<DoctorId>): DoctorId[] {
  const VIRTUAL = ' virtual';
  const nReal = pairs.length;
  type Edge = { id: number; a: DoctorId; b: DoctorId };
  const edges: Edge[] = pairs.map((p, di) => {
    const [a, b] = [...p].sort((x, y) => x.localeCompare(y));
    return { id: di, a, b };
  });
  // Add a virtual edge to each odd-degree doctor so the (multi)graph has an Eulerian circuit.
  const deg: Record<string, number> = {};
  for (const e of edges) { deg[e.a] = (deg[e.a] ?? 0) + 1; deg[e.b] = (deg[e.b] ?? 0) + 1; }
  const odd = Object.keys(deg).filter((v) => deg[v] % 2 === 1).sort((x, y) => x.localeCompare(y));
  let vid = nReal;
  for (const v of odd) edges.push({ id: vid++, a: VIRTUAL, b: v });

  // Adjacency: vertex → half-edges {edgeId, to}, sorted deterministically.
  const adj = new Map<string, { edgeId: number; to: string }[]>();
  const add = (from: string, to: string, edgeId: number) => {
    (adj.get(from) ?? adj.set(from, []).get(from)!).push({ edgeId, to });
  };
  for (const e of edges) { add(e.a, e.b, e.id); add(e.b, e.a, e.id); }
  for (const list of adj.values()) list.sort((p, q) => (p.to === q.to ? p.edgeId - q.edgeId : p.to.localeCompare(q.to)));

  const ptr = new Map<string, number>();
  for (const v of adj.keys()) ptr.set(v, 0);
  const usedEdge = new Set<number>();
  const g1ById: Record<number, DoctorId> = {}; // real edge id → G1 (the traversal tail)

  // Hierholzer over every component (deterministic start order). Orient each edge by crossing dir.
  for (const start of [...adj.keys()].sort((x, y) => x.localeCompare(y))) {
    const stack: string[] = [start];
    while (stack.length) {
      const v = stack[stack.length - 1];
      const list = adj.get(v)!;
      let p = ptr.get(v)!;
      while (p < list.length && usedEdge.has(list[p].edgeId)) p++;
      ptr.set(v, p);
      if (p < list.length) {
        const { edgeId, to } = list[p];
        usedEdge.add(edgeId);
        if (edgeId < nReal) g1ById[edgeId] = v; // tail = G1, head (`to`) = G2
        stack.push(to);
      } else {
        stack.pop();
      }
    }
  }

  const g1arr = pairs.map((p, di) => {
    let g1 = g1ById[di] ?? [...p].sort((x, y) => x.localeCompare(y))[0];
    const other = p[0] === g1 ? p[1] : p[0];
    // Pin forced-G2 doctors to G2 (flip if they came out as G1 and their partner is not also forced).
    if (forceG2.has(g1) && !forceG2.has(other)) g1 = other;
    return g1;
  });

  // Forcing a doctor to G2 pushes their partners to G1 in ±2 swings, which can unbalance a partner
  // (e.g. 4×G1 / 1×G2). Repair by AUGMENTING PATHS: view each garde-day as a directed edge G1→G2.
  // Moving one unit of "G1 excess" from an over-loaded doctor s (bal ≥ 2) to a lighter doctor t means
  // flipping the roles along a directed path s→…→t (each intermediate nets zero, s loses a G1, t gains
  // one). Edges touching a forced-G2 doctor are never used, so that doctor stays G2. A single swap is
  // just a length-1 path; longer paths escape the local minima a greedy single-swap gets stuck in.
  // Each augmentation strictly lowers Σ balance² (bounded below) ⇒ it terminates. Deterministic
  // (sorted neighbours, sorted starts). In practice this reaches |G1 − G2| ≤ 1 for every doctor.
  const other = (di: number) => (pairs[di][0] === g1arr[di] ? pairs[di][1] : pairs[di][0]);
  const swappable = (di: number) => !forceG2.has(g1arr[di]) && !forceG2.has(other(di));
  const bal: Record<DoctorId, number> = {};
  for (const p of pairs) for (const d of p) bal[d] = 0;
  pairs.forEach((_, di) => { bal[g1arr[di]] += 1; bal[other(di)] -= 1; });
  const vertsSorted = Object.keys(bal).sort((a, b) => a.localeCompare(b));

  for (let guard = 0; guard < pairs.length * 2 + 50; guard++) {
    let s = '';
    for (const v of vertsSorted) if (bal[v] >= 2 && (s === '' || bal[v] > bal[s])) s = v;
    if (s === '') break;
    // Directed adjacency over swappable edges (G1 → G2), sorted for determinism.
    const adj: Record<string, { di: number; to: string }[]> = {};
    for (let di = 0; di < pairs.length; di++) {
      if (!swappable(di)) continue;
      (adj[g1arr[di]] ??= []).push({ di, to: other(di) });
    }
    for (const u in adj) adj[u].sort((p, q) => (p.to === q.to ? p.di - q.di : p.to.localeCompare(q.to)));
    // BFS for a path from s to any lighter doctor (bal ≤ bal[s] − 2).
    const parent: Record<string, { di: number; from: string } | null> = { [s]: null };
    const queue = [s];
    let target = '';
    while (queue.length) {
      const u = queue.shift()!;
      if (u !== s && bal[u] < bal[s] - 2) { target = u; break; } // strict ⇒ Σbal² strictly drops
      for (const { di, to } of adj[u] ?? []) if (!(to in parent)) { parent[to] = { di, from: u }; queue.push(to); }
    }
    if (target === '') break; // s cannot be improved further
    for (let cur = target; parent[cur]; ) {
      const { di, from } = parent[cur]!;
      g1arr[di] = cur; bal[from] -= 2; bal[cur] += 2; // flip edge from(G1)→cur(G2)
      cur = from;
    }
  }
  return g1arr;
}

/** Solve the feasibility MILP. Returns a map of chosen g-vars, or null if infeasible. */
async function solveFeasibility(
  input: GardeInput,
  days: CalendarDay[],
  weights: GardeWeights,
  plan: WishPlan,
): Promise<Record<string, boolean> | null> {
  const glpk = await getGlpk();
  const doctors = input.doctors;
  const blocked = input.gardeBlocked ?? {};
  const isBlocked = (d: number, doc: DoctorId) => (blocked[doc] ?? []).includes(d);
  const allowed = (d: number, doc: DoctorId) => !isBlocked(d, doc);

  type Term = { name: string; coef: number };
  const dayVars: Record<number, Term[]> = {};
  const docVars: Record<DoctorId, Term[]> = {};
  const wedefVars: Record<DoctorId, Term[]> = {};
  const rsRows: { name: string; vars: Term[] }[] = [];
  const binaries: string[] = [];
  const objVars: Term[] = [];

  for (const cd of days) dayVars[cd.day] = [];
  for (const doc of doctors) {
    docVars[doc] = [];
    wedefVars[doc] = [{ name: `deficit_${doc}`, coef: 1 }];
    objVars.push({ name: `deficit_${doc}`, coef: weights.weekendDeficit });
  }
  for (const cd of days) {
    for (const doc of doctors) {
      if (!allowed(cd.day, doc)) continue;
      const name = gv(cd.day, doc);
      binaries.push(name);
      dayVars[cd.day].push({ name, coef: 1 });
      docVars[doc].push({ name, coef: 1 });
      if (isGardeWeekend(cd)) wedefVars[doc].push({ name, coef: 1 });
    }
  }
  // Rest rule: garde → RS → worked day (not garde). So in ANY 3 consecutive calendar days a
  // doctor may hold at most ONE garde → minimum gap of 3 days between a doctor's gardes.
  for (let k = 0; k < days.length; k++) {
    const window = [days[k], days[k + 1], days[k + 2]].filter(Boolean);
    if (window.length < 2) continue;
    for (const doc of doctors) {
      const vars = window.filter((cd) => allowed(cd.day, doc)).map((cd) => ({ name: gv(cd.day, doc), coef: 1 }));
      if (vars.length >= 2) rsRows.push({ name: `gap_${days[k].day}_${doc}`, vars });
    }
  }

  const subjectTo: { name: string; vars: Term[]; bnds: { type: number; lb: number; ub: number } }[] = [];
  for (const cd of days) subjectTo.push({ name: `day_${cd.day}`, vars: dayVars[cd.day], bnds: { type: glpk.GLP_FX, lb: 2, ub: 2 } });
  for (const doc of doctors) subjectTo.push({ name: `wedef_${doc}`, vars: wedefVars[doc], bnds: { type: glpk.GLP_LO, lb: 1, ub: 0 } });
  for (const row of rsRows) subjectTo.push({ name: row.name, vars: row.vars, bnds: { type: glpk.GLP_UP, lb: 0, ub: 1 } });
  // Monthly cap per doctor (≤ 7 gardes, or the wish count when higher).
  for (const doc of doctors) {
    if (docVars[doc].length > 0) {
      subjectTo.push({ name: `cap_${doc}`, vars: docVars[doc], bnds: { type: glpk.GLP_UP, lb: 0, ub: plan.cap[doc] ?? MAX_GARDES_PER_MONTH } });
    }
  }
  // Forced G+ (≤ 2 wishers that day): the doctor's garde on that day is REQUIRED.
  for (const key of plan.forced) {
    const [dStr, doc] = key.split('|');
    const d = Number(dStr);
    if (!allowed(d, doc)) continue; // dropped earlier with a warning
    subjectTo.push({ name: `wishf_${d}_${doc}`, vars: [{ name: gv(d, doc), coef: 1 }], bnds: { type: glpk.GLP_FX, lb: 1, ub: 1 } });
  }

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
      if (allowed(cd.day, doc) && Math.round(r.vars[gv(cd.day, doc)] ?? 0) === 1) chosen[gv(cd.day, doc)] = true;
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
  plan: WishPlan,
) {
  const isBlocked = (d: number, doc: DoctorId) => (blocked[doc] ?? []).includes(d);
  const dayList: Record<DoctorId, Set<number>> = {};
  // CUMULATIVE counts (carry from previous months + this month), so fairness is judged over the
  // whole horizon on three axes: total garde COUNT, HEAVY (Thu→Sun) count, and WEEKEND (Fri/Sat/Sun)
  // count — so both the number of gardes and the painful/weekend ones ROTATE across people & months.
  const cumCount: Record<DoctorId, number> = {};
  const cumHeavy: Record<DoctorId, number> = {};
  const cumWe: Record<DoctorId, number> = {};
  // THIS-month count per doctor — the monthly cap applies to it (not to the carry).
  const monthCount: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    dayList[doc] = new Set();
    cumCount[doc] = carryCount[doc] ?? 0;
    cumHeavy[doc] = carryHeavy[doc] ?? 0;
    cumWe[doc] = carryWeekend[doc] ?? 0;
    monthCount[doc] = 0;
  }
  days.forEach((cd, di) => {
    const heavy = isHeavy(cd);
    for (const doc of assigned[di]) {
      dayList[doc].add(cd.day);
      cumCount[doc] += 1;
      monthCount[doc] += 1;
      if (heavy) cumHeavy[doc] += 1;
      if (isGardeWeekend(cd)) cumWe[doc] += 1;
    }
  });

  const N = days.length; // number of calendar days in the month
  const hasGarde = (doc: DoctorId, day: number) => dayList[doc].has(day);
  // b can take day d only if it keeps a ≥3-day gap: no garde on d-2,d-1,d+1,d+2 (and not on d) —
  // and it must respect the wish plan: the monthly cap holds (forced G+ days never move at all).
  const canTake = (b: DoctorId, d: number) =>
    !isBlocked(d, b) &&
    monthCount[b] < (plan.cap[b] ?? MAX_GARDES_PER_MONTH) &&
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
      const we = isGardeWeekend(cd);
      for (const a of assigned[di]) {
        if (plan.forced.has(`${cd.day}|${a}`)) continue; // a forced G+ garde never moves
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
    monthCount[a] -= 1;
    monthCount[b] += 1;
    if (isHeavy(cd)) {
      cumHeavy[a] -= 1;
      cumHeavy[b] += 1;
    }
    if (isGardeWeekend(cd)) {
      cumWe[a] -= 1;
      cumWe[b] += 1;
    }
  }
}

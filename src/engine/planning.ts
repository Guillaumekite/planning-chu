// Phase B — full monthly planning. Builds on the garde skeleton (Phase A) and assigns the
// OTHER daily posts to every present doctor, using the acronyms from the service guide.
//
// Posts (acronyms from the Word guide):
//   G1, G2 = gardes (Phase A) · RS = repos de sécurité (lendemain de garde)
//   U  = universitaire (médecins universitaires, au prorata de leur ratio fac)
//   P  = présence (médecin dédié, si effectif ≥ 10)
//   Ped = pédiatrie (lun/mer/jeu/ven, médecins compétents) · MM = maternité · CD = consultation douleur
//   BM = bloc matin · S = service · CS1/CS2 = consultations · HC = hors clinique
//   CA = congé · '' = repos (week-end/férié, jour off, ou temps partiel)
//
// Staff (mar/ven aprem), biblio (mar matin), réunion (mer) ne sont PAS des postes : ce sont des
// moments de journée → affichés comme repères, jamais comme une affectation.

import { solveGardes } from './gardes';
import { buildMonth } from './calendar';
import {
  DEFAULT_WEIGHTS,
  type DoctorId,
  type GardeInput,
  type CalendarDay,
  type EquityReport,
} from './types';

// Day states a doctor can declare:
//   dispo         — available (can do gardes and posts)
//   souhait_garde — available, and WISHES a garde that day (soft preference)
//   no_garde      — works that day (gets a post) but must NOT be on garde
//   conge         — leave request (not present); validation handled by the admin
export type Availability = 'dispo' | 'souhait_garde' | 'no_garde' | 'conge';

const GARDEABLE = (a: Availability) => a === 'dispo' || a === 'souhait_garde';
const PRESENT = (a: Availability) => a === 'dispo' || a === 'souhait_garde' || a === 'no_garde';

export interface DoctorProfile {
  universitaire?: boolean;
  /** % of time spent at university (0-100). U posts ≈ this fraction of working days. */
  universityRatio?: number;
  /** Full-time-equivalent fraction (0-1). Part-timers get proportionally fewer gardes. Default 1. */
  fte?: number;
  /** This doctor does acupuncture (post ACU) every Monday when present (e.g. Dr Dzierzek). */
  acupuncture?: boolean;
}

export interface PlanningInput {
  year: number;
  month: number;
  doctors: DoctorId[];
  availability?: Record<DoctorId, Record<number, Availability>>;
  profiles?: Record<DoctorId, DoctorProfile>;
  holidays?: number[];
  wishes?: Record<DoctorId, number[]>;
}

export type PlanningResult =
  | {
      status: 'feasible';
      days: CalendarDay[];
      grid: Record<DoctorId, Record<number, string>>;
      gardeEquity: EquityReport;
    }
  | { status: 'infeasible'; day: number; reason: string; eligible: DoctorId[] };

const PED_DAYS = new Set([0, 2, 3, 4]); // Mon, Wed, Thu, Fri (weekday index, Monday=0)

function avail(input: PlanningInput, doc: DoctorId, day: number): Availability {
  return input.availability?.[doc]?.[day] ?? 'dispo';
}

/** Pick k items evenly spread from a sorted list (deterministic). */
function pickEven<T>(items: T[], k: number): T[] {
  if (k <= 0) return [];
  if (k >= items.length) return [...items];
  const res: T[] = [];
  const step = items.length / k;
  for (let i = 0; i < k; i++) res.push(items[Math.floor(i * step + step / 2)]);
  return res;
}

/**
 * Part-time off days (TP). A doctor at ratio r works ~r of their available weekdays, with a
 * weekly alternation (50% → 3 days then 2 days; 70% → 4 then 3) via a running credit. The
 * non-working weekdays are returned as the TP set.
 */
function computeTpDays(
  days: CalendarDay[],
  isAvailWeekday: (day: number) => boolean,
  ratio: number,
): Set<number> {
  const byWeek = new Map<number, number[]>();
  for (const cd of days) {
    if (cd.isWeekend || cd.isHoliday || !isAvailWeekday(cd.day)) continue;
    const weekId = cd.day - cd.weekday; // day-number of that week's Monday (unique per week)
    if (!byWeek.has(weekId)) byWeek.set(weekId, []);
    byWeek.get(weekId)!.push(cd.day);
  }
  const tp = new Set<number>();
  let credit = 0;
  for (const weekId of [...byWeek.keys()].sort((a, b) => a - b)) {
    const group = byWeek.get(weekId)!.sort((a, b) => a - b);
    credit += ratio * group.length;
    let work = Math.floor(credit + 0.5);
    work = Math.max(0, Math.min(group.length, work));
    credit -= work;
    const working = new Set(pickEven(group, work));
    for (const day of group) if (!working.has(day)) tp.add(day);
  }
  return tp;
}

export async function solvePlanning(input: PlanningInput): Promise<PlanningResult> {
  const days = buildMonth(input.year, input.month, DEFAULT_WEIGHTS, input.holidays ?? []);
  const doctors = input.doctors;

  const fte: Record<DoctorId, number> = {};
  for (const doc of doctors) fte[doc] = input.profiles?.[doc]?.fte ?? 1;

  // Part-time off days (TP): part-timers don't work every day — ~fte of their present weekdays,
  // in a 3/2-style weekly alternation. Those off days get no post and look like any day off.
  const tpDays: Record<DoctorId, Set<number>> = {};
  for (const doc of doctors) {
    tpDays[doc] = fte[doc] < 1
      ? computeTpDays(days, (day) => PRESENT(avail(input, doc, day)), fte[doc])
      : new Set<number>();
  }

  // Wishes (souhait_garde) feed the garde optimiser's soft preference.
  const wishes: Record<DoctorId, number[]> = { ...(input.wishes ?? {}) };
  for (const doc of doctors) {
    const wd = days.filter((cd) => avail(input, doc, cd.day) === 'souhait_garde').map((cd) => cd.day);
    if (wd.length) wishes[doc] = [...new Set([...(wishes[doc] ?? []), ...wd])];
  }

  // Acupuncture doctors keep their Mondays free for ACU — so they're also kept off garde on
  // Mondays AND Sundays (a Sunday garde would force a Monday rest), guaranteeing ACU every Monday.
  const acupuncture = new Set(doctors.filter((doc) => input.profiles?.[doc]?.acupuncture));
  const acuBlocked = (doc: DoctorId, cd: CalendarDay) => acupuncture.has(doc) && (cd.weekday === 0 || cd.weekday === 6);

  // A garde is blocked unless the doctor is garde-available that day (and not on a TP / ACU day).
  const gardeBlocked: Record<DoctorId, number[]> = {};
  for (const doc of doctors) {
    const blocked: number[] = [];
    for (const cd of days) if (!GARDEABLE(avail(input, doc, cd.day)) || tpDays[doc].has(cd.day) || acuBlocked(doc, cd)) blocked.push(cd.day);
    if (blocked.length) gardeBlocked[doc] = blocked;
  }

  // Garde fairness weight = part-time fraction × garde-availability fraction (days NOT blocked).
  const totalDays = days.length;
  const gardeWeight: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    const blockedSet = new Set(gardeBlocked[doc] ?? []);
    const gardeDays = days.filter((cd) => !blockedSet.has(cd.day)).length;
    gardeWeight[doc] = fte[doc] * (gardeDays / totalDays);
  }

  const gardeInput: GardeInput = {
    year: input.year, month: input.month, doctors,
    gardeBlocked, holidays: input.holidays, wishes, fte: gardeWeight,
  };
  const gardes = await solveGardes(gardeInput);
  if (gardes.status === 'infeasible') return gardes;

  const gardeByDay: Record<number, { G1?: DoctorId; G2?: DoctorId }> = {};
  for (const a of gardes.assignments) (gardeByDay[a.day] ??= {})[a.role] = a.doctorId;

  const grid: Record<DoctorId, Record<number, string>> = {};
  for (const doc of doctors) grid[doc] = {};

  // Compensation off (récup) for weekend gardes whose RS falls on a non-working day.
  // Team ≥ 12 active → Saturday-garde doctors get the FOLLOWING Monday off.
  // Team > 12 active → Friday-garde doctors also get the following Monday off.
  const teamSize = doctors.length;
  const compOff = new Set<string>(); // `${doctor}|${day}`
  if (teamSize >= 12) {
    for (const cd of days) {
      const g = gardeByDay[cd.day];
      if (!g) continue;
      const isSat = cd.weekday === 5;
      const isFri = cd.weekday === 4 && teamSize > 12;
      if (!isSat && !isFri) continue;
      const mondayDay = cd.day + (isSat ? 2 : 3); // Sat→+2, Fri→+3 lands on Monday
      const md = days.find((x) => x.day === mondayDay);
      if (!md || md.weekday !== 0) continue;
      for (const doc of [g.G1, g.G2]) if (doc) compOff.add(`${doc}|${mondayDay}`);
    }
  }

  const isPresent = (doc: DoctorId, day: number) =>
    PRESENT(avail(input, doc, day)) && !tpDays[doc].has(day) && !compOff.has(`${doc}|${day}`);
  const isGarde = (doc: DoctorId, day: number) => gardeByDay[day]?.G1 === doc || gardeByDay[day]?.G2 === doc;
  const isRS = (doc: DoctorId, day: number) =>
    isPresent(doc, day) && !isGarde(doc, day) && (gardeByDay[day - 1]?.G1 === doc || gardeByDay[day - 1]?.G2 === doc);

  // Pass 1 — fixed labels: absences, gardes, RS.
  for (const cd of days) {
    for (const doc of doctors) {
      const a = avail(input, doc, cd.day);
      if (a === 'conge') grid[doc][cd.day] = 'CA';
      // dispo / souhait_garde / no_garde → present, post assigned below.
      // Part-time off days (tpDays) are left BLANK on purpose — the grid must not reveal that a
      // doctor is part-time; their off days simply look like any normal day off.
    }
    const g = gardeByDay[cd.day] ?? {};
    if (g.G1) grid[g.G1][cd.day] = 'G1';
    if (g.G2) grid[g.G2][cd.day] = 'G2';
    for (const doc of doctors) if (isRS(doc, cd.day) && !grid[doc][cd.day]) grid[doc][cd.day] = 'RS';
  }

  // Acupuncture: dedicated doctors get ACU every Monday they're present (priority post).
  for (const cd of days) {
    if (cd.weekday !== 0) continue; // Monday = 0
    for (const doc of acupuncture) {
      if (isPresent(doc, cd.day) && !grid[doc][cd.day]) grid[doc][cd.day] = 'ACU';
    }
  }

  // Pass 2 — University (U): for each universitaire doctor, mark ~ratio% of their WEEKDAY
  // working days as U, spread evenly. Skipped in July/August (academic break, per guide).
  const isAcademicBreak = input.month === 7 || input.month === 8;
  if (!isAcademicBreak) {
    for (const doc of doctors) {
      const prof = input.profiles?.[doc];
      if (!prof?.universitaire) continue;
      const ratio = Math.max(0, Math.min(100, prof.universityRatio ?? 50));
      const workdays = days
        .filter((cd) => !cd.isWeekend && !cd.isHoliday && isPresent(doc, cd.day) && !grid[doc][cd.day])
        .map((cd) => cd.day);
      const k = Math.round((ratio / 100) * workdays.length);
      for (const day of pickEven(workdays, k)) grid[doc][day] = 'U';
    }
  }

  // Pass 3 — day posts (weekdays only). Special posts gated by eligibility, then the generic fill.
  const postCount: Record<DoctorId, Record<string, number>> = {};
  for (const doc of doctors) postCount[doc] = {};

  for (const cd of days) {
    // Weekend / holiday: only gardes + RS exist. Everyone else present is off (blank).
    if (cd.isWeekend || cd.isHoliday) continue;

    const presentCount = doctors.filter((doc) => isPresent(doc, cd.day)).length;
    // Pool = present, not garde, not RS, not already U.
    let pool = doctors.filter((doc) => isPresent(doc, cd.day) && !grid[doc][cd.day]);

    const assign = (doc: DoctorId, post: string) => {
      grid[doc][cd.day] = post;
      postCount[doc][post] = (postCount[doc][post] ?? 0) + 1;
      pool = pool.filter((d) => d !== doc);
    };
    // Pick the pool doctor who has done `post` the fewest times (deterministic) — anyone can do any post.
    const leastFor = (post: string): DoctorId | undefined =>
      [...pool].sort((a, b) => {
        const ca = postCount[a][post] ?? 0, cb = postCount[b][post] ?? 0;
        return ca !== cb ? ca - cb : a.localeCompare(b);
      })[0];

    // Required posts for the day, in priority order. Specials apply by day rule / headcount,
    // and are distributed across ALL present doctors (no dedicated specialists).
    const wanted: string[] = [];
    if (PED_DAYS.has(cd.weekday)) wanted.push('Ped'); // pédiatrie lun/mer/jeu/ven
    wanted.push('MM'); // maternité
    if (presentCount >= 9) wanted.push('CD'); // consultation douleur si effectif suffisant
    wanted.push('S', 'CS1', 'BM', 'CS2', 'BM', 'BM');
    if (presentCount >= 10) wanted.push('P'); // présence quand l'effectif est large

    for (const post of wanted) {
      if (pool.length === 0) break;
      const doc = leastFor(post);
      if (doc) assign(doc, post);
    }
    // Leftover → HC.
    for (const doc of [...pool]) assign(doc, 'HC');
  }

  return { status: 'feasible', days, grid, gardeEquity: gardes.equity };
}

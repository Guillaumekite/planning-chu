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
  /** Consultation douleur (CD) weight: 0 = not eligible (default), 1 = simple, 2 = double (Esbuy). */
  douleurPoids?: number;
}

export interface PlanningInput {
  year: number;
  month: number;
  doctors: DoctorId[];
  availability?: Record<DoctorId, Record<number, Availability>>;
  profiles?: Record<DoctorId, DoctorProfile>;
  holidays?: number[];
  wishes?: Record<DoctorId, number[]>;
  /** Whether ACU (acupuncture) scheduling is active for this planning. Default true. */
  acupuncture?: boolean;
  /**
   * Per universitaire doctor: days (1-based) they DECLARED as university-constraint days ("Univ").
   * When a doctor has ≥1 declared day, those exact weekdays become their U days (no auto %-fill).
   * When empty/absent, U days are auto-placed by universityRatio as before.
   */
  univConstraints?: Record<DoctorId, number[]>;
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

  // Consultation douleur (CD) eligibility & weight per doctor: 0 = not eligible, 1 = simple, 2 = double.
  const douleurPoids: Record<DoctorId, number> = {};
  for (const doc of doctors) douleurPoids[doc] = input.profiles?.[doc]?.douleurPoids ?? 0;

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

  // Acupuncture doctors do ACU on Mondays but stay normal for garde eligibility. If the schedule
  // puts one on a Monday garde, it must be G2 (evening from 18h) — see the G2-forcing step below.
  const acupuncture = new Set(doctors.filter((doc) => input.profiles?.[doc]?.acupuncture));

  // University-constraint days ("Univ") the doctor declared themselves. Honored only for universitaire
  // doctors and only on weekdays (university is a weekday activity). A doctor with ≥1 declared day gets
  // those EXACT days as U days; otherwise U is auto-placed by ratio (Pass 2).
  const weekdaySet = new Set(days.filter((cd) => !cd.isWeekend && !cd.isHoliday).map((cd) => cd.day));
  const univDays: Record<DoctorId, Set<number>> = {};
  for (const doc of doctors) {
    const declared = input.profiles?.[doc]?.universitaire ? (input.univConstraints?.[doc] ?? []) : [];
    univDays[doc] = new Set(declared.filter((d) => weekdaySet.has(d)));
  }

  // A garde is blocked unless the doctor is garde-available that day (and not on a TP day).
  const gardeBlocked: Record<DoctorId, number[]> = {};
  for (const doc of doctors) {
    const blocked: number[] = [];
    for (const cd of days) if (!GARDEABLE(avail(input, doc, cd.day)) || tpDays[doc].has(cd.day)) blocked.push(cd.day);
    // Being at university on day D forbids a garde the day BEFORE: its RS (D) would clash with the fac.
    for (const d of univDays[doc]) if (d - 1 >= 1) blocked.push(d - 1);
    if (blocked.length) gardeBlocked[doc] = [...new Set(blocked)];
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
    // Acupuncture doctors are ALWAYS G2, never G1 (permanent rule) — handled by the role balancer.
    forceG2: [...acupuncture],
  };
  const gardes = await solveGardes(gardeInput);
  if (gardes.status === 'infeasible') return gardes;

  const gardeByDay: Record<number, { G1?: DoctorId; G2?: DoctorId }> = {};
  for (const a of gardes.assignments) (gardeByDay[a.day] ??= {})[a.role] = a.doctorId;

  const acuOn = input.acupuncture !== false; // acupuncture scheduling active for this planning

  // Permanent rule "acupuncture doctor is always G2, never G1" is now enforced upstream by the garde
  // role balancer (via `forceG2` above), so no post-hoc swap is needed here.

  const grid: Record<DoctorId, Record<number, string>> = {};
  for (const doc of doctors) grid[doc] = {};

  // Compensation off (récup) for weekend gardes whose RS falls on a non-working day.
  // Team ≥ 12 active → Saturday-garde doctors get the FOLLOWING Monday off.
  // Team > 12 active → Friday-garde doctors also get the following Monday off.
  // Exception: an acupuncture doctor is NOT compensated (she keeps her Monday ACU).
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
      for (const doc of [g.G1, g.G2]) if (doc && !(acuOn && acupuncture.has(doc))) compOff.add(`${doc}|${mondayDay}`);
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

  // Acupuncture (Mondays + Wednesdays). If on the G2 garde that day → 'ACU+G2' (ACU in the day,
  // garde from 18h); those days need MS maternity cover until 18h (tracked in acuG2Days).
  // Wednesday exception: if she's on garde Tuesday (→ Wednesday RS), acupuncture moves to Thursday.
  const acuG2Days = new Set<number>();
  const placeAcu = (doc: DoctorId, day: number) => {
    if (grid[doc][day] === 'G2') { grid[doc][day] = 'ACU+G2'; acuG2Days.add(day); }
    else if (isPresent(doc, day) && !grid[doc][day]) grid[doc][day] = 'ACU';
  };
  if (acuOn) {
    for (const doc of acupuncture) {
      for (const cd of days) {
        if (cd.weekday === 0) {
          placeAcu(doc, cd.day); // Monday
        } else if (cd.weekday === 2) {
          if (isGarde(doc, cd.day - 1)) {
            // Tuesday garde → Wednesday RS → move ACU to Thursday.
            const thu = days.find((x) => x.day === cd.day + 1 && x.weekday === 3);
            if (thu) placeAcu(doc, thu.day);
          } else {
            placeAcu(doc, cd.day); // Wednesday
          }
        }
      }
    }
  }

  // Univ (declared): a universitaire who posted their own constraint days gets U on EXACTLY those
  // days. If a declared day is also their garde: G1 → 'U+G1' (they're at the fac in the day, so
  // another doctor must hold the bloc 7h30-18h → a BM-BS post that day); G2 → 'U+G2' (evening garde
  // only, the day's G1 already covers the bloc, no replacement). Otherwise a plain 'U'.
  const bmbsDays = new Set<number>();
  for (const doc of doctors) {
    if (univDays[doc].size === 0) continue;
    for (const day of univDays[doc]) {
      const cell = grid[doc][day];
      if (cell === 'G1') { grid[doc][day] = 'U+G1'; bmbsDays.add(day); }
      else if (cell === 'G2') { grid[doc][day] = 'U+G2'; }
      else if (isPresent(doc, day) && !cell) grid[doc][day] = 'U';
    }
  }

  // Pass 2 — University (U): for each universitaire doctor WITHOUT declared constraint days, mark
  // ~ratio% of their WEEKDAY working days as U, spread evenly. Skipped in July/August (academic break).
  const isAcademicBreak = input.month === 7 || input.month === 8;
  if (!isAcademicBreak) {
    for (const doc of doctors) {
      const prof = input.profiles?.[doc];
      if (!prof?.universitaire) continue;
      if (univDays[doc].size > 0) continue; // declared days already placed above
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

    // Consultation douleur (CD) — RESERVED to doctors with a douleur profile (douleurPoids ≥ 1).
    // Esbuy (poids 2) does ~2× the others: we pick the eligible present doctor with the lowest
    // CD-count PER unit of weight, so a poids-2 doctor is chosen about twice as often. Still gated by
    // effectif ≥ 9; if no eligible doctor is present that day, CD is simply not covered.
    if (presentCount >= 9) {
      const cdCandidates = pool.filter((doc) => douleurPoids[doc] >= 1);
      if (cdCandidates.length) {
        const doc = [...cdCandidates].sort((a, b) => {
          const ra = (postCount[a]['CD'] ?? 0) / douleurPoids[a];
          const rb = (postCount[b]['CD'] ?? 0) / douleurPoids[b];
          return ra !== rb ? ra - rb : a.localeCompare(b);
        })[0];
        assign(doc, 'CD');
      }
    }

    // Required posts for the day, in priority order. Specials apply by day rule / headcount,
    // and are distributed across ALL present doctors (no dedicated specialists).
    const wanted: string[] = [];
    if (PED_DAYS.has(cd.weekday)) wanted.push('Ped'); // pédiatrie lun/mer/jeu/ven
    // Maternité : MS (jusqu'à 18h) les jours où le médecin acupuncture prend la G2 à 18h ; sinon MM.
    wanted.push(acuG2Days.has(cd.day) ? 'MS' : 'MM');
    // BM-BS : bloc journée 7h30-18h, tenu par un autre médecin quand un universitaire est U+G1 ce jour.
    if (bmbsDays.has(cd.day)) wanted.push('BM-BS');
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

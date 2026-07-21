// Phase B — full monthly planning. Builds on the garde skeleton (Phase A) and assigns the
// OTHER daily posts to every present doctor, using the acronyms from the service guide.
//
// Posts (acronyms from the Word guide):
//   G1, G2 = gardes (Phase A) · RS = repos de sécurité (lendemain de garde)
//   U  = universitaire (médecins universitaires, au prorata de leur ratio fac)
//   Ped = pédiatrie (lun/mer/jeu/ven) · MM/MS = maternité (seulement quand le médecin acupuncture
//   est de garde ET ≥ 12 travaillants) · CD = consultation douleur (profil douleur, capacité)
//   BM = bloc matin (2/jour, 3 si ≥ 10 travaillants) · S = service · CS1/CS2 = consultations
//   (les deux si ≥ 9 travaillants, un seul alterné à 8) · HC = hors clinique
//   CA = congé · '' = repos (week-end/férié, jour off TP, ou récup)
//   « Travaillants » = présents réels du jour (ni congé, ni TP off, ni récup, ni U) — jamais le
//   nombre de médecins simplement cochés sur le roster.
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
  /** Legacy single acupuncture flag — equivalent to acuLundi + acuMercredi together. */
  acupuncture?: boolean;
  /** ACU on Mondays when present (Dr Dzierzek). */
  acuLundi?: boolean;
  /** ACU on Wednesdays (moved to Thursday when on garde Tuesday). */
  acuMercredi?: boolean;
  /** Consultation douleur (CD) weight: 0 = not eligible (default), 1 = simple, 2 = double (Esbuy). */
  douleurPoids?: number;
  /** "Jamais G1" : never the G1 role, only G2 (Dr Dzierzek — back problems). Independent of
   * acupuncture, even though today the same person carries both flags. */
  forceG2?: boolean;
  /** "Pas de S" : never assigned the S post. */
  noS?: boolean;
  /** Eligible for the P (présence) post — assigned only when ≥ 12 travaillants. */
  presence?: boolean;
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
  /** Cross-month garde equity: the previous published month's counters (count / heavy / weekend)
   * per doctor. A doctor overloaded last month is relieved this month. */
  carryCount?: Record<DoctorId, number>;
  carryHeavy?: Record<DoctorId, number>;
  carryWeekend?: Record<DoctorId, number>;
}

export type PlanningResult =
  | {
      status: 'feasible';
      days: CalendarDay[];
      grid: Record<DoctorId, Record<number, string>>;
      gardeEquity: EquityReport;
      /** Non-blocking issues the admin must review (G+ non honorés, ACU non posé, profil manquant…). */
      warnings: string[];
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

  // Acupuncture split by day: "Acu lundi" and "Acu mercredi" checkboxes; the legacy single
  // `acupuncture` flag counts as both. The union (`acuDocs`) drives the shared acu rules:
  // ACU+G2 evening gardes, MM/MS maternity trigger, and the récup exemption.
  const legacyAcu = (doc: DoctorId) => !!input.profiles?.[doc]?.acupuncture;
  const acuLundi = new Set(doctors.filter((doc) => input.profiles?.[doc]?.acuLundi || legacyAcu(doc)));
  const acuMercredi = new Set(doctors.filter((doc) => input.profiles?.[doc]?.acuMercredi || legacyAcu(doc)));
  const acuDocs = new Set([...acuLundi, ...acuMercredi]);
  // "Jamais G1" — doctors who NEVER take the G1 role (Dzierzek: back problems). Independent flag,
  // plus the acupuncture doctors (their evening-G2-after-ACU rule still requires G2-only).
  const neverG1 = new Set(doctors.filter((doc) => input.profiles?.[doc]?.forceG2 || acuDocs.has(doc)));
  // "Pas de S" and "P" (présence) eligibility.
  const noS = new Set(doctors.filter((doc) => input.profiles?.[doc]?.noS));
  const presenceDocs = new Set(doctors.filter((doc) => input.profiles?.[doc]?.presence));

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

  // Garde fairness weight = part-time fraction × availability fraction — where the availability
  // fraction EXCLUDES the part-time off days (the fte factor already covers those; counting them
  // twice used to give a 50% doctor only ~32% of a full-timer's gardes instead of 50%).
  const totalDays = days.length;
  const gardeWeight: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    const nonTpBlocked = new Set<number>();
    for (const cd of days) if (!GARDEABLE(avail(input, doc, cd.day))) nonTpBlocked.add(cd.day);
    for (const d of univDays[doc]) if (d - 1 >= 1) nonTpBlocked.add(d - 1);
    gardeWeight[doc] = fte[doc] * ((totalDays - nonTpBlocked.size) / totalDays);
  }

  const gardeInput: GardeInput = {
    year: input.year, month: input.month, doctors,
    gardeBlocked, holidays: input.holidays, wishes, fte: gardeWeight,
    // Cross-month equity: last published month's counters relieve whoever was overloaded.
    carryCount: input.carryCount, carryHeavy: input.carryHeavy, carryWeekend: input.carryWeekend,
    // "Jamais G1" doctors (Dzierzek) + acupuncture doctors are ALWAYS G2 — role balancer rule.
    forceG2: [...neverG1],
  };
  const gardes = await solveGardes(gardeInput);
  if (gardes.status === 'infeasible') return gardes;
  const warnings = [...gardes.warnings];

  const gardeByDay: Record<number, { G1?: DoctorId; G2?: DoctorId }> = {};
  for (const a of gardes.assignments) (gardeByDay[a.day] ??= {})[a.role] = a.doctorId;

  const acuOn = input.acupuncture !== false; // acupuncture scheduling active for this planning
  // Guard-rail: ACU active but nobody carries the profile → the flag was probably lost in the
  // doctor sheet. Without it there is NO forced G2 and NO ACU day — exactly the "Dzierzek gets
  // G1s and her ACU disappeared" symptom — so surface it loudly instead of failing silently.
  if (acuOn && acuDocs.size === 0) {
    warnings.push(
      'Acupuncture activée mais aucun médecin du roster n\'a le profil « Acu lun. » : aucun ACU ne sera posé. ' +
        'Vérifie la fiche du médecin acupuncture (et la case « Jamais G1 » pour Dzierzek).',
    );
  }

  // Permanent rule "acupuncture doctor is always G2, never G1" is now enforced upstream by the garde
  // role balancer (via `forceG2` above), so no post-hoc swap is needed here.

  const grid: Record<DoctorId, Record<number, string>> = {};
  for (const doc of doctors) grid[doc] = {};

  // BASE presence: on the roster, not on congé, not on a part-time off day. Récup (comp-off) is
  // decided LATER — once U days are placed — because it depends on the real working count.
  const basePresent = (doc: DoctorId, day: number) =>
    PRESENT(avail(input, doc, day)) && !tpDays[doc].has(day);
  const isGarde = (doc: DoctorId, day: number) => gardeByDay[day]?.G1 === doc || gardeByDay[day]?.G2 === doc;
  const isRS = (doc: DoctorId, day: number) =>
    basePresent(doc, day) && !isGarde(doc, day) && (gardeByDay[day - 1]?.G1 === doc || gardeByDay[day - 1]?.G2 === doc);

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

  // Univ (declared): a universitaire who posted their own constraint days gets U on EXACTLY those
  // days. If a declared day is also their garde: G1 → 'U+G1' (they're at the fac in the day, so
  // another doctor must hold the bloc 7h30-18h → a BM-BS post that day); G2 → 'U+G2' (evening garde
  // only, the day's G1 already covers the bloc, no replacement). Otherwise a plain 'U'.
  // (Placed BEFORE ACU and récup: the working count that gates those must know who is at the fac.)
  const bmbsDays = new Set<number>();
  for (const doc of doctors) {
    if (univDays[doc].size === 0) continue;
    for (const day of univDays[doc]) {
      const cell = grid[doc][day];
      if (cell === 'G1') { grid[doc][day] = 'U+G1'; bmbsDays.add(day); }
      else if (cell === 'G2') { grid[doc][day] = 'U+G2'; }
      else if (basePresent(doc, day) && !cell) grid[doc][day] = 'U';
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
        .filter((cd) => !cd.isWeekend && !cd.isHoliday && basePresent(doc, cd.day) && !grid[doc][cd.day])
        .map((cd) => cd.day);
      const k = Math.round((ratio / 100) * workdays.length);
      for (const day of pickEven(workdays, k)) grid[doc][day] = 'U';
    }
  }

  // "Travaillants" — the REAL daily headcount every staffing threshold uses (never the number of
  // doctors merely checked on the roster): on the roster, not on congé, not on a part-time off
  // day, and not at the university that day (U/U+G1/U+G2 — a universitaire may still hold an
  // evening garde but is absent from the day service). G1, G2, RS, ACU — and RÉCUP days — all
  // COUNT as working ("nous sommes 12 à travailler y compris les RS"); récup doctors are simply
  // not assignable to a post (the Pass-3 pool excludes them).
  const U_CELLS = new Set(['U', 'U+G1', 'U+G2']);
  const compOff = new Set<string>(); // `${doctor}|${day}`
  const isWorking = (doc: DoctorId, day: number) =>
    basePresent(doc, day) && !U_CELLS.has(grid[doc][day] ?? '');
  const workingCount = (day: number) => doctors.filter((d) => isWorking(d, day)).length;

  // Acupuncture (Mondays + Wednesdays), only when ≥ 9 doctors work that day (below that, every
  // hand is needed for the mandatory posts). If on the G2 garde that day → 'ACU+G2' (ACU in the
  // day, garde from 18h). Wednesday exception: garde Tuesday (→ Wednesday RS) moves ACU to Thursday.
  const acuG2Days = new Set<number>();
  const placeAcu = (doc: DoctorId, day: number) => {
    const canAcu = grid[doc][day] === 'G2' || (basePresent(doc, day) && !grid[doc][day]);
    if (!canAcu) return;
    if (workingCount(day) < 9) {
      warnings.push(`ACU non posé le ${day} : moins de 9 médecins travaillants ce jour-là.`);
      return;
    }
    if (grid[doc][day] === 'G2') { grid[doc][day] = 'ACU+G2'; acuG2Days.add(day); }
    else grid[doc][day] = 'ACU';
  };
  if (acuOn) {
    for (const cd of days) {
      if (cd.weekday === 0) {
        for (const doc of acuLundi) placeAcu(doc, cd.day); // Monday
      } else if (cd.weekday === 2) {
        for (const doc of acuMercredi) {
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

  // Récup (comp-off) — échelle des travaillants du lundi (récup et RS comptent dedans) :
  //   ≥ 13 → le G1 du samedi a son lundi off ; ≥ 14 → le G2 du samedi aussi.
  // Based on WORKING doctors, never roster size. The acupuncture doctor is never compensated
  // (keeps her Monday ACU).
  for (const cd of days) {
    if (cd.weekday !== 5) continue; // Saturday
    const g = gardeByDay[cd.day];
    if (!g) continue;
    const md = days.find((x) => x.day === cd.day + 2);
    if (!md || md.weekday !== 0 || md.isHoliday) continue;
    const working = workingCount(md.day);
    const granted: (DoctorId | undefined)[] = [];
    if (working >= 13) granted.push(g.G1);
    if (working >= 14) granted.push(g.G2);
    for (const doc of granted) {
      if (!doc) continue;
      if (acuOn && acuDocs.has(doc)) continue;
      if (!basePresent(doc, md.day) || grid[doc][md.day]) continue; // congé/TP, or RS/U/ACU already there
      compOff.add(`${doc}|${md.day}`);
    }
  }

  // Pass 3 — day posts (weekdays only). MANDATORY core per the staffing table, then extras
  // following the working-count ladder, strictly limited to the spare capacity beyond the core:
  //   Core (priority order): [BM-BS if a U+G1 that day], BM, BM, S, then CS1+CS2 (≥ 9 working)
  //   or a single alternating CS (8 working — weekly + monthly CS1/CS2 balance kept even).
  //   Extras ladder: Ped (Mon/Wed/Thu/Fri) · 3rd BM (≥ 10) · CD (≥ 11, douleur-weighted) ·
  //   P (≥ 12, présence-flagged doctors only) · MM/MS (≥ 12 AND the acupuncture doctor on garde;
  //   MS when her garde follows a daytime ACU). Whoever is left → HC (the admin adjusts manually
  //   beyond 14: HC or off for doctors already above 48h/week).
  const postCount: Record<DoctorId, Record<string, number>> = {};
  const totalPosts: Record<DoctorId, number> = {};
  for (const doc of doctors) { postCount[doc] = {}; totalPosts[doc] = 0; }
  const csWeek = new Map<number, { CS1: number; CS2: number }>();
  const csMonth = { CS1: 0, CS2: 0 };
  // Deterministic rotation for tie-breaks: the alphabetical order shifted by the day number, so
  // early-sorted names no longer systematically win every tie.
  const alphaIdx = new Map([...doctors].sort((a, b) => a.localeCompare(b)).map((d, i) => [d, i]));

  for (const cd of days) {
    // Weekend / holiday: only gardes + RS exist. Everyone else present is off (blank).
    if (cd.isWeekend || cd.isHoliday) continue;

    const working = workingCount(cd.day);
    // Assignable pool: working, no cell yet, and not on récup (récup counts in `working` but
    // stays blank — the doctor is resting).
    let pool = doctors.filter(
      (doc) => isWorking(doc, cd.day) && !grid[doc][cd.day] && !compOff.has(`${doc}|${cd.day}`),
    );

    const assign = (doc: DoctorId, post: string) => {
      grid[doc][cd.day] = post;
      postCount[doc][post] = (postCount[doc][post] ?? 0) + 1;
      totalPosts[doc] += 1;
      pool = pool.filter((d) => d !== doc);
    };
    // Fairness pick: fewest of THIS post, then lightest total Pass-3 load (so specialty doctors
    // don't also top the generic posts), then day-rotated deterministic order.
    const rot = (doc: DoctorId) => ((alphaIdx.get(doc) ?? 0) + cd.day) % doctors.length;
    const leastFor = (post: string, candidates?: DoctorId[]): DoctorId | undefined =>
      [...(candidates ?? pool)].sort((a, b) => {
        const ca = postCount[a][post] ?? 0, cb = postCount[b][post] ?? 0;
        if (ca !== cb) return ca - cb;
        if (totalPosts[a] !== totalPosts[b]) return totalPosts[a] - totalPosts[b];
        return rot(a) - rot(b);
      })[0];

    // Which CS runs today: both at ≥ 9 working; at ≤ 8 only the LAGGING one (weekly balance
    // first, monthly tie-break) so CS1/CS2 stay even over each week and over the month.
    const weekId = cd.day - cd.weekday; // day-number of that week's Monday (unique per week)
    const wk = csWeek.get(weekId) ?? { CS1: 0, CS2: 0 };
    csWeek.set(weekId, wk);
    const lag: 'CS1' | 'CS2' =
      wk.CS1 !== wk.CS2 ? (wk.CS1 < wk.CS2 ? 'CS1' : 'CS2') : csMonth.CS1 <= csMonth.CS2 ? 'CS1' : 'CS2';
    const core: string[] = [];
    if (bmbsDays.has(cd.day)) core.push('BM-BS'); // bloc 7h30-18h quand un universitaire est U+G1
    core.push('BM', 'BM', 'S');
    if (working >= 9) core.push(lag, lag === 'CS1' ? 'CS2' : 'CS1');
    else core.push(lag);

    // Extras ladder — only with spare capacity beyond the core, gated by the working count.
    let budget = pool.length - core.length;
    if (budget > 0 && PED_DAYS.has(cd.weekday)) {
      const doc = leastFor('Ped'); // pédiatrie lun/mer/jeu/ven
      if (doc) { assign(doc, 'Ped'); budget -= 1; }
    }
    if (budget > 0 && working >= 10) {
      const doc = leastFor('BM'); // 3e bloc quand ≥ 10 travaillants
      if (doc) { assign(doc, 'BM'); budget -= 1; }
    }
    if (budget > 0 && working >= 11) {
      // Consultation douleur (CD) — RESERVED to doctors with a douleur profile (douleurPoids ≥ 1).
      // Esbuy (poids 2) does ~2× the others: lowest CD-count PER unit of weight wins.
      const cdCandidates = pool.filter((doc) => douleurPoids[doc] >= 1);
      if (cdCandidates.length) {
        const doc = [...cdCandidates].sort((a, b) => {
          const ra = (postCount[a]['CD'] ?? 0) / douleurPoids[a];
          const rb = (postCount[b]['CD'] ?? 0) / douleurPoids[b];
          return ra !== rb ? ra - rb : rot(a) - rot(b);
        })[0];
        assign(doc, 'CD');
        budget -= 1;
      }
    }
    if (budget > 0 && working >= 12) {
      // P (présence) — only doctors with the P checkbox.
      const doc = leastFor('P', pool.filter((d) => presenceDocs.has(d)));
      if (doc) { assign(doc, 'P'); budget -= 1; }
    }
    // Maternité : UNIQUEMENT quand le médecin acupuncture (Dzierzek) est de garde ce jour ET
    // ≥ 12 travaillants. 'MS' (couverture jusqu'à 18h) si sa garde suit un ACU en journée, sinon 'MM'.
    const g = gardeByDay[cd.day] ?? {};
    const acuOnGarde = [g.G1, g.G2].some((d) => d && acuDocs.has(d));
    if (budget > 0 && acuOnGarde && working >= 12) {
      const post = acuG2Days.has(cd.day) ? 'MS' : 'MM';
      const doc = leastFor(post);
      if (doc) { assign(doc, post); budget -= 1; }
    }

    // Core fill — by construction the pool still covers it (extras only consumed the surplus).
    // "Pas de S": the S post never goes to a flagged doctor; if nobody else remains, S stays
    // uncovered with a warning (the flagged doctors fall through to the other posts / HC).
    for (const post of core) {
      if (pool.length === 0) break;
      const doc = post === 'S' ? leastFor('S', pool.filter((d) => !noS.has(d))) : leastFor(post);
      if (!doc) {
        if (post === 'S') warnings.push(`S non couvert le ${cd.day} : tous les médecins restants ont « Pas de S ».`);
        continue;
      }
      assign(doc, post);
      if (post === 'CS1' || post === 'CS2') { wk[post] += 1; csMonth[post] += 1; }
    }
    // Leftover → HC.
    for (const doc of [...pool]) assign(doc, 'HC');
  }

  return { status: 'feasible', days, grid, gardeEquity: gardes.equity, warnings };
}

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
  /** Médecins de garde le dernier jour du mois calendaire JUSTE précédent (déjà publié).
   * Reçoivent un RS le 1er du mois, et sont bloqués de garde le 1 et le 2 (règle de repos
   * inter-mois : garde le dernier jour → RS le 1er → 2 encore interdit → 1re garde possible le 3).
   * Renseigné par la route uniquement à partir de juillet 2026 et si le mois précédent est contigu. */
  carryGardeLastDay?: DoctorId[];
  /**
   * Par médecin à temps partiel : jours de semaine (1-based) DÉCLARÉS comme souhaités
   * travaillés ("TP"). Ces jours (union avec les jours souhait_garde) sont TOUJOURS travaillés ;
   * le reste du quota (ratio) est complété automatiquement. Un dépassement du quota est honoré
   * et signalé dans `warnings`.
   */
  tpPreferred?: Record<DoctorId, number[]>;
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
  forced: Set<number>,
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
    // Forced working days (declared "TP" or souhait_garde) are ALWAYS worked; auto-fill the rest
    // up to the weekly target. Honoring more forced days than the target this week pushes the
    // credit negative → later weeks fill fewer days, keeping the month close to the ratio.
    const working = new Set(group.filter((d) => forced.has(d)));
    if (working.size < work) {
      const remaining = group.filter((d) => !working.has(d));
      for (const d of pickEven(remaining, work - working.size)) working.add(d);
    }
    credit -= working.size;
    for (const day of group) if (!working.has(day)) tp.add(day);
  }
  return tp;
}

export async function solvePlanning(input: PlanningInput): Promise<PlanningResult> {
  const days = buildMonth(input.year, input.month, DEFAULT_WEIGHTS, input.holidays ?? []);
  const doctors = input.doctors;

  // Médecins de garde le dernier jour du mois précédent : leur RS tombe le 1er de ce mois, et la
  // règle de repos leur interdit une garde le 1 comme le 2 (même mécanisme que la « veille de jour
  // Univ »). Filtré au roster de ce mois (un médecin parti n'a plus rien à reporter).
  const carriedRS = new Set((input.carryGardeLastDay ?? []).filter((d) => doctors.includes(d)));

  const fte: Record<DoctorId, number> = {};
  for (const doc of doctors) fte[doc] = input.profiles?.[doc]?.fte ?? 1;

  // Consultation douleur (CD) eligibility & weight per doctor: 0 = not eligible, 1 = simple, 2 = double.
  const douleurPoids: Record<DoctorId, number> = {};
  for (const doc of doctors) douleurPoids[doc] = input.profiles?.[doc]?.douleurPoids ?? 0;

  // Part-time off days (TP): part-timers don't work every day — ~fte of their present weekdays,
  // in a 3/2-style weekly alternation. Days DECLARED "TP" (input.tpPreferred) or wished for a
  // garde (souhait_garde) are forced working; the rest of the quota is auto-filled. Off days get
  // no post and look like any day off.
  const tpPreferred = input.tpPreferred ?? {};
  const tpWarnings: string[] = [];
  const tpDays: Record<DoctorId, Set<number>> = {};
  for (const doc of doctors) {
    if (fte[doc] >= 1) { tpDays[doc] = new Set(); continue; }
    const pref = new Set(tpPreferred[doc] ?? []);
    const forced = new Set<number>();
    let availWeekdays = 0;
    for (const cd of days) {
      if (cd.isWeekend || cd.isHoliday || !PRESENT(avail(input, doc, cd.day))) continue;
      availWeekdays++;
      if (pref.has(cd.day) || avail(input, doc, cd.day) === 'souhait_garde') forced.add(cd.day);
    }
    tpDays[doc] = computeTpDays(days, (day) => PRESENT(avail(input, doc, day)), fte[doc], forced);
    const target = Math.round(fte[doc] * availWeekdays);
    if (forced.size > target) {
      tpWarnings.push(
        `${doc} (TP ${Math.round(fte[doc] * 100)} %) : ${forced.size} jours souhaités travaillés ` +
          `au-delà de son quota (~${target}) — tous honorés.`,
      );
    }
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
    // Garde le dernier jour du mois précédent → RS le 1er, 2 encore en repos : garde interdite le 1 et 2.
    if (carriedRS.has(doc)) blocked.push(1, 2);
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
    // Les 2 jours de repos inter-mois réduisent aussi la cible de gardes (comme la veille de jour Univ).
    if (carriedRS.has(doc)) { nonTpBlocked.add(1); nonTpBlocked.add(2); }
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
  warnings.push(...tpWarnings);

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
  // RS (repos de sécurité) is MANDATORY the day after a garde — it shows and counts even when it
  // lands on a part-timer's off day (only congé wins). It does NOT consume the part-timer's
  // worked-days quota: their normal TP pattern stays as computed, the RS is an extra displayed
  // day. (An hidden RS used to make the working count 8 instead of 9 → a CS slot vanished and a
  // doctor fell to HC.)
  const isRS = (doc: DoctorId, day: number) =>
    PRESENT(avail(input, doc, day)) && !isGarde(doc, day) &&
    ((gardeByDay[day - 1]?.G1 === doc || gardeByDay[day - 1]?.G2 === doc) ||
      // Le 1er : RS reporté de la garde tenue le dernier jour du mois précédent (garde du 1 bloquée).
      (day === 1 && carriedRS.has(doc)));

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
  // An RS cell counts as working even on a part-timer's off day (mandatory rest after a garde).
  const isWorking = (doc: DoctorId, day: number) =>
    (basePresent(doc, day) || grid[doc][day] === 'RS') && !U_CELLS.has(grid[doc][day] ?? '');
  const workingCount = (day: number) => doctors.filter((d) => isWorking(d, day)).length;

  // Acupuncture (Mondays + Wednesdays), only when ≥ 10 doctors work that day (below that, every
  // hand is needed for the mandatory posts). If on the G2 garde that day → 'ACU+G2' (ACU in the
  // day, garde from 18h). Wednesday exception: garde Tuesday (→ Wednesday RS) moves ACU to Thursday.
  const acuG2Days = new Set<number>();
  const placeAcu = (doc: DoctorId, day: number) => {
    const canAcu = grid[doc][day] === 'G2' || (basePresent(doc, day) && !grid[doc][day]);
    if (!canAcu) return;
    // ≥ 10: the 9-post core (G1, G2, 2 RS, 2 blocs, S, CS1, CS2) needs 9 bodies — the ACU is a
    // 10th. At 9 working an ACU would starve a core post (the self-check used to flag it).
    if (workingCount(day) < 10) {
      warnings.push(`ACU non posé le ${day} : moins de 10 médecins travaillants (le cœur de 9 postes passe d'abord).`);
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
  //   Core (priority order): [BM-BS if a U+G1 that day], BM, then Ped on Mon/Wed/Thu/Fri (the Ped
  //   IS one of the day's 2-3 "bloc" bodies, it replaces the 2nd BM — exactly one Ped those days,
  //   none on Tuesday) or a 2nd BM, then S, then the CS slots (2 at ≥ 9 working, 1 at 8).
  //   Extras ladder: 3rd BM (≥ 10) · CD (≥ 11, douleur-weighted) · P (≥ 12, présence-flagged
  //   doctors only) · MM/MS (≥ 12 AND the acupuncture doctor on garde; MS when her garde follows
  //   a daytime ACU). Whoever is left → HC (the admin adjusts manually beyond 14).
  //   CS1/CS2 get a DEDICATED equity engine (see the CS block below): combined per-doctor count
  //   prorated on presence days, hard cap 6 CS/doctor/month, per-doctor CS1/CS2 alternation, no
  //   CS two calendar days in a row, day-after-RS preferred on exact equity ties.
  const postCount: Record<DoctorId, Record<string, number>> = {};
  const totalPosts: Record<DoctorId, number> = {};
  for (const doc of doctors) { postCount[doc] = {}; totalPosts[doc] = 0; }
  const csWeek = new Map<number, { CS1: number; CS2: number }>();
  const csMonth = { CS1: 0, CS2: 0 };
  // Deterministic rotation for tie-breaks: the alphabetical order shifted by the day number, so
  // early-sorted names no longer systematically win every tie.
  const alphaIdx = new Map([...doctors].sort((a, b) => a.localeCompare(b)).map((d, i) => [d, i]));

  // CS equity state. The old scheme balanced CS1 and CS2 as two independent posts, so a doctor
  // could end up "balanced" at 4 CS1 + 4 CS2 = 8 while a colleague (often taken by gardes/RS/U
  // when CS was handed out) sat at 2. The combined counter + presence prorata fixes that.
  const MAX_CS_PER_MONTH = 6;
  const csTotal: Record<DoctorId, number> = {};
  const cs1Cnt: Record<DoctorId, number> = {};
  const cs2Cnt: Record<DoctorId, number> = {};
  const lastCsDay: Record<DoctorId, number> = {};
  const presWeekdays: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    csTotal[doc] = 0; cs1Cnt[doc] = 0; cs2Cnt[doc] = 0; lastCsDay[doc] = -9;
    presWeekdays[doc] = days.filter(
      (cd) => !cd.isWeekend && !cd.isHoliday && isWorking(doc, cd.day) && !compOff.has(`${doc}|${cd.day}`),
    ).length;
  }

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

    // How many CS slots today (2 at ≥ 9 working, 1 at 8), and which label lags for the
    // single-slot case (weekly balance first, monthly tie-break).
    const weekId = cd.day - cd.weekday; // day-number of that week's Monday (unique per week)
    const wk = csWeek.get(weekId) ?? { CS1: 0, CS2: 0 };
    csWeek.set(weekId, wk);
    const lag: 'CS1' | 'CS2' =
      wk.CS1 !== wk.CS2 ? (wk.CS1 < wk.CS2 ? 'CS1' : 'CS2') : csMonth.CS1 <= csMonth.CS2 ? 'CS1' : 'CS2';
    const csSlots = working >= 9 ? 2 : 1;
    // Core in two waves around the CS engine: S first (it carries the « Pas de S » eligibility
    // constraint), then CS picked from a still-wide pool (so its equity/cap logic has real
    // choice — filling CS last used to leave it the 2 leftover doctors, with zero freedom),
    // then the fully-generic blocs (BM / Ped) last.
    const coreFirst: string[] = [];
    if (bmbsDays.has(cd.day)) coreFirst.push('BM-BS'); // bloc 7h30-18h quand un universitaire est U+G1
    coreFirst.push('S');
    // Ped IS one of the day's blocs on Mon/Wed/Thu/Fri: it replaces the 2nd BM (exactly one Ped
    // those days, none on Tuesday). The ≥10 extra below still adds a plain BM.
    const coreRest: string[] = ['BM', PED_DAYS.has(cd.weekday) ? 'Ped' : 'BM'];

    // Extras ladder — only with spare capacity beyond the core AND the CS slots.
    let budget = pool.length - coreFirst.length - coreRest.length - csSlots;
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

    // Core wave 1 — [BM-BS], S. "Pas de S": the S post never goes to a flagged doctor; if nobody
    // else remains, S stays uncovered with a warning (flagged doctors fall through to other posts).
    for (const post of coreFirst) {
      if (pool.length === 0) break;
      const doc = post === 'S' ? leastFor('S', pool.filter((d) => !noS.has(d))) : leastFor(post);
      if (!doc) {
        if (post === 'S') warnings.push(`S non couvert le ${cd.day} : tous les médecins restants ont « Pas de S ».`);
        continue;
      }
      assign(doc, post);
    }

    // CS fill — dedicated equity: pick doctors by combined CS count prorated on their presence
    // days (hard cap 6/month), never two calendar days in a row (unless nobody else can),
    // day-after-RS preferred on exact ties, neutral rotation last. Labels: the single-slot day
    // takes the week-lagging label; with two slots each doctor gets the label they personally
    // lag on (per-doctor CS1/CS2 alternation), conflicts resolved by the bigger gap.
    const csLabelPref = (d: DoctorId): 'CS1' | 'CS2' =>
      cs1Cnt[d] < cs2Cnt[d] ? 'CS1' : cs2Cnt[d] < cs1Cnt[d] ? 'CS2' : lag;
    const csPick = (wantLabel?: 'CS1' | 'CS2'): DoctorId | undefined => {
      const underCap = pool.filter((d) => csTotal[d] < MAX_CS_PER_MONTH);
      if (!underCap.length) {
        if (pool.length) warnings.push(`CS non couvert le ${cd.day} : tous les médecins disponibles ont déjà ${MAX_CS_PER_MONTH} CS ce mois-ci.`);
        return undefined;
      }
      const noStreak = underCap.filter((d) => lastCsDay[d] !== cd.day - 1);
      return [...(noStreak.length ? noStreak : underCap)].sort((a, b) => {
        const ra = csTotal[a] / Math.max(presWeekdays[a], 1);
        const rb = csTotal[b] / Math.max(presWeekdays[b], 1);
        if (ra !== rb) return ra - rb; // équité quantité/prorata d'abord
        const rsA = grid[a][cd.day - 1] === 'RS' ? 0 : 1; // puis lendemain de RS
        const rsB = grid[b][cd.day - 1] === 'RS' ? 0 : 1;
        if (rsA !== rsB) return rsA - rsB;
        if (wantLabel) {
          // 2nd slot: prefer a doctor whose own lagging label COMPLEMENTS the 1st pick's,
          // so both get the label they personally need (fewer alternation conflicts).
          const wa = csLabelPref(a) === wantLabel ? 0 : 1;
          const wb = csLabelPref(b) === wantLabel ? 0 : 1;
          if (wa !== wb) return wa - wb;
        }
        if (totalPosts[a] !== totalPosts[b]) return totalPosts[a] - totalPosts[b];
        return rot(a) - rot(b);
      })[0];
    };
    const picked: DoctorId[] = [];
    for (let s = 0; s < csSlots && pool.length; s++) {
      const want = picked.length === 1 ? (csLabelPref(picked[0]) === 'CS1' ? 'CS2' : 'CS1') : undefined;
      const doc = csPick(want);
      if (!doc) break;
      picked.push(doc);
      pool = pool.filter((d) => d !== doc); // reserved; labelled and written just below
    }
    const labels: ('CS1' | 'CS2')[] = [];
    if (picked.length === 1) labels.push(lag);
    else if (picked.length === 2) {
      const p0 = csLabelPref(picked[0]);
      const p1 = csLabelPref(picked[1]);
      if (p0 !== p1) labels.push(p0, p1);
      else {
        const gap = (d: DoctorId) => Math.abs(cs1Cnt[d] - cs2Cnt[d]);
        const other: 'CS1' | 'CS2' = p0 === 'CS1' ? 'CS2' : 'CS1';
        if (gap(picked[0]) >= gap(picked[1])) labels.push(p0, other);
        else labels.push(other, p0);
      }
    }
    picked.forEach((doc, i) => {
      const label = labels[i];
      grid[doc][cd.day] = label;
      postCount[doc][label] = (postCount[doc][label] ?? 0) + 1;
      totalPosts[doc] += 1;
      csTotal[doc] += 1;
      (label === 'CS1' ? cs1Cnt : cs2Cnt)[doc] += 1;
      lastCsDay[doc] = cd.day;
      wk[label] += 1;
      csMonth[label] += 1;
    });

    // Core wave 2 — the generic blocs (BM / Ped), then leftover → HC.
    for (const post of coreRest) {
      if (pool.length === 0) break;
      const doc = leastFor(post);
      if (doc) assign(doc, post);
    }
    const hcCount = pool.length;
    for (const doc of [...pool]) assign(doc, 'HC');

    // Self-check: verify the day's MINIMUM posts against its working count and warn about any
    // gap — a counting bug must show up in the amber banner, never as a silently wrong grid.
    if (working >= 8) {
      const nOf = (post: string) => doctors.filter((d) => grid[d][cd.day] === post).length;
      const missing: string[] = [];
      if (nOf('S') < 1) missing.push('S');
      const cs1 = nOf('CS1'), cs2 = nOf('CS2');
      if (working >= 9) {
        if (cs1 < 1) missing.push('CS1');
        if (cs2 < 1) missing.push('CS2');
      } else if (cs1 + cs2 < 1) missing.push('CS');
      const ped = nOf('Ped');
      if (PED_DAYS.has(cd.weekday) && ped < 1) missing.push('Ped');
      if (!PED_DAYS.has(cd.weekday) && ped > 0) missing.push('Ped un mardi (interdit)');
      if (nOf('BM') + ped < 2) missing.push('2 blocs (BM/Ped)');
      if (missing.length) {
        warnings.push(`Contrôle du ${cd.day} : poste(s) manquant(s) — ${missing.join(', ')} (${working} travaillants comptés).`);
      }
      if (hcCount > 0 && working <= 10) {
        warnings.push(`Contrôle du ${cd.day} : ${hcCount} HC alors que seulement ${working} travaillants — surplus inattendu (1er du mois sans RS ?).`);
      }
    }
  }

  return { status: 'feasible', days, grid, gardeEquity: gardes.equity, warnings };
}

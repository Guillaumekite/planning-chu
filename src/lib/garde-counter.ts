// src/lib/garde-counter.ts
// Compte, par jour, le nombre de médecins par poste et vérifie les postes de base.
// Ne lit QUE la grille + les jours (identique en brouillon, en publié et à l'export).
// La logique de contrôle reproduit le bloc « Self-check » de src/engine/planning.ts.

export const POST_ROWS = [
  'G1', 'G2', 'RS', 'S', 'CS1', 'CS2', 'BM', 'Ped', 'MM', 'MS', 'ACU', 'U', 'P', 'HC',
] as const;

export type CounterDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };

export type PostCounter = {
  posts: readonly string[];
  days: CounterDay[];
  counts: Record<number, Record<string, number>>;
  working: Record<number, number>;
  flagged: Record<number, Set<string>>;
  reason: Record<number, string>;
};

const PED_DAYS = new Set([0, 2, 3, 4]); // lun, mer, jeu, ven (Monday = 0)
const NON_WORKING_MAIN = new Set(['', 'CA', 'ABS', 'U']); // ne comptent pas comme travaillants

// Décompose 'ACU+G2' → { main: 'ACU', evening: 'G2' } ; 'G1' → { main: 'G1', evening: undefined }.
function split(raw: string | undefined): { main: string; evening: string | undefined } {
  const [main, evening] = raw ? raw.split('+') : ['', undefined];
  return { main: main ?? '', evening };
}

export function computePostCounter(
  grid: Record<string, Record<number, string>>,
  days: CounterDay[],
): PostCounter {
  const doctors = Object.keys(grid);
  const counts: Record<number, Record<string, number>> = {};
  const working: Record<number, number> = {};
  const flagged: Record<number, Set<string>> = {};
  const reason: Record<number, string> = {};

  for (const cd of days) {
    const day = cd.day;
    const c: Record<string, number> = {};
    for (const p of POST_ROWS) c[p] = 0;
    let work = 0;

    for (const doc of doctors) {
      const { main, evening } = split(grid[doc]?.[day]);
      if (main && main in c) c[main] += 1;        // poste de jour (dont G1/G2 pure)
      if (evening === 'G1' || evening === 'G2') c[evening] += 1; // garde du soir
      if (!NON_WORKING_MAIN.has(main)) work += 1;  // RS/HC/S/... comptent ; U/CA/ABS/'' non
    }

    counts[day] = c;
    working[day] = work;

    // Contrôle des postes de base.
    const miss = new Set<string>();
    const pedForbiddenReason = new Set<string>();
    if (c.G1 !== 1) miss.add('G1');
    if (c.G2 !== 1) miss.add('G2');
    if (!cd.isWeekend && !cd.isHoliday && work >= 8) {
      if (c.S < 1) miss.add('S');
      if (work >= 9) {
        if (c.CS1 < 1) miss.add('CS1');
        if (c.CS2 < 1) miss.add('CS2');
      } else if (c.CS1 + c.CS2 < 1) {
        miss.add('CS');
      }
      if (PED_DAYS.has(cd.weekday)) {
        if (c.Ped < 1) miss.add('Ped');
      } else if (c.Ped > 0) {
        miss.add('Ped');
        pedForbiddenReason.add('Ped un mardi (interdit)');
      }
      if (c.BM + c.Ped < 2) miss.add('2 blocs (BM/Ped)');
    }

    flagged[day] = miss;
    const reasonParts = [...miss];
    if (pedForbiddenReason.size > 0) {
      reasonParts.push(...pedForbiddenReason);
    }
    reason[day] = reasonParts.length
      ? `${reasonParts.join(', ')} (${work} travaillants)`
      : '';
  }

  return { posts: POST_ROWS, days, counts, working, flagged, reason };
}

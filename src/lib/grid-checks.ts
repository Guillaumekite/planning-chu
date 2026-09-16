// Vérifications de la grille éditée par l'admin + recalcul d'équité des gardes.
// Tout est pur (grille + jours + profils en entrée) : utilisable en direct côté client
// pendant l'édition, sans re-solliciter le moteur.
import { computePostCounter, type CounterDay } from './garde-counter';

export type Grid = Record<string, Record<number, string>>;
export type DoctorRules = { forceG2?: boolean; noS?: boolean; noHC?: boolean };

// Même forme que EquityReport du moteur (src/engine/types.ts), clés = noms de médecins.
export type GridEquity = {
  count: Record<string, number>;
  weekendCount: Record<string, number>;
  heavyCount: Record<string, number>;
  cumulativeCount: Record<string, number>;
  cumulativeHeavy: Record<string, number>;
  cumulativeWeekend: Record<string, number>;
  spread: number;
};

/** Rôle de garde d'une case : 'G1'/'G2' pure ou combinée jour+soir ('U+G1', 'ACU+G2'). */
export function gardeRole(raw: string | undefined): 'G1' | 'G2' | null {
  if (!raw) return null;
  const [main, evening] = raw.split('+');
  const role = evening ?? main;
  return role === 'G1' || role === 'G2' ? role : null;
}

function mainPost(raw: string | undefined): string {
  return raw ? raw.split('+')[0] : '';
}

// Après une garde de nuit, seuls repos/absences sont acceptables le lendemain.
const REST_AFTER_GARDE = new Set(['', 'RS', 'CA', 'ABS']);

/**
 * Avertissements NON bloquants sur une grille (éditée) :
 *  - composition de chaque jour (G1/G2 uniques, S/CS/Ped/blocs — via computePostCounter,
 *    même contrôle que la ligne « Contrôle » du compteur des postes) ;
 *  - règles de profil (« Jamais G1 », « Pas de S », « Jamais HC ») ;
 *  - repos : gardes deux jours de suite, jour travaillé juste après une garde.
 */
export function checkGrid(
  days: CounterDay[],
  grid: Grid,
  rules: Record<string, DoctorRules> = {},
): string[] {
  const warnings: string[] = [];

  // Composition des jours — réutilise le self-check du compteur des postes.
  const pc = computePostCounter(grid, days);
  for (const cd of days) {
    if (pc.flagged[cd.day].size > 0) warnings.push(`Jour ${cd.day} : ${pc.reason[cd.day]}`);
  }

  const byDay = new Map(days.map((cd) => [cd.day, cd]));
  for (const [doc, cells] of Object.entries(grid)) {
    const r = rules[doc] ?? {};
    for (const cd of days) {
      const raw = cells[cd.day];
      const role = gardeRole(raw);
      const main = mainPost(raw);

      if (r.forceG2 && role === 'G1') {
        warnings.push(`G1 attribué à ${doc} le ${cd.day} malgré « Jamais G1 ».`);
      }
      if (r.noS && main === 'S') {
        warnings.push(`S attribué à ${doc} le ${cd.day} malgré « Pas de S ».`);
      }
      if (r.noHC && main === 'HC') {
        warnings.push(`HC attribué à ${doc} le ${cd.day} malgré « Jamais HC ».`);
      }

      // Repos autour des gardes : regarde le lendemain (s'il est dans le mois).
      if (role && byDay.has(cd.day + 1)) {
        const nextRaw = cells[cd.day + 1];
        if (gardeRole(nextRaw)) {
          warnings.push(`${doc} a deux gardes deux jours de suite (${cd.day} et ${cd.day + 1}).`);
        } else if (!REST_AFTER_GARDE.has(mainPost(nextRaw))) {
          warnings.push(
            `${doc} travaille le ${cd.day + 1} juste après sa garde du ${cd.day} (pas de repos de sécurité).`,
          );
        }
      }
    }
  }

  return warnings;
}

/**
 * Recalcule l'équité des gardes depuis la grille éditée. Les compteurs du mois sont
 * recomptés ; le report des mois précédents est préservé par delta sur la base :
 * report = cumul(base) − compte(base), puis cumul' = report + compte recompté.
 * Mêmes conventions que le moteur : week-end de garde = ven→dim, pénible = jeu→dim.
 */
export function recomputeEquity(days: CounterDay[], grid: Grid, base: GridEquity | null): GridEquity {
  const count: Record<string, number> = {};
  const weekendCount: Record<string, number> = {};
  const heavyCount: Record<string, number> = {};
  const cumulativeCount: Record<string, number> = {};
  const cumulativeHeavy: Record<string, number> = {};
  const cumulativeWeekend: Record<string, number> = {};

  for (const [doc, cells] of Object.entries(grid)) {
    count[doc] = 0; weekendCount[doc] = 0; heavyCount[doc] = 0;
    for (const cd of days) {
      if (!gardeRole(cells[cd.day])) continue;
      count[doc] += 1;
      if (cd.weekday >= 4) weekendCount[doc] += 1; // ven/sam/dim
      if (cd.weekday >= 3) heavyCount[doc] += 1;   // jeu→dim
    }
    // Report = cumul(base) − compte(base). Base historique sans cumulés → report nul.
    const carry = (cum: Record<string, number> | undefined, m: Record<string, number> | undefined) =>
      cum ? (cum[doc] ?? 0) - (m?.[doc] ?? 0) : 0;
    cumulativeCount[doc] = carry(base?.cumulativeCount, base?.count) + count[doc];
    cumulativeHeavy[doc] = carry(base?.cumulativeHeavy, base?.heavyCount) + heavyCount[doc];
    cumulativeWeekend[doc] = carry(base?.cumulativeWeekend, base?.weekendCount) + weekendCount[doc];
  }

  const cums = Object.values(cumulativeCount);
  return {
    count, weekendCount, heavyCount,
    cumulativeCount, cumulativeHeavy, cumulativeWeekend,
    spread: cums.length ? Math.max(...cums) - Math.min(...cums) : 0,
  };
}

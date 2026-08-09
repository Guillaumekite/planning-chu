// Report des RS au 1er du mois : logique PURE (aucun accès base) déterminant, à partir de la
// grille du mois publié précédent, quels médecins étaient de garde son dernier jour — donc doivent
// recevoir un RS le 1er du mois généré (et être bloqués de garde le 1 et le 2). La route
// `api/generate` fournit la grille ; ce module décide le seuil de date et la contiguïté.
import { daysInMonth } from '../engine/calendar';

/** Le report des RS inter-mois ne s'applique qu'à partir de ce mois (« à partir de juillet 2026 »). */
export const RS_CARRYIN_FROM = { year: 2026, month: 7 };

/** Cases d'une grille publiée qui signifient « ce médecin est de garde ce jour-là » (garde simple
 * ou combinée avec l'université / l'acupuncture). */
const GARDE_CELLS = new Set(['G1', 'G2', 'U+G1', 'U+G2', 'ACU+G2']);

/** Médecins porteurs d'une garde (G1/G2, y compris U+/ACU+) le jour `day` dans une grille publiée. */
export function gardeHoldersOnDay(
  grid: Record<string, Record<number, string>>,
  day: number,
): string[] {
  return Object.keys(grid).filter((doc) => GARDE_CELLS.has(grid[doc]?.[day]));
}

/**
 * Médecins dont la garde du dernier jour du mois précédent doit reporter un RS sur le 1er de
 * (year, month). Renvoie [] sauf si (year, month) ≥ juillet 2026 ET `prev` est EXACTEMENT le mois
 * calendaire juste précédent (publié). Le résultat est filtré au roster du mois généré.
 */
export function carryGardeLastDay(
  year: number,
  month: number,
  prev: { year: number; month: number; grid: Record<string, Record<number, string>> } | null,
  roster: string[],
): string[] {
  const atOrAfter =
    year > RS_CARRYIN_FROM.year || (year === RS_CARRYIN_FROM.year && month >= RS_CARRYIN_FROM.month);
  if (!atOrAfter || !prev) return [];
  const prevCal = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  if (prev.year !== prevCal.year || prev.month !== prevCal.month) return [];
  const rosterSet = new Set(roster);
  return gardeHoldersOnDay(prev.grid, daysInMonth(prev.year, prev.month)).filter((d) => rosterSet.has(d));
}

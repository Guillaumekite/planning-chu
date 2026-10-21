// Solde de gardes (équité V2, spec 2026-10-21) : fonctions PURES calculées depuis les
// grilles PUBLIÉES — les modifications manuelles comptent donc automatiquement.
// solde(médecin) = Σ sur les mois publiés depuis ANCHOR : gardes faites − gardes dues.
// Négatif = en retard (prioritaire pour la cible haute), positif = en avance.
// Jamais stocké : recalculé à chaque usage. Utilisable côté client (édition en direct).
import { gardeRole, type Grid } from './grid-checks';

/** Point de départ du compteur (décision du 21/10/2026) : juillet/août 2026, trop
 * retouchés à la main (jours troués, médecins au-delà du plafond), sont exclus. */
export const ANCHOR = { year: 2026, month: 9 } as const;

/** Gardes faites par médecin dans une grille (G1/G2 purs ou combinés U+G1, ACU+G2…). */
export function gardeCounts(grid: Grid): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [doc, cells] of Object.entries(grid)) {
    out[doc] = Object.values(cells).filter((raw) => gardeRole(raw) !== null).length;
  }
  return out;
}

/** Présence = cases non vides hors CA et ABS. Diffère volontairement de
 * `workedDaysFromGrid` (ancien chemin, ABS compté) — ne pas fusionner. */
export function presenceDays(grid: Grid): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [doc, cells] of Object.entries(grid)) {
    out[doc] = Object.values(cells).filter((raw) => {
      const main = raw ? raw.split('+')[0] : '';
      return main !== '' && main !== 'CA' && main !== 'ABS';
    }).length;
  }
  return out;
}

/**
 * Gardes dues par médecin pour un mois publié : le POT RÉEL de la grille (gère les jours
 * troués) réparti au prorata de `présence × fraction gardable`. `noGardeFraction` =
 * (jours du mois − jours G−) / jours du mois — miroir du poids de la génération : un
 * médecin qui refuse les gardes (G−) ne « doit » pas de gardes. Absent → fraction 1.
 */
export function monthDues(grid: Grid, noGardeFraction?: Record<string, number>): Record<string, number> {
  const presence = presenceDays(grid);
  const pot = Object.values(gardeCounts(grid)).reduce((s, v) => s + v, 0);
  const weight: Record<string, number> = {};
  let W = 0;
  for (const doc of Object.keys(grid)) {
    weight[doc] = presence[doc] * (noGardeFraction?.[doc] ?? 1);
    W += weight[doc];
  }
  const out: Record<string, number> = {};
  for (const doc of Object.keys(grid)) out[doc] = W > 0 ? (pot * weight[doc]) / W : 0;
  return out;
}

/** Solde cumulé sur une liste de mois publiés (ordre indifférent) : Σ faites − dues.
 * Un médecin absent d'une grille n'y contribue pas (nouveau/parti = neutre). */
export function soldeFromMonths(
  months: { grid: Grid; noGardeFraction?: Record<string, number> }[],
): Record<string, number> {
  const solde: Record<string, number> = {};
  for (const { grid, noGardeFraction } of months) {
    const done = gardeCounts(grid);
    const dues = monthDues(grid, noGardeFraction);
    for (const doc of Object.keys(grid)) {
      solde[doc] = (solde[doc] ?? 0) + (done[doc] ?? 0) - (dues[doc] ?? 0);
    }
  }
  return solde;
}

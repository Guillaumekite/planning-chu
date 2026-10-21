// Calcul serveur du solde de gardes (équité V2) : grilles publiées depuis l'ancrage +
// historique des dispos (jours G− → fraction gardable). Côté client, seules les fonctions
// pures de ./solde sont utilisées (édition en direct) — ce fichier touche la base.
import { ANCHOR, soldeFromMonths } from './solde';
import { listPublishedBetween } from './plannings';
import { getAvailability } from './availability';

/** Fraction gardable par médecin pour un mois : (jours du mois − jours G−) / jours du mois.
 * Dispos absentes pour ce mois → fraction 1 (rétro-compat). */
export async function noGardeFractionFor(
  year: number,
  month: number,
  daysInMonth: number,
): Promise<Record<string, number>> {
  const { availability } = await getAvailability(year, month);
  const out: Record<string, number> = {};
  for (const [doc, perDay] of Object.entries(availability)) {
    const noGarde = Object.values(perDay).filter((s) => s === 'no_garde').length;
    out[doc] = (daysInMonth - noGarde) / daysInMonth;
  }
  return out;
}

/** Solde d'entrée du mois (year, month) : Σ (faites − dues) sur les mois publiés
 * ANCHOR ≤ m < (year, month). Vide si rien de publié depuis l'ancrage. */
export async function soldeBefore(year: number, month: number): Promise<Record<string, number>> {
  const months = await listPublishedBetween(ANCHOR, { year, month });
  const entries = [];
  for (const m of months) {
    entries.push({
      grid: m.grid,
      noGardeFraction: await noGardeFractionFor(m.year, m.month, m.days.length),
    });
  }
  return soldeFromMonths(entries);
}

// Jours travaillés par médecin dans une grille publiée — nourrit le carry en RATIO
// gardes/jours travaillés (spec §1.3) : un médecin peu présent le mois dernier a
// légitimement moins de gardes, il ne doit pas être « rattrapé » à tort ce mois-ci.

/** Toute cellule non vide autre que CA compte travaillée (G1, G2, RS, U, ACU, postes, HC…) ;
 * les blancs (week-ends off, jours off TP, récup) et les congés ne comptent pas. */
export function workedDaysFromGrid(grid: Record<string, Record<number, string>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [doc, cells] of Object.entries(grid)) {
    out[doc] = Object.values(cells).filter((v) => v && v !== 'CA').length;
  }
  return out;
}

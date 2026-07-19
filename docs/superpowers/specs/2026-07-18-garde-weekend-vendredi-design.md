# Vendredi compté comme jour de week-end dans l'équité des gardes

## Contexte / problème

L'algorithme d'attribution des gardes (`src/engine/gardes.ts`) équilibre déjà plusieurs axes
d'équité entre médecins : nombre total de gardes, jours "pénibles" (jeudi→dimanche), jours de
week-end (samedi/dimanche), et espacement des gardes dans le mois.

Le vendredi est aujourd'hui compté comme un jour "pénible" (`isHeavy`, jeudi→dimanche) mais
**pas** comme un jour de "week-end" (`isWeekend` ne vaut `true` que pour samedi/dimanche). Résultat :
un médecin qui a une garde vendredi + samedi + dimanche a en réalité 3 gardes rapprochées de
fin de semaine, mais l'algo ne le voit que comme "2 gardes de week-end", ce qui sous-estime sa
charge réelle par rapport à un médecin qui a une garde le dimanche et deux gardes en semaine.

## Objectif

Faire compter le vendredi comme un jour de week-end pour l'équité des gardes, afin que la
répartition vendredi/samedi/dimanche soit mieux équilibrée entre médecins, **sans** changer :
- la règle dure "exactement 2 médecins par jour (G1 + G2)"
- la règle dure d'espacement (minimum 3 jours calendaires entre 2 gardes d'un même médecin, soit
  2 jours de repos)
- la définition de jour "pénible" (`isHeavy`, jeudi→dimanche)

## Contrainte d'architecture

Le champ `CalendarDay.isWeekend` (samedi/dimanche) est **partagé** en dehors du moteur de
gardes :
- `src/engine/planning.ts` s'en sert pour exclure les jours de week-end du planning de
  consultation normal (aucune consultation le week-end).
- L'UI (`DispoClient.tsx`, `PlanningGrid.tsx`, `AdminClient.tsx`, l'export Excel) s'en sert pour
  griser visuellement les colonnes de week-end.

Redéfinir `isWeekend` globalement pour inclure le vendredi grillerait ces usages : le vendredi
deviendrait à tort un jour "sans consultation" et grisé partout dans l'app.

**Décision** : la règle "vendredi = week-end" est ajoutée **seulement à l'intérieur du moteur de
gardes** (`gardes.ts`), sans toucher au champ partagé `isWeekend`. Même principe que `isHeavy`,
qui est déjà une fonction privée locale à `gardes.ts` plutôt qu'un champ du calendrier partagé.

## Changements

1. **Nouvelle fonction privée** dans `gardes.ts`, à côté de `isHeavy` :
   ```ts
   /** Un jour de "week-end de garde" : vendredi, samedi ou dimanche (weekday 4..6). */
   function isGardeWeekend(cd: CalendarDay): boolean {
     return cd.weekday >= 4;
   }
   ```

2. **Remplacer les 4 usages de `cd.isWeekend` dans `gardes.ts`** par `isGardeWeekend(cd)` :
   - le calcul de `weekendCount` (rapport d'équité affiché aux utilisateurs)
   - la contrainte MILP dure "≥ 1 garde de week-end par mois par médecin" (`wedefVars`)
   - le cumul `cumWe` dans `polishEquity` (équité cumulée mois après mois)
   - le terme d'objectif `W_WE` dans `polishEquity` (recherche locale qui rééquilibre les gardes)

3. **Aligner le poids de pénibilité du vendredi** dans `DEFAULT_WEIGHTS.perWeekday`
   (`src/engine/types.ts`) : `[1, 1, 1, 2, 2, 3, 3]` → `[1, 1, 1, 2, 3, 3, 3]` (vendredi passe de
   2 à 3, comme samedi/dimanche).
   - Note : ce poids n'alimente aujourd'hui que le champ `CalendarDay.penibility`, qui n'est lu
     par aucun calcul du solveur ni de l'UI (seulement par un test unitaire de `calendar.ts`).
     Ce changement est donc cohérent avec la demande mais n'a, en l'état, aucun effet sur le
     comportement de l'algo — le vrai changement de comportement vient du point 2
     (`isGardeWeekend`).

4. **Mettre à jour les commentaires** de `EquityReport.weekendCount` / `cumulativeWeekend` dans
   `types.ts` pour préciser "vendredi→dimanche" (au lieu de "samedi/dimanche"), pour éviter toute
   confusion avec `CalendarDay.isWeekend` qui continue lui de désigner samedi/dimanche uniquement.

## Inchangé

- `isHeavy` (jeudi→dimanche, pénibilité) — logique et poids `W_HEAVY` inchangés.
- La règle d'espacement (minimum 3 jours calendaires / 2 jours de repos entre 2 gardes d'un même
  médecin).
- La règle "exactement 2 médecins par jour".
- `CalendarDay.isWeekend` (samedi/dimanche uniquement) et tous ses consommateurs hors gardes
  (`planning.ts`, UI, exports).

## Migration de données

Aucune. En production, `carryCount` / `carryHeavy` / `carryWeekend` ne sont pas persistés ni
rechargés d'un mois sur l'autre (`planning.ts` ne les renseigne pas dans `gardeInput` — seuls
`demo.ts` et les tests le font). Il n'y a donc pas d'historique à corriger.

## Tests

- Ajouter un test dans `gardes.test.ts`, sur le modèle de "rotates weekend/heavy gardes fairly",
  vérifiant que l'écart max-min du nouveau `weekendCount` (vendredi+samedi+dimanche) reste faible
  entre médecins sur un mois complet.
- Les tests existants (`calendar.test.ts`, invariants durs de `gardes.test.ts`) ne doivent pas
  changer de comportement : `isWeekend` reste samedi/dimanche, l'espacement 3 jours et les 2
  médecins/jour restent vérifiés à l'identique.

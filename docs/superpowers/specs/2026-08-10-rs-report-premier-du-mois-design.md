# Report des RS au 1er du mois (garde du dernier jour du mois précédent)

## Contexte / problème

Un **RS** (repos de sécurité) est obligatoire le lendemain de chaque garde
(`RS = repos de sécurité (lendemain de garde)`). Dans `src/engine/planning.ts`, le RS est
calculé par :

```ts
const isRS = (doc, day) =>
  PRESENT(avail(input, doc, day)) && !isGarde(doc, day) &&
  (gardeByDay[day - 1]?.G1 === doc || gardeByDay[day - 1]?.G2 === doc);
```

`gardeByDay` ne contient que les gardes **du mois en cours**. Le 1er du mois, `day - 1 === 0`
n'existe pas dans `gardeByDay` : le RS issu d'une garde tenue le **dernier jour du mois
précédent** est donc silencieusement perdu. Le code le signale déjà lui-même (self-check
`planning.ts`, banderole ambre) : *« Contrôle du 1 : … surplus inattendu (1er du mois sans RS ?) »*.

Deux conséquences le 1er du mois, pour un médecin qui était de garde le dernier jour du mois
précédent :
1. **Affichage** — son RS n'apparaît pas (case vide au lieu de `RS`), et le décompte des
   « travaillants » du jour est faussé (surplus → HC inattendu).
2. **Cohérence de la règle de repos** — le solveur de gardes du nouveau mois ignore la garde du
   mois précédent : il pourrait lui réattribuer une garde le 1er ou le 2, ce qui violerait la
   règle des 3 jours calendaires entre 2 gardes (garde le dernier jour → 1er = RS → 2 encore
   interdit → 1re garde possible le 3).

## Objectif

À partir de **juillet 2026**, lors de la génération d'un nouveau mois, attribuer le **1er** du
mois les RS correspondant aux gardes (G1 **et** G2) du **dernier jour calendaire du mois
précédent** déjà publié — et empêcher ces médecins de reprendre une garde trop tôt (1er et 2).

## Décisions (validées)

- **Seuil de date** : le report ne s'applique que pour les mois générés **≥ juillet 2026**. Les
  mois plus anciens (historiques/démo) restent intacts. Constante dédiée
  `RS_CARRYIN_FROM = { year: 2026, month: 7 }`.
- **Contiguïté obligatoire** : le report n'a lieu que si le mois publié précédent est
  *exactement* le mois calendaire juste avant celui généré. En cas de trou de publication (ex.
  générer septembre alors que seul juillet est publié), **pas** de report — une garde de juillet
  ne produit aucun RS le 1er septembre.
- **Périmètre** : les **deux** gardes (G1 + G2) du dernier jour calendaire du mois précédent,
  chacune donnant un RS le 1er.
- **Blocage garde inter-mois** : ces médecins sont bloqués de garde le **1er et le 2** du nouveau
  mois, exactement comme le blocage existant « veille de jour Univ » — c.-à-d. ajout **à la fois**
  à `gardeBlocked` (contrainte dure du solveur) **et** à `nonTpBlocked` (poids d'équité
  `gardeWeight`, qui réduit légèrement leur cible de gardes du mois).

## Contrainte d'architecture

Le moteur (`src/engine/*.ts`) est **pur et déterministe** : pas de `Date.now()`, pas d'accès
base de données, tout fait temporel est passé en entrée. Le moteur ne va donc **pas** chercher le
mois précédent lui-même : il reçoit une liste de médecins déjà calculée par la route (comme
`carryCount` / `carryHeavy` / `carryWeekend` le sont déjà aujourd'hui via
`getLatestPublishedBefore` dans `src/app/api/generate/route.ts`).

Le seuil de date (« à partir de juillet 2026 ») et la contiguïté sont donc décidés **dans la
route** ; le moteur applique simplement la liste qu'on lui donne.

## Changements

### 1. `src/engine/planning.ts` — `PlanningInput` (nouveau champ)

```ts
/** Médecins de garde le dernier jour du mois calendaire juste précédent (déjà publié).
 *  Reçoivent un RS le 1er du mois, et sont bloqués de garde le 1 et le 2 (règle de repos
 *  inter-mois). Renseigné par la route uniquement à partir de juillet 2026 et si le mois
 *  précédent est contigu et publié. */
carryGardeLastDay?: DoctorId[];
```

### 2. `src/engine/planning.ts` — `solvePlanning` (deux effets)

- En tête de fonction :
  ```ts
  const carriedRS = new Set((input.carryGardeLastDay ?? []).filter((d) => doctors.includes(d)));
  ```
  (le filtre écarte un médecin porté qui ne serait plus au roster ce mois-ci).

- **Blocage garde + équité** — dans la boucle qui construit `gardeBlocked` **et** le bloc
  `gardeWeight` / `nonTpBlocked`, ajouter les jours **1 et 2** pour chaque médecin de `carriedRS`,
  sur le même modèle que le blocage `univDays[doc]` de la veille :
  - `gardeBlocked[doc]` reçoit `1` et `2` (jours ≥ 1 uniquement, donc toujours valides).
  - `nonTpBlocked` (calcul de `gardeWeight`) reçoit `1` et `2` de la même façon.

- **Affichage RS** — étendre `isRS` :
  ```ts
  const isRS = (doc, day) =>
    PRESENT(avail(input, doc, day)) && !isGarde(doc, day) && (
      (gardeByDay[day - 1]?.G1 === doc || gardeByDay[day - 1]?.G2 === doc) ||
      (day === 1 && carriedRS.has(doc))
    );
  ```
  Les gardes existants sont conservés : congé l'emporte (via `PRESENT`), et une case garde
  l'emporte sur RS (via `!isGarde` — de toute façon la garde du 1er est désormais bloquée).

### 3. `src/app/api/generate/route.ts` — extraction + seuil

- Nouvelle constante en tête de module :
  ```ts
  const RS_CARRYIN_FROM = { year: 2026, month: 7 }; // « à partir de juillet 2026 »
  ```
- Petit helper **pur** (exporté pour test), extrayant les porteurs de garde d'un jour dans une
  grille publiée :
  ```ts
  const GARDE_CELLS = new Set(['G1', 'G2', 'U+G1', 'U+G2', 'ACU+G2']);
  export function gardeHoldersOnDay(
    grid: Record<string, Record<number, string>>,
    day: number,
  ): string[] {
    return Object.keys(grid).filter((doc) => GARDE_CELLS.has(grid[doc]?.[day]));
  }
  ```
- Dans `POST`, après avoir obtenu `prev = getLatestPublishedBefore(input.year, input.month)` :
  - calculer le mois calendaire juste avant (`month === 1` → `{ year: year - 1, month: 12 }`) ;
  - `atOrAfter` = `input.year > 2026 || (input.year === 2026 && input.month >= 7)` ;
  - `contigu` = `prev && prev.year === prevCal.year && prev.month === prevCal.month` ;
  - si `atOrAfter && contigu` : `carryGardeLastDay =
    gardeHoldersOnDay(prev.grid, daysInMonth(prev.year, prev.month))
      .filter((d) => input.doctors.includes(d))` ;
  - passer `carryGardeLastDay` à `solvePlanning`.
- Importer `daysInMonth` depuis `@/engine/calendar`.

## Cas limites gérés

- **Mois précédent non contigu** (trou de publication) → pas de report.
- **Mois généré < juillet 2026** → pas de report (les tests existants qui supposent « le 1er n'a
  pas de RS » appellent `solvePlanning` sans `carryGardeLastDay` et restent valides).
- **Médecin porté en congé le 1er** → pas de RS (congé gagne via `PRESENT`), mais toujours bloqué
  de garde le 1/2 (correct : le repos est dû quelle que soit la dispo).
- **Médecin plus au roster ce mois-ci** → filtré (dans la route via `input.doctors`, et à nouveau
  dans le moteur via `doctors.includes`).
- **Vœu G+ le 1/2 d'un médecin porté** → ignoré avec l'avertissement « G+ ignoré : jour
  indisponible » existant (le repos gagne — comportement déjà en place pour tout jour bloqué).
- **Janvier** → le mois calendaire précédent est décembre de l'année précédente (géré par le
  wrap `month === 1`).

## Inchangé

- Règle « exactement 2 médecins/jour (G1 + G2) ».
- Règle d'espacement 3 jours **à l'intérieur** d'un mois (inchangée ; on ne fait qu'ajouter la
  continuité au 1er via le blocage 1/2).
- Calcul des RS pour tous les autres jours (lendemain de garde intra-mois).
- Mécanisme `carryCount` / `carryHeavy` / `carryWeekend` (équité cumulée des gardes) — le report
  des RS n'y touche pas : la garde reportée a déjà été comptée dans l'équité du mois précédent, le
  RS n'est pas une garde et n'ajoute aucun compteur.
- Aucun changement côté client (`AdminClient.tsx`, etc.) : la route lit déjà le mois précédent.

## Migration de données

Aucune. On lit les plannings publiés existants tels quels ; on n'écrit rien de nouveau en base.

## Tests

`src/engine/planning.test.ts` (moteur, pur — n'a pas besoin de base) :
- `carryGardeLastDay: ['D01', 'D02']` un mois ordinaire → `grid.D01[1] === 'RS'`,
  `grid.D02[1] === 'RS'`, et aucun des deux n'a `G1`/`G2` le 1 **ni** le 2.
- Médecin porté **+ congé le 1er** → `grid[.][1] === 'CA'` (pas `'RS'`), et toujours bloqué garde
  le 1/2.
- Médecin listé dans `carryGardeLastDay` mais **absent de `doctors`** → aucun plantage, aucun
  effet.

`src/app/api/generate/*` (helper pur) :
- Test unitaire de `gardeHoldersOnDay` : reconnaît `G1`, `G2`, `U+G1`, `U+G2`, `ACU+G2` ; ignore
  `RS`, `CA`, `S`, `''`, cases absentes.

Les tests existants restent verts : ils n'utilisent pas `carryGardeLastDay`, donc `day === 1`
n'obtient un RS que dans les nouveaux tests.

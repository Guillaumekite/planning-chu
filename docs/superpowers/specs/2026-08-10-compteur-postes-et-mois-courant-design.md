# Design — Mois courant par défaut + tableau compteur des postes

Date : 2026-08-10
Page concernée : `Admin — Planning des gardes` (`/admin`)

## Contexte

Deux évolutions sur la page admin du planning des gardes :

1. **Mois par défaut.** La page démarre en dur sur avril 2026. Elle doit s'ouvrir sur
   le mois courant. (La page publique `/planning` est déjà centrée sur le mois courant ;
   seule la page admin est concernée.)
2. **Tableau compteur des postes.** Ajouter un tableau qui vérifie que chaque jour
   comporte le bon nombre de médecins par poste, affiché sous le planning (à l'écran et
   dans l'export Excel/CSV), le tableau d'équité des gardes passant alors sous ce nouveau
   tableau.

## Modification 1 — Mois courant

Dans `src/app/admin/AdminClient.tsx`, remplacer :

```js
const [year, setYear]   = useState(2026);
const [month, setMonth] = useState(4);
```

par :

```js
const now = new Date();
const [year, setYear]   = useState(now.getFullYear());
const [month, setMonth] = useState(now.getMonth() + 1);
```

Le reste (navigation par flèches, chargement du roster/planning) est inchangé.

## Modification 2 — Tableau compteur des postes

### Forme retenue

Matrice **postes × jours** (option A) :

- Lignes = postes, dans l'ordre :
  `G1, G2, RS, S, CS1, CS2, BM, Ped, MM, MS, ACU, U, P, HC`.
- Colonnes = jours du mois (mêmes colonnes que le planning → alignement vertical).
- Chaque case = nombre de médecins affectés à ce poste ce jour-là.
- Deux lignes de synthèse en bas :
  - **Travaillants** — nombre de médecins travaillants ce jour.
  - **Contrôle** — `✓` si tous les postes de base sont couverts, sinon `✗` **avec le
    motif** (liste des postes de base manquants + nombre de travaillants comptés).
- Colonnes week-end / férié grisées, comme le planning.

### Module de calcul partagé — `src/lib/garde-counter.ts`

TypeScript pur (importable par la page client ET la route d'export serveur). Calcule
tout à partir de `grid` + `days` uniquement, afin d'être identique en brouillon, en
publié et dans l'export.

Décomposition des cellules composées (`raw.split('+')` → `[main, evening]`, comme
`planning-cell.ts`) :

- `main` (poste de jour) est compté pour son poste (`ACU`, `U`, `MM`, `RS`, `HC`, `S`,
  `CS1`, `CS2`, `BM`, `Ped`, `P`, ou `G1`/`G2` si garde pure).
- `evening` (garde du soir) est compté pour `G1`/`G2`.
- Ainsi `ACU+G2` → 1 `ACU` + 1 `G2` ; `U+G1` → 1 `U` + 1 `G1`.

Comptes G1/G2 par jour = cellules dont `main` **ou** `evening` vaut `G1`/`G2`.

**Nombre de travaillants** par jour, recalculé depuis la grille (aligné sur `isWorking`
du moteur) : médecins dont le poste de jour (`main`) n'est ni vide, ni `CA`, ni `ABS`,
ni `U*` (`U`, `U+G1`, `U+G2`). Les `RS` comptent comme travaillants.

**Signalements rouges** — reproduit exactement la vérif du moteur
(`src/engine/planning.ts`, bloc « Self-check »), appliquée uniquement les jours
travaillés (`working >= 8`) et hors week-end/férié :

- `S` : `< 1` → manquant.
- `CS1`/`CS2` : si `working >= 9`, chacun `< 1` → manquant ; sinon (`working == 8`),
  `CS1 + CS2 < 1` → `CS` manquant.
- `Ped` : les lun/mer/jeu/ven (`weekday ∈ {0,2,3,4}`), `< 1` → manquant ; le mardi,
  `> 0` → « Ped un mardi (interdit) ».
- `BM + Ped < 2` → « 2 blocs (BM/Ped) » manquant.

En plus, **tous les jours** (week-ends/fériés inclus) : `G1 != 1` et `G2 != 1` →
signalé.

Sortie du module (forme indicative) :

```ts
type PostCounter = {
  posts: string[];                              // lignes, dans l'ordre
  days: { day; weekday; isWeekend; isHoliday }[];
  counts: Record<number, Record<string, number>>; // counts[day][post]
  working: Record<number, number>;              // working[day]
  flagged: Record<number, Set<string>>;         // flagged[day] = postes en défaut
  reason: Record<number, string>;               // reason[day] = motif du ✗ (vide si ✓)
};
```

Le motif (`reason[day]`) est une chaîne structurelle recalculée, ex.
« S manquant, CS1 manquant (9 travaillants) ». Sur le brouillon, les avertissements
ambre détaillés du moteur (ex. « S non couvert : tous les restants ont "Pas de S" »)
restent affichés en plus, inchangés.

### Affichage sur la page — `src/components/PostCounterTable.tsx`

Nouveau composant client rendant la matrice ci-dessus. Cases en défaut surlignées en
rouge ; ligne **Contrôle** affichant `✓`/`✗` + motif au survol/à côté.

Insertion dans `AdminClient.tsx`, **sous** `PlanningGrid` et **au-dessus** de
`EquityTable` :

- Brouillon fraîchement généré (`draft`) : sous la grille du brouillon.
- Planning publié (`publishedPlanning`) : sous la grille publiée.
- Aperçu vide (aucun planning) : **non affiché** (tout serait à zéro / rouge).

### Export — `src/app/api/plannings/export/route.ts`

Ordre vertical dans l'export : **planning → compteur → équité**, empilés.

- **Excel** : passage d'une feuille « Équité » séparée à **une seule feuille empilée** :
  grille du planning, 1 ligne vide, matrice compteur (mêmes colonnes-jours → alignée),
  ligne **Travaillants**, ligne **Contrôle** (`✓`/`✗`), puis — pour chaque jour signalé —
  une ligne **Motif** « Jour X : … », 1 ligne vide, tableau d'équité. Cases en défaut
  remplies en rouge.
- **CSV** (pas de couleur) : même empilement dans le fichier unique. Les cases en défaut
  sont marquées d'un `!` (ex. `0!`) ; lignes **Travaillants** et **Contrôle** (`✓`/`✗`),
  puis les lignes **Motif** « Jour X : … » pour chaque jour signalé.

Le compteur et l'équité sont tous deux calculés depuis `planning.grid` / `planning.days`
via le module partagé (aucune donnée supplémentaire à persister).

## Fichiers touchés

- `src/app/admin/AdminClient.tsx` — mois courant + insertion du `PostCounterTable`.
- `src/lib/garde-counter.ts` — **nouveau** — calcul comptes / travaillants / motifs.
- `src/components/PostCounterTable.tsx` — **nouveau** — rendu à l'écran.
- `src/app/api/plannings/export/route.ts` — compteur empilé + équité sous le compteur,
  Excel en une seule feuille.

## Tests

- `garde-counter` (test unitaire) : décomposition des cellules composées
  (`ACU+G2`, `U+G1`), comptes par poste, nombre de travaillants, signalements
  (S/CS/Ped/blocs/G1/G2) et motifs sur des grilles construites à la main, y compris un
  jour week-end (seuls G1/G2/RS comptés) et un mardi (Ped interdit).
- Cohérence avec le moteur : sur un planning généré par `src/engine/planning.ts`, les
  jours signalés par le compteur correspondent aux avertissements « Contrôle du X »
  produits par le moteur.

## Hors périmètre

- Aucune modification du moteur d'affectation (`src/engine/planning.ts`,
  `src/engine/gardes.ts`) : le compteur ne fait que lire/vérifier la grille.
- Aucune persistance supplémentaire (les motifs sont recalculés à la lecture).

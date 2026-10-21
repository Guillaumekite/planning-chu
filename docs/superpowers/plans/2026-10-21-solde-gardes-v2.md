# Équité gardes V2 (solde) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le rattrapage « mois précédent ±1 » par un solde cumulé ancré septembre 2026 avec cibles mensuelles entières (écart ≤ 1), derrière un interrupteur `app_config`, plus garde-fou de publication et affichage admin du solde.

**Architecture:** Fonctions pures dans `src/lib/solde.ts` (calcul solde/dus depuis les grilles publiées) ; nouveau mode `equityMode: 'solde'` dans le moteur (`apportionTargets` au plus fort reste, priorité aux soldes négatifs) — le mode par défaut `'carry'` reste bit-à-bit identique ; câblage serveur dans `/api/generate` (flag `equity_v2`), routes admin `/api/config` et `/api/solde` ; garde-fou dans `POST /api/plannings` (toujours actif) ; UI dans `AdminClient.tsx`.

**Tech Stack:** Next.js 16 App Router, TypeScript, GLPK WASM (inchangé), vitest, PGlite/Neon via `src/db/client.ts`.

**Spec:** `docs/superpowers/specs/2026-10-21-solde-gardes-v2-design.md`

## Global Constraints

- Ancrage : `ANCHOR = { year: 2026, month: 9 }` (constante exportée de `src/lib/solde.ts`).
- Clé de config : `app_config.equity_v2`, `'on'`/`'off'`, **absente = on**.
- Chemin `equityMode: 'carry'` (défaut) : aucun changement de comportement — la suite de tests existante passe sans modification.
- Le garde-fou de publication n'est PAS gaté par le flag ; la colonne Solde l'est.
- Le solde n'est jamais stocké ni publié (pas dans `gardeEquity`, pas dans l'export, pas dans la vue publiée).
- Présence (solde) = cases non vides hors `CA` **et** `ABS` ; ne pas modifier `workedDaysFromGrid`.
- Poids des dus = présence × (jours − jours `no_garde`) / jours ; dispos du mois absentes → facteur 1.
- Moteur pur/déterministe : départage des unités restantes par priorité `frac − solde` décroissante, puis nom croissant ; unités réservées aux `frac > 0`.
- Conventions repo : commits sans co-auteur, `npm run build` avant push, zod sur tout nouveau champ d'API.

## Review Focus

1. Génération d'un mois ≤ ancrage en mode solde (somme vide) → cibles = parts brutes, pas de crash. → test Task 2 (`solde absent ≈ solde nul`).
2. Mois publiés POSTÉRIEURS au mois généré (publication en avance) → exclus du solde. → test Task 3 (`listPublishedBetween`).
3. Médecin du solde absent du roster courant (parti) ou médecin du roster absent du solde (nouveau) → ignoré / neutre. → tests Task 1 et Task 2.
4. Grille publiée trouée (jour sans G1/G2, août réel) → pot réduit, Σ(done−dues) ≈ 0, pas de NaN. → test Task 1.
5. Rollback : flag off → `/api/generate` ne calcule pas le solde, réponse sans champ `solde`, colonne masquée ; garde-fou toujours actif. → vérification manuelle Task 6 + build.

---

### Task 1: Fonctions pures du solde — `src/lib/solde.ts`

**Files:**
- Create: `src/lib/solde.ts`
- Test: `src/lib/solde.test.ts`

**Interfaces:**
- Consomme : `gardeRole(raw)` de `src/lib/grid-checks.ts` ; type `Grid = Record<string, Record<number, string>>`.
- Produit (consommé par Tasks 2, 4, 6) :
  - `export const ANCHOR = { year: 2026, month: 9 } as const;`
  - `export function gardeCounts(grid: Grid): Record<string, number>` — cases G1/G2 (via `gardeRole`).
  - `export function presenceDays(grid: Grid): Record<string, number>` — cases non vides ≠ CA/ABS (la partie jour d'une case combinée compte : `ACU+G2` présent, `CA` non).
  - `export function monthDues(grid: Grid, noGardeFraction?: Record<string, number>): Record<string, number>` — pot = Σ gardeCounts ; poids = présence × (fraction ?? 1) ; dus = pot × poids/Σpoids (Σpoids = 0 → tous 0).
  - `export function soldeFromMonths(months: { grid: Grid; noGardeFraction?: Record<string, number> }[]): Record<string, number>` — Σ (gardeCounts − monthDues), médecins absents d'un mois = contribution nulle.

- [ ] **Step 1: Écrire les tests** dans `src/lib/solde.test.ts` :

```ts
// grille jouet 4 jours, 3 médecins : A fait 3 gardes, B 1, C 0 (C en CA partout)
// presenceDays : CA et ABS exclus, '' exclu, 'RS'/'ACU+G2'/'G1' inclus
test('presenceDays exclut CA, ABS et cases vides', ...)
test('gardeCounts compte G1/G2 purs et combinés (U+G1, ACU+G2)', ...)
test('monthDues répartit le pot réel (grille trouée : pot = gardes présentes, pas 2×jours)', ...)
  // grille où un jour n'a qu'un G1 : pot = 3 et non 4 ; Σ dus = pot
test('monthDues : fraction no_garde nulle → aucun dû', ...)
  // noGardeFraction = { B: 0 } → dus.B = 0, le pot se répartit sur les autres
test('soldeFromMonths : Σ soldes ≈ 0 et médecin absent d\'un mois reste neutre', ...)
  // 2 mois ; médecin présent seulement au mois 2 : solde = (done2 − dues2)
```

- [ ] **Step 2: Vérifier l'échec** — `npx vitest run src/lib/solde.test.ts` → FAIL (module absent).
- [ ] **Step 3: Implémenter `src/lib/solde.ts`** (signatures ci-dessus ; `Grid` importé de `grid-checks`).
- [ ] **Step 4: Vérifier le vert** — `npx vitest run src/lib/solde.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/solde.ts src/lib/solde.test.ts && git commit -m "feat: fonctions pures du solde de gardes (ancrage sept. 2026)"`

### Task 2: Moteur — cibles entières en mode solde

**Files:**
- Modify: `src/engine/types.ts` (GardeInput), `src/engine/gardes.ts`, `src/engine/planning.ts` (passthrough)
- Test: `src/engine/gardes.test.ts` (nouveaux describe)

**Interfaces:**
- Consomme : rien de Task 1 (le moteur reste pur ; le solde arrive en paramètre).
- Produit (consommé par Task 4) :
  - `GardeInput` + `{ equityMode?: 'carry' | 'solde'; solde?: Record<DoctorId, number> }` (défaut `'carry'`).
  - `PlanningInput` (planning.ts) + mêmes champs, transmis tels quels à `gardeInput`.
  - `export function apportionTargets(doctors: DoctorId[], totalSlots: number, weight: Record<DoctorId, number>, solde: Record<DoctorId, number>): Record<DoctorId, number>` dans `gardes.ts`.

- [ ] **Step 1: Écrire les tests** (describe `solveGardes — mode solde (équité V2)`) :

```ts
test('apportionTargets : Σ cibles = places, cibles ∈ {floor, ceil} de la part', ...)
  // 18 poids égaux, 62 places → Σ=62, valeurs ∈ {3,4}
test('apportionTargets : le solde négatif prend les +1, le positif les évite', ...)
  // poids égaux, solde A:-2, B:+2 → cible A = ceil, cible B = floor
test('apportionTargets : poids nul → cible 0 ; nom inconnu au solde ignoré ; déterministe', ...)
test('mode solde : mois sans contrainte → écart mensuel ≤ 1', ...)
  // 18 médecins, solveGardes({equityMode:'solde'}), max−min count ≤ 1, Σ = 2×jours
test('mode solde : un médecin en retard (solde −2) finit au-dessus d\'un en avance (+2)', ...)
test('mode solde sans solde fourni ≡ soldes nuls (pas de crash)', ...)
```

- [ ] **Step 2: Vérifier l'échec** — `npx vitest run src/engine/gardes.test.ts -t "mode solde"` → FAIL.
- [ ] **Step 3: Implémenter** : `apportionTargets` (plus fort reste, priorité `frac − solde` desc, nom asc, unités aux `frac > 0` seulement) ; dans `solveGardes`, calcul des cibles :
  `input.equityMode === 'solde' ? apportionTargets(doctors, 2*days.length, input.fte ?? {}, input.solde ?? {}) : computeGardeTargets(…)` (ligne existante inchangée pour `'carry'`). Passthrough des 2 champs dans `planning.ts` (`PlanningInput` → `gardeInput`).
- [ ] **Step 4: Vérifier** — `npx vitest run src/engine/gardes.test.ts` complet → PASS (anciens tests inchangés).
- [ ] **Step 5: Commit** — `git commit -m "feat: mode équité V2 au moteur — cibles entières par solde (écart ≤ 1)"`

### Task 3: Accès données — plannings publiés depuis l'ancrage + flag

**Files:**
- Modify: `src/lib/plannings.ts`
- Create: `src/lib/config.ts`
- Test: `src/db/db.test.ts`

**Interfaces:**
- Produit (consommé par Task 4) :
  - `export async function listPublishedBetween(from: {year:number;month:number}, before: {year:number;month:number}): Promise<PlanningRow[]>` — publiés, `from ≤ (y,m) < before`, ordre chronologique.
  - `export async function getEquityV2(): Promise<boolean>` / `export async function setEquityV2(on: boolean): Promise<void>` (clé `equity_v2`, absente = true).

- [ ] **Step 1: Écrire les tests** (dans `src/db/db.test.ts`, PGlite) :

```ts
test('listPublishedBetween : bornes ancrage ≤ m < cible, mois postérieurs exclus', ...)
  // publier 2026-08, 09, 10, 11 ; between({2026,9},{2026,11}) → [09,10]
test('getEquityV2 : true par défaut, false après setEquityV2(false), true après (true)', ...)
```

- [ ] **Step 2: Vérifier l'échec** — `npx vitest run src/db/db.test.ts` → FAIL.
- [ ] **Step 3: Implémenter** (`WHERE status='published' AND (year,month) >= … AND < …` via comparaison year*100+month ; config : `INSERT … ON CONFLICT (key) DO UPDATE`).
- [ ] **Step 4: Vérifier** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: accès données solde — plannings publiés par plage + flag equity_v2"`

### Task 4: Câblage serveur — `/api/generate`, `/api/solde`, `/api/config`

**Files:**
- Modify: `src/app/api/generate/route.ts`
- Create: `src/app/api/solde/route.ts`, `src/app/api/config/route.ts`

**Interfaces:**
- Consomme : Task 1 (`ANCHOR`, `soldeFromMonths`), Task 2 (`equityMode`/`solde` de `solvePlanning`), Task 3 (`listPublishedBetween`, `getEquityV2`, `setEquityV2`), `getAvailability` existant.
- Produit (consommé par Task 6) :
  - Réponse `/api/generate` (cas faisable) : champ additionnel `solde?: Record<string, number>` (présent seulement si flag on).
  - `GET /api/solde?year&month` (admin) → `{ solde: Record<string,number>, noGardeFraction: Record<string,number> }` — solde d'entrée du mois demandé + fraction `(jours − G−)/jours` du mois demandé (pour l'édition en direct).
  - `GET /api/config` (admin) → `{ equityV2: boolean }` ; `PUT /api/config` body zod `{ equityV2: z.boolean() }` → `{ ok: true }`.
  - Helper partagé serveur (dans `src/app/api/solde/route.ts` ou `src/lib/solde-server.ts` au choix) : `soldeBefore(year, month)` = `listPublishedBetween(ANCHOR, {year,month})` + `getAvailability` par mois → `noGardeFraction` par mois → `soldeFromMonths`.

- [ ] **Step 1: Implémenter** (pas de test unitaire route — la logique testable est dans Tasks 1-3) :
  - `/api/generate` : `const v2 = await getEquityV2();` si v2 → `solde = await soldeBefore(year, month)` ; `solvePlanning({ …, equityMode: 'solde', solde })` ; réponse `{ …result, solde }`. Si off → appel strictement identique à aujourd'hui.
  - `/api/solde` : admin only (`getSession()` role admin, 401 sinon), zod sur year/month.
  - `/api/config` : GET/PUT admin only.
- [ ] **Step 2: Vérifier** — `npm test` (rien ne casse) + `npm run build` → OK.
- [ ] **Step 3: Commit** — `git commit -m "feat: génération en mode solde derrière le flag equity_v2 + routes /api/solde et /api/config"`

### Task 5: Garde-fou de publication (toujours actif)

**Files:**
- Modify: `src/lib/grid-checks.ts`, `src/app/api/plannings/route.ts`
- Test: `src/lib/grid-checks.test.ts`

**Interfaces:**
- Produit (consommé par Task 6) :
  - `export function missingGardeDays(days: CounterDay[], grid: Grid): number[]` — jours où G1 ≠ 1 ou G2 ≠ 1 (rôles via `gardeRole`, combinés inclus).
  - `POST /api/plannings` : body zod + `force: z.boolean().optional()` ; si `missingGardeDays` non vide et `!force` → 400 `{ error, code: 'jours-sans-garde', days: number[] }`.

- [ ] **Step 1: Écrire les tests** :

```ts
test('missingGardeDays : grille complète → []', ...)
test('missingGardeDays : jour sans G1, jour sans G2, jour à 2 G1 → listés', ...)
test('missingGardeDays : G1 combiné (U+G1) compte', ...)
```

- [ ] **Step 2: Vérifier l'échec** — `npx vitest run src/lib/grid-checks.test.ts` → FAIL.
- [ ] **Step 3: Implémenter** (lib + route ; la route garde son comportement actuel pour le reste).
- [ ] **Step 4: Vérifier** — tests PASS + `npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat: publication bloquée si un jour n'a pas 1 G1 + 1 G2 (contournement force explicite)"`

### Task 6: UI admin — interrupteur, colonne Solde, publication forcée

**Files:**
- Modify: `src/app/admin/AdminClient.tsx`

**Interfaces:**
- Consomme : Task 4 (`/api/config`, `/api/solde`, champ `solde` de la génération), Task 5 (`missingGardeDays`, `force`), Task 1 (`gardeCounts`, `monthDues` pour le direct).
- Produit : rien (feuille).

- [ ] **Step 1: Implémenter** :
  - État `equityV2` chargé au montage (GET `/api/config`) ; case à cocher « Équité V2 — solde depuis sept. 2026 » près du bouton de génération (PUT au changement).
  - `EquityTable({ equity, doctors, solde })` : colonne « Solde » (format `+2,3`/`−1,0`, 1 décimale) rendue seulement si `solde` fourni ; passée pour le brouillon (réponse de génération), la vue publiée et l'édition (GET `/api/solde?year&month`) — jamais quand `equityV2 === false`.
  - Édition en direct : `soldeAprès(doc) = solde[doc] + gardeCounts(editGrid)[doc] − monthDues(editGrid, noGardeFraction)[doc]`, recalculé à chaque `setCell`.
  - Publication : précheck client `missingGardeDays` ; si trous → bandeau rouge listant les jours + bouton distinct « Publier malgré N jour(s) sans garde complète » qui renvoie `force: true` ; gestion du 400 `jours-sans-garde` du serveur (même bandeau). Le flux d'avertissements génériques existant reste inchangé pour le reste.
- [ ] **Step 2: Vérifier** — `npm run build` → OK ; `npm test` → OK.
- [ ] **Step 3: Commit** — `git commit -m "feat: UI admin équité V2 — interrupteur, colonne solde (admin seulement), publication forcée explicite"`

### Task 7: Validation simulation + PR

**Files:**
- Modify: `.context/repro-equity2.ts` (harnais, non commité — `.context` est gitignoré)

- [ ] **Step 1: Adapter le harnais** : simuler 12 mois en mode solde (le solde recalculé chaque mois depuis les « grilles » simulées via `soldeFromMonths`), congés aléatoires déterministes identiques à l'étude du 21/10.
- [ ] **Step 2: Vérifier** : écart mensuel ≤ 1 entre médecins 100 % dispo sur les 12 mois ; |solde| borné (pas de dérive) ; écart annuel ≤ celui de l'étude (7).
- [ ] **Step 3: Suite complète** — `npm test` → 100 % PASS ; `npm run build` → OK.
- [ ] **Step 4: PR** — vérifier l'état des PR (`gh pr list`), pousser la branche `Guillaumekite/equite-repartition-gardes`, créer la PR vers `main` (titre : « Équité V2 : solde de gardes ancré septembre, mois plats, interrupteur de retour arrière ») récapitulant : décision, ancrage, rollback, V1 nombre seulement.

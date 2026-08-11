# Refonte algo gardes + postes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implémenter la spec `docs/superpowers/specs/2026-08-11-refonte-algo-gardes-postes-design.md` : équité des gardes portée par le solveur (cibles proportionnelles + carry ratio borné ±1, cap 6/7/8, règles week-end par jour, espacement, règle hebdo, échelle de relaxation réordonnée, plancher 6 présents), complétion Univ au ratio, sélection HC équitable + « Jamais HC », anti-répétition des postes de base.

**Architecture:** Le moteur reste pur/déterministe (`src/engine/`). `gardes.ts` : le MILP GLPK gagne un objectif d'équité (variables d'écart par médecin autour d'une cible arrondie) et une échelle de relaxation paramétrée `{capBase, restGap, weekendDup, honorWishes}` ; la recherche locale gagne les échanges (swaps), un poids d'espacement relevé et une pénalité de couverture hebdomadaire. `planning.ts` : plancher < 6 présents, anomalies hebdo, complétion Univ, sélection HC en tête de Pass 3, anti-répétition dans `leastFor`. La route calcule `carryWorked` depuis la grille publiée précédente.

**Tech Stack:** TypeScript, glpk.js (WASM), vitest. Tests : `npx vitest run src/engine/ src/lib/ src/db/`.

## Global Constraints

- Moteur pur et déterministe : pas de `Date.now()`, pas de `Math.random()` non seedé — même entrée ⇒ même sortie.
- Tous les messages admin (warnings) en français, précis (jours et médecins nommés).
- Chaque relaxation de règle produit un avertissement dans `warnings`.
- Ne jamais casser : G+ forcés, RS le lendemain de garde, tirage au sort déterministe, rôle G1/G2, moteur CS, récup, ACU.
- Les tests existants qui contredisent la nouvelle spec sont MIS À JOUR (pas supprimés) en citant la spec en commentaire.
- Commits fréquents, un par tâche minimum, messages en français, suffixe `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Cibles proportionnelles + carry en ratio borné ±1

**Files:**
- Modify: `src/engine/types.ts` (GardeInput : + `carryWorked`)
- Modify: `src/engine/gardes.ts` (nouvelle fonction exportée `computeGardeTargets`, `polishEquity` cible le mois via ces cibles)
- Test: `src/engine/gardes.test.ts`

**Interfaces:**
- Produces: `computeGardeTargets(doctors: DoctorId[], totalSlots: number, weight: Record<DoctorId, number>, carryCount: Record<DoctorId, number>, carryWorked: Record<DoctorId, number>): Record<DoctorId, number>` — cible mensuelle (fractionnaire) par médecin. Consommée par le MILP (Task 2) et la recherche locale.
- `GardeInput.carryWorked?: Record<DoctorId, number>` — jours travaillés du mois publié précédent.

- [ ] **Step 1: Test qui échoue** — dans `gardes.test.ts` :

```ts
import { computeGardeTargets } from './gardes';

describe('computeGardeTargets — carry en ratio borné ±1', () => {
  it('sans carry : part proportionnelle au poids', () => {
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, {}, {});
    expect(t.a).toBeCloseTo(30); expect(t.b).toBeCloseTo(30);
  });
  it('un médecin surchargé le mois dernier est soulagé d\'AU PLUS 1 garde', () => {
    // a a fait 7 gardes en 20 jours travaillés, b 3 en 20 : gros déséquilibre passé,
    // mais la correction est bornée : |cible - part| ≤ 1.
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, { a: 7, b: 3 }, { a: 20, b: 20 });
    expect(t.a).toBeGreaterThanOrEqual(29); expect(t.a).toBeLessThan(30);
    expect(t.b).toBeGreaterThan(30); expect(t.b).toBeLessThanOrEqual(31);
  });
  it('le ratio compte, pas le brut : moins de gardes parce que moins présent ⇒ pas de rattrapage', () => {
    // a : 3 gardes / 10 jours travaillés (ratio 0.3) ; b : 6 / 20 (ratio 0.3) — même ratio ⇒ corrections ~0.
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, { a: 3, b: 6 }, { a: 10, b: 20 });
    expect(Math.abs(t.a - 30)).toBeLessThan(0.5);
    expect(Math.abs(t.b - 30)).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Vérifier l'échec** — `npx vitest run src/engine/gardes.test.ts` → FAIL (`computeGardeTargets` n'existe pas).
- [ ] **Step 3: Implémentation** — dans `gardes.ts` :

```ts
/** Cible mensuelle par médecin : part proportionnelle au poids (FTE × dispo) du mois courant,
 * corrigée du mois précédent en RATIO gardes/jours travaillés — correction BORNÉE à ±1 garde
 * (spec §1.3 : le carry ajuste, il n'écrase jamais l'équilibre du mois courant). */
export function computeGardeTargets(
  doctors: DoctorId[],
  totalSlots: number,
  weight: Record<DoctorId, number>,
  carryCount: Record<DoctorId, number>,
  carryWorked: Record<DoctorId, number>,
): Record<DoctorId, number> {
  const w = (d: DoctorId) => weight[d] ?? 1;
  const W = doctors.reduce((s, d) => s + w(d), 0) || 1;
  const withCarry = doctors.filter((d) => (carryCount[d] ?? 0) > 0 || (carryWorked[d] ?? 0) > 0);
  const totC = withCarry.reduce((s, d) => s + (carryCount[d] ?? 0), 0);
  const totW = withCarry.reduce((s, d) => s + (carryWorked[d] ?? 0), 0);
  const targets: Record<DoctorId, number> = {};
  for (const doc of doctors) {
    const share = (totalSlots * w(doc)) / W;
    let corr = 0;
    if (totC > 0 && withCarry.includes(doc)) {
      const expected = totW > 0
        ? (carryWorked[doc] ?? 0) * (totC / totW) // attendu au ratio du mois précédent
        : totC / withCarry.length; // jours travaillés inconnus : moyenne simple (rétro-compat)
      corr = Math.max(-1, Math.min(1, (carryCount[doc] ?? 0) - expected));
    }
    targets[doc] = Math.max(0, share - corr);
  }
  return targets;
}
```

Puis dans `solveGardes` : lire `input.carryWorked ?? {}`, calculer `const targets = computeGardeTargets(doctors, 2 * days.length, gardeWeightInput, carryCount, carryWorked)` (le poids = `input.fte ?? {}` actuel) et le passer à `polishEquity`. Dans `polishEquity` : l'axe COUNT utilise désormais `monthCount` vs `targets[doc]` (plus `cumCount` : le carry est déjà DANS la cible, borné) ; les axes heavy/WE gardent leur logique cumulative actuelle. `types.ts` : ajouter `carryWorked?: Record<DoctorId, number>` à `GardeInput` (et le documenter).

- [ ] **Step 4: Vérifier** — `npx vitest run src/engine/gardes.test.ts` → PASS, y compris le test existant `carries equity across months` (la direction est préservée : plus chargé avant ⇒ cible plus basse). S'il échoue parce qu'il attendait un écart > 1, l'ajuster en citant la spec (« correction bornée ±1 »).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(gardes): cibles proportionnelles, carry mois précédent en ratio borné à ±1"`

---

### Task 2: Équité dans le MILP + cap souple 6

**Files:**
- Modify: `src/engine/gardes.ts` (`solveFeasibility` : variables d'écart + objectif ; caps par palier)
- Test: `src/engine/gardes.test.ts`

**Interfaces:**
- Consumes: `computeGardeTargets` (Task 1).
- Produces: `solveFeasibility(input, days, weights, plan, targets)` — `plan` devient `{ forced, cap, restGap, weekendDup, weCap }` (weekendDup/restGap consommés en Tasks 3-4 ; ici seulement `cap`).

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solveGardes — cap souple 6 et équité MILP', () => {
  it('personne au-dessus de 6 gardes quand l\'effectif suffit (11 médecins, 31 jours)', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(11) });
    expect(r.status).toBe('feasible');
    if (r.status !== 'feasible') return;
    for (const c of Object.values(r.equity.count)) expect(c).toBeLessThanOrEqual(6);
    const cs = Object.values(r.equity.count);
    expect(Math.max(...cs) - Math.min(...cs)).toBeLessThanOrEqual(1); // équité dès le solveur
  });
  it('monte à 7 UNIQUEMENT si nécessaire, avec avertissement (9 médecins, 31 jours = 62 gardes)', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(9) });
    expect(r.status).toBe('feasible');
    if (r.status !== 'feasible') return;
    expect(Math.max(...Object.values(r.equity.count))).toBe(7);
    expect(r.warnings.some((w) => w.includes('7'))).toBe(true);
  });
});
```

(`docs(n)` : helper existant du fichier ou `Array.from({length:n},(_,i)=>\`doc\${i}\`)`.)

- [ ] **Step 2: Vérifier l'échec** — le cap actuel est 7 partout et sans warning.
- [ ] **Step 3: Implémentation** — dans `solveFeasibility` : pour chaque médecin, ajouter les variables continues `devp_<doc>`, `devm_<doc>` et la contrainte `Σ g_vars(doc) + devm − devp = round(targets[doc])` (type `GLP_FX`), avec `devp`/`devm` dans l'objectif (coef 1, en plus du `weekendDeficit` existant). Le cap devient `plan.cap[doc]` où, au palier 0, `cap[doc] = max(6, nbG+retenus)` (constante `TARGET_MAX_GARDES = 6` ; `MAX_GARDES_PER_MONTH = 7` reste le grand max hors G+). Le passage à 7 est déclenché par l'échelle de relaxation (préfiguré ici : deux tentatives `capBase 6` puis `capBase 7` avec note `Effectif insuffisant pour tenir 6 gardes/mois maximum : certains médecins montent à 7 ce mois-ci.` — l'échelle complète arrive en Task 4). Passer `targets` en paramètre depuis `solveGardes`.
- [ ] **Step 4: Vérifier** — suite `gardes.test.ts` complète. Mettre à jour : `caps every doctor at 7` → devient « cap 6 par défaut, 7 si l'effectif l'exige (avec warning) » ; `lifts the cap ... 8 wishes → 8 gardes` inchangé (cap = max(6, 8) = 8).
- [ ] **Step 5: Commit** — `git commit -m "feat(gardes): équité portée par le MILP (écarts à la cible) + cap souple 6"`

---

### Task 3: Règles week-end par jour + exception G+

**Files:**
- Modify: `src/engine/gardes.ts` (contraintes par type de jour ; exception G+ ; `canTake`)
- Test: `src/engine/gardes.test.ts`

**Interfaces:**
- Produces: `plan.weekendDup: boolean` (false = règles strictes ; true = palier 3 de l'échelle). Helper interne `weekendWishDays(doc): Set<number>`.

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solveGardes — week-ends : jamais 2× le même jour, exception G+', () => {
  it('jamais deux vendredis, deux samedis ou deux dimanches pour le même médecin', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(12) });
    if (r.status !== 'feasible') throw new Error('infeasible');
    const perDocWd = new Map<string, Map<number, number>>();
    for (const a of r.assignments) {
      const wd = new Date(Date.UTC(2026, 9, a.day)).getUTCDay(); // 5=ven, 6=sam, 0=dim
      if (![5, 6, 0].includes(wd)) continue;
      const m = perDocWd.get(a.doctorId) ?? new Map();
      m.set(wd, (m.get(wd) ?? 0) + 1); perDocWd.set(a.doctorId, m);
    }
    for (const m of perDocWd.values()) for (const n of m.values()) expect(n).toBeLessThanOrEqual(1);
  });
  it('G+ sur 2 samedis : accordés, et AUCUNE autre garde de week-end ajoutée à ce médecin', async () => {
    // Octobre 2026 : samedis 3, 10, 17, 24, 31 ; le médecin pose G+ les samedis 3 et 10.
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(12), wishes: { doc0: [3, 10] } });
    if (r.status !== 'feasible') throw new Error('infeasible');
    const mine = r.assignments.filter((a) => a.doctorId === 'doc0');
    expect(mine.some((a) => a.day === 3)).toBe(true);
    expect(mine.some((a) => a.day === 10)).toBe(true);
    const weDays = mine.filter((a) => { const wd = new Date(Date.UTC(2026, 9, a.day)).getUTCDay(); return [5, 6, 0].includes(wd); });
    expect(weDays.map((a) => a.day).sort()).toEqual([10, 3].sort()); // exactement ses G+ de WE
  });
});
```

- [ ] **Step 2: Vérifier l'échec.**
- [ ] **Step 3: Implémentation** — dans le pré-traitement G+ : supprimer le refus `weKept >= weCap` (les G+ de WE sont TOUJOURS acceptés, spec §1.2) ; garder le filtre de distance (< 3 jours). Calculer `weekendWishes[doc] = Set des G+ retenus tombant ven/sam/dim`. Dans `solveFeasibility` (mode strict, `!plan.weekendDup`) :
  - Médecin AVEC ≥ 1 G+ de WE : ses g-vars de WE hors jours G+ sont interdites (les exclure via `allowed()` : jour WE && pas dans `weekendWishes[doc]` ⇒ non autorisé).
  - Médecin SANS G+ de WE : une contrainte `≤ 1` par type de jour (Σ g-vars des vendredis ≤ 1, idem samedis, dimanches) + total WE ≤ 2 (constante `MAX_WEEKEND_GARDES` conservée).
  En mode `weekendDup` (palier 3, Task 4) : per-type et exclusions levées, seul le cap total adaptatif actuel (boucle `weCapacityAt`) s'applique. Supprimer l'ancien pré-calcul adaptatif du palier 0 (il ne sert plus qu'au palier 3). Miroir exact dans `canTake` de `polishEquity` (compteurs `monthWeByWd[doc][weekday]`).
- [ ] **Step 4: Vérifier** — suite complète. Les tests existants `rotates Fri/Sat/Sun fairly` restent verts.
- [ ] **Step 5: Commit** — `git commit -m "feat(gardes): jamais 2× le même jour de week-end, exception G+ (zéro WE ajouté)"`

---

### Task 4: Échelle de relaxation réordonnée + plancher < 6 présents

**Files:**
- Modify: `src/engine/gardes.ts` (échelle 5 paliers ; `restGap` paramétré)
- Modify: `src/engine/planning.ts` (plancher < 6 présents un jour ouvré)
- Test: `src/engine/gardes.test.ts`, `src/engine/planning.test.ts`

**Interfaces:**
- Produces: type interne `WishPlan = { forced: Set<string>; cap: Record<DoctorId, number>; restGap: 3 | 2; weekendDup: boolean; weCap: number }`. Échelle :

```ts
const LADDER = [
  { capBase: 6, restGap: 3 as const, weekendDup: false, honorWishes: true },
  { capBase: 7, restGap: 3 as const, weekendDup: false, honorWishes: true,
    note: 'Effectif insuffisant pour tenir 6 gardes/mois maximum : certains médecins montent à 7 ce mois-ci.' },
  { capBase: 7, restGap: 2 as const, weekendDup: false, honorWishes: true,
    note: 'Mois très contraint : repos entre gardes réduit à 1 jour (le RS seul) pour certains médecins.' },
  { capBase: 7, restGap: 2 as const, weekendDup: true, honorWishes: true,
    note: 'Mois très contraint : impossible d\'éviter deux gardes le même jour de week-end pour tout le monde.' },
  { capBase: 7, restGap: 2 as const, weekendDup: true, honorWishes: false,
    note: 'Mois trop contraint : certains G+ ne sont pas garantis (repos / effectif).' },
];
```

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solveGardes — échelle de relaxation (ordre spec §1.4)', () => {
  it('un mois tenable à 6 ne produit AUCUN warning de relaxation', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(11) });
    if (r.status !== 'feasible') throw new Error('infeasible');
    expect(r.warnings.filter((w) => w.includes('montent à 7') || w.includes('repos') || w.includes('même jour de week-end'))).toEqual([]);
  });
  it('avec 5 médecins (31 j = 62 gardes, min repos), le repos passe à 2 AVANT d\'abandonner les G+', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(5), wishes: { doc0: [15] } });
    if (r.status !== 'feasible') throw new Error('infeasible');
    expect(r.assignments.some((a) => a.doctorId === 'doc0' && a.day === 15)).toBe(true); // G+ tenu
  });
});

// planning.test.ts :
describe('solvePlanning — plancher < 6 présents', () => {
  it('un jour ouvré à 5 présents ⇒ infaisable, jours listés', async () => {
    // 6 médecins, doc0 en congé le jeudi 1er octobre 2026 → 5 présents ce jour.
    const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(6),
      availability: { doc0: { 1: 'conge' } } });
    expect(r.status).toBe('infeasible');
    if (r.status === 'infeasible') { expect(r.reason).toContain('6 présents'); expect(r.reason).toContain('1'); }
  });
});
```

- [ ] **Step 2: Vérifier l'échec** (avec 5 médecins l'actuel est infaisable : cap 7 × 5 = 35 < 62 ; le nouveau palier restGap 2 + cap… reste infaisable aussi — ajuster le scénario : 5 médecins ne peuvent pas couvrir 62 gardes, prendre 10 médecins avec beaucoup d'indispos qui forcent le palier 2 ; l'exécutant calibre le scénario pour que le palier 2 soit atteint mais pas le 4).
- [ ] **Step 3: Implémentation** — `gardes.ts` : remplacer le tableau `attempts` actuel par `LADDER` ; `cap[doc] = max(capBase, keptWishes[doc]?.length ?? 0)` recalculé par palier ; les fenêtres de repos (`rsRows` et `canTake`) paramétrées par `restGap` (fenêtres de 3 jours si `restGap === 3`, de 2 si `2` — c.-à-d. jamais 2 jours consécutifs) ; `honorWishes: false` ⇒ `forced` vide (mais les G+ restent des souhaits doux via l'équité). Pré-check de capacité : utiliser `cap` du DERNIER palier (7/G+) pour le message d'infaisabilité totale. `planning.ts` : juste après le calcul de `tpDays`, le plancher :

```ts
// Plancher d'effectif (spec §1.1) : < 6 présents un jour ouvré ⇒ génération impossible,
// on ne relâche RIEN, l'admin voit précisément quels jours bloquent.
const understaffed = days
  .filter((cd) => !cd.isWeekend && !cd.isHoliday)
  .filter((cd) => doctors.filter((doc) => PRESENT(avail(input, doc, cd.day)) && !tpDays[doc].has(cd.day)).length < 6)
  .map((cd) => cd.day);
if (understaffed.length) {
  const first = understaffed[0];
  return {
    status: 'infeasible', day: first,
    reason: `Effectif insuffisant : moins de 6 présents le(s) ${understaffed.join(', ')} du mois — ` +
      `planning impossible (congés/indisponibilités à revoir sur ces jours).`,
    eligible: doctors.filter((doc) => PRESENT(avail(input, doc, first)) && !tpDays[doc].has(first)),
  };
}
```

- [ ] **Step 4: Auditer les tests existants** — `npx vitest run src/engine/` : tout scénario de `planning.test.ts` avec un roster < 6 présents un jour ouvré devient infaisable → passer ces rosters à ≥ 6 médecins en conservant le scénario testé (ou, pour les tests d'infaisabilité, vérifier le nouveau message). Vérifier aussi `src/engine/demo.ts` (roster ≥ 6). Itérer jusqu'au vert complet.
- [ ] **Step 5: Commit** — `git commit -m "feat: échelle de relaxation réordonnée (7e→repos→doublon WE→G+) + plancher 6 présents"`

---

### Task 5: Recherche locale — échanges (swaps), espacement renforcé, couverture hebdo

**Files:**
- Modify: `src/engine/gardes.ts` (`polishEquity`), `src/engine/types.ts` (GardeInput : + `weeklyExpected`)
- Test: `src/engine/gardes.test.ts`

**Interfaces:**
- `GardeInput.weeklyExpected?: Record<DoctorId, number[][]>` — par médecin, la liste des semaines complètes travaillées (chaque semaine = tableau des numéros de jour lun→dim). Produit par `planning.ts` (Task 6) ; les tests moteur le passent directement.
- Constantes : `W_SPREAD = 2.5` (au lieu de 0,3), `W_WEEK = 4` (pénalité par semaine attendue sans garde).

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solveGardes — espacement et couverture hebdomadaire', () => {
  it('14 médecins pleinement présents : chaque semaine attendue contient une garde', async () => {
    const ds = docs(14);
    const weeks = [[5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18], [19, 20, 21, 22, 23, 24, 25]]; // oct. 2026, lun 5 → dim 25
    const weeklyExpected = Object.fromEntries(ds.map((d) => [d, weeks]));
    const r = await solveGardes({ year: 2026, month: 10, doctors: ds, weeklyExpected });
    if (r.status !== 'feasible') throw new Error('infeasible');
    const byDoc = new Map(ds.map((d) => [d, new Set<number>()]));
    for (const a of r.assignments) byDoc.get(a.doctorId)!.add(a.day);
    let missed = 0;
    for (const d of ds) for (const wk of weeks) if (!wk.some((day) => byDoc.get(d)!.has(day))) missed++;
    expect(missed).toBe(0); // 14 médecins × 3 semaines = 42 attendues ≤ 42 slots (14 j × 2 + bords)
  });
  it('écart maximal entre 2 gardes consécutives d\'un médecin ≤ 2× l\'écart idéal', async () => {
    const r = await solveGardes({ year: 2026, month: 10, doctors: docs(10) });
    if (r.status !== 'feasible') throw new Error('infeasible');
    const byDoc: Record<string, number[]> = {};
    for (const a of r.assignments) (byDoc[a.doctorId] ??= []).push(a.day);
    for (const days of Object.values(byDoc)) {
      days.sort((a, b) => a - b);
      const ideal = 31 / (days.length + 1);
      for (let i = 1; i < days.length; i++) expect(days[i] - days[i - 1]).toBeLessThanOrEqual(Math.ceil(2 * ideal));
    }
  });
});
```

- [ ] **Step 2: Vérifier l'échec** (au moins le premier doit échouer aujourd'hui ; si le second passe déjà, le garder comme non-régression).
- [ ] **Step 3: Implémentation** — dans `polishEquity` :
  1. `W_SPREAD = 2.5`. Ajouter `weeklyExpected` : `weekCost(doc) = nb de semaines attendues sans aucune garde` ; delta pondéré `W_WEEK = 4` recalculé pour `a` et `b` à chaque move (les sets `dayList` suffisent).
  2. Neighborhood d'échange : quand plus aucun déplacement simple n'améliore (`best === null`), scanner les paires `(di, a)` × `(dj, b)` avec `a ∈ assigned[di]`, `b ∈ assigned[dj]`, `a ≠ b`, `di ≠ dj` : échange faisable si `a` peut prendre `dj` et `b` peut prendre `di` en IGNORANT leur propre garde échangée (variante `canTakeIgnoring(doc, day, ignoreDay)` qui exclut `ignoreDay` du test de proximité et des compteurs). Les compteurs mensuels ne bougent pas (chacun garde son nombre) ; recalculer les deltas heavy/WE/spread/week/pair comme la composition de deux moves. Appliquer le meilleur échange si delta < 0, puis reprendre les déplacements simples. Garder `MAX_ITER` global ; borner les passes d'échange (p. ex. 400 applications max) pour la perf. Aucune source d'aléa.
- [ ] **Step 4: Vérifier** — suite complète `gardes.test.ts` (dont déterminisme : deux runs identiques). Chronométrer grossièrement : la suite doit rester < 60 s.
- [ ] **Step 5: Commit** — `git commit -m "feat(gardes): échanges de gardes, espacement renforcé, couverture hebdomadaire"`

---

### Task 6: Anomalies hebdomadaires dans le bandeau admin

**Files:**
- Modify: `src/engine/planning.ts` (calcul `weeklyExpected` + warnings après le solve)
- Test: `src/engine/planning.test.ts`

**Interfaces:**
- Consumes: `GardeInput.weeklyExpected` (Task 5).
- Produces: warnings au format `Anomalie : <doc> travaille toute la semaine du <j1> au <j7> sans garde.`

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solvePlanning — anomalies hebdomadaires', () => {
  it('signale une semaine complète travaillée sans garde (roster 16 = plus que 14 slots/semaine)', async () => {
    const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(16) });
    if (r.status !== 'feasible') throw new Error('infeasible');
    // 16 médecins pour 14 gardes/semaine : au moins 2 anomalies par semaine complète.
    expect(r.warnings.some((w) => w.startsWith('Anomalie :') && w.includes('sans garde'))).toBe(true);
  });
  it('PAS d\'anomalie pour un médecin en G− toute la semaine', async () => {
    const avail: Record<number, 'no_garde'> = {};
    for (let d = 5; d <= 11; d++) avail[d] = 'no_garde'; // semaine lun 5 → dim 11 oct. 2026
    const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(16), availability: { doc0: avail } });
    if (r.status !== 'feasible') throw new Error('infeasible');
    expect(r.warnings.some((w) => w.startsWith('Anomalie :') && w.includes('doc0') && w.includes('du 5 au 11'))).toBe(false);
  });
});
```

- [ ] **Step 2: Vérifier l'échec.**
- [ ] **Step 3: Implémentation** — dans `solvePlanning`, AVANT `solveGardes` : construire `weeklyExpected` (semaines lun→dim entièrement dans le mois ; pour chaque médecin : tous les jours ouvrés de la semaine `PRESENT` et hors TP off ⇒ semaine attendue, SAUF si tous les jours de la semaine sont non-gardables — G−, congé, TP, veille d'Univ via `gardeBlocked`) et le passer dans `gardeInput`. APRÈS le solve : pour chaque semaine attendue sans garde dans `gardeByDay`, pousser le warning au format ci-dessus. Le même `weeklyExpected` sert aux deux (une seule source de vérité).
- [ ] **Step 4: Vérifier** — `npx vitest run src/engine/planning.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: anomalie admin — semaine complète travaillée sans garde (exception G−)"`

---

### Task 7: Complétion automatique des jours Univ au ratio

**Files:**
- Modify: `src/engine/planning.ts` (Pass 2 réécrit, helper `pickUnivDays`)
- Test: `src/engine/planning.test.ts`

**Interfaces:**
- Produces: helper interne `pickUnivDays(candidates: number[], k: number, headcount: (day: number) => number): number[]` — choisit `k` jours en privilégiant le fort effectif (headcount desc), à égalité répartis régulièrement (`pickEven`), en refusant tout jour où `headcount(day) < 9` (le cœur de 8 doit survivre au retrait).

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solvePlanning — complétion Univ au ratio (cas Gravero)', () => {
  it('3 jours déclarés + ratio 50 % ⇒ l\'algo complète jusqu\'à ~50 % des jours ouvrés travaillés', async () => {
    const r = await solvePlanning({ year: 2026, month: 9, doctors: docs(14),
      profiles: { doc0: { universitaire: true, universityRatio: 50 } },
      univConstraints: { doc0: [1, 8, 15] } }); // 3 mardis de sept. 2026
    if (r.status !== 'feasible') throw new Error('infeasible');
    const uDays = Object.entries(r.grid.doc0).filter(([, v]) => v === 'U' || v === 'U+G1' || v === 'U+G2');
    expect(uDays.map(([d]) => Number(d))).toEqual(expect.arrayContaining([1, 8, 15])); // déclarés fixes
    const workdays = r.days.filter((cd) => !cd.isWeekend && !cd.isHoliday).length;
    expect(uDays.length).toBeGreaterThanOrEqual(Math.floor(0.5 * workdays * 0.7)); // bien plus que 3
  });
  it('les jours U auto vont en priorité aux jours à fort effectif (moins d\'HC ces jours-là)', async () => {
    const r = await solvePlanning({ year: 2026, month: 9, doctors: docs(14),
      profiles: { doc0: { universitaire: true, universityRatio: 50 } }, univConstraints: { doc0: [1] } });
    if (r.status !== 'feasible') throw new Error('infeasible'); // le placement ne doit jamais casser le cœur :
    expect(r.warnings.filter((w) => w.startsWith('Contrôle du'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Vérifier l'échec** (aujourd'hui : 3 U exactement, ligne `if (univDays[doc].size > 0) continue;`).
- [ ] **Step 3: Implémentation** — supprimer le `continue` ; pour CHAQUE universitaire (hors juillet/août) : `base` = jours ouvrés où `basePresent` et (cellule vide OU déjà U déclaré) ; `kTotal = round(ratio/100 × base.length)` ; `kAuto = max(0, kTotal − nbDéclarésPosés)` ; candidats = base à cellule vide ; `headcount(day) = workingCount(day)` au moment du placement (mis à jour au fil des médecins, ordre du roster = déterministe) ; placer `pickUnivDays(candidats, kAuto, headcount)` en `'U'`. Si le quota ne peut pas être atteint (candidats filtrés < kAuto) : warning `Complétion Univ partielle pour <doc> : <n> jours U posés sur un objectif de <kTotal> (effectif insuffisant certains jours).`. Les médecins SANS jour déclaré passent par le même chemin (remplace `pickEven` seul). Mettre à jour le test existant `places U on EXACTLY the declared Univ days (no auto %-fill)` → renommé « les jours déclarés sont posés ET complétés au ratio » (spec §2). Les jours U auto ne re-bloquent pas de garde a posteriori : une cellule vide le jour J garantit déjà qu'il n'y a ni garde ni RS ce jour (le RS occupe le lendemain d'une garde).
- [ ] **Step 4: Vérifier** — suite `planning.test.ts` complète (dont `skips U entirely in July/August` inchangé).
- [ ] **Step 5: Commit** — `git commit -m "fix(univ): les jours déclarés n'annulent plus la complétion au ratio (cas Gravero)"`

---

### Task 8: Case profil « Jamais HC » (DB → API → UI → moteur)

**Files:**
- Modify: `src/db/schema.ts` (`ALTER TABLE doctors ADD COLUMN IF NOT EXISTS no_hc boolean NOT NULL DEFAULT false;` à côté de `no_s`)
- Modify: `src/lib/doctors.ts` (`DoctorRow.no_hc`, `DOCTOR_COLS`, `EDITABLE`)
- Modify: `src/app/admin/AdminClient.tsx` (colonne « Jamais HC » : `<th>` + `<td><input type="checkbox" checked={d.no_hc} onChange={(e) => patchDoctor(d.id, { no_hc: e.target.checked })} title="Ce médecin ne reçoit jamais le poste HC" /></td>` sur le modèle exact de `no_s` lignes ~222/241 ; et dans le mapping des profils ligne ~143-155 : `if (d.no_hc) p.noHC = true;`)
- Modify: `src/app/api/generate/route.ts` (`ProfileSchema` : `noHC: z.boolean().optional()`)
- Modify: `src/engine/planning.ts` (`DoctorProfile.noHC?: boolean` + `const noHC = new Set(doctors.filter((doc) => input.profiles?.[doc]?.noHC));` près de `noS`)
- Test: `src/db/db.test.ts` (si ce fichier teste les colonnes doctors, ajouter `no_hc` ; sinon rien)

- [ ] **Step 1: Implémenter les 5 fichiers** (pas de test moteur ici : le comportement HC est testé en Task 9 ; ceci est du câblage suivant un pattern existant à l'identique).
- [ ] **Step 2: Vérifier** — `npx vitest run src/db/ && npx next build 2>&1 | tail -5` (build OK, types OK). Si `db.test.ts` requiert une base non disponible localement, lancer au moins `npx tsc --noEmit`.
- [ ] **Step 3: Commit** — `git commit -m "feat(profil): case « Jamais HC » (no_hc) de la base à l'UI admin"`

---

### Task 9: Sélection HC équitable en tête de Pass 3

**Files:**
- Modify: `src/engine/planning.ts` (Pass 3 : HC choisi AVANT la distribution des postes)
- Test: `src/engine/planning.test.ts`

**Interfaces:**
- Consumes: `noHC` (Task 8). État nouveau : `hcCnt: Record<DoctorId, number>`, `lastHcDay: Record<DoctorId, number>` (initialisés comme `csTotal`/`lastCsDay`).

- [ ] **Step 1: Tests qui échouent** :

```ts
describe('solvePlanning — HC équitable', () => {
  it('l\'HC tourne : écart max−min ≤ 2 sur le mois, jamais 2 jours d\'affilée si évitable', async () => {
    const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(15) });
    if (r.status !== 'feasible') throw new Error('infeasible');
    const hc: Record<string, number> = {}; let streaks = 0;
    for (const doc of Object.keys(r.grid)) {
      let prev = -9; hc[doc] = 0;
      for (const [d, v] of Object.entries(r.grid[doc])) if (v === 'HC') {
        hc[doc]++; if (Number(d) === prev + 1) streaks++; prev = Number(d);
      }
    }
    const vals = Object.values(hc);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(2);
    expect(streaks).toBe(0);
  });
  it('« Jamais HC » : le médecin coché n\'a aucun HC', async () => {
    const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(15), profiles: { doc0: { noHC: true } } });
    if (r.status !== 'feasible') throw new Error('infeasible');
    expect(Object.values(r.grid.doc0)).not.toContain('HC');
  });
});
```

- [ ] **Step 2: Vérifier l'échec** (aujourd'hui l'HC est « le reste » : concentré, avec séries).
- [ ] **Step 3: Implémentation** — dans la boucle des jours ouvrés, remonter le calcul de `g`/`acuOnGarde` avant les extras, puis TOUT EN HAUT (après le calcul de `pool`) :

```ts
// --- Spec §3 : on choisit d'abord QUI part en HC, ensuite on distribue les postes. ---
const extrasPlanned = (() => {
  let b = pool.length - coreFirst.length - coreRest.length - csSlots, n = 0;
  if (b > 0 && working >= 10) { n++; b--; }
  if (b > 0 && working >= 11 && pool.some((d) => douleurPoids[d] >= 1)) { n++; b--; }
  if (b > 0 && working >= 12 && pool.some((d) => presenceDocs.has(d))) { n++; b--; }
  if (b > 0 && working >= 12 && acuOnGarde) { n++; b--; }
  return n;
})();
let hcToday = Math.max(0, pool.length - (coreFirst.length + coreRest.length + csSlots + extrasPlanned));
if (hcToday > 0) {
  const cdCand = pool.filter((d) => douleurPoids[d] >= 1);
  const pCand = pool.filter((d) => presenceDocs.has(d));
  const protectedDocs = new Set<DoctorId>(); // seuls candidats d'un poste réservé qui va tourner
  if (working >= 11 && cdCand.length === 1) protectedDocs.add(cdCand[0]);
  if (working >= 12 && pCand.length === 1) protectedDocs.add(pCand[0]);
  const hcSort = (arr: DoctorId[]) => [...arr].sort((a, b) => {
    const ra = hcCnt[a] / Math.max(presWeekdays[a], 1), rb = hcCnt[b] / Math.max(presWeekdays[b], 1);
    if (ra !== rb) return ra - rb; // équité prorata d'abord
    const sa = lastHcDay[a] === cd.day - 1 ? 1 : 0, sb = lastHcDay[b] === cd.day - 1 ? 1 : 0;
    if (sa !== sb) return sa - sb; // puis anti-série
    return rot(a) - rot(b);
  });
  const take = (doc: DoctorId) => { assign(doc, 'HC'); hcCnt[doc]++; lastHcDay[doc] = cd.day; hcToday--; };
  for (const doc of hcSort(pool.filter((d) => !noHC.has(d) && !protectedDocs.has(d))).slice(0, hcToday)) take(doc);
  for (const doc of hcSort(pool).slice(0, hcToday)) { // dernier recours : tous les restants sont protégés/« Jamais HC »
    warnings.push(`HC attribué à ${doc} le ${cd.day} malgré « Jamais HC » (aucun autre médecin disponible).`);
    take(doc);
  }
}
```

  Le filet de sécurité final (`leftover → HC`) reste mais passe par `hcSort` + compteurs (il doit être vide en régime normal). Déclarer `hcCnt`/`lastHcDay` avec les autres états CS.
- [ ] **Step 4: Vérifier** — suite `planning.test.ts` complète (l'arithmétique `extrasPlanned` doit coller aux affectations réelles : si un test « Contrôle du … » sort en warning, corriger l'écart plutôt que le test).
- [ ] **Step 5: Commit** — `git commit -m "feat(postes): l'HC est choisi d'abord et tourne équitablement (« Jamais HC » respecté)"`

---

### Task 10: Anti-répétition des postes de base

**Files:**
- Modify: `src/engine/planning.ts` (`leastFor`)
- Test: `src/engine/planning.test.ts`

- [ ] **Step 1: Test qui échoue** :

```ts
it('anti-répétition : jamais le même poste de base (BM/S/Ped) deux jours ouvrés consécutifs quand une alternative existe', async () => {
  const r = await solvePlanning({ year: 2026, month: 10, doctors: docs(12) });
  if (r.status !== 'feasible') throw new Error('infeasible');
  let repeats = 0;
  for (const doc of Object.keys(r.grid))
    for (const [d, v] of Object.entries(r.grid[doc]))
      if (['BM', 'S', 'Ped'].includes(v) && r.grid[doc][Number(d) - 1] === v) repeats++;
  expect(repeats).toBeLessThanOrEqual(1); // tolérance : un cas contraint isolé
});
```

- [ ] **Step 2: Vérifier l'échec** (compter les répétitions actuelles ; si déjà ≤ 1, resserrer à 0 et garder en non-régression).
- [ ] **Step 3: Implémentation** — dans `leastFor`, insérer entre le compteur du poste et `totalPosts` :

```ts
const ra = grid[a][cd.day - 1] === post ? 1 : 0; // pas le même poste que la veille (spec §3.3)
const rb = grid[b][cd.day - 1] === post ? 1 : 0;
if (ra !== rb) return ra - rb;
```

- [ ] **Step 4: Vérifier** — suite complète moteur.
- [ ] **Step 5: Commit** — `git commit -m "feat(postes): anti-répétition — pas le même poste de base que la veille si évitable"`

---

### Task 11: Route — `carryWorked` depuis la grille publiée précédente

**Files:**
- Create: `src/lib/carryWorked.ts` + Test: `src/lib/carryWorked.test.ts`
- Modify: `src/app/api/generate/route.ts`, `src/engine/planning.ts` (PlanningInput + passage au gardeInput)

**Interfaces:**
- Produces: `workedDaysFromGrid(grid: Record<string, Record<number, string>>): Record<string, number>` — par médecin, nb de cellules ni vides ni `'CA'` (RS/G1/G2/U/postes comptent travaillés ; les blancs — week-ends off, TP off, récup — non).
- `PlanningInput.carryWorked?: Record<DoctorId, number>` transmis tel quel à `GardeInput.carryWorked` (Task 1).

- [ ] **Step 1: Test qui échoue** (`src/lib/carryWorked.test.ts`) :

```ts
import { describe, it, expect } from 'vitest';
import { workedDaysFromGrid } from './carryWorked';

describe('workedDaysFromGrid', () => {
  it('compte les cellules travaillées, ignore CA et les blancs', () => {
    expect(workedDaysFromGrid({
      a: { 1: 'G1', 2: 'RS', 3: 'BM', 4: 'CA', 5: '' },
      b: { 1: 'U', 2: 'HC' },
    })).toEqual({ a: 3, b: 2 });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**, **Step 3: Implémenter** :

```ts
/** Jours travaillés par médecin dans une grille publiée : toute cellule non vide autre que CA
 * (G1, G2, RS, U, ACU, postes, HC…). Nourrit le carry en RATIO gardes/jours travaillés. */
export function workedDaysFromGrid(grid: Record<string, Record<number, string>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [doc, cells] of Object.entries(grid)) {
    out[doc] = Object.values(cells).filter((v) => v && v !== 'CA').length;
  }
  return out;
}
```

  Dans la route : `carryWorked: prev ? workedDaysFromGrid(prev.grid) : undefined` passé à `solvePlanning` ; `planning.ts` le déclare dans `PlanningInput` et le transmet dans `gardeInput`.
- [ ] **Step 4: Vérifier** — `npx vitest run src/lib/ src/engine/` → PASS ; `npx tsc --noEmit` → OK.
- [ ] **Step 5: Commit** — `git commit -m "feat(route): carryWorked — jours travaillés du mois publié pour le carry en ratio"`

---

### Task 12: Vérification finale

- [ ] **Step 1:** `npx vitest run` (toute la suite du repo, `src/` uniquement si les tests `.claude/skills` ne font pas partie du projet — utiliser `npx vitest run src/`).
- [ ] **Step 2:** `npx next build` + `npx eslint src/` → zéro erreur.
- [ ] **Step 3:** Générer un mois de démo (`src/engine/demo.ts`) et inspecter à l'œil : écarts de gardes ≤ 1, pas de doublon ven/sam/dim, HC tournant, U au ratio. Corriger tout écart avec la spec avant de conclure.
- [ ] **Step 4:** Commit final éventuel + résumé des warnings/anomalies types pour l'admin.

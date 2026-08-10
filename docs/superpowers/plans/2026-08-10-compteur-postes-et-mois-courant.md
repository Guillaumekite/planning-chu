# Compteur des postes + mois courant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir la page admin sur le mois courant et ajouter un tableau compteur des postes (matrice postes × jours, avec contrôle et motif) sous le planning, à l'écran et dans l'export Excel/CSV, l'équité passant sous ce tableau.

**Architecture:** Un module TS pur `src/lib/garde-counter.ts` calcule tout depuis `grid` + `days` (comptes par poste, travaillants, postes de base manquants, motif) — réutilisé à l'identique par la page (composant `PostCounterTable`) et par la route d'export. Aucune modification du moteur d'affectation ; aucune persistance nouvelle.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, ExcelJS (export), Vitest (tests).

## Global Constraints

- Ne PAS modifier le moteur d'affectation (`src/engine/planning.ts`, `src/engine/gardes.ts`).
- Le compteur se calcule uniquement depuis `grid` + `days` (données présentes en brouillon, en publié et dans l'export). Aucune colonne DB nouvelle.
- Les cellules composées se décomposent via `raw.split('+')` → `[main, evening]`, exactement comme `src/lib/planning-cell.ts`.
- Postes affichés, dans cet ordre : `G1, G2, RS, S, CS1, CS2, BM, Ped, MM, MS, ACU, U, P, HC`.
- Jours péd. (`Ped` autorisé) : `weekday ∈ {0, 2, 3, 4}` (lun, mer, jeu, ven) — constante `PED_DAYS` du moteur, à redéfinir localement.
- Règles de contrôle (jours travaillés `working >= 8`, hors week-end/férié) reproduites du bloc « Self-check » de `src/engine/planning.ts` : `S >= 1` ; si `working >= 9` alors `CS1 >= 1` et `CS2 >= 1`, sinon `CS1 + CS2 >= 1` ; `Ped >= 1` les jours péd. et `Ped == 0` le mardi ; `BM + Ped >= 2`. En plus, tous les jours : `G1 == 1` et `G2 == 1`.
- `working(day)` = nombre de médecins dont le poste de jour (`main`) n'est ni `''`, ni `CA`, ni `ABS`, ni `U`. (Les `RS` comptent.)
- Excel et CSV : **même contenu et même agencement** (planning → compteur → équité empilés). Seule différence : la couleur, remplacée en CSV par un marqueur `!` sur la case en défaut.
- Tests : `npm test` (vitest run). Style : `import { describe, it, expect } from 'vitest';`.

---

### Task 1: Module de calcul `garde-counter.ts`

**Files:**
- Create: `src/lib/garde-counter.ts`
- Test: `src/lib/garde-counter.test.ts`

**Interfaces:**
- Consumes: rien (module autonome).
- Produces:
  - `POST_ROWS: readonly string[]` = `['G1','G2','RS','S','CS1','CS2','BM','Ped','MM','MS','ACU','U','P','HC']`.
  - `type CounterDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean }`.
  - `type PostCounter = { posts: readonly string[]; days: CounterDay[]; counts: Record<number, Record<string, number>>; working: Record<number, number>; flagged: Record<number, Set<string>>; reason: Record<number, string> }`.
  - `function computePostCounter(grid: Record<string, Record<number, string>>, days: CounterDay[]): PostCounter`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computePostCounter, POST_ROWS, type CounterDay } from './garde-counter';

// Un lundi travaillé complet (weekday 0), 9 travaillants, tous les postes de base couverts.
const weekday0: CounterDay = { day: 5, weekday: 0, isWeekend: false, isHoliday: false };
const fullMonday: Record<string, Record<number, string>> = {
  A: { 5: 'G1' }, B: { 5: 'G2' }, C: { 5: 'S' }, D: { 5: 'CS1' }, E: { 5: 'CS2' },
  F: { 5: 'BM' }, G: { 5: 'Ped' }, H: { 5: 'HC' }, I: { 5: 'HC' },
};

describe('computePostCounter', () => {
  it('exposes the post rows in the agreed order', () => {
    expect(POST_ROWS).toEqual(['G1','G2','RS','S','CS1','CS2','BM','Ped','MM','MS','ACU','U','P','HC']);
  });

  it('counts one doctor per base post and flags nothing on a valid working day', () => {
    const c = computePostCounter(fullMonday, [weekday0]);
    expect(c.counts[5].G1).toBe(1);
    expect(c.counts[5].G2).toBe(1);
    expect(c.counts[5].S).toBe(1);
    expect(c.counts[5].CS1).toBe(1);
    expect(c.counts[5].Ped).toBe(1);
    expect(c.working[5]).toBe(9); // G1/G2 comptent comme travaillants ; HC aussi
    expect(c.flagged[5].size).toBe(0);
    expect(c.reason[5]).toBe('');
  });

  it('decomposes composite cells: ACU+G2 counts one ACU and one G2', () => {
    const grid = {
      A: { 5: 'G1' }, B: { 5: 'ACU+G2' }, C: { 5: 'S' }, D: { 5: 'CS1' }, E: { 5: 'CS2' },
      F: { 5: 'BM' }, G: { 5: 'Ped' }, H: { 5: 'U+G1' }, I: { 5: 'HC' },
    };
    const c = computePostCounter(grid, [weekday0]);
    expect(c.counts[5].ACU).toBe(1);
    expect(c.counts[5].G2).toBe(1);   // depuis ACU+G2
    expect(c.counts[5].G1).toBe(2);   // 'G1' + evening de 'U+G1'
    expect(c.counts[5].U).toBe(1);    // main de 'U+G1'
    expect(c.working[5]).toBe(8);     // U (H) ne compte pas comme travaillant
  });

  it('flags missing base posts with a reason on a working weekday', () => {
    const grid = {
      A: { 5: 'G1' }, B: { 5: 'G2' }, C: { 5: 'BM' }, D: { 5: 'Ped' },
      E: { 5: 'HC' }, F: { 5: 'HC' }, G: { 5: 'HC' }, H: { 5: 'HC' },
    }; // pas de S, pas de CS → 8 travaillants
    const c = computePostCounter(grid, [weekday0]);
    expect(c.flagged[5].has('S')).toBe(true);
    expect(c.reason[5]).toContain('S');
    expect(c.reason[5]).toContain('8 travaillants');
  });

  it('flags Ped on a Tuesday (weekday 1, interdit)', () => {
    const tue: CounterDay = { day: 6, weekday: 1, isWeekend: false, isHoliday: false };
    const grid = {
      A: { 6: 'G1' }, B: { 6: 'G2' }, C: { 6: 'S' }, D: { 6: 'CS1' }, E: { 6: 'CS2' },
      F: { 6: 'BM' }, G: { 6: 'Ped' }, H: { 6: 'BM' }, I: { 6: 'HC' },
    };
    const c = computePostCounter(grid, [tue]);
    expect(c.flagged[6].has('Ped')).toBe(true);
    expect(c.reason[6].toLowerCase()).toContain('mardi');
  });

  it('checks only G1/G2 on weekends and flags a missing garde', () => {
    const sat: CounterDay = { day: 3, weekday: 5, isWeekend: true, isHoliday: false };
    const grid = { A: { 3: 'G1' }, B: { 3: 'RS' } }; // pas de G2
    const c = computePostCounter(grid, [sat]);
    expect(c.counts[3].RS).toBe(1);
    expect(c.flagged[3].has('G2')).toBe(true);
    expect(c.flagged[3].has('S')).toBe(false); // pas de contrôle des postes de jour le week-end
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- garde-counter`
Expected: FAIL (« Cannot find module './garde-counter' » ou export manquant).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/garde-counter.ts
// Compte, par jour, le nombre de médecins par poste et vérifie les postes de base.
// Ne lit QUE la grille + les jours (identique en brouillon, en publié et à l'export).
// La logique de contrôle reproduit le bloc « Self-check » de src/engine/planning.ts.

export const POST_ROWS = [
  'G1', 'G2', 'RS', 'S', 'CS1', 'CS2', 'BM', 'Ped', 'MM', 'MS', 'ACU', 'U', 'P', 'HC',
] as const;

export type CounterDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };

export type PostCounter = {
  posts: readonly string[];
  days: CounterDay[];
  counts: Record<number, Record<string, number>>;
  working: Record<number, number>;
  flagged: Record<number, Set<string>>;
  reason: Record<number, string>;
};

const PED_DAYS = new Set([0, 2, 3, 4]); // lun, mer, jeu, ven (Monday = 0)
const NON_WORKING_MAIN = new Set(['', 'CA', 'ABS', 'U']); // ne comptent pas comme travaillants

// Décompose 'ACU+G2' → { main: 'ACU', evening: 'G2' } ; 'G1' → { main: 'G1', evening: undefined }.
function split(raw: string | undefined): { main: string; evening: string | undefined } {
  const [main, evening] = raw ? raw.split('+') : ['', undefined];
  return { main: main ?? '', evening };
}

export function computePostCounter(
  grid: Record<string, Record<number, string>>,
  days: CounterDay[],
): PostCounter {
  const doctors = Object.keys(grid);
  const counts: Record<number, Record<string, number>> = {};
  const working: Record<number, number> = {};
  const flagged: Record<number, Set<string>> = {};
  const reason: Record<number, string> = {};

  for (const cd of days) {
    const day = cd.day;
    const c: Record<string, number> = {};
    for (const p of POST_ROWS) c[p] = 0;
    let work = 0;

    for (const doc of doctors) {
      const { main, evening } = split(grid[doc]?.[day]);
      if (main && main in c) c[main] += 1;        // poste de jour (dont G1/G2 pure)
      if (evening === 'G1' || evening === 'G2') c[evening] += 1; // garde du soir
      if (!NON_WORKING_MAIN.has(main)) work += 1;  // RS/HC/S/... comptent ; U/CA/ABS/'' non
    }

    counts[day] = c;
    working[day] = work;

    // Contrôle des postes de base.
    const miss = new Set<string>();
    if (c.G1 !== 1) miss.add('G1');
    if (c.G2 !== 1) miss.add('G2');
    if (!cd.isWeekend && !cd.isHoliday && work >= 8) {
      if (c.S < 1) miss.add('S');
      if (work >= 9) {
        if (c.CS1 < 1) miss.add('CS1');
        if (c.CS2 < 1) miss.add('CS2');
      } else if (c.CS1 + c.CS2 < 1) {
        miss.add('CS');
      }
      if (PED_DAYS.has(cd.weekday)) {
        if (c.Ped < 1) miss.add('Ped');
      } else if (c.Ped > 0) {
        miss.add('Ped un mardi (interdit)');
      }
      if (c.BM + c.Ped < 2) miss.add('2 blocs (BM/Ped)');
    }

    flagged[day] = miss;
    reason[day] = miss.size
      ? `${[...miss].join(', ')} (${work} travaillants)`
      : '';
  }

  return { posts: POST_ROWS, days, counts, working, flagged, reason };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- garde-counter`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/garde-counter.ts src/lib/garde-counter.test.ts
git commit -m "feat: module de calcul du compteur des postes"
```

---

### Task 2: Mois courant par défaut sur la page admin

**Files:**
- Modify: `src/app/admin/AdminClient.tsx:44-45`

**Interfaces:**
- Consumes: rien.
- Produces: rien (comportement UI).

- [ ] **Step 1: Remplacer les valeurs en dur par le mois courant**

Dans `src/app/admin/AdminClient.tsx`, remplacer :

```js
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
```

par :

```js
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
```

- [ ] **Step 2: Vérifier la compilation / le lint**

Run: `npm run lint`
Expected: aucune erreur nouvelle.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/AdminClient.tsx
git commit -m "fix: page admin ouvre sur le mois courant"
```

---

### Task 3: Composant `PostCounterTable` + insertion dans la page

**Files:**
- Create: `src/components/PostCounterTable.tsx`
- Modify: `src/app/admin/AdminClient.tsx` (imports + les deux blocs `draft` et `publishedPlanning`)

**Interfaces:**
- Consumes: `computePostCounter`, `POST_ROWS`, `type CounterDay`, `type PostCounter` de `@/lib/garde-counter` ; `WEEKDAYS_FR` de `@/lib/store`.
- Produces: `export default function PostCounterTable({ days, grid }: { days: CounterDay[]; grid: Record<string, Record<number, string>> })`.

- [ ] **Step 1: Créer le composant**

```tsx
// src/components/PostCounterTable.tsx
// Matrice postes × jours : nombre de médecins par poste, contrôle et motif.
// Aligne ses colonnes-jours sous le PlanningGrid.
import { WEEKDAYS_FR } from '@/lib/store';
import { computePostCounter, type CounterDay } from '@/lib/garde-counter';

export default function PostCounterTable({
  days, grid,
}: {
  days: CounterDay[];
  grid: Record<string, Record<number, string>>;
}) {
  const pc = computePostCounter(grid, days);
  const flaggedDays = days.filter((d) => pc.flagged[d.day].size > 0);

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">Compteur des postes</h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="border-collapse text-center text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Poste</th>
              {days.map((d) => (
                <th key={d.day} className={`min-w-[40px] border-b border-gray-200 px-1 py-1 ${d.isWeekend || d.isHoliday ? 'bg-amber-100' : 'bg-gray-50'}`}>
                  <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                  <div className="font-semibold">{d.day}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pc.posts.map((post) => (
              <tr key={post}>
                <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium">{post}</td>
                {days.map((d) => {
                  const n = pc.counts[d.day][post] ?? 0;
                  const bad = pc.flagged[d.day].has(post) || (post === 'CS1' || post === 'CS2' ? pc.flagged[d.day].has('CS') : false);
                  const grey = d.isWeekend || d.isHoliday;
                  return (
                    <td key={d.day} className={`h-8 border border-gray-100 px-0.5 align-middle ${bad ? 'bg-red-200 font-bold text-red-800' : grey ? 'bg-gray-50' : ''}`}>
                      {n || ''}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-gray-300">
              <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-semibold">Travaillants</td>
              {days.map((d) => (
                <td key={d.day} className="h-8 border border-gray-100 px-0.5 align-middle text-gray-600">{pc.working[d.day]}</td>
              ))}
            </tr>
            <tr>
              <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-semibold">Contrôle</td>
              {days.map((d) => {
                const ok = pc.flagged[d.day].size === 0;
                return (
                  <td key={d.day} title={ok ? '' : pc.reason[d.day]} className={`h-8 border border-gray-100 px-0.5 align-middle ${ok ? 'text-green-600' : 'bg-red-200 text-red-800'}`}>
                    {ok ? '✓' : '✗'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {flaggedDays.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-red-800">
          {flaggedDays.map((d) => (
            <li key={d.day}>Jour {d.day} : {pc.reason[d.day]}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Importer le composant dans `AdminClient.tsx`**

Ajouter près des autres imports de composants (à côté de `import PlanningGrid ...`) :

```tsx
import PostCounterTable from '@/components/PostCounterTable';
```

- [ ] **Step 3: Insérer le tableau dans le bloc brouillon (draft)**

Dans `src/app/admin/AdminClient.tsx`, entre le `PlanningGrid` et le `EquityTable` du brouillon, remplacer :

```tsx
            <PlanningGrid days={draft.days} grid={draft.grid} doctors={active.map((d) => d.name)} />
            <EquityTable equity={draft.gardeEquity} doctors={active.map((d) => d.name)} />
```

par :

```tsx
            <PlanningGrid days={draft.days} grid={draft.grid} doctors={active.map((d) => d.name)} />
            <PostCounterTable days={draft.days} grid={draft.grid} />
            <EquityTable equity={draft.gardeEquity} doctors={active.map((d) => d.name)} />
```

- [ ] **Step 4: Insérer le tableau dans le bloc publié (publishedPlanning)**

Remplacer :

```tsx
            <PlanningGrid days={publishedPlanning.days} grid={publishedPlanning.grid} doctors={publishedDoctors(publishedPlanning)} />
            {publishedPlanning.garde_equity && <EquityTable equity={publishedPlanning.garde_equity} doctors={publishedDoctors(publishedPlanning)} />}
```

par :

```tsx
            <PlanningGrid days={publishedPlanning.days} grid={publishedPlanning.grid} doctors={publishedDoctors(publishedPlanning)} />
            <PostCounterTable days={publishedPlanning.days} grid={publishedPlanning.grid} />
            {publishedPlanning.garde_equity && <EquityTable equity={publishedPlanning.garde_equity} doctors={publishedDoctors(publishedPlanning)} />}
```

(Le bloc « aperçu vide » reste inchangé — pas de compteur.)

- [ ] **Step 5: Vérifier lint + build**

Run: `npm run lint`
Expected: aucune erreur nouvelle.

- [ ] **Step 6: Commit**

```bash
git add src/components/PostCounterTable.tsx src/app/admin/AdminClient.tsx
git commit -m "feat: tableau compteur des postes sous le planning (page admin)"
```

---

### Task 4: Extraire le rendu dans `render.ts` + compteur/équité empilés dans le CSV

**Files:**
- Create: `src/app/api/plannings/export/render.ts` (extraction du rendu pur, testable sans `next/headers`/DB)
- Modify: `src/app/api/plannings/export/route.ts` (déléguer à `render.ts`)
- Test: `src/app/api/plannings/export/render.test.ts`

**Interfaces:**
- Consumes: `computePostCounter`, `POST_ROWS` de `@/lib/garde-counter` ; `PlanningRow` de `@/lib/plannings` ; `planningCell`, `PlanningCell` de `@/lib/planning-cell` ; `MONTHS_FR`, `WEEKDAYS_FR` de `@/lib/store` ; `ExcelJS`.
- Produces (dans `render.ts`) :
  - `export function toCsv(planning: PlanningRow, doctors: string[]): string`
  - `export async function toXlsx(planning: PlanningRow, doctors: string[], year: number, month: number): Promise<Uint8Array>`

- [ ] **Step 1: Créer `render.ts` en déplaçant le rendu existant depuis `route.ts`**

Créer `src/app/api/plannings/export/render.ts` et y **déplacer tel quel** depuis `route.ts` (couper de `route.ts`, coller ici) : le `type Equity`, les constantes `GREY_FILL`, `RED`, `ABSENT`, `ANNOT_FONT`, `GARDE_ANNOT_FONT`, et les fonctions `isGarde`, `csvCell`, `setDayCell`, `toCsv`, `toXlsx`. Ajouter en tête de `render.ts` les imports nécessaires :

```ts
import ExcelJS from 'exceljs';
import type { PlanningRow } from '@/lib/plannings';
import { MONTHS_FR, WEEKDAYS_FR } from '@/lib/store';
import { planningCell, type PlanningCell } from '@/lib/planning-cell';
import { computePostCounter, POST_ROWS } from '@/lib/garde-counter';
```

Marquer `export` sur `toCsv` et `toXlsx`. À ce stade `toXlsx` reste identique (elle sera modifiée en Task 5).

- [ ] **Step 2: Alléger `route.ts` pour déléguer à `render.ts`**

Dans `route.ts`, supprimer les imports/constantes/fonctions déplacés et importer le rendu :

```ts
import { getSession } from '@/lib/auth';
import { getPublished } from '@/lib/plannings';
import { MONTHS_FR } from '@/lib/store';
import { toCsv, toXlsx } from './render';

export const runtime = 'nodejs';
```

Le corps de `GET` reste inchangé (il appelle déjà `toCsv(planning, doctors)` et `toXlsx(planning, doctors, year, month)`).

- [ ] **Step 3: Write the failing test**

```ts
// src/app/api/plannings/export/render.test.ts
import { describe, it, expect } from 'vitest';
import { toCsv } from './render';
import type { PlanningRow } from '@/lib/plannings';

const planning: PlanningRow = {
  year: 2026, month: 8,
  grid: {
    A: { 1: 'G1' }, B: { 1: 'G2' }, C: { 1: 'S' }, D: { 1: 'CS1' }, E: { 1: 'CS2' },
    F: { 1: 'BM' }, G: { 1: 'Ped' }, H: { 1: 'HC' }, I: { 1: 'HC' },
  },
  days: [{ day: 1, weekday: 0, isWeekend: false, isHoliday: false }],
  garde_equity: { count: { A: 1 }, weekendCount: {}, heavyCount: {}, spread: 0 },
};

describe('toCsv', () => {
  it('stacks planning, post counter and equity in a single file', () => {
    const doctors = Object.keys(planning.grid).sort();
    const csv = toCsv(planning, doctors);
    expect(csv).toContain('Compteur des postes');
    expect(csv).toContain('Travaillants');
    expect(csv).toContain('Contrôle');
    expect(csv).toContain('Équité');
    expect(csv.indexOf('Médecin')).toBeLessThan(csv.indexOf('Compteur des postes'));
    expect(csv.indexOf('Compteur des postes')).toBeLessThan(csv.indexOf('Équité'));
  });

  it('marks a missing base post with "!" in the counter block', () => {
    const bad: PlanningRow = {
      ...planning,
      grid: { A: { 1: 'G1' }, B: { 1: 'G2' }, C: { 1: 'BM' }, D: { 1: 'Ped' }, E: { 1: 'HC' }, F: { 1: 'HC' }, G: { 1: 'HC' }, H: { 1: 'HC' } },
    };
    const csv = toCsv(bad, Object.keys(bad.grid).sort());
    expect(csv).toMatch(/S;0!/); // ligne du poste S : 0 en défaut → "0!"
    expect(csv).toContain('Jour 1');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- render`
Expected: FAIL (le bloc « Compteur des postes » n'existe pas encore dans `toCsv`).

- [ ] **Step 5: Ajouter le compteur + l'équité empilés dans `toCsv`**

Dans `render.ts`, remplacer la fonction `toCsv` par :

```ts
// Séparateur ';' + BOM UTF-8 : Excel FR ouvre correctement sans ré-import manuel.
// Empile trois blocs dans un seul fichier : planning, compteur des postes, équité.
export function toCsv(planning: PlanningRow, doctors: string[]): string {
  const dayCols = planning.days.map((d) => `${WEEKDAYS_FR[d.weekday]} ${d.day}`);

  const header = ['Médecin', ...dayCols].join(';');
  const rows = doctors.map((doc) =>
    [doc, ...planning.days.map((d) => csvCell(d.weekday, planning.grid[doc]?.[d.day]))].join(';'),
  );

  const pc = computePostCounter(planning.grid, planning.days);
  const counterHeader = ['Compteur des postes', ...dayCols].join(';');
  const counterRows = POST_ROWS.map((post) =>
    [post, ...planning.days.map((d) => {
      const n = pc.counts[d.day][post] ?? 0;
      const bad = pc.flagged[d.day].has(post) || ((post === 'CS1' || post === 'CS2') && pc.flagged[d.day].has('CS'));
      return `${n}${bad ? '!' : ''}`;
    })].join(';'),
  );
  const workingRow = ['Travaillants', ...planning.days.map((d) => String(pc.working[d.day]))].join(';');
  const controlRow = ['Contrôle', ...planning.days.map((d) => (pc.flagged[d.day].size === 0 ? '✓' : '✗'))].join(';');
  const motifRows = planning.days
    .filter((d) => pc.flagged[d.day].size > 0)
    .map((d) => `Jour ${d.day} : ${pc.reason[d.day]}`);

  const equity = planning.garde_equity as Equity | null;
  const equityBlock = equity
    ? [
        ['Équité', 'Gardes', 'Week-ends', 'Jours pénibles'].join(';'),
        ...doctors.map((doc) => [doc, equity.count?.[doc] ?? 0, equity.weekendCount?.[doc] ?? 0, equity.heavyCount?.[doc] ?? 0].join(';')),
      ]
    : [];

  return [
    header,
    ...rows,
    '',
    counterHeader,
    ...counterRows,
    workingRow,
    controlRow,
    ...motifRows,
    '',
    ...equityBlock,
  ].join('\n');
}
```

Note : `Equity` a besoin de `count`/`weekendCount`/`heavyCount` optionnels — le type déplacé les déclare déjà `Record<string, number>` ; l'accès `equity.count?.[doc]` reste valide.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- render`
Expected: PASS.

- [ ] **Step 7: Vérifier lint**

Run: `npm run lint`
Expected: aucune erreur (imports inutilisés supprimés de `route.ts`).

- [ ] **Step 8: Commit**

```bash
git add src/app/api/plannings/export/render.ts src/app/api/plannings/export/route.ts src/app/api/plannings/export/render.test.ts
git commit -m "feat: rendu export extrait + compteur/équité empilés dans le CSV"
```

---

### Task 5: Excel une seule feuille — planning + compteur + équité empilés

**Files:**
- Modify: `src/app/api/plannings/export/render.ts` (fonction `toXlsx`)

**Interfaces:**
- Consumes: `computePostCounter`, `POST_ROWS` (déjà importés en Task 4), `Equity`, `GREY_FILL`, `setDayCell`, ExcelJS.
- Produces: `toXlsx` — une seule feuille : grille, ligne vide, compteur (postes + Travaillants + Contrôle + Motifs), ligne vide, équité. Cases en défaut remplies en rouge.

Pas de test unitaire ExcelJS (rendu binaire) ; la logique de contrôle est déjà couverte par Task 1 et le CSV par Task 4. Vérification manuelle en fin de tâche.

- [ ] **Step 1: Ajouter la constante de remplissage rouge**

Dans `render.ts`, près de `GREY_FILL` :

```ts
const RED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4B0B0' } } as const;
```

- [ ] **Step 2: Empiler compteur + équité dans la feuille principale**

Dans `toXlsx`, **supprimer** le bloc actuel qui crée une feuille séparée (`const equity = planning.garde_equity as Equity | null;` … `wb.addWorksheet('Équité')` … jusqu'à la fin de son `if (equity) { … }`), puis, juste après la boucle `for (const doc of doctors) { … }` qui remplit la grille, insérer :

```ts
  // Bloc compteur des postes, empilé sous la grille (mêmes colonnes-jours).
  const pc = computePostCounter(planning.grid, planning.days);
  sheet.addRow([]); // ligne vide
  const counterTitle = sheet.addRow(['Compteur des postes']);
  counterTitle.getCell(1).font = { bold: true };
  for (const post of POST_ROWS) {
    const row = sheet.addRow([post, ...planning.days.map((d) => pc.counts[d.day][post] ?? 0)]);
    row.getCell(1).font = { bold: true };
    planning.days.forEach((d, i) => {
      const bad = pc.flagged[d.day].has(post) || ((post === 'CS1' || post === 'CS2') && pc.flagged[d.day].has('CS'));
      if (bad) row.getCell(i + 2).fill = RED_FILL;
      else if (d.isWeekend || d.isHoliday) row.getCell(i + 2).fill = GREY_FILL;
    });
  }
  const workRow = sheet.addRow(['Travaillants', ...planning.days.map((d) => pc.working[d.day])]);
  workRow.getCell(1).font = { bold: true };
  const ctrlRow = sheet.addRow(['Contrôle', ...planning.days.map((d) => (pc.flagged[d.day].size === 0 ? '✓' : '✗'))]);
  ctrlRow.getCell(1).font = { bold: true };
  planning.days.forEach((d, i) => {
    if (pc.flagged[d.day].size > 0) ctrlRow.getCell(i + 2).fill = RED_FILL;
  });
  for (const d of planning.days) {
    if (pc.flagged[d.day].size > 0) sheet.addRow([`Jour ${d.day} : ${pc.reason[d.day]}`]);
  }

  // Bloc équité, empilé sous le compteur.
  const equity = planning.garde_equity as Equity | null;
  if (equity) {
    sheet.addRow([]); // ligne vide
    const eqTitle = sheet.addRow(['Équité', 'Gardes', 'Week-ends', 'Jours pénibles']);
    eqTitle.font = { bold: true };
    for (const doc of doctors) {
      sheet.addRow([doc, equity.count?.[doc] ?? 0, equity.weekendCount?.[doc] ?? 0, equity.heavyCount?.[doc] ?? 0]);
    }
  }
```

- [ ] **Step 3: Vérifier lint + build**

Run: `npm run lint && npm run build`
Expected: aucune erreur.

- [ ] **Step 4: Vérification manuelle de l'export**

Démarrer `npm run dev`, se connecter en admin, ouvrir un mois publié, cliquer « Excel (.xlsx) ». Vérifier : une seule feuille, grille en haut, compteur aligné dessous (cases en défaut en rouge), puis équité. Idem « CSV ».

- [ ] **Step 5: Commit**

```bash
git add src/app/api/plannings/export/render.ts
git commit -m "feat: export Excel en une feuille — planning + compteur + équité empilés"
```

---

### Task 6: Vérification finale

- [ ] **Step 1: Lancer toute la suite de tests**

Run: `npm test`
Expected: PASS (dont `garde-counter`, `export-csv`, et les tests existants du moteur).

- [ ] **Step 2: Lint + build complet**

Run: `npm run lint && npm run build`
Expected: aucune erreur.

- [ ] **Step 3: Contrôle visuel de la page admin**

`npm run dev` → `/admin` : la page s'ouvre sur le mois courant (août 2026) ; le compteur s'affiche sous le planning (brouillon et publié) et au-dessus de l'équité ; les jours en défaut sont en rouge avec motif.

## Notes de cohérence

- La logique de contrôle (`computePostCounter`) reproduit le bloc « Self-check » de `src/engine/planning.ts:598-619`. Si ce bloc évolue, le compteur doit être mis à jour en parallèle (les deux se veulent cohérents ; commentaire à laisser dans `garde-counter.ts`).
- Le motif est structurel (postes manquants + nombre de travaillants) car les avertissements détaillés du moteur ne sont pas persistés. Sur le brouillon, ces avertissements détaillés restent affichés dans le bandeau ambre existant.

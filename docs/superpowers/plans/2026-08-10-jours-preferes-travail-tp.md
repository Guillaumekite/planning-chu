# Jours préférés de travail (temps partiel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à l'admin et aux médecins à temps partiel de choisir, dans la page *Disponibilités*, les jours qu'ils souhaitent travailler (marqueur « TP ») ; le moteur honore ces jours et complète automatiquement jusqu'au quota du ratio TP.

**Architecture:** Nouveau marqueur booléen orthogonal `tp_work` sur la table `availability`, strictement calqué sur le marqueur `univ` existant (colonne DB → `getAvailability`/`setCell` → PUT `/api/availability` → brush dans `DispoClient`). À la génération, l'admin transforme ces jours en `tpPreferred` (comme `univConstraints`) et le moteur les injecte dans `computeTpDays` comme jours travaillés forcés (union avec les jours G+).

**Tech Stack:** Next.js 16 (App Router, route handlers `runtime = 'nodejs'`), TypeScript, PGlite/Postgres (SQL brut via `query`/`queryOne`), Zod, Vitest, Tailwind.

## Global Constraints

- **Ne jamais casser le comportement existant sans jour préféré** : `tpPreferred` absent/vide ⇒ répartition automatique actuelle identique (non-régression testée).
- **Idempotence DDL** : toute évolution de schéma via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` à la suite des existants dans `src/db/schema.ts`.
- **Le marqueur TP n'est pertinent que pour un médecin à temps partiel** (`fte < 1`) et sur un **jour de semaine** (le mécanisme de jours off TP ne concerne que la semaine).
- **Congé exclusif du TP** : un jour `conge` force `tp_work = false` (comme `univ`).
- **Dépassement honoré** : si les jours forcés dépassent le quota ratio, tous sont honorés + `warnings` le signale à l'admin.
- **G+ ⇒ présence** : pour un TP, un jour `souhait_garde` compte comme jour travaillé forcé.
- Vérifications transverses après chaque tâche touchant du TS : `npm run test`, puis `npx tsc --noEmit` et `npm run lint` pour les tâches UI.

---

### Task 1: Moteur — `computeTpDays` honore les jours travaillés forcés + avertissement de dépassement

**Files:**
- Modify: `src/engine/planning.ts` (interface `PlanningInput` ~L61-82 ; `computeTpDays` L116-140 ; bloc `tpDays` L155-160 ; `warnings` L225)
- Test: `src/engine/planning.test.ts`

**Interfaces:**
- Consumes: `PlanningInput`, `avail(input, doc, day)`, `PRESENT`, `pickEven`, `CalendarDay` (déjà présents dans `planning.ts`).
- Produces:
  - `PlanningInput.tpPreferred?: Record<DoctorId, number[]>` — par médecin TP, jours de semaine (1-based) souhaités travaillés.
  - `computeTpDays(days: CalendarDay[], isAvailWeekday: (day: number) => boolean, ratio: number, forced: Set<number>): Set<number>` — nouvelle signature (4e paramètre `forced`).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `src/engine/planning.test.ts` (helper `weekdaysOf` déjà défini en tête de fichier, L11) :

```ts
describe('solvePlanning — jours préférés de travail (temps partiel)', () => {
  it('un TP à 50 % travaille ses jours préférés et reste proche du ratio', async () => {
    const docs = doctors(11);
    const wd = weekdaysOf(2026, 4);
    const pref = [wd[0], wd[3]]; // deux jours de semaine choisis
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { fte: 0.5 } },
      tpPreferred: { D01: pref },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    // Les jours préférés sont travaillés (poste réel, pas une case vide/off).
    for (const day of pref) {
      const cell = res.grid.D01[day] ?? '';
      expect(cell.length).toBeGreaterThan(0);
      expect(['CA', 'ABS']).not.toContain(cell);
    }
    // Le nombre de jours de semaine travaillés reste ~50 % (tolérance large).
    const worked = wd.filter((d) => {
      const c = res.grid.D01[d] ?? '';
      return c.length > 0 && !['CA', 'ABS'].includes(c);
    }).length;
    expect(worked).toBeGreaterThanOrEqual(Math.round(0.5 * wd.length) - 1);
    expect(worked).toBeLessThanOrEqual(Math.round(0.5 * wd.length) + 2);
  });

  it('honore TOUS les jours préférés au-delà du quota et avertit l\'admin', async () => {
    const docs = doctors(11);
    const wd = weekdaysOf(2026, 4);
    const pref = wd.slice(0, wd.length - 1); // presque tous les jours de semaine, pour un TP à 50 %
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { fte: 0.5 } },
      tpPreferred: { D01: pref },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    for (const day of pref) {
      const cell = res.grid.D01[day] ?? '';
      expect(cell.length).toBeGreaterThan(0); // tous honorés
    }
    expect(res.warnings.some((w) => w.includes('D01') && w.includes('au-delà de son quota'))).toBe(true);
  });

  it('un jour G+ (souhait_garde) d\'un TP est forcé travaillé (jamais un jour off)', async () => {
    const docs = doctors(11);
    const wd = weekdaysOf(2026, 4);
    const gplus = wd[2];
    const res = await solvePlanning({
      year: 2026, month: 4, doctors: docs,
      profiles: { D01: { fte: 0.5 } },
      availability: { D01: { [gplus]: 'souhait_garde' } },
    });
    if (res.status !== 'feasible') throw new Error('expected feasible');
    const cell = res.grid.D01[gplus] ?? '';
    expect(cell.length).toBeGreaterThan(0);
    expect(['CA', 'ABS']).not.toContain(cell);
  });

  it('sans jour préféré, la répartition TP automatique est inchangée (non-régression)', async () => {
    const docs = doctors(11);
    const a = await solvePlanning({ year: 2026, month: 4, doctors: docs, profiles: { D01: { fte: 0.5 } } });
    const b = await solvePlanning({
      year: 2026, month: 4, doctors: docs, profiles: { D01: { fte: 0.5 } }, tpPreferred: {},
    });
    if (a.status !== 'feasible' || b.status !== 'feasible') throw new Error('expected feasible');
    expect(b.grid.D01).toEqual(a.grid.D01);
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `npm run test -- src/engine/planning.test.ts`
Expected: FAIL (au moins « au-delà de son quota » absent des warnings, et l'échec de compilation sur `tpPreferred` inconnu de `PlanningInput`).

- [ ] **Step 3: Ajouter `tpPreferred` à `PlanningInput`**

Dans `src/engine/planning.ts`, dans l'interface `PlanningInput` (après le bloc `univConstraints`, ~L76) :

```ts
  /**
   * Par médecin à temps partiel : jours de semaine (1-based) DÉCLARÉS comme souhaités
   * travaillés ("TP"). Ces jours (union avec les jours souhait_garde) sont TOUJOURS travaillés ;
   * le reste du quota (ratio) est complété automatiquement. Un dépassement du quota est honoré
   * et signalé dans `warnings`.
   */
  tpPreferred?: Record<DoctorId, number[]>;
```

- [ ] **Step 4: Étendre `computeTpDays` avec le paramètre `forced`**

Remplacer la fonction `computeTpDays` (L116-140) par :

```ts
function computeTpDays(
  days: CalendarDay[],
  isAvailWeekday: (day: number) => boolean,
  ratio: number,
  forced: Set<number>,
): Set<number> {
  const byWeek = new Map<number, number[]>();
  for (const cd of days) {
    if (cd.isWeekend || cd.isHoliday || !isAvailWeekday(cd.day)) continue;
    const weekId = cd.day - cd.weekday; // day-number of that week's Monday (unique per week)
    if (!byWeek.has(weekId)) byWeek.set(weekId, []);
    byWeek.get(weekId)!.push(cd.day);
  }
  const tp = new Set<number>();
  let credit = 0;
  for (const weekId of [...byWeek.keys()].sort((a, b) => a - b)) {
    const group = byWeek.get(weekId)!.sort((a, b) => a - b);
    credit += ratio * group.length;
    let work = Math.floor(credit + 0.5);
    work = Math.max(0, Math.min(group.length, work));
    // Forced working days (declared "TP" or souhait_garde) are ALWAYS worked; auto-fill the rest
    // up to the weekly target. Honoring more forced days than the target this week pushes the
    // credit negative → later weeks fill fewer days, keeping the month close to the ratio.
    const working = new Set(group.filter((d) => forced.has(d)));
    if (working.size < work) {
      const remaining = group.filter((d) => !working.has(d));
      for (const d of pickEven(remaining, work - working.size)) working.add(d);
    }
    credit -= working.size;
    for (const day of group) if (!working.has(day)) tp.add(day);
  }
  return tp;
}
```

- [ ] **Step 5: Construire `forcedWork` et alimenter `computeTpDays` + l'avertissement**

Remplacer le bloc `tpDays` (L153-160) par :

```ts
  // Part-time off days (TP): part-timers don't work every day — ~fte of their present weekdays,
  // in a 3/2-style weekly alternation. Days DECLARED "TP" (input.tpPreferred) or wished for a
  // garde (souhait_garde) are forced working; the rest of the quota is auto-filled. Off days get
  // no post and look like any day off.
  const tpPreferred = input.tpPreferred ?? {};
  const forcedWork: Record<DoctorId, Set<number>> = {};
  const tpWarnings: string[] = [];
  const tpDays: Record<DoctorId, Set<number>> = {};
  for (const doc of doctors) {
    if (fte[doc] >= 1) { forcedWork[doc] = new Set(); tpDays[doc] = new Set(); continue; }
    const pref = new Set(tpPreferred[doc] ?? []);
    const forced = new Set<number>();
    let availWeekdays = 0;
    for (const cd of days) {
      if (cd.isWeekend || cd.isHoliday || !PRESENT(avail(input, doc, cd.day))) continue;
      availWeekdays++;
      if (pref.has(cd.day) || avail(input, doc, cd.day) === 'souhait_garde') forced.add(cd.day);
    }
    forcedWork[doc] = forced;
    tpDays[doc] = computeTpDays(days, (day) => PRESENT(avail(input, doc, day)), fte[doc], forced);
    const target = Math.round(fte[doc] * availWeekdays);
    if (forced.size > target) {
      tpWarnings.push(
        `${doc} (TP ${Math.round(fte[doc] * 100)} %) : ${forced.size} jours souhaités travaillés ` +
          `au-delà de son quota (~${target}) — tous honorés.`,
      );
    }
  }
```

Puis, juste après `const warnings = [...gardes.warnings];` (~L225), ajouter :

```ts
  warnings.push(...tpWarnings);
```

- [ ] **Step 6: Lancer les tests, vérifier qu'ils passent**

Run: `npm run test -- src/engine/planning.test.ts`
Expected: PASS (tous les tests du fichier, y compris la régression `RS` existante).

- [ ] **Step 7: Vérifier le typage et commiter**

```bash
npx tsc --noEmit
git add src/engine/planning.ts src/engine/planning.test.ts
git commit -m "feat(engine): jours de travail forcés TP (tpPreferred + G+), auto-complétion au ratio"
```

---

### Task 2: Persistance — colonne `tp_work`, `getAvailability`, `setCell`, PUT `/api/availability`

**Files:**
- Modify: `src/db/schema.ts` (après le bloc `ALTER TABLE availability ... conge_note`, ~L60)
- Modify: `src/lib/availability.ts` (type export ~L14 ; `getAvailability` L16-42 ; `setCell` L107-130)
- Modify: `src/app/api/availability/route.ts` (`PutBody` L20-27 ; appel `setCell` L39)
- Test: `src/db/db.test.ts`

**Interfaces:**
- Consumes: `query`, `queryOne`, `ensureSchema`.
- Produces:
  - `getAvailability(...)` renvoie en plus `tpWork: TpWorkByName` (`Record<string, Record<number, boolean>>`).
  - `setCell(doctorId, year, month, day, state, univ = false, tpWork = false): Promise<void>` — nouveau 7e paramètre.

- [ ] **Step 1: Écrire le test de round-trip qui échoue**

Ajouter dans `src/db/db.test.ts`, à l'intérieur du `describe('database layer (PGlite)')`, un nouveau `it` :

```ts
  it('round-trips the tp_work marker on availability', async () => {
    const doc = await queryOne<{ id: number }>(`SELECT id FROM doctors WHERE name = 'FABRE'`);
    await query(
      `INSERT INTO availability (doctor_id, year, month, day, state, tp_work)
       VALUES ($1, 2026, 9, 12, 'dispo', true)
       ON CONFLICT (doctor_id, year, month, day)
       DO UPDATE SET state = EXCLUDED.state, tp_work = EXCLUDED.tp_work`,
      [doc!.id],
    );
    const av = await queryOne<{ state: string; tp_work: boolean }>(
      `SELECT state, tp_work FROM availability WHERE doctor_id = $1 AND year = 2026 AND month = 9 AND day = 12`,
      [doc!.id],
    );
    expect(av).toEqual({ state: 'dispo', tp_work: true });
  });
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `npm run test -- src/db/db.test.ts`
Expected: FAIL (colonne `tp_work` inexistante).

- [ ] **Step 3: Ajouter la colonne au schéma**

Dans `src/db/schema.ts`, juste après la ligne `ALTER TABLE availability ADD COLUMN IF NOT EXISTS conge_note text;` (~L60) :

```sql
-- "TP" : jour qu'un médecin à temps partiel souhaite travailler (marqueur orthogonal à `state`,
-- comme `univ`). Le moteur force ce jour en travaillé et complète le quota automatiquement.
ALTER TABLE availability ADD COLUMN IF NOT EXISTS tp_work boolean NOT NULL DEFAULT false;
```

- [ ] **Step 4: Exposer `tpWork` dans `getAvailability`**

Dans `src/lib/availability.ts` :

Ajouter le type export après `UnivByName` (~L14) :

```ts
/** doctor name → (day → true) for declared part-time preferred working days ("TP"). */
export type TpWorkByName = Record<string, Record<number, boolean>>;
```

Étendre la signature de retour de `getAvailability` (L20) — ajouter `tpWork: TpWorkByName` à l'objet retourné :

```ts
): Promise<{ availability: AvailabilityByName; congeStatus: CongeStatusByName; congeNote: CongeNoteByName; univ: UnivByName; tpWork: TpWorkByName }> {
```

Ajouter `a.tp_work` au SELECT et au type de ligne (L25-28) :

```ts
  const rows = await query<{ name: string; day: number; state: AvailState; conge_status: string | null; conge_note: string | null; univ: boolean; tp_work: boolean }>(
    `SELECT d.name, a.day, a.state, a.conge_status, a.conge_note, a.univ, a.tp_work
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE ${where}`,
    params,
  );
```

Déclarer et remplir `tpWork`, puis le retourner (L34-41) :

```ts
  const univ: UnivByName = {};
  const tpWork: TpWorkByName = {};
  for (const r of rows) {
    (availability[r.name] ??= {})[r.day] = r.state;
    if (r.conge_status) (congeStatus[r.name] ??= {})[r.day] = r.conge_status;
    if (r.conge_note) (congeNote[r.name] ??= {})[r.day] = r.conge_note;
    if (r.univ) (univ[r.name] ??= {})[r.day] = true;
    if (r.tp_work) (tpWork[r.name] ??= {})[r.day] = true;
  }
  return { availability, congeStatus, congeNote, univ, tpWork };
```

- [ ] **Step 5: Gérer `tpWork` dans `setCell`**

Remplacer `setCell` (L107-130). Le commentaire d'entête (L101-106) reste valable ; ajuster le corps :

```ts
export async function setCell(
  doctorId: number,
  year: number,
  month: number,
  day: number,
  state: AvailState,
  univ = false,
  tpWork = false,
): Promise<void> {
  await ensureSchema();
  const effectiveUniv = state === 'conge' ? false : univ;
  // A congé day can't also be a requested working day.
  const effectiveTp = state === 'conge' ? false : tpWork;
  if (state === 'dispo' && !effectiveUniv && !effectiveTp) {
    await query(`DELETE FROM availability WHERE doctor_id = $1 AND year = $2 AND month = $3 AND day = $4`,
      [doctorId, year, month, day]);
    return;
  }
  const congeStatus = state === 'conge' ? 'pending' : null;
  await query(
    `INSERT INTO availability (doctor_id, year, month, day, state, conge_status, univ, tp_work)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (doctor_id, year, month, day)
     DO UPDATE SET state = EXCLUDED.state, conge_status = EXCLUDED.conge_status, univ = EXCLUDED.univ, tp_work = EXCLUDED.tp_work`,
    [doctorId, year, month, day, state, congeStatus, effectiveUniv, effectiveTp],
  );
}
```

- [ ] **Step 6: Accepter `tpWork` dans le PUT `/api/availability`**

Dans `src/app/api/availability/route.ts` :

`PutBody` (L20-27) — ajouter `tpWork` :

```ts
const PutBody = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  state: z.enum(['dispo', 'souhait_garde', 'no_garde', 'conge']),
  univ: z.boolean().optional(),
  tpWork: z.boolean().optional(),
  doctorId: z.number().int().optional(),
});
```

Appel `setCell` (L39) :

```ts
  await setCell(doctorId, parsed.data.year, parsed.data.month, parsed.data.day, parsed.data.state, parsed.data.univ ?? false, parsed.data.tpWork ?? false);
```

- [ ] **Step 7: Lancer le test, vérifier qu'il passe**

Run: `npm run test -- src/db/db.test.ts`
Expected: PASS

- [ ] **Step 8: Vérifier le typage et commiter**

```bash
npx tsc --noEmit
git add src/db/schema.ts src/lib/availability.ts src/app/api/availability/route.ts src/db/db.test.ts
git commit -m "feat(availability): colonne tp_work, lecture/écriture (setCell, getAvailability, PUT)"
```

---

### Task 3: API génération — transmettre `tpPreferred` au moteur

**Files:**
- Modify: `src/app/api/generate/route.ts` (`BodySchema` L24-34 ; appel `solvePlanning` L73-86)

**Interfaces:**
- Consumes: `solvePlanning` (Task 1 : `PlanningInput.tpPreferred`), `BodySchema`.
- Produces: la route accepte `tpPreferred?: Record<string, number[]>` et le transmet à `solvePlanning`.

- [ ] **Step 1: Ajouter `tpPreferred` au `BodySchema`**

Dans `src/app/api/generate/route.ts`, dans `BodySchema` (après `univConstraints`, ~L33) :

```ts
  tpPreferred: z.record(z.string(), z.array(z.number().int().min(1).max(31))).optional(),
```

- [ ] **Step 2: Transmettre `tpPreferred` à `solvePlanning`**

Dans l'appel `solvePlanning({ ... })` (L73-86), ajouter après `univConstraints: input.univConstraints,` :

```ts
      tpPreferred: input.tpPreferred,
```

- [ ] **Step 3: Vérifier le typage**

Run: `npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 4: Sanity check moteur (les tests restent verts)**

Run: `npm run test`
Expected: PASS (aucune régression).

- [ ] **Step 5: Commiter**

```bash
git add src/app/api/generate/route.ts
git commit -m "feat(api): /api/generate accepte et transmet tpPreferred au moteur"
```

---

### Task 4: UI Admin — construire `tpPreferred` à la génération

**Files:**
- Modify: `src/app/admin/AdminClient.tsx` (`generate()` L122-162 ; bloc `univConstraints` L129-133 ; corps du POST L156)

**Interfaces:**
- Consumes: `GET /api/availability` (renvoie `tpWork` depuis Task 2), `POST /api/generate` (accepte `tpPreferred` depuis Task 3).
- Produces: le POST `/api/generate` inclut `tpPreferred: Record<string, number[]>`.

- [ ] **Step 1: Construire `tpPreferred` depuis `availData.tpWork`**

Dans `generate()`, juste après le bloc qui construit `univConstraints` (après L133) :

```ts
    // Declared part-time preferred working days per doctor (from the orthogonal `tp_work` layer).
    const tpPreferred: Record<string, number[]> = {};
    for (const [name, perDay] of Object.entries((availData.tpWork ?? {}) as Record<string, Record<string, boolean>>)) {
      const tDays = Object.entries(perDay).filter(([, v]) => v).map(([d]) => Number(d));
      if (tDays.length) tpPreferred[name] = tDays;
    }
```

- [ ] **Step 2: Inclure `tpPreferred` dans le corps du POST**

Dans le `body: JSON.stringify({ ... })` de l'appel `fetch('/api/generate', ...)` (L156), ajouter `tpPreferred` :

```ts
        body: JSON.stringify({ year, month, doctors: active.map((d) => d.name), availability, profiles, univConstraints, tpPreferred, holidays: parseDays(holidays), acupuncture: acuOn }),
```

- [ ] **Step 3: Vérifier typage + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: aucune erreur.

- [ ] **Step 4: Commiter**

```bash
git add src/app/admin/AdminClient.tsx
git commit -m "feat(admin): envoie les jours préférés TP (tpPreferred) à la génération"
```

---

### Task 5: UI Disponibilités — brush « TP » (admin + médecins à temps partiel)

**Files:**
- Modify: `src/app/disponibilites/DispoClient.tsx` (type `Doc` L10 ; `Brush` L16 ; états L26-28 ; fetch doctors L31-37 ; `loadAvail` L39-47 ; `dirty` L51 ; helpers L52-56 ; `cellLook` L58-74 ; `apply` L95-112 ; `save` L121-147 ; palette L174-188 ; légende L259-264)

**Interfaces:**
- Consumes: `GET /api/availability` (`tpWork`), `PUT /api/availability` (`tpWork`), `GET /api/doctors` (`part_time`).
- Produces: aucune interface consommée ailleurs (feuille de l'arbre).

- [ ] **Step 1: Étendre le type `Doc` et le mapping doctors (partTime)**

Type `Doc` (L10) :

```ts
type Doc = { id: number; name: string; universitaire: boolean; partTime: boolean };
```

Type local `TpWork` à côté de `UnivMap` (après L14) :

```ts
type TpMap = Record<string, Record<number, boolean>>;
```

`Brush` (L16-17) :

```ts
/** The garde-preference palette states plus the orthogonal "univ" / "tp" brushes. */
type Brush = Availability | 'univ' | 'tp';
```

Mapping dans le `fetch('/api/doctors')` (L32-36) :

```ts
    fetch('/api/doctors').then((r) => (r.ok ? r.json() : { doctors: [] })).then((d) => {
      const all: Doc[] = (d.doctors ?? []).map((x: { id: number; name: string; universitaire?: boolean; part_time?: boolean }) =>
        ({ id: x.id, name: x.name, universitaire: !!x.universitaire, partTime: !!x.part_time }));
      setDoctors(isAdmin ? all : all.filter((x) => x.id === doctorId));
    });
```

- [ ] **Step 2: Ajouter les états TP et leur chargement**

Après `const [pendingUniv, setPendingUniv] = useState<UnivMap>({});` (L27) :

```ts
  const [savedTp, setSavedTp] = useState<TpMap>({});
  const [pendingTp, setPendingTp] = useState<TpMap>({});
```

Dans `loadAvail` (L43-45), après la ligne `setSavedUniv(...)` :

```ts
      setSavedTp(d.tpWork ?? {}); setPendingTp(d.tpWork ?? {});
```

`dirty` (L51) — inclure TP :

```ts
  const dirty = JSON.stringify(saved) !== JSON.stringify(pending)
    || JSON.stringify(savedUniv) !== JSON.stringify(pendingUniv)
    || JSON.stringify(savedTp) !== JSON.stringify(pendingTp);
```

Helper `tpOf` + `hasPartTime`, après `univOf` (L53-56) :

```ts
  const tpOf = (name: string, day: number): boolean => !!pendingTp[name]?.[day];
  // The TP brush is offered to the admin always (discoverable) and to a doctor only when at least
  // one part-timer exists — exactly like the Univ brush for universitaire doctors.
  const hasPartTime = isAdmin || doctors.some((d) => d.partTime);
```

- [ ] **Step 3: Afficher le marqueur TP dans `cellLook`**

Dans `cellLook` (L58-74), après la ligne calculant `u` et avant le `return` final, remplacer la fin de la fonction par :

```ts
    const u = univOf(name, day) && st !== 'conge'; // congé can't also be a fac day
    const tp = tpOf(name, day) && st !== 'conge'; // congé can't also be a requested working day
    let base: { label: string; cls: string };
    if (st === 'conge') {
      const status = conge[name]?.[day];
      if (status === 'approved') base = { label: 'Congé', cls: 'bg-green-300 text-green-900' };
      else if (status === 'refused') base = { label: 'Congé', cls: 'bg-red-300 text-red-900 line-through' };
      else base = { label: AVAIL_INFO[st].label, cls: AVAIL_INFO[st].cls };
    } else {
      base = { label: AVAIL_INFO[st].label, cls: AVAIL_INFO[st].cls };
    }
    // Orthogonal markers: keep the garde-preference background, add a ring. Label priority when a
    // cell has no garde label: garde > TP > U. TP = emerald ring; Univ = indigo ring.
    const rings = `${tp ? ' ring-2 ring-inset ring-emerald-500' : ''}${u ? ' ring-2 ring-inset ring-indigo-500' : ''}`;
    if (tp || u) {
      const fallback = tp ? 'TP' : 'U';
      return { label: base.label || fallback, cls: `${base.cls}${rings}` };
    }
    return base;
```

(Supprimer l'ancien bloc `const u = ...` / `if (u) return ...` d'origine ; il est remplacé ci-dessus.)

- [ ] **Step 4: Peindre le marqueur TP dans `apply`**

Dans `apply` (L95-112), après le bloc `if (brush === 'univ') { ... }` et avant `setPending((p) => {` :

```ts
    if (brush === 'tp') {
      // TP days are only meaningful for part-time doctors — ignore clicks on other rows.
      if (!doctors.find((d) => d.name === name)?.partTime) return;
      setPendingTp((p) => {
        const row = { ...(p[name] ?? {}) };
        if (row[day]) delete row[day]; else row[day] = true;
        return { ...p, [name]: row };
      });
      return;
    }
```

- [ ] **Step 5: Enregistrer les changements TP dans `save`**

Dans `save` (L121-147) :

L'ensemble `names` (L122-124) — ajouter les clés TP :

```ts
    const names = new Set([
      ...Object.keys(saved), ...Object.keys(pending), ...Object.keys(savedUniv), ...Object.keys(pendingUniv),
      ...Object.keys(savedTp), ...Object.keys(pendingTp),
    ]);
```

Le type de `changes` (L125) :

```ts
    const changes: { name: string; day: number; state: Availability; univ: boolean; tpWork: boolean }[] = [];
```

Dans la boucle (L127-136), ajouter les maps TP et la comparaison :

```ts
      const a = saved[name] ?? {}; const b = pending[name] ?? {};
      const su = savedUniv[name] ?? {}; const pu = pendingUniv[name] ?? {};
      const st = savedTp[name] ?? {}; const pt = pendingTp[name] ?? {};
      const dayset = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(su), ...Object.keys(pu), ...Object.keys(st), ...Object.keys(pt)].map(Number));
      for (const day of dayset) {
        const beforeState = a[day] ?? 'dispo'; const afterState = b[day] ?? 'dispo';
        const beforeUniv = !!su[day]; const afterUniv = !!pu[day];
        const beforeTp = !!st[day]; const afterTp = !!pt[day];
        if (beforeState !== afterState || beforeUniv !== afterUniv || beforeTp !== afterTp) {
          changes.push({ name, day, state: afterState, univ: afterUniv, tpWork: afterTp });
        }
      }
```

Le corps du PUT (L140-143) :

```ts
      await fetch('/api/availability', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, day: c.day, state: c.state, univ: c.univ, tpWork: c.tpWork, doctorId: isAdmin ? id : undefined }),
      });
```

- [ ] **Step 6: Ajouter le bouton palette et la légende TP**

Bouton palette — après le bloc `{hasUniversitaire && ( ... )}` (L182-187), ajouter :

```tsx
        {hasPartTime && (
          <button onClick={() => setBrush('tp')}
            className={`rounded px-3 py-1.5 text-sm text-emerald-700 ${brush === 'tp' ? 'bg-emerald-100 ring-2 ring-blue-500' : 'bg-white ring-2 ring-inset ring-emerald-400'}`}>
            TP — Jour souhaité travaillé (temps partiel)
          </button>
        )}
```

Légende — après le bloc `{hasUniversitaire && ( ... )}` de bas de page (L259-264), ajouter :

```tsx
      {hasPartTime && (
        <p className="mt-1 text-sm text-gray-500">
          <span className="rounded px-1 ring-2 ring-inset ring-emerald-500">TP</span> Jour qu&apos;un
          médecin à temps partiel souhaite travailler : marqueur indépendant (anneau émeraude). Le
          moteur force ces jours en travaillés et complète le reste automatiquement selon le ratio.
        </p>
      )}
```

- [ ] **Step 7: Vérifier typage + lint + build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: aucune erreur.

- [ ] **Step 8: Vérification manuelle (décrire, ne pas exécuter en CI)**

Lancer `npm run dev`, se connecter en admin, aller sur *Disponibilités* :
1. Un médecin à temps partiel existe → le bouton « TP » apparaît dans la palette.
2. Sélectionner le brush « TP », cliquer sur des jours de semaine de la ligne d'un TP → la case affiche « TP » (anneau émeraude) ; cliquer sur un G+ déjà posé → conserve « G+ » + anneau émeraude.
3. Cliquer sur la ligne d'un médecin non-TP avec le brush TP → aucun effet.
4. Enregistrer, recharger le mois → les marqueurs TP persistent.
5. Poser un congé sur un jour marqué TP puis enregistrer → le TP disparaît (congé exclusif).
6. Générer un planning : les jours marqués TP du médecin apparaissent travaillés (poste normal) ; si trop de jours sont marqués pour un TP, un avertissement « au-delà de son quota » s'affiche dans le résultat.

- [ ] **Step 9: Commiter**

```bash
git add src/app/disponibilites/DispoClient.tsx
git commit -m "feat(dispo): brush TP (jours préférés de travail temps partiel) admin + médecins TP"
```

---

## Self-Review

**Spec coverage :**
- Marqueur TP dans Disponibilités (admin + médecins TP) → Task 5. ✓
- Visibilité brush (admin toujours + médecin si TP) → Task 5 Step 2 (`hasPartTime`). ✓
- Colonne `tp_work` + persistance → Task 2. ✓
- Congé exclusif du TP → Task 2 Step 5 (`effectiveTp`). ✓
- Transmission à la génération (`tpPreferred`) → Tasks 3 & 4. ✓
- Jours forcés + auto-complétion au ratio → Task 1 Step 4. ✓
- Dépassement honoré + warning → Task 1 Step 5. ✓
- G+ ⇒ jour travaillé forcé → Task 1 Step 5 (`avail === 'souhait_garde'`). ✓
- Non-régression sans jour préféré → Task 1 Step 1 (4e test). ✓
- Planning affiche des postes normaux → aucun changement requis (un jour forcé travaillé reçoit un poste normal via les passes existantes) ; couvert par les assertions de Task 1 Steps 1-3.

**Placeholder scan :** aucun TBD/TODO ; tous les steps de code contiennent le code exact.

**Type consistency :** `tpPreferred: Record<DoctorId/string, number[]>` cohérent (moteur/route/admin) ; `setCell(..., univ, tpWork)` cohérent (lib + route) ; `tpWork`/`tp_work`/`tpPreferred`/`pendingTp`/`savedTp`/`hasPartTime`/`tpOf` cohérents ; `getAvailability` renvoie `tpWork` consommé par AdminClient (`availData.tpWork`) et DispoClient (`d.tpWork`).

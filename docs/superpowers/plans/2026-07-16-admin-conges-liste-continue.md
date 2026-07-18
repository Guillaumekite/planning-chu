# Liste continue des demandes de congé (admin) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le sélecteur Mois/Année de la page admin des congés par une liste continue de toutes les demandes à venir, tous mois confondus, avec gestion des congés à cheval sur deux mois.

**Architecture:** Extraire la logique pure (regroupement des jours en blocs par date calendaire réelle, plancher temporel, tri) dans un module testable `src/lib/congeRuns.ts`. `src/lib/availability.ts` fournit l'accès DB (requête sans paramètre de mois, validation multi-mois). L'API `/api/conge` et le composant `CongesClient.tsx` passent d'un modèle `(year, month, days[])` à un modèle `dates: {year,month,day}[]`.

**Tech Stack:** Next.js (App Router), TypeScript, Postgres (postgres.js en prod / PGlite en local), Vitest, Zod.

## Global Constraints

- Fuseau horaire de référence pour « aujourd'hui » : **Europe/Paris**.
- Plancher métier : garder tout congé dont la **date de fin du bloc** est ≥ (aujourd'hui − 7 jours).
- Comparaisons de dates portables (postgres.js ET PGlite) via entier `year*10000 + month*100 + day` en SQL, et via `Date.UTC` côté JS.
- Tri d'affichage : congé le plus proche (date de début la plus petite) en premier.
- Interface FR conservée, copie existante réutilisée.

---

### Task 1: Module pur `congeRuns.ts` (types + regroupement + plancher + tri)

**Files:**
- Create: `src/lib/congeRuns.ts`
- Test: `src/lib/congeRuns.test.ts`

**Interfaces:**
- Produces:
  - `type YMD = { year: number; month: number; day: number }`
  - `type CongeStatus = 'pending' | 'approved' | 'refused'`
  - `type CongeRun = { doctorId: number; name: string; start: YMD; end: YMD; length: number; dates: YMD[]; status: CongeStatus | 'mixed'; note: string | null }`
  - `type CongeDayRow = { doctorId: number; name: string; year: number; month: number; day: number; congeStatus: string | null; congeNote: string | null }`
  - `ymdToUTC(d: YMD): number`
  - `shiftDays(d: YMD, delta: number): YMD`
  - `encodeYMD(d: YMD): number`
  - `groupCongeRuns(rows: CongeDayRow[], floor: YMD): CongeRun[]` — rows pré-triés par (doctorId, date asc)

- [ ] **Step 1: Write the failing test** — `src/lib/congeRuns.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { groupCongeRuns, shiftDays, encodeYMD, type CongeDayRow } from './congeRuns';

const row = (doctorId: number, name: string, year: number, month: number, day: number, congeStatus: string | null = 'pending', congeNote: string | null = null): CongeDayRow =>
  ({ doctorId, name, year, month, day, congeStatus, congeNote });

describe('shiftDays / encodeYMD', () => {
  it('crosses month boundaries backwards', () => {
    expect(shiftDays({ year: 2026, month: 3, day: 5 }, -7)).toEqual({ year: 2026, month: 2, day: 26 });
  });
  it('crosses year boundaries', () => {
    expect(shiftDays({ year: 2026, month: 1, day: 3 }, -7)).toEqual({ year: 2025, month: 12, day: 27 });
  });
  it('encodes ordinally', () => {
    expect(encodeYMD({ year: 2026, month: 10, day: 1 })).toBe(20261001);
    expect(encodeYMD({ year: 2026, month: 9, day: 30 })).toBeLessThan(encodeYMD({ year: 2026, month: 10, day: 1 }));
  });
});

describe('groupCongeRuns', () => {
  const floor = { year: 2026, month: 7, day: 1 };

  it('groups consecutive days in the same month into one block', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(1, 'Alice', 2026, 7, 6), row(1, 'Alice', 2026, 7, 7)], floor);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 7, day: 5 });
    expect(runs[0].end).toEqual({ year: 2026, month: 7, day: 7 });
    expect(runs[0].length).toBe(3);
  });

  it('groups a leave straddling two months into one block', () => {
    const rows = [
      row(1, 'Alice', 2026, 9, 28), row(1, 'Alice', 2026, 9, 29), row(1, 'Alice', 2026, 9, 30),
      row(1, 'Alice', 2026, 10, 1), row(1, 'Alice', 2026, 10, 2),
    ];
    const runs = groupCongeRuns(rows, floor);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 9, day: 28 });
    expect(runs[0].end).toEqual({ year: 2026, month: 10, day: 2 });
    expect(runs[0].length).toBe(5);
    expect(runs[0].dates).toHaveLength(5);
  });

  it('splits non-consecutive days into separate blocks', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(1, 'Alice', 2026, 7, 8)], floor);
    expect(runs).toHaveLength(2);
  });

  it('keeps different doctors in separate blocks even on adjacent days', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(2, 'Bob', 2026, 7, 6)], floor);
    expect(runs).toHaveLength(2);
  });

  it('marks a block mixed when its days have different statuses', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5, 'approved'), row(1, 'Alice', 2026, 7, 6, 'pending')], floor);
    expect(runs[0].status).toBe('mixed');
  });

  it('excludes a block entirely before the floor', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 6, 1), row(1, 'Alice', 2026, 6, 2)], floor);
    expect(runs).toHaveLength(0);
  });

  it('keeps a long ongoing block with its true start day (no truncation)', () => {
    // floor = 15 July; block 1–20 July ends after the floor → kept, start stays 1 July
    const f = { year: 2026, month: 7, day: 15 };
    const rows = Array.from({ length: 20 }, (_, i) => row(1, 'Alice', 2026, 7, i + 1));
    const runs = groupCongeRuns(rows, f);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 7, day: 1 });
    expect(runs[0].end).toEqual({ year: 2026, month: 7, day: 20 });
  });

  it('sorts blocks by soonest start first', () => {
    const rows = [row(1, 'Alice', 2026, 9, 10), row(2, 'Bob', 2026, 7, 20)];
    const runs = groupCongeRuns(rows, floor);
    expect(runs.map((r) => r.name)).toEqual(['Bob', 'Alice']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/congeRuns.test.ts`
Expected: FAIL (module `./congeRuns` not found).

- [ ] **Step 3: Write minimal implementation** — `src/lib/congeRuns.ts`

```ts
// Pure logic for the admin leave-request list: grouping consecutive days into
// calendar-accurate blocks, applying the "upcoming" floor, and sorting. No DB access.

export type YMD = { year: number; month: number; day: number };
export type CongeStatus = 'pending' | 'approved' | 'refused';

export type CongeRun = {
  doctorId: number;
  name: string;
  start: YMD;
  end: YMD;
  length: number;
  dates: YMD[];
  status: CongeStatus | 'mixed';
  note: string | null;
};

export type CongeDayRow = {
  doctorId: number;
  name: string;
  year: number;
  month: number;
  day: number;
  congeStatus: string | null;
  congeNote: string | null;
};

const DAY_MS = 86_400_000;

/** UTC epoch ms for a calendar date. UTC avoids any DST offset when comparing days. */
export const ymdToUTC = (d: YMD): number => Date.UTC(d.year, d.month - 1, d.day);

/** Shift a calendar date by whole days, crossing month/year boundaries correctly. */
export const shiftDays = (d: YMD, delta: number): YMD => {
  const t = new Date(ymdToUTC(d) + delta * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};

/** Ordinal integer for a date: 2026-10-01 -> 20261001. Matches the SQL expression. */
export const encodeYMD = (d: YMD): number => d.year * 10000 + d.month * 100 + d.day;

/**
 * Group per-day leave rows (pre-sorted by doctorId then date ascending) into
 * consecutive-day blocks per doctor, keep only blocks whose end date is >= floor,
 * and sort the result by soonest start first.
 */
export function groupCongeRuns(rows: CongeDayRow[], floor: YMD): CongeRun[] {
  const runs: CongeRun[] = [];
  let cur: CongeRun | null = null;
  let statuses = new Set<string>();
  let notes = new Set<string>();

  const flush = () => {
    if (cur) {
      cur.length = cur.dates.length;
      cur.end = cur.dates[cur.dates.length - 1];
      cur.status = statuses.size === 1 ? ([...statuses][0] as CongeStatus) : 'mixed';
      cur.note = notes.size ? [...notes].join(' ') : null;
      runs.push(cur);
    }
    cur = null;
    statuses = new Set();
    notes = new Set();
  };

  for (const r of rows) {
    const ymd: YMD = { year: r.year, month: r.month, day: r.day };
    const st = r.congeStatus ?? 'pending';
    const prev = cur ? cur.dates[cur.dates.length - 1] : null;
    const adjacent = cur && prev !== null && cur.doctorId === r.doctorId && ymdToUTC(ymd) === ymdToUTC(prev) + DAY_MS;
    if (adjacent) {
      cur!.dates.push(ymd);
    } else {
      flush();
      cur = { doctorId: r.doctorId, name: r.name, start: ymd, end: ymd, length: 1, dates: [ymd], status: 'pending', note: null };
    }
    statuses.add(st);
    if (r.congeNote) notes.add(r.congeNote);
  }
  flush();

  const floorT = ymdToUTC(floor);
  return runs
    .filter((run) => ymdToUTC(run.end) >= floorT)
    .sort((a, b) => ymdToUTC(a.start) - ymdToUTC(b.start) || a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/congeRuns.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/congeRuns.ts src/lib/congeRuns.test.ts
git commit -m "Congés admin: module pur de regroupement des blocs (multi-mois, plancher, tri)"
```

---

### Task 2: `availability.ts` — requête sans mois + validation multi-mois

**Files:**
- Modify: `src/lib/availability.ts` (remplace `listCongeRuns`, `setCongeStatus`, et les types `CongeStatus`/`CongeRun`)

**Interfaces:**
- Consumes: `groupCongeRuns`, `shiftDays`, `encodeYMD`, `YMD`, `CongeRun` from `./congeRuns`.
- Produces:
  - `listCongeRuns(): Promise<CongeRun[]>` (plus de paramètre)
  - `setCongeStatus(doctorId: number, dates: YMD[], status: CongeStatus, note?: string | null): Promise<void>`
  - re-export `type CongeRun`, `type CongeStatus`, `type YMD` from `./congeRuns` (pour les consommateurs existants).

- [ ] **Step 1: Replace the type declarations and `listCongeRuns`**

Remplacer le bloc actuel `export type CongeStatus = ...` … fin de `listCongeRuns` (≈ lignes 43–94) par :

```ts
export type { CongeRun, CongeStatus, YMD } from './congeRuns';
import { groupCongeRuns, shiftDays, encodeYMD, type CongeRun, type CongeStatus, type YMD } from './congeRuns';

/** Today's calendar date in the Europe/Paris timezone. */
function parisToday(): YMD {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // "YYYY-MM-DD"
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

/**
 * All upcoming leave requests, grouped into consecutive-day blocks, across every
 * month. A block is kept when its end date is >= (today - 7 days). The SQL prefilter
 * reaches 45 days further back so a long ongoing block keeps its true start day.
 */
export async function listCongeRuns(): Promise<CongeRun[]> {
  await ensureSchema();
  const floor = shiftDays(parisToday(), -7);
  const prefilter = shiftDays(floor, -45);
  const rows = await query<{ doctor_id: number; name: string; year: number; month: number; day: number; conge_status: string | null; conge_note: string | null }>(
    `SELECT a.doctor_id, d.name, a.year, a.month, a.day, a.conge_status, a.conge_note
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE a.state = 'conge' AND (a.year * 10000 + a.month * 100 + a.day) >= $1
     ORDER BY a.doctor_id, a.year, a.month, a.day`,
    [encodeYMD(prefilter)],
  );
  return groupCongeRuns(
    rows.map((r) => ({
      doctorId: r.doctor_id, name: r.name, year: r.year, month: r.month, day: r.day,
      congeStatus: r.conge_status, congeNote: r.conge_note,
    })),
    floor,
  );
}
```

- [ ] **Step 2: Replace `setCongeStatus`**

```ts
/**
 * Set the approval status on specific leave dates for a doctor. Dates may span
 * several months (a leave straddling a month boundary). An optional `note` is stored
 * only when refusing and non-empty; approving or resetting to pending clears it.
 */
export async function setCongeStatus(
  doctorId: number,
  dates: YMD[],
  status: CongeStatus,
  note?: string | null,
): Promise<void> {
  if (!dates.length) return;
  await ensureSchema();
  const cleanNote = status === 'refused' && note && note.trim() ? note.trim() : null;
  const encoded = dates.map(encodeYMD);
  const placeholders = encoded.map((_, i) => `$${i + 4}`).join(', ');
  await query(
    `UPDATE availability SET conge_status = $1, conge_note = $2
     WHERE doctor_id = $3 AND state = 'conge' AND (year * 10000 + month * 100 + day) IN (${placeholders})`,
    [status, cleanNote, doctorId, ...encoded],
  );
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no error from `availability.ts` (errors in `route.ts`/`CongesClient.tsx` are fixed in Tasks 3–4; run this again after those).

- [ ] **Step 4: Commit**

```bash
git add src/lib/availability.ts
git commit -m "Congés admin: listCongeRuns sans mois + setCongeStatus multi-mois"
```

---

### Task 3: API `/api/conge` — GET sans paramètres, PUT avec `dates`

**Files:**
- Modify: `src/app/api/conge/route.ts`

**Interfaces:**
- Consumes: `listCongeRuns()` (no args), `setCongeStatus(doctorId, dates, status, note)`.

- [ ] **Step 1: Update GET and the PUT body schema**

Remplacer le corps de `GET` et le `PutBody` :

```ts
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  return NextResponse.json({ runs: await listCongeRuns() });
}

const PutBody = z.object({
  doctorId: z.number().int(),
  dates: z.array(z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })).min(1),
  status: z.enum(['pending', 'approved', 'refused']),
  note: z.string().max(500).optional(),
});

export async function PUT(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { doctorId, dates, status, note } = parsed.data;
  await setCongeStatus(doctorId, dates, status, note);
  return NextResponse.json({ ok: true });
}
```

Supprimer l'import de `Request` inutile ? Non : `PUT(req: Request)` l'utilise encore. `GET` n'a plus de paramètre `req`.

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no error in `route.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/conge/route.ts
git commit -m "API congés: GET sans mois, PUT accepte des dates multi-mois"
```

---

### Task 4: `CongesClient.tsx` — liste continue, blocs multi-mois

**Files:**
- Modify: `src/app/admin/conges/CongesClient.tsx`

**Interfaces:**
- Consumes: `GET /api/conge` → `{ runs: Run[] }` où `Run = { doctorId, name, start: YMD, end: YMD, length, dates: YMD[], status, note }`; `PUT /api/conge` body `{ doctorId, dates, status, note? }`.

- [ ] **Step 1: Replace the component**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminNav from '@/components/AdminNav';
import { MONTHS_FR } from '@/lib/store';

type YMD = { year: number; month: number; day: number };
type Run = {
  doctorId: number; name: string; start: YMD; end: YMD;
  length: number; dates: YMD[]; status: 'pending' | 'approved' | 'refused' | 'mixed';
  note: string | null;
};

const runKey = (run: Run) => `${run.doctorId}-${run.start.year}-${run.start.month}-${run.start.day}`;

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'En attente', cls: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Validé', cls: 'bg-green-100 text-green-800' },
  refused: { label: 'Refusé', cls: 'bg-red-100 text-red-800' },
  mixed: { label: 'Mixte', cls: 'bg-gray-100 text-gray-700' },
};

const monthName = (m: number) => MONTHS_FR[m - 1].toLowerCase();

function fmt(run: Run) {
  const { start: s, end: e } = run;
  if (run.length === 1) return `le ${s.day} ${monthName(s.month)}`;
  if (s.year === e.year && s.month === e.month) return `du ${s.day} au ${e.day} ${monthName(s.month)} (${run.length} jours)`;
  return `du ${s.day} ${monthName(s.month)} au ${e.day} ${monthName(e.month)} (${run.length} jours)`;
}

export default function CongesClient() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [refusingKey, setRefusingKey] = useState<string | null>(null);
  const [refuseNote, setRefuseNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch('/api/conge');
    if (r.ok) setRuns((await r.json()).runs);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setStatus(run: Run, status: 'approved' | 'refused' | 'pending', note?: string) {
    await fetch('/api/conge', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorId: run.doctorId, dates: run.dates, status, note }),
    });
    setRefusingKey(null);
    setRefuseNote('');
    await load();
  }

  function startRefuse(run: Run) {
    setRefusingKey(runKey(run));
    setRefuseNote(run.note ?? '');
  }

  const pending = runs.filter((r) => r.status === 'pending' || r.status === 'mixed');
  const decided = runs.filter((r) => r.status === 'approved' || r.status === 'refused');

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Demandes de congé</h1>
        <AdminNav active="conges" />
      </div>
      <p className="mb-6 text-sm text-gray-500">Toutes les demandes à venir, de la plus proche à la plus lointaine. Valide ou refuse les congés demandés par les médecins.</p>

      {loading ? <p className="text-sm text-gray-400">Chargement…</p> : (
        <>
          <h2 className="mb-2 text-lg font-semibold">À traiter ({pending.length})</h2>
          {pending.length === 0 ? <p className="mb-6 text-sm text-gray-400">Aucune demande en attente.</p> : (
            <ul className="mb-8 space-y-2">
              {pending.map((run) => (
                <li key={runKey(run)} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{run.name}</span>
                      <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setStatus(run, 'approved')} className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700">Valider</button>
                      <button onClick={() => startRefuse(run)} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Refuser</button>
                    </div>
                  </div>
                  {refusingKey === runKey(run) && (
                    <div className="mt-3 rounded border border-red-200 bg-red-50 p-3">
                      <label className="mb-1 block text-sm font-medium text-red-800">Motif du refus (optionnel, visible par le médecin)</label>
                      <textarea
                        autoFocus rows={2} value={refuseNote} onChange={(e) => setRefuseNote(e.target.value)}
                        placeholder="Ex : effectif insuffisant cette semaine-là."
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => setStatus(run, 'refused', refuseNote)} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Confirmer le refus</button>
                        <button onClick={() => { setRefusingKey(null); setRefuseNote(''); }} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Annuler</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 text-lg font-semibold">Déjà traités ({decided.length})</h2>
          {decided.length === 0 ? <p className="text-sm text-gray-400">Rien pour l&apos;instant.</p> : (
            <ul className="space-y-2">
              {decided.map((run) => (
                <li key={runKey(run)} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{run.name}</span>
                      <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                    </div>
                    <button onClick={() => setStatus(run, 'pending')} className="text-xs text-gray-500 hover:text-blue-600">remettre en attente</button>
                  </div>
                  {run.status === 'refused' && run.note && (
                    <p className="mt-1 text-sm text-red-700"><span className="font-medium">Motif :</span> {run.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify types + lint + full test suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no type error, no lint error, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/conges/CongesClient.tsx
git commit -m "Congés admin: liste continue sans sélecteur de mois, blocs multi-mois"
```

---

## Self-Review notes

- Spec « suppression du sélecteur » → Task 4 (plus d'état year/month, plus de `<select>`).
- Spec « plancher au niveau du bloc » → Task 1 `groupCongeRuns` filtre sur `run.end`, prefilter SQL −45 j dans Task 2.
- Spec « regroupement multi-mois par date réelle » → Task 1 (adjacence via `ymdToUTC`).
- Spec « tri le plus proche d'abord » → Task 1 `.sort`.
- Spec « validation multi-mois » → Task 2 `setCongeStatus(dates)` + Task 3 `PutBody.dates`.
- Spec « libellé à cheval » → Task 4 `fmt`.
- Types cohérents : `YMD`, `CongeRun.dates`, `start`, `end` identiques entre `congeRuns.ts`, `availability.ts`, `route.ts` (via Zod), `CongesClient.tsx`.

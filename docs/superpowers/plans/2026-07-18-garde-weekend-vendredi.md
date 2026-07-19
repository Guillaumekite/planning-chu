# Vendredi compté comme week-end dans l'équité des gardes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the garde-assignment engine treat Friday as part of the "weekend" bucket for
equity purposes (Fri+Sat+Sun), instead of only Saturday/Sunday, so that Fri/Sat/Sun on-call load
gets balanced fairly across doctors — while leaving the shared `CalendarDay.isWeekend` field
(consumed by `planning.ts` and the UI for the regular consultation grid) untouched.

**Architecture:** Add a private predicate `isGardeWeekend(cd)` (weekday ≥ 4, i.e. Fri/Sat/Sun)
inside `src/engine/gardes.ts`, next to the existing `isHeavy` predicate, and swap the 5 places
that currently read `cd.isWeekend` for equity/fairness math to use it instead. Also align
Friday's pénibilité weight with Saturday/Sunday in `DEFAULT_WEIGHTS.perWeekday`.

**Tech Stack:** TypeScript, Vitest (`npm test` = `vitest run`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-garde-weekend-vendredi-design.md` — read it before
  starting if anything below is unclear.
- Do NOT change `CalendarDay.isWeekend` (must stay Saturday/Sunday only — it is shared with
  `src/engine/planning.ts` and the UI grids/exports).
- Do NOT change `isHeavy` (Thursday→Sunday pénibilité bucket), the 3-day garde-spacing rule, or
  the "exactly 2 doctors per day" rule — all stay exactly as they are.
- Every task must end with `npm test` passing (full suite), not just the new test file.

---

### Task 1: Add a failing test proving Friday must count as weekend equity

**Files:**
- Modify: `src/engine/gardes.test.ts`

**Interfaces:**
- Consumes: `solveGardes` (from `./gardes`), `buildMonth` (from `./calendar`), `DEFAULT_WEIGHTS`
  (from `./types`) — `buildMonth(year, month, weights, holidays?)` returns `CalendarDay[]` with a
  `weekday: 0..6` field (0=Monday … 6=Sunday) and `EquityReport.weekendCount: Record<DoctorId, number>`.

- [ ] **Step 1: Add the missing imports at the top of `src/engine/gardes.test.ts`**

Current top of file:

```ts
import { describe, it, expect } from 'vitest';
import { solveGardes } from './gardes';
import { daysInMonth } from './calendar';
import { mulberry32, randInt } from './rng';
import type { GardeInput, GardeResult } from './types';
```

Replace with:

```ts
import { describe, it, expect } from 'vitest';
import { solveGardes } from './gardes';
import { daysInMonth, buildMonth } from './calendar';
import { mulberry32, randInt } from './rng';
import { DEFAULT_WEIGHTS } from './types';
import type { GardeInput, GardeResult } from './types';
```

- [ ] **Step 2: Add the failing test inside `describe('solveGardes — equity', ...)`**

Add this test right after the `'keeps garde-count spread tight with a clean full roster'` test
(inside the same `describe` block):

```ts
  it('counts Friday in the weekend equity bucket (Fri+Sat+Sun)', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const days = buildMonth(2026, 4, DEFAULT_WEIGHTS);
    const friSatSun = days.filter((d) => d.weekday >= 4).length; // Fri(4), Sat(5), Sun(6)
    const totalWeekendCount = Object.values(res.equity.weekendCount).reduce((s, v) => s + v, 0);
    // 2 doctors (G1+G2) on garde every Fri/Sat/Sun day.
    expect(totalWeekendCount).toBe(friSatSun * 2);
  });
```

- [ ] **Step 3: Run the test and confirm it FAILS**

Run: `npx vitest run src/engine/gardes.test.ts -t "counts Friday in the weekend equity bucket"`

Expected: FAIL — `totalWeekendCount` is currently based on Sat/Sun only (`friSatSun * 2` is too
high), e.g. `expected 24 to be 30` (exact numbers depend on April 2026's calendar, the point is
that it fails, not the specific numbers).

- [ ] **Step 4: Commit**

```bash
git add src/engine/gardes.test.ts
git commit -m "test: Friday must count in garde weekend-equity bucket (red)"
```

---

### Task 2: Implement `isGardeWeekend` and wire it into the equity engine

**Files:**
- Modify: `src/engine/gardes.ts:142-145` (add function), `:116`, `:292`, `:364`, `:424`, `:467`
  (swap `cd.isWeekend` → `isGardeWeekend(cd)`)
- Modify: `src/engine/types.ts` (fix now-stale `isWeekend` doc comment)

**Interfaces:**
- Produces: `isGardeWeekend(cd: CalendarDay): boolean` — private function in `gardes.ts`, true
  for Friday/Saturday/Sunday (`cd.weekday >= 4`). Not exported; only used inside `gardes.ts`.

- [ ] **Step 1: Add `isGardeWeekend` next to `isHeavy` in `src/engine/gardes.ts`**

Find:

```ts
/** A "heavy" (penible) garde day: Thursday→Sunday (weekday index 3..6). */
function isHeavy(cd: CalendarDay): boolean {
  return cd.weekday >= 3;
}
```

Replace with:

```ts
/** A "heavy" (penible) garde day: Thursday→Sunday (weekday index 3..6). */
function isHeavy(cd: CalendarDay): boolean {
  return cd.weekday >= 3;
}

/**
 * A "week-end de garde" day for EQUITY purposes only: Friday→Sunday (weekday index 4..6).
 * Deliberately NOT the same as `CalendarDay.isWeekend` (Sat/Sun only), which stays scoped to
 * the regular consultation planning (`planning.ts`) and the UI grids/exports — those must keep
 * treating Friday as a normal working day.
 */
function isGardeWeekend(cd: CalendarDay): boolean {
  return cd.weekday >= 4;
}
```

- [ ] **Step 2: Swap the 5 `cd.isWeekend` reads used for equity math**

In `src/engine/gardes.ts`, find (inside `solveGardes`, the per-day assignment/count loop):

```ts
      if (cd.isWeekend) weekendCount[doc] += 1;
```

Replace with:

```ts
      if (isGardeWeekend(cd)) weekendCount[doc] += 1;
```

Find (inside `solveFeasibility`, building the "≥1 weekend garde/month" MILP constraint):

```ts
      if (cd.isWeekend) wedefVars[doc].push({ name, coef: 1 });
```

Replace with:

```ts
      if (isGardeWeekend(cd)) wedefVars[doc].push({ name, coef: 1 });
```

Find (inside `polishEquity`, the initial cumulative-counts loop):

```ts
      if (cd.isWeekend) cumWe[doc] += 1;
```

Replace with:

```ts
      if (isGardeWeekend(cd)) cumWe[doc] += 1;
```

Find (inside `polishEquity`'s main steepest-descent loop):

```ts
      const we = cd.isWeekend;
```

Replace with:

```ts
      const we = isGardeWeekend(cd);
```

Find (inside `polishEquity`, applying the chosen best swap):

```ts
    if (cd.isWeekend) {
      cumWe[a] -= 1;
      cumWe[b] += 1;
    }
```

Replace with:

```ts
    if (isGardeWeekend(cd)) {
      cumWe[a] -= 1;
      cumWe[b] += 1;
    }
```

- [ ] **Step 3: Fix the now-stale `isWeekend` doc comment in `src/engine/types.ts`**

Find:

```ts
  isWeekend: boolean; // Saturday or Sunday — used for the "≥1 WE garde / month" rule
```

Replace with:

```ts
  isWeekend: boolean; // Saturday or Sunday — used by planning.ts/UI for the regular weekly grid
```

- [ ] **Step 4: Run the Task 1 test and confirm it now PASSES**

Run: `npx vitest run src/engine/gardes.test.ts -t "counts Friday in the weekend equity bucket"`

Expected: PASS

- [ ] **Step 5: Run the full test suite and confirm nothing else broke**

Run: `npm test`

Expected: all tests pass, including the pre-existing hard-invariant tests (2 doctors/day, 3-day
spacing) and `calendar.test.ts` (which still asserts `isWeekend` is Sat/Sun only).

- [ ] **Step 6: Commit**

```bash
git add src/engine/gardes.ts src/engine/types.ts
git commit -m "feat: count Friday as garde weekend-equity day (green)"
```

---

### Task 3: Add a fairness regression test for the Fri/Sat/Sun bucket

**Files:**
- Modify: `src/engine/gardes.test.ts`

**Interfaces:**
- Consumes: `res.equity.weekendCount: Record<DoctorId, number>` (now Fri+Sat+Sun per Task 2).

- [ ] **Step 1: Add the test inside `describe('solveGardes — equity', ...)`**

Add right after the `'rotates weekend/heavy gardes fairly across the roster'` test:

```ts
  it('rotates Fri/Sat/Sun gardes fairly across the roster', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14) });
    expect(res.status).toBe('feasible');
    if (res.status === 'feasible') {
      const we = Object.values(res.equity.weekendCount);
      // No doctor hoards Fri/Sat/Sun gardes while another gets none.
      expect(Math.max(...we) - Math.min(...we)).toBeLessThanOrEqual(3);
    }
  });
```

- [ ] **Step 2: Run it and confirm it PASSES**

Run: `npx vitest run src/engine/gardes.test.ts -t "rotates Fri/Sat/Sun gardes fairly"`

Expected: PASS (the existing `W_WE` local-search term in `polishEquity` already balances
whatever `isGardeWeekend` reports, so this should pass immediately after Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/engine/gardes.test.ts
git commit -m "test: Fri/Sat/Sun garde load stays balanced across doctors"
```

---

### Task 4: Align Friday's pénibilité weight and finish doc comments

**Files:**
- Modify: `src/engine/types.ts`

**Interfaces:**
- Produces: `DEFAULT_WEIGHTS.perWeekday: [1, 1, 1, 2, 3, 3, 3]` (was `[1, 1, 1, 2, 2, 3, 3]`).

- [ ] **Step 1: Align Friday's weight in `DEFAULT_WEIGHTS`**

Find:

```ts
export const DEFAULT_WEIGHTS: GardeWeights = {
  perWeekday: [1, 1, 1, 2, 2, 3, 3], // Mon-Wed=1, Thu/Fri=2, Sat/Sun=3
  holiday: 3,
  weekendDeficit: 4,
  wishHonored: 0.5,
};
```

Replace with:

```ts
export const DEFAULT_WEIGHTS: GardeWeights = {
  perWeekday: [1, 1, 1, 2, 3, 3, 3], // Mon-Wed=1, Thu=2, Fri/Sat/Sun=3
  holiday: 3,
  weekendDeficit: 4,
  wishHonored: 0.5,
};
```

Note: this only feeds `CalendarDay.penibility`, which today is read by `calendar.test.ts` but not
by the solver — this step is a data-consistency change, not a behavior change. The actual
equity-balancing change is Task 2's `isGardeWeekend`.

- [ ] **Step 2: Update the `weekendCount` / `cumulativeWeekend` / `carryWeekend` doc comments**

Find:

```ts
  /** Weekend (Sat/Sun) gardes per doctor this month. */
  weekendCount: Record<DoctorId, number>;
```

Replace with:

```ts
  /** Weekend (Fri/Sat/Sun) gardes per doctor this month — Friday counts toward equity even
   * though `CalendarDay.isWeekend` (Sat/Sun only) does not. */
  weekendCount: Record<DoctorId, number>;
```

Find:

```ts
  /** Cumulative weekend (Sat/Sun) garde count (carry + this month) — feeds next month's carryWeekend. */
  cumulativeWeekend: Record<DoctorId, number>;
```

Replace with:

```ts
  /** Cumulative weekend (Fri/Sat/Sun) garde count (carry + this month) — feeds next month's carryWeekend. */
  cumulativeWeekend: Record<DoctorId, number>;
```

Find:

```ts
  /** Per doctor: cumulative weekend (Sat/Sun) garde count from previous months (WE rotation). */
  carryWeekend?: Record<DoctorId, number>;
```

Replace with:

```ts
  /** Per doctor: cumulative weekend (Fri/Sat/Sun) garde count from previous months (WE rotation). */
  carryWeekend?: Record<DoctorId, number>;
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: all tests pass (this task only touches weights consumed by an unrelated field and
comments, no behavior change beyond Task 2's).

- [ ] **Step 4: Commit**

```bash
git add src/engine/types.ts
git commit -m "chore: align Friday penibility weight with weekend, refresh equity doc comments"
```

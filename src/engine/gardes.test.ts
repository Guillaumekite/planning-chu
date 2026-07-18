import { describe, it, expect } from 'vitest';
import { solveGardes } from './gardes';
import { daysInMonth, buildMonth } from './calendar';
import { mulberry32, randInt } from './rng';
import { DEFAULT_WEIGHTS } from './types';
import type { GardeInput, GardeResult } from './types';

function doctors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
}

/** Assert all HARD-constraint invariants on a feasible result. */
function assertHardInvariants(res: GardeResult, input: GardeInput) {
  expect(res.status).toBe('feasible');
  if (res.status !== 'feasible') return;
  const n = daysInMonth(input.year, input.month);
  const blocked = input.gardeBlocked ?? {};

  // Exactly one G1 and one G2 per day, on two distinct doctors.
  for (let day = 1; day <= n; day++) {
    const today = res.assignments.filter((a) => a.day === day);
    expect(today.length).toBe(2);
    const roles = today.map((a) => a.role).sort();
    expect(roles).toEqual(['G1', 'G2']);
    expect(today[0].doctorId).not.toBe(today[1].doctorId);
  }

  // No assignment on a blocked day.
  for (const a of res.assignments) {
    expect((blocked[a.doctorId] ?? []).includes(a.day)).toBe(false);
  }

  // Rest rule: garde → RS → worked day → garde ⇒ minimum 3-day gap between a doctor's gardes.
  const byDoctor: Record<string, number[]> = {};
  for (const a of res.assignments) (byDoctor[a.doctorId] ??= []).push(a.day);
  for (const days of Object.values(byDoctor)) {
    const sorted = [...days].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(3);
    }
  }
}

describe('solveGardes — hard constraints (property-based over seeds)', () => {
  for (let seed = 1; seed <= 8; seed++) {
    it(`feasible month satisfies all hard invariants (seed ${seed})`, async () => {
      const rng = mulberry32(seed);
      const docs = doctors(14 + randInt(rng, 7)); // 14-20 doctors
      const gardeBlocked: Record<string, number[]> = {};
      for (const doc of docs) {
        const days: number[] = [];
        const k = randInt(rng, 4);
        for (let j = 0; j < k; j++) days.push(1 + randInt(rng, 30));
        gardeBlocked[doc] = [...new Set(days)];
      }
      const input: GardeInput = { year: 2026, month: 4, doctors: docs, gardeBlocked };
      const res = await solveGardes(input);
      assertHardInvariants(res, input);
    });
  }
});

describe('solveGardes — equity', () => {
  it('keeps garde-count spread tight with a clean full roster', async () => {
    const input: GardeInput = { year: 2026, month: 4, doctors: doctors(18) };
    const res = await solveGardes(input);
    expect(res.status).toBe('feasible');
    if (res.status === 'feasible') {
      expect(res.equity.spread).toBeLessThanOrEqual(2);
    }
  });

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

  it('rotates weekend/heavy gardes fairly across the roster', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14) });
    expect(res.status).toBe('feasible');
    if (res.status === 'feasible') {
      const heavy = Object.values(res.equity.heavyCount);
      // No doctor hoards the painful days while another gets none.
      expect(Math.max(...heavy) - Math.min(...heavy)).toBeLessThanOrEqual(3);
    }
  });

  it('rotates Fri/Sat/Sun gardes fairly across the roster', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14) });
    expect(res.status).toBe('feasible');
    if (res.status === 'feasible') {
      const we = Object.values(res.equity.weekendCount);
      // No doctor hoards Fri/Sat/Sun gardes while another gets none.
      expect(Math.max(...we) - Math.min(...we)).toBeLessThanOrEqual(3);
    }
  });

  it('spreads each doctor\'s gardes across the month (no clustering)', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(16) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const byDoctor: Record<string, number[]> = {};
    for (const a of res.assignments) (byDoctor[a.doctorId] ??= []).push(a.day);
    for (const days of Object.values(byDoctor)) {
      if (days.length < 2) continue;
      const sorted = [...days].sort((x, y) => x - y);
      const gaps = sorted.slice(1).map((d, i) => d - sorted[i]);
      // Hard rule: every gap between a doctor's gardes is at least 3 days.
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
    }
  });

  it('carries equity across months (a heavier-starting doctor gets fewer gardes)', async () => {
    const docs = doctors(12);
    const carryCount: Record<string, number> = { D01: 20 };
    const res = await solveGardes({ year: 2026, month: 4, doctors: docs, carryCount });
    expect(res.status).toBe('feasible');
    if (res.status === 'feasible') {
      const d01 = res.assignments.filter((a) => a.doctorId === 'D01').length;
      const avg = res.assignments.length / docs.length; // ~5
      expect(d01).toBeLessThan(avg);
    }
  });
});

describe('solveGardes — infeasibility is first-class', () => {
  it('detects a day with fewer than 2 eligible doctors', async () => {
    const docs = doctors(10);
    const gardeBlocked: Record<string, number[]> = {};
    for (const doc of docs) if (doc !== 'D01') gardeBlocked[doc] = [15];
    const res = await solveGardes({ year: 2026, month: 4, doctors: docs, gardeBlocked });
    expect(res.status).toBe('infeasible');
    if (res.status === 'infeasible') {
      expect(res.day).toBe(15);
      expect(res.eligible).toEqual(['D01']);
    }
  });

  it('reports infeasible when the RS rule cannot be satisfied (only 2 doctors)', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(2) });
    expect(res.status).toBe('infeasible');
  });
});

describe('solveGardes — G1/G2 role balancing (intra-month)', () => {
  it('alternates G1/G2 for each doctor with ≥2 gardes (|G1−G2| ≤ 1)', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const g1: Record<string, number> = {};
    const g2: Record<string, number> = {};
    for (const a of res.assignments) {
      if (a.role === 'G1') g1[a.doctorId] = (g1[a.doctorId] ?? 0) + 1;
      else g2[a.doctorId] = (g2[a.doctorId] ?? 0) + 1;
    }
    for (const doc of doctors(14)) {
      const total = (g1[doc] ?? 0) + (g2[doc] ?? 0);
      if (total < 2) continue;
      expect(Math.abs((g1[doc] ?? 0) - (g2[doc] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it('keeps a forceG2 doctor always in G2 (never G1)', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(14), forceG2: ['D01'] });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const d01 = res.assignments.filter((a) => a.doctorId === 'D01');
    expect(d01.length).toBeGreaterThan(0);
    expect(d01.every((a) => a.role === 'G2')).toBe(true);
    // Still exactly one G1 + one G2 each day.
    const n = daysInMonth(2026, 4);
    for (let day = 1; day <= n; day++) {
      const today = res.assignments.filter((a) => a.day === day);
      expect(today.map((a) => a.role).sort()).toEqual(['G1', 'G2']);
    }
  });

  it('still balances every OTHER doctor to |G1−G2| ≤ 1 despite a forceG2 doctor', async () => {
    const docs = doctors(14);
    const res = await solveGardes({ year: 2026, month: 4, doctors: docs, forceG2: ['D01'] });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const g1: Record<string, number> = {}, g2: Record<string, number> = {};
    for (const a of res.assignments) (a.role === 'G1' ? g1 : g2)[a.doctorId] = ((a.role === 'G1' ? g1 : g2)[a.doctorId] ?? 0) + 1;
    for (const doc of docs.slice(1)) { // skip the forced doctor
      if (((g1[doc] ?? 0) + (g2[doc] ?? 0)) < 2) continue;
      expect(Math.abs((g1[doc] ?? 0) - (g2[doc] ?? 0))).toBeLessThanOrEqual(1);
    }
  });
});

describe('solveGardes — determinism', () => {
  it('produces identical output for identical input', async () => {
    const input: GardeInput = {
      year: 2026,
      month: 4,
      doctors: doctors(16),
      gardeBlocked: { D03: [4, 5], D07: [12] },
    };
    const a = await solveGardes(input);
    const b = await solveGardes(input);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

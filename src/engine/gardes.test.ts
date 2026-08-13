import { describe, it, expect } from 'vitest';
import { solveGardes, computeGardeTargets } from './gardes';
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

describe('solveGardes — G+ wishes are hard & the monthly cap holds', () => {
  it('forces the garde for each wisher when ≤ 2 G+ land on the same day', async () => {
    // Jour 7 = mardi (un G+ de week-end restreindrait les WE du wisher — spec §1.2 — et
    // déclencherait une relaxation légitime ; ici on teste le forçage pur, sans warning).
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(12), wishes: { D05: [7], D06: [7] } });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const day7 = res.assignments.filter((a) => a.day === 7).map((a) => a.doctorId).sort();
    expect(day7).toEqual(['D05', 'D06']);
    expect(res.warnings).toHaveLength(0);
  });

  it('reserves both slots to wishers (with a warning) when ≥ 3 G+ hit the same day', async () => {
    const res = await solveGardes({
      year: 2026, month: 4, doctors: doctors(12), wishes: { D05: [10], D06: [10], D07: [10] },
    });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    for (const a of res.assignments.filter((x) => x.day === 10)) {
      expect(['D05', 'D06', 'D07']).toContain(a.doctorId);
    }
    expect(res.warnings.some((w) => w.includes('3 G+ le 10'))).toBe(true);
  });

  it('keeps the first of two G+ closer than 3 days apart and warns about the second', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(12), wishes: { D05: [10, 11] } });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    expect(res.assignments.some((a) => a.day === 10 && a.doctorId === 'D05')).toBe(true);
    expect(res.assignments.some((a) => a.day === 11 && a.doctorId === 'D05')).toBe(false); // rest rule
    expect(res.warnings.some((w) => w.includes('repos'))).toBe(true);
  });

  it('caps every doctor at 7 gardes/month', async () => {
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(9) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const perDoc: Record<string, number> = {};
    for (const a of res.assignments) perDoc[a.doctorId] = (perDoc[a.doctorId] ?? 0) + 1;
    for (const doc of doctors(9)) expect(perDoc[doc] ?? 0).toBeLessThanOrEqual(7);
  });

  it('lifts the cap for a doctor who posted more than 7 G+ (8 wishes → 8 gardes)', async () => {
    const wishes = { D01: [1, 4, 7, 10, 13, 16, 19, 22] }; // 8 wishes, all ≥3 days apart
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(9), wishes });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    expect(res.assignments.filter((a) => a.doctorId === 'D01').length).toBe(8);
    for (const d of wishes.D01) {
      expect(res.assignments.some((a) => a.day === d && a.doctorId === 'D01')).toBe(true);
    }
  });
});

describe('solveGardes — infeasibility is first-class', () => {
  it('reports infeasible with a clear message when the 7-garde cap makes the month uncoverable', async () => {
    // 8 doctors × 7 gardes = 56 < 60 slots (April) → provably infeasible under the cap.
    const res = await solveGardes({ year: 2026, month: 4, doctors: doctors(8) });
    expect(res.status).toBe('infeasible');
    if (res.status === 'infeasible') expect(res.reason).toContain('7 gardes/médecin');
  });

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

describe('computeGardeTargets — carry du mois précédent en ratio, borné ±1 (spec §1.3)', () => {
  it('sans carry : part proportionnelle au poids', () => {
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, {}, {});
    expect(t.a).toBeCloseTo(30);
    expect(t.b).toBeCloseTo(30);
  });

  it('un médecin surchargé le mois dernier est soulagé d\'AU PLUS 1 garde', () => {
    // a a fait 7 gardes en 20 jours travaillés, b 3 en 20 : gros déséquilibre passé,
    // mais la correction est bornée : |cible − part| ≤ 1.
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, { a: 7, b: 3 }, { a: 20, b: 20 });
    expect(t.a).toBeGreaterThanOrEqual(29);
    expect(t.a).toBeLessThan(30);
    expect(t.b).toBeGreaterThan(30);
    expect(t.b).toBeLessThanOrEqual(31);
  });

  it('le ratio compte, pas le brut : moins de gardes parce que moins présent ⇒ pas de rattrapage', () => {
    // a : 3 gardes / 10 jours travaillés (ratio 0.3) ; b : 6 / 20 (ratio 0.3) — même ratio ⇒ corrections ~0.
    const t = computeGardeTargets(['a', 'b'], 60, { a: 1, b: 1 }, { a: 3, b: 6 }, { a: 10, b: 20 });
    expect(Math.abs(t.a - 30)).toBeLessThan(0.5);
    expect(Math.abs(t.b - 30)).toBeLessThan(0.5);
  });

  it('un nouveau médecin (aucune donnée du mois précédent) reste neutre : cible = sa part', () => {
    const t = computeGardeTargets(['a', 'b', 'neuf'], 60, { a: 1, b: 1, neuf: 1 }, { a: 5, b: 3 }, { a: 20, b: 20 });
    expect(Math.abs(t.neuf - 20)).toBeLessThanOrEqual(0.01);
  });
});

describe('solveGardes — cap souple 6 et équité portée par le MILP (spec §1.3)', () => {
  it('personne au-dessus de 6 gardes quand l\'effectif suffit (11 médecins, 31 jours)', async () => {
    const res = await solveGardes({ year: 2026, month: 10, doctors: doctors(11) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    for (const c of Object.values(res.equity.count)) expect(c).toBeLessThanOrEqual(6);
    const cs = Object.values(res.equity.count);
    expect(Math.max(...cs) - Math.min(...cs)).toBeLessThanOrEqual(1); // équité dès le solveur
    expect(res.warnings.some((w) => w.includes('montent à 7'))).toBe(false);
  });

  it('monte à 7 UNIQUEMENT si nécessaire, avec avertissement (9 médecins, 31 jours = 62 gardes)', async () => {
    const res = await solveGardes({ year: 2026, month: 10, doctors: doctors(9) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    expect(Math.max(...Object.values(res.equity.count))).toBe(7);
    expect(res.warnings.some((w) => w.includes('montent à 7'))).toBe(true);
  });
});

describe('solveGardes — week-ends : jamais 2× le même jour, exception G+ (spec §1.2)', () => {
  const weWd = (day: number) => new Date(Date.UTC(2026, 9, day)).getUTCDay(); // 5=ven, 6=sam, 0=dim

  it('jamais deux vendredis, deux samedis ou deux dimanches pour le même médecin', async () => {
    const res = await solveGardes({ year: 2026, month: 10, doctors: doctors(12) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const perDocWd = new Map<string, Map<number, number>>();
    for (const a of res.assignments) {
      const wd = weWd(a.day);
      if (![5, 6, 0].includes(wd)) continue;
      const m = perDocWd.get(a.doctorId) ?? new Map<number, number>();
      m.set(wd, (m.get(wd) ?? 0) + 1);
      perDocWd.set(a.doctorId, m);
    }
    for (const m of perDocWd.values()) for (const n of m.values()) expect(n).toBeLessThanOrEqual(1);
  });

  it('G+ sur 2 samedis : accordés, et AUCUNE autre garde de week-end ajoutée à ce médecin', async () => {
    const res = await solveGardes({ year: 2026, month: 10, doctors: doctors(12), wishes: { D01: [3, 10] } });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const mine = res.assignments.filter((a) => a.doctorId === 'D01');
    expect(mine.some((a) => a.day === 3)).toBe(true);
    expect(mine.some((a) => a.day === 10)).toBe(true);
    const weDays = mine.filter((a) => [5, 6, 0].includes(weWd(a.day))).map((a) => a.day).sort((x, y) => x - y);
    expect(weDays).toEqual([3, 10]); // exactement ses G+ de week-end, rien de plus
  });
});

describe('solveGardes — espacement et couverture hebdomadaire (spec §1.3)', () => {
  it('14 médecins pleinement présents : chaque semaine complète travaillée contient une garde', async () => {
    const ds = doctors(14);
    const weeks = [
      [5, 6, 7, 8, 9, 10, 11],
      [12, 13, 14, 15, 16, 17, 18],
      [19, 20, 21, 22, 23, 24, 25],
    ]; // oct. 2026 : lundis 5, 12, 19 — 3 semaines lun→dim entières
    const weeklyExpected = Object.fromEntries(ds.map((d) => [d, weeks]));
    const res = await solveGardes({ year: 2026, month: 10, doctors: ds, weeklyExpected });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const byDoc = new Map(ds.map((d) => [d, new Set<number>()]));
    for (const a of res.assignments) byDoc.get(a.doctorId)!.add(a.day);
    let missed = 0;
    for (const d of ds) for (const wk of weeks) if (!wk.some((day) => byDoc.get(d)!.has(day))) missed++;
    // 14 médecins × 3 semaines = 42 gardes attendues pour 42 places (14 j × 2 + bords) : zéro raté.
    expect(missed).toBe(0);
  });

  it('écart maximal entre 2 gardes consécutives d\'un médecin ≤ 2× l\'écart idéal', async () => {
    const res = await solveGardes({ year: 2026, month: 10, doctors: doctors(10) });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    const byDoc: Record<string, number[]> = {};
    for (const a of res.assignments) (byDoc[a.doctorId] ??= []).push(a.day);
    for (const ds2 of Object.values(byDoc)) {
      ds2.sort((x, y) => x - y);
      const ideal = 31 / (ds2.length + 1);
      for (let i = 1; i < ds2.length; i++) expect(ds2[i] - ds2[i - 1]).toBeLessThanOrEqual(Math.ceil(2 * ideal));
    }
  });
});

describe('solveGardes — minimum 2 gardes pour les présents ≥ 8 jours (minTwo)', () => {
  it('un médecin peu disponible mais présent reçoit au moins 2 gardes quand c\'est possible', async () => {
    // D01 gardable seulement les 5, 10, 15, 20 (4 jours espacés) — sa part proportionnelle
    // serait ~1 garde ; minTwo le remonte à 2 pour alléger les plus chargés.
    const docs = doctors(18);
    const gardeBlocked: Record<string, number[]> = {
      D01: Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => ![5, 10, 15, 20].includes(d)),
    };
    const res = await solveGardes({ year: 2026, month: 4, doctors: docs, gardeBlocked, minTwo: ['D01'] });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    expect(res.equity.count.D01).toBeGreaterThanOrEqual(2);
  });

  it('2 gardes impossibles (2 jours gardables trop rapprochés) : 1 garde + avertissement, pas de blocage', async () => {
    const docs = doctors(18);
    const gardeBlocked: Record<string, number[]> = {
      D01: Array.from({ length: 30 }, (_, i) => i + 1).filter((d) => ![10, 11].includes(d)),
    };
    const res = await solveGardes({ year: 2026, month: 4, doctors: docs, gardeBlocked, minTwo: ['D01'] });
    expect(res.status).toBe('feasible');
    if (res.status !== 'feasible') return;
    expect(res.equity.count.D01).toBe(1);
    expect(res.warnings.some((w) => w.includes('D01') && w.includes('garde'))).toBe(true);
  });
});

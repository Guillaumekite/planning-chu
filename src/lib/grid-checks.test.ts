// Vérifications de la grille éditée par l'admin + recalcul d'équité des gardes.
import { describe, it, expect } from 'vitest';
import { gardeRole, checkGrid, recomputeEquity, type GridEquity } from './grid-checks';

type Day = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };

// Petit mois de test : jours 1..7, le jour 1 est un lundi (weekday 0).
function week(): Day[] {
  return [0, 1, 2, 3, 4, 5, 6].map((wd) => ({
    day: wd + 1,
    weekday: wd,
    isWeekend: wd === 5 || wd === 6,
    isHoliday: false,
  }));
}

// Grille bien formée : chaque jour exactement 1 G1 + 1 G2, jamais deux gardes de
// suite pour un même médecin, RS après chaque garde — pour isoler les autres règles.
// Jours impairs : A=G1, C=G2 ; jours pairs : B=G1, D=G2.
function gardesOk(extra: Record<string, Record<number, string>> = {}): Record<string, Record<number, string>> {
  const A: Record<number, string> = {}, B: Record<number, string> = {};
  const C: Record<number, string> = {}, D: Record<number, string> = {};
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    if (d % 2 === 1) { A[d] = 'G1'; C[d] = 'G2'; B[d] = 'RS'; D[d] = 'RS'; }
    else { B[d] = 'G1'; D[d] = 'G2'; A[d] = 'RS'; C[d] = 'RS'; }
  }
  return { A, B, C, D, ...extra };
}

describe('gardeRole', () => {
  it('reconnaît les gardes pures et combinées', () => {
    expect(gardeRole('G1')).toBe('G1');
    expect(gardeRole('G2')).toBe('G2');
    expect(gardeRole('U+G1')).toBe('G1');
    expect(gardeRole('ACU+G2')).toBe('G2');
    expect(gardeRole('BM')).toBeNull();
    expect(gardeRole('')).toBeNull();
    expect(gardeRole(undefined)).toBeNull();
  });
});

describe('checkGrid — composition du jour', () => {
  it('signale un jour sans G1 ni G2', () => {
    const days = week();
    const warnings = checkGrid(days, { A: {} });
    expect(warnings.some((w) => w.includes('Jour 1') && w.includes('G1'))).toBe(true);
  });

  it('signale un jour avec deux G1', () => {
    const days = [week()[0]];
    const warnings = checkGrid(days, { A: { 1: 'G1' }, B: { 1: 'G1' } });
    expect(warnings.some((w) => w.includes('Jour 1') && w.includes('G1'))).toBe(true);
  });

  it("ne signale rien sur une semaine complète bien formée (week-end : gardes seules)", () => {
    const warnings = checkGrid(week(), gardesOk());
    expect(warnings).toEqual([]);
  });
});

describe('checkGrid — règles de profil', () => {
  it('signale un G1 attribué à un médecin « Jamais G1 » (garde pure ou du soir)', () => {
    const days = week();
    const w1 = checkGrid(days, gardesOk(), { A: { forceG2: true } });
    expect(w1.some((w) => w.includes('A') && w.includes('Jamais G1'))).toBe(true);
    // Garde du soir combinée : C a 'G1' le jour 2 → remplaçons par une combinée.
    const grid = gardesOk();
    grid.C[2] = 'U+G1';
    const w2 = checkGrid(days, grid, { C: { forceG2: true } });
    expect(w2.some((w) => w.includes('C') && w.includes('Jamais G1'))).toBe(true);
  });

  it('signale un S attribué à un médecin « Pas de S »', () => {
    const grid = gardesOk({ E: { 1: 'S' } });
    const warnings = checkGrid(week(), grid, { E: { noS: true } });
    expect(warnings.some((w) => w.includes('E') && w.includes('Pas de S'))).toBe(true);
  });

  it('signale un HC attribué à un médecin « Jamais HC »', () => {
    const grid = gardesOk({ E: { 1: 'HC' } });
    const warnings = checkGrid(week(), grid, { E: { noHC: true } });
    expect(warnings.some((w) => w.includes('E') && w.includes('Jamais HC'))).toBe(true);
  });
});

describe('checkGrid — repos autour des gardes', () => {
  it('signale deux gardes deux jours de suite', () => {
    const grid = gardesOk();
    grid.A[2] = 'G2'; grid.B[2] = 'RS'; // A : G1 jour 1 puis G2 jour 2
    const warnings = checkGrid(week(), grid);
    expect(warnings.some((w) => w.includes('A') && w.includes('deux jours de suite'))).toBe(true);
  });

  it('signale un jour travaillé juste après une garde (pas de repos de sécurité)', () => {
    const grid = gardesOk();
    grid.A[2] = 'BM'; // A : G1 jour 1 puis BM jour 2
    const warnings = checkGrid(week(), grid);
    expect(warnings.some((w) => w.includes('A') && w.includes('repos de sécurité'))).toBe(true);
  });

  it("ne double pas l'avertissement quand le lendemain est lui-même une garde", () => {
    const grid = gardesOk();
    grid.A[2] = 'G2'; grid.B[2] = 'RS';
    const warnings = checkGrid(week(), grid);
    expect(warnings.some((w) => w.includes('repos de sécurité'))).toBe(false);
  });

  it('accepte RS ou case vide après une garde', () => {
    const warnings = checkGrid(week(), gardesOk());
    expect(warnings.some((w) => w.includes('repos de sécurité'))).toBe(false);
  });
});

describe('recomputeEquity', () => {
  it('recompte les gardes du mois depuis la grille (pures et du soir)', () => {
    const days = week();
    const grid = { A: { 1: 'G1', 4: 'ACU+G2' }, B: { 2: 'G2' } };
    const eq = recomputeEquity(days, grid, null);
    expect(eq.count).toEqual({ A: 2, B: 1 });
    // Jour 4 = jeudi (weekday 3) → pénible ; jour 1 lundi → ni pénible ni week-end.
    expect(eq.heavyCount).toEqual({ A: 1, B: 0 });
    expect(eq.weekendCount).toEqual({ A: 0, B: 0 });
  });

  it('compte week-end de garde du vendredi au dimanche', () => {
    const days = week();
    const grid = { A: { 5: 'G1', 6: 'G1' }, B: { 7: 'G2' } }; // ven, sam / dim
    const eq = recomputeEquity(days, grid, null);
    expect(eq.weekendCount).toEqual({ A: 2, B: 1 });
    expect(eq.heavyCount).toEqual({ A: 2, B: 1 });
  });

  it("préserve le report des mois précédents : cumul = report + nouveau compte", () => {
    const days = week();
    const base: GridEquity = {
      count: { A: 2, B: 1 },
      weekendCount: { A: 1, B: 0 },
      heavyCount: { A: 1, B: 1 },
      cumulativeCount: { A: 5, B: 1 }, // report A = 3, B = 0
      cumulativeHeavy: { A: 2, B: 1 },
      cumulativeWeekend: { A: 1, B: 0 },
      spread: 4,
    };
    // A perd une garde au profit de B.
    const grid = { A: { 1: 'G1' }, B: { 2: 'G2', 3: 'G1' } };
    const eq = recomputeEquity(days, grid, base);
    expect(eq.count).toEqual({ A: 1, B: 2 });
    expect(eq.cumulativeCount).toEqual({ A: 4, B: 2 }); // 3+1, 0+2
    expect(eq.spread).toBe(2);
  });

  it('tolère une base historique sans champs cumulés (report considéré nul)', () => {
    const base = {
      count: { A: 2 }, weekendCount: { A: 1 }, heavyCount: { A: 1 }, spread: 0,
    } as unknown as GridEquity;
    const eq = recomputeEquity(week(), { A: { 1: 'G1' } }, base);
    expect(eq.cumulativeCount).toEqual({ A: 1 });
    expect(eq.spread).toBe(0);
  });

  it('sans base (pas de rapport publié), le cumul est le compte du mois', () => {
    const eq = recomputeEquity(week(), { A: { 1: 'G1' }, B: {} }, null);
    expect(eq.cumulativeCount).toEqual({ A: 1, B: 0 });
    expect(eq.spread).toBe(1);
  });
});

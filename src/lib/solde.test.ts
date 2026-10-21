import { describe, expect, test } from 'vitest';
import { ANCHOR, gardeCounts, presenceDays, monthDues, soldeFromMonths } from './solde';
import type { Grid } from './grid-checks';

// Grille jouet 4 jours, 3 médecins : A fait 3 gardes, B 1, C 0 (C en congé partout).
const GRID: Grid = {
  A: { 1: 'G1', 2: 'RS', 3: 'U+G1', 4: 'ACU+G2' },
  B: { 1: 'G2', 2: 'BM', 3: 'CS1', 4: '' },
  C: { 1: 'CA', 2: 'CA', 3: 'ABS', 4: 'CA' },
};

describe('solde — fonctions pures', () => {
  test('ancrage = septembre 2026', () => {
    expect(ANCHOR).toEqual({ year: 2026, month: 9 });
  });

  test('presenceDays exclut CA, ABS et cases vides', () => {
    const p = presenceDays(GRID);
    expect(p.A).toBe(4); // G1, RS, U+G1, ACU+G2
    expect(p.B).toBe(3); // '' exclu
    expect(p.C).toBe(0); // CA/ABS exclus
  });

  test('gardeCounts compte G1/G2 purs et combinés (U+G1, ACU+G2)', () => {
    const g = gardeCounts(GRID);
    expect(g.A).toBe(3);
    expect(g.B).toBe(1);
    expect(g.C).toBe(0);
  });

  test('monthDues répartit le pot réel (grille trouée : pot = gardes présentes)', () => {
    // 4 gardes seulement dans la grille (jours troués) : Σ dus = 4, au prorata de la présence.
    const dues = monthDues(GRID);
    expect(dues.A).toBeCloseTo((4 * 4) / 7);
    expect(dues.B).toBeCloseTo((4 * 3) / 7);
    expect(dues.C).toBe(0);
    expect(dues.A + dues.B + dues.C).toBeCloseTo(4);
  });

  test('monthDues : fraction no_garde nulle → aucun dû, le pot se reporte sur les autres', () => {
    const dues = monthDues(GRID, { B: 0 });
    expect(dues.B).toBe(0);
    expect(dues.A).toBeCloseTo(4);
  });

  test('monthDues : Σ poids nul → tous les dus à 0 (pas de NaN)', () => {
    const empty: Grid = { A: { 1: 'CA' }, B: { 1: '' } };
    const dues = monthDues(empty);
    expect(dues.A).toBe(0);
    expect(dues.B).toBe(0);
  });

  test('soldeFromMonths : Σ soldes ≈ 0 et médecin absent d’un mois reste neutre', () => {
    // Mois 1 : A et B seulement. Mois 2 : A, B et D (nouveau).
    const m2: Grid = {
      A: { 1: 'G1', 2: 'RS' },
      B: { 1: 'G2', 2: 'BM' },
      D: { 1: 'CS1', 2: 'G1' },
    };
    const solde = soldeFromMonths([{ grid: GRID }, { grid: m2 }]);
    const total = Object.values(solde).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(0);
    // D n'existe qu'au mois 2 : sa contribution vient de ce seul mois.
    const dues2 = monthDues(m2);
    expect(solde.D).toBeCloseTo(1 - dues2.D);
    // A cumule les deux mois.
    const dues1 = monthDues(GRID);
    expect(solde.A).toBeCloseTo(3 - dues1.A + (1 - dues2.A));
  });
});

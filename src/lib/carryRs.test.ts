import { describe, it, expect } from 'vitest';
import { gardeHoldersOnDay, carryGardeLastDay, RS_CARRYIN_FROM } from './carryRs';

describe('gardeHoldersOnDay', () => {
  const grid = {
    D01: { 30: 'G1' },
    D02: { 30: 'G2' },
    D03: { 30: 'U+G1' },
    D04: { 30: 'U+G2' },
    D05: { 30: 'ACU+G2' },
    D06: { 30: 'RS' }, // lendemain de garde — PAS une garde
    D07: { 30: 'S' },
    D08: { 30: 'CA' },
    D09: { 30: '' },
    D10: {}, // case absente
  };

  it('reconnaît toutes les cases porteuses de garde (G1, G2, U+G1, U+G2, ACU+G2)', () => {
    expect(gardeHoldersOnDay(grid, 30).sort()).toEqual(['D01', 'D02', 'D03', 'D04', 'D05']);
  });

  it('ignore RS, S, CA, vide et case absente', () => {
    const holders = gardeHoldersOnDay(grid, 30);
    for (const doc of ['D06', 'D07', 'D08', 'D09', 'D10']) expect(holders).not.toContain(doc);
  });

  it('ne renvoie rien pour un jour sans garde', () => {
    expect(gardeHoldersOnDay(grid, 15)).toEqual([]);
  });
});

describe('carryGardeLastDay', () => {
  const roster = ['D01', 'D02', 'D03', 'D04'];
  // Mois précédent = juin 2026 (30 jours), gardes du dernier jour sur D01/D02, un RS sur D03.
  const juin = { year: 2026, month: 6, grid: { D01: { 30: 'G1' }, D02: { 30: 'G2' }, D03: { 30: 'RS' } } };

  it('reporte les gardes du dernier jour quand le mois généré est ≥ juillet 2026 et le mois précédent contigu', () => {
    expect(carryGardeLastDay(2026, 7, juin, roster).sort()).toEqual(['D01', 'D02']);
  });

  it('ne reporte rien avant juillet 2026 (mois historiques intacts)', () => {
    const mai = { year: 2026, month: 5, grid: { D01: { 31: 'G1' }, D02: { 31: 'G2' } } };
    expect(carryGardeLastDay(2026, 6, mai, roster)).toEqual([]);
  });

  it('ne reporte rien si le mois publié précédent n\'est pas contigu (trou de publication)', () => {
    // On génère septembre mais le dernier publié est juillet → pas de report.
    const juillet = { year: 2026, month: 7, grid: { D01: { 31: 'G1' }, D02: { 31: 'G2' } } };
    expect(carryGardeLastDay(2026, 9, juillet, roster)).toEqual([]);
  });

  it('ne reporte rien sans mois précédent publié', () => {
    expect(carryGardeLastDay(2026, 7, null, roster)).toEqual([]);
  });

  it('gère le passage d\'année : janvier reporte depuis décembre', () => {
    const dec = { year: 2026, month: 12, grid: { D01: { 31: 'G1' }, D02: { 31: 'G2' } } };
    expect(carryGardeLastDay(2027, 1, dec, roster).sort()).toEqual(['D01', 'D02']);
  });

  it('filtre les médecins qui ne sont plus au roster du mois généré', () => {
    expect(carryGardeLastDay(2026, 7, juin, ['D01', 'D03', 'D04'])).toEqual(['D01']);
  });

  it('expose le seuil juillet 2026', () => {
    expect(RS_CARRYIN_FROM).toEqual({ year: 2026, month: 7 });
  });
});

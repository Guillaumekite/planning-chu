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

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

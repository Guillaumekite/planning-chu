import { describe, it, expect } from 'vitest';
import { workedDaysFromGrid } from './carryWorked';

describe('workedDaysFromGrid', () => {
  it('compte les cellules travaillées, ignore CA et les blancs', () => {
    expect(
      workedDaysFromGrid({
        a: { 1: 'G1', 2: 'RS', 3: 'BM', 4: 'CA', 5: '' },
        b: { 1: 'U', 2: 'HC' },
      }),
    ).toEqual({ a: 3, b: 2 });
  });

  it('grille vide ⇒ zéro partout', () => {
    expect(workedDaysFromGrid({ a: {} })).toEqual({ a: 0 });
  });
});

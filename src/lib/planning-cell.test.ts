// Décomposition d'une case du planning en poste + réunions (matin/après-midi).
import { describe, it, expect } from 'vitest';
import { planningCell } from './planning-cell';

// weekday : 0 = lundi, 1 = mardi, 2 = mercredi, 3 = jeudi, 4 = vendredi.

describe('planningCell — réunions par-dessus le poste', () => {
  it('mardi : biblio le matin + staff l’après-midi', () => {
    const c = planningCell(1, 'MM');
    expect(c.morning).toBe('biblio');
    expect(c.afternoon).toBe('staff');
    expect(c.afternoonKind).toBe('meeting');
  });

  it('vendredi : staff l’après-midi', () => {
    const c = planningCell(4, 'MM');
    expect(c.morning).toBe('');
    expect(c.afternoon).toBe('staff');
    expect(c.afternoonKind).toBe('meeting');
  });

  it('mercredi : plus aucune réunion (supprimée)', () => {
    const c = planningCell(2, 'MM');
    expect(c.morning).toBe('');
    expect(c.afternoon).toBe('');
    expect(c.afternoonKind).toBe('');
  });

  it('postes qui ne travaillent pas la journée : aucune réunion (ex. mardi, RS)', () => {
    const c = planningCell(1, 'RS');
    expect(c.morning).toBe('');
    expect(c.afternoon).toBe('');
  });

  it('garde du soir : l’après-midi affiche la garde, le matin du mardi reste', () => {
    const c = planningCell(1, 'MM+G1');
    expect(c.morning).toBe('biblio');
    expect(c.afternoon).toBe('G1 18h');
    expect(c.afternoonKind).toBe('garde');
  });
});

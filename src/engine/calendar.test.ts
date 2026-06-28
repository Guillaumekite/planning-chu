import { describe, it, expect } from 'vitest';
import { weekdayOf, daysInMonth, buildMonth } from './calendar';
import { DEFAULT_WEIGHTS } from './types';

describe('calendar', () => {
  it('computes weekday (Monday=0) against known anchors', () => {
    expect(weekdayOf(2000, 1, 1)).toBe(5); // Saturday
    expect(weekdayOf(2024, 1, 1)).toBe(0); // Monday
    expect(weekdayOf(2024, 2, 29)).toBe(3); // Thursday
  });

  it('handles leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('flags weekends and applies holiday penibility', () => {
    const days = buildMonth(2026, 4, DEFAULT_WEIGHTS, [6]);
    const d6 = days.find((d) => d.day === 6)!;
    expect(d6.isHoliday).toBe(true);
    expect(d6.penibility).toBeGreaterThanOrEqual(DEFAULT_WEIGHTS.holiday);
    const weekends = days.filter((d) => d.isWeekend);
    expect(weekends.every((d) => d.weekday === 5 || d.weekday === 6)).toBe(true);
  });
});

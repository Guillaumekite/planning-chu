import type { CalendarDay, Weekday, GardeWeights } from './types';

/**
 * Weekday of a date using Sakamoto's algorithm — pure arithmetic, no Date object,
 * so the engine stays deterministic and runtime-independent.
 * Returns 0 = Monday … 6 = Sunday.
 */
export function weekdayOf(year: number, month: number, day: number): Weekday {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let y = year;
  if (month < 3) y -= 1;
  // Sakamoto returns 0 = Sunday … 6 = Saturday
  const w = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + day) % 7;
  // Convert to Monday-first: Sunday(0) -> 6, Monday(1) -> 0, …
  return ((w + 6) % 7) as Weekday;
}

/** Number of days in a given month (1-12), Gregorian. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Build the calendar (one entry per day) for a month, with penibility weights. */
export function buildMonth(
  year: number,
  month: number,
  weights: GardeWeights,
  holidays: number[] = [],
): CalendarDay[] {
  const holidaySet = new Set(holidays);
  const n = daysInMonth(year, month);
  const days: CalendarDay[] = [];
  for (let day = 1; day <= n; day++) {
    const weekday = weekdayOf(year, month, day);
    const isWeekend = weekday === 5 || weekday === 6; // Sat or Sun
    const isHoliday = holidaySet.has(day);
    const base = weights.perWeekday[weekday];
    const penibility = isHoliday ? Math.max(base, weights.holiday) : base;
    days.push({ day, weekday, isWeekend, isHoliday, penibility });
  }
  return days;
}

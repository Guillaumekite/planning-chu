import { describe, it, expect } from 'vitest';
import { groupCongeRuns, shiftDays, encodeYMD, type CongeDayRow } from './congeRuns';

const row = (doctorId: number, name: string, year: number, month: number, day: number, congeStatus: string | null = 'pending', congeNote: string | null = null): CongeDayRow =>
  ({ doctorId, name, year, month, day, congeStatus, congeNote });

describe('shiftDays / encodeYMD', () => {
  it('crosses month boundaries backwards', () => {
    expect(shiftDays({ year: 2026, month: 3, day: 5 }, -7)).toEqual({ year: 2026, month: 2, day: 26 });
  });
  it('crosses year boundaries', () => {
    expect(shiftDays({ year: 2026, month: 1, day: 3 }, -7)).toEqual({ year: 2025, month: 12, day: 27 });
  });
  it('encodes ordinally', () => {
    expect(encodeYMD({ year: 2026, month: 10, day: 1 })).toBe(20261001);
    expect(encodeYMD({ year: 2026, month: 9, day: 30 })).toBeLessThan(encodeYMD({ year: 2026, month: 10, day: 1 }));
  });
});

describe('groupCongeRuns', () => {
  const floor = { year: 2026, month: 7, day: 1 };

  it('groups consecutive days in the same month into one block', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(1, 'Alice', 2026, 7, 6), row(1, 'Alice', 2026, 7, 7)], floor);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 7, day: 5 });
    expect(runs[0].end).toEqual({ year: 2026, month: 7, day: 7 });
    expect(runs[0].length).toBe(3);
  });

  it('groups a leave straddling two months into one block', () => {
    const rows = [
      row(1, 'Alice', 2026, 9, 28), row(1, 'Alice', 2026, 9, 29), row(1, 'Alice', 2026, 9, 30),
      row(1, 'Alice', 2026, 10, 1), row(1, 'Alice', 2026, 10, 2),
    ];
    const runs = groupCongeRuns(rows, floor);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 9, day: 28 });
    expect(runs[0].end).toEqual({ year: 2026, month: 10, day: 2 });
    expect(runs[0].length).toBe(5);
    expect(runs[0].dates).toHaveLength(5);
  });

  it('splits non-consecutive days into separate blocks', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(1, 'Alice', 2026, 7, 8)], floor);
    expect(runs).toHaveLength(2);
  });

  it('keeps different doctors in separate blocks even on adjacent days', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5), row(2, 'Bob', 2026, 7, 6)], floor);
    expect(runs).toHaveLength(2);
  });

  it('marks a block mixed when its days have different statuses', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 7, 5, 'approved'), row(1, 'Alice', 2026, 7, 6, 'pending')], floor);
    expect(runs[0].status).toBe('mixed');
  });

  it('excludes a block entirely before the floor', () => {
    const runs = groupCongeRuns([row(1, 'Alice', 2026, 6, 1), row(1, 'Alice', 2026, 6, 2)], floor);
    expect(runs).toHaveLength(0);
  });

  it('keeps a long ongoing block with its true start day (no truncation)', () => {
    // floor = 15 July; block 1–20 July ends after the floor → kept, start stays 1 July
    const f = { year: 2026, month: 7, day: 15 };
    const rows = Array.from({ length: 20 }, (_, i) => row(1, 'Alice', 2026, 7, i + 1));
    const runs = groupCongeRuns(rows, f);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toEqual({ year: 2026, month: 7, day: 1 });
    expect(runs[0].end).toEqual({ year: 2026, month: 7, day: 20 });
  });

  it('sorts blocks by soonest start first', () => {
    const rows = [row(1, 'Alice', 2026, 9, 10), row(2, 'Bob', 2026, 7, 20)];
    const runs = groupCongeRuns(rows, floor);
    expect(runs.map((r) => r.name)).toEqual(['Bob', 'Alice']);
  });
});

// Pure logic for the admin leave-request list: grouping consecutive days into
// calendar-accurate blocks, applying the "upcoming" floor, and sorting. No DB access.

export type YMD = { year: number; month: number; day: number };
export type CongeStatus = 'pending' | 'approved' | 'refused';

export type CongeRun = {
  doctorId: number;
  name: string;
  start: YMD;
  end: YMD;
  length: number;
  dates: YMD[];
  status: CongeStatus | 'mixed';
  note: string | null;
};

export type CongeDayRow = {
  doctorId: number;
  name: string;
  year: number;
  month: number;
  day: number;
  congeStatus: string | null;
  congeNote: string | null;
};

const DAY_MS = 86_400_000;

/** UTC epoch ms for a calendar date. UTC avoids any DST offset when comparing days. */
export const ymdToUTC = (d: YMD): number => Date.UTC(d.year, d.month - 1, d.day);

/** Shift a calendar date by whole days, crossing month/year boundaries correctly. */
export const shiftDays = (d: YMD, delta: number): YMD => {
  const t = new Date(ymdToUTC(d) + delta * DAY_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};

/** Ordinal integer for a date: 2026-10-01 -> 20261001. Matches the SQL expression. */
export const encodeYMD = (d: YMD): number => d.year * 10000 + d.month * 100 + d.day;

/**
 * Group per-day leave rows (pre-sorted by doctorId then date ascending) into
 * consecutive-day blocks per doctor, keep only blocks whose end date is >= floor,
 * and sort the result by soonest start first.
 */
export function groupCongeRuns(rows: CongeDayRow[], floor: YMD): CongeRun[] {
  const runs: CongeRun[] = [];
  let cur: CongeRun | null = null;
  let statuses = new Set<string>();
  let notes = new Set<string>();

  const flush = () => {
    if (cur) {
      cur.length = cur.dates.length;
      cur.end = cur.dates[cur.dates.length - 1];
      cur.status = statuses.size === 1 ? ([...statuses][0] as CongeStatus) : 'mixed';
      cur.note = notes.size ? [...notes].join(' ') : null;
      runs.push(cur);
    }
    cur = null;
    statuses = new Set();
    notes = new Set();
  };

  for (const r of rows) {
    const ymd: YMD = { year: r.year, month: r.month, day: r.day };
    const st = r.congeStatus ?? 'pending';
    const prev = cur ? cur.dates[cur.dates.length - 1] : null;
    const adjacent = cur && prev !== null && cur.doctorId === r.doctorId && ymdToUTC(ymd) === ymdToUTC(prev) + DAY_MS;
    if (adjacent) {
      cur!.dates.push(ymd);
    } else {
      flush();
      cur = { doctorId: r.doctorId, name: r.name, start: ymd, end: ymd, length: 1, dates: [ymd], status: 'pending', note: null };
    }
    statuses.add(st);
    if (r.congeNote) notes.add(r.congeNote);
  }
  flush();

  const floorT = ymdToUTC(floor);
  return runs
    .filter((run) => ymdToUTC(run.end) >= floorT)
    .sort((a, b) => ymdToUTC(a.start) - ymdToUTC(b.start) || a.name.localeCompare(b.name));
}

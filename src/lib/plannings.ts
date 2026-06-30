// Data access for published plannings (the consultable monthly schedule).
import { query, queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';

export type PlanningRow = {
  year: number;
  month: number;
  grid: Record<string, Record<number, string>>;
  days: { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean }[];
  garde_equity: unknown;
};

export async function savePublished(
  year: number,
  month: number,
  grid: unknown,
  days: unknown,
  gardeEquity: unknown,
): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO plannings (year, month, status, grid, days, garde_equity)
     VALUES ($1, $2, 'published', $3::jsonb, $4::jsonb, $5::jsonb)
     ON CONFLICT (year, month) DO UPDATE
       SET status = 'published', grid = EXCLUDED.grid, days = EXCLUDED.days,
           garde_equity = EXCLUDED.garde_equity, created_at = now()`,
    [year, month, JSON.stringify(grid), JSON.stringify(days), JSON.stringify(gardeEquity)],
  );
}

export async function getPublished(year: number, month: number): Promise<PlanningRow | null> {
  await ensureSchema();
  const row = await queryOne<Record<string, unknown>>(
    `SELECT year, month, grid, days, garde_equity FROM plannings
     WHERE year = $1 AND month = $2 AND status = 'published'`,
    [year, month],
  );
  if (!row) return null;
  // jsonb columns can come back as strings depending on the driver (postgres-js) — normalise.
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    year: row.year as number,
    month: row.month as number,
    grid: parse(row.grid),
    days: parse(row.days),
    garde_equity: parse(row.garde_equity),
  } as PlanningRow;
}

export async function listPublishedMonths(): Promise<{ year: number; month: number }[]> {
  await ensureSchema();
  return query<{ year: number; month: number }>(
    `SELECT year, month FROM plannings WHERE status = 'published' ORDER BY year, month`,
  );
}

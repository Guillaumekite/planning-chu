// Data access for doctor availability (shared, in the database).
import { query } from '@/db/client';
import { ensureSchema } from '@/db/schema';

export type AvailState = 'dispo' | 'souhait_garde' | 'no_garde' | 'conge';
/** doctor name → (day → state) */
export type AvailabilityByName = Record<string, Record<number, AvailState>>;
/** doctor name → (day → conge approval status) */
export type CongeStatusByName = Record<string, Record<number, string>>;

export async function getAvailability(
  year: number,
  month: number,
  doctorId?: number,
): Promise<{ availability: AvailabilityByName; congeStatus: CongeStatusByName }> {
  await ensureSchema();
  const params: unknown[] = [year, month];
  let where = 'a.year = $1 AND a.month = $2';
  if (doctorId != null) { params.push(doctorId); where += ` AND a.doctor_id = $3`; }
  const rows = await query<{ name: string; day: number; state: AvailState; conge_status: string | null }>(
    `SELECT d.name, a.day, a.state, a.conge_status
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE ${where}`,
    params,
  );
  const availability: AvailabilityByName = {};
  const congeStatus: CongeStatusByName = {};
  for (const r of rows) {
    (availability[r.name] ??= {})[r.day] = r.state;
    if (r.conge_status) (congeStatus[r.name] ??= {})[r.day] = r.conge_status;
  }
  return { availability, congeStatus };
}

export type CongeStatus = 'pending' | 'approved' | 'refused';
export type CongeRun = {
  doctorId: number;
  name: string;
  startDay: number;
  endDay: number;
  length: number;
  days: number[];
  status: CongeStatus | 'mixed';
};

/** List leave requests grouped into consecutive-day runs, for the admin validation screen. */
export async function listCongeRuns(year: number, month: number): Promise<CongeRun[]> {
  await ensureSchema();
  const rows = await query<{ doctor_id: number; name: string; day: number; conge_status: string | null }>(
    `SELECT a.doctor_id, d.name, a.day, a.conge_status
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE a.year = $1 AND a.month = $2 AND a.state = 'conge'
     ORDER BY d.name, a.day`,
    [year, month],
  );
  const runs: CongeRun[] = [];
  let cur: CongeRun | null = null;
  let statuses: Set<string> = new Set();
  const flush = () => {
    if (cur) {
      cur.length = cur.days.length;
      cur.endDay = cur.days[cur.days.length - 1];
      cur.status = statuses.size === 1 ? ([...statuses][0] as CongeStatus) : 'mixed';
      runs.push(cur);
    }
    cur = null;
    statuses = new Set();
  };
  for (const r of rows) {
    const st = r.conge_status ?? 'pending';
    if (cur && cur.doctorId === r.doctor_id && r.day === cur.days[cur.days.length - 1] + 1) {
      cur.days.push(r.day);
    } else {
      flush();
      cur = { doctorId: r.doctor_id, name: r.name, startDay: r.day, endDay: r.day, length: 1, days: [r.day], status: 'pending' };
    }
    statuses.add(st);
  }
  flush();
  return runs;
}

/** Set the approval status on specific leave days for a doctor. */
export async function setCongeStatus(
  doctorId: number,
  year: number,
  month: number,
  days: number[],
  status: CongeStatus,
): Promise<void> {
  if (!days.length) return;
  await ensureSchema();
  const placeholders = days.map((_, i) => `$${i + 4}`).join(', ');
  await query(
    `UPDATE availability SET conge_status = $1
     WHERE doctor_id = $2 AND year = $3 AND day IN (${placeholders}) AND state = 'conge' AND month = $${days.length + 4}`,
    [status, doctorId, year, ...days, month],
  );
}

/** Upsert (or clear, when state = 'dispo') one day for one doctor. */
export async function setCell(
  doctorId: number,
  year: number,
  month: number,
  day: number,
  state: AvailState,
): Promise<void> {
  await ensureSchema();
  if (state === 'dispo') {
    await query(`DELETE FROM availability WHERE doctor_id = $1 AND year = $2 AND month = $3 AND day = $4`,
      [doctorId, year, month, day]);
    return;
  }
  const congeStatus = state === 'conge' ? 'pending' : null;
  await query(
    `INSERT INTO availability (doctor_id, year, month, day, state, conge_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (doctor_id, year, month, day)
     DO UPDATE SET state = EXCLUDED.state, conge_status = EXCLUDED.conge_status`,
    [doctorId, year, month, day, state, congeStatus],
  );
}

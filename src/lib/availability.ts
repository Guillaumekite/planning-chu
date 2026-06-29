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

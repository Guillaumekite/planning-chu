// Data access for doctor availability (shared, in the database).
import { query } from '@/db/client';
import { ensureSchema } from '@/db/schema';
import { groupCongeRuns, shiftDays, encodeYMD, type CongeRun, type CongeStatus, type YMD } from './congeRuns';

export type AvailState = 'dispo' | 'souhait_garde' | 'no_garde' | 'conge';
/** doctor name → (day → state) */
export type AvailabilityByName = Record<string, Record<number, AvailState>>;
/** doctor name → (day → conge approval status) */
export type CongeStatusByName = Record<string, Record<number, string>>;
/** doctor name → (day → refusal note) */
export type CongeNoteByName = Record<string, Record<number, string>>;
/** doctor name → (day → true) for declared university-constraint days. */
export type UnivByName = Record<string, Record<number, boolean>>;

export async function getAvailability(
  year: number,
  month: number,
  doctorId?: number,
): Promise<{ availability: AvailabilityByName; congeStatus: CongeStatusByName; congeNote: CongeNoteByName; univ: UnivByName }> {
  await ensureSchema();
  const params: unknown[] = [year, month];
  let where = 'a.year = $1 AND a.month = $2';
  if (doctorId != null) { params.push(doctorId); where += ` AND a.doctor_id = $3`; }
  const rows = await query<{ name: string; day: number; state: AvailState; conge_status: string | null; conge_note: string | null; univ: boolean }>(
    `SELECT d.name, a.day, a.state, a.conge_status, a.conge_note, a.univ
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE ${where}`,
    params,
  );
  const availability: AvailabilityByName = {};
  const congeStatus: CongeStatusByName = {};
  const congeNote: CongeNoteByName = {};
  const univ: UnivByName = {};
  for (const r of rows) {
    (availability[r.name] ??= {})[r.day] = r.state;
    if (r.conge_status) (congeStatus[r.name] ??= {})[r.day] = r.conge_status;
    if (r.conge_note) (congeNote[r.name] ??= {})[r.day] = r.conge_note;
    if (r.univ) (univ[r.name] ??= {})[r.day] = true;
  }
  return { availability, congeStatus, congeNote, univ };
}

export type { CongeRun, CongeStatus, YMD } from './congeRuns';

/** Today's calendar date in the Europe/Paris timezone. */
function parisToday(): YMD {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // "YYYY-MM-DD"
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

/**
 * All upcoming leave requests, grouped into consecutive-day blocks, across every
 * month. A block is kept when its end date is >= (today - 7 days). The SQL prefilter
 * reaches 45 days further back so a long ongoing block keeps its true start day.
 */
export async function listCongeRuns(): Promise<CongeRun[]> {
  await ensureSchema();
  const floor = shiftDays(parisToday(), -7);
  const prefilter = shiftDays(floor, -45);
  const rows = await query<{ doctor_id: number; name: string; year: number; month: number; day: number; conge_status: string | null; conge_note: string | null }>(
    `SELECT a.doctor_id, d.name, a.year, a.month, a.day, a.conge_status, a.conge_note
     FROM availability a JOIN doctors d ON d.id = a.doctor_id
     WHERE a.state = 'conge' AND (a.year * 10000 + a.month * 100 + a.day) >= $1
     ORDER BY a.doctor_id, a.year, a.month, a.day`,
    [encodeYMD(prefilter)],
  );
  return groupCongeRuns(
    rows.map((r) => ({
      doctorId: r.doctor_id, name: r.name, year: r.year, month: r.month, day: r.day,
      congeStatus: r.conge_status, congeNote: r.conge_note,
    })),
    floor,
  );
}

/**
 * Set the approval status on specific leave dates for a doctor. Dates may span
 * several months (a leave straddling a month boundary). An optional `note` is stored
 * only when refusing and non-empty; approving or resetting to pending clears it.
 */
export async function setCongeStatus(
  doctorId: number,
  dates: YMD[],
  status: CongeStatus,
  note?: string | null,
): Promise<void> {
  if (!dates.length) return;
  await ensureSchema();
  const cleanNote = status === 'refused' && note && note.trim() ? note.trim() : null;
  const encoded = dates.map(encodeYMD);
  const placeholders = encoded.map((_, i) => `$${i + 4}`).join(', ');
  await query(
    `UPDATE availability SET conge_status = $1, conge_note = $2
     WHERE doctor_id = $3 AND state = 'conge' AND (year * 10000 + month * 100 + day) IN (${placeholders})`,
    [status, cleanNote, doctorId, ...encoded],
  );
}

/**
 * Upsert one day for one doctor. `state` is the garde/congé preference; `univ` is the orthogonal
 * university-constraint marker. The row is cleared only when it carries NO information at all
 * (state = 'dispo' AND not univ) — so a "at the fac, no garde preference" day survives. A congé day
 * can never be a univ day (absent ≠ at university), so univ is forced off then.
 */
export async function setCell(
  doctorId: number,
  year: number,
  month: number,
  day: number,
  state: AvailState,
  univ = false,
): Promise<void> {
  await ensureSchema();
  const effectiveUniv = state === 'conge' ? false : univ;
  if (state === 'dispo' && !effectiveUniv) {
    await query(`DELETE FROM availability WHERE doctor_id = $1 AND year = $2 AND month = $3 AND day = $4`,
      [doctorId, year, month, day]);
    return;
  }
  const congeStatus = state === 'conge' ? 'pending' : null;
  await query(
    `INSERT INTO availability (doctor_id, year, month, day, state, conge_status, univ)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (doctor_id, year, month, day)
     DO UPDATE SET state = EXCLUDED.state, conge_status = EXCLUDED.conge_status, univ = EXCLUDED.univ`,
    [doctorId, year, month, day, state, congeStatus, effectiveUniv],
  );
}

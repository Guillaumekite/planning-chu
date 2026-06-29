// Data access for doctors, their login accounts, and the per-month roster.
import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { query, queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';

/** Readable temporary password (no ambiguous characters like O/0, l/1). */
export function generatePassword(length = 8): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < length; i++) p += chars[randomInt(chars.length)];
  return p;
}

export type DoctorRow = {
  id: number;
  name: string;
  universitaire: boolean;
  university_ratio: number;
  part_time: boolean;
  part_time_ratio: number;
  has_account: boolean;
};

export async function listDoctors(): Promise<DoctorRow[]> {
  await ensureSchema();
  return query<DoctorRow>(
    `SELECT d.id, d.name, d.universitaire, d.university_ratio, d.part_time, d.part_time_ratio,
            (u.id IS NOT NULL) AS has_account
     FROM doctors d
     LEFT JOIN users u ON u.doctor_id = d.id
     ORDER BY d.name`,
  );
}

export async function createDoctor(name: string): Promise<DoctorRow> {
  await ensureSchema();
  const row = await queryOne<DoctorRow>(
    `INSERT INTO doctors (name) VALUES ($1)
     RETURNING id, name, universitaire, university_ratio, part_time, part_time_ratio, false AS has_account`,
    [name],
  );
  return row!;
}

const EDITABLE = ['name', 'universitaire', 'university_ratio', 'part_time', 'part_time_ratio'] as const;

export async function updateDoctor(id: number, patch: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of EDITABLE) {
    if (key in patch) {
      sets.push(`${key} = $${sets.length + 1}`);
      vals.push(patch[key]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  await query(`UPDATE doctors SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
}

export async function deleteDoctor(id: number): Promise<void> {
  await query(`DELETE FROM doctors WHERE id = $1`, [id]);
}

/** Create (or reset) a login account for a doctor: username = doctor name, given password. */
export async function setAccount(doctorId: number, username: string, password: string): Promise<void> {
  await ensureSchema();
  const hash = bcrypt.hashSync(password, 10);
  await query(
    `INSERT INTO users (username, password_hash, role, doctor_id, must_change_password)
     VALUES ($1, $2, 'medecin', $3, true)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, doctor_id = EXCLUDED.doctor_id`,
    [username, hash, doctorId],
  );
}

export async function getRoster(year: number, month: number): Promise<number[]> {
  await ensureSchema();
  const rows = await query<{ doctor_id: number }>(
    `SELECT doctor_id FROM rosters WHERE year = $1 AND month = $2`,
    [year, month],
  );
  return rows.map((r) => r.doctor_id);
}

export async function setRoster(year: number, month: number, doctorIds: number[]): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM rosters WHERE year = $1 AND month = $2`, [year, month]);
  for (const id of doctorIds) {
    await query(`INSERT INTO rosters (year, month, doctor_id) VALUES ($1, $2, $3)`, [year, month, id]);
  }
}

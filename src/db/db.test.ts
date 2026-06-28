import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryOne } from './client';
import { ensureSchema } from './schema';

// Uses the embedded PGlite database (no external Postgres needed).
describe('database layer (PGlite)', () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  it('creates the schema and round-trips a doctor + user', async () => {
    await query('DELETE FROM users');
    await query('DELETE FROM doctors');

    const doc = await queryOne<{ id: number; name: string }>(
      `INSERT INTO doctors (name, part_time, part_time_ratio) VALUES ($1, $2, $3) RETURNING id, name`,
      ['FABRE', true, 50],
    );
    expect(doc?.name).toBe('FABRE');

    await query(
      `INSERT INTO users (username, password_hash, role, doctor_id) VALUES ($1, $2, $3, $4)`,
      ['FABRE', 'hash', 'medecin', doc!.id],
    );
    const user = await queryOne<{ username: string; role: string }>(
      `SELECT username, role FROM users WHERE username = $1`,
      ['FABRE'],
    );
    expect(user).toEqual({ username: 'FABRE', role: 'medecin' });
  });

  it('stores config (e.g. the view passcode) and availability', async () => {
    await query(
      `INSERT INTO app_config (key, value) VALUES ('passcode', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['chuguyane'],
    );
    const cfg = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'passcode'`);
    expect(cfg?.value).toBe('chuguyane');

    const doc = await queryOne<{ id: number }>(`SELECT id FROM doctors WHERE name = 'FABRE'`);
    await query(
      `INSERT INTO availability (doctor_id, year, month, day, state, conge_status)
       VALUES ($1, 2026, 9, 10, 'conge', 'pending')
       ON CONFLICT (doctor_id, year, month, day) DO UPDATE SET state = EXCLUDED.state`,
      [doc!.id],
    );
    const av = await queryOne<{ state: string; conge_status: string }>(
      `SELECT state, conge_status FROM availability WHERE doctor_id = $1 AND year = 2026 AND month = 9 AND day = 10`,
      [doc!.id],
    );
    expect(av).toEqual({ state: 'conge', conge_status: 'pending' });
  });
});

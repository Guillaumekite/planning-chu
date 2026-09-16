import { describe, it, expect, beforeAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { query, queryOne } from './client';
import { ensureSchema } from './schema';
import { setCell } from '@/lib/availability';
import { setAccount, deleteDoctor } from '@/lib/doctors';

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

  it('round-trips the tp_work marker on availability', async () => {
    const doc = await queryOne<{ id: number }>(`SELECT id FROM doctors WHERE name = 'FABRE'`);
    await query(
      `INSERT INTO availability (doctor_id, year, month, day, state, tp_work)
       VALUES ($1, 2026, 9, 12, 'dispo', true)
       ON CONFLICT (doctor_id, year, month, day)
       DO UPDATE SET state = EXCLUDED.state, tp_work = EXCLUDED.tp_work`,
      [doc!.id],
    );
    const av = await queryOne<{ state: string; tp_work: boolean }>(
      `SELECT state, tp_work FROM availability WHERE doctor_id = $1 AND year = 2026 AND month = 9 AND day = 12`,
      [doc!.id],
    );
    expect(av).toEqual({ state: 'dispo', tp_work: true });
  });

  it('setCell : G+ (souhait_garde) est exclusif du marqueur TP off — tp_work forcé à false', async () => {
    const doc = await queryOne<{ id: number }>(`SELECT id FROM doctors WHERE name = 'FABRE'`);
    await setCell(doc!.id, 2026, 9, 14, 'souhait_garde', false, true); // tpWork demandé mais G+ → refusé
    const av = await queryOne<{ state: string; tp_work: boolean }>(
      `SELECT state, tp_work FROM availability WHERE doctor_id = $1 AND year = 2026 AND month = 9 AND day = 14`,
      [doc!.id],
    );
    expect(av).toEqual({ state: 'souhait_garde', tp_work: false });
  });

  // Regression: resetting a password after a case-only rename must NOT create a
  // duplicate account. The account is keyed by doctor_id, not username — otherwise
  // the INSERT ON CONFLICT (username) inserted a second row and login (which matches
  // lower(username)) returned the stale row, rejecting the new password.
  it('reset after a case-only rename keeps one account and the new password works', async () => {
    await query('DELETE FROM users');
    await query('DELETE FROM doctors');

    const doc = await queryOne<{ id: number }>(
      `INSERT INTO doctors (name) VALUES ($1) RETURNING id`,
      ['Nguyen'],
    );
    await setAccount(doc!.id, 'Nguyen', 'oldpass'); // original account
    await setAccount(doc!.id, 'NGUYEN', 'newpass'); // renamed doctor -> reset

    const count = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE doctor_id = $1`,
      [doc!.id],
    );
    expect(count?.n).toBe(1);

    // Login exactly as /api/auth/login does it (case-insensitive lookup).
    const user = await queryOne<{ password_hash: string }>(
      `SELECT * FROM users WHERE lower(username) = lower($1)`,
      ['NGUYEN'],
    );
    expect(user && bcrypt.compareSync('newpass', user.password_hash)).toBe(true);
  });

  // Regression: deleting a doctor left the users row behind (doctor_id set to NULL by
  // the FK). Re-creating a doctor with the same name then made "créer le compte" fail
  // silently: the INSERT hit the unique(username) constraint against the orphaned row.
  it('supprimer un médecin supprime aussi son compte ; recréer le même nom permet de créer le compte', async () => {
    await query('DELETE FROM users');
    await query('DELETE FROM doctors');

    const doc1 = await queryOne<{ id: number }>(
      `INSERT INTO doctors (name) VALUES ($1) RETURNING id`,
      ['Martin'],
    );
    await setAccount(doc1!.id, 'Martin', 'pass1');
    await deleteDoctor(doc1!.id);

    const orphans = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE lower(username) = 'martin'`,
    );
    expect(orphans?.n).toBe(0); // no orphaned account left behind

    // Re-create a doctor with the same name and create their account (the admin button).
    const doc2 = await queryOne<{ id: number }>(
      `INSERT INTO doctors (name) VALUES ($1) RETURNING id`,
      ['Martin'],
    );
    await setAccount(doc2!.id, 'Martin', 'pass2'); // must not throw on unique(username)

    const user = await queryOne<{ doctor_id: number; password_hash: string }>(
      `SELECT * FROM users WHERE lower(username) = 'martin'`,
    );
    expect(user?.doctor_id).toBe(doc2!.id);
    expect(user && bcrypt.compareSync('pass2', user.password_hash)).toBe(true);
  });

  // Even if an orphaned row already exists in a deployed DB (deleted doctor from before
  // the fix), setAccount must reclaim the username instead of crashing on unique(username).
  it('setAccount récupère un username orphelin (ligne users sans doctor)', async () => {
    await query('DELETE FROM users');
    await query('DELETE FROM doctors');

    // Orphaned account: doctor deleted long ago, FK left doctor_id NULL.
    await query(
      `INSERT INTO users (username, password_hash, role, doctor_id) VALUES ('Durand', 'oldhash', 'medecin', NULL)`,
    );

    const doc = await queryOne<{ id: number }>(
      `INSERT INTO doctors (name) VALUES ($1) RETURNING id`,
      ['Durand'],
    );
    await setAccount(doc!.id, 'Durand', 'newpass'); // must not throw

    const rows = await query<{ doctor_id: number | null; password_hash: string }>(
      `SELECT doctor_id, password_hash FROM users WHERE lower(username) = 'durand'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].doctor_id).toBe(doc!.id);
    expect(bcrypt.compareSync('newpass', rows[0].password_hash)).toBe(true);
  });

  // doctors.name UNIQUE is case-SENSITIVE, so 'Dupont' and 'DUPONT' can coexist as two
  // living doctors. Reclaiming the username must NOT silently delete the other doctor's
  // account — it must fail loudly so the admin sees the conflict.
  it("setAccount refuse d'écraser le compte d'un autre médecin homonyme (casse différente)", async () => {
    await query('DELETE FROM users');
    await query('DELETE FROM doctors');

    const d1 = await queryOne<{ id: number }>(`INSERT INTO doctors (name) VALUES ('Dupont') RETURNING id`);
    await setAccount(d1!.id, 'Dupont', 'pass1');
    const d2 = await queryOne<{ id: number }>(`INSERT INTO doctors (name) VALUES ('DUPONT') RETURNING id`);

    await expect(setAccount(d2!.id, 'DUPONT', 'pass2')).rejects.toThrow();

    // d1's account is untouched and still works.
    const rows = await query<{ doctor_id: number | null; password_hash: string }>(
      `SELECT doctor_id, password_hash FROM users WHERE lower(username) = 'dupont'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].doctor_id).toBe(d1!.id);
    expect(bcrypt.compareSync('pass1', rows[0].password_hash)).toBe(true);
  });
});

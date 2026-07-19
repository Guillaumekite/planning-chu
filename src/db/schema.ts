import bcrypt from 'bcryptjs';
import { query, queryOne } from './client';

// Idempotent schema (CREATE TABLE IF NOT EXISTS). Runs on first DB access; no migration tooling
// needed for an app this size. Same DDL works on PGlite and Postgres.
const DDL = `
CREATE TABLE IF NOT EXISTS app_config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS doctors (
  id               serial PRIMARY KEY,
  name             text UNIQUE NOT NULL,
  universitaire    boolean NOT NULL DEFAULT false,
  university_ratio integer NOT NULL DEFAULT 0,
  part_time        boolean NOT NULL DEFAULT false,
  part_time_ratio  integer NOT NULL DEFAULT 100,
  active           boolean NOT NULL DEFAULT true
);

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS acupuncture boolean NOT NULL DEFAULT false;
-- Consultation douleur (CD) weight: 0 = not eligible, 1 = simple, 2 = double (Esbuy).
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS douleur_poids integer NOT NULL DEFAULT 0;
-- "Jamais G1" : ce médecin ne prend JAMAIS le rôle G1 (ex. Dzierzek, mal de dos) — indépendant
-- de l'acupuncture, même si en pratique c'est la même personne aujourd'hui.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS force_g2 boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS users (
  id                   serial PRIMARY KEY,
  username             text UNIQUE NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'medecin',
  doctor_id            integer REFERENCES doctors(id) ON DELETE SET NULL,
  must_change_password boolean NOT NULL DEFAULT true
);

-- One row per doctor per day with a declared state. Congé carries an approval status.
CREATE TABLE IF NOT EXISTS availability (
  doctor_id    integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  year         integer NOT NULL,
  month        integer NOT NULL,
  day          integer NOT NULL,
  state        text NOT NULL,            -- dispo | souhait_garde | no_garde | conge
  conge_status text,                     -- NULL | pending | approved | refused
  PRIMARY KEY (doctor_id, year, month, day)
);

-- University-constraint marker: orthogonal to the state column (e.g. souhait_garde AND univ together).
ALTER TABLE availability ADD COLUMN IF NOT EXISTS univ boolean NOT NULL DEFAULT false;

-- Optional reason the admin gives when refusing a leave request (shown to the doctor).
ALTER TABLE availability ADD COLUMN IF NOT EXISTS conge_note text;

-- Which doctors work a given month (the admin's per-month roster).
CREATE TABLE IF NOT EXISTS rosters (
  year      integer NOT NULL,
  month     integer NOT NULL,
  doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  PRIMARY KEY (year, month, doctor_id)
);

-- Generated plannings (one per month). grid/days/equity stored as JSON.
CREATE TABLE IF NOT EXISTS plannings (
  id           serial PRIMARY KEY,
  year         integer NOT NULL,
  month        integer NOT NULL,
  status       text NOT NULL DEFAULT 'draft',  -- draft | published
  grid         jsonb NOT NULL,
  days         jsonb NOT NULL,
  garde_equity jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);
`;

let ready: Promise<void> | null = null;

/** Ensure the schema exists. Safe to call repeatedly. */
export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // PGlite executes one statement per call; split on ';'.
      for (const stmt of DDL.split(';')) {
        const s = stmt.trim();
        if (s) await query(s);
      }
      await runConfigMigrations();
    })();
  }
  return ready;
}

/**
 * One-off data migrations, each guarded by a flag in app_config so they run exactly
 * once even on an already-deployed database. Idempotent and safe to call repeatedly.
 */
async function runConfigMigrations(): Promise<void> {
  // v1: reset the admin account to the fixed password `medecin973` (was `chuguyane`).
  const done = await queryOne<{ value: string }>(
    `SELECT value FROM app_config WHERE key = 'admin_pw_reset_v1'`,
  );
  if (!done) {
    const hash = bcrypt.hashSync('medecin973', 10);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = false WHERE role = 'admin'`,
      [hash],
    );
    await query(
      `INSERT INTO app_config (key, value) VALUES ('admin_pw_reset_v1', 'done') ON CONFLICT (key) DO NOTHING`,
    );
  }

  // v2: seed the new "Jamais G1" flag from the acupuncture flag — the acupuncture doctor
  // (Dzierzek) is the one who must never be G1. Runs once; the admin can adjust afterwards.
  const seeded = await queryOne<{ value: string }>(
    `SELECT value FROM app_config WHERE key = 'force_g2_seed_v1'`,
  );
  if (!seeded) {
    await query(`UPDATE doctors SET force_g2 = true WHERE acupuncture = true`);
    await query(
      `INSERT INTO app_config (key, value) VALUES ('force_g2_seed_v1', 'done') ON CONFLICT (key) DO NOTHING`,
    );
  }
}

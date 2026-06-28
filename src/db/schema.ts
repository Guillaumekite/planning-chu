import { query } from './client';

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
    })();
  }
  return ready;
}

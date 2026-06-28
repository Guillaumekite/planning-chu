// One-off: ensure the schema exists and seed base config. Run with a DATABASE_URL pointing at
// the target Postgres (locally it falls back to PGlite). Safe to run repeatedly (idempotent).
import bcrypt from 'bcryptjs';
import { ensureSchema } from './schema';
import { query, queryOne } from './client';

async function main() {
  await ensureSchema();
  await query(
    `INSERT INTO app_config (key, value) VALUES ('passcode', $1)
     ON CONFLICT (key) DO NOTHING`,
    ['chuguyane'],
  );

  // Bootstrap an admin account on first run so the chief can log in and create the others.
  const userCount = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  if (userCount?.n === 0) {
    const hash = bcrypt.hashSync('chuguyane', 10);
    await query(
      `INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', $1, 'admin', true)`,
      [hash],
    );
    console.log("Compte admin créé : nom 'admin' / mot de passe 'chuguyane' (à changer).");
  }

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const passcode = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'passcode'`);
  const doctors = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM doctors`);

  console.log('Tables :', tables.map((t) => t.table_name).join(', '));
  console.log('Passcode :', passcode?.value);
  console.log('Médecins en base :', doctors?.n);
  console.log('✓ Base initialisée.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

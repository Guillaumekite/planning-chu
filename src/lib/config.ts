// Interrupteur de l'équité V2 (solde de gardes, spec 2026-10-21) — clé app_config
// `equity_v2`, valeurs 'on'/'off'. ABSENTE = ON (la décision du 21/10). Le retour arrière
// prod = passer à 'off' : la génération suivante reprend l'ancien comportement à l'identique.
import { query, queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';

export async function getEquityV2(): Promise<boolean> {
  await ensureSchema();
  const row = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'equity_v2'`);
  return row ? row.value !== 'off' : true;
}

export async function setEquityV2(on: boolean): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO app_config (key, value) VALUES ('equity_v2', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [on ? 'on' : 'off'],
  );
}

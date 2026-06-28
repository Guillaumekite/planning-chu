// Unified database access. Same SQL runs everywhere:
//   - Production (Vercel): connects to Postgres via DATABASE_URL (Vercel Postgres / Neon).
//   - Local dev / tests: an embedded Postgres (PGlite, WASM) in ./.pglite — zero setup.
// Both use $1, $2… placeholders, so query strings are identical.

type Row = Record<string, unknown>;
type QueryFn = (text: string, params?: unknown[]) => Promise<Row[]>;

declare global {
  // Reuse the connection across hot reloads / invocations.
  // eslint-disable-next-line no-var
  var __dbQuery: QueryFn | undefined;
}

async function makeQuery(): Promise<QueryFn> {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(url, { max: 1 });
    return async (text, params = []) =>
      (await sql.unsafe(text, params as Parameters<typeof sql.unsafe>[1])) as unknown as Row[];
  }
  // Local embedded Postgres.
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite('./.pglite');
  return async (text, params = []) => {
    const res = await db.query(text, params);
    return (res as { rows: Row[] }).rows;
  };
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!globalThis.__dbQuery) globalThis.__dbQuery = await makeQuery();
  return (await globalThis.__dbQuery(text, params)) as T[];
}

/** Convenience for single-row queries. */
export async function queryOne<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

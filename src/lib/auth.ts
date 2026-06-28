// Lightweight server-side auth: signed cookies (HMAC), no external dependency.
// The signing secret lives in the database (app_config) so no extra env var is needed.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { query, queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';

export const SESSION_COOKIE = 'pc_session';
export const VIEW_COOKIE = 'pc_view';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type Session = { userId: number; username: string; role: 'admin' | 'medecin'; doctorId: number | null };

let secretCache: string | null = null;
async function getSecret(): Promise<string> {
  if (secretCache) return secretCache;
  await ensureSchema();
  const row = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'session_secret'`);
  if (row?.value) { secretCache = row.value; return row.value; }
  const secret = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO app_config (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING`,
    [secret],
  );
  const fresh = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'session_secret'`);
  secretCache = fresh!.value;
  return secretCache;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export async function sign(payload: object): Promise<string> {
  const secret = await getSecret();
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export async function verify<T = unknown>(token: string | undefined): Promise<T | null> {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const secret = await getSecret();
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

/** Read the current logged-in session (Server Components / route handlers). */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verify<Session>(store.get(SESSION_COOKIE)?.value);
}

/** Whether the visitor has entered the view passcode. */
export async function hasViewAccess(): Promise<boolean> {
  const store = await cookies();
  const v = await verify<{ ok: boolean }>(store.get(VIEW_COOKIE)?.value);
  return !!v?.ok;
}

export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: MAX_AGE,
};

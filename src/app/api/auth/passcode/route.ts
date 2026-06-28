import { NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';
import { sign, VIEW_COOKIE, cookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

const Body = z.object({ passcode: z.string().min(1) });

export async function POST(req: Request) {
  await ensureSchema();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });

  const row = await queryOne<{ value: string }>(`SELECT value FROM app_config WHERE key = 'passcode'`);
  if (!row || parsed.data.passcode.trim() !== row.value) {
    return NextResponse.json({ error: 'Code incorrect.' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(VIEW_COOKIE, await sign({ ok: true }), cookieOptions);
  return res;
}

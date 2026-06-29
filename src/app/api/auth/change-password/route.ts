import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '@/db/client';
import { getSession, sign, SESSION_COOKIE, cookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

const Body = z.object({ newPassword: z.string().min(4) });

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Mot de passe trop court (4 caractères min).' }, { status: 400 });

  const hash = bcrypt.hashSync(parsed.data.newPassword, 10);
  await query(`UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`, [hash, s.userId]);

  const res = NextResponse.json({ ok: true, redirect: s.role === 'admin' ? '/admin' : '/disponibilites' });
  res.cookies.set(SESSION_COOKIE, await sign({ ...s, mustChangePassword: false }), cookieOptions);
  return res;
}

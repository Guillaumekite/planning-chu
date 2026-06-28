import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { queryOne } from '@/db/client';
import { ensureSchema } from '@/db/schema';
import { sign, SESSION_COOKIE, cookieOptions, type Session } from '@/lib/auth';

export const runtime = 'nodejs';

const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  asAdmin: z.boolean().optional(),
});

type UserRow = { id: number; username: string; password_hash: string; role: 'admin' | 'medecin'; doctor_id: number | null; must_change_password: boolean };

export async function POST(req: Request) {
  await ensureSchema();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { username, password, asAdmin } = parsed.data;

  const user = await queryOne<UserRow>(`SELECT * FROM users WHERE lower(username) = lower($1)`, [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return NextResponse.json({ error: 'Nom ou mot de passe incorrect.' }, { status: 401 });
  }
  if (asAdmin && user.role !== 'admin') {
    return NextResponse.json({ error: "Ce compte n'est pas administrateur." }, { status: 403 });
  }

  const session: Session = { userId: user.id, username: user.username, role: user.role, doctorId: user.doctor_id };
  const res = NextResponse.json({
    ok: true,
    role: user.role,
    mustChangePassword: user.must_change_password,
    redirect: user.role === 'admin' && asAdmin ? '/admin' : '/disponibilites',
  });
  res.cookies.set(SESSION_COOKIE, await sign(session), cookieOptions);
  return res;
}

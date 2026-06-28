import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getRoster, setRoster } from '@/lib/doctors';

export const runtime = 'nodejs';

async function requireAdmin() {
  const s = await getSession();
  return s && s.role === 'admin' ? s : null;
}

export async function GET(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return NextResponse.json({ error: 'Paramètres invalides' }, { status: 400 });
  return NextResponse.json({ doctorIds: await getRoster(year, month) });
}

const PutBody = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  doctorIds: z.array(z.number().int()),
});

export async function PUT(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  await setRoster(parsed.data.year, parsed.data.month, parsed.data.doctorIds);
  return NextResponse.json({ ok: true });
}

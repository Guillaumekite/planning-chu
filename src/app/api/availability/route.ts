import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getAvailability, setCell } from '@/lib/availability';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return NextResponse.json({ error: 'Paramètres invalides' }, { status: 400 });
  // Admins see everyone; a doctor sees only their own row.
  const doctorId = s.role === 'admin' ? undefined : s.doctorId ?? -1;
  return NextResponse.json(await getAvailability(year, month, doctorId));
}

const PutBody = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  state: z.enum(['dispo', 'souhait_garde', 'no_garde', 'conge']),
  doctorId: z.number().int().optional(),
});

export async function PUT(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });

  // A doctor can only edit their own days; an admin must say which doctor.
  const doctorId = s.role === 'admin' ? parsed.data.doctorId : s.doctorId ?? undefined;
  if (doctorId == null) return NextResponse.json({ error: 'Médecin non identifié' }, { status: 400 });

  await setCell(doctorId, parsed.data.year, parsed.data.month, parsed.data.day, parsed.data.state);
  return NextResponse.json({ ok: true });
}

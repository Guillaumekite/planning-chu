import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { listCongeRuns, setCongeStatus } from '@/lib/availability';

export const runtime = 'nodejs';

async function requireAdmin() {
  const s = await getSession();
  return s && s.role === 'admin' ? s : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  return NextResponse.json({ runs: await listCongeRuns() });
}

const PutBody = z.object({
  doctorId: z.number().int(),
  dates: z.array(z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })).min(1),
  status: z.enum(['pending', 'approved', 'refused']),
  note: z.string().max(500).optional(),
});

export async function PUT(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { doctorId, dates, status, note } = parsed.data;
  await setCongeStatus(doctorId, dates, status, note);
  return NextResponse.json({ ok: true });
}

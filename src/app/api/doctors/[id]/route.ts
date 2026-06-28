import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { updateDoctor, deleteDoctor, setAccount } from '@/lib/doctors';

export const runtime = 'nodejs';

async function requireAdmin() {
  const s = await getSession();
  return s && s.role === 'admin' ? s : null;
}

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  universitaire: z.boolean().optional(),
  university_ratio: z.number().min(0).max(100).optional(),
  part_time: z.boolean().optional(),
  part_time_ratio: z.number().min(0).max(100).optional(),
  password: z.string().min(1).optional(), // (re)set the doctor's login password
  username: z.string().min(1).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const id = Number((await params).id);
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !Number.isInteger(id)) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { password, username, ...profile } = parsed.data;
  await updateDoctor(id, profile);
  if (password && username) await setAccount(id, username, password);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  await deleteDoctor(id);
  return NextResponse.json({ ok: true });
}

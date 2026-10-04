import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { updateDoctor, deleteDoctor, setAccount, generatePassword } from '@/lib/doctors';

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
  acupuncture: z.boolean().optional(),
  acu_lundi: z.boolean().optional(),
  acu_mercredi: z.boolean().optional(),
  douleur_poids: z.number().int().min(0).max(2).optional(),
  force_g2: z.boolean().optional(), // "Jamais G1" (ex. Dzierzek)
  no_s: z.boolean().optional(), // jamais le poste S
  no_hc: z.boolean().optional(), // jamais le poste HC (hors clinique)
  presence: z.boolean().optional(), // éligible au poste P
  irm: z.boolean().optional(), // habilité au poste IRM (mardis sauf le dernier)
  password: z.string().min(1).optional(), // (re)set the doctor's login password
  username: z.string().min(1).optional(),
  generatePassword: z.boolean().optional(), // auto-generate and return a new password
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const id = Number((await params).id);
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !Number.isInteger(id)) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { password, username, generatePassword: gen, ...profile } = parsed.data;
  // Always answer JSON, even on failure — the admin UI reads `error` to show an alert
  // (a bare 500 would be a non-JSON body and the failure would be invisible).
  try {
    await updateDoctor(id, profile);
    if (gen && username) {
      const newPassword = generatePassword();
      await setAccount(id, username, newPassword);
      return NextResponse.json({ ok: true, password: newPassword });
    }
    if (password && username) await setAccount(id, username, password);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Erreur.' }, { status: 409 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  await deleteDoctor(id);
  return NextResponse.json({ ok: true });
}

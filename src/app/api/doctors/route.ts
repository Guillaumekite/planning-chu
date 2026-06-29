import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { listDoctors, createDoctor, setAccount, generatePassword } from '@/lib/doctors';

export const runtime = 'nodejs';

async function requireAdmin() {
  const s = await getSession();
  return s && s.role === 'admin' ? s : null;
}

export async function GET() {
  // Any logged-in user can read the roster of colleagues (needed by the availability page).
  if (!(await getSession())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  return NextResponse.json({ doctors: await listDoctors() });
}

const CreateBody = z.object({ name: z.string().min(1), password: z.string().min(1).optional() });

export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  try {
    const doc = await createDoctor(parsed.data.name.trim());
    // Auto-generate a temporary password on first creation (the admin shares it; the doctor
    // changes it on first login). A provided password, if any, overrides.
    const password = parsed.data.password?.trim() || generatePassword();
    await setAccount(doc.id, doc.name, password);
    return NextResponse.json({ doctor: { ...doc, has_account: true }, password });
  } catch (e) {
    const msg = (e as Error).message.includes('unique') ? 'Ce nom existe déjà.' : 'Erreur.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getEquityV2, setEquityV2 } from '@/lib/config';

export const runtime = 'nodejs';

// Interrupteur de l'équité V2 (solde de gardes) — admin uniquement. PUT { equityV2: false }
// = retour arrière prod : la génération suivante reprend l'ancien comportement à l'identique.
export async function GET() {
  const s = await getSession();
  if (!s || s.role !== 'admin') return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  return NextResponse.json({ equityV2: await getEquityV2() });
}

const PutBody = z.object({ equityV2: z.boolean() });

export async function PUT(req: Request) {
  const s = await getSession();
  if (!s || s.role !== 'admin') return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PutBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  await setEquityV2(parsed.data.equityV2);
  return NextResponse.json({ ok: true });
}

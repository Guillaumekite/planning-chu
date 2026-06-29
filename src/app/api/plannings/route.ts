import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasViewAccess } from '@/lib/auth';
import { savePublished, getPublished, listPublishedMonths } from '@/lib/plannings';

export const runtime = 'nodejs';

// GET ?year&month → one published planning; GET (no params) → list of published months.
// Readable by anyone who entered the passcode OR is logged in.
export async function GET(req: Request) {
  const allowed = (await hasViewAccess()) || (await getSession());
  if (!allowed) return NextResponse.json({ error: 'Accès refusé' }, { status: 401 });

  const url = new URL(req.url);
  const yp = url.searchParams.get('year');
  const mp = url.searchParams.get('month');
  if (yp && mp) {
    return NextResponse.json({ planning: await getPublished(Number(yp), Number(mp)) });
  }
  return NextResponse.json({ months: await listPublishedMonths() });
}

const PostBody = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  grid: z.record(z.string(), z.record(z.string(), z.string())),
  days: z.array(z.object({ day: z.number(), weekday: z.number(), isWeekend: z.boolean(), isHoliday: z.boolean() })),
  gardeEquity: z.unknown(),
});

export async function POST(req: Request) {
  const s = await getSession();
  if (!s || s.role !== 'admin') return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { year, month, grid, days, gardeEquity } = parsed.data;
  await savePublished(year, month, grid, days, gardeEquity);
  return NextResponse.json({ ok: true });
}

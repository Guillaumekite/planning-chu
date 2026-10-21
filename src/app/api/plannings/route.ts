import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession, hasViewAccess } from '@/lib/auth';
import { savePublished, getPublished, listPublishedMonths } from '@/lib/plannings';
import { missingGardeDays } from '@/lib/grid-checks';

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
  /** Contournement EXPLICITE du garde-fou « 1 G1 + 1 G2 par jour » (bandeau rouge dédié). */
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const s = await getSession();
  if (!s || s.role !== 'admin') return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  const { year, month, grid, days, gardeEquity, force } = parsed.data;
  // Garde-fou (spec 2026-10-21, TOUJOURS actif) : un jour publié sans 1 G1 + 1 G2 fausse le
  // planning et empoisonne le solde du mois suivant (3 jours troués publiés en août 2026).
  const holes = missingGardeDays(days, grid);
  if (holes.length > 0 && !force) {
    return NextResponse.json(
      {
        error: `${holes.length} jour(s) sans garde complète (1 G1 + 1 G2) : ${holes.join(', ')}.`,
        code: 'jours-sans-garde',
        days: holes,
      },
      { status: 400 },
    );
  }
  await savePublished(year, month, grid, days, gardeEquity);
  return NextResponse.json({ ok: true });
}

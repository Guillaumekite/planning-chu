import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { soldeBefore, noGardeFractionFor } from '@/lib/solde-server';

export const runtime = 'nodejs';

// GET ?year&month (admin) → solde d'entrée du mois (Σ depuis l'ancrage, mois STRICTEMENT
// antérieurs) + fraction gardable du mois demandé (pour le recalcul en direct pendant
// l'édition). Jamais publié ni stocké — consommé par l'admin seulement.
export async function GET(req: Request) {
  const s = await getSession();
  if (!s || s.role !== 'admin') return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });

  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Paramètres year/month invalides' }, { status: 400 });
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const [solde, noGardeFraction] = await Promise.all([
    soldeBefore(year, month),
    noGardeFractionFor(year, month, daysInMonth),
  ]);
  return NextResponse.json({ solde, noGardeFraction });
}

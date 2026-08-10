// Export d'un planning publié en Excel (.xlsx) ou CSV. Réservé aux admins.
import { getSession } from '@/lib/auth';
import { getPublished } from '@/lib/plannings';
import { MONTHS_FR } from '@/lib/store';
import { toCsv, toXlsx } from './render';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== 'admin') return new Response('Non autorisé', { status: 401 });

  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
  if (!year || !month || month < 1 || month > 12) {
    return new Response('Paramètres invalides', { status: 400 });
  }

  const planning = await getPublished(year, month);
  if (!planning) return new Response('Aucun planning publié pour ce mois', { status: 404 });

  const doctors = Object.keys(planning.grid).sort((a, b) => a.localeCompare(b, 'fr'));
  const filename = `planning-${MONTHS_FR[month - 1].toLowerCase()}-${year}.${format}`;

  if (format === 'csv') {
    const csv = toCsv(planning, doctors);
    return new Response('﻿' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const buffer = await toXlsx(planning, doctors, year, month);
  // exceljs types buffers as Uint8Array<ArrayBufferLike>; DOM lib wants ArrayBuffer — always true at runtime here.
  return new Response(new Blob([buffer as Uint8Array<ArrayBuffer>]), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

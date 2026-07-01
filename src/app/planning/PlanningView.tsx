'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR } from '@/lib/store';
import PlanningGrid, { type GridDay } from '@/components/PlanningGrid';

type Planning = { year: number; month: number; grid: Record<string, Record<number, string>>; days: GridDay[] };

export default function PlanningView({ loggedIn }: { loggedIn: boolean }) {
  const [months, setMonths] = useState<{ year: number; month: number }[]>([]);
  const [sel, setSel] = useState<{ year: number; month: number } | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);

  useEffect(() => {
    fetch('/api/plannings').then((r) => (r.ok ? r.json() : { months: [] })).then((d) => {
      setMonths(d.months ?? []);
      if (d.months?.length) setSel(d.months[d.months.length - 1]);
    });
  }, []);
  useEffect(() => {
    if (!sel) return;
    fetch(`/api/plannings?year=${sel.year}&month=${sel.month}`).then((r) => r.json()).then((d) => setPlanning(d.planning));
  }, [sel]);

  const doctors = planning ? Object.keys(planning.grid).sort((a, b) => a.localeCompare(b)) : [];
  const idx = sel ? months.findIndex((m) => m.year === sel.year && m.month === sel.month) : -1;

  return (
    <div className="min-h-screen font-sans text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
        <span className="font-semibold">Planning Anesthésie — CHU</span>
        {loggedIn
          ? <Link href="/disponibilites" className="text-sm text-blue-600 hover:underline">Mon espace</Link>
          : <Link href="/login" className="flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"><span aria-hidden>👤</span> Se connecter</Link>}
      </header>

      <main className="w-full p-6">
        <h1 className="mb-3 text-2xl font-bold">Planning des gardes</h1>
        {months.length > 0 && sel && (
          <div className="mb-4 flex items-center gap-2">
            <button disabled={idx <= 0} onClick={() => setSel(months[idx - 1])}
              className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40">‹</button>
            <span className="inline-block w-52 text-center text-lg font-semibold">{MONTHS_FR[sel.month - 1]} {sel.year}</span>
            <button disabled={idx >= months.length - 1} onClick={() => setSel(months[idx + 1])}
              className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40">›</button>
          </div>
        )}

        {months.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun planning publié pour l&apos;instant.</p>
        ) : !planning ? (
          <p className="text-sm text-gray-400">Chargement…</p>
        ) : (
          <PlanningGrid days={planning.days} grid={planning.grid} doctors={doctors} />
        )}
      </main>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR } from '@/lib/store';
import PlanningGrid, { type GridDay } from '@/components/PlanningGrid';

type Planning = { year: number; month: number; grid: Record<string, Record<number, string>>; days: GridDay[] };

// Fenêtre fixe de 25 mois : aujourd'hui −12 mois → aujourd'hui +12 mois.
function buildMonthWindow(): { year: number; month: number }[] {
  const now = new Date();
  const base = now.getFullYear() * 12 + now.getMonth(); // mois courant en index absolu
  const out: { year: number; month: number }[] = [];
  for (let i = -12; i <= 12; i++) {
    const abs = base + i;
    out.push({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });
  }
  return out;
}

export default function PlanningView({ loggedIn }: { loggedIn: boolean }) {
  const [range] = useState(buildMonthWindow);
  const [idx, setIdx] = useState(12); // par défaut : mois courant (centre de la fenêtre)
  // undefined = en cours de chargement ; null = mois non publié ; objet = planning publié
  const [planning, setPlanning] = useState<Planning | null | undefined>(undefined);

  const sel = range[idx];

  useEffect(() => {
    setPlanning(undefined);
    fetch(`/api/plannings?year=${sel.year}&month=${sel.month}`)
      .then((r) => r.json())
      .then((d) => setPlanning(d.planning ?? null));
  }, [sel.year, sel.month]);

  const doctors = planning ? Object.keys(planning.grid).sort((a, b) => a.localeCompare(b)) : [];

  return (
    <div className="min-h-screen font-sans text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
        <span className="font-semibold">Planning Anesthésie — CHU</span>
        {loggedIn
          ? <Link href="/disponibilites" className="text-sm text-blue-600 hover:underline">Mon espace</Link>
          : <Link href="/login" className="flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"><span aria-hidden>👤</span> Se connecter</Link>}
      </header>

      <main className="w-full p-6">
        <h1 className="mb-3 text-2xl font-bold">Planning</h1>
        <div className="mb-4 flex items-center gap-2">
          <button disabled={idx <= 0} onClick={() => setIdx(idx - 1)}
            className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40">‹</button>
          <span className="inline-block w-52 text-center text-lg font-semibold">{MONTHS_FR[sel.month - 1]} {sel.year}</span>
          <button disabled={idx >= range.length - 1} onClick={() => setIdx(idx + 1)}
            className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40">›</button>
        </div>

        {planning === undefined ? (
          <p className="text-sm text-gray-400">Chargement…</p>
        ) : planning === null ? (
          <div className="flex items-center justify-center py-32">
            <p className="text-3xl font-semibold text-gray-300">Planning non publié</p>
          </div>
        ) : (
          <PlanningGrid days={planning.days} grid={planning.grid} doctors={doctors} />
        )}
      </main>
    </div>
  );
}

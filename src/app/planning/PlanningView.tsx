'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR, WEEKDAYS_FR, postStyle } from '@/lib/store';

type Day = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };
type Planning = { year: number; month: number; grid: Record<string, Record<number, string>>; days: Day[] };

function dayMarker(weekday: number): string {
  if (weekday === 1) return 'bib·staff';
  if (weekday === 2) return 'réunion';
  if (weekday === 4) return 'staff';
  return '';
}

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

  return (
    <div className="min-h-screen font-sans text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
        <span className="font-semibold">Planning Anesthésie — CHU</span>
        {loggedIn
          ? <Link href="/disponibilites" className="text-sm text-blue-600 hover:underline">Mon espace</Link>
          : <Link href="/login" className="flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"><span aria-hidden>👤</span> Se connecter</Link>}
      </header>

      <main className="mx-auto max-w-[1400px] p-6">
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-2xl font-bold">Planning des gardes</h1>
          {months.length > 0 && (
            <select
              className="rounded border border-gray-300 px-2 py-1.5 text-sm"
              value={sel ? `${sel.year}-${sel.month}` : ''}
              onChange={(e) => { const [y, m] = e.target.value.split('-').map(Number); setSel({ year: y, month: m }); }}
            >
              {months.map((m) => <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>{MONTHS_FR[m.month - 1]} {m.year}</option>)}
            </select>
          )}
        </div>

        {months.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun planning publié pour l&apos;instant.</p>
        ) : !planning ? (
          <p className="text-sm text-gray-400">Chargement…</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="border-collapse text-center text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Médecin</th>
                  {planning.days.map((d) => (
                    <th key={d.day} className={`min-w-[36px] border-b border-gray-200 px-1 py-1 ${d.isWeekend || d.isHoliday ? 'bg-amber-100' : 'bg-gray-50'}`}>
                      <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                      <div className="font-semibold">{d.day}</div>
                      <div className="text-[8px] leading-tight text-blue-400">{dayMarker(d.weekday)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {doctors.map((doc) => (
                  <tr key={doc}>
                    <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium whitespace-nowrap">{doc}</td>
                    {planning.days.map((d) => { const post = planning.grid[doc]?.[d.day]; return <td key={d.day} className={`border border-gray-100 px-1 py-1 ${postStyle(post)}`}>{post ?? ''}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

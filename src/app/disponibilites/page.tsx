'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  loadDoctors, loadAvailability, saveAvailability,
  MONTHS_FR, WEEKDAYS_FR, AVAIL_STATES, AVAIL_INFO,
  type Doctor, type Availability, type MonthAvailability,
} from '@/lib/store';
import { buildMonth } from '@/engine/calendar';
import { DEFAULT_WEIGHTS } from '@/engine/types';

export default function DisponibilitesPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [avail, setAvail] = useState<MonthAvailability>({});
  const [loaded, setLoaded] = useState(false);
  const [brush, setBrush] = useState<Availability>('souhait_garde');
  const [painting, setPainting] = useState(false);

  useEffect(() => { setDoctors(loadDoctors()); setLoaded(true); }, []);
  useEffect(() => { if (loaded) setAvail(loadAvailability(year, month)); }, [year, month, loaded]);
  // Stop painting as soon as the mouse button is released anywhere.
  useEffect(() => {
    const up = () => setPainting(false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const active = doctors.filter((d) => d.active);
  const days = buildMonth(year, month, DEFAULT_WEIGHTS, []);
  const stateOf = (doc: string, day: number): Availability => avail[doc]?.[day] ?? 'dispo';

  // Apply the selected brush to a cell (the 'dispo' brush erases).
  function paint(doc: string, day: number) {
    const updated: MonthAvailability = { ...avail, [doc]: { ...(avail[doc] ?? {}) } };
    if (brush === 'dispo') delete updated[doc][day];
    else updated[doc][day] = brush;
    setAvail(updated);
    saveAvailability(year, month, updated);
  }
  function resetRow(doc: string) {
    const updated = { ...avail, [doc]: {} };
    setAvail(updated);
    saveAvailability(year, month, updated);
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6 font-sans text-gray-900 select-none">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Disponibilités des médecins</h1>
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:underline">← Retour admin</Link>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        Choisis un état dans la palette, puis clique (ou glisse) sur les jours pour l&apos;appliquer.
      </p>

      {/* Palette de pinceaux */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">Pinceau :</span>
        {AVAIL_STATES.map((s) => (
          <button
            key={s}
            onClick={() => setBrush(s)}
            className={`rounded px-3 py-1.5 text-sm ${AVAIL_INFO[s].cls} ${brush === s ? 'ring-2 ring-blue-500' : 'ring-1 ring-gray-300'}`}
          >
            {AVAIL_INFO[s].label ? `${AVAIL_INFO[s].label} — ` : ''}{AVAIL_INFO[s].legend}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">Mois
          <select className="ml-2 rounded border border-gray-300 px-2 py-2" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS_FR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className="text-sm">Année
          <input type="number" className="ml-2 w-24 rounded border border-gray-300 px-2 py-2" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
      </div>

      {active.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun médecin actif. Ajoute-en dans l&apos;<Link href="/admin" className="text-blue-600 hover:underline">espace admin</Link>.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="border-collapse text-center text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Médecin</th>
                {days.map((d) => (
                  <th key={d.day} className={`min-w-[30px] border-b border-gray-200 px-1 py-1 ${d.isWeekend ? 'bg-amber-100' : 'bg-gray-50'}`}>
                    <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                    <div className="font-semibold">{d.day}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((doc) => (
                <tr key={doc.name}>
                  <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium whitespace-nowrap">
                    {doc.name}
                    <button onClick={() => resetRow(doc.name)} className="ml-2 text-[10px] text-gray-400 hover:text-blue-600" title="Tout remettre à dispo">↺</button>
                  </td>
                  {days.map((d) => {
                    const info = AVAIL_INFO[stateOf(doc.name, d.day)];
                    return (
                      <td
                        key={d.day}
                        onMouseDown={(e) => { e.preventDefault(); setPainting(true); paint(doc.name, d.day); }}
                        onMouseEnter={() => { if (painting) paint(doc.name, d.day); }}
                        className={`cursor-pointer border border-gray-100 px-1 py-1 text-[10px] ${info.cls}`}
                        title={`${WEEKDAYS_FR[d.weekday]} ${d.day} — ${info.legend}`}
                      >
                        {info.label}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-sm text-gray-500">
        Enregistré automatiquement. Les congés passeront au <span className="text-green-700">vert</span> une fois
        validés (ou <span className="text-red-600">rouge</span> si refusés) depuis l&apos;espace admin.
        Génère le planning dans l&apos;<Link href="/admin" className="text-blue-600 hover:underline">espace admin</Link>.
      </p>
    </main>
  );
}

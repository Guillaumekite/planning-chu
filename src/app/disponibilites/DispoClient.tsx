'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR, WEEKDAYS_FR, AVAIL_STATES, AVAIL_INFO, type Availability } from '@/lib/store';
import { buildMonth } from '@/engine/calendar';
import { DEFAULT_WEIGHTS } from '@/engine/types';

type Doc = { id: number; name: string };
type Avail = Record<string, Record<number, Availability>>;
type Conge = Record<string, Record<number, string>>;

export default function DispoClient({ isAdmin, doctorId }: { isAdmin: boolean; doctorId: number | null }) {
  const [doctors, setDoctors] = useState<Doc[]>([]);
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [avail, setAvail] = useState<Avail>({});
  const [conge, setConge] = useState<Conge>({});
  const [brush, setBrush] = useState<Availability>('souhait_garde');
  const [painting, setPainting] = useState(false);

  useEffect(() => {
    fetch('/api/doctors').then((r) => (r.ok ? r.json() : { doctors: [] })).then((d) => {
      const all: Doc[] = (d.doctors ?? []).map((x: Doc) => ({ id: x.id, name: x.name }));
      setDoctors(isAdmin ? all : all.filter((x) => x.id === doctorId));
    });
  }, [isAdmin, doctorId]);

  const loadAvail = useCallback(async () => {
    const r = await fetch(`/api/availability?year=${year}&month=${month}`);
    if (r.ok) { const d = await r.json(); setAvail(d.availability ?? {}); setConge(d.congeStatus ?? {}); }
  }, [year, month]);
  useEffect(() => { loadAvail(); }, [loadAvail]);

  useEffect(() => {
    const up = () => setPainting(false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const days = buildMonth(year, month, DEFAULT_WEIGHTS, []);
  const stateOf = (name: string, day: number): Availability => avail[name]?.[day] ?? 'dispo';

  function cellClass(name: string, day: number): { label: string; cls: string } {
    const st = stateOf(name, day);
    if (st === 'conge') {
      const status = conge[name]?.[day];
      if (status === 'approved') return { label: 'Congé', cls: 'bg-green-300 text-green-900' };
      if (status === 'refused') return { label: 'Congé', cls: 'bg-red-300 text-red-900 line-through' };
    }
    return { label: AVAIL_INFO[st].label, cls: AVAIL_INFO[st].cls };
  }

  async function paint(doc: Doc, day: number) {
    const next = brush;
    setAvail((a) => {
      const row = { ...(a[doc.name] ?? {}) };
      if (next === 'dispo') delete row[day]; else row[day] = next;
      return { ...a, [doc.name]: row };
    });
    await fetch('/api/availability', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, day, state: next, doctorId: isAdmin ? doc.id : undefined }),
    });
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6 font-sans text-gray-900 select-none">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isAdmin ? 'Disponibilités des médecins' : 'Mes disponibilités'}</h1>
        <div className="flex items-center gap-4 text-sm">
          {isAdmin && <Link href="/admin" className="font-medium text-blue-600 hover:underline">← Admin</Link>}
          <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
        </div>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        Choisis un état dans la palette, puis clique (ou glisse) sur les jours. Enregistré dans la base partagée.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">Pinceau :</span>
        {AVAIL_STATES.map((s) => (
          <button key={s} onClick={() => setBrush(s)}
            className={`rounded px-3 py-1.5 text-sm ${AVAIL_INFO[s].cls} ${brush === s ? 'ring-2 ring-blue-500' : 'ring-1 ring-gray-300'}`}>
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

      {doctors.length === 0 ? (
        <p className="text-sm text-gray-400">{isAdmin ? "Aucun médecin. Ajoute-en dans l'espace admin." : 'Ton compte n’est pas relié à une fiche médecin. Contacte l’administrateur.'}</p>
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
              {doctors.map((doc) => (
                <tr key={doc.id}>
                  <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-3 py-1 text-left font-medium whitespace-nowrap">{doc.name}</td>
                  {days.map((d) => {
                    const c = cellClass(doc.name, d.day);
                    return (
                      <td key={d.day}
                        onMouseDown={(e) => { e.preventDefault(); setPainting(true); paint(doc, d.day); }}
                        onMouseEnter={() => { if (painting) paint(doc, d.day); }}
                        className={`cursor-pointer border border-gray-100 px-1 py-1 text-[10px] ${c.cls}`}
                        title={`${WEEKDAYS_FR[d.weekday]} ${d.day}`}>
                        {c.label}
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
        Congé : <span className="rounded bg-blue-200 px-1 text-blue-800">en attente</span> →
        <span className="ml-1 rounded bg-green-300 px-1 text-green-900">validé</span> ou
        <span className="ml-1 rounded bg-red-300 px-1 text-red-900">refusé</span> par l&apos;admin.
      </p>
    </main>
  );
}

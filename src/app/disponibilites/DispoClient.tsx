'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AdminNav from '@/components/AdminNav';
import { MONTHS_FR, WEEKDAYS_FR, AVAIL_STATES, AVAIL_INFO, type Availability } from '@/lib/store';
import { buildMonth } from '@/engine/calendar';
import { DEFAULT_WEIGHTS } from '@/engine/types';

type Doc = { id: number; name: string; universitaire: boolean };
type Avail = Record<string, Record<number, Availability>>;
type Conge = Record<string, Record<number, string>>;
type CongeNote = Record<string, Record<number, string>>;
type UnivMap = Record<string, Record<number, boolean>>;
/** The garde-preference palette states plus the orthogonal "univ" toggle brush. */
type Brush = Availability | 'univ';

export default function DispoClient({ isAdmin, doctorId }: { isAdmin: boolean; doctorId: number | null }) {
  const [doctors, setDoctors] = useState<Doc[]>([]);
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [saved, setSaved] = useState<Avail>({});
  const [pending, setPending] = useState<Avail>({});
  const [conge, setConge] = useState<Conge>({});
  const [congeNote, setCongeNote] = useState<CongeNote>({});
  const [savedUniv, setSavedUniv] = useState<UnivMap>({});
  const [pendingUniv, setPendingUniv] = useState<UnivMap>({});
  const [brush, setBrush] = useState<Brush>('souhait_garde');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    fetch('/api/doctors').then((r) => (r.ok ? r.json() : { doctors: [] })).then((d) => {
      const all: Doc[] = (d.doctors ?? []).map((x: { id: number; name: string; universitaire?: boolean }) =>
        ({ id: x.id, name: x.name, universitaire: !!x.universitaire }));
      setDoctors(isAdmin ? all : all.filter((x) => x.id === doctorId));
    });
  }, [isAdmin, doctorId]);

  const loadAvail = useCallback(async () => {
    const r = await fetch(`/api/availability?year=${year}&month=${month}`);
    if (r.ok) {
      const d = await r.json();
      setSaved(d.availability ?? {}); setPending(d.availability ?? {}); setConge(d.congeStatus ?? {});
      setCongeNote(d.congeNote ?? {});
      setSavedUniv(d.univ ?? {}); setPendingUniv(d.univ ?? {});
    }
  }, [year, month]);
  useEffect(() => { loadAvail(); }, [loadAvail]);

  const days = buildMonth(year, month, DEFAULT_WEIGHTS, []);
  const dirty = JSON.stringify(saved) !== JSON.stringify(pending) || JSON.stringify(savedUniv) !== JSON.stringify(pendingUniv);
  const stateOf = (name: string, day: number): Availability => pending[name]?.[day] ?? 'dispo';
  const univOf = (name: string, day: number): boolean => !!pendingUniv[name]?.[day];
  const hasUniversitaire = doctors.some((d) => d.universitaire);

  function cellLook(name: string, day: number): { label: string; cls: string } {
    const st = stateOf(name, day);
    const u = univOf(name, day) && st !== 'conge'; // congé can't also be a fac day
    let base: { label: string; cls: string };
    if (st === 'conge') {
      const status = conge[name]?.[day];
      if (status === 'approved') base = { label: 'Congé', cls: 'bg-green-300 text-green-900' };
      else if (status === 'refused') base = { label: 'Congé', cls: 'bg-red-300 text-red-900 line-through' };
      else base = { label: AVAIL_INFO[st].label, cls: AVAIL_INFO[st].cls };
    } else {
      base = { label: AVAIL_INFO[st].label, cls: AVAIL_INFO[st].cls };
    }
    // Univ is an ORTHOGONAL marker: keep the garde-preference background, add an indigo ring, and
    // show 'U' when there's no other label (so "G+ and U" reads as G+ with an indigo ring).
    if (u) return { label: base.label || 'U', cls: `${base.cls} ring-2 ring-inset ring-indigo-500` };
    return base;
  }

  // Refused leave grouped into consecutive-day runs, with the admin's note, for the recap below the grid.
  function refusedRuns(name: string): { start: number; end: number; note?: string }[] {
    const rdays = Object.keys(conge[name] ?? {}).map(Number)
      .filter((d) => conge[name]?.[d] === 'refused').sort((a, b) => a - b);
    const runs: { start: number; end: number; note?: string }[] = [];
    for (const d of rdays) {
      const last = runs[runs.length - 1];
      if (last && d === last.end + 1) last.end = d; else runs.push({ start: d, end: d });
    }
    for (const r of runs) {
      for (let d = r.start; d <= r.end; d++) { const n = congeNote[name]?.[d]; if (n) { r.note = n; break; } }
    }
    return runs;
  }
  const m = MONTHS_FR[month - 1].toLowerCase();
  const fmtRange = (r: { start: number; end: number }) =>
    r.start === r.end ? `le ${r.start} ${m}` : `du ${r.start} au ${r.end} ${m}`;
  const anyRefused = doctors.some((d) => refusedRuns(d.name).length > 0);

  function apply(name: string, day: number) {
    setSavedMsg('');
    if (brush === 'univ') {
      setPendingUniv((p) => {
        const row = { ...(p[name] ?? {}) };
        if (row[day]) delete row[day]; else row[day] = true;
        return { ...p, [name]: row };
      });
      return;
    }
    setPending((p) => {
      const row = { ...(p[name] ?? {}) };
      if (brush === 'dispo') delete row[day]; else row[day] = brush;
      return { ...p, [name]: row };
    });
  }

  function navigate(delta: number) {
    if (dirty && !confirm('Tu as des modifications non enregistrées. Continuer sans enregistrer ?')) return;
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  }

  async function save() {
    const names = new Set([
      ...Object.keys(saved), ...Object.keys(pending), ...Object.keys(savedUniv), ...Object.keys(pendingUniv),
    ]);
    const changes: { name: string; day: number; state: Availability; univ: boolean }[] = [];
    for (const name of names) {
      const a = saved[name] ?? {}; const b = pending[name] ?? {};
      const su = savedUniv[name] ?? {}; const pu = pendingUniv[name] ?? {};
      const dayset = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(su), ...Object.keys(pu)].map(Number));
      for (const day of dayset) {
        const beforeState = a[day] ?? 'dispo'; const afterState = b[day] ?? 'dispo';
        const beforeUniv = !!su[day]; const afterUniv = !!pu[day];
        if (beforeState !== afterState || beforeUniv !== afterUniv) {
          changes.push({ name, day, state: afterState, univ: afterUniv });
        }
      }
    }
    for (const c of changes) {
      const id = doctors.find((d) => d.name === c.name)?.id;
      await fetch('/api/availability', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, day: c.day, state: c.state, univ: c.univ, doctorId: isAdmin ? id : undefined }),
      });
    }
    await loadAvail();
    setSavedMsg(`✓ ${changes.length} modification(s) enregistrée(s).`);
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <main className="w-full p-6 font-sans text-gray-900 select-none">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isAdmin ? 'Disponibilités des médecins' : 'Mes disponibilités'}</h1>
        {isAdmin ? (
          <div className="flex items-center gap-4 text-sm">
            <Link href="/planning" className="font-medium text-blue-600 hover:underline">← Planning commun</Link>
            <AdminNav active="disponibilites" />
          </div>
        ) : (
          <div className="flex items-center gap-4 text-sm">
            <Link href="/planning" className="font-medium text-blue-600 hover:underline">← Planning commun</Link>
            <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
          </div>
        )}
      </div>
      <p className="mb-4 text-sm text-gray-500">
        Choisis un état, applique-le sur les jours, puis clique <b>Enregistrer</b>.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">État :</span>
        {AVAIL_STATES.map((s) => (
          <button key={s} onClick={() => setBrush(s)}
            className={`rounded px-3 py-1.5 text-sm ${AVAIL_INFO[s].cls} ${brush === s ? 'ring-2 ring-blue-500' : 'ring-1 ring-gray-300'}`}>
            {AVAIL_INFO[s].label ? `${AVAIL_INFO[s].label} — ` : ''}{AVAIL_INFO[s].legend}
          </button>
        ))}
        {hasUniversitaire && (
          <button onClick={() => setBrush('univ')}
            className={`rounded px-3 py-1.5 text-sm text-indigo-700 ${brush === 'univ' ? 'bg-indigo-100 ring-2 ring-blue-500' : 'bg-white ring-2 ring-inset ring-indigo-400'}`}>
            U — Contrainte université (se combine avec G+/G−)
          </button>
        )}
      </div>

      {/* Tout est ancré à GAUCHE avec des largeurs fixes : rien ne se déplace selon la longueur
          du mois, et le bouton Enregistrer garde une position fixe (le message vient APRÈS). */}
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50">‹</button>
        <span className="inline-block w-52 text-center text-lg font-semibold">{MONTHS_FR[month - 1]} {year}</span>
        <button onClick={() => navigate(1)} className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50">›</button>
        <button onClick={save} disabled={!dirty} className="ml-6 w-32 rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40">Enregistrer</button>
        {dirty
          ? <span className="text-sm text-amber-600">● non enregistré</span>
          : savedMsg
            ? <span className="text-sm text-green-700">{savedMsg}</span>
            : null}
      </div>

      {doctors.length === 0 ? (
        <p className="text-sm text-gray-400">{isAdmin ? 'Aucun médecin.' : 'Ton compte n’est pas relié à une fiche médecin. Contacte l’administrateur.'}</p>
      ) : (
        // Calendrier en ligne : 1er → fin du mois sur une ligne par médecin.
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="border-collapse text-center text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-2 py-1.5 text-left">Médecin</th>
                {days.map((d) => (
                  <th key={d.day} className={`w-9 min-w-9 border-b border-gray-200 px-0 py-1 ${d.isWeekend ? 'bg-amber-100' : 'bg-gray-50'}`}>
                    <div className="text-[10px] text-gray-500">{WEEKDAYS_FR[d.weekday]}</div>
                    <div className="text-sm font-semibold">{d.day}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {doctors.map((doc) => (
                <tr key={doc.id}>
                  <td className="sticky left-0 z-10 border-r border-gray-200 bg-white px-2 py-1.5 text-left font-medium whitespace-nowrap">{doc.name}</td>
                  {days.map((d) => {
                    const c = cellLook(doc.name, d.day);
                    const refused = conge[doc.name]?.[d.day] === 'refused';
                    const note = refused ? congeNote[doc.name]?.[d.day] : undefined;
                    const title = refused ? (note ? `Congé refusé — motif : ${note}` : 'Congé refusé') : undefined;
                    return <td key={d.day} title={title} onClick={() => apply(doc.name, d.day)} className={`h-9 w-9 min-w-9 cursor-pointer border border-gray-100 p-0 text-xs ${d.isWeekend ? 'ring-1 ring-amber-100' : ''} ${c.cls}`}>{c.label || ' '}</td>;
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
        <span className="ml-1 rounded bg-red-300 px-1 text-red-900">refusé</span> par l&apos;admin (après enregistrement).
      </p>

      {anyRefused && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="mb-1 text-sm font-semibold text-red-800">Congés refusés — {MONTHS_FR[month - 1]} {year}</p>
          <ul className="space-y-1 text-sm text-red-700">
            {doctors.flatMap((doc) => refusedRuns(doc.name).map((r, i) => (
              <li key={`${doc.id}-${i}`}>
                {isAdmin && <span className="font-medium">{doc.name} — </span>}
                <span>{fmtRange(r)}</span>
                {r.note ? <span> — <span className="font-medium">motif :</span> {r.note}</span> : <span className="text-red-500"> — sans motif</span>}
              </li>
            )))}
          </ul>
        </div>
      )}
      {hasUniversitaire && (
        <p className="mt-1 text-sm text-gray-500">
          <span className="rounded px-1 ring-2 ring-inset ring-indigo-500">U</span> Contrainte université : marqueur
          indépendant (anneau indigo) — se cumule avec une préférence de garde (G+/G−) sur le même jour.
        </p>
      )}
    </main>
  );
}

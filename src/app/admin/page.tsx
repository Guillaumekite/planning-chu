'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  loadDoctors, saveDoctors, loadAvailability, MONTHS_FR, WEEKDAYS_FR, postStyle,
  type Doctor,
} from '@/lib/store';

type ApiDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };
type Equity = {
  count: Record<string, number>; weekendCount: Record<string, number>;
  heavyCount: Record<string, number>; spread: number;
};
type ApiResult =
  | { status: 'feasible'; days: ApiDay[]; grid: Record<string, Record<number, string>>; gardeEquity: Equity }
  | { status: 'infeasible'; day: number; reason: string; eligible: string[] }
  | { error: string };

function parseDays(s: string): number[] {
  return s.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
}
// Day-level markers (NOT posts): staff (Tue/Fri PM), biblio (Tue AM), réunion (Wed).
function dayMarker(weekday: number): string {
  if (weekday === 1) return 'bib·staff';
  if (weekday === 2) return 'réunion';
  if (weekday === 4) return 'staff';
  return '';
}

export default function AdminPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [holidays, setHolidays] = useState('');
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { setDoctors(loadDoctors()); setLoaded(true); }, []);
  useEffect(() => { if (loaded) saveDoctors(doctors); }, [doctors, loaded]);

  const active = doctors.filter((d) => d.active);

  function addDoctor() {
    const name = newName.trim();
    if (!name) return;
    if (doctors.some((d) => d.name.toLowerCase() === name.toLowerCase())) { alert('Ce nom existe déjà.'); return; }
    setDoctors([...doctors, { name, password: newPassword, active: true }]);
    setNewName(''); setNewPassword('');
  }
  const update = (i: number, patch: Partial<Doctor>) => setDoctors(doctors.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => setDoctors(doctors.filter((_, idx) => idx !== i));

  async function generate() {
    setResult(null);
    if (active.length < 2) { setResult({ error: 'Il faut au moins 2 médecins actifs ce mois-ci.' }); return; }
    const availability = loadAvailability(year, month);
    const profiles: Record<string, { universitaire?: boolean; universityRatio?: number; fte?: number }> = {};
    for (const d of active) {
      const p: { universitaire?: boolean; universityRatio?: number; fte?: number } = {};
      if (d.universitaire) { p.universitaire = true; p.universityRatio = d.universityRatio ?? 50; }
      if (d.partTime) p.fte = Math.max(0, Math.min(100, d.partTimeRatio ?? 100)) / 100;
      if (Object.keys(p).length) profiles[d.name] = p;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, doctors: active.map((d) => d.name), availability, profiles, holidays: parseDays(holidays) }),
      });
      setResult((await res.json()) as ApiResult);
    } catch (e) {
      setResult({ error: `Échec de l'appel : ${(e as Error).message}` });
    } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin — Planning des gardes</h1>
        <Link href="/disponibilites" className="text-sm font-medium text-blue-600 hover:underline">→ Saisie des disponibilités</Link>
      </div>
      <p className="mb-6 text-sm text-gray-500">Prototype local : médecins, profils et disponibilités sont enregistrés dans ce navigateur.</p>

      {/* Médecins */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="mb-3 text-lg font-semibold">Médecins ({doctors.length})</h2>
        <div className="mb-4 flex flex-wrap gap-2">
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Nom du médecin" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDoctor()} />
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Mot de passe" value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDoctor()} />
          <button onClick={addDoctor} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">+ Ajouter</button>
        </div>

        {doctors.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun médecin. Ajoute-en pour commencer.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-4">Ce mois</th><th className="pr-4">Nom</th>
                  <th className="pr-4">Universitaire</th><th className="pr-4">% fac</th>
                  <th className="pr-4">Temps partiel</th><th className="pr-4">% présence</th><th></th>
                </tr>
              </thead>
              <tbody>
                {doctors.map((d, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-2 pr-4"><input type="checkbox" checked={d.active} onChange={(e) => update(i, { active: e.target.checked })} /></td>
                    <td className="pr-4 font-medium whitespace-nowrap">{d.name}</td>
                    <td className="pr-4"><input type="checkbox" checked={!!d.universitaire} onChange={(e) => update(i, { universitaire: e.target.checked })} /></td>
                    <td className="pr-4">
                      {d.universitaire && (
                        <input type="number" min={0} max={100} className="w-16 rounded border border-gray-300 px-1 py-0.5"
                          value={d.universityRatio ?? 50} onChange={(e) => update(i, { universityRatio: Number(e.target.value) })} />
                      )}
                    </td>
                    <td className="pr-4"><input type="checkbox" checked={!!d.partTime} onChange={(e) => update(i, { partTime: e.target.checked })} /></td>
                    <td className="pr-4">
                      {d.partTime && (
                        <input type="number" min={0} max={100} className="w-16 rounded border border-gray-300 px-1 py-0.5"
                          value={d.partTimeRatio ?? 80} onChange={(e) => update(i, { partTimeRatio: Number(e.target.value) })} />
                      )}
                    </td>
                    <td className="text-right"><button onClick={() => remove(i)} className="text-xs text-red-600 hover:underline">supprimer</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-sm text-gray-500"><strong>{active.length}</strong> médecin(s) travailleront ce mois-ci. Les indispos/congés se règlent dans <Link href="/disponibilites" className="text-blue-600 hover:underline">Saisie des disponibilités</Link>.</p>
      </section>

      {/* Génération */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="mb-3 text-lg font-semibold">Générer le mois</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Mois
            <select className="ml-2 rounded border border-gray-300 px-2 py-2" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS_FR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="text-sm">Année
            <input type="number" className="ml-2 w-24 rounded border border-gray-300 px-2 py-2" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <label className="text-sm">Jours fériés
            <input className="ml-2 w-36 rounded border border-gray-300 px-2 py-2" placeholder="ex : 1, 8" value={holidays} onChange={(e) => setHolidays(e.target.value)} />
          </label>
          <button onClick={generate} disabled={loading} className="rounded bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
            {loading ? 'Calcul…' : 'Générer le planning'}
          </button>
        </div>
      </section>

      {result && <Result result={result} doctors={active.map((d) => d.name)} month={month} year={year} />}
    </main>
  );
}

function Result({ result, doctors, month, year }: { result: ApiResult; doctors: string[]; month: number; year: number }) {
  if ('error' in result) return <Banner>{result.error}</Banner>;
  if (result.status === 'infeasible') {
    return (
      <Banner>
        <p className="font-semibold">Mois infaisable</p>
        <p className="mt-1">{result.reason}</p>
        <p className="mt-1 text-sm">Médecins éligibles ce jour : {result.eligible.join(', ') || '—'}</p>
      </Banner>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-lg font-semibold">Planning — {MONTHS_FR[month - 1]} {year}</h2>
        <PlanningGrid days={result.days} grid={result.grid} doctors={doctors} />
        <Legend />
      </div>
      <div>
        <h2 className="mb-2 text-lg font-semibold">Équité des gardes (écart : {result.gardeEquity.spread})</h2>
        <table className="text-sm">
          <thead><tr className="border-b border-gray-300 text-left text-gray-500"><th className="py-1 pr-6">Médecin</th><th className="pr-6">Gardes</th><th className="pr-6">Week-ends</th><th>Jours pénibles</th></tr></thead>
          <tbody>
            {doctors.map((doc) => (
              <tr key={doc} className="border-b border-gray-100">
                <td className="py-1 pr-6 font-medium">{doc}</td>
                <td className="pr-6">{result.gardeEquity.count[doc] ?? 0}</td>
                <td className="pr-6">{result.gardeEquity.weekendCount[doc] ?? 0}</td>
                <td>{result.gardeEquity.heavyCount[doc] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PlanningGrid({ days, grid, doctors }: { days: ApiDay[]; grid: Record<string, Record<number, string>>; doctors: string[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="border-collapse text-center text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-3 py-1 text-left">Médecin</th>
            {days.map((d) => (
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
              {days.map((d) => {
                const post = grid[doc]?.[d.day];
                return <td key={d.day} className={`border border-gray-100 px-1 py-1 ${postStyle(post)}`}>{post ?? ''}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ['G1', 'Garde générale'], ['G2', 'Garde gynéco-obst'], ['RS', 'Repos sécurité'],
    ['U', 'Universitaire'], ['P', 'Présence'], ['Ped', 'Pédiatrie'], ['MM', 'Maternité'], ['CD', 'Consult. douleur'],
    ['BM', 'Bloc matin'], ['S', 'Service'], ['CS1', 'Consult. gén.'], ['CS2', 'Consult. gynéco'],
    ['HC', 'Hors clinique'], ['CA', 'Congé'], ['ABS', 'Indispo'],
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
      {items.map(([k, label]) => <span key={k} className={`rounded px-2 py-0.5 ${postStyle(k)}`}>{k} — {label}</span>)}
      <span className="rounded px-2 py-0.5 text-blue-400">bib·staff·réunion = moments (pas des postes)</span>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">⛔ {children}</div>;
}

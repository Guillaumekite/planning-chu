'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR } from '@/lib/store';
import PlanningGrid from '@/components/PlanningGrid';

type Doctor = {
  id: number; name: string; universitaire: boolean; university_ratio: number;
  part_time: boolean; part_time_ratio: number; has_account: boolean;
};
type ApiDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };
type Equity = { count: Record<string, number>; weekendCount: Record<string, number>; heavyCount: Record<string, number>; spread: number };
type GenResult =
  | { status: 'feasible'; days: ApiDay[]; grid: Record<string, Record<number, string>>; gardeEquity: Equity }
  | { status: 'infeasible'; day: number; reason: string; eligible: string[] }
  | { error: string };

function parseDays(s: string): number[] {
  return s.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
}

export default function AdminClient() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [rosterIds, setRosterIds] = useState<Set<number>>(new Set());
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [newName, setNewName] = useState('');
  const [holidays, setHolidays] = useState('');
  const [result, setResult] = useState<GenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [credential, setCredential] = useState<{ name: string; password: string } | null>(null);

  const loadDoctors = useCallback(async () => {
    const res = await fetch('/api/doctors');
    if (res.ok) setDoctors((await res.json()).doctors);
  }, []);
  const loadRoster = useCallback(async () => {
    const res = await fetch(`/api/roster?year=${year}&month=${month}`);
    if (res.ok) setRosterIds(new Set((await res.json()).doctorIds));
  }, [year, month]);

  useEffect(() => { loadDoctors(); }, [loadDoctors]);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  const active = doctors.filter((d) => rosterIds.has(d.id));

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  }

  async function addDoctor() {
    const name = newName.trim();
    if (!name) return;
    const res = await fetch('/api/doctors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error ?? 'Erreur'); return; }
    setNewName('');
    if (data.password) setCredential({ name, password: data.password });
    await loadDoctors();
  }
  async function patchDoctor(id: number, patch: Record<string, unknown>) {
    setDoctors((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    await fetch(`/api/doctors/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  }
  async function removeDoctor(id: number) {
    if (!confirm('Supprimer ce médecin et son compte ?')) return;
    await fetch(`/api/doctors/${id}`, { method: 'DELETE' });
    await loadDoctors(); await loadRoster();
  }
  async function toggleRoster(id: number) {
    const next = new Set(rosterIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setRosterIds(next);
    await fetch('/api/roster', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year, month, doctorIds: [...next] }) });
  }
  async function resetPassword(d: Doctor) {
    const res = await fetch(`/api/doctors/${d.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generatePassword: true, username: d.name }),
    });
    const data = await res.json();
    if (res.ok && data.password) { setCredential({ name: d.name, password: data.password }); await loadDoctors(); }
  }

  async function generate() {
    setResult(null);
    if (active.length < 2) { setResult({ error: 'Sélectionne au moins 2 médecins pour ce mois (case « Ce mois »).' }); return; }
    const availRes = await fetch(`/api/availability?year=${year}&month=${month}`);
    const availability = availRes.ok ? (await availRes.json()).availability ?? {} : {};
    const profiles: Record<string, { universitaire?: boolean; universityRatio?: number; fte?: number }> = {};
    for (const d of active) {
      const p: { universitaire?: boolean; universityRatio?: number; fte?: number } = {};
      if (d.universitaire) { p.universitaire = true; p.universityRatio = d.university_ratio || 50; }
      if (d.part_time) p.fte = Math.max(0, Math.min(100, d.part_time_ratio || 100)) / 100;
      if (Object.keys(p).length) profiles[d.name] = p;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, doctors: active.map((d) => d.name), availability, profiles, holidays: parseDays(holidays) }),
      });
      setResult((await res.json()) as GenResult);
    } catch (e) {
      setResult({ error: `Échec : ${(e as Error).message}` });
    } finally { setLoading(false); }
  }

  const [publishMsg, setPublishMsg] = useState('');
  async function publish() {
    if (!result || !('status' in result) || result.status !== 'feasible') return;
    setPublishMsg('');
    const res = await fetch('/api/plannings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, grid: result.grid, days: result.days, gardeEquity: result.gardeEquity }),
    });
    setPublishMsg(res.ok ? '✓ Planning publié — consultable via le code d\'accès.' : 'Échec de la publication.');
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin — Planning des gardes</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/admin/conges" className="font-medium text-blue-600 hover:underline">Congés</Link>
          <Link href="/disponibilites" className="font-medium text-blue-600 hover:underline">Disponibilités</Link>
          <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">Médecins, profils et comptes sont enregistrés dans la base partagée.</p>

      {/* Médecins */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="mb-3 text-lg font-semibold">Médecins ({doctors.length})</h2>
        <div className="mb-4 flex flex-wrap gap-2">
          <input className="rounded border border-gray-300 px-3 py-2 text-sm" placeholder="Nom du médecin" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDoctor()} />
          <button onClick={addDoctor} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">+ Ajouter</button>
          <span className="self-center text-xs text-gray-400">Le mot de passe est généré automatiquement.</span>
        </div>

        {credential && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            Identifiants de <b>{credential.name}</b> — mot de passe :{' '}
            <code className="rounded bg-white px-2 py-0.5 font-mono text-base">{credential.password}</code>{' '}
            <button onClick={() => navigator.clipboard?.writeText(credential.password)} className="ml-2 text-blue-600 hover:underline">copier</button>
            <button onClick={() => setCredential(null)} className="ml-3 text-gray-500 hover:underline">fermer</button>
            <div className="mt-1 text-xs text-amber-700">Note-le et communique-le au médecin. Il le changera à sa 1ʳᵉ connexion.</div>
          </div>
        )}

        {doctors.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun médecin. Ajoute-en pour commencer.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-4">Ce mois</th><th className="pr-4">Nom</th>
                  <th className="pr-4">Univ.</th><th className="pr-4">% fac</th>
                  <th className="pr-4">Tps partiel</th><th className="pr-4">% prés.</th>
                  <th className="pr-4">Compte</th><th></th>
                </tr>
              </thead>
              <tbody>
                {doctors.map((d) => (
                  <tr key={d.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4"><input type="checkbox" checked={rosterIds.has(d.id)} onChange={() => toggleRoster(d.id)} title="Travaille ce mois" /></td>
                    <td className="pr-4 font-medium whitespace-nowrap">{d.name}</td>
                    <td className="pr-4"><input type="checkbox" checked={d.universitaire} onChange={(e) => patchDoctor(d.id, { universitaire: e.target.checked })} /></td>
                    <td className="pr-4">{d.universitaire && <input type="number" min={0} max={100} className="w-14 rounded border border-gray-300 px-1 py-0.5" value={d.university_ratio} onChange={(e) => patchDoctor(d.id, { university_ratio: Number(e.target.value) })} />}</td>
                    <td className="pr-4"><input type="checkbox" checked={d.part_time} onChange={(e) => patchDoctor(d.id, { part_time: e.target.checked })} /></td>
                    <td className="pr-4">{d.part_time && <input type="number" min={0} max={100} className="w-14 rounded border border-gray-300 px-1 py-0.5" value={d.part_time_ratio} onChange={(e) => patchDoctor(d.id, { part_time_ratio: Number(e.target.value) })} />}</td>
                    <td className="pr-4">
                      <div className="flex items-center gap-2">
                        {d.has_account
                          ? <span className="text-green-600" title="Compte actif">✓ actif</span>
                          : <span className="text-gray-400">—</span>}
                        <button onClick={() => resetPassword(d)} className="text-xs text-blue-600 hover:underline">
                          {d.has_account ? 'réinitialiser' : 'créer le compte'}
                        </button>
                      </div>
                    </td>
                    <td className="text-right"><button onClick={() => removeDoctor(d.id)} className="text-xs text-red-600 hover:underline">suppr.</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-sm text-gray-500"><strong>{active.length}</strong> médecin(s) ce mois. Les dispos/congés se règlent dans <Link href="/disponibilites" className="text-blue-600 hover:underline">Disponibilités</Link>.</p>
      </section>

      {/* Génération */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="mb-3 text-lg font-semibold">Générer le mois</h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* Navigation par flèches, largeurs figées (stable d'un mois à l'autre) */}
          <button onClick={() => shiftMonth(-1)} className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50">‹</button>
          <span className="inline-block w-52 text-center text-lg font-semibold">{MONTHS_FR[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} className="w-10 rounded border border-gray-300 py-1.5 text-sm hover:bg-gray-50">›</button>
          <label className="ml-4 text-sm">Jours fériés
            <input className="ml-2 w-36 rounded border border-gray-300 px-2 py-2" placeholder="ex : 1, 8" value={holidays} onChange={(e) => setHolidays(e.target.value)} />
          </label>
          <button onClick={generate} disabled={loading} className="rounded bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
            {loading ? 'Calcul…' : 'Générer le planning'}
          </button>
        </div>
      </section>

      {result && 'status' in result && result.status === 'feasible' && (
        <div className="mb-4 flex items-center gap-3">
          <button onClick={publish} className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700">Publier ce planning</button>
          {publishMsg && <span className="text-sm text-green-700">{publishMsg}</span>}
        </div>
      )}
      {result && <Result result={result} doctors={active.map((d) => d.name)} month={month} year={year} />}
    </main>
  );
}

function Result({ result, doctors, month, year }: { result: GenResult; doctors: string[]; month: number; year: number }) {
  if ('error' in result) return <Banner>{result.error}</Banner>;
  if (result.status === 'infeasible') {
    return <Banner><p className="font-semibold">Mois infaisable</p><p className="mt-1">{result.reason}</p><p className="mt-1 text-sm">Éligibles : {result.eligible.join(', ') || '—'}</p></Banner>;
  }
  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-lg font-semibold">Planning — {MONTHS_FR[month - 1]} {year}</h2>
        <PlanningGrid days={result.days} grid={result.grid} doctors={doctors} />
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

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">⛔ {children}</div>;
}

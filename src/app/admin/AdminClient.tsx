'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AdminNav from '@/components/AdminNav';
import { MONTHS_FR } from '@/lib/store';
import PlanningGrid, { type GridDay } from '@/components/PlanningGrid';
import { weekdayOf, daysInMonth } from '@/engine/calendar';

type Doctor = {
  id: number; name: string; universitaire: boolean; university_ratio: number;
  part_time: boolean; part_time_ratio: number; acupuncture: boolean; douleur_poids: number; has_account: boolean;
};
type ApiDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };
type Equity = { count: Record<string, number>; weekendCount: Record<string, number>; heavyCount: Record<string, number>; spread: number };
type GenResult =
  | { status: 'feasible'; days: ApiDay[]; grid: Record<string, Record<number, string>>; gardeEquity: Equity }
  | { status: 'infeasible'; day: number; reason: string; eligible: string[] }
  | { error: string };
// A published planning as returned by GET /api/plannings (snake_case column names).
type PublishedPlanning = { days: ApiDay[]; grid: Record<string, Record<number, string>>; garde_equity: Equity | null };

function parseDays(s: string): number[] {
  return s.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
}

// Calendar days for an empty preview grid (no assignments), so a non-published month still renders.
function emptyDays(year: number, month: number, holidays: number[]): GridDay[] {
  const hs = new Set(holidays);
  const n = daysInMonth(year, month);
  const days: GridDay[] = [];
  for (let day = 1; day <= n; day++) {
    const weekday = weekdayOf(year, month, day);
    days.push({ day, weekday, isWeekend: weekday === 5 || weekday === 6, isHoliday: hs.has(day) });
  }
  return days;
}

export default function AdminClient() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [rosterIds, setRosterIds] = useState<Set<number>>(new Set());
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [newName, setNewName] = useState('');
  const [holidays, setHolidays] = useState('');
  const [acuOn, setAcuOn] = useState(true);
  const [result, setResult] = useState<GenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [credential, setCredential] = useState<{ name: string; password: string } | null>(null);
  const [publishMsg, setPublishMsg] = useState('');
  const [publishedPlanning, setPublishedPlanning] = useState<PublishedPlanning | null>(null);

  const loadDoctors = useCallback(async () => {
    const res = await fetch('/api/doctors');
    if (res.ok) setDoctors((await res.json()).doctors);
  }, []);
  const loadRoster = useCallback(async () => {
    const res = await fetch(`/api/roster?year=${year}&month=${month}`);
    if (res.ok) setRosterIds(new Set((await res.json()).doctorIds));
  }, [year, month]);
  const loadPublished = useCallback(async () => {
    const res = await fetch(`/api/plannings?year=${year}&month=${month}`);
    setPublishedPlanning(res.ok ? ((await res.json()).planning ?? null) : null);
  }, [year, month]);

  useEffect(() => { loadDoctors(); }, [loadDoctors]);
  useEffect(() => { loadRoster(); }, [loadRoster]);
  useEffect(() => { loadPublished(); }, [loadPublished]);

  const published = !!publishedPlanning;
  // A freshly generated (not yet published) draft for the current month, if any.
  const draft = result && 'status' in result && result.status === 'feasible' ? result : null;

  const active = doctors.filter((d) => rosterIds.has(d.id));

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
    setResult(null); setPublishMsg('');
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
    const availData = availRes.ok ? await availRes.json() : {};
    const availability = availData.availability ?? {};
    // Declared university-constraint days per doctor (from the orthogonal `univ` layer).
    const univConstraints: Record<string, number[]> = {};
    for (const [name, perDay] of Object.entries((availData.univ ?? {}) as Record<string, Record<string, boolean>>)) {
      const uDays = Object.entries(perDay).filter(([, v]) => v).map(([d]) => Number(d));
      if (uDays.length) univConstraints[name] = uDays;
    }
    type Profile = { universitaire?: boolean; universityRatio?: number; fte?: number; acupuncture?: boolean; douleurPoids?: number };
    const profiles: Record<string, Profile> = {};
    for (const d of active) {
      const p: Profile = {};
      if (d.universitaire) { p.universitaire = true; p.universityRatio = d.university_ratio || 50; }
      if (d.part_time) p.fte = Math.max(0, Math.min(100, d.part_time_ratio || 100)) / 100;
      if (d.acupuncture) p.acupuncture = true;
      if (d.douleur_poids) p.douleurPoids = d.douleur_poids;
      if (Object.keys(p).length) profiles[d.name] = p;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, doctors: active.map((d) => d.name), availability, profiles, univConstraints, holidays: parseDays(holidays), acupuncture: acuOn }),
      });
      setResult((await res.json()) as GenResult);
    } catch (e) {
      setResult({ error: `Échec : ${(e as Error).message}` });
    } finally { setLoading(false); }
  }

  async function publish() {
    if (!result || !('status' in result) || result.status !== 'feasible') return;
    setPublishMsg('');
    const res = await fetch('/api/plannings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, grid: result.grid, days: result.days, gardeEquity: result.gardeEquity }),
    });
    setPublishMsg(res.ok ? '✓ Planning publié — consultable via le code d\'accès.' : 'Échec de la publication.');
    // Reload from DB and drop the draft so the persistent published view (filled grid + export) takes over.
    if (res.ok) { await loadPublished(); setResult(null); }
  }

  return (
    <main className="mx-auto max-w-[1400px] p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin — Planning des gardes</h1>
        <AdminNav active="planning" />
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
                  <th className="pr-4">Acu lun.</th>
                  <th className="pr-4">Douleur</th>
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
                    <td className="pr-4"><input type="checkbox" checked={d.acupuncture} onChange={(e) => patchDoctor(d.id, { acupuncture: e.target.checked })} /></td>
                    <td className="pr-4">
                      <select className="rounded border border-gray-300 px-1 py-0.5" value={d.douleur_poids ?? 0} onChange={(e) => patchDoctor(d.id, { douleur_poids: Number(e.target.value) })}>
                        <option value={0}>Non</option>
                        <option value={1}>Simple</option>
                        <option value={2}>Double</option>
                      </select>
                    </td>
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
          <label className="ml-2 flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={acuOn} onChange={(e) => setAcuOn(e.target.checked)} /> Acupuncture
          </label>
          <button onClick={generate} disabled={loading} className="rounded bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
            {loading ? 'Calcul…' : 'Générer le planning'}
          </button>
        </div>
      </section>

      {/* Planning du mois — toujours affiché : brouillon, publié (rempli), ou aperçu vide */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Planning — {MONTHS_FR[month - 1]} {year}</h2>
          <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${published ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {published ? '● Publié' : '● Non publié'}
          </span>
          {published && (
            <span className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-gray-500">Export :</span>
              <a href={`/api/plannings/export?year=${year}&month=${month}&format=xlsx`} className="rounded border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50">Excel (.xlsx)</a>
              <a href={`/api/plannings/export?year=${year}&month=${month}&format=csv`} className="rounded border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50">CSV</a>
            </span>
          )}
        </div>

        {/* Erreurs éventuelles d'une génération */}
        {result && 'error' in result && <Banner>{result.error}</Banner>}
        {result && 'status' in result && result.status === 'infeasible' && (
          <Banner><p className="font-semibold">Mois infaisable</p><p className="mt-1">{result.reason}</p><p className="mt-1 text-sm">Éligibles : {result.eligible.join(', ') || '—'}</p></Banner>
        )}

        {draft ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <button onClick={publish} className="rounded bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700">Publier ce planning</button>
              {publishMsg && <span className="text-sm text-green-700">{publishMsg}</span>}
              <span className="text-sm text-gray-500">Brouillon généré, non encore publié.</span>
            </div>
            <PlanningGrid days={draft.days} grid={draft.grid} doctors={active.map((d) => d.name)} />
            <EquityTable equity={draft.gardeEquity} doctors={active.map((d) => d.name)} />
          </div>
        ) : publishedPlanning ? (
          <div className="space-y-6">
            <PlanningGrid days={publishedPlanning.days} grid={publishedPlanning.grid} doctors={publishedDoctors(publishedPlanning)} />
            {publishedPlanning.garde_equity && <EquityTable equity={publishedPlanning.garde_equity} doctors={publishedDoctors(publishedPlanning)} />}
          </div>
        ) : (
          <div>
            <p className="mb-2 text-sm text-gray-500">Aucun planning publié pour ce mois — aperçu vide. Génère puis publie pour le remplir.</p>
            <PlanningGrid days={emptyDays(year, month, parseDays(holidays))} grid={{}} doctors={active.map((d) => d.name)} />
          </div>
        )}
      </section>
    </main>
  );
}

// Doctors of a published planning, sorted (fr) for a stable display order.
function publishedDoctors(p: PublishedPlanning): string[] {
  return Object.keys(p.grid).sort((a, b) => a.localeCompare(b, 'fr'));
}

function EquityTable({ equity, doctors }: { equity: Equity; doctors: string[] }) {
  return (
    <div>
      <h3 className="mb-2 text-lg font-semibold">Équité des gardes (écart : {equity.spread})</h3>
      <table className="text-sm">
        <thead><tr className="border-b border-gray-300 text-left text-gray-500"><th className="py-1 pr-6">Médecin</th><th className="pr-6">Gardes</th><th className="pr-6">Week-ends</th><th>Jours pénibles</th></tr></thead>
        <tbody>
          {doctors.map((doc) => (
            <tr key={doc} className="border-b border-gray-100">
              <td className="py-1 pr-6 font-medium">{doc}</td>
              <td className="pr-6">{equity.count[doc] ?? 0}</td>
              <td className="pr-6">{equity.weekendCount[doc] ?? 0}</td>
              <td>{equity.heavyCount[doc] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">⛔ {children}</div>;
}

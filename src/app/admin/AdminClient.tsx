'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AdminNav from '@/components/AdminNav';
import { MONTHS_FR } from '@/lib/store';
import PlanningGrid, { type GridDay } from '@/components/PlanningGrid';
import PostCounterTable from '@/components/PostCounterTable';
import CellEditor from '@/components/CellEditor';
import { checkGrid, recomputeEquity, missingGardeDays, type Grid, type GridEquity } from '@/lib/grid-checks';
import { gardeCounts, monthDues } from '@/lib/solde';
import { weekdayOf, daysInMonth } from '@/engine/calendar';

type Doctor = {
  id: number; name: string; universitaire: boolean; university_ratio: number;
  part_time: boolean; part_time_ratio: number; acupuncture: boolean;
  acu_lundi: boolean; acu_mercredi: boolean; douleur_poids: number;
  force_g2: boolean; no_s: boolean; no_hc: boolean; presence: boolean; irm: boolean; has_account: boolean;
};
type ApiDay = { day: number; weekday: number; isWeekend: boolean; isHoliday: boolean };
type Equity = { count: Record<string, number>; weekendCount: Record<string, number>; heavyCount: Record<string, number>; spread: number };
type GenResult =
  | { status: 'feasible'; days: ApiDay[]; grid: Record<string, Record<number, string>>; gardeEquity: Equity; warnings?: string[]; solde?: Record<string, number> }
  | { status: 'infeasible'; day: number; reason: string; eligible: string[] }
  | { error: string };
// Solde d'entrée du mois + fraction gardable (équité V2) — admin seulement, jamais publié.
type SoldeInfo = { solde: Record<string, number>; noGardeFraction: Record<string, number> };
// A published planning as returned by GET /api/plannings (snake_case column names).
type PublishedPlanning = { days: ApiDay[]; grid: Record<string, Record<number, string>>; garde_equity: Equity | null };
// Édition manuelle en cours (brouillon généré OU planning déjà publié).
type EditState = {
  source: 'draft' | 'published';
  days: ApiDay[];
  baseGrid: Grid;    // grille d'origine (diff visuel + annulation)
  grid: Grid;        // grille en cours d'édition
  baseEquity: GridEquity | null; // équité d'origine — porte le report des mois précédents
  doctors: string[];
};

// Clés `doc|day` des cases qui diffèrent entre la grille d'origine et l'éditée.
function diffKeys(base: Grid, grid: Grid): Set<string> {
  const keys = new Set<string>();
  for (const doc of new Set([...Object.keys(base), ...Object.keys(grid)])) {
    const a = base[doc] ?? {}, b = grid[doc] ?? {};
    for (const day of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[Number(day)] ?? '') !== (b[Number(day)] ?? '')) keys.add(`${doc}|${day}`);
    }
  }
  return keys;
}

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
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [newName, setNewName] = useState('');
  const [holidays, setHolidays] = useState('');
  const [acuOn, setAcuOn] = useState(true);
  const [result, setResult] = useState<GenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [credential, setCredential] = useState<{ name: string; password: string } | null>(null);
  const [publishMsg, setPublishMsg] = useState('');
  const [publishedPlanning, setPublishedPlanning] = useState<PublishedPlanning | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [selCell, setSelCell] = useState<{ doc: string; day: number } | null>(null);
  // Publication demandée alors que des avertissements existent : le 1er clic arme la
  // confirmation (« passer outre »), le 2e publie. Désarmée à chaque changement.
  const [confirmPublish, setConfirmPublish] = useState(false);
  // Garde-fou : jours sans 1 G1 + 1 G2 détectés à la publication — bandeau rouge dédié,
  // contournable uniquement par le bouton explicite (force). Désarmé à chaque changement.
  const [publishHoles, setPublishHoles] = useState<number[] | null>(null);
  // Équité V2 (solde) : interrupteur global + solde d'entrée du mois affiché (admin seulement).
  const [equityV2, setEquityV2] = useState<boolean | null>(null);
  const [soldeInfo, setSoldeInfo] = useState<SoldeInfo | null>(null);

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
  useEffect(() => {
    fetch('/api/config').then(async (r) => { if (r.ok) setEquityV2((await r.json()).equityV2); });
  }, []);
  useEffect(() => {
    setSoldeInfo(null);
    if (equityV2 !== true) return;
    fetch(`/api/solde?year=${year}&month=${month}`).then(async (r) => {
      if (r.ok) setSoldeInfo((await r.json()) as SoldeInfo);
    });
  }, [year, month, equityV2]);

  async function toggleEquityV2(on: boolean) {
    setEquityV2(on); // optimiste — l'interrupteur est le mécanisme de retour arrière prod
    await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ equityV2: on }) });
  }

  // « Solde après ce mois » par médecin pour une grille affichée : solde d'entrée + faites − dues.
  // Recalculé en direct pendant l'édition (les modifications manuelles comptent immédiatement).
  function soldeAfter(grid: Grid): Record<string, number> | undefined {
    if (equityV2 !== true || !soldeInfo) return undefined;
    const done = gardeCounts(grid);
    const dues = monthDues(grid, soldeInfo.noGardeFraction);
    const out: Record<string, number> = {};
    for (const doc of Object.keys(grid)) {
      out[doc] = (soldeInfo.solde[doc] ?? 0) + (done[doc] ?? 0) - (dues[doc] ?? 0);
    }
    return out;
  }

  const published = !!publishedPlanning;
  // A freshly generated (not yet published) draft for the current month, if any.
  const draft = result && 'status' in result && result.status === 'feasible' ? result : null;

  const active = doctors.filter((d) => rosterIds.has(d.id));

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
    setResult(null); setPublishMsg('');
    setEdit(null); setSelCell(null); setConfirmPublish(false); setPublishHoles(null);
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.password) { alert(data.error ?? 'Échec de la création du compte. Réessaie ou reconnecte-toi.'); return; }
    setCredential({ name: d.name, password: data.password });
    await loadDoctors();
  }

  async function generate() {
    setResult(null);
    setEdit(null); setSelCell(null); setConfirmPublish(false);
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
    // Declared part-time preferred OFF days per doctor (from the orthogonal `tp_work` layer).
    const tpPreferred: Record<string, number[]> = {};
    for (const [name, perDay] of Object.entries((availData.tpWork ?? {}) as Record<string, Record<string, boolean>>)) {
      const tDays = Object.entries(perDay).filter(([, v]) => v).map(([d]) => Number(d));
      if (tDays.length) tpPreferred[name] = tDays;
    }
    type Profile = {
      universitaire?: boolean; universityRatio?: number; fte?: number;
      acuLundi?: boolean; acuMercredi?: boolean; douleurPoids?: number;
      forceG2?: boolean; noS?: boolean; noHC?: boolean; presence?: boolean; irm?: boolean;
    };
    const profiles: Record<string, Profile> = {};
    for (const d of active) {
      const p: Profile = {};
      if (d.universitaire) { p.universitaire = true; p.universityRatio = d.university_ratio || 50; }
      if (d.part_time) p.fte = Math.max(0, Math.min(100, d.part_time_ratio || 100)) / 100;
      if (d.acu_lundi) p.acuLundi = true;
      if (d.acu_mercredi) p.acuMercredi = true;
      if (d.douleur_poids) p.douleurPoids = d.douleur_poids;
      if (d.force_g2) p.forceG2 = true; // « Jamais G1 » (ex. Dzierzek)
      if (d.no_s) p.noS = true;
      if (d.no_hc) p.noHC = true; // « Jamais HC » (ex. Dzierzek)
      if (d.presence) p.presence = true;
      if (d.irm) p.irm = true; // habilité au poste IRM (mardis sauf le dernier)
      if (Object.keys(p).length) profiles[d.name] = p;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, doctors: active.map((d) => d.name), availability, profiles, univConstraints, tpPreferred, holidays: parseDays(holidays), acupuncture: acuOn }),
      });
      setResult((await res.json()) as GenResult);
    } catch (e) {
      setResult({ error: `Échec : ${(e as Error).message}` });
    } finally { setLoading(false); }
  }

  // ---- Édition manuelle (brouillon ou publié) ----

  // Règles de profil par nom de médecin, pour les vérifications de la grille éditée.
  const rulesByName = Object.fromEntries(
    doctors.map((d) => [d.name, { forceG2: d.force_g2, noS: d.no_s, noHC: d.no_hc }]),
  );
  const editWarnings = edit ? checkGrid(edit.days, edit.grid, rulesByName) : [];
  const editEquity = edit ? recomputeEquity(edit.days, edit.grid, edit.baseEquity) : null;
  const editedKeys = edit ? diffKeys(edit.baseGrid, edit.grid) : undefined;

  function startEdit(source: 'draft' | 'published') {
    if (source === 'draft' && draft) {
      setEdit({
        source, days: draft.days,
        baseGrid: structuredClone(draft.grid), grid: structuredClone(draft.grid),
        baseEquity: draft.gardeEquity as unknown as GridEquity,
        doctors: active.map((d) => d.name),
      });
    } else if (source === 'published' && publishedPlanning) {
      setEdit({
        source, days: publishedPlanning.days,
        baseGrid: structuredClone(publishedPlanning.grid), grid: structuredClone(publishedPlanning.grid),
        baseEquity: publishedPlanning.garde_equity as unknown as GridEquity | null,
        doctors: publishedDoctors(publishedPlanning),
      });
    } else return;
    setSelCell(null); setConfirmPublish(false); setPublishMsg(''); setPublishHoles(null);
  }
  function cancelEdit() {
    setEdit(null); setSelCell(null); setConfirmPublish(false); setPublishHoles(null);
  }
  function setCell(doc: string, day: number, raw: string) {
    setEdit((prev) => {
      if (!prev) return prev;
      const grid = structuredClone(prev.grid);
      if (raw) (grid[doc] ??= {})[day] = raw;
      else if (grid[doc]) delete grid[doc][day];
      return { ...prev, grid };
    });
    setConfirmPublish(false); setPublishHoles(null);
  }

  // Publie une grille (brouillon tel quel, ou grille éditée). S'il reste des avertissements,
  // le 1er clic arme la confirmation « passer outre » et le 2e clic publie vraiment.
  // Garde-fou (toujours actif) : un jour sans 1 G1 + 1 G2 bloque la publication — seul le
  // bouton rouge dédié du bandeau (force) passe outre, et le serveur revérifie de son côté.
  async function publishGrid(grid: Grid, days: ApiDay[], gardeEquity: unknown, warnings: string[], force = false) {
    if (!force) {
      const holes = missingGardeDays(days, grid);
      if (holes.length > 0) { setPublishHoles(holes); return; }
      if (warnings.length > 0 && !confirmPublish) { setConfirmPublish(true); return; }
    }
    setPublishMsg('');
    const res = await fetch('/api/plannings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, grid, days, gardeEquity, force }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.code === 'jours-sans-garde') { setPublishHoles(data.days as number[]); return; }
      setPublishMsg('Échec de la publication.');
      return;
    }
    setPublishMsg('✓ Planning publié — consultable via le code d\'accès.');
    // Reload from DB and drop the draft so the persistent published view (filled grid + export) takes over.
    await loadPublished(); setResult(null); setEdit(null); setSelCell(null); setConfirmPublish(false); setPublishHoles(null);
  }

  // Bandeau rouge du garde-fou : liste des jours troués + bouton de contournement explicite.
  function HolesBanner({ onForce }: { onForce: () => void }) {
    if (!publishHoles) return null;
    return (
      <div className="rounded-lg border border-red-400 bg-red-50 p-3 text-sm text-red-900">
        <p className="font-semibold">
          ⛔ Publication bloquée : {publishHoles.length} jour(s) sans garde complète (1 G1 + 1 G2) — jours {publishHoles.join(', ')}.
        </p>
        <p className="mt-1">Complète ces jours (✎ Modifier), ou publie en connaissance de cause : les compteurs d&apos;équité du mois suivant seront faussés.</p>
        <div className="mt-2 flex items-center gap-2">
          <button onClick={onForce} className="rounded bg-red-600 px-4 py-1.5 font-medium text-white hover:bg-red-700">
            Publier malgré {publishHoles.length} jour(s) sans garde complète
          </button>
          <button onClick={() => setPublishHoles(null)} className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50">non, revenir</button>
        </div>
      </div>
    );
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
                  <th className="pr-4" title="Acupuncture le lundi">Acu lun.</th>
                  <th className="pr-4" title="Acupuncture le mercredi (déplacée au jeudi si garde le mardi)">Acu mer.</th>
                  <th className="pr-4" title="Ce médecin ne prend jamais le rôle G1 (uniquement G2)">Jamais G1</th>
                  <th className="pr-4" title="Ce médecin ne fait jamais le poste S">Pas de S</th>
                  <th className="pr-4" title="Ce médecin ne reçoit jamais le poste HC (hors clinique)">Jamais HC</th>
                  <th className="pr-4" title="Éligible au poste P (présence) — posé quand ≥ 12 travaillants">P</th>
                  <th className="pr-4" title="Habilité au poste IRM — posé chaque mardi sauf le dernier mardi du mois">IRM</th>
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
                    <td className="pr-4"><input type="checkbox" checked={d.acu_lundi} onChange={(e) => patchDoctor(d.id, { acu_lundi: e.target.checked })} title="Acupuncture le lundi" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.acu_mercredi} onChange={(e) => patchDoctor(d.id, { acu_mercredi: e.target.checked })} title="Acupuncture le mercredi" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.force_g2} onChange={(e) => patchDoctor(d.id, { force_g2: e.target.checked })} title="Jamais G1 — uniquement G2" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.no_s} onChange={(e) => patchDoctor(d.id, { no_s: e.target.checked })} title="Jamais le poste S" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.no_hc} onChange={(e) => patchDoctor(d.id, { no_hc: e.target.checked })} title="Jamais le poste HC (hors clinique)" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.presence} onChange={(e) => patchDoctor(d.id, { presence: e.target.checked })} title="Éligible au poste P (présence)" /></td>
                    <td className="pr-4"><input type="checkbox" checked={d.irm} onChange={(e) => patchDoctor(d.id, { irm: e.target.checked })} title="Habilité au poste IRM (mardis sauf le dernier)" /></td>
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
          <label
            className="ml-2 flex items-center gap-1.5 text-sm"
            title="Équité V2 : mois plats (écart ≤ 1 à présence égale), solde cumulé depuis septembre 2026. Décocher = retour à l'ancien algorithme (rattrapage sur le seul mois précédent) dès la prochaine génération."
          >
            <input
              type="checkbox"
              checked={equityV2 ?? true}
              disabled={equityV2 === null}
              onChange={(e) => toggleEquityV2(e.target.checked)}
            /> Équité V2 (solde depuis sept. 2026)
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

        {edit && editEquity ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => publishGrid(edit.grid, edit.days, editEquity, editWarnings)}
                className={`rounded px-5 py-2 text-sm font-medium text-white ${confirmPublish ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >
                {confirmPublish
                  ? `⚠️ Confirmez-vous de publier malgré ${editWarnings.length} avertissement(s) ?`
                  : edit.source === 'published' ? 'Republier avec ces modifications' : 'Publier ce planning'}
              </button>
              {confirmPublish && (
                <button onClick={() => setConfirmPublish(false)} className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">non, revenir</button>
              )}
              <button onClick={cancelEdit} className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">Annuler les modifications</button>
              <span className="text-sm text-gray-500">
                Mode édition — clique une case pour la modifier. {editedKeys?.size ?? 0} case(s) modifiée(s).
              </span>
              {publishMsg && <span className="text-sm text-green-700">{publishMsg}</span>}
            </div>
            <HolesBanner onForce={() => publishGrid(edit.grid, edit.days, editEquity, editWarnings, true)} />
            {editWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">⚠️ Avertissements ({editWarnings.length}) — publication possible après confirmation</p>
                <ul className="mt-1 list-disc pl-5">
                  {editWarnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            {selCell && (
              <CellEditor
                doc={selCell.doc} day={selCell.day}
                value={edit.grid[selCell.doc]?.[selCell.day] ?? ''}
                onChange={(raw) => setCell(selCell.doc, selCell.day, raw)}
                onClose={() => setSelCell(null)}
              />
            )}
            <PlanningGrid
              days={edit.days} grid={edit.grid} doctors={edit.doctors}
              editable selected={selCell} editedKeys={editedKeys}
              onCellClick={(doc, day) => setSelCell({ doc, day })}
            />
            <PostCounterTable days={edit.days} grid={edit.grid} />
            <EquityTable equity={editEquity} doctors={edit.doctors} solde={soldeAfter(edit.grid)} />
          </div>
        ) : draft ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => publishGrid(draft.grid, draft.days, draft.gardeEquity, draft.warnings ?? [])}
                className={`rounded px-5 py-2 text-sm font-medium text-white ${confirmPublish ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
              >
                {confirmPublish
                  ? `⚠️ Confirmez-vous de publier malgré ${(draft.warnings ?? []).length} avertissement(s) ?`
                  : 'Publier ce planning'}
              </button>
              {confirmPublish && (
                <button onClick={() => setConfirmPublish(false)} className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">non, revenir</button>
              )}
              <button onClick={() => startEdit('draft')} className="rounded border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">✎ Modifier</button>
              {publishMsg && <span className="text-sm text-green-700">{publishMsg}</span>}
              <span className="text-sm text-gray-500">Brouillon généré, non encore publié.</span>
            </div>
            <HolesBanner onForce={() => publishGrid(draft.grid, draft.days, draft.gardeEquity, draft.warnings ?? [], true)} />
            {draft.warnings && draft.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">⚠️ À vérifier avant de publier ({draft.warnings.length})</p>
                <ul className="mt-1 list-disc pl-5">
                  {draft.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            <PlanningGrid days={draft.days} grid={draft.grid} doctors={active.map((d) => d.name)} />
            <PostCounterTable days={draft.days} grid={draft.grid} />
            <EquityTable equity={draft.gardeEquity} doctors={active.map((d) => d.name)} solde={soldeAfter(draft.grid)} />
          </div>
        ) : publishedPlanning ? (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <button onClick={() => startEdit('published')} className="rounded border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">✎ Modifier ce planning publié</button>
              {publishMsg && <span className="text-sm text-green-700">{publishMsg}</span>}
            </div>
            <PlanningGrid days={publishedPlanning.days} grid={publishedPlanning.grid} doctors={publishedDoctors(publishedPlanning)} />
            <PostCounterTable days={publishedPlanning.days} grid={publishedPlanning.grid} />
            {publishedPlanning.garde_equity && <EquityTable equity={publishedPlanning.garde_equity} doctors={publishedDoctors(publishedPlanning)} solde={soldeAfter(publishedPlanning.grid)} />}
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

// Solde formaté à la française, signe explicite : +2,3 (en avance) / −1,0 (en retard).
function fmtSolde(v: number): string {
  const s = Math.abs(v).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return v >= 0.05 ? `+${s}` : v <= -0.05 ? `−${s}` : '0,0';
}

function EquityTable({ equity, doctors, solde }: { equity: Equity; doctors: string[]; solde?: Record<string, number> }) {
  return (
    <div>
      <h3 className="mb-2 text-lg font-semibold">Équité des gardes (écart : {equity.spread})</h3>
      <table className="text-sm">
        <thead><tr className="border-b border-gray-300 text-left text-gray-500">
          <th className="py-1 pr-6">Médecin</th><th className="pr-6">Gardes</th><th className="pr-6">Week-ends</th><th className="pr-6">Jours pénibles</th>
          {solde && <th title="Solde cumulé depuis septembre 2026, ce mois inclus : positif = en avance (fera moins ensuite), négatif = en retard (prioritaire pour la garde supplémentaire). Visible par l'admin uniquement, jamais publié.">Solde après ce mois</th>}
        </tr></thead>
        <tbody>
          {doctors.map((doc) => (
            <tr key={doc} className="border-b border-gray-100">
              <td className="py-1 pr-6 font-medium">{doc}</td>
              <td className="pr-6">{equity.count[doc] ?? 0}</td>
              <td className="pr-6">{equity.weekendCount[doc] ?? 0}</td>
              <td className="pr-6">{equity.heavyCount[doc] ?? 0}</td>
              {solde && (
                <td className={(solde[doc] ?? 0) <= -1 ? 'text-red-700' : (solde[doc] ?? 0) >= 1 ? 'text-green-700' : ''}>
                  {fmtSolde(solde[doc] ?? 0)}
                </td>
              )}
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

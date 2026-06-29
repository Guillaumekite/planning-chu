'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MONTHS_FR } from '@/lib/store';

type Run = {
  doctorId: number; name: string; startDay: number; endDay: number;
  length: number; days: number[]; status: 'pending' | 'approved' | 'refused' | 'mixed';
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'En attente', cls: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Validé', cls: 'bg-green-100 text-green-800' },
  refused: { label: 'Refusé', cls: 'bg-red-100 text-red-800' },
  mixed: { label: 'Mixte', cls: 'bg-gray-100 text-gray-700' },
};

export default function CongesClient() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(4);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/conge?year=${year}&month=${month}`);
    if (r.ok) setRuns((await r.json()).runs);
    setLoading(false);
  }, [year, month]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(run: Run, status: 'approved' | 'refused' | 'pending') {
    await fetch('/api/conge', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorId: run.doctorId, year, month, days: run.days, status }),
    });
    await load();
  }

  const pending = runs.filter((r) => r.status === 'pending' || r.status === 'mixed');
  const decided = runs.filter((r) => r.status === 'approved' || r.status === 'refused');

  function fmt(run: Run) {
    const m = MONTHS_FR[month - 1].toLowerCase();
    return run.length === 1 ? `le ${run.startDay} ${m}` : `du ${run.startDay} au ${run.endDay} ${m} (${run.length} jours)`;
  }

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Demandes de congé</h1>
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:underline">← Admin</Link>
      </div>
      <p className="mb-4 text-sm text-gray-500">Valide ou refuse les congés demandés par les médecins.</p>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="text-sm">Mois
          <select className="ml-2 rounded border border-gray-300 px-2 py-2" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS_FR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className="text-sm">Année
          <input type="number" className="ml-2 w-24 rounded border border-gray-300 px-2 py-2" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
      </div>

      {loading ? <p className="text-sm text-gray-400">Chargement…</p> : (
        <>
          <h2 className="mb-2 text-lg font-semibold">À traiter ({pending.length})</h2>
          {pending.length === 0 ? <p className="mb-6 text-sm text-gray-400">Aucune demande en attente.</p> : (
            <ul className="mb-8 space-y-2">
              {pending.map((run, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg border border-gray-200 p-3">
                  <div>
                    <span className="font-medium">{run.name}</span>
                    <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                    <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setStatus(run, 'approved')} className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700">Valider</button>
                    <button onClick={() => setStatus(run, 'refused')} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Refuser</button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 text-lg font-semibold">Déjà traités ({decided.length})</h2>
          {decided.length === 0 ? <p className="text-sm text-gray-400">Rien pour l&apos;instant.</p> : (
            <ul className="space-y-2">
              {decided.map((run, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg border border-gray-100 p-3">
                  <div>
                    <span className="font-medium">{run.name}</span>
                    <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                    <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                  </div>
                  <button onClick={() => setStatus(run, 'pending')} className="text-xs text-gray-500 hover:text-blue-600">remettre en attente</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

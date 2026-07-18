'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminNav from '@/components/AdminNav';
import { MONTHS_FR } from '@/lib/store';

type YMD = { year: number; month: number; day: number };
type Run = {
  doctorId: number; name: string; start: YMD; end: YMD;
  length: number; dates: YMD[]; status: 'pending' | 'approved' | 'refused' | 'mixed';
  note: string | null;
};

const runKey = (run: Run) => `${run.doctorId}-${run.start.year}-${run.start.month}-${run.start.day}`;

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'En attente', cls: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Validé', cls: 'bg-green-100 text-green-800' },
  refused: { label: 'Refusé', cls: 'bg-red-100 text-red-800' },
  mixed: { label: 'Mixte', cls: 'bg-gray-100 text-gray-700' },
};

const monthName = (m: number) => MONTHS_FR[m - 1].toLowerCase();

function fmt(run: Run) {
  const { start: s, end: e } = run;
  if (run.length === 1) return `le ${s.day} ${monthName(s.month)}`;
  if (s.year === e.year && s.month === e.month) return `du ${s.day} au ${e.day} ${monthName(s.month)} (${run.length} jours)`;
  return `du ${s.day} ${monthName(s.month)} au ${e.day} ${monthName(e.month)} (${run.length} jours)`;
}

export default function CongesClient() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [refusingKey, setRefusingKey] = useState<string | null>(null);
  const [refuseNote, setRefuseNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch('/api/conge');
    if (r.ok) setRuns((await r.json()).runs);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setStatus(run: Run, status: 'approved' | 'refused' | 'pending', note?: string) {
    await fetch('/api/conge', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorId: run.doctorId, dates: run.dates, status, note }),
    });
    setRefusingKey(null);
    setRefuseNote('');
    await load();
  }

  function startRefuse(run: Run) {
    setRefusingKey(runKey(run));
    setRefuseNote(run.note ?? '');
  }

  const pending = runs.filter((r) => r.status === 'pending' || r.status === 'mixed');
  const decided = runs.filter((r) => r.status === 'approved' || r.status === 'refused');

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-gray-900">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Demandes de congé</h1>
        <AdminNav active="conges" />
      </div>
      <p className="mb-6 text-sm text-gray-500">Toutes les demandes à venir, de la plus proche à la plus lointaine. Valide ou refuse les congés demandés par les médecins.</p>

      {loading ? <p className="text-sm text-gray-400">Chargement…</p> : (
        <>
          <h2 className="mb-2 text-lg font-semibold">À traiter ({pending.length})</h2>
          {pending.length === 0 ? <p className="mb-6 text-sm text-gray-400">Aucune demande en attente.</p> : (
            <ul className="mb-8 space-y-2">
              {pending.map((run) => (
                <li key={runKey(run)} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{run.name}</span>
                      <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setStatus(run, 'approved')} className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700">Valider</button>
                      <button onClick={() => startRefuse(run)} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Refuser</button>
                    </div>
                  </div>
                  {refusingKey === runKey(run) && (
                    <div className="mt-3 rounded border border-red-200 bg-red-50 p-3">
                      <label className="mb-1 block text-sm font-medium text-red-800">Motif du refus (optionnel, visible par le médecin)</label>
                      <textarea
                        autoFocus rows={2} value={refuseNote} onChange={(e) => setRefuseNote(e.target.value)}
                        placeholder="Ex : effectif insuffisant cette semaine-là."
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => setStatus(run, 'refused', refuseNote)} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Confirmer le refus</button>
                        <button onClick={() => { setRefusingKey(null); setRefuseNote(''); }} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Annuler</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mb-2 text-lg font-semibold">Déjà traités ({decided.length})</h2>
          {decided.length === 0 ? <p className="text-sm text-gray-400">Rien pour l&apos;instant.</p> : (
            <ul className="space-y-2">
              {decided.map((run) => (
                <li key={runKey(run)} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{run.name}</span>
                      <span className="ml-2 text-sm text-gray-600">{fmt(run)}</span>
                      <span className={`ml-2 rounded px-2 py-0.5 text-xs ${STATUS_BADGE[run.status].cls}`}>{STATUS_BADGE[run.status].label}</span>
                    </div>
                    <button onClick={() => setStatus(run, 'pending')} className="text-xs text-gray-500 hover:text-blue-600">remettre en attente</button>
                  </div>
                  {run.status === 'refused' && run.note && (
                    <p className="mt-1 text-sm text-red-700"><span className="font-medium">Motif :</span> {run.note}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

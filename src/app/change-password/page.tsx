'use client';

import { useState } from 'react';

export default function ChangePasswordPage() {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (p1.length < 4) { setError('Au moins 4 caractères.'); return; }
    if (p1 !== p2) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: p1 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Échec.'); return; }
      window.location.href = data.redirect ?? '/disponibilites';
    } catch {
      setError('Erreur réseau.');
    } finally { setLoading(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 font-sans text-gray-900">
      <h1 className="mb-1 text-2xl font-bold">Choisis ton mot de passe</h1>
      <p className="mb-6 text-sm text-gray-500">Première connexion : définis un mot de passe personnel.</p>
      <form onSubmit={submit} className="space-y-3">
        <input type="password" className="w-full rounded border border-gray-300 px-3 py-2" placeholder="Nouveau mot de passe" value={p1} onChange={(e) => setP1(e.target.value)} autoFocus />
        <input type="password" className="w-full rounded border border-gray-300 px-3 py-2" placeholder="Confirmer" value={p2} onChange={(e) => setP2(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={loading} className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {loading ? 'Enregistrement…' : 'Valider'}
        </button>
      </form>
    </main>
  );
}

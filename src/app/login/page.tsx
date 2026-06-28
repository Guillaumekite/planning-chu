'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [asAdmin, setAsAdmin] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, asAdmin }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Échec de la connexion.'); return; }
      window.location.href = data.redirect ?? '/disponibilites';
    } catch {
      setError('Erreur réseau.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 font-sans text-gray-900">
      <Link href="/" className="mb-6 text-sm text-blue-600 hover:underline">← Accueil</Link>
      <h1 className="mb-1 text-2xl font-bold">Connexion</h1>
      <p className="mb-6 text-sm text-gray-500">Nom du médecin et mot de passe fournis par l&apos;administrateur.</p>

      <form onSubmit={submit} className="space-y-3">
        <input className="w-full rounded border border-gray-300 px-3 py-2" placeholder="Nom du médecin" value={username}
          onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input type="password" className="w-full rounded border border-gray-300 px-3 py-2" placeholder="Mot de passe" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
          Je suis administrateur
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={loading} className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </main>
  );
}

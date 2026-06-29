'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function Home() {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/passcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Code incorrect.'); return; }
      window.location.href = '/planning';
      return;
    } catch {
      setError('Erreur réseau.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen font-sans text-gray-900">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
        <span className="font-semibold">Planning Anesthésie — CHU</span>
        <Link href="/login" className="flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">
          <span aria-hidden>👤</span> Se connecter
        </Link>
      </header>

      <main className="mx-auto flex max-w-md flex-col justify-center px-6 py-24">
        <h1 className="text-3xl font-bold">Planning des gardes</h1>
        <p className="mt-3 text-gray-600">
          Entre le code d&apos;accès pour consulter les plannings. Les médecins peuvent se connecter
          (en haut à droite) pour déclarer leurs disponibilités et leurs congés.
        </p>

        <form onSubmit={submit} className="mt-8 flex gap-2">
          <input className="flex-1 rounded border border-gray-300 px-3 py-2" placeholder="Code d'accès" value={passcode}
            onChange={(e) => setPasscode(e.target.value)} autoFocus />
          <button disabled={loading} className="rounded bg-blue-600 px-5 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {loading ? '…' : 'Entrer'}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </main>
    </div>
  );
}

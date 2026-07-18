'use client';

import Link from 'next/link';

type AdminPage = 'planning' | 'conges' | 'disponibilites';

const TABS: { key: AdminPage; label: string; href: string }[] = [
  { key: 'planning', label: 'Planning des gardes', href: '/admin' },
  { key: 'conges', label: 'Congés', href: '/admin/conges' },
  { key: 'disponibilites', label: 'Disponibilités', href: '/disponibilites' },
];

export default function AdminNav({ active }: { active: AdminPage }) {
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <div className="fixed top-6 right-6 z-10 flex items-center gap-4 bg-white text-sm">
      <div className="flex items-center gap-1">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={
              tab.key === active
                ? 'rounded-full bg-blue-600 px-3 py-1 font-medium text-white'
                : 'rounded-full px-3 py-1 font-medium text-gray-600 hover:text-blue-600'
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
    </div>
  );
}

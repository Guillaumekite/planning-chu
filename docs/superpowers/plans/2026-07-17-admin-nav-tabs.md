# Onglets admin — redirection et navigation partagée Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un compte admin atterrit directement sur `/admin` après connexion, et les 3 pages admin (`/admin`, `/admin/conges`, `/disponibilites`) partagent une même barre d'onglets qui met en avant la page active.

**Architecture:** Simplifier la redirection de connexion pour qu'elle dépende uniquement du rôle en base (plus de case à cocher). Extraire un composant client partagé `AdminNav` (3 onglets + bouton déconnexion) et le brancher dans les 3 pages admin existantes, en remplacement de leurs headers codés en dur.

**Tech Stack:** Next.js 16 (App Router, composants client `'use client'`), React 19, Tailwind CSS 4, TypeScript. Pas d'infrastructure de test de composants React dans ce repo (vitest ne couvre que `src/engine` et `src/db`) — la vérification de ces tâches se fait par lint, typecheck, et contrôle manuel au navigateur.

## Global Constraints

- Ne pas introduire de nouvelle dépendance (pas de testing-library) — suivre la convention existante du repo (aucun test de composant React).
- Conserver le style Tailwind existant (mêmes classes de couleur : `blue-600` pour actif/liens, `gray-500`/`gray-600` pour inactif, `hover:text-red-600` pour déconnexion).
- Ne pas toucher à `/planning` (page publique) ni à son propre header.
- `AdminNav` ne fait aucun contrôle d'accès — il suppose que la page appelante a déjà vérifié le rôle admin (comme aujourd'hui).

---

### Task 1: Connexion admin → redirection directe vers `/admin`

**Files:**
- Modify: `src/app/login/page.tsx`
- Modify: `src/app/api/auth/login/route.ts`

**Interfaces:**
- Consumes: rien (route existante, pas de dépendance sur les tâches suivantes).
- Produces: `POST /api/auth/login` accepte toujours `{ username, password }` (le champ `asAdmin` disparaît du contrat) et répond `{ ok, role, mustChangePassword, redirect }` où `redirect` vaut `/admin` si `role === 'admin'`, sinon `/disponibilites` (sauf `must_change_password` qui prime, inchangé).

- [ ] **Step 1: Retirer la case à cocher du formulaire de connexion**

Dans `src/app/login/page.tsx`, remplacer tout le contenu du fichier par :

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ username, password }),
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={loading} className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Simplifier la route de connexion**

Dans `src/app/api/auth/login/route.ts`, appliquer ces trois changements :

1. Retirer `asAdmin` du schéma :

```ts
const Body = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
```

2. Retirer `asAdmin` de la déstructuration et le contrôle d'erreur associé — remplacer :

```ts
  const { username, password, asAdmin } = parsed.data;

  const user = await queryOne<UserRow>(`SELECT * FROM users WHERE lower(username) = lower($1)`, [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return NextResponse.json({ error: 'Nom ou mot de passe incorrect.' }, { status: 401 });
  }
  if (asAdmin && user.role !== 'admin') {
    return NextResponse.json({ error: "Ce compte n'est pas administrateur." }, { status: 403 });
  }
```

par :

```ts
  const { username, password } = parsed.data;

  const user = await queryOne<UserRow>(`SELECT * FROM users WHERE lower(username) = lower($1)`, [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return NextResponse.json({ error: 'Nom ou mot de passe incorrect.' }, { status: 401 });
  }
```

3. Simplifier le calcul de `home` — remplacer :

```ts
  const home = user.role === 'admin' && asAdmin ? '/admin' : '/disponibilites';
```

par :

```ts
  const home = user.role === 'admin' ? '/admin' : '/disponibilites';
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: pas d'erreur liée à `login/page.tsx` ou `api/auth/login/route.ts` (aucune sortie, ou uniquement des erreurs préexistantes sans rapport).

Run: `npm run lint`
Expected: pas de nouvelle erreur/warning sur les deux fichiers modifiés.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx src/app/api/auth/login/route.ts
git commit -m "Connexion admin redirige directement vers /admin (suppression de la case à cocher)"
```

---

### Task 2: Composant partagé `AdminNav`

**Files:**
- Create: `src/components/AdminNav.tsx`

**Interfaces:**
- Consumes: rien.
- Produces: `export default function AdminNav({ active }: { active: 'planning' | 'conges' | 'disponibilites' })` — composant client autonome, gère son propre `logout()` (POST `/api/auth/logout` puis `window.location.href = '/'`). Les tâches 3, 4, 5 l'importent via `import AdminNav from '@/components/AdminNav'` et l'utilisent comme `<AdminNav active="planning" />`, `<AdminNav active="conges" />`, `<AdminNav active="disponibilites" />`.

- [ ] **Step 1: Créer le composant**

Créer `src/components/AdminNav.tsx` :

```tsx
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
    <div className="flex items-center gap-4 text-sm">
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
```

- [ ] **Step 2: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: pas d'erreur liée à `src/components/AdminNav.tsx` (le fichier n'est encore importé nulle part, donc pas d'erreur "unused" possible côté TS — vérifier simplement l'absence d'erreur de syntaxe/type).

Run: `npm run lint`
Expected: pas de nouvelle erreur/warning sur ce fichier.

- [ ] **Step 3: Commit**

```bash
git add src/components/AdminNav.tsx
git commit -m "Ajoute le composant AdminNav (barre d'onglets admin partagée)"
```

---

### Task 3: Brancher `AdminNav` dans `/admin` (Planning des gardes)

**Files:**
- Modify: `src/app/admin/AdminClient.tsx`

**Interfaces:**
- Consumes: `AdminNav` de la Task 2 (`import AdminNav from '@/components/AdminNav'`).
- Produces: rien pour les tâches suivantes (page terminale).

- [ ] **Step 1: Remplacer le header**

Dans `src/app/admin/AdminClient.tsx`, ajouter l'import en haut du fichier (après `import Link from 'next/link';`) :

```tsx
import AdminNav from '@/components/AdminNav';
```

Retirer la fonction `logout` (lignes 165-168) :

```tsx
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

```

Remplacer le bloc header (lignes 172-179) :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin — Planning des gardes</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/admin/conges" className="font-medium text-blue-600 hover:underline">Congés</Link>
          <Link href="/disponibilites" className="font-medium text-blue-600 hover:underline">Disponibilités</Link>
          <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
        </div>
      </div>
```

par :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin — Planning des gardes</h1>
        <AdminNav active="planning" />
      </div>
```

Ne pas retirer l'import `Link` de `next/link` : il reste utilisé plus bas dans le fichier (ligne ~251, lien vers Disponibilités dans le texte d'aide).

- [ ] **Step 2: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: pas d'erreur liée à `AdminClient.tsx` (en particulier pas de `logout is not defined` ni de variable inutilisée).

Run: `npm run lint`
Expected: pas de nouvelle erreur/warning.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/AdminClient.tsx
git commit -m "Page /admin utilise la barre d'onglets AdminNav"
```

---

### Task 4: Brancher `AdminNav` dans `/admin/conges` (Congés)

**Files:**
- Modify: `src/app/admin/conges/CongesClient.tsx`

**Interfaces:**
- Consumes: `AdminNav` de la Task 2.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Remplacer le header**

Dans `src/app/admin/conges/CongesClient.tsx`, remplacer l'import :

```tsx
import Link from 'next/link';
```

par :

```tsx
import AdminNav from '@/components/AdminNav';
```

(`Link` n'est utilisé nulle part ailleurs dans ce fichier — confirmé par grep, seule occurrence était le lien du header.)

Remplacer le bloc header (lignes 63-66) :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Demandes de congé</h1>
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:underline">← Admin</Link>
      </div>
```

par :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Demandes de congé</h1>
        <AdminNav active="conges" />
      </div>
```

- [ ] **Step 2: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: pas d'erreur liée à `CongesClient.tsx`.

Run: `npm run lint`
Expected: pas de nouvelle erreur/warning (en particulier pas de `Link` importé sans être utilisé).

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/conges/CongesClient.tsx
git commit -m "Page /admin/conges utilise la barre d'onglets AdminNav"
```

---

### Task 5: Brancher `AdminNav` dans `/disponibilites` (vue admin)

**Files:**
- Modify: `src/app/disponibilites/DispoClient.tsx`

**Interfaces:**
- Consumes: `AdminNav` de la Task 2.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Remplacer le header, branche admin uniquement**

Dans `src/app/disponibilites/DispoClient.tsx`, ajouter l'import en haut du fichier (après `import Link from 'next/link';`) :

```tsx
import AdminNav from '@/components/AdminNav';
```

Remplacer le bloc header (lignes 151-158) :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isAdmin ? 'Disponibilités des médecins' : 'Mes disponibilités'}</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/planning" className="font-medium text-blue-600 hover:underline">← Planning commun</Link>
          {isAdmin && <Link href="/admin" className="font-medium text-blue-600 hover:underline">Admin</Link>}
          <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
        </div>
      </div>
```

par :

```tsx
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isAdmin ? 'Disponibilités des médecins' : 'Mes disponibilités'}</h1>
        {isAdmin ? (
          <div className="flex items-center gap-4 text-sm">
            <Link href="/planning" className="font-medium text-blue-600 hover:underline">← Planning commun</Link>
            <AdminNav active="disponibilites" />
          </div>
        ) : (
          <div className="flex items-center gap-4 text-sm">
            <Link href="/planning" className="font-medium text-blue-600 hover:underline">← Planning commun</Link>
            <button onClick={logout} className="text-gray-500 hover:text-red-600">Déconnexion</button>
          </div>
        )}
      </div>
```

Le header non-admin garde exactement son comportement actuel (`← Planning commun` + `Déconnexion`) ; la fonction `logout` existante (lignes 144-147) reste utilisée par cette branche et ne doit pas être retirée.

- [ ] **Step 2: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: pas d'erreur liée à `DispoClient.tsx`.

Run: `npm run lint`
Expected: pas de nouvelle erreur/warning.

- [ ] **Step 3: Commit**

```bash
git add src/app/disponibilites/DispoClient.tsx
git commit -m "Page /disponibilites (vue admin) utilise la barre d'onglets AdminNav"
```

---

### Task 6: Vérification manuelle bout-en-bout

**Files:** aucun changement de code — vérification uniquement.

**Interfaces:**
- Consumes: le flux de connexion (Task 1) et les 3 pages branchées sur `AdminNav` (Tasks 3-5).
- Produces: rien.

- [ ] **Step 1: Démarrer le serveur de dev**

Run: `npm run dev`
Expected: serveur démarré sur `http://localhost:3000` sans erreur de compilation.

- [ ] **Step 2: Vérifier la connexion admin**

Dans un navigateur (ou via le MCP Playwright), aller sur `http://localhost:3000/login`. Vérifier que la case "Je suis administrateur" a disparu. Se connecter avec le compte `admin` (mot de passe `medecin973`, cf. `docs/superpowers/specs/2026-07-16-auth-conge-corrections-design.md`).
Expected: redirection immédiate vers `/admin` (page "Admin — Planning des gardes"), sans étape intermédiaire.

- [ ] **Step 3: Vérifier la barre d'onglets sur les 3 pages**

Sur `/admin` : vérifier que l'onglet "Planning des gardes" est en fond bleu, "Congés" et "Disponibilités" en gris, "Déconnexion" à droite en gris.
Cliquer sur "Congés" → arrivée sur `/admin/conges`, onglet "Congés" maintenant en bleu, les deux autres en gris.
Cliquer sur "Disponibilités" → arrivée sur `/disponibilites`, onglet "Disponibilités" en bleu, lien "← Planning commun" toujours présent avant les onglets.
Cliquer sur "Planning des gardes" → retour sur `/admin`, onglet à nouveau en bleu.
Expected: à chaque page, exactement un onglet en bleu correspondant à la page affichée, les 2 autres cliquables en gris, cohérent sur les 3 pages.

- [ ] **Step 4: Vérifier qu'un compte médecin (non-admin) n'est pas affecté**

Se déconnecter, se connecter avec un compte médecin standard.
Expected: redirection vers `/disponibilites`, header affichant "Mes disponibilités", `← Planning commun` et `Déconnexion` uniquement (pas de barre d'onglets admin).

- [ ] **Step 5: Confirmer et clore**

Si tout correspond aux résultats attendus des steps 2-4, la fonctionnalité est complète. Aucun commit supplémentaire nécessaire pour cette tâche (vérification seule).

# Onglets admin — redirection et navigation partagée

Date : 2026-07-17

Deux correctifs liés sur la partie admin du site Planning CHU.

## Chantier 1 — Connexion admin → `/admin` directement

**Problème.** Le formulaire de connexion (`src/app/login/page.tsx`) a une case
« Je suis administrateur » qui détermine la redirection après connexion
(`src/app/api/auth/login/route.ts`, ligne 36) :

```js
const home = user.role === 'admin' && asAdmin ? '/admin' : '/disponibilites';
```

Le rôle vient déjà de la base (`users.role`) — la case est redondante pour la
redirection et source de confusion (un admin qui oublie de la cocher atterrit sur
`/disponibilites`).

**Correctif.** Supprimer la case à cocher. Un seul formulaire de connexion pour
tout le monde ; la redirection se base uniquement sur `user.role` :

```js
const home = user.role === 'admin' ? '/admin' : '/disponibilites';
```

Fichiers :
- `src/app/login/page.tsx` — retirer la case `asAdmin` et son état, ne plus
  l'envoyer dans le body de la requête.
- `src/app/api/auth/login/route.ts` — retirer `asAdmin` du schéma `Body`, retirer
  le contrôle `if (asAdmin && user.role !== 'admin')`, simplifier `home`.

## Chantier 2 — Barre d'onglets admin partagée

**Problème.** Chaque page admin (`AdminClient.tsx`, `CongesClient.tsx`, et la
vue admin de `DispoClient.tsx`) a son propre header avec des liens texte codés en
dur, sans indication de la page active :

- `/admin` (Planning des gardes) : liens vers Congés, Disponibilités, Déconnexion
- `/admin/conges` (Congés) : lien retour vers Admin uniquement
- `/disponibilites` (vue admin) : liens vers Planning commun, Admin, Déconnexion

**Correctif.** Nouveau composant partagé `AdminNav` (`src/components/AdminNav.tsx`)
affiché sur les 3 pages, avec un prop `active: 'planning' | 'conges' | 'disponibilites'`.

Rendu :
- 3 onglets en pilule côte à côte : **Planning des gardes** (`/admin`) ·
  **Congés** (`/admin/conges`) · **Disponibilités** (`/disponibilites`)
  - Onglet actif : fond `bg-blue-600`, texte blanc, `rounded-full px-3 py-1`
  - Onglets inactifs : texte gris, survol bleu, même padding (pas de saut de layout)
- **Déconnexion** séparée à droite, texte gris / survol rouge (comportement actuel
  inchangé) — ce n'est pas une page donc jamais mise en avant
- Le composant encapsule la fonction `logout()` (POST `/api/auth/logout` puis
  redirection vers `/`), dupliquée aujourd'hui dans les 3 fichiers

Cas particulier `/disponibilites` : le lien `← Planning commun` (vers `/planning`)
reste affiché, positionné avant les 4 boutons de `AdminNav`, uniquement quand
`isAdmin` est vrai. Pour les médecins non-admin, aucun changement au header actuel
de `DispoClient.tsx`.

Fichiers :
- `src/components/AdminNav.tsx` (nouveau)
- `src/app/admin/AdminClient.tsx` — remplace le header actuel par `<AdminNav active="planning" />`
- `src/app/admin/conges/CongesClient.tsx` — remplace le header actuel par `<AdminNav active="conges" />`
- `src/app/disponibilites/DispoClient.tsx` — quand `isAdmin`, affiche `← Planning
  commun` puis `<AdminNav active="disponibilites" />` ; le header non-admin ne
  change pas

## Hors périmètre

- Pas de changement sur `/planning` (page publique) ni sur son propre header.
- Pas de nouveau contrôle d'accès : `AdminNav` suppose que la page qui l'affiche a
  déjà vérifié le rôle admin (comme aujourd'hui).

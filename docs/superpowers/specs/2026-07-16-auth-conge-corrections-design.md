# Corrections site — auth, mot de passe admin, note de refus de congé

Date : 2026-07-16

Trois corrections indépendantes sur le site Planning CHU.

## Chantier 1 — Séparer « code d'accès » et « connexion » (option B)

**Problème.** Le cookie de session (`pc_session`) dure 30 jours et n'est jamais
effacé en entrant le code d'accès. Résultat : une ancienne session admin persiste,
l'utilisateur est « admin automatiquement » alors qu'il a juste tapé le code d'accès.

**Correctifs.**
1. Entrer le code d'accès `chuguyane` **efface la session** (`pc_session`) → on
   redevient simple spectateur, jamais admin résiduel.
2. Le cookie `pc_session` devient un **cookie de session** (sans `maxAge`, effacé à
   la fermeture du navigateur) au lieu de 30 jours → connexion redemandée à chaque
   nouvelle visite. Le cookie `pc_view` (code d'accès) garde ses 30 jours.

Fichiers : `src/lib/auth.ts` (nouvelles `sessionCookieOptions`), routes
`api/auth/login`, `api/auth/change-password` (utilisent `sessionCookieOptions`),
`api/auth/passcode` (efface `pc_session`).

## Chantier 2 — Mot de passe admin fixe : `medecin973`

- Nouvelle installation : compte `admin` créé avec `medecin973`,
  `must_change_password = false`.
- Installation existante (en ligne) : migration idempotente unique, gardée par un
  flag dans `app_config` (`admin_pw_reset_v1`), qui force le mot de passe du compte
  `admin` à `medecin973` au prochain démarrage.

Fichiers : `src/db/seed.ts`, `src/db/schema.ts` (ou fonction de migration appelée
depuis `ensureSchema`).

## Chantier 3 — Note de refus de congé (visible par le médecin)

- Colonne `conge_note text` ajoutée à `availability` (nullable, `ADD COLUMN IF NOT EXISTS`).
- Page admin *Demandes de congé* : au clic sur **Refuser**, champ de motif optionnel ;
  envoyé avec le statut. Motif appliqué à tous les jours du run refusé. Approuver /
  remettre en attente efface le motif.
- Espace médecin *Mes disponibilités* : le motif s'affiche **sous le calendrier**
  (liste « Congé refusé du X au Y — motif : … ») **et au survol** de la case rouge.

Fichiers : `src/db/schema.ts`, `src/lib/availability.ts`
(`getAvailability`, `setCongeStatus`, `listCongeRuns`), `src/app/api/conge/route.ts`,
`src/app/api/availability/route.ts`, `src/app/admin/conges/CongesClient.tsx`,
`src/app/disponibilites/DispoClient.tsx`.

# Liste continue des demandes de congé (admin)

Date : 2026-07-16
Statut : validé, prêt pour plan d'implémentation

## Problème

La page admin `admin/conges` oblige à choisir un **Mois** et une **Année** à chaque
consultation, et n'affiche que les congés de ce mois précis. L'admin craint
d'oublier ou de ne pas voir à l'avance des demandes à traiter, et doit changer de
mois manuellement pour balayer les demandes.

De plus, un congé à cheval sur deux mois (ex. 28 septembre → 15 octobre) est
aujourd'hui affiché en deux blocs cassés au changement de mois, et ne peut pas
être validé en une seule action.

## Objectif

- Afficher **automatiquement toutes les demandes à venir**, tous mois confondus,
  sans avoir à choisir de mois.
- Garder visibles les demandes déjà traitées (récentes), retirer les congés
  entièrement passés.
- Trier du congé **le plus proche au plus lointain** (le plus urgent en haut).
- Gérer proprement les congés **à cheval sur deux mois** : affichage en un seul
  bloc et validation/refus en une seule action.

## Portée / non-portée

- **Dans la portée** : page admin `admin/conges` (`CongesClient.tsx`), API
  `/api/conge` (GET + PUT), fonctions `listCongeRuns` et `setCongeStatus` dans
  `src/lib/availability.ts`.
- **Hors portée** : la génération de planning (elle ne lit pas ces fonctions ;
  elle reçoit les dispos autrement), la déclaration de congé côté médecin
  (`disponibilites`), le schéma de la table `availability` (inchangé).

## Comportement

### Chargement de la page
- **Suppression du sélecteur Mois/Année.** À l'ouverture, la page charge
  automatiquement toutes les demandes à venir, tous mois confondus.
- **Plancher (seuil temporel)** : on affiche tout congé dont le **dernier jour**
  est ≥ (aujourd'hui − 7 jours). Un congé entièrement terminé depuis plus d'une
  semaine disparaît ; un congé en cours ou à venir reste visible.
  - Le « dernier jour » d'un congé = la date de fin du bloc (run), pas de chaque
    jour isolé : un congé du 1 au 8 juillet reste visible tant que le 8 juillet
    est ≥ (aujourd'hui − 7 jours).
- « Aujourd'hui » est calculé dans le fuseau **Europe/Paris**.

### Deux sections (conservées)
- **« À traiter »** : runs de statut `pending` ou `mixed`, triés du congé le plus
  proche (date de début la plus petite ≥ maintenant) au plus lointain.
- **« Déjà traités »** : runs `approved` / `refused`, triés pareil (le plus proche
  en haut). L'action « remettre en attente » est conservée.

## Conception technique

### `listCongeRuns` — requête (src/lib/availability.ts)
- Ne prend plus `(year, month)`. Calcule un plancher métier `floor` = date
  d'aujourd'hui (Europe/Paris) − 7 jours.
- **Le plancher s'applique au bloc (run), pas au jour isolé.** Filtrer chaque jour
  en SQL par `≥ floor` casserait le début d'un congé long en cours (un congé
  1→20 juillet avec `floor` au 9 juillet s'afficherait « du 9 au 20 » au lieu de
  « du 1 au 20 »). Donc :
  1. **Pré-filtre SQL large** : requête tous les jours `state = 'conge'` dont la
     date est `≥ (floor − 45 jours)`. Ce recul de 45 jours garantit de capturer
     l'intégralité de tout congé qui se termine à partir de `floor` (un congé
     réaliste dure bien moins de 38 jours), tout en bornant le volume lu.
  2. **Regroupement** en runs (voir section suivante).
  3. **Filtre final au niveau run** : on ne garde que les runs dont la **date de
     fin `end` est ≥ `floor`**.
  - Comparaison de date en SQL via un entier ordonnable
    `(year*10000 + month*100 + day)` comparé aux bornes encodées de la même façon,
    pour rester portable et indépendant du type date SQL.
  - Tri SQL : `ORDER BY year, month, day, doctor_id` (le tri final par proximité
    est appliqué sur les runs).

### Regroupement des jours consécutifs (multi-mois)
- Le regroupement actuel colle deux jours si `day === lastDay + 1`. C'est **faux**
  entre deux mois (le 30 septembre et le 1er octobre ne sont ni 30 ni 31).
- Nouvelle règle : deux jours appartiennent au même bloc s'ils concernent le même
  médecin **et** que la date du second est le **lendemain calendaire réel** du
  premier (calcul via objet date, en UTC pour éviter tout décalage DST).
- Chaque run porte désormais ses jours sous forme de liste
  `dates: { year, month, day }[]` (au lieu de simples numéros de jour), ainsi que
  `start: {year,month,day}` et `end: {year,month,day}`. Le statut du run reste
  `pending | approved | refused | mixed` (mixed si plusieurs statuts dans le bloc).

### Validation multi-mois — `setCongeStatus` + API PUT
- `setCongeStatus` ne prend plus `(doctorId, year, month, days[], status, note)`
  mais `(doctorId, dates: {year,month,day}[], status, note?)`. Elle met à jour
  toutes les lignes correspondantes, potentiellement réparties sur plusieurs mois,
  en une seule transaction. La règle du `note` (conservé seulement si `refused` et
  non vide, sinon effacé) est inchangée.
- Le corps du `PUT /api/conge` devient
  `{ doctorId: number, dates: {year,month,day}[], status: 'pending'|'approved'|'refused', note?: string }`.
  Validation Zod adaptée (`dates` non vide ; year/month/day cohérents ; note ≤ 500).
- Le `GET /api/conge` ne prend plus de paramètres `year`/`month` ; il renvoie
  `{ runs }` = `listCongeRuns()`.

### Affichage d'un bloc (CongesClient.tsx)
- Le libellé de date s'adapte :
  - un seul jour → « le 5 juillet » ;
  - même mois → « du 5 au 8 juillet » ;
  - à cheval sur deux mois → « du 28 septembre au 15 octobre (18 jours) ».
- Le reste est conservé : nom du médecin, badge de statut, motif de refus,
  boutons Valider / Refuser (+ zone de motif), et « remettre en attente ».
- Les boutons envoient désormais `run.dates` (multi-mois) au lieu de
  `{ year, month, days }`.

## Tests

- **Regroupement** :
  - jours consécutifs dans un même mois → 1 bloc ;
  - jours à cheval sur deux mois (30 sept + 1 oct) → 1 bloc ;
  - jours non consécutifs (5 juillet + 8 juillet) → 2 blocs séparés ;
  - deux médecins avec des jours qui se suivent → blocs distincts par médecin.
- **Plancher temporel** :
  - congé entièrement passé (fin > 7 jours avant aujourd'hui) → exclu ;
  - congé en cours (commencé avant, se termine après aujourd'hui) → inclus ;
  - congé futur → inclus ;
  - congé fini il y a 3 jours → inclus (dans la fenêtre de 7 jours) ;
  - **congé long en cours** (commencé il y a 15 jours, se termine dans 5 jours) →
    inclus **et affiché avec sa vraie date de début** (le pré-filtre de 45 jours ne
    doit pas tronquer le début du bloc).
- **Validation** :
  - valider un bloc à cheval sur deux mois → toutes les lignes des deux mois
    passent à `approved` ;
  - refuser avec motif → `refused` + note sur toutes les lignes du bloc ;
  - « remettre en attente » → `pending` + note effacée.
- **Tri** : le congé le plus proche apparaît avant le plus lointain dans chaque
  section.

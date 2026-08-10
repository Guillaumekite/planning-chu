# Jours préférés de travail (temps partiel) — Design

**Date :** 2026-08-10
**Statut :** validé, prêt pour le plan d'implémentation

## Problème

Aujourd'hui, un médecin à temps partiel (TP) ne choisit pas les jours de la
semaine qu'il travaille : le moteur les répartit automatiquement et
équitablement (`computeTpDays`, alternance 3/2 selon le ratio). Il n'existe
aucun moyen, ni pour l'admin ni pour le médecin, d'indiquer « je préfère
travailler tel jour ».

On veut donner ce choix — exactement comme on choisit déjà ses **jours de garde
préférés** (G+) ou ses **jours de contrainte université** (U). Si le médecin
sélectionne **moins** de jours que ne le permet son quota TP, l'algorithme
**complète automatiquement** les jours manquants pour atteindre le ratio.

## Concept

Un nouveau **marqueur orthogonal « TP »** dans la grille *Disponibilités*,
strictement parallèle au marqueur **U** (université) qui existe déjà :

- Peint par l'**admin** (sur les lignes des médecins à temps partiel) et par un
  **médecin à temps partiel** (sur sa propre ligne uniquement).
- Se **combine** avec G+/G−/dispo le même jour ; **exclusif** avec Congé
  (on ne peut pas demander à travailler ET poser un congé le même jour).
- Signifie *« je souhaite travailler ce jour dans mon quota TP »*. Le planning
  généré y place ensuite un **poste normal** (BM, G1, G2, S, CS…) selon le
  profil — le marqueur ne force **jamais** un poste précis. Dans *Disponibilités*
  la case affiche « TP » ; dans le planning généré elle affiche le poste réel.

### Décisions cadrées (avec l'utilisateur)

1. **Dépassement du quota** : si un TP sélectionne **plus** de jours que son
   ratio ne le permet, **tous** les jours choisis sont honorés (le TP peut donc
   travailler au-delà de son ratio), et l'admin est **averti**.
2. **Portée** : marqueur pertinent sur les **jours de semaine** (le mécanisme de
   jours off TP ne concerne que la semaine). Un marqueur posé sur un week-end est
   inerte ; les gardes de week-end préférées restent exprimées par G+.
3. **G+ implique présence** : pour un TP, un jour marqué **G+** (souhait de
   garde) est automatiquement considéré comme **jour travaillé forcé** — évite
   qu'un souhait de garde tombe sur un jour off et soit perdu.
4. **Visibilité du brush** : admin toujours + médecin seulement s'il est à temps
   partiel (comme le brush U pour les universitaires).

## Modifications

### 1. Base de données — `src/db/schema.ts`

```sql
ALTER TABLE availability ADD COLUMN IF NOT EXISTS tp_work boolean NOT NULL DEFAULT false;
```

Idempotent, ajouté à la suite des `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
existants (`univ`, `conge_note`).

### 2. Accès données — `src/lib/availability.ts`

- Nouveau type `TpWorkByName = Record<string, Record<number, boolean>>`.
- `getAvailability` sélectionne `a.tp_work` et renvoie un champ supplémentaire
  `tpWork` (parallèle à `univ`).
- `setCell(doctorId, year, month, day, state, univ, tpWork)` :
  - `tpWork` forcé à `false` quand `state === 'conge'`.
  - La ligne n'est **supprimée** que si `state === 'dispo' && !univ && !tpWork`
    (un jour « TP seul » doit survivre).
  - L'`INSERT ... ON CONFLICT` écrit et met à jour `tp_work`.

### 3. API

- **`PUT /api/availability`** (`src/app/api/availability/route.ts`) : `PutBody`
  gagne `tpWork: z.boolean().optional()`, transmis à `setCell`.
- **`POST /api/generate`** (`src/app/api/generate/route.ts`) : `BodySchema`
  gagne `tpPreferred: z.record(z.string(), z.array(z.number().int().min(1).max(31))).optional()`,
  transmis à `solvePlanning`.

### 4. UI Disponibilités — `src/app/disponibilites/DispoClient.tsx`

- Type `Doc` gagne `partTime: boolean` (mappé depuis `part_time` renvoyé par
  `/api/doctors`).
- `Brush` = `Availability | 'univ' | 'tp'`.
- Nouveaux états `savedTp` / `pendingTp` (`Record<string, Record<number, boolean>>`),
  chargés depuis `d.tpWork` dans `loadAvail`.
- Bouton palette « **TP** — Jour souhaité travaillé (temps partiel) », affiché si
  `isAdmin || doctors.some(d => d.partTime)` (`hasPartTime`, miroir de
  `hasUniversitaire`).
- `apply()` : pour le brush `'tp'`, ignorer les clics sur une ligne non-TP ;
  sinon toggler le jour dans `pendingTp`.
- `cellLook` : le marqueur TP est **orthogonal** comme U. Congé l'emporte
  (pas de TP affiché sur un congé). S'il est seul (état `dispo`) → label
  « TP » ; combiné à G+/G− → conserver le label garde et ajouter un **anneau
  émeraude** (`ring-2 ring-inset ring-emerald-500`). Un jour peut cumuler U et
  TP (rare) : deux anneaux — priorité d'affichage du label : garde > TP > U.
- `save()` : inclure les changements TP dans le diff et envoyer `tpWork` dans le
  corps du `PUT`.
- Ligne de légende décrivant le marqueur TP (affichée quand le brush est
  disponible).

### 5. UI Admin — `src/app/admin/AdminClient.tsx`

Dans `generate()`, construire `tpPreferred` depuis `availData.tpWork`
(parallèle à `univConstraints`) et l'ajouter au corps du POST `/api/generate`.

### 6. Moteur — `src/engine/planning.ts`

- `PlanningInput` gagne
  `tpPreferred?: Record<DoctorId, number[]>` (documenté comme les jours de
  semaine que le TP souhaite travailler).
- Construire un ensemble `forcedWork[doc]` pour chaque médecin : jours de
  **semaine**, **présents** (`PRESENT(avail)`), qui sont soit un jour TP déclaré
  (`tpPreferred[doc]`), **soit** un jour `souhait_garde` (G+). (G+ ⇒ présence.)
- Étendre `computeTpDays(days, isAvailWeekday, ratio, forced)` avec le paramètre
  `forced: Set<number>` :
  - Par semaine (dans l'ordre) : `credit += ratio × group.length` ;
    `work = clamp(round(credit), 0, group.length)`.
  - `working = jours de la semaine appartenant à forced` (toujours honorés).
  - Si `working.size < work` : compléter avec
    `pickEven(group ∖ working, work − working.size)`.
  - `credit -= working.size` : un dépassement une semaine réduit les semaines
    suivantes → le mois reste proche du ratio tout en honorant **tous** les
    jours forcés.
  - Jours off = `group ∖ working`.
- **Avertissement** (`warnings`) quand le nombre de jours forcés d'un TP dépasse
  son quota cible `round(ratio × nombre de jours de semaine disponibles)` :
  « Dr X (TP r %) : n jours souhaités travaillés au-delà de son quota (~q) —
  tous honorés. »

### 7. Cas limites

- **Jour forcé un week-end** : `computeTpDays` ne traite que les jours de
  semaine → inerte. Les gardes de week-end préférées passent par G+.
- **Médecin non-TP marqué TP** : `fte = 1` → `computeTpDays` n'est pas appelé →
  marqueur sans effet. Sûr.
- **TP + congé le même jour** : impossible (`setCell` force `tpWork = false` sur
  un congé, comme pour `univ`).
- **Aucun jour préféré** : `forced` vide → comportement actuel inchangé
  (répartition automatique par ratio).

## Tests — `src/engine/planning.test.ts`

- Un TP à 50 % avec 2 jours de semaine préférés → ces 2 jours sont travaillés
  (pas dans l'ensemble off) et le total de jours travaillés reste ≈ ratio.
- Jours préférés au-delà du quota → tous honorés + `warnings` contient
  l'avertissement de dépassement.
- Un jour **G+** sur un jour de semaine d'un TP → jour travaillé (jamais off),
  donc le souhait de garde reste exploitable.
- Aucun jour préféré → répartition automatique identique à l'existant
  (non-régression).

## Hors périmètre

- Pas de choix de **poste** précis pour un jour TP (le moteur assigne comme
  d'habitude).
- Pas de modification de l'affichage du **planning généré** (déjà correct : un
  jour forcé travaillé devient présent et reçoit un poste normal).
- Pas de gestion des week-ends dans le mécanisme TP (inchangé).

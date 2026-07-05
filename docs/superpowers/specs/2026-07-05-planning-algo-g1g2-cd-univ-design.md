# Design — 3 évolutions du moteur de planning

Date : 2026-07-05
Branche : `Guillaumekite/planning-algo-features`

Trois évolutions du moteur de génération de plannings (service anesthésie, CHU Guyane) :

1. **Alternance G1/G2** — les médecins alternent les rôles G1 et G2 sur le mois (au lieu d'un rôle figé par ordre alphabétique). Exception permanente : Dr Dzierzek (acupuncture) reste toujours G2.
2. **Consultation douleur (CD) réservée** — seuls 5 médecins (profil dédié) font la CD ; Esbuy en fait deux fois plus que les autres.
3. **Jours de contrainte universitaire posés par le médecin** — un universitaire peut poser lui-même ses jours « Univ » dans le calendrier de dispos ; sinon placement automatique au pourcentage. Nouveau poste `BM-BS` quand un universitaire est `U+G1`.

Rappel des conventions projet (à respecter pour ces 3 features) :
- Commits **sans co-auteur** (Vercel Hobby / repo public).
- `npm run build` **avant** tout push (les tests ne typo-checkent pas les pages Next).
- Tout nouveau champ de profil doit être ajouté au **zod `ProfileSchema` de `/api/generate`** (sinon zod le supprime silencieusement).
- Toute nouvelle colonne DB via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dans `ensureSchema` (`schema.ts`), puis appliquée sur Neon (tsx one-off + `DATABASE_URL`).
- Déterminisme du moteur : aucun `Math.random`, aucune horloge. Même entrée → même sortie (Node ↔ navigateur).

---

## Feature 1 — Alternance G1/G2 (intra-mois)

### Comportement actuel
Dans `src/engine/gardes.ts` (lignes ~100-114), une fois la Phase A résolue, chaque jour a 2 médecins de garde. Le rôle G1/G2 est attribué par **tri alphabétique de l'identifiant** :

```ts
const chosen = [...assigned[di]].sort((a, b) => a.localeCompare(b));
chosen.forEach((doc, idx) => { const role = idx === 0 ? 'G1' : 'G2'; ... });
```

Conséquence : un médecin dont le nom sort tôt fait quasi toujours G1, un autre quasi toujours G2. La règle « Dzierzek toujours G2 » est appliquée après coup par un swap manuel dans `planning.ts` (lignes ~171-176).

### Comportement cible
Sur un mois donné, un médecin qui fait plusieurs gardes doit **alterner** G1 et G2 (≈ moitié/moitié). Équilibrage **intra-mois** uniquement (pas de report multi-mois pour la v1). Dr Dzierzek (et tout médecin acupuncteur) reste **toujours G2**.

### Conception
- Ajouter un champ optionnel `forceG2?: DoctorId[]` à `GardeInput` (dans `src/engine/types.ts`).
- Dans `planning.ts`, passer les médecins acupuncteurs comme `forceG2` à `solveGardes`. Cela **remplace** le swap manuel `planning.ts:171-176`, qui est supprimé.
- Dans `gardes.ts`, remplacer le tri alphabétique par une **passe d'attribution des rôles déterministe** :
  - Parcourir les jours dans l'ordre du calendrier.
  - Maintenir par médecin un solde `balance = g1Count − g2Count` (init 0).
  - Pour chaque jour avec les 2 médecins `{x, y}` :
    - Si l'un est dans `forceG2` → il prend G2, l'autre G1.
    - Si les **deux** sont dans `forceG2` (cas théorique, n'arrive pas avec un seul acupuncteur) → départage déterministe : celui d'id le plus petit (localeCompare) prend G2, l'autre G1 (pas de plantage).
    - Sinon → **G1 au médecin qui "doit" le plus un G1**, c.-à-d. la plus petite `balance` ; égalité départagée par `localeCompare` de l'id (déterminisme).
  - Mettre à jour les soldes (`g1Count`/`g2Count`) après chaque jour.
- Le reste de la construction du résultat (compteurs d'équité, `reason`) reste identique.

### Impact
- **Pur ré-étiquetage** : ne change ni *qui* est de garde, ni *quand*. Les 4 axes d'équité (nombre, week-end, pénibles, étalement) sont intacts. Aucun risque de faisabilité.
- Feature 1 est calculée en Phase A ; c'est elle qui détermine si un universitaire tombe en `U+G1` ou `U+G2` (voir Feature 3). On **ne biaise pas** l'attribution des rôles pour éviter les `U+G1` (le `BM-BS` est un cas normal).

### Tests
- Un médecin avec ≥ 2 gardes dans le mois a un écart |G1 − G2| ≤ 1.
- Un médecin acupuncteur de garde est toujours G2.
- Chaque jour a toujours exactement 1 G1 et 1 G2.
- Déterminisme : deux exécutions identiques produisent les mêmes rôles.

---

## Feature 2 — Consultation douleur (CD) réservée + Esbuy ×2

### Comportement actuel
Dans `planning.ts` (Passe 3, lignes ~264-305), la CD est un poste **générique** : ajoutée à la liste voulue si `presentCount >= 9`, puis attribuée par `leastFor('CD')` à n'importe quel médecin présent (celui qui en a fait le moins). Aucune restriction de personne.

### Comportement cible
Seuls les médecins portant un profil « consultation douleur » peuvent faire la CD. Trois niveaux : **Non** (défaut), **Simple**, **Double**. Les 5 médecins concernés (Esbuy, Kaba, Egbou, Boukadida, Anaphy) passent en Simple ; **Esbuy en Double** (≈ 2× plus de CD par mois). Le seuil `presentCount >= 9` est **conservé** (on ne change que *qui* peut la faire, pas *quand* elle apparaît). Si aucun médecin éligible n'est présent un jour → **pas de CD** ce jour-là.

### Conception
- Nouveau champ profil `douleurPoids?: number` : `0` = Non (défaut), `1` = Simple, `2` = Double.
  - `src/lib/store.ts` : ajouter `douleurPoids?: number` au type `Doctor`.
  - `src/engine/planning.ts` : ajouter `douleurPoids?: number` à `DoctorProfile`.
  - `/api/generate` : ajouter `douleurPoids` (number optionnel) au **zod `ProfileSchema`**.
  - `schema.ts` : colonne DB `douleur_poids integer NOT NULL DEFAULT 0` via `ALTER TABLE ... IF NOT EXISTS`, appliquée sur Neon.
  - Accès données médecins (`src/lib/doctors.ts`) : lire/écrire `douleur_poids` ↔ `douleurPoids`.
- Admin UI : **select 3 états** (Non / Simple / Double) par médecin, à côté des champs universitaire / temps partiel / acupuncture.
- `planning.ts` Passe 3 :
  - Construire le **pool candidat CD** = médecins présents ce jour avec `douleurPoids >= 1`.
  - Choix pondéré : parmi ce pool, prendre le médecin qui minimise `cdCount[doc] / douleurPoids[doc]` (Esbuy à poids 2 est donc choisi ~2× plus souvent sur le mois) ; égalité départagée par `localeCompare`.
  - La CD n'est ajoutée à la liste voulue que si `presentCount >= 9` **et** le pool candidat CD est non vide ce jour-là.
  - Le médecin choisi est retiré du pool général (occupé par la CD), comme les autres postes.

### Impact
- Les ~15 autres médecins récupèrent d'autres postes (S / CS / BM / HC) à la place → répartition des postes de journée légèrement modifiée (voulu).
- Aucun impact sur la Phase A (gardes) ni sur la faisabilité.

### Tests
- Seuls les médecins `douleurPoids >= 1` reçoivent une CD.
- Sur un mois plein, Esbuy (poids 2) fait ≈ 2× le nombre de CD d'un médecin poids 1.
- Un jour où aucun éligible n'est présent : aucune case CD.
- Aucun nom de médecin codé en dur dans le moteur (tout passe par le profil).

---

## Feature 3 — Jours de contrainte universitaire posés par le médecin + poste `BM-BS`

### Comportement actuel
Dans `planning.ts` (Passe 2, lignes ~248-262), pour chaque universitaire, ~`universityRatio` % de ses jours ouvrés travaillés sont marqués `U`, répartis uniformément (sauf juillet/août). Le médecin ne choisit pas ses jours U.

Le calendrier de dispos (`DispoClient.tsx`) est un pinceau mono-valeur : chaque case a **un** état parmi `dispo | souhait_garde | no_garde | conge`, stocké dans la colonne `availability.state`.

### Comportement cible
- Un médecin **universitaire** peut poser lui-même ses **jours de contrainte universitaire** (« Univ ») dans le calendrier de dispos.
- Bascule : s'il pose **≥ 1** jour Univ → le moteur utilise **exactement** ces jours comme jours U. S'il n'en pose **aucun** → placement **automatique au %** (comportement actuel inchangé).
- Un jour Univ **n'est pas exclusif** d'une préférence de garde : l'universitaire doit pouvoir poser « Univ **+** G+ » ou « Univ **+** G− » sur la même case (il peut être de garde le soir même en étant à la fac le jour).
- Interaction garde :
  - Un jour Univ `D` reste **gardable** (garde le soir OK).
  - On **bloque la garde le jour `D−1`** pour chaque jour Univ `D` (garde D−1 → repos de sécurité D, incompatible avec « à la fac le jour D »). Équivalent : garde le soir autorisée le jour Univ *sauf si* Univ le lendemain.
  - Si l'universitaire est de garde le jour où il est aussi Univ :
    - rôle **G1** → il ne peut pas tenir le bloc en journée → case affichée **`U+G1`** et un **autre** médecin prend le poste **`BM-BS`** (bloc 7h30-18h) ce jour-là.
    - rôle **G2** → case affichée **`U+G2`**, **pas** de remplacement (le G1 du jour tient déjà le bloc).
  - Sinon (présent, pas de garde) → case affichée **`U`**.
- Nouveau poste **`BM-BS`** = bloc journée complète 7h30-18h (BM = bloc matin, BS = bloc soir 14h-18h ; ici les deux réunis sur une personne).

### Conception — modèle de données
`univ` est traité comme une **couche indépendante** de la préférence de garde (pas un état de plus dans la palette mono-valeur).

- `schema.ts` : nouvelle colonne `availability.univ boolean NOT NULL DEFAULT false` via `ALTER TABLE ... IF NOT EXISTS`, appliquée sur Neon. La colonne `state` reste la préférence garde/congé.
- `src/lib/availability.ts` :
  - `getAvailability` : sélectionner aussi `a.univ` ; renvoyer une structure `univ` par médecin/jour (ex. `univByName: Record<string, Record<number, boolean>>`), en plus de `availability`/`congeStatus`.
  - `setCell(doctorId, year, month, day, state, univ)` : upsert de `state` **et** `univ`. La ligne n'est supprimée que si `state === 'dispo' && univ === false` (sinon on perdrait un jour « fac sans préférence de garde »). `conge` force `univ = false` (absent ≠ à la fac).
- `src/app/api/availability/route.ts` : ajouter `univ: z.boolean().optional()` au `PutBody` ; passer à `setCell`.

### Conception — UI (`DispoClient`)
- La palette garde-préférence (dispo / G+ / G− / Congé) reste inchangée.
- Nouveau **pinceau « Univ »** indépendant qui **bascule** le marqueur `univ` sur les cases cliquées **sans modifier** `state`.
- Rendu de la case : **fond = préférence de garde** (couleur actuelle) **+ marqueur Univ superposé** (liseré/coin indigo avec un petit « U »). Une case peut donc afficher « G+ et U » simultanément, ou « U » seul.
- Le pinceau « Univ » n'est proposé que pour un médecin **universitaire** : enrichir le fetch `/api/doctors` (ou l'état chargé) avec le flag `universitaire` par médecin. En vue admin (toutes les lignes), le pinceau reste utilisable ; le moteur n'honore les jours Univ que pour les universitaires de toute façon.
- L'enregistrement (`save`) envoie `{state, univ}` par case modifiée (diff sur les deux dimensions).

### Conception — moteur (`planning.ts`)
- Récupérer `univDays[doc]` = ensemble des jours où `univ === true` (uniquement pour les universitaires ; ignoré pour les autres).
- **Blocage garde** (avant l'appel Phase A) : pour chaque jour Univ `D` d'un universitaire, ajouter `D−1` à `gardeBlocked[doc]` (en plus des blocages existants). Le jour `D` lui-même n'est **pas** bloqué.
- **Placement U** (remplace/complète la Passe 2) :
  - Si `univDays[doc]` est **non vide** → placer `U` exactement sur ces jours (voir overlay garde ci-dessous). **Pas** de complément automatique au %.
  - Si `univDays[doc]` est **vide** → placement automatique au % (Passe 2 actuelle, inchangée, sauf juillet/août).
- **Overlay garde + Univ** (mécanique calquée sur `placeAcu`), pour un universitaire sur un jour Univ `D` :
  - si la case vaut `G1` → `U+G1` ; enregistrer `D` dans un ensemble `bmbsDays` (jours nécessitant un `BM-BS`).
  - si la case vaut `G2` → `U+G2`.
  - sinon si présent et case vide → `U`.
- **Poste `BM-BS`** : dans la Passe 3, pour chaque jour de `bmbsDays`, ajouter `BM-BS` à la liste des postes voulus (priorité haute, avant le remplissage générique), attribué à un médecin du pool (pas l'universitaire concerné, qui est déjà `U+G1`). Réparti par `leastFor('BM-BS')` comme les autres postes.
- **Affichage** : ajouter `BM-BS` (et gérer `U+G1` / `U+G2` par le préfixe, comme `ACU` l'est déjà) à `postStyle` (`store.ts`) et à la légende de `PlanningGrid.tsx`.

### Impact
- Le blocage de garde `D−1` peut réduire légèrement les gardes disponibles si beaucoup de jours Univ sont posés. L'infaisabilité reste un résultat de premier rang (renvoyée proprement, jamais de planning cassé).
- Les jours U auto (aucune contrainte posée) sont inchangés.
- Le nouveau poste `BM-BS` n'apparaît que les jours `U+G1`.

### Tests
- Un universitaire qui pose 3 jours Univ → exactement ces 3 jours en `U`, aucun jour U supplémentaire.
- Un universitaire qui ne pose aucun jour Univ → placement auto au % inchangé.
- Univ le jour `D` → garde bloquée le jour `D−1`, garde autorisée le jour `D`.
- Universitaire de garde G1 sur son jour Univ → case `U+G1` **et** un autre médecin a `BM-BS` ce jour-là.
- Universitaire de garde G2 sur son jour Univ → case `U+G2`, aucun `BM-BS` généré de ce fait.
- Case peut porter `state='souhait_garde'` **et** `univ=true` simultanément (persistée et rechargée sans perte).
- Un jour `state='dispo'` + `univ=true` n'est pas supprimé à l'enregistrement.

---

## Ordre d'implémentation suggéré
1. **Feature 1** (isolée, sans DB) — la plus sûre, valide la mécanique des rôles.
2. **Feature 2** (profil + DB + admin + moteur).
3. **Feature 3** (la plus large : DB + API + UI dispos + moteur + affichage).

Chaque feature : tests moteur d'abord, puis `npm run build`, puis commit (sans co-auteur). Migrations DB appliquées sur Neon avant le déploiement des features 2 et 3.

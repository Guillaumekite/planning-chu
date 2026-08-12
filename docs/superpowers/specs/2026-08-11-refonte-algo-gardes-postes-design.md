# Refonte de l'algorithme gardes + postes — spec validée

Date : 2026-08-11 · Statut : en attente de validation finale par Guillaume
Fichiers concernés : `src/engine/gardes.ts`, `src/engine/planning.ts`, `src/engine/types.ts`,
`src/app/api/generate/route.ts`, profil médecin (schéma + UI admin).

## Problèmes constatés (planning réel)

1. Nombre de gardes non proportionnel aux jours travaillés (3 vs 6-7 à présence égale).
2. Deux gardes le même jour de week-end dans le mois (2 vendredis, 2 samedis…).
3. Gardes trop rapprochées pour certains, très espacées pour d'autres ; médecins sans garde
   sur des semaines entières travaillées.
4. Jours Univ déclarés ⇒ l'auto-complétion au ratio du profil est désactivée
   (bug `planning.ts` : `if (univDays[doc].size > 0) continue;` — cas Gravero, sept. 2026).
5. HC = « le reste » : aucune équité, mêmes personnes en HC plusieurs jours d'affilée.
6. Postes de base (BM, S, CS1, CS2) : répétitions en série, rotation insuffisante.

## Priorités (ordre imposé)

1. Refonte de l'équité des gardes (la première chose que fait l'algo).
2. Complétion automatique des jours Univ au ratio.
3. Répartition équitable et tournante des postes communs (méthode/ordre d'attribution revus).
4. HC devient un poste équitable + case profil « Jamais HC ».

---

## 1. Gardes (étape A — `gardes.ts`)

### 1.1 Contraintes dures (jamais violées)

- 2 gardes/jour (G1 + G2), tous les jours du mois.
- Jours bloqués : congé, jour off TP, G−, veille d'un jour Univ, report RS inter-mois (1er/2).
- Repos entre deux gardes d'un même médecin : **≥ 2 jours sans garde** (le RS + 1 jour) —
  soit une distance minimale de 3 jours calendaires. Relaxable à 1 jour (le RS seul,
  distance 2) uniquement via l'échelle de relaxation (§1.4).
- Plafond mensuel : **7 gardes grand max** ; au-delà de 7 uniquement si le médecin a posé
  plus de 7 G+ (son plafond devient alors son nombre de G+ retenus).
- G+ : garde obligatoire le jour posé. Deux G+ d'un même médecin sont acceptés dès qu'il
  reste **≥ 2 jours de repos entre les deux gardes** (distance 3). Si ≥ 3 candidats G+ le
  même jour : tirage au sort déterministe (inchangé), les perdants sont avertis.
- **Plancher d'effectif : tout jour ouvré avec < 6 médecins présents (hors congé, TP off)
  ⇒ génération IMPOSSIBLE**, message admin listant précisément le(s) jour(s) en cause.
  On ne relâche aucune règle en dessous de ce plancher. (Week-ends/fériés : plancher
  inchangé de 2 éligibles aux gardes.)

### 1.2 Règles week-end (ven/sam/dim)

- Max **2 gardes de week-end** par médecin et par mois (algo).
- **Jamais deux fois le même jour** : au plus 1 vendredi, 1 samedi, 1 dimanche.
- Exception G+ uniquement : des G+ posés sur des jours de WE peuvent dépasser ces caps
  (ex. G+ sur 2 samedis ⇒ accordé). Dans ce cas, **l'algo n'ajoute aucune garde de
  week-end supplémentaire** à ce médecin : ses gardes de WE = exactement ses G+ de WE.

### 1.3 Équité (dans le solveur ET la recherche locale)

- **Cible par médecin** = proportionnelle aux jours travaillés du mois
  (FTE × jours disponibles), corrigée par le mois précédent en **ratio**
  (gardes / jours travaillés du mois publié précédent), jamais en compte brut.
- **La correction de carry est bornée à ±1 garde** : le mois précédent ajuste, il n'écrase
  jamais l'équilibre du mois courant. (Historique : 1 mois aujourd'hui ; lissage 2-3 mois
  prévu à partir de novembre 2026 — hors scope ici.)
- **Cible 6 max** : la 7e garde n'est attribuée que via l'échelle de relaxation (effectif
  insuffisant, exceptionnel, jamais la norme) ou par G+.
- Le MILP porte désormais l'équité (bornes par médecin autour de la cible + objectif),
  au lieu de la seule faisabilité. La recherche locale ajoute des **échanges de gardes
  entre deux médecins** (swaps) en plus des déplacements simples, pour sortir des
  optima locaux responsables des écarts 3 vs 7.
- **Espacement** : poids fortement augmenté (aujourd'hui 0,3 vs 10 pour le nombre) —
  gaps réguliers dans le mois pour chaque médecin, et équité des gaps entre médecins.
  La préférence « garde samedi → jeudi suivant » est abandonnée pour l'instant.
- **Règle hebdomadaire** : toute semaine calendaire (lun→dim) entièrement dans le mois où
  le médecin est présent tous les jours ouvrés (ni congé ni TP off) doit contenir
  ≥ 1 garde. Sinon ⇒ **anomalie écrite dans le bandeau admin à la génération**.
  Exception : G− posés sur toute la semaine. Les temps partiels ont par construction des
  jours off chaque semaine ⇒ jamais d'anomalie hebdo, leur équité est portée par la cible
  pro-rata et l'espacement. Arithmétique : 14 gardes/semaine seulement (2×7) — si plus de
  14 médecins travaillent une semaine complète, l'algo fait tourner qui « saute » sa
  semaine et chaque cas ressort en anomalie.

### 1.4 Échelle de relaxation (mois trop contraint)

Quand aucune solution n'existe avec toutes les règles, on sacrifie dans cet ordre,
chaque étape produisant son avertissement admin :

1. Autoriser des **7e gardes** (ciblées sur les médecins les plus disponibles).
2. Réduire le repos entre gardes : 2 jours → **1 jour** (le RS seul).
3. Autoriser **2 fois le même jour de week-end**.
4. En tout dernier recours : **ne pas honorer certains G+**.

Plancher absolu (§1.1) : < 6 présents un jour ouvré ⇒ on n'entre pas dans l'échelle,
c'est impossible, message avec les jours en cause.

## 2. Univ (étape B)

- Jours Univ déclarés = fixes (inchangé).
- **Nouveau : complétion automatique jusqu'au ratio du profil** (`universityRatio`),
  même quand des jours sont déclarés. Nombre total de U ≈ ratio × jours ouvrés
  travaillés ; les jours déclarés comptent dedans, l'algo complète le reste.
- Les jours ajoutés automatiquement privilégient les **jours à fort effectif** (ceux qui
  produiraient de l'HC), sans jamais faire tomber un jour sous la couverture du cœur de
  postes ; à surplus égal, répartition régulière dans le mois.
- Pause académique juillet/août : inchangée (pas d'auto-complétion ces mois-là).

## 3. Postes communs (étape B — méthode revue)

Le cœur du changement : **on choisit d'abord qui part en HC, ensuite on distribue les
postes** — et non l'inverse (aujourd'hui l'HC est « le reste », d'où les séries).

Chaque jour ouvré :

1. Postes fixes posés comme aujourd'hui (CA, G1, G2, RS, U, ACU, récup).
2. Si le pool dépasse les postes distribuables du jour : sélection des **HC du jour par
   équité** — plus faible compteur HC (proraté sur les jours de présence), jamais deux
   jours d'affilée si évitable, exclusion des profils « Jamais HC ».
3. Distribution des postes au reste du pool avec les compteurs d'équité existants,
   renforcés par une **anti-répétition** : éviter le même poste que la veille quand une
   alternative existe (généralisation de la règle déjà en place pour CS).
4. Le moteur CS (compteur combiné proraté, cap 6/mois, alternance CS1/CS2) est conservé.
5. Postes réservés inchangés : CD (profil douleur), P (case P), Ped, MM/MS, S (« Pas de S »).

## 4. Profil médecin

- Nouvelle case **« Jamais HC »** (comme Univ, TP, P) : schéma zod de la route, type
  `DoctorProfile`, UI admin. Utilisée par la sélection HC (§3.2). Cas d'usage : Dr Dzierzek.

## Hors scope (traité plus tard)

- Pinceau « P » sur le planning de Dzierzek (jours P quand ≥ 12 travaillants).
- Préférence d'espacement « samedi → jeudi ».
- Lissage du carry sur 2-3 mois (novembre 2026).

## Tests (moteur, vitest)

- Équité : à présence égale, écart de gardes ≤ 1 sur un mois type ; carry en ratio borné ±1.
- Week-end : jamais 2× le même jour de WE sans G+ ; G+ WE ⇒ zéro garde WE ajoutée.
- Plafonds : 6 par défaut ; 7 seulement via relaxation (avec avertissement) ; 8 via G+.
- Repos : distance 3 respectée ; relaxation à 2 seulement à l'étape 2 de l'échelle.
- Règle hebdo : anomalie émise pour une semaine complète travaillée sans garde ; pas
  d'anomalie si G− toute la semaine ou temps partiel.
- Plancher : jour ouvré à 5 présents ⇒ statut infaisable avec le(s) jour(s) listé(s).
- Univ : jours déclarés + complétion exacte au ratio (cas Gravero) ; rien en juillet/août.
- HC : répartition (max-min ≤ 1 proraté), jamais 2 jours d'affilée si évitable,
  « Jamais HC » respecté.
- Anti-répétition : pas deux fois le même poste de base deux jours de suite quand une
  alternative existe.
- Déterminisme : même entrée ⇒ même planning (aucune horloge, RNG seedé inchangé).

---

## Addendum (2026-08-12) — deux règles validées après la PR initiale

### A. Minimum 2 gardes pour les présents ≥ 8 jours
Tout médecin présent ≥ 8 jours ouvrés (hors congé, hors jour off TP) reçoit **au moins
2 gardes** dans le mois — l'allègement des plus chargés (gardes et week-ends) passe par là.
Souple : si les disponibilités l'empêchent (moins de 2 jours gardables, ou trop rapprochés),
l'algo fait le maximum et **avertit l'admin**. Exemption si G−/blocage rend toute garde
impossible. Les gardes issues d'un G+ restent inamovibles : le rééquilibrage ne joue que sur
les gardes libres.

### B. Sièges HC → jours U pour les universitaires
Un universitaire **sous son ratio** présent un jour à surplus prend le siège HC en **U**
au lieu d'un HC (le ratio prime sur la régularité des jours U — décision explicite).
Le placement classique (jours à fort effectif, garde-fou du cœur) reste la première passe ;
la conversion HC→U comble le déficit restant pendant la Pass 3 ; l'avertissement
« complétion partielle » n'est émis qu'en toute fin, sur le manque réellement restant.

Tests : cibles minTwo (2 gardes atteintes / impossible ⇒ 1 + warning), intégration G−,
scénario de complétion bloquée (garde-fou ≥ 9) comblé par conversion, invariant « un
universitaire sous son objectif ne reçoit jamais de HC ».

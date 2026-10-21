# Équité des gardes V2 — « solde de gardes » à mémoire longue (décision du 21/10/2026)

## Intention et pourquoi

La répartition mensuelle des gardes produit des écarts vécus comme injustes (ex. 3 gardes
contre 5 entre deux médecins également présents). Diagnostic (session du 21/10, validé sur
les plannings publiés réels juillet→novembre 2026) — deux causes dans `src/engine/gardes.ts` :

1. **Cibles arrondies** : `Math.round(cible)` fait que la somme des cibles ≠ nombre de places
   (ex. 59 cibles pour 62 gardes). Les gardes « orphelines » sont posées arbitrairement par le
   MILP (pénalité linéaire indifférente) et sont inamovibles au polissage : quand deux cibles
   diffèrent d'exactement 1, passer de {5,3} à {4,4} a un delta quadratique exactement nul,
   or le polissage exige une amélioration stricte.
2. **Rattrapage à mémoire d'un mois** : le report (`carryCount` ±1) ne regarde que le dernier
   mois publié. Tout déséquilibre plus ancien est oublié (oscillations réelles observées :
   ESSONO 8 gardes en juillet → 1 en août → 5-5-5 en sept-oct-nov), et les éditions manuelles
   de ±2-3 gardes dépassent la capacité de correction (±1).

Décision de Guillaume : **option 1** (« solde de gardes ») + 3 correctifs, **ancrée au
1er septembre 2026**, avec **retour arrière possible en prod sans redéploiement**.

## Objectifs

- Chaque mois généré est **plat** : à présence égale, écart de gardes ≤ 1 (plus jamais 3 vs 5).
- La mémoire est **longue et complète** : un déséquilibre (y compris créé par édition manuelle)
  est remboursé au fil des mois (~1 garde/mois/médecin max), jamais oublié.
- **Transparence côté admin uniquement** : le solde est visible dans l'admin (brouillon, publié,
  édition en direct) ; il n'apparaît **ni** sur la consultation publiée **ni** dans l'export.
- **Réversibilité** : interrupteur admin (base `app_config`) ; éteint → comportement actuel à
  l'identique, aucune migration ni nettoyage (le solde n'est jamais stocké, toujours recalculé).

## Non-objectifs / anti-objectifs (V1)

- **Pas de refonte des rotations week-end (ven/sam/dim) et jours pénibles (jeu→dim)** : elles
  gardent leur fonctionnement actuel (fenêtre d'un mois, plafonds durs). Une V2 pourra les
  brancher sur le solde **rétroactivement depuis le même ancrage septembre** (les grilles
  publiées contiennent tout). Décision explicite : pendant la V1, leur équité reste « ni mieux
  ni pire » qu'aujourd'hui.
- Pas de régénération des mois déjà publiés (septembre, octobre, novembre restent tels quels ;
  **décembre 2026 est le premier mois généré avec le nouveau système**).
- **L'été n'est pas remboursé** : juillet/août 2026 sont exclus du compteur (données jugées trop
  sales : éditions manuelles massives, 3 jours d'août sans G1 ou G2, médecins au-delà du
  plafond 7). Choix assumé par Guillaume.
- Anti-objectif : toute modification du comportement de **génération** quand l'interrupteur est
  éteint. Le chemin « V1 actuelle » doit rester bit-à-bit identique (fidélité du rollback) —
  y compris son bug d'arrondi, qui n'est corrigé que dans le chemin V2.
- Périmètre de l'interrupteur (choix du développeur, validé par la relecture) : il ne gate que
  la **génération** et l'**affichage du solde** (colonne masquée quand éteint). Le **garde-fou
  de publication reste actif en permanence** : c'est une protection d'intégrité des données —
  le désactiver pendant un retour arrière laisserait publier des grilles trouées qui
  empoisonneraient le solde à la réactivation.

## Conception

### 1. Le solde

Pour générer le mois M : `solde(médecin) = Σ sur les mois publiés m, ANCRAGE ≤ m < M` de
`(gardes faites en m) − (gardes dues en m)`, avec :

- `ANCRAGE = septembre 2026` (constante de code, documentée).
- `gardes faites` = cases G1/G2 de la **grille publiée** (fonction `gardeRole` existante de
  `src/lib/grid-checks.ts`) — les modifications manuelles comptent donc automatiquement.
- `pot du mois` = Σ gardes réellement présentes dans la grille (gère les jours troués : si le
  mois n'a que 59 gardes, on répartit 59 dus — Σ soldes reste ≈ 0).
- `gardes dues` = pot × poids(médecin) / Σ poids, avec
  `poids = présence × (jours du mois − jours G−) / jours du mois` :
  - **présence** = cases non vides hors CA et ABS dans la grille publiée (nouvelle fonction dans
    `src/lib/solde.ts` ; on n'altère pas `workedDaysFromGrid` qui nourrit l'ancien chemin —
    différence voulue : ABS exclu, contrairement à l'ancien compteur). Approximation
    documentée : les RS et gardes comptent dans la présence (effet de second ordre, assumé).
  - **jours G−** = jours `no_garde` de l'historique des disponibilités du mois (table
    `availability`, conservée par mois) ; table vide pour ce mois → facteur 1. Ce facteur est
    le miroir exact de la part de gardes que la génération pouvait donner (`gardeWeight` =
    fte × fraction disponible) : un médecin qui refuse les gardes (G− chronique) ne « doit »
    pas de gardes, sinon son solde dériverait négativement sans fin (décision du relecteur,
    choix du développeur). Conséquence : le solde se calcule côté serveur ; pour l'édition en
    direct, `GET /api/solde` fournit aussi le facteur G− par médecin et le client recalcule
    les dus sur la grille éditée.
- Médecin absent d'une grille ce mois-là, ou nouveau : contribution nulle (solde neutre).
- Seuls les mois **strictement antérieurs à M** comptent (vous publiez en avance : régénérer
  octobre pendant que novembre est publié ne doit lire que septembre).
- Le solde n'est **jamais stocké** : recalculé à chaque usage depuis la base des plannings.

### 2. Cibles entières (correctif de l'arrondi, chemin V2 uniquement)

- Part brute de chaque médecin = poids actuel (`fte × fraction de disponibilité`, inchangé).
- Cibles entières par **répartition au plus fort reste** : chacun reçoit `floor(part)`, puis les
  unités restantes (somme exacte = 2 × jours du mois) vont par priorité décroissante
  `priorité = (part − floor(part)) − solde`. Un solde très négatif (en retard) garantit le
  « +1 » chaque mois jusqu'à remboursement ; un solde positif l'évite.
- Une unité n'est attribuée qu'aux médecins dont la part fractionnaire est > 0 (un médecin à
  part entière — cas rare — ne déborde pas de `ceil(part)` ; limitation documentée : mois à
  parts toutes entières = aucun vecteur de rattrapage ce mois-là).
- Chaque cible reste dans {floor(part), ceil(part)} → **écart ≤ 1 garanti entre médecins de
  même poids**.
- Le MILP (`eq_` rows) et le polissage (`tgtCount`) consomment ces cibles entières : tout « +1 »
  a un « −1 » en face, le gel par égalité parfaite disparaît.

### 3. Interrupteur (rollback)

- Clé `app_config` : `equity_v2`, valeurs `'on'`/`'off'`. **Absente = `on`** (la décision).
- `/api/generate` lit la clé côté serveur (autorité). `on` → calcule le solde et passe le mode
  V2 au moteur ; `off` → chemin actuel inchangé (`computeGardeTargets` + `Math.round`).
- UI : case à cocher dans l'admin (page planning, près de la génération) « Équité V2 — solde
  depuis sept. 2026 », lue/écrite via une petite route admin `/api/config` (GET/PUT, PUT
  réservé admin).
- En V2, `carryCount`/`carryWorked` ne pilotent plus les cibles de comptage, mais restent
  transmis pour le rapport cumulé et pour les axes week-end/pénibles (inchangés).

### 4. Garde-fou de publication (correctif 2)

- Validation **côté serveur** dans `POST /api/plannings` : chaque jour doit avoir exactement
  1 G1 et 1 G2 dans la grille. Sinon → 400 avec la liste des jours fautifs, **sauf** si le corps
  contient `force: true`.
- UI : la publication d'une grille trouée affiche un bandeau rouge listant les jours, et exige
  une confirmation distincte et explicite (bouton dédié « Publier malgré N jour(s) sans garde
  complète ») qui renvoie `force: true`. Le « passer outre » générique actuel (avertissements)
  ne suffit plus pour ce cas.
- Validateur pur partagé (`src/lib/grid-checks.ts`) utilisé par la route et le client.

### 5. Affichage du solde (correctif 3) — admin uniquement

- `EquityTable` (composant local d'`AdminClient`) : colonne « Solde » (1 décimale, signe
  explicite, ex. `+2,3` = en avance → prioritaire pour en faire moins).
- Brouillon généré : `/api/generate` renvoie le solde d'entrée utilisé (champ à part dans la
  réponse, **pas** dans `gardeEquity` pour qu'il ne soit jamais stocké/publié).
- Vue publiée & édition : nouvelle route admin `GET /api/solde?year&month` → solde d'entrée du
  mois. Pendant l'édition, le client calcule en direct `solde après = solde d'entrée +
  (faites − dues)` sur la grille éditée (fonctions pures de `src/lib/solde.ts`, utilisables
  côté client).
- La consultation publiée (`PlanningView`) et l'export n'affichent rien de nouveau (ils ne
  reçoivent jamais le solde).

## Contraintes

- Moteur pur et déterministe (pas de Date.now/aléatoire) : l'ancrage et le solde entrent en
  paramètres ; départages déterministes (reste fractionnaire, puis nom).
- Les tests moteur existants ne règlent pas le mode → ils restent sur le chemin V1 et doivent
  passer **sans modification**. Les nouveaux tests couvrent le mode V2.
- Conventions repo : commits sans co-auteur ; `npm run build` obligatoire avant push ; livraison
  par PR vers `main` (Guillaume merge) ; tout nouveau champ d'API validé par zod.
- Identité des médecins par nom (clé des grilles) : un renommage casserait la continuité du
  solde (limitation existante du carry, documentée, acceptée).

## Ce qui est laissé au développeur

- Détails de style UI (case à cocher, colonne, bandeau) dans l'existant Tailwind.
- Forme exacte des réponses JSON de `/api/config` et `/api/solde`.
- Découpage des fonctions pures dans `src/lib/solde.ts` et leurs tests.
- Mécanique interne du moteur pour brancher cibles entières (nouveau paramètre d'entrée
  `GardeInput` : solde + mode), tant que le chemin V1 reste intact.

## Plan de validation

1. Tests unitaires : solde (ancrage, mois troués, CA/ABS, médecin nouveau/absent, publication
   en avance), répartition entière (Σ = places, bornes floor/ceil, priorité par solde,
   déterminisme), garde-fou (jours fautifs, force).
2. Tests moteur V2 : mois sans contrainte → écart ≤ 1 ; solde négatif → reçoit le « +1 » ;
   suite existante inchangée au vert.
3. Simulation 12 mois (harnais `.context/repro-equity2.ts` adapté au solde) : écart mensuel ≤ 1
   entre médecins 100 % dispo, convergence du solde.
4. `npm test` + `npm run build`, PR, vérification du déploiement Vercel après merge.

## Procédure de retour arrière (prod)

Décocher « Équité V2 » dans l'admin (ou `UPDATE app_config SET value='off' WHERE
key='equity_v2'`). La génération suivante reprend l'ancien comportement à l'identique. Aucune
donnée à migrer ou nettoyer. Les plannings déjà publiés ne sont jamais affectés.

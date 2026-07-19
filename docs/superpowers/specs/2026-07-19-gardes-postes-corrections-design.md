# Corrections algo gardes + postes : G+/G− durs, présence réelle, table de postes, cap 7

Spec issue du retour utilisateur du 2026-07-19 (3 points) + reproduction empirique.

## Diagnostic (causes racines confirmées)

1. **G+ ignorés** : `solveGardes` reçoit `wishes` (état `souhait_garde`) mais ne les utilise que
   dans la chaîne `reason` — jamais comme contrainte ni objectif. `weights.wishHonored` n'est
   branché nulle part.
2. **Dzierzek G1 / ACU disparus** : le moteur est correct (reproduction : jamais G1, ACU posés)
   quand `profiles[doc].acupuncture` est présent. Le symptôme du site vient de l'entrée (flag
   non transmis à la génération, ou case "Acupuncture" décochée). Il manque un garde-fou visible.
3. **"Présents" = cochés** : `presentCount` compte les universitaires en U comme présents, et la
   récup lundi utilise `teamSize = doctors.length` (roster coché) au lieu des présents réels.
   La liste de postes `Ped, MM/MS, BM-BS, S, CS1, BM, CS2, BM, BM, P` ne correspond pas à la
   table de staffing exigée (à 8 présents on obtient Ped+MM et zéro BM/CS).

## Règles corrigées

### A. Vœux de garde (G+ / G−)
- **G−** (`no_garde`) : déjà une contrainte dure (aucune garde ce jour). Inchangé. Si un jour
  devient infaisable (< 2 éligibles), le résultat `infeasible` le dit à l'admin (existant).
- **G+** (`souhait_garde`), nouveau — contraintes dures + avertissements :
  - Par jour, W(d) = médecins ayant posé G+ ce jour et non bloqués.
  - |W(d)| ≤ 2 → chaque médecin de W(d) reçoit **obligatoirement** une garde ce jour (MILP fixe).
  - |W(d)| ≥ 3 → les 2 gagnants sont **tirés au sort** parmi W(d) (tirage déterministe, seedé par
    année/mois/jour : regénérer le même mois redonne le même tirage) et forcés ; warning listant
    retenus et non-retenus. [amendé 2026-07-19 : tirage au sort au lieu de la simple réservation]
  - Vœu sur jour bloqué (congé, G−, TP) → ignoré + warning.
  - Deux G+ du même médecin espacés de < 3 jours → seul le premier est forcé + warning
    (règle de repos).
  - Si le MILP devient infaisable avec les forçages → nouvelle résolution **sans** forçage +
    warning global « Impossible d'honorer les G+ (repos/effectif) ».
  - La recherche locale d'équité ne déplace jamais une garde forcée par un G+ et respecte les
    jours réservés.
- **Cap dur : ≤ 7 gardes/mois/médecin.** Exception : un médecin ayant posé plus de 7 G+ honorés
  peut aller jusqu'à son nombre de G+ (ex. 8 G+ → cap 8). Si l'effectif rend le cap intenable
  (2×jours > Σ caps), résultat `infeasible` avec message explicite.
- `GardeResult`/`PlanningResult` (feasible) gagnent `warnings: string[]`, affichés dans /admin.

### B. Présence réelle ("travaillants")
`workingCount(jour)` = médecins du roster qui, ce jour :
- ne sont pas en congé (CA),
- ne sont pas en jour non travaillé de temps partiel (TP),
- ne sont pas en U / U+G1 / U+G2 (un universitaire à la fac n'est pas présent en journée —
  il peut faire une garde le soir, sauf veille d'un jour Univ, règle existante conservée).
G1, G2, RS, ACU **et les jours de récup** comptent comme travaillants (« nous sommes 12 à
travailler y compris les RS ») — un médecin en récup compte dans l'effectif mais n'est pas
affectable à un poste. [amendé 2026-07-19] Tous les seuils ci-dessous utilisent ce compte,
plus jamais le nombre de cochés.

### B-bis. « Jamais G1 » (amendé 2026-07-19)
La règle « toujours G2, jamais G1 » concerne le **médecin Dzierzek** (mal de dos), pas
l'acupuncture en soi. Nouveau flag `force_g2` (« Jamais G1 ») sur la fiche médecin, indépendant
du flag acupuncture ; le moteur force G2 pour l'union des deux (l'ACU du lundi + garde du soir
impose de toute façon G2 à l'acupunctrice). Migration one-shot : `force_g2` initialisé à `true`
pour les médecins ayant déjà le flag acupuncture.

### C. Table de postes de journée (jours de semaine)
Pré-posés avant la passe des postes : CA, G1/G2, RS, U (déclaré + auto), ACU, récup.
- **Cœur obligatoire**, dans l'ordre de priorité : [BM-BS si un U+G1 ce jour] puis
  `BM, BM, S`, puis CS :
  - workingCount ≥ 9 → `CS1` et `CS2` ;
  - workingCount = 8 → **un seul** CS, en alternant CS1/CS2 pour garder les comptes équilibrés
    par semaine et par mois (déterministe : on pose celui qui est en retard) ;
  - < 8 → on remplit dans l'ordre tant qu'il y a des médecins.
- **Extras** (uniquement si le pool dépasse le cœur), dans l'ordre :
  1. `Ped` (lun/mer/jeu/ven) ;
  2. `MM`/`MS` : **seulement si le médecin acupuncture (Dzierzek) est de garde ce jour ET
     workingCount ≥ 12** ; label `MS` si jour ACU+G2 (couverture maternité jusqu'à 18h), sinon `MM` ;
  3. `CD` : seulement s'il reste un médecin éligible (douleurPoids ≥ 1) dans le pool après le
     cœur ; choix pondéré par douleurPoids (inchangé) ;
  4. 3ᵉ `BM` si workingCount ≥ 10.
- Reste du pool → `HC`.
- **Poste `P` supprimé** (remplacé par le 3ᵉ BM à ≥ 10 travaillants).
- MM quotidien supprimé (remplacé par la règle Dzierzek-garde + ≥ 12 ci-dessus).

### D. Récup du lundi (comp-off)
- Gardes du **samedi** → lundi suivant off, si `workingCount(lundi)` (avant récup) ≥ **12**,
  seuil **13** si un CD est posable ce lundi (un médecin douleur présent).
- L'ancienne règle vendredi (roster > 12) est **supprimée**.
- L'acupuncteur n'est jamais compensé (garde son ACU). Un médecin déjà en U ce lundi n'a pas
  besoin de récup.

### E. ACU
- Lun + mer (mer → jeu si garde mardi, règle existante), posé seulement si
  `workingCount(jour) ≥ 9` (interprétation de « si l'effectif est suffisant » — en dessous tout
  le monde est requis pour le cœur).
- **Garde-fou** : si la case Acupuncture est cochée mais qu'aucun médecin du roster n'a le profil
  acupuncture → warning explicite (« flag perdu ? Dzierzek recevra des G1 et aucun ACU »).

### F. Gardes — équité (rappel, inchangé sauf cap)
- 2/jour, espacement 3 jours, ≥ 1 garde week-end (ven/sam/dim)/mois, équité ven/sam/dim,
  prorata des jours travaillables (`fte × jours non bloqués / jours du mois`) — inchangés.
- Nouveau : cap 7 (cf. A) appliqué aussi par la recherche locale.

## Interprétations à valider par l'utilisateur
- Seuil ACU = 9 travaillants.
- Récup vendredi supprimée (la nouvelle règle ne mentionne que le samedi).
- Ped/CD uniquement en capacité au-delà du cœur (la table minimale à 9 ne les inclut pas).
- MS conservé comme variante de MM les jours ACU+G2.

## Hors périmètre (inchangé)
`CalendarDay.isWeekend` partagé, règle U (déclaré/auto, juillet-août), BM-BS ↔ U+G1,
alternance G1/G2 (|G1−G2| ≤ 1) et forceG2, TP 3/2, déterminisme du moteur.

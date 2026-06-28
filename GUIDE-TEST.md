# Guide de test — Moteur de planning (gardes)

Ce guide explique comment **tester dès maintenant** le cœur de l'application : l'algorithme
qui génère des plannings de gardes équitables. Il n'y a pas encore d'interface web — on teste
donc le moteur en ligne de commande (terminal).

> Ce qui est testable aujourd'hui : la **génération des gardes G1/G2** (équité, repos,
> infaisabilité, report d'un mois sur l'autre). Pas encore : le site, les comptes, la saisie
> des vœux, les autres postes de la journée, l'export Excel.

---

## 1. Pré-requis (une seule fois)

- **Node.js 18 ou plus** installé (vérifie avec `node -v`).
- Ouvre un terminal **dans le dossier du projet**, puis installe les dépendances :

```bash
npm install
```

---

## 2. Lancer les tests automatiques

```bash
npm test
```

Tu dois voir **17 tests au vert** (`17 passed`) en moins d'une seconde. Ces tests vérifient
automatiquement que le moteur respecte les règles :

| Ce qui est vérifié | Règle métier |
|---|---|
| 1 G1 + 1 G2 chaque jour, sur 2 médecins différents | les 2 gardes obligatoires |
| Jamais 2 gardes à la suite pour un même médecin | repos de sécurité après une garde |
| Aucune garde un jour bloqué | congés / indispo / nouveau |
| Écart du nombre de gardes ≤ 1 | équité de charge |
| Week-ends/jours pénibles répartis | personne n'accumule les corvées |
| Renvoie « impossible » + le jour fautif | mois infaisable (trop de congés) |
| Même entrée → même résultat | déterminisme |

Si tout est vert, le moteur respecte les contraintes.

---

## 3. Voir un planning concret (démo)

```bash
npm run demo
```

Ça simule **3 mois d'affilée** (avril, mai, juin 2026) avec 18 médecins, quelques congés et
quelques vœux de garde — et **reporte l'équité d'un mois sur l'autre**.

Pour chaque mois tu obtiens :

**a) Le planning jour par jour** (les week-ends sont marqués d'une `*`) :

```
  Jour       G1           G2
  Mer  1     HOUNDJE      SBOUI
  Jeu  2     HANNAFI      KARADJI
  Sam  4 *   DE NEEF      GOUDEAU
  ...
```

**b) Le tableau d'équité du mois** :

```
  Médecin      gardes  we   cumul gardes  cumul pénibles
  DZIERZEK     4       1    4             2
  ...
```

- `gardes` = nombre de gardes ce mois-ci
- `we` = gardes de week-end (samedi/dimanche) ce mois-ci
- `cumul gardes` / `cumul pénibles` = totaux **reportés** depuis le début (c'est ce qui sert
  à équilibrer le mois suivant)

**c) À la fin, le bilan sur 3 mois** — c'est là qu'on voit l'équité dans le temps :

```
  Médecin      gardes  we   pénibles
  DZIERZEK     11      2    6
  ESSONO       10      1    6
  ...
  Écart nombre de gardes sur 3 mois : 1 | écart week-ends : 3
```

**Comment lire** : tout le monde finit autour du **même nombre de gardes** (écart ≈ 1), et les
**week-ends + jours pénibles tournent** entre les médecins. C'est la réponse concrète à
« est-ce que ça change d'un mois sur l'autre pour que ce ne soit pas toujours les mêmes » :
**oui**, parce que les compteurs sont reportés et rééquilibrés.

---

## 4. Tester TES propres cas

Ouvre le fichier **`src/engine/demo.ts`** et modifie :

- **La liste des médecins** (`DOCTORS`) — ajoute / enlève des noms.
- **Les contraintes par mois** (`MONTHS`) :
  - `blocked` = jours où un médecin **ne peut pas** être de garde (congé, indispo). Ex :
    `KABA: [1, 2, 3]` = KABA bloqué les 1, 2, 3.
  - `wishes` = jours où un médecin **souhaite** une garde. Ex : `SBOUI: [11]`.

Puis relance `npm run demo`.

**Idées de tests à faire :**
- Mets **beaucoup de congés le même week-end** → le moteur doit afficher
  « ⛔ INFAISABLE » avec le jour concerné (au lieu d'un planning faux).
- Donne un **vœu de garde** à quelqu'un et vérifie qu'il l'obtient (mention « vœu honoré »).
- Réduis à **6-7 médecins** pour voir l'équité se resserrer sur un petit effectif.

---

## 5. Ce qui n'est pas encore testable

- Le **site web** (rien à ouvrir dans le navigateur pour l'instant, hormis la page Next.js par défaut).
- Les **comptes / connexion** (nom + mot de passe).
- La **saisie des vœux** par les médecins (grille couleur).
- Les **autres postes** de la journée (BM, S, CS1/CS2, Ped…).
- L'**export Excel**.

Ces éléments sont planifiés et viendront ensuite. Pour l'instant, le test porte sur le
« moteur mathématique » — la pièce la plus difficile, et celle qui fait l'équité.

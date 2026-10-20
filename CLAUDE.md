# CrocoFit (ex-Coach Maison) — consignes pour Claude Code

## Le projet

Petite app web de sport à la maison, façon Freeletics simplifié, faite par Côme pour sa femme.
Nom affiché : **CrocoFit** (icône : crocodile vert sur fond orange). Les identifiants internes gardent
l'ancien nom (`coachMaison.v1`, `app:'coach-maison'`) : ne jamais les renommer.
Elle l'utilise sur son téléphone, ajoutée à l'écran d'accueil, via GitHub Pages
(branche `main`, dossier racine). Merger dans `main` = mise en ligne en ~1 min.

Côme n'est pas développeur : explique tes changements en français simple, sans jargon,
et termine chaque tâche par ce qu'il doit faire (ex. « clique sur Create PR puis Merge »).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | **Toute l'app** : HTML + CSS + JS dans un seul fichier, sans dépendance |
| `manifest.json`, `icon.png` | Installation sur l'écran d'accueil (nom, icône, plein écran) |
| `tests/coach.test.cjs` | Série de tests (node:test + Playwright, écran taille iPhone) |
| `package.json` | Lance les tests (`npm test`) |

## Règles à ne jamais casser

1. **Données de l'utilisatrice.** Tout est stocké dans `localStorage` sous la clé
   `coachMaison.v1` (objectifs par exercice, historique, réglages). Ne change jamais cette clé
   ni la forme des données sans migration : sinon elle perd son historique et ses niveaux.
   Pour ajouter un champ, passe par `normalize()` (valeur par défaut si absent).
   Ajouter un exercice dans `EXERCISES` est sans risque : `normalize()` l'initialise.
2. **Format de sauvegarde.** Le fichier exporté (`{app:'coach-maison', version, data}`) doit
   rester importable. Les anciennes sauvegardes doivent continuer à se restaurer.
3. **Un seul fichier, zéro dépendance.** Pas de framework, pas de build, pas de CDN, pas de
   backend, pas de service worker (risque de version figée en cache sur iPhone).
4. **Mobile d'abord.** Écran ~390 px, boutons ≥ 44 px, pas de défilement horizontal,
   textes en français avec le tutoiement.
5. **Garde les points d'accroche des tests** : attributs `data-test="…"` et `window.CM`.

## Comment marche l'app (repères dans `index.html`)

- `EXERCISES` : catalogue (~55 exercices). Type `reps` ou `time`, objectif de départ (`start`),
  haltère de départ (`weight`), zone(s) `z` (`bas` / `haut` / `abdos` / `cardio`), `sides` = de chaque
  côté, `pace` = secondes par répétition, `floor` = au sol, `hard` = effort intense,
  `gear` = chevillères, `warm` = échauffement (jamais ajusté ni stocké).
- `WARMUPS` : échauffements (~2 min 15) par zone. `RECIPES` : les 12 séances (muscu / cardio),
  format `circuit` (tours), `pyramid` (paliers 60→100→60 %, pauses en pyramide) ou `tabata`
  (8 × 20 s / 10 s). `slots` = zones dans lesquelles l'app choisit les exercices.
- `CYCLE` : programme sur 4 semaines (3 séances, muscu/cardio en alternance). `ensurePlan()` génère
  la semaine (stockée dans `state.plan`, stable toute la semaine). `makeSession()` choisit les exercices
  faits il y a le plus longtemps (`state.ex[id].last`) et règle tours/paliers pour viser ~20 min.
- Séances en plus : `EXTRA_THEMES` (bouton « + Séance en plus »), comptent dans la semaine.
- `REST` + `restFor()` : pauses (muscu 15 s, cardio 10 s, +5/+10 s pour changer d'haltère, mettre
  les chevillères, passer au sol, après un effort long/intense ; plafonds 25/20 s).
- `FEEL` : forme du jour choisie sur l'écran matériel (fatiguée −15 %, +5 s sur les pauses ≥ 15 s,
  un bloc de moins en tabata ; en forme +10 %, 25 s d'effort en tabata). N'affecte que la séance du jour.
- `adjust()` : la règle d'ajustement, exercice par exercice, appliquée à l'enregistrement :
  Trop dur −15 %, Trop facile +15 %, 2 « OK » de suite +5 %, pas de réponse = rien.
  Au moins ±1 répétition ou ±5 s. Bornes 5–30 répétitions et 15–60 s. Au max : haltère
  +1 kg (max 3 kg, elle a 1, 2 et 3 kg) et objectif ramené à 20 répétitions. Au min : haltère −1 kg
  et objectif remonté pour garder le même effort (5 rép. à 2 kg → 10 rép. à 1 kg).
  Un jour « fatiguée », « Trop facile » compte comme « OK » ; un jour « en forme », « Trop dur » compte comme « OK ».
  Dans une pyramide, le ressenti n'est demandé qu'à partir du palier le plus dur.
- Motivation, tout recalculé depuis l'historique (gardé sur 1 500 séances) : points (`sessionPoints`,
  `totalPoints`), `LEVELS` (13 niveaux, « Légende » vers 1 an de pratique régulière, puis +1 niveau tous les
  1 500 points), `formeIndex()` (100 + 1 point par 10 % de progrès sur un exercice, jamais sous 50, valeur gardée
  dans chaque séance de l'historique pour la courbe), `streak()` (semaines d'affilée à 3 séances).
- Stockage : `load()` ne doit jamais mener à écraser des données non lues. Données illisibles → copiées dans
  `coachMaison.v1.illisible` ; écriture impossible (navigation privée, mémoire pleine) → `readOnly`, `save()` ne fait rien.
- Anti double tap : les boutons d'étape (Go, Passer, Terminé, J'ai tout) ignorent un 2e tap à moins de 0,4 s.
  Dans les tests, utiliser `tap()` (avance l'horloge de 0,45 s) pour ces boutons.
- Moteur de séance : `buildPlan()` → étapes `gear` (matériel + forme du jour) / `ready` / `work` / `rest`,
  chrono basé sur `Date.now()` (fiable même si l'écran se met en veille), `tick()` toutes les 200 ms.
- Sons (Web Audio), voix (`speechSynthesis`), vibration, écran allumé (Wake Lock) :
  tous dans des `try/catch`, l'app doit marcher sans eux.
- Champs ajoutés en v2 (via `normalize()`) : `ex[id].last`, `plan`, et dans l'historique `kind`,
  `extra`, `week`, `slot`, `feel`, `forme`. Les anciennes données et sauvegardes restent valides.

## Avant de pousser

1. `npm install` puis `npm test` → les 62+ tests doivent passer.
   (Si `npm install` échoue, essaie quand même `npm test` : le test retrouve un Playwright
   préinstallé. Si Chromium manque : `npx playwright install chromium`. Si rien ne marche,
   dis-le clairement plutôt que de sauter les tests.)
2. Ajoute ou adapte un test pour chaque nouvelle fonction.
3. Incrémente `VERSION` dans `index.html` (affichée dans Réglages).
4. Ne committe jamais `node_modules/` (crée un `.gitignore` si besoin).

## Mise en ligne

Côme ne veut pas ouvrir GitHub : tu fais tout toi-même. Travaille sur une branche, committe,
pousse, crée la pull request puis merge-la (`gh api repos/comedpz/sport/pulls/…` ;
l'API GraphQL de `gh pr` est bloquée ici).
**Merger dans `main` = mise en ligne sur le téléphone de sa compagne** : fais-le seulement si
Côme l'a demandé explicitement pour ce changement (« mets en ligne », « publie »…).
Sinon, demande-lui confirmation avant de merger.

## Idées déjà évoquées pour la suite

- Noter la course de 5 km hebdomadaire dans l'historique.
- Choisir la durée de la séance (15 / 20 / 30 min) : `makeSession()` vise déjà une durée (`TARGET_SEC`).

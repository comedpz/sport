# Coach Maison — consignes pour Claude Code

## Le projet

Petite app web de sport à la maison, façon Freeletics simplifié, faite par Côme pour sa femme.
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

- `EXERCISES` : catalogue (type `reps` ou `time`, objectif de départ, haltère de départ,
  `sides` = de chaque côté, `pace` = secondes estimées par répétition, `warm` = échauffement).
- `SESSIONS` : séances (liste d'exercices, nombre de tours, repos). `mini: true` = ne compte
  pas dans l'objectif de 3 séances par semaine.
- `adjust()` : la règle d'ajustement, exercice par exercice, appliquée à l'enregistrement :
  Trop dur −15 %, Trop facile +15 %, 2 « OK » de suite +5 %, pas de réponse = rien.
  Au moins ±1 répétition ou ±5 s. Bornes 5–30 répétitions et 15–60 s. Au max : haltère
  +1 kg (max 3 kg, elle a 1, 2 et 3 kg) et objectif ramené à 20 répétitions.
- Moteur de séance : `buildPlan()` → étapes `ready` / `work` / `rest`, chrono basé sur
  `Date.now()` (fiable même si l'écran se met en veille), `tick()` toutes les 200 ms.
- Sons (Web Audio), voix (`speechSynthesis`), vibration, écran allumé (Wake Lock) :
  tous dans des `try/catch`, l'app doit marcher sans eux.

## Avant de pousser

1. `npm install` puis `npm test` → les 34+ tests doivent passer.
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

- Choisir la durée de la séance (15 / 20 / 30 min) avec génération automatique.
- Noter la course de 5 km hebdomadaire dans l'historique.
- Série de semaines où l'objectif de 3 séances est atteint.

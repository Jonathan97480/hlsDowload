# AGENTS.md

## But du projet

- API serveur Node.js/Express pour telecharger un flux HLS `.m3u8` et produire un fichier `.mp4` via FFmpeg.

## Source de verite

- Les regles de structure, de securite et d'architecture sont documentees dans [projet.md](projet.md).
- Si une instruction ici semble contredire [projet.md](projet.md), suivre [projet.md](projet.md).

## Conventions a respecter

- Garder les fichiers de code sous 300 lignes; decomposer en sous-modules/services si necessaire.
- Respecter la separation des responsabilites:
  - `public/`: interface de test uniquement.
  - `controllers/`: orchestration HTTP uniquement.
  - `services/`: logique metier, traitement FFmpeg.
- Encadrer les promesses/appels async avec gestion d'erreur (`try/catch` ou `.catch`).
- **CSS dedié** : tout le style dans des fichiers `.css` (ex: `public/admin.css`); aucun bloc `<style>` ni style inline dans le HTML.
- **JS dedié** : tout le code JavaScript dans des fichiers `.js`; aucun bloc `<script>` avec du code inline dans le HTML. Seuls les `<script src="...">` sont autorises.

## Exigences securite API

- Toute requete API doit verifier le header `x-api-key`.
- Valider les URLs d'entree: commencer par `http` et finir par `.m3u8`.
- Ne jamais construire un nom de fichier a partir d'entrees utilisateur non nettoyees.

## Prerequis d'environnement

- FFmpeg doit etre installe et accessible sur la machine qui execute le serveur.

## Workflow agent recommande

- Avant toute modification, lire [projet.md](projet.md) pour conserver les conventions existantes.
- Avant d'executer des commandes, verifier leur disponibilite dans le depot (ex: scripts npm) car ce workspace ne contient pas encore `package.json` ni code applicatif.
- Limiter les changements au besoin utilisateur; eviter les refactors larges non demandes.

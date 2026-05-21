# TODO

## Priorite Haute

- Securiser [public/admin-logic.js](/e:/projet dowload/public/admin-logic.js:1) en remplacant les usages sensibles de `innerHTML` par une construction DOM via `textContent`.
- Ameliorer les erreurs de l'API HLS pour distinguer clairement:
  - URL invalide
  - DNS introuvable
  - playlist inaccessible ou expiree
  - segment invalide
  - echec FFmpeg
- Tester le pipeline HLS par segments sur plusieurs flux reels:
  - media playlists `.ts`
  - audio-only
  - `EXT-X-DISCONTINUITY`
  - `EXT-X-KEY`
  - `EXT-X-MAP`

## Priorite Moyenne

- Refactoriser [src/services/download-job.service.js](/e:/projet dowload/src/services/download-job.service.js:1) pour respecter la limite de taille et mieux separer:
  - persistance jobs
  - queue / concurrence
  - snapshot dashboard
  - execution download
- Refactoriser [public/admin-logic.js](/e:/projet dowload/public/admin-logic.js:1) en modules plus petits:
  - auth
  - dashboard
  - profile
  - api key
  - settings
- Verifier la persistance complete de `settings_json`, notamment `maxTitleLength`.
- Ajouter des logs plus structures avec `jobId`, type de source, mode final et erreur normalisee.
- Revoir le reglage de resynchronisation audio HLS pour reduire les micro-sauts audibles introduits par le mode `transcode`:
  - confirmer sur plusieurs sources si `aresample=async=1:first_pts=0` est trop agressif
  - tester un profil de correction audio plus doux
  - envisager un transcodage conditionnel reserve aux flux detectes comme instables

## Priorite Basse

- Ameliorer le panneau API:
  - bouton copier la nouvelle cle
  - confirmation avant rotation
  - affichage plus visible de la source `database` ou `env`
- Decouper [public/admin.html](/e:/projet dowload/public/admin.html:1) et [public/admin.css](/e:/projet dowload/public/admin.css:1) si l'interface continue de grossir.
- Revoir les logs de debug HLS pour reduire le bruit une fois la phase de stabilisation terminee.

## Tests A Ajouter

- Persistance de la cle API apres redemarrage.
- Rotation de cle API et invalidation de l'ancienne cle.
- Fallback HLS:
  - segments -> copy
  - segments -> transcode
  - erreur DNS
- Telechargement YouTube avec collision de nom.
- Reprise des jobs apres redemarrage.

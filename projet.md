Ce projet est la partie serveur d'un système de téléchargement de flux HLS (.m3u8). Il permet de recevoir une URL, de traiter le flux via FFmpeg et de sauvegarder le fichier final (.mp4) localement.

## 🛠 Technologies Requises

- **Node.js** (Environnement d'exécution)
- **Express.js** (Framework API)
- **FFmpeg** (Moteur de traitement vidéo - doit être installé sur le serveur)
- **Fluent-ffmpeg** (Abstraction pour manipuler FFmpeg en JS)
- **UUID** (Pour la génération de noms de fichiers uniques)

## 📂 Structure du Projet

Une structure modulaire pour garantir la séparation des responsabilités :

```text
hls-downloader-server/
├── src/
│   ├── app.js             # Point d'entrée de l'application
│   ├── routes/
│   │   └── download.js    # Définition des points de terminaison (endpoints)
│   ├── controllers/
│   │   └── download.controller.js # Logique de gestion des requêtes
│   ├── services/
│   │   └── ffmpeg.service.js      # Logique pure de traitement vidéo
│   └── middleware/
│       └── auth.middleware.js     # Sécurité et validation
├── public/
│   ├── index.html         # Page de test (Rendu)
│   └── script.js          # Logique frontend de test
├── downloads/             # Dossier de stockage des vidéos
├── .env                   # Variables d'environnement (Clé API, Port)
├── package.json
└── README.md
📜 Règles de Développement
Limite de lignes : Aucun fichier de code ne doit dépasser 300 lignes. Si un fichier devient trop gros, il doit être décomposé en sous-modules ou services.

Séparation Logique/Rendu :

Le dossier public/ contient uniquement l'interface.

Les controllers gèrent uniquement la communication HTTP.

Les services contiennent toute la logique métier (calculs, appels FFmpeg).

Gestion d'erreurs : Chaque promesse doit avoir un bloc .catch ou un try/catch pour éviter de faire planter le serveur.

🔐 Sécurité de l'API
Pour protéger ton serveur contre les utilisations non autorisées (même chez toi) :

Authentification par Clé API : Toutes les requêtes vers l'API (depuis l'extension ou la page de test) doivent inclure un header x-api-key.

Validation d'URL : Le serveur vérifie que l'URL fournie commence bien par http et se termine par .m3u8.

Nettoyage de l'input : Les noms de fichiers ne sont jamais générés à partir des données de l'utilisateur pour éviter les injections de commandes.
```

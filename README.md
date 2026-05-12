# HLS Downloader Server

API Node.js/Express qui convertit un flux HLS `.m3u8` en `.mp4` via FFmpeg.

Le projet inclut:

- API de telechargement HLS -> MP4
- Interface admin (`/admin`) avec dashboard temps reel
- Extension Chrome (`chrome-extension/`)
- Persistance SQLite (`data/app.db`) pour admin/sessions/settings/jobs/historique
- Pipeline de telechargement robuste avec fallback auto en transcodage si le flux HLS est instable

## Prerequis

- Node.js 18+
- FFmpeg installe et accessible en ligne de commande

## Variables d'environnement

Variables principales (voir `.env.example`):

- `PORT`: port HTTP du serveur (defaut `3000`)
- `API_KEY`: cle API requise pour les endpoints de download
- `FFMPEG_PATH`: chemin absolu vers binaire ffmpeg (optionnel)
- `DISK_MIN_FREE_PERCENT`: seuil mini d'espace libre disque (defaut `5`)

Variables admin optionnelles:

- `ADMIN_DEFAULT_USERNAME` (defaut `admin`)
- `ADMIN_DEFAULT_PASSWORD` (defaut `admin123`)

Exemple:

```env
PORT=3000
API_KEY=change-moi
FFMPEG_PATH=
DISK_MIN_FREE_PERCENT=5
ADMIN_DEFAULT_USERNAME=admin
ADMIN_DEFAULT_PASSWORD=admin123
```

## Installation

1. Copier le fichier d'environnement:
   - `copy .env.example .env` (Windows)

- `cp .env.example .env` (Linux/macOS)

2. Renseigner `API_KEY` dans `.env`
3. Installer les dependances:
   - `npm install`

## Lancer le serveur

- Developpement: `npm run dev`
- Production: `npm start`

Serveur disponible sur `http://localhost:3000` par defaut.

## Deploiement sur serveur (Linux)

Exemple rapide Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone <votre-repo>
cd <votre-repo>
cp .env.example .env
npm install --omit=dev
npm start
```

Recommandation production (service systemd):

```ini
[Unit]
Description=HLS Downloader Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/hls-downloader-server
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/hls-downloader-server/.env
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Puis:

```bash
sudo systemctl daemon-reload
sudo systemctl enable hls-downloader
sudo systemctl start hls-downloader
sudo systemctl status hls-downloader
```

Persistance a sauvegarder:

- `data/` (SQLite: `app.db`)
- `downloads/` (videos generees)

## Deploiement Docker

Vous pouvez conteneuriser le projet avec FFmpeg inclus.

Exemple `Dockerfile`:

```dockerfile
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
```

Build + run:

```bash
docker build -t hls-downloader:latest .
docker run -d \
  --name hls-downloader \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/downloads:/app/downloads \
  hls-downloader:latest
```

Exemple `docker-compose.yml`:

```yaml
services:
  hls-downloader:
    build: .
    container_name: hls-downloader
    ports:
      - "3000:3000"
    env_file:
      - .env
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./downloads:/app/downloads
```

Demarrage compose:

```bash
docker compose up -d --build
```

Important Docker:

- Ne pas oublier les volumes `data` et `downloads` pour conserver l'etat.
- Si `FFMPEG_PATH` est defini, verifier qu'il pointe vers un chemin valide dans le conteneur.
- `restart: unless-stopped` permet au conteneur de redemarrer automatiquement apres un reboot du serveur Docker.
- Le depot inclut maintenant un `.dockerignore` pour reduire la taille du contexte de build.

## API

## Robustesse des telechargements

Le moteur de download utilise maintenant une strategie hybride:

- tentative initiale rapide en copie directe (`-c copy`)
- verification du MP4 produit via `ffprobe`
- verification de decodage sur les premieres minutes du fichier
- bascule automatique en transcodage robuste (`libx264` + `aac`) si le fichier est detecte comme corrompu ou instable

Ce mecanisme reduit les cas ou:

- l'image se fige mais le son continue
- des artefacts ou traits colores apparaissent
- certains segments HLS instables rendent le MP4 final illisible

### `POST /api/download`

Headers obligatoires:

- `x-api-key: <votre-cle>`
- `Content-Type: application/json`

Body JSON:

```json
{
  "url": "https://example.com/playlist.m3u8",
  "headers": {
    "referer": "https://example.com/",
    "userAgent": "Mozilla/5.0 ...",
    "cookie": "name=value; other=value"
  }
}
```

Les champs dans `headers` sont optionnels.

Validation:

- URL doit commencer par `http://` ou `https://`
- URL doit se terminer par `.m3u8` (query string acceptee)

Reponse succes:

```json
{
  "message": "Telechargement termine",
  "fileName": "<uuid>.mp4",
  "filePath": "/downloads/<uuid>.mp4"
}
```

### Mode temps reel (extension)

`POST /api/download/start`

- Meme body que `POST /api/download`
- Reponse: `202` avec `jobId`

`GET /api/download/status/:jobId`

- Header requis: `x-api-key`
- Reponse: statut du job (`queued`, `running`, `completed`, `failed`) + `progress` (0-100)

## Interface de test

- Ouvrir `http://localhost:3000`
- Saisir la cle API et l'URL `.m3u8`
- Lancer la conversion

## Interface admin

- URL: `http://localhost:3000/admin`
- 1ere connexion: utiliser le mot de passe bootstrap puis creer le compte admin definitif
- Le dashboard consomme un flux SSE (`/api/admin/dashboard/stream`)
- Le stockage admin/session/settings/jobs/historique est dans SQLite (`data/app.db`)

## Extension Chrome (mode developpeur)

Le dossier `chrome-extension/` contient une extension MV3 qui:

- detecte des URLs `.m3u8` (requetes reseau + scan de page)
- pre-remplit l'URL detectee dans le popup
- envoie l'URL a `POST /api/download` avec `x-api-key`

Installation:

1. Ouvrir `chrome://extensions`
2. Activer le mode Developpeur
3. Cliquer sur Charger l'extension non empaquetee
4. Selectionner le dossier `chrome-extension/`

Utilisation:

1. Demarrer le serveur local (`npm start`)
2. Ouvrir une page qui charge un flux HLS
3. Ouvrir le popup de l'extension
4. Verifier `Endpoint API` (par defaut: `http://localhost:3000/api/download`)
5. Saisir `API Key` (celle de `.env`)
6. Cliquer `Detecter`, puis `Envoyer`

Note CORS:

- Le serveur autorise les origins `chrome-extension://*`, `localhost` et `127.0.0.1`.

## Notes

- Les fichiers sont enregistres dans `downloads/`
- Les donnees persistantes sont enregistrees dans `data/app.db` (SQLite)
- Les noms de sortie sont nettoyes et securises pour eviter les injections via input utilisateur
- Conventions agent et architecture: voir `AGENTS.md` et `projet.md`

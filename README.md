# HLS Downloader Server

API Node.js/Express qui convertit un flux HLS `.m3u8` en `.mp4` via FFmpeg, et telecharge des videos YouTube via yt-dlp.

Le projet inclut:

- API de telechargement HLS -> MP4
- API de telechargement YouTube (via yt-dlp)
- Interface admin (`/admin`) avec dashboard temps reel
- Extension Chrome (`chrome-extension/`)
- Persistance SQLite (`data/app.db`) pour admin/sessions/settings/jobs/historique
- Pipeline de telechargement robuste avec fallback auto en transcodage si le flux HLS est instable

## Prerequis

- Node.js 18+
- FFmpeg installe et accessible en ligne de commande
- **yt-dlp** installe et accessible en ligne de commande (pour le support YouTube)

### Installation de yt-dlp

```bash
# Via pip (recommande)
pip install yt-dlp

# Via pip3
pip3 install yt-dlp

# Via brew (macOS)
brew install yt-dlp

# Via apt (Debian/Ubuntu) - necessite un PPA tiers
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Verifier l'installation:

```bash
yt-dlp --version
```

## Variables d'environnement

Variables principales (voir `.env.example`):

- `PORT`: port HTTP du serveur (defaut `3000`)
- `API_KEY`: cle API requise pour les endpoints de download
- `FFMPEG_PATH`: chemin absolu vers binaire ffmpeg (optionnel)
- `YT_DLP_PATH`: chemin absolu vers binaire yt-dlp (optionnel, defaut `yt-dlp`)
- `DISK_MIN_FREE_PERCENT`: seuil mini d'espace libre disque (defaut `5`)

Variables admin optionnelles:

- `ADMIN_DEFAULT_USERNAME` (defaut `admin`)
- `ADMIN_DEFAULT_PASSWORD` (defaut `admin123`)

Exemple:

```env
PORT=3000
API_KEY=change-moi
FFMPEG_PATH=
YT_DLP_PATH=
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
4. Installer yt-dlp (voir section ci-dessus)

## Lancer le serveur

- Developpement: `npm run dev`
- Production: `npm start`

Serveur disponible sur `http://localhost:3000` par defaut.

## Deploiement sur serveur (Linux)

Exemple rapide Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg curl build-essential python3-pip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Installer yt-dlp
sudo pip3 install yt-dlp

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

Vous pouvez conteneuriser le projet avec FFmpeg et yt-dlp inclus.

Exemple `Dockerfile`:

```dockerfile
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp

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
- yt-dlp est installe dans l'image Docker via pip3.

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

### Telechargement YouTube

`POST /api/download/youtube`

Telechargement synchrone d'une video YouTube.

Headers obligatoires:

- `x-api-key: <votre-cle>`
- `Content-Type: application/json`

Body JSON:

```json
{
  "videoId": "dQw4w9WgXcQ",
  "fileName": "Ma video",
  "headers": {
    "cookie": "name=value"
  }
}
```

Ou avec une URL YouTube:

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "fileName": "Ma video"
}
```

Champs:

- `videoId` (string) - ID YouTube 11 caracteres, ou URL YouTube complete via le champ `url`
- `url` (string, alternative) - URL YouTube (`youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`)
- `fileName` (string, optionnel) - nom de fichier souhaite
- `headers.cookie` (string, optionnel) - cookies pour les videos restreintes

Reponse succes (`201`):

```json
{
  "message": "Telechargement termine",
  "fileName": "Ma video.mp4",
  "filePath": "/downloads/Ma video.mp4"
}
```

`POST /api/download/youtube/start`

Meme body, mais asynchrone. Retourne un `jobId` pour le polling.

Reponse (`202`):

```json
{
  "message": "Job YouTube demarre",
  "jobId": "uuid-du-job",
  "status": "queued",
  "fileName": "",
  "filePath": ""
}
```

`GET /api/download/youtube/status/:jobId`

- Header requis: `x-api-key`
- Reponse: statut du job + progression

Reponse:

```json
{
  "jobId": "uuid-du-job",
  "status": "running",
  "progress": 45,
  "timemark": "ETA 01:23",
  "message": "YouTube 45%",
  "fileName": "",
  "filePath": "",
  "ffmpegMode": "yt-dlp",
  "error": ""
}
```

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
- detecte les videos YouTube (youtube.com, youtu.be, shorts)
- pre-remplit l'URL detectee ou le videoId YouTube dans le popup
- envoie l'URL a `POST /api/download` ou `POST /api/download/youtube/start` avec `x-api-key`

Installation:

1. Ouvrir `chrome://extensions`
2. Activer le mode Developpeur
3. Cliquer sur Charger l'extension non empaquetee
4. Selectionner le dossier `chrome-extension/`

### Utilisation - Flux HLS/MP4 classiques

1. Demarrer le serveur local (`npm start`)
2. Ouvrir une page qui charge un flux HLS
3. Ouvrir le popup de l'extension
4. Verifier `Endpoint API` (par defaut: `http://localhost:3000/api/download`)
5. Saisir `API Key` (celle de `.env`)
6. Cliquer `Detecter`, puis `Envoyer`

### Utilisation - Videos YouTube

1. Demarrer le serveur local (`npm start`)
2. Ouvrir une video YouTube dans le navigateur
3. Ouvrir le popup de l'extension
4. La section "YouTube detecte" apparait avec le videoId
5. Verifier `Endpoint API` et `API Key`
6. Cliquer le bouton **YouTube** (rouge)
7. Le telechargement se lance via yt-dlp sur le serveur
8. La progression s'affiche dans le popup
9. Une fois termine, le fichier MP4 se telecharge automatiquement via le navigateur

Note CORS:

- Le serveur autorise les origins `chrome-extension://*`, `localhost` et `127.0.0.1`.

## Architecture des services

```
src/
  services/
    youtube-download.service.js   # Wrapper yt-dlp (child_process)
    media-download.service.js     # Routeur HLS/MP4 direct
    ffmpeg.service.js             # Pipeline FFmpeg avec fallback
    direct-download.service.js    # Telechargement MP4 direct
    download-job.service.js       # Queue et gestion des jobs
    hls-quality.service.js        # Selection qualite M3U8
    ...
  controllers/
    download.controller.js        # Endpoints HLS/MP4
    youtube.controller.js         # Endpoints YouTube
    admin.controller.js           # Endpoints admin
  routes/
    download.js                   # Routes /api/download/*
    admin.js                      # Routes /api/admin/*
```

## Notes

- Les fichiers sont enregistres dans `downloads/`
- Les donnees persistantes sont enregistrees dans `data/app.db` (SQLite)
- Les noms de sortie sont nettoyes et securises pour eviter les injections via input utilisateur
- YouTube: yt-dlp selectionne automatiquement la meilleure qualite MP4 disponible
- YouTube: les cookies du navigateur sont transmis pour les videos avec restriction d'age
- Conventions agent et architecture: voir `AGENTS.md` et `projet.md`

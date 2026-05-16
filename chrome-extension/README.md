# Video URL Sender (Chrome Extension)

Extension Chrome Manifest V3 pour detecter des URLs `.m3u8` ou `.mp4` et les envoyer a l'API locale.

## Installation rapide

1. Ouvrir `chrome://extensions`
2. Activer le mode Developpeur
3. Cliquer `Charger l'extension non empaquetee`
4. Selectionner le dossier `chrome-extension/`

## Utilisation

1. Lancer le serveur Node (`npm start`)
2. Ouvrir la page contenant la video
3. Ouvrir le popup de l'extension
4. Cliquer `Detecter`
5. Verifier/ajuster l'URL video detectee
6. Cliquer `Envoyer`

## Fichiers

- `manifest.json`: configuration extension MV3
- `background.js`: capture des requetes reseau et stockage des URLs `.m3u8` ou `.mp4`
- `content-script-main.js`: scan du DOM/page pour URLs media detectables
- `popup.html|css|js`: interface et appel vers le serveur

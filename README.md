# Dojo (Zero-dependency PWA)

Dojo is a fully client-side, installable training log + next-target engine. It runs from static HTML/CSS/JS with IndexedDB persistence and works offline.

## Repo structure
```
/docs
  index.html
  styles.css
  app.js
  manifest.webmanifest
  sw.js
  /icons
    icon-192.png
    icon-512.png
    apple-touch-icon.png
```

## Run locally
Any static server works. Examples:

```bash
python -m http.server --directory docs 5173
```

Then open http://localhost:5173

## Deploy to GitHub Pages
1. Commit the repository.
2. In GitHub, go to **Settings → Pages**.
3. Set **Source** to `Deploy from a branch`.
4. Choose the `main` (or current) branch and set the folder to `/docs`.
5. Save. GitHub Pages will serve `docs/index.html`.

## Install on iPhone (Safari)
1. Open the GitHub Pages URL in Safari.
2. Tap the Share button.
3. Choose **Add to Home Screen**.
4. Launch **Dojo** from your home screen for offline use.

## Data management
- **Settings → Export JSON** for full backups.
- **Settings → Import JSON** to restore.
- **Analytics → CSV** for per-exercise or global exports.

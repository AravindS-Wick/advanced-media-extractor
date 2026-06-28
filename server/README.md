# Media Extractor PRO — local backend

The extension popup is a thin client. The actual downloading is done by this small local
server, which shells out to **yt-dlp** (+ **ffmpeg**) — the universal engine that supports
~1800 sites (YouTube, Dailymotion, X, Instagram, generic HLS/DASH, …), cracks signature
ciphers, and muxes audio+video. A browser extension cannot do these things on its own.

## One-time setup

```bash
brew install yt-dlp ffmpeg        # the engine + muxer
```

## Run it

```bash
cd advanced-media-extractor
python3 server/server.py          # listens on http://127.0.0.1:8787
```

Leave it running while you use the extension. Click the toolbar icon on any page, pick a
quality, and the file lands in your `~/Downloads`.

To keep it always-on, run it under a process manager or a macOS LaunchAgent (optional).

## What works / what doesn't

- ✅ Any of yt-dlp's ~1800 supported sites + its generic extractor for unknown HLS/DASH pages.
- ❌ **DRM-protected** services (Netflix, Disney+, Spotify, Prime, …). Hardware-encrypted —
  impossible for any tool. Not a bug.
- 🔄 If a big site suddenly breaks, run `brew upgrade yt-dlp` (sites change their internals).

## Cloud Deployment (Railway / Render)

If you don't want to run the python server locally, you can deploy it to the cloud using the included `Dockerfile`. 

### Steps to Deploy on Railway:
1. Push this repository to GitHub.
2. Log in to [Railway](https://railway.app) and create a **New Project** -> **Deploy from GitHub**.
3. Choose your repository. In the settings, set the **Root Directory** to `server`.
4. Railway will automatically build and deploy the container using the `Dockerfile` (which provisions `python`, `ffmpeg`, and the latest `yt-dlp`).
5. Copy your generated public domain (e.g. `https://your-service-name.up.railway.app`).

### Connect the Chrome Extension:
1. Open the Media Extractor PRO extension popup.
2. Click **⚙ settings** in the bottom right footer.
3. Paste your public Railway URL (e.g. `https://your-service-name.up.railway.app`) into the input field and click **Save**.
4. The extension will automatically verify the remote service. When you click download, the remote server processes the video and automatically prompts your browser to download the finished file!

## API (used by the popup)

| Method | Path | Returns |
|--------|------|---------|
| GET  | `/health` | `{ ok, ytdlp, ffmpeg, downloadDir }` |
| GET  | `/resolve?url=…` | `{ title, duration, thumbnail, extractor, heights[], hasVideo, hasAudio }` |
| POST | `/download` `{url, preset}` | `{ job_id }` — preset: `best`/`1080`/`720`/`480`/`audio` |
| GET  | `/progress?id=…` | `{ status, percent, file, error }` |
| GET  | `/files?id=…` | File download stream |

> You alone are responsible for respecting each site's terms of service and copyright.

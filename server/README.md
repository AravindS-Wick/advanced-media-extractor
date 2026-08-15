# Media Extractor PRO — Helper Server & Cloud Hosting Guide

The Chrome Extension operates in two modes:
1. **In-Browser Serverless Mode**: Scans page DOM & sniffed network streams, downloads direct files & images (bypassing CORS), and assembles HLS video streams right in your browser via offscreen document.
2. **Python Engine Mode (`yt-dlp` + `ffmpeg`)**: Universal engine supporting ~1800 sites (YouTube, Dailymotion, X, Instagram, TikTok, etc.) with resolution selection (4K, 1080p, 720p, MP3 Audio).

---

## 🚀 Local Run (Zero Configuration)

### 1. Install prerequisites (macOS / Linux / Windows WSL):
```bash
# macOS
brew install yt-dlp ffmpeg

# Windows (winget / scoop / pip)
pip install yt-dlp
# Install ffmpeg and ensure it is in PATH
```

### 2. Start local server:
```bash
python3 server/server.py
```
Listens on `http://127.0.0.1:8787`.

---

## 🌐 Remote Cloud Hosting Guide

If you don't want to run the server locally on your machine, you can host it remotely on **Render**, **Railway**, **Docker**, or any **VPS (Ubuntu / Debian / DigitalOcean)**.

### Option A: Render.com (Free Tier Ready)
1. Push this repo to your GitHub account.
2. Log into [Render.com](https://render.com) -> New **Web Service** -> Connect your GitHub repo.
3. Render automatically reads `server/render.yaml` and `server/Dockerfile`.
4. (Optional) Set `API_KEY` in Environment Variables to secure your hosted endpoint.
5. Copy your service URL (e.g. `https://media-extractor-xyz.onrender.com`).
6. In the Chrome Extension popup -> **⚙ Settings** -> Paste your URL (and API Key if set) -> Click **Save Settings**.

### Option B: Railway.app (1-Click Deployment)
1. Log into [Railway.app](https://railway.app) -> **New Project** -> **Deploy from GitHub repo**.
2. Set Root Directory to `server/`.
3. Railway will build the container using `server/Dockerfile`.
4. Copy your generated public domain (e.g., `https://web-production-1234.up.railway.app`).
5. Open Chrome Extension popup -> **⚙ Settings** -> Paste URL -> **Save Settings**.

### Option C: Docker (Self-Hosted VPS / Unraid / Synology)
```bash
# Build Docker image
docker build -t media-extractor-server -f server/Dockerfile .

# Run container with optional API key protection
docker run -d \
  -p 8787:8787 \
  -e PORT=8787 \
  -e API_KEY="your_secret_api_key" \
  --name media-extractor \
  media-extractor-server
```

---

## 🔐 API Security & Options

| Environment Variable | Default | Purpose |
|----------------------|---------|---------|
| `PORT` | `8787` | Port the HTTP server binds to |
| `API_KEY` | None | Optional secret token required for authentication (`X-API-Key` header) |

---

## 🛠 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status, ffmpeg, yt-dlp check, and auth requirements |
| GET | `/resolve?url=…` | Extract video metadata, title, thumbnail, available resolutions |
| POST | `/download` | Trigger download job (`preset`: `best`, `1080`, `720`, `480`, `audio`) |
| GET | `/progress?id=…` | Poll progress percent, status (`running`, `done`, `error`), and filename |
| GET | `/files?id=…` | Download finished file stream from remote host |

> Respect site terms of service and content copyright when using this tool.

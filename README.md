# ⚡ Media Extractor PRO (v3.0)

A high-performance Manifest V3 Chrome Extension and Python backend engine for sniffing, filtering, previewing, and archiving web media (HLS streams, MP4/MKV videos, audio, images, and documents).

---

## 🌟 Key Features (v3.0)

- **🎬 Real-Time HLS Download Engine**: Live percentage progress tracking (`Fetching 45%...` -> `✓ Saved`) directly inside popup & grabber pages.
- **📐 Resolution Variant Expansion**: Automatically parses HLS master playlists into individual resolution cards (`1080p`, `1280p`, `720p`, `848p`, `640p`, `480p`, `360p`).
- **📊 Multi-Source Video Size Calculator**: Calculates exact file sizes using a 6-stage video duration harvester (HTML5 video, OpenGraph metadata, ISO 8601 strings, JSON-LD, Dailymotion config) and resolution bitrates.
- **📦 Client-Side ZIP Bulk Archiving**: Package multiple selected media files into a single zero-dependency Store-mode `.zip` file.
- **🏷️ Smart Metadata Naming**: Auto-extracts titles from page context, video titles, or image alt tags, with inline click-to-edit renaming.
- **🔎 Inbuilt Video Preview & Search**: Embedded video player modal for stream validation and live keyword searching.
- **🛡️ Ad & Tracker Shield**: Built-in `declarativeNetRequest` ad blocker with dynamic cosmetic element hiding and persistent toggle synchronization.
- **🔔 Extension Toolbar Badge**: Displays live detected media count badges on the browser action icon overlay and top popup header.

---

## 🧪 Testing & Quality Assurance

### Run Jest Unit Tests
```bash
npm test
```

### Run Playwright E2E Suite
```bash
npm run test:e2e
```

### Validate JSON Rulesets
```bash
python -c "import json; json.load(open('manifest.json')); json.load(open('rules/ad-block-rules.json'))"
```

---

## ☁️ Backend Cloud Deployment

The python helper engine supports dynamic `$PORT` binding and API Key security for 1-click cloud deployment:

- **Render**: `render.yaml` blueprint included.
- **Railway**: `railway.json` blueprint included.

---

## 📄 License
MIT License. Created by [AravindS-Wick](https://github.com/AravindS-Wick).

#!/usr/bin/env python3
"""
Media Extractor PRO — local yt-dlp backend.

A tiny dependency-free (stdlib only) HTTP server that the Chrome extension talks to.
It shells out to `yt-dlp` (+ `ffmpeg`) — the universal engine that handles ~1800 sites
(YouTube, Dailymotion, X, Instagram, generic HLS/DASH, ...) including signature ciphers
and audio/video muxing that a browser extension cannot do on its own.

Run:  python3 server.py         (listens on 127.0.0.1:8787)
Stop: Ctrl-C

Endpoints (all permissive-CORS so the extension can call them):
  GET  /health                         -> { ok, ytdlp, ffmpeg }
  GET  /resolve?url=<page-url>          -> { title, duration, thumbnail, heights[], hasVideo, hasAudio }
  POST /download  { url, preset }       -> { job_id }      preset: best|1080|720|480|audio
  GET  /progress?id=<job_id>            -> { status, percent, file, error }
"""

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 8787))
DOWNLOAD_DIR = os.path.expanduser("~/Downloads")
if not os.path.exists(DOWNLOAD_DIR) or not os.access(DOWNLOAD_DIR, os.W_OK):
    DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

YTDLP = shutil.which("yt-dlp")
FFMPEG = shutil.which("ffmpeg")

# job_id -> { status: 'running'|'done'|'error', percent: float, file: str|None, error: str|None }
JOBS = {}
JOBS_LOCK = threading.Lock()

# preset -> yt-dlp format selector / postprocessing args
PRESETS = {
    "best":  ["-f", "bv*+ba/b", "--merge-output-format", "mp4"],
    "1080":  ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4"],
    "720":   ["-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4"],
    "480":   ["-f", "bv*[height<=480]+ba/b[height<=480]/b", "--merge-output-format", "mp4"],
    "audio": ["-f", "ba/b", "-x", "--audio-format", "mp3"],
}

PCT_RE = re.compile(rb"\[download\]\s+([0-9.]+)%")
DEST_RE = re.compile(rb"\[(?:download|Merger|ExtractAudio)\][^\n]*?(?:Destination:|Merging formats into|to)\s*\"?(.+?)\"?\s*$")


def run_resolve(url):
    out = subprocess.run(
        [YTDLP, "-J", "--no-playlist", "--no-warnings", url],
        capture_output=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode("utf-8", "replace").strip()[:500] or "yt-dlp could not resolve this URL")
    info = json.loads(out.stdout.decode("utf-8", "replace"))

    heights, has_video, has_audio = set(), False, False
    for f in info.get("formats", []) or []:
        if f.get("vcodec") and f.get("vcodec") != "none":
            has_video = True
            if f.get("height"):
                heights.add(int(f["height"]))
        if f.get("acodec") and f.get("acodec") != "none":
            has_audio = True
    return {
        "title": info.get("title") or "media",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "heights": sorted(heights, reverse=True),
        "hasVideo": has_video,
        "hasAudio": has_audio,
    }


def run_download(job_id, url, preset):
    if preset in PRESETS:
        args = PRESETS[preset]
    elif preset.isdigit():
        h = int(preset)
        args = ["-f", f"bv*[height<={h}]+ba/b[height<={h}]/b", "--merge-output-format", "mp4"]
    else:
        args = PRESETS["best"]
    outtmpl = os.path.join(DOWNLOAD_DIR, "%(title).180B [%(id)s].%(ext)s")
    cmd = [YTDLP, "--no-playlist", "--newline", "--no-warnings", "--no-part",
           *args, "-o", outtmpl, url]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        dest = None
        for raw in proc.stdout:
            m = PCT_RE.search(raw)
            if m:
                with JOBS_LOCK:
                    JOBS[job_id]["percent"] = float(m.group(1))
            d = DEST_RE.search(raw.rstrip())
            if d:
                dest = d.group(1).decode("utf-8", "replace").strip()
        proc.wait()
        if proc.returncode == 0:
            with JOBS_LOCK:
                JOBS[job_id].update(status="done", percent=100.0,
                                    file=os.path.basename(dest) if dest else None)
        else:
            with JOBS_LOCK:
                JOBS[job_id].update(status="error", error="yt-dlp exited with code %d" % proc.returncode)
    except Exception as e:
        with JOBS_LOCK:
            JOBS[job_id].update(status="error", error=str(e)[:500])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quieter
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._json(200, {"ok": True, "ytdlp": bool(YTDLP), "ffmpeg": bool(FFMPEG),
                                    "downloadDir": DOWNLOAD_DIR})
        if u.path == "/resolve":
            url = (q.get("url") or [""])[0]
            if not url:
                return self._json(400, {"error": "missing url"})
            try:
                return self._json(200, run_resolve(url))
            except subprocess.TimeoutExpired:
                return self._json(504, {"error": "yt-dlp timed out resolving this URL"})
            except Exception as e:
                return self._json(422, {"error": str(e)[:500]})
        if u.path == "/progress":
            jid = (q.get("id") or [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                return self._json(404, {"error": "unknown job"})
            return self._json(200, job)
        if u.path == "/files":
            jid = (q.get("id") or [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job or job["status"] != "done" or not job["file"]:
                return self._json(404, {"error": "file not found or download not finished"})
            filepath = os.path.join(DOWNLOAD_DIR, job["file"])
            if not os.path.exists(filepath):
                return self._json(404, {"error": "file missing on server"})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(filepath)}"')
            self._cors()
            self.send_header("Content-Length", str(os.path.getsize(filepath)))
            self.end_headers()
            with open(filepath, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
            return
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/download":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON"})
        url = data.get("url")
        preset = data.get("preset", "best")
        if not url:
            return self._json(400, {"error": "missing url"})
        jid = uuid.uuid4().hex[:12]
        with JOBS_LOCK:
            JOBS[jid] = {"status": "running", "percent": 0.0, "file": None, "error": None}
        threading.Thread(target=run_download, args=(jid, url, preset), daemon=True).start()
        return self._json(200, {"job_id": jid})


def main():
    if not YTDLP:
        raise SystemExit("yt-dlp not found on PATH. Install it:  brew install yt-dlp ffmpeg")
    print(f"Media Extractor backend on http://0.0.0.0:{PORT}")
    print(f"  yt-dlp: {YTDLP}")
    print(f"  ffmpeg: {FFMPEG or 'MISSING (merging/audio extraction will fail)'}")
    print(f"  downloads -> {DOWNLOAD_DIR}")
    try:
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except OSError as e:
        if e.errno in (48, 98):  # address already in use (macOS/Linux)
            raise SystemExit(
                f"\nPort {PORT} is already in use — the backend is probably already running.\n"
                f"Either just use it, or free the port:\n"
                f"  lsof -ti tcp:{PORT} | xargs kill -9\n"
            )
        raise
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()

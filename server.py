#!/usr/bin/env python3
"""TAG backend: serves the frontend, the maps, and keeps round statistics.

No third-party packages needed (Python 3.9+).

    python server.py                # http://127.0.0.1:8000
    python server.py --port 9000
    python server.py --host 0.0.0.0 # let other devices on your network open it

API
    GET  /api/maps     level data (platforms, pads, portals, spawns)
    GET  /api/stats    aggregate stats + the most recent rounds
    POST /api/results  record a finished round
"""
import argparse
import json
import mimetypes
import os
import tempfile
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import maps

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_FILE = ROOT / "data" / "results.json"

MAX_BODY_BYTES = 4096
MAX_STORED_RESULTS = 1000

_lock = threading.Lock()


# ---------------------------------------------------------------- storage --
def load_results():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_results(results):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_FILE.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(results[-MAX_STORED_RESULTS:], f)
    os.replace(tmp, DATA_FILE)  # atomic: never leaves a half-written file


# ------------------------------------------------------------- game logic --
def _int_in(value, lo, hi, name):
    # bool is a subclass of int in Python; reject it explicitly
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ValueError(f"{name} must be an integer between {lo} and {hi}")
    return value


def validate_result(payload):
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    map_id = payload.get("map")
    if map_id not in maps.MAPS:
        raise ValueError("unknown map")
    players = _int_in(payload.get("players"), 2, 4, "players")
    return {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "map": map_id,
        "players": players,
        "loser": _int_in(payload.get("loser"), 1, players, "loser"),
        "seconds": _int_in(payload.get("seconds"), 5, 300, "seconds"),
        "tags": _int_in(payload.get("tags"), 0, 999, "tags"),
    }


def build_stats(results):
    per_player = {str(i): {"caught": 0, "survived": 0} for i in range(1, 5)}
    per_map = {k: 0 for k in maps.MAPS}
    for r in results:
        per_map[r["map"]] = per_map.get(r["map"], 0) + 1
        for i in range(1, r["players"] + 1):
            key = "caught" if i == r["loser"] else "survived"
            per_player[str(i)][key] += 1
    return {
        "rounds": len(results),
        "players": per_player,
        "maps": per_map,
        "recent": results[-5:][::-1],
    }


# ------------------------------------------------------------------- http --
class Handler(BaseHTTPRequestHandler):
    server_version = "TagServer/1.0"

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-type", "text/html")
        self.end_headers()

    # -- helpers
    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _static(self, url_path):
        rel = "index.html" if url_path in ("", "/") else url_path.lstrip("/")
        target = (STATIC / rel).resolve()
        # block path traversal such as /../server.py
        if not target.is_relative_to(STATIC) or not target.is_file():
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # -- routes
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/maps":
            return self._json(200, maps.public_maps())
        if path == "/api/stats":
            with _lock:
                return self._json(200, build_stats(load_results()))
        if path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        self._static(path)

    def do_POST(self):
        if urlparse(self.path).path != "/api/results":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "bad Content-Length"})
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._json(413, {"error": "body too large or empty"})
        try:
            record = validate_result(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError) as exc:
            return self._json(400, {"error": str(exc)})
        with _lock:
            results = load_results()
            results.append(record)
            save_results(results)
            stats = build_stats(results)
        self._json(201, stats)


def main():
    ap = argparse.ArgumentParser(description="TAG game server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = ap.parse_args()
    server_address = ("0.0.0.0", args.port)
    httpd = ThreadingHTTPServer(server_address, Handler)
    print(f"TAG running on 0.0.0.0:{args.port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

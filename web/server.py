#!/usr/bin/env python3
"""The terminal hub's /assets server: the page's files, plus /assets/sessions.json, the list of
places and sessions (from `terminal-hub --list`). ttyd serves the page itself and the terminals.

    server.py PORT DIRECTORY
"""
import functools, http.server, json, os, subprocess, sys, threading, time

PICKER = os.path.expanduser("~/.local/bin/terminal-hub")
FRESH_SECONDS = 2  # every open page polls; they share one listing
_lock = threading.Lock()
_cache = (0.0, b"")


def _int(s):
    return int(s) if s.isdigit() else 0


def sessions(fresh=False):
    """{"places": [{"key", "label", "colour", "state", "sessions": [
        {"name", "windows", "attached", "status", "statusAt", "prefix"}]}]}
    fresh: list again unless the cached list is under a quarter of a second old."""
    global _cache
    with _lock:
        stamp, body = _cache
        if time.monotonic() - stamp < (0.25 if fresh else FRESH_SECONDS):
            return body
        try:
            out = subprocess.run([PICKER, "--list"], capture_output=True, text=True, timeout=30).stdout
        except (OSError, subprocess.TimeoutExpired):
            out = ""
        places = []
        for line in out.splitlines():
            f = line.split("\t")
            if f[0] == "place" and len(f) == 5:
                places.append({"key": f[1], "label": f[2], "colour": f[3], "state": f[4], "sessions": []})
            elif f[0] == "session" and len(f) >= 7 and places:
                places[-1]["sessions"].append({
                    "name": f[2], "windows": _int(f[3]), "attached": _int(f[4]),
                    "status": f[5] if f[5] in ("working", "waiting", "done") else "", "statusAt": _int(f[6]),
                    "prefix": f[7][:16] if len(f) > 7 else "",  # the session's tmux prefix key, e.g. C-b
                })
        body = json.dumps({"places": places}).encode()
        _cache = (time.monotonic(), body)
        return body


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    }

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path != "/sessions.json":
            return super().do_GET()
        body = sessions(fresh="fresh" in query.split("&"))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Revalidate everything (an unchanged file costs a 304), so updates show up at once.
        self.send_header("Cache-Control", "no-cache")
        if self.path.split("?")[0].endswith("/sw.js"):
            self.send_header("Service-Worker-Allowed", "/")  # it lives here but serves the whole site
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port, directory = int(sys.argv[1]), sys.argv[2]
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=directory)).serve_forever()

#!/usr/bin/env python3
"""Server for the terminal hub's /assets: the static files (font, manifest, icons, service
worker), plus sessions.json, the session list behind the page's session panel.
Static files get no-cache, and the service worker gets the header it needs: it lives under
/assets but must control the whole site."""
import functools, http.server, json, os, subprocess, sys, threading, time

PICKER = os.path.expanduser("~/.local/bin/terminal-hub")
FRESH_SECONDS = 3  # several open pages share one listing (ssh places take a moment)
_lock = threading.Lock()
_cache = (0.0, b"")


def sessions():
    """Run `terminal-hub --tsv` (at most once per FRESH_SECONDS) and turn it into JSON:
    {"places": [{"key", "label", "colour", "state", "sessions": [{"name", "windows", "attached"}]}]}"""
    global _cache
    with _lock:
        stamp, body = _cache
        if time.monotonic() - stamp < FRESH_SECONDS:
            return body
        try:
            out = subprocess.run([PICKER, "--tsv"], capture_output=True, text=True, timeout=30).stdout
        except (OSError, subprocess.TimeoutExpired):
            out = ""
        places = []
        for line in out.splitlines():
            f = line.split("\t")
            if f[0] == "place" and len(f) == 5:
                places.append({"key": f[1], "label": f[2], "colour": f[3], "state": f[4], "sessions": []})
            elif f[0] == "session" and len(f) == 5 and places:
                n = lambda s: int(s) if s.isdigit() else 0
                places[-1]["sessions"].append({"name": f[2], "windows": n(f[3]), "attached": n(f[4])})
        body = json.dumps({"places": places}).encode()
        _cache = (time.monotonic(), body)
        return body


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/sessions.json":
            return super().do_GET()
        body = sessions()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Always revalidate (unchanged files cost a 304): a stale manifest or icon makes Chrome
        # install the app under its old name and look.
        self.send_header("Cache-Control", "no-cache")
        if self.path.split("?")[0].endswith("/sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, *a):
        pass


port, directory = int(sys.argv[1]), sys.argv[2]
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=directory)).serve_forever()

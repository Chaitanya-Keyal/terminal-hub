#!/usr/bin/env python3
"""Static server for the terminal hub's /assets (font, manifest, icons, service worker).
Like `python3 -m http.server`, plus no-cache on everything and the header the hub's service worker
needs: it lives under /assets but must control the whole site."""
import functools, http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
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

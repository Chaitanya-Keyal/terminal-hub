#!/usr/bin/env python3
"""The terminal hub's /assets server: the page's files, and /assets/sessions.json, the list of
categories, places and sessions (from terminal-hub). ttyd serves the page and the terminals.

    server.py PORT DIRECTORY

The list: each place is listed on its own (`terminal-hub --list KEY`), so a slow or unreachable
one never holds up the rest. A request lists again the places last listed over STALE_SECONDS
ago, waits up to SOFT_WAIT for those answers, and otherwise answers with the last lists it has.
?fresh (every place) or ?fresh=KEY,KEY (after you changed something there) waits longer for
lists that started after the request. /assets/events streams the list (server-sent events): a
message whenever it changes, so an open page, even a hidden tab, hears of a change at once.

The files: /v/VERSION/FILE is FILE, and install.sh puts the version (a hash of the files) in
the page's URLs, so browsers may keep those for good. FILE.gz, when install.sh made one, goes to
browsers that take gzip.

Sending a file: POST /send?place=KEY&name=FILENAME with the file as the body saves it in that
place (`terminal-hub --receive`) and answers {"path": ...}, which the page types into the
session. Only the hub's own page may (its Origin is this host), as ttyd's --check-origin does for
terminals: other websites can't send files through your browser.
"""
import email.utils, http.server, json, mimetypes, os, signal, subprocess, sys, threading, time
from urllib.parse import parse_qs, urlsplit

HUB = os.path.expanduser("~/.local/bin/terminal-hub")
STALE_SECONDS = 2   # list a place again when its list is older than this
DOWN_SECONDS = 15   # ... or this, for a place that was locked or unreachable last time
SOFT_WAIT = 0.8     # how long a request waits for those lists (a quick place answers in time)
FRESH_WAIT = 4      # ... for ?fresh lists
FIRST_WAIT = 6      # ... for places never listed yet
EVENT_SECONDS = 2   # how often an event stream looks for a change
SEND_LIMIT = 100 << 20  # the largest file the page may send (bytes)
CONFIG = os.environ.get("TERMINAL_HUB_CONFIG") or os.path.expanduser("~/.config/terminal-hub/config")

state = threading.Condition()
CATEGORIES = os.path.join(os.path.dirname(CONFIG), "categories")  # the ones made on the page
config = {"stamp": None, "categories": [], "places": []}  # stamp: when the two files last changed
# Per place key: busy (a list is running), started (when it started), listed (when the last
# finished list started; 0: never), again (list once more when this one ends), state, sessions.
lists = {}


def _int(s):
    return int(s) if s.isdigit() else 0


def run(*args, timeout):
    """terminal-hub's output; on a timeout, it and everything it started (ssh, sudo) are killed."""
    try:
        proc = subprocess.Popen([HUB, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, errors="replace", start_new_session=True)
    except OSError:
        return ""
    try:
        return proc.communicate(timeout=timeout)[0]
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return ""


def parse(out):
    """terminal-hub's tab-separated lines → (categories, places with their sessions)."""
    categories, places = [], []
    for line in out.splitlines():
        f = line.split("\t")
        if f[0] == "category" and len(f) >= 4:
            categories.append({"key": f[1], "label": f[2], "icon": f[3],
                               "editable": len(f) > 4 and f[4] == "page"})  # made on the page
        elif f[0] == "place" and len(f) >= 5:
            places.append({"key": f[1], "label": f[2], "colour": f[3], "state": f[4],
                           "icon": f[5] if len(f) > 5 else "", "sessions": []})
        elif f[0] == "session" and len(f) >= 7 and places:
            places[-1]["sessions"].append({
                "name": f[2], "windows": _int(f[3]), "attached": _int(f[4]),
                "status": f[5] if f[5] in ("working", "waiting", "done") else "", "statusAt": _int(f[6]),
                "prefix": f[7][:16] if len(f) > 7 else "",   # the session's tmux prefix, e.g. C-b
                "category": f[8] if len(f) > 8 else "",
                "path": f[9] if len(f) > 9 else "",  # the folder it started in
            })
    return categories, places


def refresh(key):
    """List place KEY, again while asked to (a ?fresh request came in meanwhile)."""
    try:
        while True:
            with state:
                entry = lists.get(key)
                if entry is None:
                    return
                started = entry["started"] = time.monotonic()
                entry["again"] = False
            place = next((p for p in parse(run("--list", key, timeout=30))[1] if p["key"] == key), None)
            with state:
                entry = lists.get(key)
                if entry is None:
                    return
                entry.update(listed=started, state=place["state"] if place else "unreachable",
                             sessions=place["sessions"] if place else [])
                if not entry["again"]:
                    return
                state.notify_all()
    finally:
        with state:
            if key in lists:
                lists[key]["busy"] = False
            state.notify_all()


def snapshot(fresh=None):
    """The list, as JSON. fresh: None, True (every place) or a set of place keys."""
    now = time.monotonic()
    with state:
        stamp = tuple(os.stat(f).st_mtime_ns if os.path.exists(f) else 0 for f in (CONFIG, CATEGORIES))
        if stamp != config["stamp"]:  # read the config (categories, places) when it changes
            categories, places = parse(run("--config", timeout=10))
            config["stamp"] = stamp
            if places:  # a broken config keeps the last good one
                config.update(categories=categories, places=places)
        keys = [p["key"] for p in config["places"]]
        for k in set(lists) - set(keys):
            del lists[k]
        wanted = set(keys) if fresh is True else set(fresh or ()) & set(keys)
        need = {}  # key → (the list must have started at or after this, give up at this time)
        for k in keys:
            e = lists.setdefault(k, {"busy": False, "started": 0.0, "listed": 0.0, "again": False,
                                     "state": "pending", "sessions": []})
            up = e["state"] in ("ok", "pending")
            stale = now - e["listed"] > (STALE_SECONDS if up else DOWN_SECONDS)
            if k in wanted or stale:
                if not e["busy"]:
                    e["busy"] = True
                    e["started"] = now
                    threading.Thread(target=refresh, args=(k,), daemon=True).start()
                elif k in wanted and e["started"] < now:
                    e["again"] = True
            if not e["listed"]:
                need[k] = (1e-9, now + FIRST_WAIT)
            elif k in wanted:
                need[k] = (now, now + FRESH_WAIT)
            elif stale and up:  # a down place isn't worth waiting for
                need[k] = (now, now + SOFT_WAIT)
        while True:
            t = time.monotonic()
            waiting = [k for k, (since, until) in need.items() if lists[k]["listed"] < since and t < until]
            if not waiting:
                break
            state.wait(min(need[k][1] for k in waiting) - t)
        body = {"categories": config["categories"], "places": [
            {**p, "state": lists[p["key"]]["state"], "sessions": lists[p["key"]]["sessions"]}
            for p in config["places"]]}
    return json.dumps(body, separators=(",", ":")).encode()


TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
         ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
         ".png": "image/png", ".json": "application/json"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/sessions.json":
            values = parse_qs(query, keep_blank_values=True).get("fresh")
            fresh = None
            if values is not None:
                fresh = {k for v in values for k in v.split(",") if k} or True
            return self.reply(200, snapshot(fresh), "application/json", "no-store")
        if path == "/events":
            return self.events()
        forever = path.startswith("/v/")
        if forever:  # /v/VERSION/FILE
            path = "/" + path.split("/", 3)[3] if path.count("/") >= 3 else "/"
        self.file(path, forever)

    def do_POST(self):
        path, _, query = self.path.partition("?")
        if path != "/send":
            return self.reply(404, b"not found", "text/plain", "no-store")
        if urlsplit(self.headers.get("Origin", "")).netloc != self.headers.get("Host"):
            return self.answer(403, error="only the hub's page may send files")
        q = parse_qs(query)
        place, name = q.get("place", [""])[0], q.get("name", ["file"])[0]
        size = _int(self.headers.get("Content-Length", ""))
        if not 0 < size <= SEND_LIMIT:
            return self.answer(413, error=f"files up to {SEND_LIMIT >> 20} MB")
        try:
            proc = subprocess.Popen([HUB, "--receive", place, name], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as e:
            return self.answer(500, error=str(e))
        out = err = b""
        try:
            left = size
            while left:
                chunk = self.rfile.read(min(left, 1 << 16))
                if not chunk:
                    break
                proc.stdin.write(chunk)
                left -= len(chunk)
            out, err = proc.communicate(timeout=300)
        except (OSError, subprocess.TimeoutExpired):  # it quit early, or took too long
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            out, err = proc.communicate()
        path = out.decode(errors="replace").strip()
        if proc.returncode == 0 and path and not left:
            return self.answer(200, path=path)
        self.answer(500, error=err.decode(errors="replace").strip()[:200] or "couldn't save it")

    def answer(self, code, **body):
        self.reply(code, json.dumps(body).encode(), "application/json", "no-store")

    def events(self):
        """The list as server-sent events: a message when it changes, a comment now and then so a
        dead connection shows up (the write fails and this thread ends)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last, idle = b"", 0.0
        try:
            while True:
                body = snapshot()
                if body != last:
                    self.wfile.write(b"data: " + body + b"\n\n")
                    last, idle = body, 0.0
                elif idle >= 15:
                    self.wfile.write(b": still here\n\n")
                    idle = 0.0
                self.wfile.flush()
                time.sleep(EVENT_SECONDS)
                idle += EVENT_SECONDS
        except OSError:  # the page went away
            pass

    def file(self, path, forever):
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            return self.reply(404, b"not found", "text/plain", "no-store")
        full = os.path.realpath(os.path.join(self.server.root, rel))
        if not full.startswith(self.server.root + os.sep) or not os.path.isfile(full):
            return self.reply(404, b"not found", "text/plain", "no-store")
        ext = os.path.splitext(full)[1]
        kind = TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        gz = full + ".gz"
        zipped = "gzip" in self.headers.get("Accept-Encoding", "") and os.path.isfile(gz)
        mtime = int(os.path.getmtime(full))
        if not forever:  # revalidated each time: an unchanged file costs a 304
            since = self.headers.get("If-Modified-Since")
            try:
                if since and email.utils.parsedate_to_datetime(since).timestamp() >= mtime:
                    self.send_response(304)
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass
        with open(gz if zipped else full, "rb") as fh:
            body = fh.read()
        extra = {"Last-Modified": email.utils.formatdate(mtime, usegmt=True), "Vary": "Accept-Encoding"}
        if zipped:
            extra["Content-Encoding"] = "gzip"
        if path.endswith("/sw.js"):
            extra["Service-Worker-Allowed"] = "/"  # it lives here but serves the whole site
        cache = "public, max-age=31536000, immutable" if forever else "no-cache"
        self.reply(200, body, kind, cache, extra)

    def reply(self, code, body, kind, cache, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port, root = int(sys.argv[1]), sys.argv[2]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.root = os.path.realpath(root)
    server.daemon_threads = True
    server.serve_forever()

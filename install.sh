#!/usr/bin/env bash
# Install or update terminal-hub for the current user. Safe to re-run: do it after editing
# anything in this repo or the config's app settings.
#   ./install.sh          install from this checkout
#   ./install.sh --pull   git pull first (how another machine picks up changes)
#
# Copies the picker and `share` to ~/.local/bin, builds the page and its assets into
# ~/.local/share/terminal-hub, and runs two systemd user services: ttyd on 127.0.0.1:7682 and
# the assets on 127.0.0.1:7683. Publishing those (`tailscale serve`) is up to you: see README.md.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [[ ${1:-} == --pull ]]; then
  git pull --ff-only --quiet
  exec ./install.sh
fi

CONFIG=$HOME/.config/terminal-hub/config
SHARE=$HOME/.local/share/terminal-hub
UNITS=$HOME/.config/systemd/user
# systemctl --user finds the user's manager through this; it's unset under `sudo -u`.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

for cmd in ttyd tmux python3 curl; do
  command -v "$cmd" >/dev/null || { echo "terminal-hub needs $cmd" >&2; exit 1; }
done
command -v fzf >/dev/null || [[ -x $HOME/.fzf/bin/fzf ]] || { echo "terminal-hub needs fzf" >&2; exit 1; }

mkdir -p "${CONFIG%/*}" "$SHARE/assets" "$HOME/.local/bin" "$UNITS"
if [[ ! -f $CONFIG ]]; then
  cp config.example "$CONFIG"
  echo "wrote $CONFIG from config.example: edit it, then run ./install.sh again"
fi

# App settings: defaults, then the config. Here place() only notes the first place's label.
HUB_NAME='terminal hub' HUB_SHORT_NAME='hub' HUB_APP_ID='hub'
HUB_DESCRIPTION='Every tmux session in one list' HUB_FALLBACK='' HUB_FALLBACK_NAME=''
HERE=''
place() { [[ -n $HERE ]] || HERE=$2; }
source "$CONFIG"

install -m 755 bin/terminal-hub bin/share "$HOME/.local/bin/"

# ttyd's own page, taken from the installed ttyd so it always matches the binary.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ttyd --interface "$tmp/ttyd.sock" true >/dev/null 2>&1 &
ttyd_pid=$!
for _ in $(seq 50); do [[ -S $tmp/ttyd.sock ]] && break; sleep 0.1; done
curl -sf --unix-socket "$tmp/ttyd.sock" http://localhost/ -o "$tmp/ttyd.html" ||
  { echo "couldn't get ttyd's page from the installed ttyd" >&2; exit 1; }
kill "$ttyd_pid" 2>/dev/null || true

restart_assets=0
cmp -s web/serve-assets.py "$SHARE/serve-assets.py" || restart_assets=1
cp web/serve-assets.py "$SHARE/"
cp tmux/hub.conf "$SHARE/tmux.conf"
cp web/FiraCodeNF.woff2 icons/app-{32,192,512}.png "$SHARE/assets/"

# The page (ttyd's + head.html + sessions.js + keys.js), the manifest, and the fallback service worker.
export HUB_NAME HUB_SHORT_NAME HUB_APP_ID HUB_DESCRIPTION HUB_FALLBACK HUB_FALLBACK_NAME HERE
PYTHONUTF8=1 python3 -I - "$tmp/ttyd.html" "$SHARE" <<'PY'
import hashlib, html, json, os, re, sys
from pathlib import Path

ttyd_page, share = Path(sys.argv[1]), Path(sys.argv[2])
assets, env = share / "assets", os.environ
start = f"/?app={env['HUB_APP_ID']}"
manifest = {
    "id": start, "name": env["HUB_NAME"], "short_name": env["HUB_SHORT_NAME"],
    "description": env["HUB_DESCRIPTION"], "start_url": start, "scope": "/",
    "display": "standalone", "orientation": "any",
    "background_color": "#000000", "theme_color": "#0b0d10",
    "icons": [
        {"src": f"/assets/app-{n}.png", "sizes": f"{n}x{n}", "type": "image/png", "purpose": "any maskable"}
        for n in (192, 512)
    ],
}
(assets / "app.webmanifest").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

head = Path("web/head.html").read_text(encoding="utf-8")
fallback = env["HUB_FALLBACK"]
if fallback:
    offline = (Path("web/offline.html").read_text(encoding="utf-8")
               .replace("@HERE@", html.escape(env["HERE"] or "this machine"))
               .replace("@FALLBACK_NAME@", html.escape(env["HUB_FALLBACK_NAME"] or fallback))
               .replace("@FALLBACK_URL@", html.escape(fallback))
               .replace("@FALLBACK_JSON@", json.dumps(fallback)))
    (assets / "offline.html").write_text(offline, encoding="utf-8")
    # The cache name follows what it caches, so phones refresh it when either changes.
    version = hashlib.sha256(offline.encode() + (assets / "app-192.png").read_bytes()).hexdigest()[:8]
    sw = (Path("web/sw.js").read_text(encoding="utf-8")
          .replace("@FALLBACK_JSON@", json.dumps(fallback)).replace("@VERSION@", version))
    (assets / "sw.js").write_text(sw, encoding="utf-8")
    head += "<script>navigator.serviceWorker?.register('/assets/sw.js', { scope: '/' }).catch(() => {});</script>\n"
else:
    for name in ("sw.js", "offline.html"):
        (assets / name).unlink(missing_ok=True)

page = ttyd_page.read_text(encoding="utf-8")
page = page.replace("<title>ttyd - Terminal</title>", f"<title>{html.escape(env['HUB_NAME'])}</title>", 1)
page = re.sub(r'<link[^>]*rel="icon"[^>]*>', "", page, count=1)  # ttyd's favicon; head.html has ours
i = page.index("</head>")
page = page[:i] + head + page[i:]
i = page.rindex("</body>")
scripts = "".join(f"<script>{Path('web', js).read_text(encoding='utf-8')}</script>" for js in ("sessions.js", "keys.js"))
page = page[:i] + scripts + page[i:]
(share / "index.html").write_text(page, encoding="utf-8")
PY

# Services. ttyd re-reads the page and starts a fresh picker per visit, so only a changed unit
# needs a restart (which drops open hub tabs; the tmux sessions carry on).
restart=0
for unit in systemd/*.service; do
  cmp -s "$unit" "$UNITS/${unit##*/}" || { cp "$unit" "$UNITS/"; restart=1; }
done
systemctl --user daemon-reload
systemctl --user enable --quiet terminal-hub.service terminal-hub-assets.service
if ((restart)); then
  systemctl --user restart terminal-hub.service terminal-hub-assets.service
else
  ((restart_assets)) && systemctl --user restart terminal-hub-assets.service
  systemctl --user start terminal-hub.service terminal-hub-assets.service
fi

echo "installed '$HUB_NAME': ttyd on 127.0.0.1:7682, assets on 127.0.0.1:7683"
grep -qs 'terminal-hub/tmux.conf' "$HOME/.tmux.conf" ||
  echo "optional: add the hub's tmux settings to ~/.tmux.conf (see README.md)"

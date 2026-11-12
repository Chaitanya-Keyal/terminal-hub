#!/usr/bin/env bash
# Install, update or remove terminal-hub for the current user. Safe to re-run.
#   ./install.sh              install from this checkout (again after any change or config edit)
#   ./install.sh --pull       git pull first (how another machine picks up changes)
#   ./install.sh --uninstall  stop the services and remove everything except your config
#   ./install.sh --no-services   no page: on the other machines (hub-state, share, the tmux
#                                settings), or to run ttyd and server.py yourself (as in systemd/)
#
# Puts terminal-hub, share and hub-state in ~/.local/bin and the page, the tmux settings and the
# OpenCode plugin in ~/.local/share/terminal-hub, and runs two systemd user services: ttyd (the
# page and its terminals) on 127.0.0.1:HUB_PORT (7682), and server.py (the page's files and the
# session list) on the next port. Publishing them, say with `tailscale serve`, is up to you.
# Every machine also gets terminal-hub-restore, which brings sessions back after a restart.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

CONFIG=${TERMINAL_HUB_CONFIG:-$HOME/.config/terminal-hub/config}
SHARE=$HOME/.local/share/terminal-hub
BIN=$HOME/.local/bin
UNITS=$HOME/.config/systemd/user
SERVICES=(terminal-hub.service terminal-hub-assets.service)
RESTORE=terminal-hub-restore.service
# systemctl --user finds the user's manager through this; it's unset under `sudo -u`.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

services=1
case ${1:-} in
  '') ;;
  --no-services) services=0 ;;
  --pull)
    git pull --ff-only --quiet
    exec ./install.sh "${@:2}"
    ;;
  --uninstall)
    systemctl --user disable --now "${SERVICES[@]}" "$RESTORE" 2>/dev/null || true
    for s in "${SERVICES[@]}" "$RESTORE"; do rm -f "$UNITS/$s"; done
    systemctl --user daemon-reload
    rm -f "$BIN/terminal-hub" "$BIN/share" "$BIN/hub-state"
    rm -rf "$SHARE"
    echo "terminal-hub removed. Your config is still in $CONFIG, the saved session list in"
    echo "${XDG_STATE_HOME:-$HOME/.local/state}/terminal-hub."
    echo "Also remove: the tailscale serve paths (tailscale serve --set-path / off, and /assets),"
    echo "the source-file line in ~/.tmux.conf, any agent hooks that call hub-state, and the"
    echo "terminal-hub entry in ~/.config/opencode/cli.json."
    exit 0
    ;;
  *) echo "usage: ./install.sh [--pull [--no-services] | --uninstall | --no-services]" >&2; exit 2 ;;
esac

need=(tmux python3)
((services)) && need+=(ttyd)
for cmd in "${need[@]}"; do
  command -v "$cmd" >/dev/null || { echo "terminal-hub needs $cmd" >&2; exit 1; }
done
if ((services)); then
  ttyd_version=$(ttyd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
  if ! printf '%s\n' 1.7 "$ttyd_version" | sort -V -C; then
    echo "terminal-hub needs ttyd 1.7 or newer (found ${ttyd_version:-unknown})" >&2
    exit 1
  fi
fi

mkdir -p "$SHARE" "$BIN"
if ((services)) && [[ ! -f $CONFIG ]]; then
  mkdir -p "${CONFIG%/*}"
  cp config.example "$CONFIG"
  echo "wrote $CONFIG from config.example: edit it (your places), then run ./install.sh again"
fi

# App settings: defaults, then the config. Here place() only notes the first place's label,
# and the rest of the config is for terminal-hub.
HUB_NAME='terminal hub' HUB_SHORT_NAME='hub' HUB_APP_ID='hub'
HUB_DESCRIPTION='Every tmux session in one list' HUB_FALLBACK='' HUB_FALLBACK_NAME='' HUB_PORT=7682
HERE=''
place() { [[ -n $HERE ]] || HERE=$2; }
icon() { :; }
category() { :; }
# shellcheck source=/dev/null
[[ ! -f $CONFIG ]] || source "$CONFIG"
if [[ ! $HUB_PORT =~ ^[0-9]+$ ]] || ((HUB_PORT < 1024 || HUB_PORT > 65534)); then
  echo "HUB_PORT in $CONFIG: a port from 1024 to 65534" >&2
  exit 1
fi

install -m 755 bin/terminal-hub bin/share bin/hub-state "$BIN/"

# The page's files go into a fresh folder that replaces the old one in one step.
new=$SHARE/assets.new
rm -rf "$new"
mkdir -p "$new/vendor"
cp web/app.js web/term.js web/keys.js web/icons.js web/app.css web/FiraCodeNF.woff2 "$new/"
cp icons/app-32.png icons/app-192.png icons/app-512.png "$new/"
cp web/vendor/*.mjs web/vendor/xterm.css "$new/vendor/"

export HUB_NAME HUB_SHORT_NAME HUB_APP_ID HUB_DESCRIPTION HUB_FALLBACK HUB_FALLBACK_NAME HERE
PYTHONUTF8=1 python3 -I - "$SHARE" "$new" <<'PY'
import gzip, hashlib, html, json, os, sys
from pathlib import Path

share, assets, env = Path(sys.argv[1]), Path(sys.argv[2]), os.environ
start = f"/?app={env['HUB_APP_ID']}"
manifest = {
    "id": start, "name": env["HUB_NAME"], "short_name": env["HUB_SHORT_NAME"],
    "description": env["HUB_DESCRIPTION"], "start_url": start, "scope": "/",
    "display": "standalone", "orientation": "any",
    "background_color": "#0b0d10", "theme_color": "#0e1115",
    "icons": [
        {"src": f"/assets/app-{n}.png", "sizes": f"{n}x{n}", "type": "image/png", "purpose": "any maskable"}
        for n in (192, 512)
    ],
}
(assets / "app.webmanifest").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# The service worker: notifications go through it, and with HUB_FALLBACK it opens another hub
# when this machine doesn't answer (offline.html says so on the way).
fallback = env["HUB_FALLBACK"]
offline = ""
if fallback:
    offline = (Path("web/offline.html").read_text(encoding="utf-8")
               .replace("@NAME@", html.escape(env["HUB_NAME"]))
               .replace("@HERE@", html.escape(env["HERE"] or "this machine"))
               .replace("@FALLBACK_NAME@", html.escape(env["HUB_FALLBACK_NAME"] or fallback))
               .replace("@FALLBACK_URL@", html.escape(fallback))
               .replace("@FALLBACK_JSON@", json.dumps(fallback)))
    (assets / "offline.html").write_text(offline, encoding="utf-8")
# The cache name follows what it caches, so phones refresh it when either changes.
cache = hashlib.sha256(offline.encode() + (assets / "app-192.png").read_bytes()).hexdigest()[:8]
sw = (Path("web/sw.js").read_text(encoding="utf-8")
      .replace("@FALLBACK_JSON@", json.dumps(fallback)).replace("@VERSION@", cache))
(assets / "sw.js").write_text(sw, encoding="utf-8")

# The page's files get versioned URLs (/assets/v/HASH), which server.py lets browsers keep for
# good: one hash for the libraries and the font, which rarely change, and one for the rest, so an
# update to the page doesn't make phones fetch the big files again. Text files get a gzipped copy.
def version(files):
    digest = hashlib.sha256()
    for f in sorted(files):
        digest.update(f.relative_to(assets).as_posix().encode() + b"\0" + f.read_bytes())
    return "/assets/v/" + digest.hexdigest()[:12]
everything = [f for f in assets.rglob("*") if f.is_file()]
lib = [f for f in everything if f.parent.name == "vendor" or f.name == "FiraCodeNF.woff2"]
lib_version, app_version = version(lib), version([f for f in everything if f not in lib])
for f in assets.rglob("*"):
    if f.suffix in (".js", ".mjs", ".css", ".webmanifest", ".html", ".svg"):
        with open(f.with_name(f.name + ".gz"), "wb") as out, gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as z:
            z.write(f.read_bytes())

page = (Path("web/index.html").read_text(encoding="utf-8")
        .replace("@LIB@", lib_version)
        .replace("@APP@", app_version)
        .replace("@NAME@", html.escape(env["HUB_NAME"]))
        .replace("@DESCRIPTION@", html.escape(env["HUB_DESCRIPTION"])))
(share / "index.html").write_text(page, encoding="utf-8")
PY

rm -rf "$SHARE/assets"
mv "$new" "$SHARE/assets"
restart_assets=0
cmp -s web/server.py "$SHARE/server.py" || restart_assets=1
cp web/server.py "$SHARE/"
cp tmux/hub.conf "$SHARE/tmux.conf"
mkdir -p "$SHARE/opencode"
cp integrations/opencode/tui.js "$SHARE/opencode/"  # the OpenCode plugin (docs/agents.md)
tmux_hint() {
  grep -qs 'terminal-hub/tmux.conf' "$HOME/.tmux.conf" ||
    echo "optional: add the hub's tmux settings to ~/.tmux.conf (docs/install.md); bringing"\
      "sessions back after a restart needs them"
}

# The units, made for this machine: systemd looks for programs only in the system folders, so
# they get the full paths of ttyd and python3 found above, a PATH with the folders of the tools
# terminal-hub runs, and HUB_PORT. ttyd re-reads the page for each visit, so only a changed unit
# needs a restart (which drops open hub tabs; the tmux sessions carry on).
path=$BIN
add_path() { [[ -z $1 || :$path: == *:"$1":* ]] || path+=:$1; }
for t in ttyd tmux python3 ssh; do p=$(command -v "$t") && add_path "${p%/*}"; done
for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do add_path "$d"; done
# On WSL, Windows' folders last, as WSL adds them in an ordinary terminal (unless wsl.conf turns
# that off), so shells the hub opens can run Windows programs too. Read from Windows itself: the
# shell running this may lack them. A folder with % in it was never expanded, and systemd would
# take the % for its own.
if [[ -e /proc/sys/fs/binfmt_misc/WSLInterop && -x /mnt/c/Windows/System32/cmd.exe ]] &&
  ! grep -qiE '^[[:space:]]*appendWindowsPath[[:space:]]*=[[:space:]]*false' /etc/wsl.conf 2>/dev/null; then
  IFS=';' read -ra win < <(cd /mnt/c && timeout 10 ./Windows/System32/cmd.exe /d /c 'echo %PATH%' 2>/dev/null | tr -d '\r\n') || true
  for d in "${win[@]}"; do
    [[ -n $d && $d != *[%\"]* ]] && d=$(wslpath -u "$d" 2>/dev/null) && [[ -d $d ]] && add_path "$d"
  done
fi
render() {
  sed -e "s|^ExecStart=ttyd |ExecStart=$(command -v ttyd) |; s|--port 7682 |--port $HUB_PORT |" \
    -e "s|^ExecStart=python3 |ExecStart=$(command -v python3) |; s|server.py 7683 |server.py $((HUB_PORT + 1)) |" \
    -e "/^\[Service\]/a Environment=\"PATH=$path\"" "$1"
}
# put UNIT: write UNIT for this machine; fails if it was already so.
put() {
  local dest=$UNITS/$1
  render "systemd/$1" >"$dest.new"
  if cmp -s "$dest.new" "$dest"; then rm "$dest.new"; return 1; fi
  mv "$dest.new" "$dest"
}

# terminal-hub-restore, on every machine with a systemd user manager: after a restart it brings
# back the sessions it ended, once tmux has the hub's settings (docs/install.md).
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$UNITS"
  put "$RESTORE" && systemctl --user daemon-reload
  systemctl --user enable --quiet "$RESTORE"
  systemctl --user start "$RESTORE"
fi

if ((!services)); then
  echo "installed the files (no page): hub-state, share and the tmux settings are ready"
  tmux_hint
  exit 0
fi

mkdir -p "$UNITS"
restart=0 fresh=0
[[ -f $UNITS/terminal-hub.service ]] || fresh=1
for unit in "${SERVICES[@]}"; do put "$unit" && restart=1; done
systemctl --user daemon-reload
systemctl --user enable --quiet "${SERVICES[@]}"
if ((restart)); then
  systemctl --user restart "${SERVICES[@]}"
else
  ((restart_assets)) && systemctl --user restart terminal-hub-assets.service
  systemctl --user start "${SERVICES[@]}"
fi

echo "installed '$HUB_NAME': ttyd on 127.0.0.1:$HUB_PORT, the page's files on 127.0.0.1:$((HUB_PORT + 1))"
if ((fresh)); then
  echo "publish both through something that authenticates (docs/install.md), say on your tailnet:"
  echo "  tailscale serve --bg --set-path / http://127.0.0.1:$HUB_PORT"
  echo "  tailscale serve --bg --set-path /assets http://127.0.0.1:$((HUB_PORT + 1))"
fi
tmux_hint
echo "check the setup any time with: terminal-hub --check"

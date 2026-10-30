# Install

## What you need

- **The hub** (the machine that serves the page): Linux (WSL works) with systemd user services,
  [ttyd](https://github.com/tsl0922/ttyd) 1.7 or newer, tmux and python3.
  [fzf](https://github.com/junegunn/fzf) is optional (a command-line picker).
- **The other machines:** tmux, and ssh key login from the hub.
- **A way to reach the hub** that authenticates you, such as [Tailscale](https://tailscale.com).
  ttyd hands out shells, so the hub must never be open to the internet.

## Install the hub

```sh
git clone https://github.com/Chaitanya-Keyal/terminal-hub && cd terminal-hub
./install.sh                           # the first run writes ~/.config/terminal-hub/config
$EDITOR ~/.config/terminal-hub/config  # add your places: see config.md
./install.sh
loginctl enable-linger "$USER"         # keep it running while you're logged out
terminal-hub --check
```

install.sh puts the scripts in `~/.local/bin`, the page in `~/.local/share/terminal-hub`, and runs
two systemd user services on 127.0.0.1 only: ttyd (the page and its terminals) on port 7682, and
`server.py` (the page's files and the session list) on 7683. `HUB_PORT` in the config moves them.

## Publish it

With Tailscale (on WSL, run these with the Windows `tailscale.exe`):

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7682
tailscale serve --bg --set-path /assets http://127.0.0.1:7683
```

Open `https://MACHINE.TAILNET.ts.net` on your phone and add it to the home screen.

Any other reverse proxy works if it authenticates you first and:

- sends `/` and its websockets to ttyd, and `/assets/…` to server.py with `/assets` cut off;
- keeps the `Host` header (both compare it with the page's `Origin`);
- doesn't buffer `/assets/events` (server-sent events), and lets `/assets/send` take files up to
  100 MB.

## The other machines

The hub reaches them over ssh, so they need nothing more to be listed. For the status dots and
the tmux settings there, run this on each (it needs tmux and python3, not ttyd):

```sh
git clone https://github.com/Chaitanya-Keyal/terminal-hub && cd terminal-hub
./install.sh --no-services
```

## tmux settings

Optional but recommended: they turn on mouse mode (for swipe scrolling and drag-to-copy), size
windows to whichever screen you used last, and add a quiet status line tagged with the place. In
`~/.tmux.conf` on each machine:

```tmux
set -g @hub-tag laptop               # default: the hostname
set -g @hub-colour '#7ee787'
source-file -q ~/.local/share/terminal-hub/tmux.conf
```

## Updating and removing

```sh
./install.sh --pull                  # git pull, then install
./install.sh --uninstall             # stop and remove everything except your config
```

Updates apply when you reload the page; your tmux sessions keep running. A changed service
restarts ttyd, and open pages reconnect.

## Where things go

| Path | What |
| --- | --- |
| `~/.config/terminal-hub/config` | your settings |
| `~/.local/bin/terminal-hub` | lists sessions and attaches to them (ttyd runs it) |
| `~/.local/bin/hub-state`, `share` | the status dots, and `share` |
| `~/.local/share/terminal-hub/` | the page, `server.py`, the tmux settings and the OpenCode plugin |
| `~/.config/systemd/user/terminal-hub.service` | ttyd |
| `~/.config/systemd/user/terminal-hub-assets.service` | `server.py` |
| `$TMPDIR/terminal-hub-files-UID/` | files sent from the page, on the session's machine |

install.sh writes the services for this machine (where it found ttyd, python3 and the tools
terminal-hub runs, and `HUB_PORT`). For anything else, use a drop-in:
`systemctl --user edit terminal-hub`.

## Troubleshooting

`terminal-hub --check` checks the tools, the config, every place, the services and the ports.

- **A place says Unreachable:** ssh couldn't connect within 5 seconds. Try `ssh HOST true` as the
  hub's user; it has to work without a password prompt.
- **A place says Unlock:** its ssh key has a passphrase and isn't in the agent. Tap Unlock, or run
  `terminal-hub --unlock KEY`.
- **A place says Checking:** its first list is taking a while (a slow or sleeping machine); the
  rest of the list doesn't wait for it.
- **The page loads but the list stays empty:** `/assets` isn't published, or the asset service is
  down: `systemctl --user status terminal-hub-assets`.
- **Swiping doesn't scroll:** turn on tmux mouse mode (the hub's tmux settings do).
- **"Notifications are blocked":** the browser was told no once; allow notifications in the
  site's settings (the lock or tune icon next to the address), then turn the bell on again.
- **No notifications, though they're allowed:** the system may hide the browser's notifications.
  On Windows, check Settings → System → Notifications (the switch at the top, which covers every
  app, then your browser), and Do not disturb. A browser that forgets the permission when it
  closes (Edge: "Choose what to clear every time you close the browser", Site permissions) turns
  the bell off again on the next visit.

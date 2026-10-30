# terminal-hub

Every tmux session on your machines, in one web page that works on a phone and on a desktop.

terminal-hub lists the tmux sessions of every machine you give it (this one, others over ssh,
other users on either) and opens any of them in a real terminal: side by side on a desktop, one
at a time with a key bar on a phone. Coding agents like Claude Code get a dot that says whether
they're working, waiting for you, or done. It runs on one machine, you reach it privately over
your tailnet, and there's nothing to build: plain JavaScript, a bash script and a small Python
server around [ttyd](https://github.com/tsl0922/ttyd) and [xterm.js](https://xtermjs.org).

![Two phones: the list of sessions on three machines with status dots, and a session in vim with the key bar](docs/screenshot.png)

![A desktop: the session sidebar, and three sessions side by side: tests, an agent waiting for an answer, and logs](docs/desktop.png)

## What you get

- **One list across machines.** Each *place* in the config is tmux somewhere: here, on another
  machine over ssh, or as another user, with its own colour and icon. A place that can't be
  reached says so, one whose ssh key is locked offers to unlock it, and a slow one never holds up
  the rest.
- **Categories** group sessions above the places, say one per project, even across machines.
  Rules in the config sort sessions by folder or name, and the ⋯ menu moves any session.
  Every group collapses, and a collapsed one still shows if a session in it needs you.
- **Desktop:** a sidebar and up to four sessions side by side. Recent sessions stay connected in
  the background, so switching is instant, and a reload brings your layout back.
- **Phone:** a home screen with every session, then one session at a time with a top bar and a
  one-row key bar for what a phone keyboard lacks (esc, tab, shift-tab, ctrl, ^C, arrows, paste).
  Swipes scroll tmux history, and the page installs as an app.
- **Agent status:** a blue dot while an agent works, yellow when it waits for you (a permission
  prompt or a question; also counted in the tab title), green when it's done, until you look.
  Turn on notifications and the hub tells you when a session needs you or finishes.
- **New sessions** from the list: press + by a place, type a name or leave it blank. Each session's
  ⋯ menu renames it or kills it (after asking).
- **`share`** moves the terminal you're in into tmux, so it shows up in the list. `share -- claude`
  starts a program in its own session.

## How it works

```
 browser (phone or desktop)
    │  HTTPS, tailnet only
    ▼
 tailscale serve ─┬─ /        →  ttyd       127.0.0.1:7682   the page, and one terminal per open session
                  └─ /assets  →  server.py  127.0.0.1:7683   the page's files, and the session list
                                     │
                              terminal-hub (bash)
                                     │
             tmux here  ·  tmux on other machines (ssh)  ·  tmux as another user (sudo)
```

Everything runs on one machine, the hub. Each session you open in the page is its own
connection to ttyd, which runs `terminal-hub KEY:NAME` to attach to that tmux session: directly,
over ssh, or through sudo. The list comes from `terminal-hub --list KEY`, which `server.py` runs
for each place on its own and keeps answering with the latest lists, so a slow place doesn't
delay the others; ssh connections are reused for a minute. Open pages get changes pushed to them
over one connection (server-sent events) instead of asking again and again. The page's files have versioned URLs,
so browsers keep them, and they load in parallel. When a session closes, `terminal-hub` tells the page why (you detached,
the session ended, or the connection dropped), so the page can offer to reattach. Renaming and
killing a session run `terminal-hub --rename` and `--kill` through ttyd the same way.

The other machines run nothing new: they need tmux, and ssh key login from the hub.

## Install

On the hub you need Linux (WSL works) with systemd user services, [ttyd](https://github.com/tsl0922/ttyd)
1.7 or newer, tmux and python3. [fzf](https://github.com/junegunn/fzf) is optional (a command-line
picker). To reach the hub you need [Tailscale](https://tailscale.com) or another proxy that
authenticates.

```sh
git clone https://github.com/Chaitanya-Keyal/terminal-hub && cd terminal-hub
./install.sh                           # the first run writes ~/.config/terminal-hub/config
$EDITOR ~/.config/terminal-hub/config  # add your places
./install.sh
loginctl enable-linger "$USER"         # keep it running while you're logged out
terminal-hub --check
```

Then publish it on your tailnet (on WSL, run these with the Windows `tailscale.exe`):

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7682
tailscale serve --bg --set-path /assets http://127.0.0.1:7683
```

Open `https://MACHINE.TAILNET.ts.net` on your phone and add it to the home screen.

The hub's tmux settings are optional but recommended: they turn on mouse mode (for swipe scrolling),
size windows to whichever screen you used last, and add a quiet status line tagged with the place.
In `~/.tmux.conf` on each machine that has `~/.local/share/terminal-hub/tmux.conf`:

```tmux
set -g @hub-tag laptop               # default: the hostname
set -g @hub-colour '#7ee787'
source-file -q ~/.local/share/terminal-hub/tmux.conf
```

## Config

`~/.config/terminal-hub/config` is a bash file; [config.example](config.example) explains every
setting. Most of it is the list of places:

```bash
place laptop laptop  '#7ee787' local                           # tmux here
place srv    server  '#ff7b72' ssh myserver                    # tmux on myserver (an ssh alias)
place bot    bot     '#d2a8ff' ssh myserver sudo -u bot -H     # another user's tmux there
place box    sandbox '#79c0ff' via sudo -n -u sandbox bash -c  # another user's tmux here
```

Changes to places apply at once. The first place is "here", where links without a place open.

- ssh places need key login, because listing can't answer prompts. A key with a passphrase works
  if an ssh-agent holds it (`AddKeysToAgent yes` in `~/.ssh/config`); while it's locked, the place
  shows **Unlock**, which asks for the passphrase once.
- Session names are 1 to 32 letters, digits, `-` and `_`.

### Icons and categories

```bash
icon laptop laptop                          # a place's icon, shown in its colour
icon bot    🤖                               # or an emoji
category work  Work  briefcase '*/work/*'   # sessions started in a work folder
category ops   Ops   rocket    'srv:*' 'deploy*'
```

A session goes into the first category with a matching pattern: one with a `/` matches the
folder the session started in, one with a `:` matches `PLACE:NAME`, and any other matches the
session's name (`*` and `?` work as in the shell). The ⋯ menu's **Move to category** overrides
the rules for that session, **No category** included; it's kept in the session's tmux option
`@hub-category`. Categories with no sessions don't show.

Icons can be an emoji, or one of these [Lucide](https://lucide.dev/icons) names: bitcoin,
book-open, bot, box, brain, briefcase, bug, building-2, chart-line, cloud, code, coffee,
container, cpu, database, flame, flask-conical, folder, folder-git-2, gamepad-2, gem,
git-branch, globe, graduation-cap, hammer, hard-drive, heart, house, key-round, laptop, layers,
leaf, mail, monitor, moon, mountain, music, package, palette, puzzle, rocket, router, server,
shield, smartphone, sparkles, star, sun, target, terminal, user, users, wallet, wrench, zap.
More can be added to `tools/vendor.sh`.

The app settings (`HUB_NAME` and friends) are built into the page, so run `./install.sh` after
changing them. `HUB_FALLBACK` makes the installed app open another URL when this machine doesn't
answer within 4 seconds, say the same hub on an always-on server.

## Using it

**Desktop.** Click a session to open it. Shift+click, or the split button that appears on hover,
opens it in a new pane beside the others. The ⋯ button next to it, or a right-click on it, renames
it, moves it to another category, or kills it. Click a group's name to collapse it. The keyboard button at the bottom of the sidebar lists
the shortcuts, and common tmux keys after the open session's tmux prefix:

| | |
| --- | --- |
| Alt+↑, Alt+↓ | previous, next session |
| Alt+\` | the last session |
| Shift+click | open in a new pane |
| Shift+drag | select text to copy |
| Shift+right-click | the browser's menu |

With tmux's mouse mode on, tmux gets plain drags and right-clicks (its own menu); Shift hands them
to the page instead. On a Mac, use ⌥ rather than Shift.

**Phone.** Tap a session to open it, and use the back button (or the browser's) to return to the
list. The ⋯ on each session, and the one in the top bar, rename, move or kill it. The top bar's swap button jumps to the last session. ctrl on the key bar applies to the next
key; arrows repeat while held. The gear on the home screen sets the text size.

**Links.** `/?arg=KEY:NAME` opens session NAME on place KEY, creating it if it doesn't exist.
`/?arg=NAME` does the same on the first place, `/?arg=new` starts a new shell there, and
`/?arg=KEY:new` starts one on place KEY.

## Agent status

The dots come from two tmux options on each session, which anything inside the session can set
with `hub-state`:

```sh
hub-state working    # blue
hub-state waiting    # yellow: needs you
hub-state done       # green, until you look at the session
hub-state clear
```

**Claude Code** sets them through hooks. Add the hooks in
[integrations/claude-code.json](integrations/claude-code.json) to `~/.claude/settings.json`: if you
have no `"hooks"` there yet, copy the block in; otherwise add each event's entry to your lists.
With [jq](https://jqlang.org), this merges them for you:

```sh
jq --slurpfile h integrations/claude-code.json \
  '.hooks = ((.hooks // {}) as $old | reduce ($h[0].hooks | to_entries[]) as $e
     ($old; .[$e.key] = ((.[$e.key] // []) + $e.value | unique)))' \
  ~/.claude/settings.json > settings.tmp && cat settings.tmp > ~/.claude/settings.json && rm settings.tmp
```

Every hook runs `~/.local/bin/hub-state hook`, which reads the event and sets the dot: working
when you send a message, waiting when a permission prompt or a question opens, working again once
that tool runs, done when the turn ends (on an error too), cleared when Claude exits. A subagent
finishing its work doesn't hide a question the main agent is asking you. Outside tmux the hooks do
nothing. One gap: Claude Code has no hook for interrupting it with Esc, so after that the dot stays
blue until your next message.

Agents on other machines need `hub-state` there: copy `bin/hub-state` to `~/.local/bin/` on that
machine.

**Notifications.** The bell at the bottom of the sidebar (on a phone: the gear, then
Notifications) asks the browser to allow them. Then a session that starts waiting for you, or
finishes, raises a notification, unless it's on your screen; clicking it opens the session. They
come while the hub is open, in any tab or window: a browser can't run a page that's closed, so a
phone gets them while the app is open or just in the background. On an iPhone, add the hub to the
home screen first (Safari offers notifications only to installed apps). OpenCode isn't supported yet: its plugins run in a shared background process, so they
can't tell which terminal an event belongs to.

## share

```sh
share [NAME] [-- COMMAND...]
```

Run in an ordinary terminal, `share` moves you into a tmux session (named after the folder, or
NAME) so it shows up in the hub; detach with your tmux prefix and `d` to get the plain terminal
back. With a command, the session runs just that command and closes when it exits. A shell
function saves typing, and passes arguments along:

```sh
cc() { share -- claude "$@"; }       # cc --resume
```

## Security

ttyd gives a shell to anyone who can reach it, so both services listen on 127.0.0.1 only. Publish
them only through something that authenticates, such as `tailscale serve` (tailnet only), and never
expose ports 7682 and 7683 directly. ttyd runs with `--check-origin`, so other websites can't open
terminals through your browser. Everything that changes something (opening, creating, renaming
or killing a session) goes through ttyd; `server.py` only reads. The session list (`/assets/sessions.json`) shows session names; it's
published the same way as the rest.

## Updating and removing

```sh
./install.sh --pull                  # git pull, then install
./install.sh --uninstall             # stop and remove everything except your config
```

Updates apply when you reload the page; your tmux sessions keep running. A changed service unit
restarts ttyd, and open pages reconnect.

## Troubleshooting

`terminal-hub --check` checks the tools, the config, every place and the services.

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

## Where things go

| Path | What |
| --- | --- |
| `~/.config/terminal-hub/config` | your settings |
| `~/.local/bin/terminal-hub` | lists sessions and attaches to them (ttyd runs it) |
| `~/.local/bin/hub-state`, `share` | the status dots, and `share` |
| `~/.local/share/terminal-hub/` | the page, `server.py` and the tmux settings |
| `~/.config/systemd/user/terminal-hub.service` | ttyd |
| `~/.config/systemd/user/terminal-hub-assets.service` | `server.py` |

For per-machine changes to a service, like a PATH or a port, use a drop-in:
`systemctl --user edit terminal-hub`.

## Development

There's no build step: edit the files in `web/`, run `./install.sh` and reload. The JavaScript is
type-checked with TypeScript through JSDoc comments. The tests start throwaway tmux servers and
drive the page in Chromium:

```sh
cd tests
npm ci && npx playwright install chromium
npm run typecheck
npm test                             # hub-state, then the page end to end
npm run screenshots                  # a demo hub with made-up sessions, into ../docs
```

`tools/vendor.sh` downloads the pinned xterm.js and Lucide versions into `web/vendor/` and checks
their integrity.

## Credits

[ttyd](https://github.com/tsl0922/ttyd) (MIT) runs the terminals, [xterm.js](https://xtermjs.org)
(MIT) draws them, the icons are [Lucide](https://lucide.dev) (ISC), and the font is FiraCode Nerd
Font (SIL OFL 1.1). Their licences are in `web/vendor/` and `web/FiraCodeNF-LICENSE.txt`.

## License

[MIT](LICENSE)

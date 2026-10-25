# terminal-hub

Every tmux session on your machines in one web terminal that works on a phone.

terminal-hub is a thin layer over [ttyd](https://github.com/tsl0922/ttyd). Open the page and you get an
fzf list of tmux sessions: this machine's, plus any you can reach over ssh or as another user. Tap one
to attach. A key bar adds what a phone keyboard lacks (esc, shift-tab, arrows, ctrl, paste), which
makes TUI apps like Claude Code usable from a phone. The page installs as an app.

![On a phone: the session list across three places, and a session open in vim with the key bar](docs/screenshot.png)

## Features

- **One list across machines.** Each *place* in the config is tmux somewhere: here, on another machine
  over ssh, or as another user through sudo. Rows get a coloured tag per place, and a place that can't be
  reached says so (or, if its ssh key is locked, offers to unlock it).
- **Phone key bar.** esc, ⇧tab, arrows, tab, a sticky ctrl, ^C, paste, back to the list, new session,
  font size. Swipes scroll tmux history.
- **Links.** `/?arg=NAME` opens a session, creating it if needed. `/?arg=KEY:NAME` does the same in
  another place, and `/?arg=new` starts a fresh one.
- **Installable app** with its own name and icon. Optional fallback: if this machine doesn't answer
  within 4 seconds, the app opens another URL, say the same hub on an always-on server.
- **Matching tmux look**: a quiet status line tagged with where you are, and window sizes that follow
  whichever screen you used last.
- **`share`** moves a desktop terminal into tmux so it shows up in the list.

## Security

ttyd gives a shell to anyone who can reach it. terminal-hub listens on 127.0.0.1 only. Publish it
through something that authenticates, such as `tailscale serve` (tailnet only). Never expose ports 7682
and 7683 directly or behind a reverse proxy without auth.

## Install

You need ttyd, tmux, fzf, python3, curl and systemd user services.

```sh
git clone https://github.com/Chaitanya-Keyal/terminal-hub && cd terminal-hub
./install.sh                         # the first run writes ~/.config/terminal-hub/config
$EDITOR ~/.config/terminal-hub/config
./install.sh
loginctl enable-linger "$USER"       # keep it running while you're logged out
```

Then publish it on your tailnet:

```sh
tailscale serve --bg --set-path / http://127.0.0.1:7682
tailscale serve --bg --set-path /assets http://127.0.0.1:7683
```

On WSL, run those with the Windows `tailscale.exe`.

The tmux settings are optional. Add them to `~/.tmux.conf`:

```tmux
set -g @hub-tag laptop               # default: the hostname
set -g @hub-colour '#7ee787'
source-file -q ~/.local/share/terminal-hub/tmux.conf
```

## Config

`~/.config/terminal-hub/config` is a bash file; [config.example](config.example) explains every
setting. The main part is the list of places:

```bash
place laptop laptop  '#7ee787' local                         # tmux here
place srv    server  '#ff7b72' ssh myserver                  # tmux on myserver (an ssh alias)
place bot    bot     '#d2a8ff' ssh myserver sudo -u bot -H   # another user's tmux there
place box    sandbox '#79c0ff' via sudo -n -u sandbox bash -c  # another user's tmux here
```

The first place is "here". ssh places need key login, because listing runs with `BatchMode`. A key with
a passphrase works if an ssh-agent holds it (`AddKeysToAgent` in `~/.ssh/config`): while it's locked, the
place shows "locked, tap to unlock", and tapping it asks for the passphrase once. Session names are
letters, digits, `-` and `_`.

## Updating

```sh
./install.sh --pull                  # git pull, then install
```

The picker and page apply on the next visit. A changed service unit restarts ttyd, which drops open
tabs; the tmux sessions keep running.

## Where things go

| Path | What |
| --- | --- |
| `~/.local/bin/terminal-hub` | the picker that ttyd runs |
| `~/.local/share/terminal-hub/` | the built page, assets, tmux settings, asset server |
| `~/.config/terminal-hub/config` | your settings |
| `~/.config/systemd/user/terminal-hub*.service` | ttyd, and the asset server |

For per-machine service tweaks, like a PATH or a port, use a drop-in: `systemctl --user edit terminal-hub`.

## Credits

[ttyd](https://github.com/tsl0922/ttyd) serves the terminal, using [xterm.js](https://xtermjs.org).
The list is [fzf](https://github.com/junegunn/fzf). The font is FiraCode Nerd Font (SIL OFL 1.1; see
[web/FiraCodeNF-LICENSE.txt](web/FiraCodeNF-LICENSE.txt)).

## License

[MIT](LICENSE)

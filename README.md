# terminal-hub

Every tmux session on your machines, in one web page that works on a phone and on a desktop.

terminal-hub lists the tmux sessions of every machine you give it (this one, others over ssh,
other users on either) and opens any of them in a real terminal: side by side on a desktop, one
at a time with a key bar on a phone. Coding agents (Claude Code, OpenCode) get a dot that says
whether they're working, waiting for you, or done. It runs on one machine, you reach it privately
(over your tailnet, say), and there's nothing to build: plain JavaScript, a few bash scripts and
a small Python server around [ttyd](https://github.com/tsl0922/ttyd) and
[xterm.js](https://xtermjs.org).

![Two phones: the list of sessions on three machines with status dots, and a session in vim with the key bar](docs/screenshot.png)

![A desktop: the session sidebar, and three sessions side by side: tests, an agent waiting for an answer, and logs](docs/desktop.png)

## What you get

- **One list across machines**, each with its own colour and icon. A place that can't be reached
  says so, and a slow one never holds up the rest.
- **Categories** group sessions, say one per project, even across machines. Drag sessions between
  them, and into any order.
- **Desktop:** a sidebar and up to four sessions side by side, switching instantly.
- **Phone:** a home screen with every session, then one at a time with a key bar for what a phone
  keyboard lacks. It installs as an app.
- **Agent status:** blue while an agent works, yellow when it needs you, green when it's done,
  with notifications if you want them.
- **Files into a session:** send a photo from your phone, or drop or paste one on a desktop; its
  path is typed into the session.
- **`share`** moves the terminal you're in into tmux, so it shows up in the list.

## Quick start

On the hub you need Linux (WSL works) with systemd user services,
[ttyd](https://github.com/tsl0922/ttyd) 1.7 or newer, tmux and python3.

```sh
git clone https://github.com/Chaitanya-Keyal/terminal-hub && cd terminal-hub
./install.sh                           # the first run writes ~/.config/terminal-hub/config
$EDITOR ~/.config/terminal-hub/config  # add your places
./install.sh
tailscale serve --bg --set-path / http://127.0.0.1:7682
tailscale serve --bg --set-path /assets http://127.0.0.1:7683
```

Then open `https://MACHINE.TAILNET.ts.net` on your phone and add it to the home screen.

ttyd gives a shell to anyone who can reach it: publish the hub only through something that
authenticates, like `tailscale serve`, never on an open port.

## Docs

- [Install](docs/install.md): what you need, publishing (other proxies too), the other machines,
  tmux settings, updating, troubleshooting
- [Config](docs/config.md): places, icons, categories, app settings
- [Using it](docs/using.md): desktop and phone, sending files, notifications, links, `share`
- [Agent status](docs/agents.md): the dots, Claude Code, OpenCode, your own scripts
- [How it works](docs/development.md): the pieces, security, and working on it

## Credits

[ttyd](https://github.com/tsl0922/ttyd) (MIT) runs the terminals, [xterm.js](https://xtermjs.org)
(MIT) draws them, the icons are [Lucide](https://lucide.dev) (ISC), and the font is FiraCode Nerd
Font (SIL OFL 1.1). Their licences are in `web/vendor/` and `web/FiraCodeNF-LICENSE.txt`.
Licensed under [MIT](LICENSE).

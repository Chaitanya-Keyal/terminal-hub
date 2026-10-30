# How it works

```
 browser (phone or desktop)
    │  HTTPS, through something that authenticates
    ▼
 tailscale serve ─┬─ /        →  ttyd       127.0.0.1:7682   the page, a terminal per session
 (or a proxy)     └─ /assets  →  server.py  127.0.0.1:7683   its files, the list, files you send
                                     │
                              terminal-hub (bash)
                                     │
             tmux here  ·  tmux on other machines (ssh)  ·  tmux as another user (sudo)
```

Everything runs on one machine, the hub. Each session you open in the page is its own connection
to ttyd, which runs `terminal-hub KEY:NAME` to attach to that tmux session: directly, over ssh, or
through sudo. When a session closes, `terminal-hub` tells the page why (you detached, the session
ended, or the connection dropped), so the page can offer to reattach. Renaming, killing and
moving a session run `terminal-hub --rename`, `--kill` and `--category` through ttyd the same way.

The list comes from `terminal-hub --list KEY`, which `server.py` runs for each place on its own, so
a slow place doesn't delay the others; ssh connections are reused for a minute. Open pages get
changes pushed to them over one connection (server-sent events). The page's files have versioned
URLs, so browsers keep them. A file you send goes to `server.py`'s `/send`, which hands it to
`terminal-hub --receive` to save on the session's machine.

## Security

ttyd gives a shell to anyone who can reach it, so both services listen on 127.0.0.1 only; publish
them only through something that authenticates. Other websites can't use your browser to get in:
ttyd runs with `--check-origin`, so it takes terminals only from the hub's own page, and
`server.py` makes the same check before saving a file you send. Everything else that changes
something (opening, creating, renaming or killing a session) goes through ttyd. The session list
(`/assets/sessions.json`) shows session names; it's published the same way as the rest.

## Working on it

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
their integrity. `icons/make-icons.py` draws the app icon (it needs Pillow).

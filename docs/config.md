# Config

`~/.config/terminal-hub/config` is a bash file; [config.example](../config.example) explains every
setting. Changes to places, icons and categories apply at once; the app settings need
`./install.sh` again.

## Places

Each place is tmux somewhere, listed in this order:

```bash
place laptop laptop  '#7ee787' local                           # tmux here
place srv    server  '#ff7b72' ssh myserver                    # tmux on myserver (an ssh alias)
place bot    bot     '#d2a8ff' ssh myserver sudo -u bot -H     # another user's tmux there
place box    sandbox '#79c0ff' via sudo -n -u sandbox bash -c  # another user's tmux here
```

The first place is "here", where links without a place open.

- ssh places need key login, because listing can't answer prompts. A key with a passphrase works
  if an ssh-agent holds it (`AddKeysToAgent yes` in `~/.ssh/config`); while it's locked, the place
  shows **Unlock**, which asks for the passphrase once.
- Session names are 1 to 32 letters, digits, `-` and `_`. tmux allows others; those sessions are
  listed, dimmed, and can be renamed from their ⋯ menu.

## Icons and categories

```bash
icon laptop laptop                          # a place's icon, shown in its colour
icon bot    🤖                               # or an emoji
category work  Work  briefcase '*/work/*'   # sessions started in a work folder
category ops   Ops   rocket    'srv:*' 'deploy*'
```

A session goes into the first category with a matching pattern: one with a `/` matches the folder
the session started in, one with a `:` matches `PLACE:NAME`, and any other matches the session's
name (`*` and `?` work as in the shell). The ⋯ menu's **Move to category**, or dragging the session
into a category, overrides the rules for that session (**No category**, or dragging it to its
place, included); it's kept in the session's tmux option `@hub-category`. Categories with no
sessions don't show, except while you drag one.

You can also make categories on the page: a session's ⋯, **Move to category**, **New
category…**, with a name, an icon, and (ticked unless it's your home folder) a rule that catches
sessions started in that session's folder, so the next one started there lands in it too. Those
live in `~/.config/terminal-hub/categories` (one per line, tab-separated; not run as code), and
their own ⋯ renames or deletes them. Categories in the config are changed in the config.

Icons can be an emoji, or one of these [Lucide](https://lucide.dev/icons) names: bitcoin,
book-open, bot, box, brain, briefcase, bug, building-2, chart-line, cloud, code, coffee,
container, cpu, database, flame, flask-conical, folder, folder-git-2, gamepad-2, gem, git-branch,
globe, graduation-cap, hammer, hard-drive, heart, house, key-round, laptop, layers, leaf, mail,
monitor, moon, mountain, music, package, palette, puzzle, rocket, router, server, shield,
smartphone, sparkles, star, sun, target, terminal, user, users, wallet, wrench, zap. More can be
added to `tools/vendor.sh`.

## App settings

| Setting | What |
| --- | --- |
| `HUB_NAME`, `HUB_SHORT_NAME` | the page title and home-screen name, and the label under the icon |
| `HUB_APP_ID` | the installed app's identity: change it and phones see a new app |
| `HUB_DESCRIPTION` | the app's description |
| `HUB_FALLBACK`, `HUB_FALLBACK_NAME` | a URL the installed app opens when this machine doesn't answer within 4 seconds (say the same hub on an always-on server), and what to call it |
| `HUB_PORT` | ttyd's port (7682); the page's files use the next one |

They're built into the page and the services, so run `./install.sh` after changing them.

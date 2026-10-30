# Using it

## Desktop

Click a session to open it. Shift+click, or the split button that appears on hover, opens it in a
new pane beside the others (up to four). The ⋯ button next to a session, or a right-click on it,
renames it, moves it to another category, or kills it (after asking), and for an open session
sends a file. Click a group's name to collapse it (a collapsed one still shows a session that
needs you). Press + by a place for a new session: type a name, or leave it blank for a shell.

The keyboard button at the bottom of the sidebar lists the shortcuts, and common tmux keys after
the open session's tmux prefix:

| | |
| --- | --- |
| Alt+↑, Alt+↓ | previous, next session |
| Alt+\` | the last session |
| Shift+click | open in a new pane |
| Shift+drag | select text to copy |
| Shift+right-click | the browser's menu |

With tmux's mouse mode on, tmux gets plain drags (its copy reaches your clipboard) and
right-clicks (its own menu); Shift hands them to the page instead. On a Mac, use ⌥ rather than
Shift. Recent sessions stay connected in the background, so switching is instant, and a reload
brings your layout back.

## Phone

Tap a session to open it, and use the back button (or the browser's) to return to the list. The
⋯ on each session, and the one in the top bar, rename, move or kill it; the top bar's also sends a
file into the session. The swap button jumps to the last session. The key bar has what a phone
keyboard lacks: esc, tab, shift-tab, ctrl (for the next key), ^C, arrows (they repeat while held)
and paste. Swipes scroll tmux's history. The gear on the home screen sets the text size and turns
notifications on. Add the page to your home screen to use it as an app.

## Sending files

Send a photo or any file from your phone (the top bar's ⋯, **Send a file**), or on a desktop drop
one on a terminal, paste an image into it, or use the session's ⋯. The file is saved on the
session's machine and its path is typed in, ready for a command, or for Claude Code, which reads a
pasted image path as the image.

Files land in a private folder there, `$TMPDIR/terminal-hub-files-UID` (`/tmp/…` without a
TMPDIR), which the system clears now and then. Their names keep letters, digits, `.`, `-` and `_`,
and get a number in front if the name is taken.

## Notifications

The bell at the bottom of the sidebar (on a phone: the gear, then Notifications) asks the browser
to allow them. Then a session that starts waiting for you, or finishes, raises a notification,
unless it's on your screen; clicking it opens the session. They come while the hub is open, in any
tab or window: a browser can't run a page that's closed, so a phone gets them while the app is
open or just in the background. On an iPhone, add the hub to the home screen first (Safari offers
notifications only to installed apps).

## Links

`/?arg=KEY:NAME` opens session NAME on place KEY, creating it if it doesn't exist. `/?arg=NAME`
does the same on the first place, `/?arg=new` starts a new shell there, and `/?arg=KEY:new` starts
one on place KEY.

## share

```sh
share [NAME] [-- COMMAND...]
```

Run in an ordinary terminal, `share` moves you into a tmux session (named after the folder, or
NAME) so it shows up in the hub; detach with your tmux prefix and `d` to get the plain terminal
back. With a command, the session runs just that command and closes when it exits. A shell
function saves typing, and passes arguments along:

```sh
cl() { share -- claude "$@"; }       # cl --resume
```

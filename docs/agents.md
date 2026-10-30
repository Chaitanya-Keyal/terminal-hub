# Agent status

A blue dot while an agent works, yellow when it waits for you (a permission prompt or a question;
also counted in the tab title), green when it's done, until you look at the session.

The dots come from options on each tmux session, which anything inside the session can set with
`hub-state`, so any script or agent can use them:

```sh
hub-state working    # blue
hub-state waiting    # yellow: needs you
hub-state done       # green, until you look at the session
hub-state clear
```

Agents on the other machines need `hub-state` there too: run `./install.sh --no-services` on each
([install.md](install.md#the-other-machines)), then set up the hooks or the plugin as below.

## Claude Code

Add the hooks in [integrations/claude-code.json](../integrations/claude-code.json) to
`~/.claude/settings.json`: if you have no `"hooks"` there yet, copy the block in; otherwise add
each event's entry to your lists. With [jq](https://jqlang.org), this merges them for you:

```sh
jq --slurpfile h integrations/claude-code.json \
  '.hooks = ((.hooks // {}) as $old | reduce ($h[0].hooks | to_entries[]) as $e
     ($old; .[$e.key] = ((.[$e.key] // []) + $e.value | unique)))' \
  ~/.claude/settings.json > settings.tmp && cat settings.tmp > ~/.claude/settings.json && rm settings.tmp
```

Every hook runs `~/.local/bin/hub-state hook`, which reads the event and sets the dot:

- working when you send a message;
- waiting when a permission prompt or a question opens, and working again as soon as you answer;
- done when the turn ends (on an error too);
- cleared when you stop Claude (Esc, or no to a permission) or it exits.

Claude Code has no hooks for answering a prompt or for stopping, so during a turn `hub-state`
watches for those in the background: the prompt closing on screen, and the interruption in
Claude's transcript. A subagent finishing its work doesn't hide a question the main agent is
asking you. Outside tmux the hooks do nothing.

## OpenCode

OpenCode (v2) sets the dots through a small plugin that runs in its terminal window, so it knows
its tmux pane even when OpenCode's server is the shared background service. install.sh puts it in
`~/.local/share/terminal-hub/opencode`; list that folder, with its full path, in
`~/.config/opencode/cli.json` (create the file if you have none):

```json
{ "plugins": ["/home/you/.local/share/terminal-hub/opencode"] }
```

The dot is working while one of the window's tabs is busy, waiting when one asks for a permission
or a question, done when they finish, and cleared when you stop one with Esc or close OpenCode.

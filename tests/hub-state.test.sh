#!/usr/bin/env bash
# Tests for bin/hub-state: feeds it hook events shaped like Claude Code's and checks the mark it
# leaves on a tmux session (a private tmux server, found through $TMUX as inside a real pane).
set -u
cd "$(dirname "$0")/.." || exit 1
dir=$(mktemp -d)
# -S everywhere it matters: run inside tmux, a bare `tmux kill-server` would end your own server.
trap 'tmux -S "$dir/sock" kill-server 2>/dev/null; rm -rf "$dir"' EXIT
tmux -S "$dir/sock" -f /dev/null new-session -d -s t
export TMUX="$dir/sock,0,0"
TMUX_PANE=$(tmux display-message -p -t t '#{pane_id}')
export TMUX_PANE

fails=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
opt() { tmux display-message -p -t "$TMUX_PANE" "#{$1}"; }
# check WHAT STATE/WAITER
check() {
  local got
  got="$(opt @hub-state)/$(opt @hub-wait)"
  if [[ $got == "$2" ]]; then pass "$1"; else fail "$1: expected $2, got $got"; fi
}
# ev EVENT [AGENT] [MORE-JSON]: a hook event, with the fields in the order Claude Code sends them
ev() {
  printf '{"session_id":"s","cwd":"/x","permission_mode":"default",%s"hook_event_name":"%s"%s}' \
    "${2:+\"agent_id\":\"$2\",\"agent_type\":\"Explore\",}" "$1" "${3:-}" | bin/hub-state hook
}
T=',"tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_1"'

ev UserPromptSubmit;              check "a prompt: working" working/
ev PermissionRequest '' "$T";     check "a permission dialog or question: waiting" waiting/main
ev PostToolUse sub1 "$T";         check "a subagent's tool doesn't end the main agent's wait" waiting/main
ev PostToolUse '' "$T";           check "the main agent's tool: working again" working/
ev PermissionRequest sub1 "$T";   check "a subagent asks: waiting" waiting/sub1
ev PostToolUse '' "$T";           check "the main agent's tool doesn't end the subagent's wait" waiting/sub1
ev PostToolUseFailure sub1 "$T";  check "the subagent's tool, even failing: working" working/
ev PostToolUse '' ',"tool_name":"X","tool_input":{"agent_id":"evil"}'
check "an agent_id inside a tool's input is ignored" working/
ev Stop;                          check "the turn ends: done" done/
tmux set-option -t t @hub-state-at 1
ev StopFailure;                   check "a turn ending on an error: done" done/
if [[ $(opt @hub-state-at) == 1 ]]; then pass "done again keeps its time"; else fail "done again changed its time"; fi
ev SessionEnd;                    check "the session ends: no mark" /
if [[ -z $(opt @hub-state-at) ]]; then pass "the session ends: no time either"; else fail "the session ends: time left behind"; fi

bin/hub-state waiting;            check "waiting, set by hand" waiting/
ev PostToolUse sub2 "$T";         check "any tool ends a wait set by hand" working/
bin/hub-state clear;              check "cleared by hand" /

{ printf '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"'
  head -c 3000000 /dev/zero | tr '\0' a; printf '"}}'; } | bin/hub-state hook
check "a 3 MB event" waiting/main
printf '{"something":"else"}' | bin/hub-state hook
check "an event it doesn't know changes nothing" waiting/main

if env -u TMUX -u TMUX_PANE bin/hub-state hook <<<'{}'; then pass "outside tmux: does nothing"; else fail "outside tmux: failed"; fi
bin/hub-state bogus 2>/dev/null
if [[ $? == 2 ]]; then pass "a bad argument: usage, exit 2"; else fail "a bad argument: wrong exit code"; fi

echo "$fails failed"
((fails == 0))

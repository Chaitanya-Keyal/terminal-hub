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

# The watch, for what no hook reports: each prompt and each permission dialog starts one.
bin/hub-state clear
sleep 0.6  # the watches started above see the change and stop
TR=",\"transcript_path\":\"$dir/t.jsonl\""
: >"$dir/t.jsonl"
dialog() { tmux send-keys -t t "clear; printf ' Do you want to proceed?\n 1. Yes\n\n Esc to cancel - Tab to amend\n'" Enter; sleep 0.5; }
answer() { tmux send-keys -t t clear Enter; }
# wait_for STATE/WAITER: true once the mark is that (up to 4 s)
wait_for() { local i; for ((i = 0; i < 40; i++)); do [[ "$(opt @hub-state)/$(opt @hub-wait)" == "$1" ]] && return 0; sleep 0.1; done; return 1; }
# expect WHAT STATE/WAITER: check, allowing the watch its moment
expect() { if wait_for "$2"; then pass "$1"; else fail "$1: expected $2, got $(opt @hub-state)/$(opt @hub-wait)"; fi; }
# Lines Claude Code adds to the transcript: stopped [" for tool use"], and no [WHAT-INSTEAD].
stopped() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user%s]"}]}}\n' "${1:-}" >>"$dir/t.jsonl"; }
no() {
  printf '{"type":"user","message":{"content":[{"type":"tool_result","content":"The user doesn'\''t want to proceed with this tool use. %s"}]}}\n' \
    "${1:-STOP what you are doing and wait for the user to tell you how to proceed.}" >>"$dir/t.jsonl"
  [[ -n ${1:-} ]] || stopped ' for tool use'
}
stopped  # from an earlier turn
ev UserPromptSubmit '' "$TR"
sleep 1.5;                        check "an earlier turn's interruption doesn't count" working/
stopped
expect "pressing Esc: the mark clears" /
ev UserPromptSubmit '' "$TR"
dialog
ev PermissionRequest '' "$TR$T"
sleep 1.5;                        check "while the dialog is open: waiting" waiting/main
answer
expect "answering it: working at once" working/
dialog
ev PermissionRequest '' "$TR$T"
sleep 1
no
answer
expect "saying no: Claude stops, and the mark clears" /
ev UserPromptSubmit '' "$TR"
dialog
ev PermissionRequest '' "$TR$T"
sleep 1
no 'To tell you how to proceed, the user said: use ls'
answer
expect "saying no and what to do instead: working" working/
ev Stop
stopped
sleep 1.5;                        check "after the turn, nothing is watched" done/

if env -u TMUX -u TMUX_PANE bin/hub-state hook <<<'{}'; then pass "outside tmux: does nothing"; else fail "outside tmux: failed"; fi
bin/hub-state bogus 2>/dev/null
if [[ $? == 2 ]]; then pass "a bad argument: usage, exit 2"; else fail "a bad argument: wrong exit code"; fi

echo "$fails failed"
((fails == 0))

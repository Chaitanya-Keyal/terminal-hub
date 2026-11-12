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
# The saved session list goes here, never into your own; the boot is made up.
export XDG_STATE_HOME="$dir/state" HUB_STATE_BOOT=boot-1
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

# Remembering the sessions, and bringing them back after a restart.
saved="$dir/state/terminal-hub/sessions"
ev UserPromptSubmit
if [[ $(opt @hub-resume) == 'claude s' ]]; then pass "a prompt records the conversation to resume"; else fail "no conversation recorded: '$(opt @hub-resume)'"; fi
if grep -qx $'session\tt\t[^\t]*\t.\tclaude s' "$saved"; then pass "a new conversation is saved at once"; else fail "not saved: $(cat "$saved")"; fi
ev SessionEnd
if [[ -z $(opt @hub-resume) ]]; then pass "the conversation ends: nothing to resume"; else fail "still resumes $(opt @hub-resume)"; fi

mkdir -p "$dir/work"
# Plain shells, not yours: your startup files might change folder or print things.
tmux set-option -g default-command 'exec bash --norc --noprofile'
tmux new-session -d -s plain -c "$dir/work"
tmux new-session -d -s sorted -c "$dir"
tmux set-option -t =sorted: @hub-category projects
tmux new-session -d -s agent -c "$dir/work"
tmux new-session -d -s out -c "$dir"
tmux set-option -t =out: @hub-category -
TMUX_PANE=$(tmux display-message -p -t =agent: '#{pane_id}') bin/hub-state resume claude abc-123
TMUX_PANE=$(tmux display-message -p -t =agent: '#{pane_id}') bin/hub-state resume claude 'x; rm -rf ~'
tmux new-session -d -s 'odd name'
bin/hub-state save
if [[ $(head -1 "$saved") == $'boot\tboot-1' ]] && grep -qx $'session\tplain\t'"$dir/work"$'\t.\t-' "$saved" &&
  grep -qx $'session\tsorted\t'"$dir"$'\tprojects\t-' "$saved" && grep -qx $'session\tagent\t'"$dir/work"$'\t.\tclaude abc-123' "$saved" &&
  grep -qx $'session\tout\t'"$dir"$'\t-\t-' "$saved"
then pass "save: name, folder, category and conversation of each session"; else fail "save wrote: $(cat "$saved")"; fi
if grep -q odd "$saved"; then fail "a name the hub can't open was saved"; else pass "names the hub can't open aren't saved"; fi

bin/hub-state restore
if [[ $(tmux ls -F '#S' | sort | tr '\n' ' ') == 'agent odd name out plain sorted t ' ]]; then pass "the same boot: restore changes nothing"
else fail "the same boot: sessions now $(tmux ls -F '#S' | tr '\n' ' ')"; fi

# A restart ends them all (here: all but t, the test's own).
for s in plain sorted agent out 'odd name'; do tmux kill-session -t "=$s"; done
HUB_STATE_BOOT=boot-2 bin/hub-state restore
if [[ $(tmux ls -F '#S' | sort | tr '\n' ' ') == 'agent out plain sorted t ' ]]; then pass "a new boot: the saved sessions are back"
else fail "after the restore: $(tmux ls -F '#S' | tr '\n' ' ')"; fi
if [[ $(tmux display-message -p -t =plain: '#{pane_current_path}') == "$dir/work" ]]; then pass "back in their folder"; else fail "plain is in $(tmux display-message -p -t =plain: '#{pane_current_path}')"; fi
if [[ $(tmux display-message -p -t =sorted: '#{@hub-category}') == projects ]]; then pass "back in their category"; else fail "sorted lost its category"; fi
if [[ $(tmux display-message -p -t =out: '#{@hub-category}') == - ]]; then pass "moved out of every category: still out"; else fail "out is in '$(tmux display-message -p -t =out: '#{@hub-category}')'"; fi
if [[ -z $(tmux display-message -p -t =plain: '#{@hub-category}') ]]; then pass "never moved: its folder still decides"; else fail "plain got category '$(tmux display-message -p -t =plain: '#{@hub-category}')'"; fi
line=$(tmux capture-pane -p -t =agent: | grep -F 'claude --resume abc-123')
if [[ -n $line ]]; then pass "the agent's resume command is typed"; else fail "agent shows: $(tmux capture-pane -p -t =agent:)"; fi
sleep 0.5
if [[ $(tmux capture-pane -p -t =agent: | grep -c .) -le 2 && $(tmux display-message -p -t =agent: '#{pane_current_command}') != claude ]]
then pass "but not run"; else fail "it ran: $(tmux capture-pane -p -t =agent:)"; fi
if [[ $(tmux display-message -p -t =agent: '#{@hub-resume}') == 'claude abc-123' ]]; then pass "and still remembered, for the next restart"; else fail "the restored session forgot its conversation"; fi
if [[ $(head -1 "$saved") == $'boot\tboot-2' ]]; then pass "the list now belongs to this boot"; else fail "the list's boot: $(head -1 "$saved")"; fi

tmux kill-session -t =plain
tmux kill-session -t =out
HUB_STATE_BOOT=boot-2 bin/hub-state save
tmux kill-session -t =sorted
HUB_STATE_BOOT=boot-2 bin/hub-state restore
if ! tmux has-session -t =sorted 2>/dev/null; then pass "only once per boot"; else fail "restored twice in one boot"; fi
tmux kill-session -t =agent
HUB_STATE_BOOT=boot-3 bin/hub-state restore
if [[ $(tmux ls -F '#S' | sort | tr '\n' ' ') == 'agent t ' ]]; then pass "sessions ended on purpose stay ended; the rest come back"
else fail "after the next restart: $(tmux ls -F '#S' | tr '\n' ' ')"; fi

# shellcheck disable=SC2016  # on purpose: code that would run if the list were run as code
printf 'boot\told\nsession\t$(touch %s)\t/\t-\t-\nsession\tbad1\t/tmp\t-\tclaude ;touch %s\nsession\t-x\t/tmp\t-\t-\n' \
  "$dir/pwned" "$dir/pwned" >"$saved"
HUB_STATE_BOOT=boot-4 bin/hub-state restore
sleep 0.5
if [[ ! -e $dir/pwned ]] && ! tmux has-session -t '=-x' 2>/dev/null && ! tmux capture-pane -p -t =bad1: | grep -qF touch
then pass "a tampered list runs nothing"; else fail "a tampered list did something"; fi
for s in agent sorted bad1; do tmux kill-session -t "=$s" 2>/dev/null; done

if env -u TMUX -u TMUX_PANE bin/hub-state hook <<<'{}'; then pass "outside tmux: does nothing"; else fail "outside tmux: failed"; fi
bin/hub-state bogus 2>/dev/null
if [[ $? == 2 ]]; then pass "a bad argument: usage, exit 2"; else fail "a bad argument: wrong exit code"; fi

echo "$fails failed"
((fails == 0))

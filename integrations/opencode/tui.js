// terminal-hub for OpenCode (v2): marks this tmux session in the hub's list as working, waiting
// (for you: a permission or a question) or done, like the Claude Code hooks do (hub-state).
//
// It's a TUI plugin, so it runs in the terminal, inside the tmux pane, even when OpenCode's server
// is the shared background service (which can't tell which terminal a session is shown in).
// Install: list this folder in ~/.config/opencode/cli.json (see README.md).
import { Plugin } from '@opencode/plugin/tui';
import { createEffect, createRoot } from 'solid-js';
import { spawn } from 'node:child_process';

const HUB_STATE = `${process.env.HOME}/.local/bin/hub-state`;

export default Plugin.define({
  id: 'terminal-hub',
  setup(ctx) {
    if (!process.env.TMUX || !process.env.TMUX_PANE) return;  // not in tmux: nothing to mark

    // hub-state runs one at a time, in order, and only when the mark changes.
    let marked = '', queue = Promise.resolve();
    const mark = state => {
      if (state === marked) return;
      marked = state;
      queue = queue.then(() => new Promise(resolve => {
        try {
          const p = spawn(HUB_STATE, [state], { stdio: 'ignore' });
          p.on('exit', resolve);
          p.on('error', resolve);
        } catch { resolve(); }
      }));
    };

    // The sessions this terminal shows: its tabs, or the session on screen.
    const shown = () => {
      if (ctx.ui.tabs.enabled()) return ctx.ui.tabs.list();
      const route = ctx.ui.router.current();
      if (route.type !== 'session') return [];
      const family = ctx.data.session.family(route.sessionID);
      return [{
        sessionID: route.sessionID,
        busy: family.some(id => ctx.data.session.status(id) === 'running'),
        attention: family.some(id => (ctx.data.session.permission.list(id) ?? []).length > 0
          || (ctx.data.session.form.list(id) ?? []).length > 0),
      }];
    };

    // Sessions stopped with Esc: their turn didn't finish, so they get no "done".
    const interrupted = new Set();
    const stops = [
      ctx.data.on('session.execution.started', e => interrupted.delete(e.data.sessionID)),
      ctx.data.on('session.execution.interrupted', e => interrupted.add(e.data.sessionID)),
    ];

    // Waiting beats working. When nothing is busy any more, it's done, or no mark after an Esc;
    // decided a moment later, as the interrupt's event and the tab's change come in either order.
    let busy = [], settle;
    const update = () => {
      const tabs = shown();
      clearTimeout(settle);
      if (tabs.some(t => t.attention)) return mark('waiting');
      const now = tabs.filter(t => t.busy).map(t => t.sessionID);
      if (now.length) { busy = now; return mark('working'); }
      if (marked !== 'working' && marked !== 'waiting') return;
      settle = setTimeout(() => {
        mark(busy.length && busy.every(id => interrupted.has(id)) ? 'clear' : 'done');
        busy = [];
      }, 300);
    };

    // Tabs are reactive; events catch what isn't (a moment later, once the data has caught up).
    const stopEffect = createRoot(dispose => { createEffect(update); return dispose; });
    let timer;
    stops.push(ctx.data.listen(() => { clearTimeout(timer); timer = setTimeout(update, 100); }));
    return () => {
      stopEffect();
      for (const stop of stops) stop();
      clearTimeout(timer);
      clearTimeout(settle);
      if (marked) spawn(HUB_STATE, ['clear'], { stdio: 'ignore', detached: true }).unref();
    };
  },
});

// One live terminal: an xterm.js view connected to ttyd, attached to one tmux session.
//
// ttyd's protocol (ttyd 1.7): a websocket on /ws with subprotocol "tty". The client first sends
// JSON {AuthToken, columns, rows}; after that every message starts with a command byte:
// client → ttyd: "0" input, "1" resize (JSON), "2" pause, "3" resume;
// ttyd → client: "0" output, "1" window title, "2" preferences.
// ?arg=… on the websocket URL becomes the command's arguments (ttyd --url-arg).
// The @xterm/* imports resolve through the import map in index.html (to vendor/*.mjs); their
// types come from vendor/types, for `tsc` (tsconfig.json).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { icon } from './icons.js';

const enc = new TextEncoder();
const FLOW = { limit: 100000, high: 10, low: 4 };  // same back-pressure as ttyd's own page
const THEME = {
  background: '#0b0d10', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0b0d10',
  selectionBackground: 'rgba(68, 147, 248, 0.35)',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
};
const CTRL_SYMS = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127 };
// Where the key that takes the mouse back from the app (to select text) is ⌥ rather than Shift.
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

let tokenPromise = null;
const authToken = () => (tokenPromise ??= fetch('/token').then(r => r.json()).then(j => j.token || '').catch(() => ''));

const wsUrl = args => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${args.map(a => 'arg=' + encodeURIComponent(a)).join('&')}`;

// Run one terminal-hub command that answers with OSC 7766 ("ok" or "failed;MESSAGE"), such as
// ['--kill', 'laptop:notes'], through ttyd like a terminal (so ttyd's origin check covers it).
/** @returns {Promise<{ok: boolean, message: string}>} */
export async function runHub(args) {
  const token = await authToken();
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl(args), ['tty']);
    const dec = new TextDecoder();
    let out = '', settled = false;
    const done = (ok, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve({ ok, message });
    };
    const timer = setTimeout(() => done(false, 'No answer'), 20000);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(enc.encode(JSON.stringify({ AuthToken: token, columns: 80, rows: 24 })));
    ws.onmessage = e => {
      const d = new Uint8Array(e.data);
      if (d[0] !== 48) return;
      out += dec.decode(d.subarray(1), { stream: true });
      const m = out.match(/\x1b\]7766;([^\x07]*)\x07/);
      if (m) { const [result, ...msg] = m[1].split(';'); done(result === 'ok', msg.join(';')); }
    };
    ws.onclose = () => done(false, out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() || 'No answer');
  });
}

export function ctrlOf(d) {
  const c = d.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
  return d in CTRL_SYMS ? String.fromCharCode(CTRL_SYMS[d]) : d;
}

export class TermView {
  // args: the command's arguments, e.g. ['laptop:notes'] or ['--unlock', 'server'];
  // again: the arguments for reconnecting (default: args), e.g. ['--existing', 'laptop:notes'].
  // hooks: {fontSize, renderer, ctrl() → bool, ctrlUsed(), status(view), copied(),
  //   actions(view) → [[label, fn]], attached(view): a connection's first output (the session exists),
  //   files(view, files): files dropped on it, or an image pasted into it}
  constructor(args, hooks, again = args) {
    this.args = args;
    this.again = again;
    this.target = '';  // the page's name for the session (KEY:NAME); a rename changes it
    this.connections = 0;
    this.hooks = hooks;
    this.status = 'connecting';  // connecting | open | reconnecting | detached | ended | unlocked | failed
    this.reason = '';            // why the last connection closed, from the attach (OSC 7766)
    this.retries = 0;
    this.connecting = false;  // waiting for the auth token, before the socket exists
    this.fitFrame = 0;
    this.lastUsed = 0;  // for the page's keep-the-recent-ones-connected rule
    this.written = 0;
    this.pending = 0;
    /** @type {WebSocket | null} */ this.ws = null;
    this.el = Object.assign(document.createElement('div'), { className: 'term' });
    this.screen = Object.assign(document.createElement('div'), { className: 'term-screen' });
    this.overlay = Object.assign(document.createElement('div'), { className: 'term-overlay' });
    this.el.append(this.screen, this.overlay);

    const t = (this.term = new Terminal({
      fontFamily: '"FiraCode NF", ui-monospace, Menlo, Consolas, monospace',
      fontSize: hooks.fontSize, lineHeight: 1.1, theme: THEME, cursorBlink: true,
      allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true,
      scrollback: 2000, drawBoldTextInBrightColors: false,
    }));
    this.fit = new FitAddon();
    t.loadAddon(this.fit);
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
    t.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    t.onData(d => {
      if (this.hooks.ctrl() && d.length === 1) { d = ctrlOf(d); this.hooks.ctrlUsed(); }
      this.send(d);
    });
    t.onBinary(d => this.sendBytes(Uint8Array.from(d, c => c.charCodeAt(0))));
    t.onResize(({ cols, rows }) => this.sendCommand('1', JSON.stringify({ columns: cols, rows })));
    t.parser.registerOscHandler(7766, data => { this.reason = data; return true; });
    // tmux's copy (a mouse drag, with mouse mode on) arrives as OSC 52 "SELECTION;BASE64": put it
    // on the clipboard. A request to read the clipboard ("?") is ignored: it's none of their business.
    t.parser.registerOscHandler(52, data => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (b64 && b64 !== '?' && navigator.clipboard) {
        try {
          const text = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
          navigator.clipboard.writeText(text).then(() => this.hooks.copied(), () => {});
        } catch { /* not base64 */ }
      }
      return true;
    });
    t.onSelectionChange(() => {
      const s = t.getSelection();
      if (s && navigator.clipboard) navigator.clipboard.writeText(s).then(() => this.hooks.copied(), () => {});
    });
    // When the app uses the mouse (tmux's mouse mode), right-click is its too: tmux has a menu.
    // The key that selects text past the app (Shift; ⌥ on a Mac) brings the browser's menu back.
    this.el.addEventListener('contextmenu', e => {
      if (t.modes.mouseTrackingMode !== 'none' && !(MAC ? e.altKey : e.shiftKey)) e.preventDefault();
    });
    // Files dropped here, or an image pasted (a screenshot; pasted text stays xterm's), go to the
    // page, which sends them to the session's machine.
    this.el.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.el.addEventListener('drop', e => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || !this.hooks.files) return;
      e.preventDefault();
      this.hooks.files(this, files);
    });
    this.el.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || e.clipboardData?.getData('text') || !this.hooks.files) return;
      e.preventDefault();
      e.stopPropagation();
      this.hooks.files(this, files);
    }, true);
    new ResizeObserver(() => this.refit()).observe(this.el);
  }

  // Put the terminal on screen in SLOT; the first time, open xterm and connect.
  mount(slot) {
    if (this.el.parentNode !== slot) slot.append(this.el);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.screen);
      this.touchScroll();
      if (this.hooks.renderer !== 'dom') {
        try {
          const gl = new WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          this.term.loadAddon(gl);
        } catch { /* the DOM renderer is the fallback */ }
      }
      this.refit();
      this.connect();
    } else {
      this.refit();
    }
  }

  refit() {
    if (!this.opened || !this.el.offsetWidth || !this.el.offsetHeight) return;  // hidden: keep the size
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => { try { this.fit.fit(); } catch {} });
  }

  async connect() {
    if (this.connecting) return;  // two quick calls (a phone waking up) would attach twice
    clearTimeout(this.retryTimer);
    this.reason = '';
    this.setStatus(this.retries ? 'reconnecting' : 'connecting');
    this.connecting = true;
    const token = await authToken();
    this.connecting = false;
    if (this.disposed) return;
    this.ws?.close();
    const ws = new WebSocket(wsUrl(this.connections++ ? this.again : this.args), ['tty']);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(enc.encode(JSON.stringify({ AuthToken: token, columns: this.term.cols, rows: this.term.rows })));
      this.retries = 0;
      this.written = this.pending = 0;
      this.quiet = true;
      this.setStatus('open');
    };
    ws.onmessage = e => {
      const d = new Uint8Array(e.data);
      if (d[0] !== 48) return;  // "0": output; title and preferences are ignored
      this.write(d.subarray(1));
      if (this.quiet) { this.quiet = false; this.hooks.attached?.(this); }
    };
    ws.onclose = () => { if (this.ws === ws) this.closed(); };
    this.ws = ws;
  }

  // The connection closed. ttyd doesn't say why (its close code is the same either way), but the
  // attach does, in its last output: detached, ended, unlocked or failed are final. No reason, or
  // "lost", means the network: try again (quickly at first, then every 10 s). xterm parses output
  // a moment after it arrives, so let it catch up before reading the reason.
  closed() {
    this.ws = null;
    if (this.disposed) return;
    this.term.write('', () => {
      if (this.disposed) return;
      const why = this.reason;
      if (why && why !== 'lost') return this.setStatus(why);
      const delay = Math.min(10000, 500 * 2 ** this.retries++);
      this.setStatus('reconnecting');
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  reconnectNow() {
    if (this.status === 'reconnecting') this.connect();
  }

  // Output, with ttyd's flow control: pause the command while xterm is behind.
  write(data) {
    this.written += data.length;
    if (this.written > FLOW.limit) {
      this.term.write(data, () => {
        this.pending = Math.max(this.pending - 1, 0);
        if (this.pending < FLOW.low) this.sendCommand('3');
      });
      this.pending++;
      this.written = 0;
      if (this.pending > FLOW.high) this.sendCommand('2');
    } else {
      this.term.write(data);
    }
  }

  send(text) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(text.length * 3 + 1);
    buf[0] = 48;
    const { written } = enc.encodeInto(text, buf.subarray(1));
    this.ws.send(buf.subarray(0, written + 1));
  }

  sendBytes(bytes) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(bytes.length + 1);
    buf[0] = 48;
    buf.set(bytes, 1);
    this.ws.send(buf);
  }

  sendCommand(cmd, json = '') {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(enc.encode(cmd + json));
  }

  // Arrow keys depend on the terminal's cursor-key mode.
  arrow(dir) { return (this.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + dir; }

  paste(text) { this.term.paste(text); }
  focus() { this.term.focus(); }
  setFontSize(px) { if (this.term.options.fontSize !== px) { this.term.options.fontSize = px; this.refit(); } }

  setStatus(status) {
    this.status = status;
    clearTimeout(this.spinTimer);
    this.overlay.replaceChildren();
    this.overlay.className = 'term-overlay';
    if (status === 'connecting') {
      // Only show a spinner if connecting takes a moment.
      this.spinTimer = setTimeout(() => this.banner('loader-circle', 'Connecting…', true), 600);
    } else if (status === 'reconnecting') {
      this.banner('wifi-off', 'Reconnecting…', false);
    } else if (status !== 'open') {
      this.card(status);
    }
    this.hooks.status(this);
  }

  banner(name, text, spin) {
    const b = Object.assign(document.createElement('div'), { className: 'term-banner' });
    const i = icon(name);
    if (spin) i.classList.add('spin');
    b.append(i, text);
    this.overlay.replaceChildren(b);
  }

  card(status) {
    const actions = this.hooks.actions(this);
    if (!actions) return;
    const box = Object.assign(document.createElement('div'), { className: 'term-card' });
    const title = { detached: 'Detached', ended: 'Session ended', failed: 'Still locked', unlocked: 'Unlocked' }[status] ?? status;
    box.append(Object.assign(document.createElement('b'), { textContent: title }));
    const row = Object.assign(document.createElement('div'), { className: 'term-card-actions' });
    for (const [label, fn, primary] of actions) {
      const btn = Object.assign(document.createElement('button'), { className: primary ? 'btn primary' : 'btn', textContent: label });
      btn.onclick = fn;
      row.append(btn);
    }
    box.append(row);
    this.overlay.className = 'term-overlay dim';
    this.overlay.replaceChildren(box);
  }

  // Phones: with tmux's mouse mode on, xterm ignores swipes; turn them into wheel events so tmux
  // scrolls its history.
  touchScroll() {
    const el = this.term.element, rowsPerTick = 2;
    if (!el) return;
    /** @type {number | null} */ let lastY = null;
    let acc = 0, x = 0;
    const screen = () => /** @type {HTMLElement} */ (el.querySelector('.xterm-screen') ?? el);
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { lastY = null; return; }
      lastY = e.touches[0].clientY; x = e.touches[0].clientX; acc = 0;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (lastY === null || this.term.modes.mouseTrackingMode === 'none') return;
      const y = e.touches[0].clientY;
      acc += y - lastY; lastY = y;
      const step = (screen().offsetHeight / this.term.rows) * rowsPerTick;
      while (Math.abs(acc) >= step) {
        const older = acc > 0;  // finger moving down shows older output
        acc -= older ? step : -step;
        screen().dispatchEvent(new WheelEvent('wheel', {
          deltaY: older ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));
      }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.spinTimer);
    try { this.ws?.close(); } catch {}
    this.term.dispose();
    this.el.remove();
  }
}

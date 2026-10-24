// Phone extras for the terminal hub (ttyd): extra-keys bar, Nerd Font, persisted font size.
(() => {
  const FONT = '"FiraCode NF", monospace';
  const BG = '#0b0d10';  // the hub's background; ttyd's default grey would frame the terminal
  const SIZE_KEY = 'ttyd.fontSize';
  let size = +localStorage.getItem(SIZE_KEY) || 16;
  let ctrl = false;
  let rawSend = null;

  const term = () => window.term;
  const send = d => { if (rawSend) rawSend(d, true); term()?.focus(); };
  const arrow = c => (term()?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
  const CTRL_SYMS = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127 };
  const ctrlOf = d => {
    const c = d.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    return d in CTRL_SYMS ? String.fromCharCode(CTRL_SYMS[d]) : d;
  };

  // Claude Code first (esc interrupts, shift-tab switches mode), then navigation and view.
  const KEYS = [
    ['esc', () => send('\x1b')],
    ['⇧tab', () => send('\x1b[Z')],
    ['↑', () => send(arrow('A'))], ['↓', () => send(arrow('B'))],
    ['←', () => send(arrow('D'))], ['→', () => send(arrow('C'))],
    ['tab', () => send('\t')],
    ['ctrl', null],
    ['^C', () => send('\x03')],
    '|',
    ['paste', async () => { const t = await navigator.clipboard.readText(); term()?.paste(t); term()?.focus(); }],
    '|',
    ['hub', () => { location.href = location.origin + '/'; }, 'nav'],   // back to the picker; sessions keep running
    ['new', newSession, 'nav'],
    '|',
    ['A−', () => setSize(size - 1)], ['A+', () => setSize(size + 1)],
  ];

  // Reconnect via ttyd's ?arg= (see bin/terminal-hub); the old session keeps running.
  function newSession() {
    const name = prompt('New session name (blank = auto):');
    if (name === null) return term()?.focus();
    const n = name.trim().replace(/\s+/g, '-');
    if (n && !/^[A-Za-z0-9_-]{1,32}$/.test(n)) return alert('Use letters, digits, - and _ only.');
    location.search = '?arg=' + encodeURIComponent(n || 'new');
  }

  function setCtrl(on) { ctrl = on; document.getElementById('k-ctrl')?.classList.toggle('on', on); }
  function setSize(s) { size = Math.max(7, Math.min(24, s)); localStorage.setItem(SIZE_KEY, size); sync(); }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'keys';
    for (const k of KEYS) {
      if (k === '|') { bar.appendChild(Object.assign(document.createElement('span'), { className: 'sep' })); continue; }
      const [label, fn, cls] = k;
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      if (label === 'ctrl') { b.id = 'k-ctrl'; b.onclick = () => { setCtrl(!ctrl); term()?.focus(); }; }
      else b.onclick = fn;
      bar.appendChild(b);
    }
    // Keep focus (and the soft keyboard) on the terminal when tapping keys.
    bar.addEventListener('mousedown', e => e.preventDefault());
    document.body.appendChild(bar);
    document.documentElement.style.setProperty('--keys-h', bar.offsetHeight + 'px');
  }

  // Latch Ctrl onto the next character typed on the soft keyboard.
  function patch(t) {
    const cs = t._core.coreService;
    if (cs.__phonePatched) return;
    rawSend = cs.triggerDataEvent.bind(cs);
    cs.triggerDataEvent = (d, user) => {
      if (ctrl && user && d.length === 1) { d = ctrlOf(d); setCtrl(false); }
      return rawSend(d, user);
    };
    cs.__phonePatched = true;
  }

  // With tmux mouse mode on, xterm ignores touch swipes entirely; turn them into
  // wheel events so tmux scrolls its history (copy mode, exits at the bottom).
  const ROWS_PER_TICK = 2;
  function touchScroll(t) {
    const el = t.element;
    if (!el || el.__touchScroll) return;
    el.__touchScroll = true;
    const screen = () => el.querySelector('.xterm-screen');
    let lastY = null, acc = 0, x = 0;
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { lastY = null; return; }
      lastY = e.touches[0].clientY; x = e.touches[0].clientX; acc = 0;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (lastY === null || t.modes.mouseTrackingMode === 'none') return;
      const y = e.touches[0].clientY;
      acc += y - lastY; lastY = y;
      const step = (screen().offsetHeight / t.rows) * ROWS_PER_TICK;
      while (Math.abs(acc) >= step) {
        const older = acc > 0;  // finger moving down → show older output
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

  // ttyd owns the xterm instance and can recreate/reconfigure it; re-assert our settings.
  function sync() {
    const t = term();
    if (!t) return;
    patch(t);
    touchScroll(t);
    let changed = false;
    if (t.options.fontFamily !== FONT) { t.options.fontFamily = FONT; changed = true; }
    if (t.options.fontSize !== size) { t.options.fontSize = size; changed = true; }
    if (t.options.theme?.background !== BG) t.options.theme = { ...t.options.theme, background: BG };
    if (changed) t.fit();
  }

  window.addEventListener('load', () => {
    buildBar();
    document.fonts.load(`${size}px "FiraCode NF"`).finally(() => {
      sync();
      setInterval(sync, 1000);
    });
    window.dispatchEvent(new Event('resize'));
  });
})();

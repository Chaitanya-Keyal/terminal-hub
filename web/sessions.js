// Session switching for the terminal hub: a session panel (a sidebar on wide screens, a sheet
// on phones), "last" to jump back, and switching without reloading the page.
//
// The picker (bin/terminal-hub) keeps running under each session and reports what it's doing
// with private OSC 7766 sequences. To switch, the page leaves the current session (its tmux
// prefix, then d) or closes the list (esc); the picker then says "ready", and the page answers
// with the session to open. The panel's list comes from /assets/sessions.json.
(() => {
  const OSC = 7766;
  const POLL_MS = 10000;
  const PENDING_MS = 5000;  // give up on a switch if the picker doesn't get ready by then
  const WIDE = matchMedia('(min-width: 900px)');
  const SIDE_KEY = 'hub.sidebar';
  const RECENT_KEY = 'hub.recent';
  const TITLE = document.title;

  let atList = !new URLSearchParams(location.search).get('arg');  // else a session is open
  let current = null;   // "KEY:NAME" of the open session
  let recent = JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]');  // most recent first
  let prefix = '\x02';  // the open place's tmux prefix: ctrl-b until it says otherwise
  let pending = null, pendingAt = 0;
  let places = null;    // from sessions.json
  let sheet = false;    // narrow screens: the panel is open
  let side = localStorage.getItem(SIDE_KEY) !== 'off';
  let timer = 0;

  const term = () => window.term;
  // Not marked as user input, so the key bar's sticky ctrl leaves it alone.
  const send = d => term()?._core.coreService.triggerDataEvent(d, false);
  const keyOf = t => t.slice(0, t.indexOf(':'));
  const nameOf = t => t.slice(t.indexOf(':') + 1);
  const all = () => (places || []).flatMap(p => p.sessions.map(s => `${p.key}:${s.name}`));
  const exists = t => !places || all().includes(t);
  const lastTarget = () => recent.find(t => t !== current && exists(t));

  // tmux key names to bytes: C-b, C-a, C-Space, M-a, or a plain character.
  function keyBytes(k) {
    if (k === 'C-Space') return '\x00';
    let m = /^C-([a-z])$/i.exec(k);
    if (m) return String.fromCharCode(m[1].toLowerCase().charCodeAt(0) - 96);
    m = /^M-(.)$/.exec(k);
    if (m) return '\x1b' + m[1];
    return k.length === 1 ? k : null;
  }

  function onEvent(data) {
    const i = data.indexOf(';');
    const ev = i < 0 ? data : data.slice(0, i), val = i < 0 ? '' : data.slice(i + 1);
    if (ev === 'list') {
      atList = true;
      setCurrent(null);
    } else if (ev === 'open') {
      atList = false;
      prefix = '\x02';
      setCurrent(val);
    } else if (ev === 'prefix') {
      prefix = keyBytes(val) || '\x02';
    } else if (ev === 'ready') {
      send((pending && Date.now() - pendingAt < PENDING_MS ? pending : '') + '\r');
      pending = null;
    }
    render();
    if (ev === 'list' || ev === 'open') load();
    return true;
  }

  function setCurrent(t) {
    current = t;
    if (t) {
      recent = [t, ...recent.filter(x => x !== t)].slice(0, 20);
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    }
    // Keep the address on the open session, so a reload or a bookmark comes back to it.
    const url = new URL(location.href);
    if (t) url.searchParams.set('arg', t); else url.searchParams.delete('arg');
    history.replaceState(history.state, '', url);
    document.title = t ? `${nameOf(t)} · ${TITLE}` : TITLE;
  }

  function switchTo(target) {
    closeSheet();
    term()?.focus();
    if (pending && Date.now() - pendingAt < PENDING_MS) { pending = target; return; }  // still switching
    if (target === current) return;
    pending = target;
    pendingAt = Date.now();
    send(atList ? '\x1b' : prefix + 'd');
  }

  function toList() {
    closeSheet();
    term()?.focus();
    pending = null;
    if (!atList) send(prefix + 'd');
  }

  function newSession() {
    closeSheet();
    const name = prompt('New session name (blank = auto):');
    if (name === null) return term()?.focus();
    const n = name.trim().replace(/\s+/g, '-');
    if (n && !/^[A-Za-z0-9_-]{1,32}$/.test(n)) return alert('Use letters, digits, - and _ only.');
    const key = current ? keyOf(current) : places?.[0]?.key;
    switchTo(key ? `${key}:${n || 'new'}` : n || 'new');
  }

  function last() {
    const t = lastTarget();
    if (t) switchTo(t); else term()?.focus();
  }

  // Wide screens: show or hide the sidebar. Narrow: open or close the sheet.
  function toggle() {
    if (WIDE.matches) {
      side = !side;
      localStorage.setItem(SIDE_KEY, side ? 'on' : 'off');
      layout();
    } else {
      sheet = !sheet;
      render();
    }
    if (side || sheet) refresh();
    if (!sheet) term()?.focus();
  }
  function closeSheet() { if (sheet) { sheet = false; render(); } }

  // The panel.
  const panel = Object.assign(document.createElement('nav'), { id: 'hub-panel' });
  const scrim = Object.assign(document.createElement('div'), { id: 'hub-scrim', onclick: () => { closeSheet(); term()?.focus(); } });
  panel.addEventListener('mousedown', e => { if (!WIDE.matches) e.preventDefault(); });  // keep the phone keyboard up
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  function button(cls, text, fn) {
    const b = el('button', cls, text);
    b.onclick = fn;
    return b;
  }

  function render() {
    const top = el('div', 'hp-top');
    top.append(el('span', '', 'sessions'), button('hp-list', 'list', toList));
    const parts = [top];
    if (!places) parts.push(el('div', 'hp-label', 'loading…'));
    for (const p of places || []) {
      const sec = el('section', 'hp-place');
      sec.style.setProperty('--c', p.colour);
      const label = el('div', 'hp-label', p.label);
      if (p.state !== 'ok') {
        label.append(el('span', 'hp-note', p.state === 'locked' ? 'locked · unlock in the list' : 'unreachable'));
        label.onclick = p.state === 'locked' ? toList : () => refresh();
        label.classList.add('hp-click');
      }
      sec.append(label);
      for (const s of p.sessions) {
        const t = `${p.key}:${s.name}`;
        const row = button('hp-row' + (t === current ? ' now' : ''), '', () => switchTo(t));
        row.append(el('span', 'hp-name', s.name));
        if (s.windows > 1) row.append(el('span', 'hp-meta', `${s.windows} win`));
        sec.append(row);
      }
      if (p.state === 'ok') sec.append(button('hp-row hp-new', '+ new', () => switchTo(`${p.key}:new`)));
      parts.push(sec);
    }
    panel.replaceChildren(...parts);
    document.body.classList.toggle('hub-sheet', !WIDE.matches && sheet);
    document.querySelector('#keys [data-key="last"]')?.classList.toggle('off', !lastTarget());
  }

  function layout() {
    document.body.classList.toggle('hub-side', WIDE.matches && side);
    render();
    window.dispatchEvent(new Event('resize'));  // ttyd refits the terminal
  }

  async function load() {
    try {
      const r = await fetch('/assets/sessions.json', { cache: 'no-store' });
      if (r.ok) places = (await r.json()).places;
    } catch {}
    render();
  }
  // Refresh the list now (or after DELAY), then every POLL_MS while the panel is on screen.
  function refresh(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!document.hidden && (WIDE.matches ? side : sheet)) await load();
      refresh(POLL_MS);
    }, delay);
  }

  // Wide screens: alt+↑ / alt+↓ go to the previous / next session in the panel.
  addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Arrow(Up|Down)$/.test(e.key)) return;
    const list = all();
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    const from = list.indexOf(pending || current), down = e.key === 'ArrowDown';
    const i = from < 0 ? (down ? 0 : list.length - 1) : (from + (down ? 1 : list.length - 1)) % list.length;
    switchTo(list[i]);
  }, true);

  // ttyd creates (and may recreate) the terminal; hook its OSC parser as soon as it exists.
  setInterval(() => {
    const t = term();
    if (t && !t.__hubOsc) {
      t.__hubOsc = true;
      t.parser.registerOscHandler(OSC, onEvent);
    }
  }, 50);

  window.hub = { toggle, last, newSession };
  window.addEventListener('load', () => {
    document.body.append(scrim, panel);
    WIDE.addEventListener('change', layout);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    layout();
    load();
    refresh(POLL_MS);
  });
})();

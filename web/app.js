// The terminal hub page. Wide screens: a session list on the left and up to four terminals side
// by side. Phones: a home screen with the list, then one terminal with a top bar and key bar.
// Every terminal is its own connection to ttyd (term.js); the last few hidden ones stay
// connected, so switching back is instant. The list comes from /assets/sessions.json.
import { icon } from './icons.js';
import { TermView, MAC } from './term.js';
import { keyBar } from './keys.js';

const WIDE = matchMedia('(min-width: 900px)');
const TOUCH = matchMedia('(pointer: coarse)');
const POLL_MS = 5000;
const MAX_PANES = 4;
const KEEP_HIDDEN = { wide: 4, narrow: 1 };  // hidden terminals that stay connected
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const APP = document.title;
const STATUS = { working: 'Working', waiting: 'Needs you', done: 'Done' };

/** @typedef {{name: string, windows: number, attached: number, status: '' | 'working' | 'waiting' | 'done', statusAt: number, prefix?: string, starting?: boolean}} Session */
/** @typedef {{key: string, label: string, colour: string, state: 'ok' | 'locked' | 'unreachable', sessions: Session[]}} Place */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('hub.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('hub.' + key, JSON.stringify(value)); } catch {} },
};

const S = {
  places: /** @type {Place[] | null} */ (null),
  /** @type {string[]} targets ("KEY:NAME") in the panes, on wide screens */
  panes: store.get('panes', []).filter(t => typeof t === 'string' && t.includes(':')).slice(0, MAX_PANES),
  focus: store.get('focus', 0),
  current: /** @type {string | null} */ (null),  // phones: the open session, or null for the home screen
  sidebar: store.get('sidebar', true),
  fontSize: store.get('fontSize', 15),
  /** @type {string[]} most recent first */
  recent: store.get('recent', []),
  /** @type {Record<string, number>} target → when you last had it on screen (for "done" dots) */
  seen: store.get('seen', {}),
  creating: /** @type {string | null} */ (null),  // place key whose new-session field is open
  filter: '',
  ctrl: false,
  ready: false,                 // the first list has arrived
  /** @type {Set<string>} targets you opened yourself: safe to connect before the list */
  trusted: new Set(),
};
/** @type {Map<string, TermView>} the live terminals */
const views = new Map();
/** @type {HTMLFormElement | null} */ let createEl = null;
/** @type {{close(): void} | null} */ let modal = null;
/** @type {HTMLElement | null} */ let sheet = null, help = null;
/** @type {string | null} */ let pendingArg = null;

const wide = () => WIDE.matches;
const keyOf = t => t.slice(0, t.indexOf(':'));
const nameOf = t => t.slice(t.indexOf(':') + 1);
const placeOf = t => S.places?.find(p => p.key === keyOf(t));
const sessionOf = t => placeOf(t)?.sessions.find(s => s.name === nameOf(t));
const exists = t => !!sessionOf(t);
// The hub only attaches to names it can pass safely through every shell on the way; tmux allows
// others (spaces, say), and those sessions are listed but not opened.
const openable = t => NAME_RE.test(nameOf(t));
const visible = () => (wide() ? S.panes : S.current ? [S.current] : []);
const focused = () => (wide() ? S.panes[S.focus] ?? null : S.current);
const focusedView = () => { const f = focused(); return f ? views.get(f) : undefined; };
const allTargets = () => (S.places ?? []).flatMap(p => p.sessions.map(s => `${p.key}:${s.name}`)).filter(openable);
const lastTarget = () => S.recent.find(t => t !== focused() && exists(t));
const colourOf = t => placeOf(t)?.colour ?? 'var(--muted)';
const labelOf = t => placeOf(t)?.label ?? keyOf(t);
const now = () => Math.floor(Date.now() / 1000);

// h('div', {class, onclick, …}, ...children): a tiny element builder.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.includes('-') || !(k in el)) el.setAttribute(k, v);
    else el[k] = v;
  }
  el.append(...kids.flat(Infinity).filter(c => c != null && c !== false && c !== ''));
  return el;
}
const iconBtn = (name, title, onclick, cls = '') =>
  h('button', { type: 'button', class: `icon-btn ${cls}`, title, 'aria-label': title, onclick }, icon(name));
const kbd = (...k) => h('kbd', {}, ...k);
const brand = () => h('div', { class: 'brand' }, icon('square-terminal'), h('span', {}, APP));

// ---- skeleton ----------------------------------------------------------------------------
const ui = {
  side: h('aside', { id: 'sidebar' }), rail: h('aside', { id: 'rail' }),
  top: h('header', { id: 'topbar' }), home: h('section', { id: 'home' }),
  empty: h('section', { id: 'empty' }), panes: h('div', { id: 'panes' }),
  keys: h('nav', { id: 'keybar', 'aria-label': 'Keys' }), park: h('div', { id: 'parking' }),
  toast: h('div', { id: 'toast', role: 'status' }),
  sideList: h('div', { class: 'list', role: 'list' }), homeList: h('div', { class: 'list', role: 'list' }),
  cont: h('div', { class: 'cont-slot' }),
};
ui.main = h('main', { id: 'main' }, ui.top, ui.home, ui.empty, ui.panes, ui.keys);
document.body.append(h('div', { id: 'app' }, ui.side, ui.rail, ui.main, ui.park), ui.toast);

function searchBox() {
  const input = h('input', {
    type: 'search', placeholder: 'Filter sessions', autocomplete: 'off', spellcheck: false,
    'aria-label': 'Filter sessions', enterKeyHint: 'go',
    oninput: () => { S.filter = input.value; renderLists(); },
    onkeydown: e => {
      if (e.key === 'Escape') { input.value = S.filter = ''; renderLists(); input.blur(); focusTerm(); }
      if (e.key === 'Enter') {
        const first = ui.main.ownerDocument.querySelector(`#${wide() ? 'sidebar' : 'home'} .row-main`);
        first?.click();
      }
    },
  });
  return { el: h('label', { class: 'search' }, icon('search'), input), input };
}
const sideSearch = searchBox(), homeSearch = searchBox();

ui.side.append(
  h('div', { class: 'side-head' }, brand(), iconBtn('panel-left', 'Hide the list', () => setSidebar(false))),
  sideSearch.el, ui.sideList,
  h('div', { class: 'side-foot' },
    iconBtn('a-arrow-down', 'Smaller text', () => setFont(S.fontSize - 1)),
    iconBtn('a-arrow-up', 'Larger text', () => setFont(S.fontSize + 1)),
    h('span', { class: 'grow' }),
    iconBtn('keyboard', 'Keyboard shortcuts', toggleHelp, 'help-toggle')),
);
ui.rail.append(iconBtn('panel-left', 'Show the list', () => setSidebar(true)));
ui.home.append(
  h('div', { class: 'home-head' }, brand(), iconBtn('settings', 'Settings', openSettings)),
  homeSearch.el, ui.cont, ui.homeList,
);

const bar = keyBar(ui.keys, {
  view: focusedView,
  ctrl: { get: () => S.ctrl, set: on => { S.ctrl = on; bar.setCtrl(on); } },
});

// ---- the session list ----------------------------------------------------------------------
function placeItems() {
  if (!S.places) return [h('div', { class: 'note' }, 'Loading…')];
  if (!S.places.length) return [h('div', { class: 'note' }, 'No places in the config.')];
  const q = S.filter.trim().toLowerCase();
  const out = [];
  for (const p of S.places) {
    const placeHit = !q || p.label.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);
    const sessions = placeHit ? p.sessions : p.sessions.filter(s => s.name.toLowerCase().includes(q));
    if (!placeHit && !sessions.length) continue;
    out.push(h('section', { class: 'place', style: `--c:${p.colour}` },
      placeHead(p),
      S.creating === p.key && createEl,
      sessions.map(s => sessionRow(p, s)),
      p.state === 'ok' && !p.sessions.length && S.creating !== p.key && h('div', { class: 'note small' }, 'No sessions')));
  }
  if (!out.length) out.push(h('div', { class: 'note' }, `Nothing matches “${S.filter.trim()}”`));
  return out;
}

function placeHead(p) {
  const tail =
    p.state === 'locked' ? h('button', { type: 'button', class: 'chip', onclick: () => unlock(p) }, icon('lock'), 'Unlock')
    : p.state === 'unreachable' ? h('button', { type: 'button', class: 'chip quiet', title: 'Try again', onclick: () => load(true) }, icon('rotate-cw'), 'Unreachable')
    : iconBtn('plus', `New session on ${p.label}`, () => startCreate(p.key), 'add');
  return h('div', { class: 'place-head' }, h('span', { class: 'dot' }), h('span', { class: 'place-name' }, p.label), tail);
}

function statusOf(t, s) {
  if (s.status === 'done') return s.statusAt > (S.seen[t] ?? 0) && !visible().includes(t) ? 'done' : '';
  return s.status;
}

function sessionRow(p, s) {
  const t = `${p.key}:${s.name}`;
  const st = statusOf(t, s);
  const open = visible().includes(t);
  const ok = openable(t);
  const main = h('button', {
    type: 'button', class: 'row-main',
    title: !ok ? 'Rename this session to open it here' : s.starting ? 'Starting…' : st ? STATUS[st] : null,
    onclick: e => (wide() && (e.shiftKey || e.metaKey || e.ctrlKey) ? openBeside(t) : openSession(t)),
  },
  s.starting ? h('span', { class: 'st st-starting', 'aria-label': 'Starting' }, icon('loader-circle'))
    : h('span', { class: `st${st ? ' st-' + st : ''}`, 'aria-label': st ? STATUS[st] : null }),
  h('span', { class: 'row-name' }, s.name),
  !wide() && open ? h('span', { class: 'row-meta' }, 'open')
    : s.windows > 1 && h('span', { class: 'row-meta' }, `${s.windows} windows`));
  return h('div', { class: `row${open ? ' open' : ''}${t === focused() ? ' focused' : ''}${ok ? '' : ' off'}`, role: 'listitem' },
    main, wide() && ok && iconBtn('columns-2', 'Open beside', () => openBeside(t), 'row-split'));
}

function suggest(p) {
  const taken = new Set(p.sessions.map(s => s.name));
  let name = 'shell', i = 2;
  while (taken.has(name)) name = `shell-${i++}`;
  return name;
}

function startCreate(key) {
  const p = S.places?.find(x => x.key === key);
  if (!p) return;
  if (wide() && !S.sidebar) setSidebar(true);
  S.creating = key;
  const fallback = suggest(p);
  const input = h('input', {
    class: 'create-input', placeholder: `name (blank: ${fallback})`, maxLength: 32, autocomplete: 'off',
    autocapitalize: 'off', spellcheck: false, enterKeyHint: 'go', 'aria-label': `Name for the new session on ${p.label}`,
    onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); cancelCreate(); } },
    oninput: () => { err.textContent = ''; },
  });
  const err = h('div', { class: 'create-error', role: 'alert' });
  createEl = h('form', {
    class: 'create',
    onsubmit: e => {
      e.preventDefault();
      const name = input.value.trim().replace(/\s+/g, '-') || fallback;
      if (!NAME_RE.test(name)) { err.textContent = 'Use letters, digits, - and _ (up to 32).'; input.focus(); return; }
      openSession(`${p.key}:${name}`);
      setTimeout(load, 700);  // the new session shows up in the list
    },
  }, h('div', { class: 'create-row' }, input,
    h('button', { type: 'submit', class: 'btn primary' }, 'Create'),
    iconBtn('x', 'Cancel', cancelCreate)), err);
  renderLists();
  input.focus();
}

function cancelCreate() {
  S.creating = createEl = null;
  renderLists();
  focusTerm();
}

function continueCard(t) {
  return h('button', { type: 'button', class: 'continue', onclick: () => openSession(t) },
    icon('history'),
    h('span', { class: 'continue-text' }, h('small', {}, 'Continue'), h('b', {}, nameOf(t)), h('span', { class: 'continue-place' }, labelOf(t))));
}

// Rebuild the visible list, keeping focus (and the cursor) in the new-session field.
function renderLists() {
  const list = wide() ? ui.sideList : ui.homeList;
  const active = /** @type {HTMLInputElement | null} */ (document.activeElement);
  const keep = active && list.contains(active) ? { el: active, from: active.selectionStart, to: active.selectionEnd } : null;
  list.replaceChildren(...placeItems());
  if (keep?.el.isConnected) { keep.el.focus(); try { keep.el.setSelectionRange(keep.from, keep.to); } catch {} }
  const t = S.recent.find(x => exists(x) && x !== focused());
  ui.cont.replaceChildren(...(!wide() && t && !S.filter ? [continueCard(t)] : []));
  for (const s of [sideSearch, homeSearch]) if (document.activeElement !== s.input) s.input.value = S.filter;
}

// ---- opening and closing -----------------------------------------------------------------
function openSession(t) {
  if (!t) return;
  if (!openable(t)) return cantOpen(t);
  S.creating = createEl = null;
  S.trusted.add(t);
  markStarting(t);
  if (wide()) {
    const i = S.panes.indexOf(t);
    if (i >= 0) S.focus = i;
    else if (!S.panes.length) { S.panes = [t]; S.focus = 0; }
    else S.panes[S.focus] = t;
  } else {
    const fromHome = !S.current;
    S.current = t;
    history[fromHome ? 'pushState' : 'replaceState']({ hub: 'session', target: t }, '', urlFor(t));
  }
  remember(t);
  render();
  focusTerm();
}

function openBeside(t) {
  if (!openable(t)) return cantOpen(t);
  S.trusted.add(t);
  markStarting(t);
  const i = S.panes.indexOf(t);
  if (i >= 0) S.focus = i;
  else if (S.panes.length < MAX_PANES) { S.panes.push(t); S.focus = S.panes.length - 1; }
  else S.panes[S.focus] = t;
  remember(t);
  render();
  focusTerm();
}

function cantOpen(t) {
  toast(`To open “${nameOf(t)}” here, rename it to letters, digits, - and _ (up to 32)`, 4500);
}

function closePane(i) {
  const [t] = S.panes.splice(i, 1);
  S.focus = Math.max(0, Math.min(S.focus, S.panes.length - 1));
  render();
  focusTerm();
  return t;
}

// The session is gone (it ended) or you closed it: take it off the screen.
function closeTarget(t) {
  if (wide()) { const i = S.panes.indexOf(t); if (i >= 0) closePane(i); }
  else if (S.current === t) goHome();
  views.get(t)?.dispose();
  views.delete(t);
  render();
}

function goHome() {
  if (history.state?.hub === 'session') history.back();  // popstate shows the list
  else { S.current = null; history.replaceState({ hub: 'home' }, '', urlFor(null)); render(); }
}

function last() { const t = lastTarget(); if (t) openSession(t); }

function remember(t) {
  S.recent = [t, ...S.recent.filter(x => x !== t)].slice(0, 20);
  store.set('recent', S.recent);
  markSeen(t);
}
function markSeen(t) { S.seen[t] = now(); store.set('seen', S.seen); }

function urlFor(t) {
  const u = new URL(location.href);
  u.search = t ? `?arg=${t}` : '';
  return u;
}

function focusTerm() {
  if (TOUCH.matches) return;  // don't pop a phone keyboard up uninvited
  requestAnimationFrame(() => focusedView()?.focus());
}

// ---- terminals and panes -----------------------------------------------------------------
function viewFor(t) {
  let v = views.get(t);
  if (!v) {
    // Only a session you opened yourself may be created; reconnecting never recreates one.
    v = new TermView(S.trusted.has(t) ? [t] : ['--existing', t], {
      fontSize: S.fontSize, renderer: store.get('renderer', 'webgl'),
      ctrl: () => S.ctrl, ctrlUsed: () => { S.ctrl = false; bar.setCtrl(false); },
      copied: () => toast('Copied'),
      status: view => {
        if (view.status !== 'ended') return;
        toast(`${nameOf(t)} ended`);
        const p = placeOf(t);
        if (p) p.sessions = p.sessions.filter(s => s.name !== nameOf(t));
        starting.delete(t);
        setTimeout(() => closeTarget(t));
        load(true);
      },
      attached: () => load(true),
      actions: view => view.status === 'detached'
        ? [['Reattach', () => view.connect(), true], ['Close', () => closeTarget(t)]] : null,
    }, ['--existing', t]);
    views.set(t, v);
  }
  v.lastUsed = Date.now();
  return v;
}

// A slot is one place in the grid. Its header is built once and updated in place: a click on a
// pane that isn't focused focuses it first (a render), and must still reach the button it began on.
/** @type {{el: HTMLElement, body: HTMLElement, name: HTMLElement, place: HTMLElement, close: HTMLElement, target: string}[]} */
const slots = [];
function slot(i) {
  if (!slots[i]) {
    const name = h('span', { class: 'pane-name' }), place = h('span', { class: 'pane-place' });
    const close = iconBtn('x', 'Close', () => closePane(S.panes.indexOf(slots[i].target)));
    const head = h('div', { class: 'pane-head' }, h('span', { class: 'dot' }), name, place, h('span', { class: 'grow' }), close);
    const body = h('div', { class: 'pane-body' });
    const el = h('div', { class: 'pane' }, head, body);
    el.addEventListener('pointerdown', () => {
      if (wide() && i !== S.focus && i < S.panes.length) { S.focus = i; render(); }
    }, true);
    slots[i] = { el, body, name, place, close, target: '' };
  }
  return slots[i];
}

function renderPanes() {
  const vis = visible();
  const want = vis.map((_, i) => slot(i).el);
  if (want.length !== ui.panes.children.length || want.some((el, i) => ui.panes.children[i] !== el)) ui.panes.replaceChildren(...want);
  vis.forEach((t, i) => {
    const s = slot(i);
    s.el.style.setProperty('--c', colourOf(t));
    s.el.classList.toggle('focused', !wide() || i === S.focus);
    s.target = t;
    s.name.textContent = nameOf(t);
    s.place.textContent = labelOf(t);
    s.close.title = `Close ${nameOf(t)}`;
    s.close.setAttribute('aria-label', s.close.title);
    if (S.ready || S.trusted.has(t)) viewFor(t).mount(s.body);
    else if (!s.body.querySelector('.term')) s.body.replaceChildren(h('div', { class: 'pane-wait' }, icon('loader-circle')));
  });
  for (const [t, v] of views) if (!vis.includes(t) && v.el.parentNode !== ui.park) ui.park.append(v.el);
  for (const s of slots.slice(vis.length)) s.body.querySelector('.pane-wait')?.remove();
}

function prune() {
  const vis = new Set(visible());
  const hidden = [...views].filter(([t]) => !vis.has(t)).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  for (const [t, v] of hidden.slice(KEEP_HIDDEN[wide() ? 'wide' : 'narrow'])) { v.dispose(); views.delete(t); }
}

function renderTop() {
  const t = S.current;
  if (wide() || !t) return ui.top.replaceChildren();
  const lt = lastTarget();
  ui.top.style.setProperty('--c', colourOf(t));
  ui.top.replaceChildren(
    iconBtn('chevron-left', 'All sessions', goHome, 'back'),
    h('div', { class: 'top-title' }, h('span', { class: 'dot' }), h('b', {}, nameOf(t)), h('small', {}, labelOf(t))),
    ...(lt ? [h('button', { type: 'button', class: 'last-btn', title: `Switch to ${nameOf(lt)}`, onclick: last },
      icon('arrow-left-right'), h('span', {}, nameOf(lt)))] : []));
}

function renderEmpty() {
  if (!wide() || S.panes.length) return ui.empty.replaceChildren();
  const t = S.recent.find(exists);
  ui.empty.replaceChildren(h('div', { class: 'empty-box' },
    h('div', { class: 'empty-icon' }, icon('square-terminal')),
    h('h2', {}, 'No session open'),
    t && continueCard(t),
    h('p', {}, 'Pick one on the left, or press', kbd('Alt'), h('kbd', { 'aria-label': 'Down arrow' }, icon('arrow-down')))));
}

function render() {
  const w = wide();
  const vis = visible();
  document.body.className = [
    w ? 'wide' : 'narrow', TOUCH.matches && 'touch', w && !S.sidebar && 'side-hidden',
    vis.length ? 'in-session' : 'no-session', `panes-${vis.length || 0}`,
  ].filter(Boolean).join(' ');
  renderPanes();
  renderTop();
  renderLists();
  renderEmpty();
  for (const t of vis) if (S.seen[t] < now() - 2 || !S.seen[t]) markSeen(t);
  const f0 = focused();
  if (f0 && S.recent[0] !== f0) remember(f0);  // "last" follows what's actually on screen
  const waiting = (S.places ?? []).flatMap(p => p.sessions).filter(s => s.status === 'waiting').length;
  const f = focused();
  document.title = `${waiting ? `(${waiting}) ` : ''}${f ? `${nameOf(f)} · ` : ''}${APP}`;
  if (navigator.setAppBadge) (waiting ? navigator.setAppBadge(waiting) : navigator.clearAppBadge()).catch(() => {});
  if (w) {
    store.set('panes', S.panes);
    store.set('focus', S.focus);
    if (S.ready) history.replaceState(history.state, '', urlFor(f));
  }
  prune();
}

// ---- the list from the server --------------------------------------------------------------
// load(true) asks the server to list again rather than share its last list (up to 2 s old), for
// when you just did something: a fresh request made while another is on the way follows it.
let loading = null, again = false;
function load(fresh = false) {
  if (loading) { again ||= fresh; return loading; }
  return (loading = (async () => {
    try {
      const r = await fetch(`/assets/sessions.json${fresh || !S.ready ? '?fresh' : ''}`, { cache: 'no-store' });
      if (r.ok) S.places = withStarting((await r.json()).places);
    } catch { /* keep the last list */ }
    loading = null;
    if (!S.ready && S.places) firstList();
    render();
    if (again) { again = false; load(true); }
  })());
}

// Sessions you just created show up at once, with a spinner, until the list has them: the place
// takes a moment (an ssh hop) to create one. After 20 s without it, creating must have failed.
const starting = new Map();  // target → when
function markStarting(t) {
  if (!S.ready || exists(t) || placeOf(t)?.state !== 'ok') return;
  starting.set(t, Date.now());
  S.places = withStarting(S.places);
}
/** @param {Place[] | null} places */
function withStarting(places) {
  for (const [t, at] of starting) {
    const p = places?.find(x => x.key === keyOf(t)), name = nameOf(t);
    const listed = p?.sessions.find(s => s.name === name);
    if (!p || p.state !== 'ok' || (listed && !listed.starting) || Date.now() - at > 20000) { starting.delete(t); continue; }
    if (!listed) {
      const i = p.sessions.findIndex(s => s.name > name);  // tmux lists sessions by name
      p.sessions.splice(i < 0 ? p.sessions.length : i, 0, { name, windows: 1, attached: 1, status: '', statusAt: 0, starting: true });
    }
  }
  return places;
}

// After the first list: drop restored panes whose sessions are gone (connecting to them would
// recreate them as empty shells), and open what the address asked for.
function firstList() {
  S.ready = true;
  for (const t of S.trusted) markStarting(t);  // a link that creates a session
  const keep = t => S.trusted.has(t) || exists(t) || placeOf(t)?.state !== 'ok';
  S.panes = S.panes.filter(keep);
  S.focus = Math.max(0, Math.min(S.focus, S.panes.length - 1));
  if (S.current && !keep(S.current)) {
    toast(`${nameOf(S.current)} has ended`);
    S.current = null;
    history.replaceState({ hub: 'home' }, '', urlFor(null));
  }
  if (pendingArg) {
    const a = pendingArg;
    pendingArg = null;
    const p = a.includes(':') ? S.places?.find(x => x.key === keyOf(a)) : S.places?.[0];
    const name = a.includes(':') ? nameOf(a) : a;
    if (p) openSession(`${p.key}:${name === 'new' ? suggest(p) : name}`);
  }
}

// ---- settings, help, unlock, toast ---------------------------------------------------------
function setFont(px) {
  S.fontSize = Math.max(10, Math.min(24, px));
  store.set('fontSize', S.fontSize);
  for (const v of views.values()) v.setFontSize(S.fontSize);
  toast(`Text size ${S.fontSize}`);
}

function setSidebar(on) {
  S.sidebar = on;
  store.set('sidebar', on);
  closeHelp();
  render();
}

// A tmux key name (C-b, M-a, C-Space) as the keys to press.
const tmuxKeys = name => {
  const parts = name.split('-');
  const key = parts.pop() || '-';
  return [...parts.map(m => ({ C: 'Ctrl', M: 'Alt', S: 'Shift' })[m] ?? m), key];
};

function toggleHelp() {
  if (help) return closeHelp();
  const line = (what, ...keys) => h('div', { class: 'help-line' }, h('span', {}, what), h('span', { class: 'help-keys' }, ...keys));
  const arrow = (dir, label) => h('kbd', { 'aria-label': label }, icon(`arrow-${dir}`));
  const plus = what => h('span', { class: 'muted' }, what);
  const prefix = sessionOf(focused() ?? '')?.prefix || S.places?.flatMap(p => p.sessions).find(s => s.prefix)?.prefix || 'C-b';
  const box = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('b', {}, 'Shortcuts'),
    line('Switch session', kbd('Alt'), arrow('up', 'Up arrow'), arrow('down', 'Down arrow')),
    line('Last session', kbd('Alt'), kbd('`')),
    line('Open in a new pane', kbd('Shift'), plus('+ click')),
    // tmux's mouse mode takes plain drags and right-clicks; this key gives them to the page.
    line('Select text to copy', kbd(MAC ? '⌥' : 'Shift'), plus('+ drag')),
    line('Browser menu', kbd(MAC ? '⌥' : 'Shift'), plus('+ right-click')),
    h('b', { class: 'help-head' }, 'tmux'),
    h('div', { class: 'help-sub' }, 'Press', ...tmuxKeys(prefix).map(k => kbd(k)), 'then:'),
    line('Detach', kbd('d')),
    line('New window', kbd('c')),
    line('Next, previous window', kbd('n'), kbd('p')),
    line('Window by number', kbd('0'), plus('…'), kbd('9')),
    line('Split side by side', kbd('%')),
    line('Split stacked', kbd('"')),
    line('Switch pane', arrow('left', 'Left arrow'), arrow('right', 'Right arrow'), arrow('up', 'Up arrow'), arrow('down', 'Down arrow')),
    line('Zoom a pane in or out', kbd('z')),
    line('Close a pane', kbd('x')),
    line('Scroll back (q stops)', kbd('[')),
    line('Rename window', kbd(',')),
    line('Rename session', kbd('$')),
    line('Every tmux key', kbd('?')),
    h('div', { class: 'help-note' }, 'With mouse mode on, you can also click a pane, scroll, drag pane borders, and right-click for a menu.'));
  help = box;
  ui.side.append(box);
  // A press anywhere else closes it (the click that opened it is over by now). The button is left
  // to toggle it: closing here would let its click open it again.
  document.addEventListener('pointerdown', function off(e) {
    const t = /** @type {Element} */ (e.target);
    if (help && !help.contains(t) && !t.closest?.('.help-toggle')) closeHelp();
    if (!help) document.removeEventListener('pointerdown', off, true);
  }, true);
}

function closeHelp() { help?.remove(); help = null; }

function openSettings() {
  const value = h('span', { class: 'value' }, String(S.fontSize));
  const step = d => { setFont(S.fontSize + d); value.textContent = S.fontSize; };
  const close = () => { sheet?.remove(); sheet = null; };
  const wrap = h('div', { class: 'sheet-wrap', onclick: e => { if (e.target === wrap) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'setting' }, h('span', {}, 'Text size'),
        h('div', { class: 'stepper' }, iconBtn('a-arrow-down', 'Smaller text', () => step(-1)), value,
          iconBtn('a-arrow-up', 'Larger text', () => step(1))))));
  sheet = wrap;
  document.body.append(wrap);
}

function unlock(p) {
  modal?.close();
  const body = h('div', { class: 'modal-body' });
  const view = new TermView(['--unlock', p.key], {
    fontSize: S.fontSize, renderer: store.get('renderer', 'webgl'),
    ctrl: () => false, ctrlUsed() {}, copied() {},
    status: v => { if (v.status === 'unlocked') { close(); toast(`${p.label} unlocked`); load(true); } },
    actions: v => (v.status === 'failed' ? [['Try again', () => v.connect(), true], ['Close', () => close()]] : null),
  });
  const el = h('div', { class: 'modal', onclick: e => { if (e.target === el) close(); } },
    h('div', { class: 'modal-box', role: 'dialog', 'aria-label': `Unlock ${p.label}` },
      h('div', { class: 'modal-head' }, icon('lock'), h('span', {}, `Unlock ${p.label}`), h('span', { class: 'grow' }),
        iconBtn('x', 'Close', () => close())),
      body));
  const close = () => { view.dispose(); el.remove(); modal = null; };
  modal = { close };
  document.body.append(el);
  view.mount(body);
  view.focus();
}

let toastTimer;
function toast(text, ms = 1800) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

// ---- keyboard, history, layout changes ---------------------------------------------------
addEventListener('keydown', e => {
  if (e.key === 'Escape' && help) { e.preventDefault(); e.stopPropagation(); return closeHelp(); }
  if (!wide() || !e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const list = allTargets();
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    const f = focused(), i = f ? list.indexOf(f) : -1, d = e.key === 'ArrowDown' ? 1 : -1;
    openSession(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length]);
  } else if (e.code === 'Backquote') {
    e.preventDefault();
    e.stopPropagation();
    last();
  }
}, true);

addEventListener('popstate', e => {
  if (wide()) return;
  S.current = e.state?.hub === 'session' ? e.state.target : null;
  render();
});

WIDE.addEventListener('change', () => {
  if (wide() && S.current && !S.panes.includes(S.current)) { S.panes = [S.current, ...S.panes].slice(0, MAX_PANES); S.focus = 0; }
  if (!wide()) {
    S.current = S.panes[S.focus] ?? null;
    history.replaceState({ hub: 'home' }, '', urlFor(null));
    if (S.current) history.pushState({ hub: 'session', target: S.current }, '', urlFor(S.current));
  }
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  load(true);
  for (const v of views.values()) v.reconnectNow();
});

// Phones: size the app to the visible area, so the key bar sits right above the keyboard.
const vv = window.visualViewport;
if (vv) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
  vv.addEventListener('resize', fit);
  fit();
}

// ---- start -----------------------------------------------------------------------------------
{
  const arg = new URLSearchParams(location.search).get('arg');
  if (arg && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]{1,32}$/.test(arg) && !arg.endsWith(':new')) {
    // A link to a session never opened here opens it at once (creating it if needed). A known one
    // (a reload, a session you had open) waits for the list, so a session that ended meanwhile
    // isn't recreated as an empty shell.
    if (!S.recent.includes(arg) && !S.panes.includes(arg)) S.trusted.add(arg);
    if (wide()) { const i = S.panes.indexOf(arg); if (i >= 0) S.focus = i; else if (S.panes.length) S.panes[S.focus] = arg; else S.panes = [arg]; }
    else S.current = arg;
    remember(arg);
  } else if (arg) {
    pendingArg = arg;
  }
  history.replaceState({ hub: 'home' }, '', urlFor(wide() ? focused() : null));
  if (!wide() && S.current) history.pushState({ hub: 'session', target: S.current }, '', urlFor(S.current));
  render();
  load();
  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
}

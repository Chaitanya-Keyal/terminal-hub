// The terminal hub page. Wide screens: a session list on the left and up to four terminals side
// by side. Phones: a home screen with the list, then one terminal with a top bar and key bar.
// Every terminal is its own connection to ttyd (term.js); the last few hidden ones stay
// connected, so switching back is instant. The list comes from /assets/sessions.json.
import { icon, hasIcon, PLACE_ICONS } from './icons.js';
import { TermView, MAC, runHub } from './term.js';
import { keyBar } from './keys.js';

const WIDE = matchMedia('(min-width: 900px)');
const TOUCH = matchMedia('(pointer: coarse)');
const POLL_MS = 30000;  // a safety net: the list arrives by the event stream (/assets/events)
const MAX_PANES = 4;
const KEEP_HIDDEN = { wide: 4, narrow: 1 };  // hidden terminals that stay connected
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;  // as terminal-hub's: no leading - (a tmux option)
const APP = document.title;
const STATUS = { working: 'Working', waiting: 'Needs you', done: 'Done' };

/** @typedef {{name: string, windows: number, attached: number, status: '' | 'working' | 'waiting' | 'done', statusAt: number, prefix?: string, category?: string, path?: string, starting?: boolean}} Session */
/** @typedef {{key: string, label: string, colour: string, icon?: string, state: 'ok' | 'locked' | 'unreachable' | 'pending', sessions: Session[]}} Place */
/** @typedef {{key: string, label: string, icon?: string, editable?: boolean}} Category */
/** @typedef {{p: Place, s: Session}} Item */
/** @typedef {{id: string, key: string, label: string, category: Category | null, place: Place | null, items: Item[]}} Group */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('hub.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('hub.' + key, JSON.stringify(value)); } catch {} },
};

const S = {
  places: /** @type {Place[] | null} */ (null),
  categories: /** @type {Category[]} */ ([]),
  /** @type {Set<string>} collapsed groups: "c:KEY" (a category) or "p:KEY" (a place) */
  collapsed: new Set(store.get('collapsed', [])),
  /** @type {string[]} targets ("KEY:NAME") in the panes, on wide screens */
  panes: store.get('panes', []).filter(t => typeof t === 'string' && t.includes(':')).slice(0, MAX_PANES),
  focus: store.get('focus', 0),
  current: /** @type {string | null} */ (null),  // phones: the open session, or null for the home screen
  sidebar: store.get('sidebar', true),
  fontSize: store.get('fontSize', 15),
  /** notifications on (and allowed by the browser) */
  notify: store.get('notify', false) && typeof Notification === 'function' && Notification.permission === 'granted',
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
/** @type {HTMLElement | null} */ let sheet = null, help = null, menu = null;
/** @type {Element | {x: number, y: number} | null} */ let menuAnchor = null;  // what opened the menu
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
const allTargets = () => groups().flatMap(g => g.items.map(({ p, s }) => `${p.key}:${s.name}`)).filter(openable);
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
  bell: h('button', { type: 'button', class: 'icon-btn', onclick: () => setNotify(!S.notify) }),
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
    ui.bell,
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
// The list's groups, in order: the categories that have sessions, then every place with its
// sessions that aren't in one.
/** @returns {Group[]} */
function groups() {
  const places = S.places ?? [];
  /** @type {Map<string, Item[]>} */
  const byCategory = new Map(S.categories.map(c => [c.key, []]));
  /** @type {Map<string, Item[]>} */
  const byPlace = new Map(places.map(p => [p.key, []]));
  for (const p of places) {
    for (const s of p.sessions) ((s.category && byCategory.get(s.category)) || byPlace.get(p.key))?.push({ p, s });
  }
  const items = (map, key) => map.get(key) ?? [];
  return [
    ...S.categories.filter(c => items(byCategory, c.key).length)
      .map(c => ({ id: `c:${c.key}`, key: c.key, label: c.label, category: c, place: null, items: items(byCategory, c.key) })),
    ...places.map(p => ({ id: `p:${p.key}`, key: p.key, label: p.label, category: null, place: p, items: items(byPlace, p.key) })),
  ];
}

function placeItems() {
  if (!S.places) return [h('div', { class: 'note' }, 'Loading…')];
  if (!S.places.length) return [h('div', { class: 'note' }, 'No places in the config.')];
  const q = S.filter.trim().toLowerCase();
  const out = [];
  for (const g of groups()) {
    const hit = !q || g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q);
    const items = hit ? g.items : g.items.filter(({ s }) => s.name.toLowerCase().includes(q));
    if (!hit && !items.length) continue;
    const shut = !q && S.collapsed.has(g.id);
    const p = g.place;
    if (!p) {
      const c = /** @type {Category} */ (g.category);
      out.push(h('section', {
        class: 'group category',
        oncontextmenu: e => {  // on the header; a row has its own menu
          if (!wide() || !c.editable || !/** @type {Element} */ (e.target).closest('.group-head')) return;
          e.preventDefault();
          categoryMenu(c, { x: e.clientX, y: e.clientY });
        },
      },
        groupHead(g, items, h('span', { class: 'cat-mark' }, mark(c.icon) ?? icon('tag')),
          c.editable ? iconBtn('ellipsis', `More for ${c.label}`, e => categoryMenu(c, e.currentTarget), 'group-more') : null),
        !shut && items.map(({ p, s }) => sessionRow(p, s, true))));
      continue;
    }
    out.push(h('section', { class: 'group place', style: `--c:${p.colour}` },
      groupHead(g, items, placeMark(p), placeTail(p)),
      !shut && S.creating === p.key && createEl,
      !shut && items.map(({ s }) => sessionRow(p, s, false)),
      !shut && p.state === 'ok' && !p.sessions.length && S.creating !== p.key && h('div', { class: 'note small' }, 'No sessions')));
  }
  if (!out.length) out.push(h('div', { class: 'note' }, `Nothing matches “${S.filter.trim()}”`));
  return out;
}

// A group's header: a button that collapses it (showing its count, and the most urgent status in
// it), then TAIL (a place's + or state).
function groupHead(g, items, markEl, tail) {
  const shut = !S.filter.trim() && S.collapsed.has(g.id);
  const urgent = shut && ['waiting', 'working', 'done'].find(st => items.some(({ p, s }) => statusOf(`${p.key}:${s.name}`, s) === st));
  return h('div', { class: 'group-head' },
    h('button', {
      type: 'button', class: 'group-toggle', 'aria-expanded': String(!shut), 'data-k': g.id,
      title: `${shut ? 'Show' : 'Hide'} ${g.label}`, onclick: () => toggleGroup(g.id),
    }, icon('chevron-right'), markEl, h('span', { class: 'group-name' }, g.label),
    shut && items.length > 0 && h('span', { class: 'group-count' }, String(items.length)),
    urgent && h('span', { class: `st st-${urgent}`, 'aria-label': STATUS[urgent] })),
    tail);
}

function placeTail(p) {
  if (p.state === 'locked') return h('button', { type: 'button', class: 'chip', onclick: () => unlock(p) }, icon('lock'), 'Unlock');
  if (p.state === 'unreachable') {
    return h('button', { type: 'button', class: 'chip quiet', title: 'Try again', onclick: () => load(p.key) }, icon('rotate-cw'), 'Unreachable');
  }
  if (p.state === 'pending') return h('span', { class: 'chip quiet', title: 'Listing its sessions' }, spinner(), 'Checking');
  return iconBtn('plus', `New session on ${p.label}`, () => startCreate(p.key), 'add');
}

function toggleGroup(id) {
  if (!S.collapsed.delete(id)) S.collapsed.add(id);
  store.set('collapsed', [...S.collapsed]);
  renderLists();
}

// An icon from the config: a Lucide name (icons.js), or anything else (an emoji) as text.
function mark(name) {
  if (!name) return null;
  return hasIcon(name) ? icon(name) : h('span', { class: 'emoji', 'aria-hidden': 'true' }, name);
}
// A place's mark: its icon in its colour, else a dot.
function placeMark(p) {
  return h('span', { class: 'pmark', style: p ? `--c:${p.colour}` : null }, (p && mark(p.icon)) ?? h('span', { class: 'dot' }));
}
const spinner = () => { const i = icon('loader-circle'); i.classList.add('spin'); return i; };

function statusOf(t, s) {
  if (s.status === 'done') return s.statusAt > (S.seen[t] ?? 0) && !visible().includes(t) ? 'done' : '';
  return s.status;
}

function sessionRow(p, s, showPlace) {
  const t = `${p.key}:${s.name}`;
  const st = statusOf(t, s);
  const open = visible().includes(t);
  const ok = openable(t);
  const main = h('button', {
    type: 'button', class: 'row-main', 'data-k': t,
    title: !ok ? 'Rename this session to open it here' : s.starting ? 'Starting…' : st ? STATUS[st] : null,
    onclick: e => (wide() && (e.shiftKey || e.metaKey || e.ctrlKey) ? openBeside(t) : openSession(t)),
  },
  s.starting ? h('span', { class: 'st st-starting', 'aria-label': 'Starting' }, icon('loader-circle'))
    : h('span', { class: `st${st ? ' st-' + st : ''}`, 'aria-label': st ? STATUS[st] : null }),
  h('span', { class: 'row-name' }, s.name),
  showPlace ? h('span', { class: 'row-meta row-place', title: p.label }, placeMark(p), p.label)
    : !wide() && open ? h('span', { class: 'row-meta' }, 'open')
      : s.windows > 1 && h('span', { class: 'row-meta' }, `${s.windows} windows`));
  return h('div', {
    class: `row${open ? ' open' : ''}${t === focused() ? ' focused' : ''}${ok ? '' : ' off'}`, role: 'listitem',
    style: `--c:${p.colour}`,  // the open marker's colour, also in a category
    oncontextmenu: e => { if (!wide() || s.starting) return; e.preventDefault(); sessionMenu(t, { x: e.clientX, y: e.clientY }); },
  },
  main,
  wide() && ok && iconBtn('columns-2', 'Open beside', () => openBeside(t), 'row-split'),
  !s.starting && iconBtn('ellipsis', `More for ${s.name}`, e => sessionMenu(t, e.currentTarget), 'row-more'));
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
  if (S.collapsed.delete(`p:${key}`)) store.set('collapsed', [...S.collapsed]);
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
  const keep = active && list.contains(active) ? { el: active, k: active.dataset.k, from: active.selectionStart, to: active.selectionEnd } : null;
  list.replaceChildren(...placeItems());
  if (keep?.el.isConnected) { keep.el.focus(); try { keep.el.setSelectionRange(keep.from, keep.to); } catch {} }
  else if (keep?.k) /** @type {HTMLElement | null} */ (list.querySelector(`[data-k="${CSS.escape(keep.k)}"]`))?.focus();
  const t = lastTarget();
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
  S.trusted.delete(t);  // nothing may create it again without you asking
  if (wide()) { const i = S.panes.indexOf(t); if (i >= 0) closePane(i); }
  else if (S.current === t) goHome();
  views.get(t)?.dispose();
  views.delete(t);
  render();
}

// Leave the session on a phone. The list shows at once: history.back() lands later, and a render
// in between must not find the session still open (it would connect to it again).
function goHome() {
  const fromSession = history.state?.hub === 'session';
  S.current = null;
  if (fromSession) history.back();
  else history.replaceState({ hub: 'home' }, '', urlFor(null));
  render();
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
        const t = view.target;
        toast(`${nameOf(t)} ended`);
        const p = placeOf(t);
        if (p) p.sessions = p.sessions.filter(s => s.name !== nameOf(t));
        starting.delete(t);
        setTimeout(() => closeTarget(t));
        load(keyOf(t));
      },
      attached: view => load(keyOf(view.target)),
      actions: view => view.status === 'detached'
        ? [['Reattach', () => view.connect(), true], ['Close', () => closeTarget(view.target)]] : null,
    }, ['--existing', t]);
    v.target = t;
    views.set(t, v);
  }
  v.lastUsed = Date.now();
  return v;
}

// A slot is one place in the grid. Its header is built once and updated in place: a click on a
// pane that isn't focused focuses it first (a render), and must still reach the button it began on.
/** @type {{el: HTMLElement, body: HTMLElement, name: HTMLElement, place: HTMLElement, mk: HTMLElement, close: HTMLElement, target: string}[]} */
const slots = [];
function slot(i) {
  if (!slots[i]) {
    const name = h('span', { class: 'pane-name' }), place = h('span', { class: 'pane-place' }), mk = h('span');
    const close = iconBtn('x', 'Close', () => closePane(S.panes.indexOf(slots[i].target)));
    const head = h('div', { class: 'pane-head' }, mk, name, place, h('span', { class: 'grow' }), close);
    const body = h('div', { class: 'pane-body' });
    const el = h('div', { class: 'pane' }, head, body);
    el.addEventListener('pointerdown', () => {
      if (wide() && i !== S.focus && i < S.panes.length) { S.focus = i; render(); }
    }, true);
    slots[i] = { el, body, name, place, mk, close, target: '' };
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
    if (s.target !== t || !s.mk.firstChild) s.mk.replaceChildren(placeMark(placeOf(t)));
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
    h('div', { class: 'top-title' }, placeMark(placeOf(t)), h('b', {}, nameOf(t)), h('small', {}, labelOf(t))),
    ...(lt ? [h('button', { type: 'button', class: 'last-btn', title: `Switch to ${nameOf(lt)}`, onclick: last },
      icon('arrow-left-right'), h('span', {}, nameOf(lt)))] : []),
    iconBtn('ellipsis', `More for ${nameOf(t)}`, e => sessionMenu(t, e.currentTarget), 'more'));
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
// load(): the list as the server last had it (it lists places again in the background).
// load(true) or load(KEY) wait for a new list of every place, or of place KEY, after a change.
// A request made while another is on the way follows it. An unchanged list isn't drawn again.
let loading = null, lastList = '';
const pendingFresh = new Set();
/** @param {boolean | string} [fresh] */
function load(fresh = false) {
  if (loading) { if (fresh) pendingFresh.add(fresh === true ? '' : fresh); return loading; }
  const query = fresh === true ? '?fresh' : fresh ? `?fresh=${encodeURIComponent(fresh)}` : '';
  return (loading = (async () => {
    let changed = false;
    try {
      const r = await fetch(`/assets/sessions.json${query}`, { cache: 'no-store' });
      changed = applyList(r.ok ? await r.text() : '');
    } catch { /* keep the last list */ }
    loading = null;
    if (!S.ready && S.places) firstList();
    if (changed) render();
    if (pendingFresh.size) {
      const next = pendingFresh.has('') ? true : [...pendingFresh].join(',');
      pendingFresh.clear();
      load(next);
    }
  })());
}

// A list from the server (JSON text), unless it's the one we have. True if it changed.
function applyList(text) {
  if (!text || (text === lastList && !starting.size)) return false;
  const list = JSON.parse(text);
  lastList = text;
  S.categories = list.categories ?? [];
  S.places = withStarting(list.places);
  notifyChanges();
  return true;
}

// The event stream: server.py sends the list whenever it changes. A hidden tab keeps it only
// with notifications on.
let events = null;
function listen() {
  if (events || typeof EventSource !== 'function') return;
  events = new EventSource('/assets/events');
  events.onmessage = e => {
    try { if (!applyList(e.data)) return; } catch { return; }
    if (!S.ready) firstList();
    render();
  };
}
function quiet() { events?.close(); events = null; }

// ---- notifications --------------------------------------------------------------------------
// With them on, a session that starts waiting for you, or finishes, raises one (unless it's on
// screen in a focused window). A click opens the session.
/** @type {Map<string, string> | null} target → "status statusAt", from the previous list */
let lastStates = null;
function notifyChanges() {
  const before = lastStates;
  lastStates = new Map();
  for (const p of S.places ?? []) {
    for (const s of p.sessions) {
      const t = `${p.key}:${s.name}`, now = `${s.status} ${s.statusAt}`;
      lastStates.set(t, now);
      if (!before || !S.notify || s.starting || !before.has(t) || before.get(t) === now) continue;
      if (document.visibilityState === 'visible' && document.hasFocus() && visible().includes(t)) continue;
      if (s.status === 'waiting' && !before.get(t)?.startsWith('waiting')) show(t, `${s.name} needs you`, p.label);
      else if (s.status === 'done') show(t, `${s.name} is done`, p.label);
    }
  }
}

async function show(t, title, body) {
  const options = { body, tag: t, icon: '/assets/app-192.png', data: { target: t, url: `/?arg=${t}` } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();  // phones show them only this way
    if (reg?.active) return await reg.showNotification(title, options);
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); openFromNotification(t); n.close(); };
  } catch { /* not allowed after all */ }
}

function openFromNotification(t) {
  if (exists(t)) openSession(t); else toast(`${nameOf(t)} has ended`);
}

async function setNotify(on) {
  if (on) {
    if (typeof Notification !== 'function') return toast("This browser can't show notifications (on an iPhone, add the hub to the home screen first)", 4500);
    const answer = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (answer !== 'granted') return toast("Notifications are blocked: allow them in this site's settings", 4500);
  }
  S.notify = on;
  store.set('notify', on);
  paintBell();
  toast(on ? 'Notifications on' : 'Notifications off');
  if (document.hidden && !on) quiet();
}

function paintBell() {
  ui.bell.replaceChildren(icon(S.notify ? 'bell' : 'bell-off'));
  ui.bell.title = S.notify ? 'Notifications on: turn off' : 'Notifications off: turn on';
  ui.bell.setAttribute('aria-label', ui.bell.title);
  ui.bell.setAttribute('aria-pressed', String(S.notify));
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
    goHome();
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
  const toggle = h('button', {
    type: 'button', class: 'switch', role: 'switch', 'aria-label': 'Notifications', 'aria-checked': String(S.notify),
    onclick: async () => { await setNotify(!S.notify); toggle.setAttribute('aria-checked', String(S.notify)); },
  });
  const wrap = h('div', { class: 'sheet-wrap', onclick: e => { if (e.target === wrap) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'setting' }, h('span', {}, 'Text size'),
        h('div', { class: 'stepper' }, iconBtn('a-arrow-down', 'Smaller text', () => step(-1)), value,
          iconBtn('a-arrow-up', 'Larger text', () => step(1)))),
      h('div', { class: 'setting' },
        h('span', {}, 'Notifications', h('small', {}, 'When a session needs you or finishes, while the hub is open')),
        toggle)));
  sheet = wrap;
  document.body.append(wrap);
}

// ---- menus: a session's (rename, move, kill) and a page-made category's (edit, delete) ---------
// A popover by the ⋯ button (or the pointer, for a right-click) on a desktop; a sheet on a phone.
/** @typedef {{fill: (...kids: any[]) => void, item: (ic: string | Element, label: string, onclick: () => void, cls?: string) => HTMLElement, error: () => HTMLElement, focus: () => void}} MenuKit */
/** @param {Element | {x: number, y: number}} at @param {string} label @param {(kit: MenuKit) => void} build */
function openMenu(at, label, build) {
  if (menu && menuAnchor === at) return closeMenu();  // its button again: a toggle
  closeMenu();
  closeHelp();
  menuAnchor = at;
  const body = h('div', { class: 'menu-body' });
  /** @type {MenuKit} */
  const kit = {
    fill: (...kids) => body.replaceChildren(...kids.flat().filter(Boolean)),  // replaceChildren would print false
    item: (ic, text, onclick, cls = '') => h('button', { type: 'button', class: `menu-item ${cls}`, role: 'menuitem', onclick },
      typeof ic === 'string' ? icon(ic) : ic, h('span', {}, text)),
    error: () => h('div', { class: 'create-error', role: 'alert' }),
    focus: () => requestAnimationFrame(() => /** @type {HTMLElement | null} */ (body.querySelector('input, button'))?.focus()),
  };
  build(kit);
  kit.focus();
  if (wide()) {
    menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label }, body);
    document.body.append(menu);
    const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
    const place = () => {
      if (!menu) return;
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    };
    place();
    new ResizeObserver(place).observe(menu);  // its steps (a form, a question) change its size
    // A press anywhere else closes it (the press that opened it is over by now).
    document.addEventListener('pointerdown', function off(e) {
      const target = /** @type {Node} */ (e.target);
      if (menu && !menu.contains(target) && !(menuAnchor instanceof Element && menuAnchor.contains(target))) closeMenu();
      if (!menu) document.removeEventListener('pointerdown', off, true);
    }, true);
  } else {
    menu = h('div', { class: 'sheet-wrap', onclick: e => { if (e.target === menu) closeMenu(); } },
      h('div', { class: 'sheet menu-sheet', role: 'dialog', 'aria-label': label }, h('div', { class: 'sheet-grip' }), body));
    document.body.append(menu);
  }
}

/** @param {string} t @param {Element | {x: number, y: number}} at */
function sessionMenu(t, at) {
  openMenu(at, nameOf(t), ({ fill, item, error, focus }) => {
    const title = !wide() && h('div', { class: 'menu-title', style: `--c:${colourOf(t)}` },
      placeMark(placeOf(t)), h('b', {}, nameOf(t)), h('small', {}, labelOf(t)));
    const kit = { fill, item, error, focus };

    const choose = () => fill(title,
      wide() && openable(t) && !visible().includes(t) && item('columns-2', 'Open in a new pane', () => { closeMenu(); openBeside(t); }),
      item('pencil', 'Rename', rename),
      item('tag', 'Move to category', pickCategory),
      item('trash-2', 'Kill session', confirmKill, 'danger'));

    const moveTo = async key => {
      const r = await runHub(['--category', t, key || '-']);
      if (!r.ok) return r.message || "Couldn't move it.";
      closeMenu();
      const s = sessionOf(t);
      if (s) s.category = key;
      render();
      load(keyOf(t));
      return '';
    };

    const pickCategory = () => {
      const err = error();
      const now = sessionOf(t)?.category ?? '';
      const choice = (markEl, label, key) => h('button', {
        type: 'button', class: `menu-item${key === now ? ' current' : ''}`, role: 'menuitemradio',
        'aria-checked': String(key === now), onclick: async () => { err.textContent = await moveTo(key); },
      }, markEl ?? icon('tag'), h('span', {}, label), key === now && icon('check'));
      fill(title,
        S.categories.map(c => choice(mark(c.icon), c.label, c.key)),
        S.categories.length > 0 && choice(icon('x'), 'No category', ''),
        item('plus', 'New category…', newCategory),
        err);
      focus();
    };

    const newCategory = () => {
      const s = sessionOf(t);
      // A rule for the session's folder, ticked unless it's one that catches nearly everything.
      const broad = /^\/(?:(?:home|Users)\/[^/]+|root|tmp)?\/?$/.test(s?.path ?? '');
      const box = s?.path ? h('input', { type: 'checkbox', checked: !broad }) : null;
      fill(title, categoryForm(kit, {
        submitLabel: 'Create',
        extra: box && h('label', { class: 'menu-check' }, box, h('span', {}, 'Also sessions started in ', h('b', {}, shortPath(s?.path ?? '')))),
        submit: async (label, ic) => {
          const folder = box?.checked && s?.path ? [glob(s.path), `${glob(s.path)}/*`] : [];
          const made = await runHub(['--new-category', label, ic, ...folder]);
          if (!made.ok) return made.message || "Couldn't make it.";
          S.categories = [...S.categories, { key: made.message, label, icon: ic, editable: true }];
          return moveTo(made.message);
        },
      }));
      focus();
    };

    const rename = () => {
      const err = error();
      const input = h('input', {
        class: 'create-input', value: openable(t) ? nameOf(t) : nameOf(t).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32),
        maxLength: 32, autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterKeyHint: 'done',
        'aria-label': `New name for ${nameOf(t)}`, oninput: () => { err.textContent = ''; },
      });
      const save = h('button', { type: 'submit', class: 'btn primary' }, 'Rename');
      fill(title, h('form', {
        class: 'menu-form',
        onsubmit: async e => {
          e.preventDefault();
          const name = input.value.trim().replace(/\s+/g, '-');
          if (name === nameOf(t)) return closeMenu();
          if (!NAME_RE.test(name)) { err.textContent = 'Use letters, digits, - and _ (up to 32).'; return input.focus(); }
          if (placeOf(t)?.sessions.some(s => s.name === name)) { err.textContent = `There's already a ${name}.`; return input.focus(); }
          save.disabled = true;
          const r = await runHub(['--rename', t, name]);
          if (!r.ok) { save.disabled = false; err.textContent = r.message || "Couldn't rename it."; return; }
          closeMenu();
          renamed(t, `${keyOf(t)}:${name}`);
        },
      }, h('div', { class: 'create-row' }, input, save), err));
      input.focus();
      input.select();
    };

    const confirmKill = () => {
      const err = error();
      const kill = h('button', {
        type: 'button', class: 'btn danger',
        onclick: async () => {
          kill.disabled = true;
          const r = await runHub(['--kill', t]);
          if (!r.ok) { kill.disabled = false; err.textContent = r.message || "Couldn't kill it."; return; }
          closeMenu();
          killed(t);
        },
      }, 'Kill');
      fill(title,
        h('p', { class: 'menu-text' }, 'Kill ', h('b', {}, nameOf(t)), '? Everything running in it stops.'),
        h('div', { class: 'menu-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeMenu }, 'Cancel'), kill),
        err);
      kill.focus();
    };

    choose();
  });
}

/** A category made on the page: rename it, change its icon, or delete it. @param {Category} c @param {Element | {x: number, y: number}} at */
function categoryMenu(c, at) {
  openMenu(at, c.label, kit => {
    const title = !wide() && h('div', { class: 'menu-title' }, h('span', { class: 'cat-mark' }, mark(c.icon) ?? icon('tag')), h('b', {}, c.label));
    const edit = () => {
      kit.fill(title, categoryForm(kit, {
        label: c.label, icon: c.icon || 'tag', submitLabel: 'Save',
        submit: async (label, ic) => {
          const r = await runHub(['--edit-category', c.key, label, ic]);
          if (!r.ok) return r.message || "Couldn't save it.";
          closeMenu();
          Object.assign(c, { label, icon: ic });
          render();
          load(true);
          return '';
        },
      }));
      kit.focus();
    };
    const confirmDelete = () => {
      const err = kit.error();
      const drop = h('button', {
        type: 'button', class: 'btn danger',
        onclick: async () => {
          drop.disabled = true;
          const r = await runHub(['--delete-category', c.key]);
          if (!r.ok) { drop.disabled = false; err.textContent = r.message || "Couldn't delete it."; return; }
          closeMenu();
          S.categories = S.categories.filter(x => x !== c);
          for (const p of S.places ?? []) for (const s of p.sessions) if (s.category === c.key) s.category = '';
          render();
          load(true);
        },
      }, 'Delete');
      kit.fill(title,
        h('p', { class: 'menu-text' }, 'Delete ', h('b', {}, c.label), '? Its sessions go back to their places.'),
        h('div', { class: 'menu-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeMenu }, 'Cancel'), drop),
        err);
      drop.focus();
    };
    kit.fill(title, kit.item('pencil', 'Rename, or change its icon', edit), kit.item('trash-2', 'Delete category', confirmDelete, 'danger'));
  });
}

// A category's name and icon. submit(label, icon) saves, and returns what went wrong, or ''.
/** @param {MenuKit} kit @param {{label?: string, icon?: string, submitLabel: string, extra?: any, submit: (label: string, icon: string) => Promise<string>}} o */
function categoryForm(kit, o) {
  const err = kit.error();
  let chosen = o.icon ?? 'folder';
  const input = h('input', {
    class: 'create-input', value: o.label ?? '', maxLength: 40, placeholder: 'Name, say Website', autocomplete: 'off',
    spellcheck: false, enterKeyHint: 'done', 'aria-label': 'Category name', oninput: () => { err.textContent = ''; },
  });
  const grid = h('div', { class: 'icon-grid', role: 'radiogroup', 'aria-label': 'Icon' },
    PLACE_ICONS.map(name => h('button', {
      type: 'button', class: `icon-pick${name === chosen ? ' on' : ''}`, role: 'radio', 'aria-checked': String(name === chosen),
      title: name, 'aria-label': name,
      onclick: e => {
        chosen = name;
        for (const b of grid.children) {
          b.classList.toggle('on', b === e.currentTarget);
          b.setAttribute('aria-checked', String(b === e.currentTarget));
        }
      },
    }, icon(name))));
  const save = h('button', { type: 'submit', class: 'btn primary' }, o.submitLabel);
  return h('form', {
    class: 'menu-form',
    onsubmit: async e => {
      e.preventDefault();
      const label = input.value.trim();
      if (!label) { err.textContent = 'Give it a name.'; return input.focus(); }
      save.disabled = true;
      err.textContent = await o.submit(label, chosen);
      save.disabled = false;
    },
  }, input, grid, o.extra,
  h('div', { class: 'menu-actions' }, h('button', { type: 'button', class: 'btn', onclick: closeMenu }, 'Cancel'), save), err);
}

const glob = path => path.replace(/[*?[\]\\]/g, '\\$&');  // a folder, as a pattern that matches only it
const shortPath = path => path.replace(/^\/(home|Users)\/[^/]+/, '~');

function closeMenu() {
  if (!menu) return;
  const back = menuAnchor instanceof HTMLElement && menuAnchor.isConnected ? menuAnchor : null;
  menu.remove();
  menu = menuAnchor = null;
  back?.focus();
}

// A session has a new name: everything that knew it by the old one follows.
function renamed(old, t) {
  const v = views.get(old);
  if (v) {
    views.delete(old);
    views.set(t, v);
    v.target = t;
    v.args = v.args[0] === '--existing' ? ['--existing', t] : [t];
    v.again = ['--existing', t];
  }
  if (starting.delete(old)) starting.set(t, Date.now());
  S.panes = S.panes.map(x => (x === old ? t : x));
  if (S.current === old) { S.current = t; history.replaceState({ hub: 'session', target: t }, '', urlFor(t)); }
  S.recent = S.recent.map(x => (x === old ? t : x));
  store.set('recent', S.recent);
  if (old in S.seen) { S.seen[t] = S.seen[old]; delete S.seen[old]; store.set('seen', S.seen); }
  if (S.trusted.delete(old)) S.trusted.add(t);
  const s = sessionOf(old);
  if (s) s.name = nameOf(t);
  toast(`Renamed to ${nameOf(t)}`);
  render();
  load(keyOf(t));
}

function killed(t) {
  const p = placeOf(t);
  if (p) p.sessions = p.sessions.filter(s => s.name !== nameOf(t));
  starting.delete(t);
  if (views.has(t)) closeTarget(t);
  toast(`Killed ${nameOf(t)}`);
  render();
  load(keyOf(t));
}

function unlock(p) {
  modal?.close();
  const body = h('div', { class: 'modal-body' });
  const view = new TermView(['--unlock', p.key], {
    fontSize: S.fontSize, renderer: store.get('renderer', 'webgl'),
    ctrl: () => false, ctrlUsed() {}, copied() {},
    status: v => { if (v.status === 'unlocked') { close(); toast(`${p.label} unlocked`); load(p.key); } },
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
  if (e.key === 'Escape' && (help || menu || sheet || modal)) {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    closeHelp();
    sheet?.remove();
    sheet = null;
    return modal?.close();
  }
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
  if (document.hidden) { if (!S.notify) quiet(); return; }
  listen();
  load();
  for (const v of views.values()) v.reconnectNow();
});

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.hub === 'open' && typeof e.data.target === 'string' && e.data.target.includes(':')) openFromNotification(e.data.target);
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
  if (arg && /^[A-Za-z0-9_-]+:[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/.test(arg) && !arg.endsWith(':new')) {
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
  paintBell();
  render();
  load();
  listen();
  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  navigator.serviceWorker?.register('/assets/sw.js', { scope: '/' }).catch(() => {});
}

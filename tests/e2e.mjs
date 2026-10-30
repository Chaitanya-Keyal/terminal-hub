// End-to-end test. Installs terminal-hub into a throwaway home, runs ttyd and server.py on spare
// ports with three fake places (two separate tmux servers and an unreachable ssh host), and drives
// the page in Chromium, on a desktop and on a phone.
//
//   cd tests && npm ci && npx playwright install chromium && npm test
//
// Needs ttyd, tmux and python3. PLAYWRIGHT (a path to playwright's index.mjs) and CHROMIUM (a
// browser executable) override the defaults.
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, launch, until, sleep } from './harness.mjs';

let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && info ? `  (${info})` : ''}`);
  if (!ok) failures++;
};

const hub = await startHub({
  places: [
    { key: 'laptop', label: 'laptop', colour: '#7ee787' },
    { key: 'server', label: 'server', colour: '#ff7b72', tmuxConf: 'set -g status off\nset -g mouse on\n' },
  ],
  extraConfig: [`place broken broken '#8b949e' ssh hub-e2e.invalid`],
});
const { base: BASE, tmux } = hub;
const clients = place => tmux(place, 'list-clients', '-F', '#{session_name}').split('\n').filter(Boolean);
const sessions = place => tmux(place, 'list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
tmux('laptop', 'new-session', '-d', '-s', 'alpha');
tmux('laptop', 'new-session', '-d', '-s', 'beta');
tmux('server', 'new-session', '-d', '-s', 'gamma');

// ttyd only takes terminal connections from its own page.
const upgrade = origin => new Promise(res => {
  const req = http.request(`${BASE}/ws`, { headers: {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', Origin: origin,
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol': 'tty' } });
  req.on('upgrade', (r, sock) => { sock.destroy(); res(101); });
  req.on('response', r => { r.resume(); res(r.statusCode); });
  req.on('error', () => res(0));
  req.end();
});
check('a terminal connection from another site is refused', (await upgrade('http://evil.example')) !== 101);
check("a terminal connection from the hub's own page is accepted", (await upgrade(BASE)) === 101);

const browser = await launch();
const context = options => hub.context(browser, options);
const names = page => page.locator('#sidebar .row-name').allTextContents();
// Right-click in the focused terminal: true if the page kept the browser's menu away.
const menuBlocked = (page, shiftKey = false) => page.locator('.pane.focused .xterm').evaluate((el, shiftKey) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}, shiftKey);
const row = (page, name, scope = '#sidebar') => page.locator(`${scope} .row`).filter({ has: page.locator('.row-name', { hasText: new RegExp(`^${name}$`) }) });

try {
  // ---- desktop ----------------------------------------------------------------------------
  const ctx = await context({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => check(`no page errors (${e.message})`, false));
  await page.goto(BASE);
  check('desktop: the sidebar lists every session', await until(async () => (await names(page)).join() === 'alpha,beta,gamma'), (await names(page)).join());
  check('desktop: nothing open shows the empty state', await page.locator('#empty h2').isVisible());
  check('desktop: an unreachable place says so', await until(() => page.locator('.place', { hasText: 'broken' }).locator('.chip', { hasText: 'Unreachable' }).isVisible()));
  check('desktop: no key bar on a desktop', !(await page.locator('#keybar').isVisible()));

  await row(page, 'alpha').locator('.row-main').click();
  check('click opens the session', await until(() => clients('laptop').includes('alpha')), clients('laptop').join());
  check('the address follows the session', await until(() => page.url().endsWith('?arg=laptop:alpha')), page.url());
  check('the open session is highlighted', await until(() => row(page, 'alpha').evaluate(el => el.classList.contains('focused'))));
  await until(() => page.locator('.xterm-rows').evaluate(el => el.textContent.includes('$')), 4000);
  await page.keyboard.type('echo hub-$((40+2))\n');
  check('typing reaches the session', await until(() => tmux('laptop', 'capture-pane', '-p', '-t', 'alpha').includes('hub-42')));

  await row(page, 'gamma').locator('.row-main').click();
  check('switch to another place', await until(() => clients('server').includes('gamma')), clients('server').join());
  check("right-click goes to tmux when it uses the mouse (tmux's menu)", await until(() => menuBlocked(page)));
  check("... and shift+right-click to the browser's menu", !(await menuBlocked(page, true)));
  check('the previous session stays connected in the background', clients('laptop').includes('alpha'));
  await row(page, 'alpha').locator('.row-main').click();
  check('switching back reuses the connection', await until(() => row(page, 'alpha').evaluate(el => el.classList.contains('focused'))) && clients('laptop').filter(s => s === 'alpha').length === 1);
  check("right-click is the browser's when tmux doesn't use the mouse", !(await menuBlocked(page)));

  await row(page, 'beta').locator('.row-main').click({ modifiers: ['Shift'] });
  check('shift+click opens a second pane', await until(async () => (await page.locator('#panes .pane').count()) === 2 && clients('laptop').includes('beta')));
  check('two panes show their headers', await page.locator('.pane-head').first().isVisible());
  await row(page, 'gamma').locator('.row-split').click();
  check('"open beside" adds a third pane', await until(async () => (await page.locator('#panes .pane').count()) === 3));
  await page.locator('.pane', { hasText: 'beta' }).locator('.pane-head .icon-btn').click();  // gamma has the focus
  check("one click closes a pane that isn't focused", await until(async () => (await page.locator('#panes .pane').count()) === 2, 2000));
  await page.locator('.pane', { hasText: 'gamma' }).locator('.pane-head .icon-btn').click();
  check('closing panes goes back to one', await until(async () => (await page.locator('#panes .pane').count()) === 1));

  await page.keyboard.press('Alt+ArrowDown');
  check('alt+down goes to the next session', await until(() => row(page, 'beta').evaluate(el => el.classList.contains('focused'))));
  await page.keyboard.press('Alt+Backquote');
  check('alt+` goes back to the last one', await until(() => row(page, 'alpha').evaluate(el => el.classList.contains('focused'))));
  await page.locator('.side-foot .icon-btn[title="Keyboard shortcuts"]').click();
  check("the shortcuts list tmux's keys, after the session's prefix",
    await until(async () => (await page.locator('.popover .help-sub').textContent()).replace(/\s/g, '') === 'PressCtrlbthen:'));
  const helpButton = page.locator('.side-foot .icon-btn[title="Keyboard shortcuts"]');
  await helpButton.click();
  check('the shortcuts button closes the box again', await until(async () => (await page.locator('.popover').count()) === 0, 2000));
  await helpButton.click();
  await page.keyboard.press('Escape');
  check('... and so does Esc', await until(async () => (await page.locator('.popover').count()) === 0, 2000));

  tmux('laptop', 'new-session', '-d', '-s', 'my notes');  // tmux allows the space; the hub can't attach to it
  check("a session the hub can't open is dimmed", await until(() => row(page, 'my notes').evaluate(el => el.classList.contains('off'))));
  await row(page, 'my notes').locator('.row-main').click();
  check('... and a click explains, without connecting', await until(async () => (await page.locator('#toast').textContent()).includes('rename it'))
    && (await page.locator('#panes .pane').count()) === 1 && !clients('laptop').includes('my notes'));
  await row(page, 'my notes').hover();
  await row(page, 'my notes').locator('.row-more').click();
  await page.locator('.menu .menu-item', { hasText: 'Rename' }).click();
  check('rename suggests a name the hub can open', (await page.locator('.menu .create-input').inputValue()) === 'my-notes');
  await page.locator('.menu .create-input').fill('notes');
  await page.keyboard.press('Enter');
  check('the ⋯ menu renames a session', await until(() => sessions('laptop').includes('notes') && !sessions('laptop').includes('my notes'))
    && await until(async () => (await names(page)).includes('notes')), sessions('laptop').join());
  check('... which the hub can then open', await until(() => row(page, 'notes').evaluate(el => !el.classList.contains('off'))));
  await row(page, 'notes').click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Kill session' }).click();
  check('killing asks first', await page.locator('.menu .menu-text', { hasText: 'Everything running in it stops' }).isVisible() && sessions('laptop').includes('notes'));
  await page.locator('.menu .btn.danger').click();
  check('right-click opens the menu too, and it kills the session', await until(() => !sessions('laptop').includes('notes'))
    && await until(async () => !(await names(page)).includes('notes')), sessions('laptop').join());

  await page.locator('#sidebar .place', { hasText: 'server' }).locator('.icon-btn.add').click();
  check('"+" opens a name field, focused', await until(() => page.locator('.create-input').evaluate(el => el === document.activeElement)));
  await page.keyboard.type('work\n');
  check('a new session is listed at once', await until(async () => (await names(page)).includes('work'), 300));
  check('a named session is created and opened', await until(() => clients('server').includes('work')), sessions('server').join());
  await sleep(400);
  await page.keyboard.type('echo typed-$((6*7))\n');
  check('you can type into a new session straight away', await until(() => tmux('server', 'capture-pane', '-p', '-t', 'work').includes('typed-42')));
  check('the new session shows up in the list', await until(async () => (await names(page)).includes('work')));
  await page.locator('#sidebar .place', { hasText: 'server' }).locator('.icon-btn.add').click();
  await page.keyboard.press('Enter');
  check('a blank name becomes "shell"', await until(() => sessions('server').includes('shell')), sessions('server').join());

  await until(() => clients('server').includes('shell'));
  await page.locator('.pane.focused .xterm').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('d');
  check('detaching shows a card', await until(() => page.locator('.term-card', { hasText: 'Detached' }).isVisible()));
  await page.locator('.term-card button', { hasText: 'Reattach' }).click();
  check('reattach works', await until(async () => clients('server').includes('shell') && !(await page.locator('.term-card').isVisible())));

  await row(page, 'shell').hover();
  await row(page, 'shell').locator('.row-more').click();
  await page.locator('.menu .menu-item', { hasText: 'Rename' }).click();
  await page.locator('.menu .create-input').fill('renamed');
  await page.keyboard.press('Enter');
  check('renaming the open session keeps it open, under the new name', await until(() =>
    sessions('server').includes('renamed') && clients('server').includes('renamed') && page.url().endsWith('?arg=server:renamed')), page.url());
  await page.locator('.pane.focused .xterm').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('d');
  check('... detaching from it still reads as detached', await until(() => page.locator('.term-card', { hasText: 'Detached' }).isVisible()));
  await page.locator('.term-card button', { hasText: 'Reattach' }).click();
  check('... and it reattaches by its new name', await until(async () => clients('server').includes('renamed') && !(await page.locator('.term-card').isVisible())));

  tmux('server', 'kill-session', '-t', 'renamed');
  check('a session that ends closes its pane, with a note', await until(async () => (await page.locator('#toast').textContent()).includes('renamed ended')),
    `toast: ${await page.locator('#toast').textContent()}; panes: ${await page.locator('#panes .pane').count()}; card: ${await page.locator('.term-card').allTextContents()}`);

  tmux('laptop', 'set-option', '-t', 'beta', '@hub-state', 'waiting');
  check('a session that needs you gets a dot', await until(() => row(page, 'beta').locator('.st-waiting').isVisible(), 9000));
  check('... and a count in the title', (await page.title()).startsWith('(1)'));
  tmux('laptop', 'set-option', '-t', 'beta', '@hub-state', 'done');
  tmux('laptop', 'set-option', '-t', 'beta', '@hub-state-at', String(Math.floor(Date.now() / 1000) + 5));
  check('a finished session you haven\'t seen gets a dot', await until(() => row(page, 'beta').locator('.st-done').isVisible(), 9000));
  await row(page, 'beta').locator('.row-main').click();
  check('... until you look at it', await until(async () => !(await row(page, 'beta').locator('.st-done').isVisible()), 9000));

  await page.locator('#sidebar .side-head .icon-btn').click();
  check('the sidebar hides to a rail', await until(() => page.locator('#rail').isVisible()));
  await page.locator('#rail .icon-btn').click();
  check('... and comes back', await until(() => page.locator('#sidebar').isVisible()));

  await row(page, 'gamma').locator('.row-main').click({ modifiers: ['Shift'] });
  await until(async () => (await page.locator('#panes .pane').count()) === 2);
  await page.reload();
  check('a reload brings both panes back', await until(async () => (await page.locator('#panes .pane').count()) === 2 && clients('server').includes('gamma')));
  tmux('server', 'kill-session', '-t', 'gamma');
  await sleep(300);
  await page.reload();
  await until(() => names(page).then(n => n.length > 0));
  await sleep(1500);
  check("a restored pane whose session is gone isn't recreated", !sessions('server').includes('gamma') && (await page.locator('#panes .pane').count()) === 1, sessions('server').join());
  await ctx.close();

  // ---- phone ------------------------------------------------------------------------------
  const pctx = await context({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await pctx.newPage();
  phone.on('pageerror', e => check(`no page errors on the phone (${e.message})`, false));
  await phone.goto(BASE);
  check('phone: opens on the home screen', await until(() => phone.locator('#home .row-name', { hasText: 'alpha' }).isVisible()));
  check('phone: no sidebar', !(await phone.locator('#sidebar').isVisible()));
  check('phone: each row has its ⋯ button showing', await phone.locator('#home .row .row-more').first().isVisible());
  await row(phone, 'alpha', '#home').locator('.row-main').tap();
  check('phone: a tap opens the session with a top bar', await until(() => phone.locator('#topbar b', { hasText: 'alpha' }).isVisible()));
  check('phone: the top bar has no stray text', !(await phone.locator('#topbar').textContent()).includes('undefined'));
  check('phone: the key bar fits in one row', await phone.locator('#keybar').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.children.length === 10));
  await phone.locator('.xterm').tap();
  await phone.keyboard.type('sleep 30\n');
  await until(() => tmux('laptop', 'display', '-p', '-t', 'alpha', '#{pane_current_command}') === 'sleep', 4000);
  await phone.locator('#keybar button[title="Ctrl+C"]').tap();
  check('phone: the ^C key interrupts', await until(() => tmux('laptop', 'display', '-p', '-t', 'alpha', '#{pane_current_command}') === 'bash'));
  await phone.locator('#topbar .back').tap();
  check('phone: back returns to the list', await until(() => phone.locator('#home').isVisible()));
  check('phone: the list offers to continue', await until(() => phone.locator('.continue', { hasText: 'alpha' }).isVisible()));
  await row(phone, 'beta', '#home').locator('.row-main').tap();
  check('phone: the top bar offers the last session', await until(() => phone.locator('.last-btn', { hasText: 'alpha' }).isVisible()));
  await phone.locator('.last-btn').tap();
  check('phone: one tap switches back', await until(() => phone.locator('#topbar b', { hasText: 'alpha' }).isVisible()));
  await phone.goBack();
  check("phone: the browser's back goes to the list", await until(() => phone.locator('#home').isVisible()));
  await phone.locator('#home .place', { hasText: 'laptop' }).locator('.icon-btn.add').tap();
  await phone.locator('.create-input').fill('m1');
  await phone.locator('.create .btn.primary').tap();
  check('phone: a new named session opens', await until(() => phone.locator('#topbar b', { hasText: 'm1' }).isVisible() && sessions('laptop').includes('m1')));
  await phone.locator('#topbar .more').tap();
  check("phone: the top bar's ⋯ opens the session's menu", await until(() => phone.locator('.menu-sheet .menu-item', { hasText: 'Kill session' }).isVisible()));
  await phone.locator('.menu-sheet .menu-item', { hasText: 'Kill session' }).tap();
  await phone.locator('.menu-sheet .btn.danger').tap();
  check('phone: killing the open session goes back to the list', await until(async () => !sessions('laptop').includes('m1') && await phone.locator('#home').isVisible()),
    `sessions: ${sessions('laptop').join()}; home: ${await phone.locator('#home').isVisible()}; toast: ${await phone.locator('#toast').textContent()}; menu: ${await phone.locator('.menu-sheet').allTextContents()}`);
  await row(phone, 'alpha', '#home').locator('.row-main').tap();
  await until(() => phone.locator('#topbar b', { hasText: 'alpha' }).isVisible() && clients('laptop').includes('alpha'));
  tmux('laptop', 'kill-session', '-t', 'alpha');
  await until(() => phone.locator('#home').isVisible());
  await sleep(1500);
  check("phone: a session that ends goes back to the list, and isn't made again", (await phone.locator('#home').isVisible()) && !sessions('laptop').includes('alpha'), sessions('laptop').join());
  await phone.locator('.home-head .icon-btn').tap();
  const before = await phone.locator('.stepper .value').textContent();
  await phone.locator('.stepper .icon-btn').last().tap();
  check('phone: settings change the text size', await until(async () => Number(await phone.locator('.stepper .value').textContent()) === Number(before) + 1));
  await pctx.close();

  // ---- categories, icons, and a slow place: a second hub with its own config ----------------
  const extra = mkdtempSync(join(tmpdir(), 'hub-slow-'));
  mkdirSync(join(extra, 'tmux'), { mode: 0o700 });
  writeFileSync(join(extra, 'slow.sh'), `#!/bin/bash\n[ -e ${extra}/slow ] && sleep 3\n` +
    `exec env -u TMUX -u TMUX_PANE TMUX_TMPDIR=${extra}/tmux HOME=${extra} bash -c "$1"\n`, { mode: 0o755 });
  const hub2 = await startHub({
    places: [{ key: 'laptop', label: 'laptop', colour: '#7ee787' }, { key: 'server', label: 'server', colour: '#ff7b72' }],
    extraConfig: [`place slow slow '#d2a8ff' via ${extra}/slow.sh`, 'icon laptop laptop', 'icon server 🚀',
      `category work Work briefcase '*/hub-e2e-work/*'`  // not */work/*: CI's temp folder is under /work/, `category bots Bots bot 'server:bot*'`],
  });
  try {
    const workDir = join(hub2.home, 'home-laptop', 'hub-e2e-work', 'api');
    mkdirSync(workDir, { recursive: true });
    hub2.tmux('laptop', 'new-session', '-d', '-s', 'api', '-c', workDir);
    hub2.tmux('laptop', 'new-session', '-d', '-s', 'notes');
    hub2.tmux('server', 'new-session', '-d', '-s', 'bot1');
    hub2.tmux('server', 'new-session', '-d', '-s', 'logs');
    const ctx2 = await hub2.context(browser, { viewport: { width: 1280, height: 800 } });
    const pg = await ctx2.newPage();
    pg.on('pageerror', e => check(`no page errors with categories (${e.message})`, false));
    await pg.goto(hub2.base);
    const order = async () => (await pg.locator('#sidebar .group-name').allTextContents()).join();
    const group = name => pg.locator('#sidebar .group').filter({ has: pg.locator('.group-name', { hasText: new RegExp(`^${name}$`) }) });
    check('categories come first, then the places', await until(async () => (await order()) === 'Work,Bots,laptop,server,slow'), await order());
    check('a folder rule puts a session in its category, which shows its place',
      await group('Work').locator('.row', { hasText: 'api' }).locator('.row-place', { hasText: 'laptop' }).isVisible());
    check('its place keeps the other sessions', (await group('laptop').locator('.row-name').allTextContents()).join() === 'notes');
    check('places show their icons: a Lucide one, or an emoji',
      (await group('laptop').locator('.group-head .pmark svg').count()) === 1 && (await group('server').locator('.group-head .emoji').textContent()) === '🚀');

    await group('Work').locator('.group-toggle').click();
    check('a group collapses to a count', await until(async () =>
      !(await group('Work').locator('.row').count()) && (await group('Work').locator('.group-count').textContent()) === '1'));
    await pg.reload();
    check('... and stays collapsed after a reload', await until(async () => (await group('Work').locator('.group-toggle').getAttribute('aria-expanded')) === 'false'));
    await group('Work').locator('.group-toggle').click();
    await group('laptop').locator('.group-toggle').focus();
    await pg.keyboard.press('Enter');
    check('collapsing from the keyboard keeps the focus on the group', await until(async () =>
      (await group('laptop').locator('.group-toggle').getAttribute('aria-expanded')) === 'false'
        && await pg.evaluate(() => document.activeElement?.getAttribute('data-k')) === 'p:laptop'));
    await group('laptop').locator('.icon-btn.add').click();
    check('"+" on a collapsed place opens it, with the name field', await until(() => pg.locator('.create-input').evaluate(el => el === document.activeElement)));
    await pg.keyboard.press('Escape');

    const menuFor = async name => {
      const r = pg.locator('#sidebar .row').filter({ has: pg.locator('.row-name', { hasText: new RegExp(`^${name}$`) }) });
      await r.hover();
      await r.locator('.row-more').click();
      await pg.locator('.menu .menu-item', { hasText: 'Move to category' }).click();
    };
    await menuFor('notes');
    await pg.locator('.menu .menu-item', { hasText: 'Work' }).click();
    check('the ⋯ menu moves a session into a category', await until(async () => (await group('Work').locator('.row-name').allTextContents()).join() === 'api,notes'));
    await menuFor('bot1');
    await pg.locator('.menu .menu-item', { hasText: 'No category' }).click();
    check('... and "No category" takes one out, even one a rule put in', await until(async () =>
      (await order()) === 'Work,laptop,server,slow' && (await group('server').locator('.row-name').allTextContents()).join() === 'bot1,logs')
      && hub2.tmux('server', 'show-options', '-v', '-t', '=bot1:', '@hub-category') === '-', await order());

    writeFileSync(join(extra, 'slow'), '');  // the slow place now takes 3 s to answer
    await sleep(2500);                       // so every list is stale
    const ms = await pg.evaluate(async () => { const t = performance.now(); await fetch('/assets/sessions.json', { cache: 'no-store' }); return performance.now() - t; });
    check("a slow place doesn't hold up the list", ms < 1500, `${Math.round(ms)} ms`);
    rmSync(join(extra, 'slow'));

    const src = await pg.locator('script[type=module][src]').getAttribute('src') ?? '';
    const res = await fetch(hub2.assets + src.replace(/^\/assets/, ''), { headers: { 'Accept-Encoding': 'gzip' } });
    check("the page's files have versioned URLs that browsers keep, gzipped",
      /^\/assets\/v\/[0-9a-f]{12}\/app\.js$/.test(src) && /immutable/.test(res.headers.get('cache-control') ?? '')
        && res.headers.get('content-encoding') === 'gzip' && (await res.text()).includes('function render'), src);

    const pctx2 = await hub2.context(browser, { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const ph = await pctx2.newPage();
    await ph.goto(hub2.base);
    check('phone: categories head the home screen too', await until(async () => (await ph.locator('#home .group-name').first().textContent()) === 'Work'));
  } finally {
    hub2.close();
    rmSync(extra, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  hub.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

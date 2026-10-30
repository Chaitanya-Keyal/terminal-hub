// End-to-end test. Installs terminal-hub into a throwaway home, runs ttyd and server.py on spare
// ports with three fake places (two separate tmux servers and an unreachable ssh host), and drives
// the page in Chromium, on a desktop and on a phone.
//
//   cd tests && npm ci && npx playwright install chromium && npm test
//
// Needs ttyd, tmux and python3. PLAYWRIGHT (a path to playwright's index.mjs) and CHROMIUM (a
// browser executable) override the defaults.
import http from 'node:http';
import { startHub, launch, until, sleep } from './harness.mjs';

let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && info ? `  (${info})` : ''}`);
  if (!ok) failures++;
};

const hub = await startHub({
  places: [{ key: 'laptop', label: 'laptop', colour: '#7ee787' }, { key: 'server', label: 'server', colour: '#ff7b72' }],
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
  check('the previous session stays connected in the background', clients('laptop').includes('alpha'));
  await row(page, 'alpha').locator('.row-main').click();
  check('switching back reuses the connection', await until(() => row(page, 'alpha').evaluate(el => el.classList.contains('focused'))) && clients('laptop').filter(s => s === 'alpha').length === 1);

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

  tmux('laptop', 'new-session', '-d', '-s', 'my notes');  // tmux allows the space; the hub can't attach to it
  check("a session the hub can't open is dimmed", await until(() => row(page, 'my notes').evaluate(el => el.classList.contains('off'))));
  await row(page, 'my notes').locator('.row-main').click();
  check('... and a click explains, without connecting', await until(async () => (await page.locator('#toast').textContent()).includes('rename it'))
    && (await page.locator('#panes .pane').count()) === 1 && !clients('laptop').includes('my notes'));
  tmux('laptop', 'kill-session', '-t', 'my notes');

  await page.locator('#sidebar .place', { hasText: 'server' }).locator('.icon-btn.add').click();
  check('"+" opens a name field, focused', await until(() => page.locator('.create-input').evaluate(el => el === document.activeElement)));
  await page.keyboard.type('work\n');
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

  tmux('server', 'kill-session', '-t', 'shell');
  check('a session that ends closes its pane, with a note', await until(async () => (await page.locator('#toast').textContent()).includes('shell ended')));

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
  await phone.locator('#topbar .back').tap();
  await phone.locator('.home-head .icon-btn').tap();
  const before = await phone.locator('.stepper .value').textContent();
  await phone.locator('.stepper .icon-btn').last().tap();
  check('phone: settings change the text size', await until(async () => Number(await phone.locator('.stepper .value').textContent()) === Number(before) + 1));
  await pctx.close();
} finally {
  await browser.close();
  hub.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

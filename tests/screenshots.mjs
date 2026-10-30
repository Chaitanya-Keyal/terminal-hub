// Screenshots of a demo hub (made-up places and sessions), for reviewing the UI and for the README.
//   node screenshots.mjs OUT_DIR            every view, as separate PNGs
//   node screenshots.mjs --readme           also writes ../docs/screenshot.png and ../docs/desktop.png
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHub, launch, until, sleep, REPO } from './harness.mjs';

const readme = process.argv.includes('--readme');
const out = process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(REPO, 'tests/shots');
mkdirSync(out, { recursive: true });

const hub = await startHub({
  places: [
    { key: 'laptop', label: 'laptop', colour: '#7ee787' },
    { key: 'server', label: 'server', colour: '#ff7b72' },
    { key: 'bot', label: 'bot', colour: '#d2a8ff' },
  ],
  homeFiles: { '.bash_profile': "PS1='\\[\\e[38;5;245m\\]\\W\\[\\e[0m\\] $ '\n", '.hushlogin': '' },
  // A category that spans two places, and an icon for each place.
  extraConfig: ['icon laptop laptop', 'icon server server', 'icon bot bot',
    "category shop Shop rocket 'laptop:api' 'laptop:web' 'server:deploy'"],
});
const { tmux } = hub;
// Each demo session runs a little script, then leaves a shell.
let n = 0;
function run(key, name, script, dir = '/tmp') {
  const file = join(hub.home, `demo-${++n}.sh`);
  writeFileSync(file, `${script}\nexec bash -l\n`);
  tmux(key, 'new-session', '-d', '-s', name, '-c', dir, `bash ${file}`);
}
const now = Math.floor(Date.now() / 1000);

run('laptop', 'api', String.raw`printf '%b\n' '\e[38;5;245mapi\e[0m $ npm test' '' '> api@1.4.0 test' '> node --test' '' \
  '  \e[32m✔\e[0m lists sessions on every place \e[38;5;245m(12ms)\e[0m' \
  '  \e[32m✔\e[0m attaches, and creates a missing session \e[38;5;245m(31ms)\e[0m' \
  '  \e[32m✔\e[0m says why a session closed \e[38;5;245m(8ms)\e[0m' \
  '  \e[32m✔\e[0m refuses other origins \e[38;5;245m(4ms)\e[0m' \
  '  \e[32m✔\e[0m keeps hidden terminals connected \e[38;5;245m(22ms)\e[0m' '' \
  '\e[32mℹ tests 5 · pass 5 · fail 0\e[0m' ''`, REPO);
tmux('laptop', 'set-option', '-t', 'api', '@hub-state', 'working');
run('laptop', 'web', `cd ${REPO}/web && vim -c 'syntax on' -c 'set nonumber nowrap laststatus=0' app.css`, REPO);
tmux('laptop', 'new-window', '-t', 'web');
tmux('laptop', 'select-window', '-t', 'web:0');
run('laptop', 'notes', `cd ${REPO} && ls --color=always && echo && git log --oneline -6 --color=always`, REPO);
run('server', 'logs', String.raw`for p in /api/sessions /api/health /login /api/me /api/sessions /api/health /api/sessions /login; do
  printf '\e[38;5;245m%s\e[0m  GET %-14s \e[32m200\e[0m  %sms\n' "$(date +%H:%M:%S)" "$p" $((RANDOM % 9 + 1))
done`);
run('server', 'deploy', String.raw`printf '%b\n' '\e[38;5;245mdeploy\e[0m $ ./deploy.sh' 'building…' 'pushing image 3f2a9c1' 'restarting web (2 replicas)' '\e[32mdeployed in 41s\e[0m'`);
tmux('server', 'set-option', '-t', 'deploy', '@hub-state', 'done');
tmux('server', 'set-option', '-t', 'deploy', '@hub-state-at', String(now + 60));
run('bot', 'agent', String.raw`printf '%b\n' 'Plan: rename the config keys' '  1. update the parser' '  2. migrate old config files' '' '\e[33mAllow edits to config.example?\e[0m [y/n]'`);
tmux('bot', 'set-option', '-t', 'agent', '@hub-state', 'waiting');

const browser = await launch();
const shot = async (page, name) => { await sleep(700); await page.screenshot({ path: join(out, `${name}.png`) }); console.log(`${name}.png`); };
const settle = page => until(() => page.evaluate(() => document.fonts.status === 'loaded'), 5000);
const rowMain = (page, name, scope = '#sidebar') =>
  page.locator(`${scope} .row`).filter({ has: page.locator('.row-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.row-main');

try {
  // Desktop
  const ctx = await hub.context(browser, { viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(hub.base);
  await until(() => page.locator('#sidebar .row-name', { hasText: 'agent' }).isVisible());
  await settle(page);
  await shot(page, 'desktop-empty-first');
  await rowMain(page, 'notes').click();
  await rowMain(page, 'api').click();
  await shot(page, 'desktop-one');
  await rowMain(page, 'logs').click({ modifiers: ['Shift'] });
  await shot(page, 'desktop-two');
  await rowMain(page, 'web').click({ modifiers: ['Shift'] });
  await rowMain(page, 'agent').click({ modifiers: ['Shift'] });
  await shot(page, 'desktop-four');
  for (let i = 0; i < 3; i++) await page.locator('.pane-head .icon-btn').first().click();
  await rowMain(page, 'api').click();
  await page.locator('#sidebar .place', { hasText: 'server' }).locator('.icon-btn.add').click();
  await page.keyboard.type('migr');
  await shot(page, 'desktop-create');
  await page.keyboard.press('Escape');
  await page.locator('.side-foot .icon-btn[title="Keyboard shortcuts"]').click();
  await shot(page, 'desktop-help');
  await page.mouse.click(900, 400);
  // The README's desktop: tests, an agent waiting for an answer, and logs.
  await rowMain(page, 'agent').click({ modifiers: ['Shift'] });
  await rowMain(page, 'logs').click({ modifiers: ['Shift'] });
  await page.mouse.move(1000, 700);
  await sleep(500);
  await page.screenshot({ path: join(out, 'readme-desktop.png') });
  await ctx.close();

  // Phone
  const pctx = await hub.context(browser, { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await pctx.newPage();
  await phone.goto(hub.base);
  await until(() => phone.locator('#home .row-name', { hasText: 'agent' }).isVisible());
  await settle(phone);
  await rowMain(phone, 'notes', '#home').tap();
  await phone.locator('#topbar .back').tap();
  await shot(phone, 'phone-home');
  await rowMain(phone, 'api', '#home').tap();
  await shot(phone, 'phone-session');
  await phone.locator('#topbar .back').tap();
  await phone.locator('#home .place', { hasText: 'laptop' }).locator('.icon-btn.add').tap();
  await phone.keyboard.type('fix-login');
  await shot(phone, 'phone-create');
  await phone.locator('.create .icon-btn').tap();
  await phone.locator('.home-head .icon-btn').tap();
  await shot(phone, 'phone-settings');
  await phone.locator('.sheet-wrap').click({ position: { x: 10, y: 10 } });
  await rowMain(phone, 'web', '#home').tap();
  await sleep(500);
  await phone.screenshot({ path: join(out, 'readme-phone-session.png') });
  await phone.locator('#topbar .back').tap();
  await sleep(300);
  await phone.screenshot({ path: join(out, 'readme-phone-home.png') });
  await pctx.close();

  if (readme) {
    // Frame the shots (rounded corners, a thin border) on a transparent background.
    const img = f => `data:image/png;base64,${readFileSync(join(out, f)).toString('base64')}`;
    const frame = (src, w) => `<img src="${src}" style="width:${w}px;display:block;border-radius:22px;border:1px solid #30363d">`;
    const page2 = await browser.newPage({ deviceScaleFactor: 2 });
    await page2.setContent(`<body style="margin:0;background:transparent"><div id="c" style="display:inline-flex;gap:32px;padding:2px">
      ${frame(img('readme-phone-home.png'), 390)}${frame(img('readme-phone-session.png'), 390)}</div></body>`);
    await page2.locator('#c').screenshot({ path: join(REPO, 'docs/screenshot.png'), omitBackground: true });
    await page2.setContent(`<body style="margin:0;background:transparent"><div id="c" style="display:inline-block;padding:2px">
      ${frame(img('readme-desktop.png'), 1440).replace('22px', '14px')}</div></body>`);
    await page2.locator('#c').screenshot({ path: join(REPO, 'docs/desktop.png'), omitBackground: true });
    console.log('docs/screenshot.png, docs/desktop.png');
  }
} finally {
  await browser.close();
  hub.close();
}

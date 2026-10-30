// A throwaway terminal hub for tests and screenshots: installs terminal-hub into a temporary home,
// makes each place its own tmux server, and runs ttyd and server.py on spare ports.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() > end) return false;
    await sleep(150);
  }
}

const freePort = () => new Promise(res => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

/**
 * places: [{key, label, colour, tmuxConf?}] are fake places (each its own tmux server, reached
 * with `via env TMUX_TMPDIR=… bash -c`); extraConfig: more config lines (say an unreachable place).
 */
export async function startHub({ places, extraConfig = [], homeFiles = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const dirs = {};
  const lines = [];
  for (const p of places) {
    dirs[p.key] = { sock: join(home, `tmux-${p.key}`), home: join(home, `home-${p.key}`) };
    mkdirSync(dirs[p.key].sock, { mode: 0o700 });
    mkdirSync(dirs[p.key].home);
    writeFileSync(join(dirs[p.key].home, '.tmux.conf'), p.tmuxConf ?? 'set -g status off\n');
    for (const [name, text] of Object.entries(homeFiles)) writeFileSync(join(dirs[p.key].home, name), text);
    lines.push(`place ${p.key} ${p.label} '${p.colour}' via env TMUX_TMPDIR=${dirs[p.key].sock} HOME=${dirs[p.key].home} bash -c`);
  }
  mkdirSync(join(home, '.config/terminal-hub'), { recursive: true });
  writeFileSync(join(home, '.config/terminal-hub/config'), [...lines, ...extraConfig].join('\n') + '\n');
  // Without TMUX and TMUX_PANE: run from inside tmux, they'd point every tmux command here (even
  // kill-server) at your own tmux server instead of the test places.
  const { TMUX, TMUX_PANE, ...outside } = process.env;
  const env = { ...outside, HOME: home, TERM: 'xterm-256color', XDG_RUNTIME_DIR: home };
  execFileSync(join(REPO, 'install.sh'), ['--no-services'], { env, stdio: 'ignore' });

  const tmux = (key, ...args) => {
    try {
      return execFileSync('tmux', args, {
        env: { ...outside, TMUX_TMPDIR: dirs[key].sock, HOME: dirs[key].home, TERM: 'xterm-256color' }, encoding: 'utf8',
      }).trim();
    } catch { return ''; }
  };

  const [ttydPort, assetPort] = [await freePort(), await freePort()];
  const share = join(home, '.local/share/terminal-hub');
  const procs = [
    spawn('ttyd', ['--interface', '127.0.0.1', '--port', String(ttydPort), '--writable', '--check-origin', '--url-arg',
      '--index', join(share, 'index.html'), join(home, '.local/bin/terminal-hub')], { env, stdio: 'ignore' }),
    spawn('python3', [join(share, 'server.py'), String(assetPort), join(share, 'assets')], { env, stdio: 'ignore' }),
  ];
  const base = `http://127.0.0.1:${ttydPort}`;
  await until(() => fetch(base).then(r => r.ok), 5000);

  // A browser context that sends /assets to server.py, like `tailscale serve` does.
  async function context(browser, options = {}) {
    const ctx = await browser.newContext(options);
    await ctx.route('**/assets/**', async route => {
      const u = new URL(route.request().url());
      try {
        await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${assetPort}${u.pathname.replace(/^\/assets/, '')}${u.search}` }) });
      } catch {
        await route.abort().catch(() => {});  // the page closed while its request was on the way
      }
    });
    await ctx.addInitScript(() => localStorage.setItem('hub.renderer', '"dom"'));
    return ctx;
  }

  function close() {
    for (const p of procs) p.kill();
    for (const key of Object.keys(dirs)) tmux(key, 'kill-server');
    rmSync(home, { recursive: true, force: true });
  }

  return { base, home, tmux, context, close };
}

export async function launch() {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
  return chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
}

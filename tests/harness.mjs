// A throwaway terminal hub for tests and screenshots: installs terminal-hub into a temporary home,
// makes each place its own tmux server, runs ttyd and server.py on spare ports, and puts a small
// proxy in front that sends /assets to server.py and the rest to ttyd, as `tailscale serve` does.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';

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
    dirs[p.key] = { sock: join(home, `tmux-${p.key}`), home: join(home, `home-${p.key}`), tmp: join(home, `tmp-${p.key}`) };
    mkdirSync(dirs[p.key].sock, { mode: 0o700 });
    mkdirSync(dirs[p.key].home);
    mkdirSync(dirs[p.key].tmp);  // where files sent from the page land
    writeFileSync(join(dirs[p.key].home, '.tmux.conf'), p.tmuxConf ?? 'set -g status off\n');
    for (const [name, text] of Object.entries(homeFiles)) writeFileSync(join(dirs[p.key].home, name), text);
    lines.push(`place ${p.key} ${p.label} '${p.colour}' via env TMUX_TMPDIR=${dirs[p.key].sock} HOME=${dirs[p.key].home} TMPDIR=${dirs[p.key].tmp} bash -c`);
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
  await until(() => fetch(`http://127.0.0.1:${ttydPort}`).then(r => r.ok), 5000);

  // The proxy: /assets/X → server.py's /X, anything else (and websockets) → ttyd, Host kept.
  const proxy = http.createServer((req, res) => {
    const assets = req.url?.startsWith('/assets/');
    const up = http.request({
      host: '127.0.0.1', port: assets ? assetPort : ttydPort, method: req.method, headers: req.headers,
      path: assets ? req.url.slice('/assets'.length) : req.url,
    }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());  // an event stream ends when the page goes
    req.pipe(up);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const up = net.connect(ttydPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  const proxyPort = await freePort();
  await new Promise(r => proxy.listen(proxyPort, '127.0.0.1', () => r(null)));
  const base = `http://127.0.0.1:${proxyPort}`;

  // A browser context for this hub (the DOM renderer: headless WebGL draws at the wrong scale).
  async function context(browser, options = {}) {
    const ctx = await browser.newContext(options);
    await ctx.addInitScript(() => localStorage.setItem('hub.renderer', '"dom"'));
    return ctx;
  }

  function close() {
    proxy.closeAllConnections?.();
    proxy.close();
    for (const p of procs) p.kill();
    for (const key of Object.keys(dirs)) tmux(key, 'kill-server');
    rmSync(home, { recursive: true, force: true });
  }

  return { base, assets: `http://127.0.0.1:${assetPort}`, home, tmux, context, close };
}

export async function launch() {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
  return chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
}

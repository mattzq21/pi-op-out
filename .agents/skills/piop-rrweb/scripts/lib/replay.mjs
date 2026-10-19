// Build a self-contained replay viewer and verify it in headless Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureBundles } from './bundles.mjs';
import { markers } from './mirror.mjs';

const escapeScript = s => s.replace(/<\/script/gi, '<\\/script');

export function buildViewer(events, outDir, { title = 'piop rrweb replay' } = {}) {
  const bundles = ensureBundles();
  const lib = fs.readFileSync(bundles.replay, 'utf8');
  const css = fs.readFileSync(bundles.replayCss, 'utf8');
  const marks = markers(events).filter(m => m.tag === 'mark').map(m => ({ label: m.payload?.label ?? m.tag, offsetMs: m.offsetMs }));
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>${css}
body{margin:0;background:#1e1e1e;color:#eee;font:13px system-ui,sans-serif}
#bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px}
#bar button{font:inherit}
#root{transform-origin:0 0}
</style>
<div id="bar"><button onclick="replayer.play()">Play</button><button onclick="replayer.pause()">Pause</button>
<label>speed <select onchange="replayer.setConfig({speed:Number(this.value)})"><option>1</option><option>2</option><option>4</option><option>8</option></select></label>
<span id="marks"></span><span id="status"></span></div>
<div id="root"></div>
<script>${escapeScript(lib)}</script>
<script>
window.events = ${escapeScript(JSON.stringify(events))};
window.markers = ${JSON.stringify(marks)};
window.finished = false;
window.replayer = new rrwebReplay.Replayer(window.events, { root: document.getElementById('root'), mouseTail: false, showWarning: true, skipInactive: false });
window.replayer.on('finish', () => { window.finished = true; document.getElementById('status').textContent = ' finished'; });
for (const m of window.markers) { const b = document.createElement('button'); b.textContent = m.label + ' @' + (m.offsetMs / 1000).toFixed(2) + 's'; b.onclick = () => replayer.pause(m.offsetMs); document.getElementById('marks').append(b); }
setInterval(() => { if (!window.finished) document.getElementById('status').textContent = ' ' + (replayer.getCurrentTime() / 1000).toFixed(2) + 's'; }, 200);
if (location.hash === '#autoplay') window.replayer.play();
</script>`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'replay.html');
  fs.writeFileSync(file, html);
  return { file, marks };
}

function findChromium() {
  if (process.env.PIOP_RRWEB_CHROMIUM) return process.env.PIOP_RRWEB_CHROMIUM;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const exe = path.join(cache, d, sub, 'chrome');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
      const exe = path.join(dir, name);
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No Chromium found. Set PIOP_RRWEB_CHROMIUM to a chrome executable.');
}

function loadPlaywright() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), path.resolve(here, '../../../../..')];
  for (const dir of candidates) {
    try { return createRequire(path.join(dir, 'noop.js'))('playwright-core'); } catch {}
  }
  throw new Error('playwright-core not found; run from the Piop checkout (it is a devDependency).');
}

function serve(dir) {
  const types = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// points: [{ label, offsetMs }]. selectors: CSS selectors to describe inside the replayed document at each point.
export async function verifyViewer(viewerFile, { points = [], selectors = [], speed = 4, durationMs, viewport = [1400, 900] }) {
  const dir = path.dirname(viewerFile);
  const { server, port } = await serve(dir);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const result = { viewer: viewerFile, chromium: findChromium(), points: [], console: [], pageErrors: [], failedRequests: [], finished: false };
  try {
    const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] } });
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) result.console.push(m.type() + ': ' + m.text().slice(0, 200)); });
    page.on('pageerror', e => result.pageErrors.push(String(e.message).slice(0, 300)));
    page.on('requestfailed', r => result.failedRequests.push(r.url().slice(0, 160)));
    page.on('response', r => { if (r.status() >= 400) result.failedRequests.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`); });
    await page.goto(`http://127.0.0.1:${port}/${path.basename(viewerFile)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.replayer, null, { timeout: 30000 });
    const describe = async () => page.evaluate(sels => {
      const doc = window.replayer.iframe.contentDocument;
      const facts = { currentTimeMs: Math.round(window.replayer.getCurrentTime()), nodes: doc ? doc.querySelectorAll('*').length : 0, selectors: {} };
      for (const sel of sels) {
        const el = doc && doc.querySelector(sel);
        if (!el) { facts.selectors[sel] = { present: false }; continue; }
        const r = el.getBoundingClientRect();
        facts.selectors[sel] = { present: true, text: (el.innerText || el.textContent || '').trim().slice(0, 120), value: 'value' in el ? String(el.value).slice(0, 120) : undefined, rect: [r.x, r.y, r.width, r.height].map(v => Math.round(v)),
          scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, attrs: Object.fromEntries([...el.attributes].filter(a => a.name !== 'style' || a.value.length < 200).map(a => [a.name, a.value.slice(0, 120)])) };
      }
      return facts;
    }, selectors);
    const seen = new Set();
    for (const [index, point] of points.entries()) {
      await page.evaluate(ms => window.replayer.pause(ms), point.offsetMs);
      await page.waitForTimeout(400);
      const facts = await describe();
      const safe = String(point.label).replace(/[^\w.-]+/g, '_').slice(0, 60);
      const screenshot = path.join(dir, `replay-${String(index + 1).padStart(2, '0')}-${safe}.png`);
      await page.screenshot({ path: screenshot });
      for (const [sel, f] of Object.entries(facts.selectors)) if (f.present) seen.add(sel);
      result.points.push({ label: point.label, offsetMs: point.offsetMs, clamped: point.clamped || undefined, screenshot, ...facts });
    }
    result.selectorsNeverPresent = selectors.filter(s => !seen.has(s));
    await page.evaluate(s => { window.replayer.setConfig({ speed: s }); window.replayer.play(0); }, speed);
    const started = Date.now();
    const budget = Math.ceil((durationMs ?? 60000) / speed) + 15000;
    try {
      await page.waitForFunction(() => window.finished, null, { timeout: budget });
      result.finished = true;
    } catch {
      result.finished = false;
    }
    result.playbackWallMs = Date.now() - started;
    result.final = await describe();
  } finally {
    await browser.close();
    server.close();
  }
  result.ok = result.finished && result.pageErrors.length === 0;
  return result;
}

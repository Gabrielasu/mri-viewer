/*
 * End-to-end test: serves the app, drives headless Chrome over the DevTools
 * protocol, loads a real disc ISO through the app's intake path, and verifies
 * the rendered viewport. Saves screenshots to test/artifacts/.
 *
 * Usage: ISO_DIR=/path/to/private/discs node test/e2e-chrome.js
 * Env: ISO_PATH may select one ISO directly; otherwise the smallest ISO in
 * ISO_DIR is used so this test does not encode any patient-specific filename.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const ISO_PATH = (() => {
  if (process.env.ISO_PATH) return path.resolve(process.env.ISO_PATH);
  if (!process.env.ISO_DIR) throw new Error('Set ISO_DIR or ISO_PATH to a private ISO file');
  const candidates = fs.readdirSync(process.env.ISO_DIR)
    .filter((name) => /\.iso$/i.test(name))
    .map((name) => path.join(process.env.ISO_DIR, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  if (!candidates.length) throw new Error(`No ISO files found in ${process.env.ISO_DIR}`);
  return candidates[0];
})();
const ISO_NAME = path.basename(ISO_PATH);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8791;
const CDP_PORT = 9333;

function serve() {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.iso': 'application/octet-stream' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file;
    if (url === '/test.iso') file = ISO_PATH;
    else file = path.join(ROOT, url === '/' ? 'index.html' : url.slice(1));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  fs.mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
  const server = await serve();
  const profile = fs.mkdtempSync('/tmp/chrome-e2e-');
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 50 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 200));
      targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
    }
    const page = targets.find((t) => t.type === 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // Verify the actual delivery mode first: double-clicking index.html in
    // Finder, without a development server.
    await cdp.send('Page.navigate', { url: pathToFileURL(path.join(ROOT, 'index.html')).href });
    await new Promise((r) => setTimeout(r, 1200));

    const evalJs = (expr, timeout = 300000) =>
      cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout });

    // page loads without errors, welcome visible
    const boot = await evalJs(`(async () => ({
      hasHooks: !!(window.__test && window.ISO9660 && window.DICOM && window.RENDER && window.STACK && window.DICOMDIR),
      welcomeVisible: getComputedStyle(document.querySelector('#welcome')).display !== 'none',
    }))()`);
    check('app boots with all modules', boot.result.value.hasHooks);
    check('welcome screen visible', boot.result.value.welcomeVisible);

    // Use the local server only to make a private test ISO available to the
    // browser automation process, then exercise the real window drop handler.
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await new Promise((r) => setTimeout(r, 1200));

    // load the real ISO through the app's own intake path
    console.log('  … loading private ISO through the app (this reads the whole ISO over HTTP)');
    const isoUrl = JSON.stringify('/test.iso');
    const isoName = JSON.stringify(ISO_NAME);
    const load = await evalJs(`(async () => {
      const resp = await fetch(${isoUrl});
      const blob = await resp.blob();
      const file = new File([blob], ${isoName});
      const transfer = new DataTransfer();
      transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      // wait for the auto-opened series to display
      for (let i = 0; i < 300; i++) {
        const c = window.__test.getCurrent();
        const vp = window.__test.getViewport();
        if (c.series && vp.slice) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const c = window.__test.getCurrent();
      const vp = window.__test.getViewport();
      const patients = [...window.__test.model.patients.values()];
      return {
        patients: patients.length,
        studies: patients.reduce((n,p) => n + p.studies.size, 0),
        series: patients.reduce((n,p) => n + [...p.studies.values()].reduce((m,s) => m + s.series.size, 0), 0),
        images: patients.reduce((n,p) => n + [...p.studies.values()].reduce((m,s) => m + [...s.series.values()].reduce((k,x) => k + x.instances.length, 0), 0), 0),
        currentSeries: c.series ? c.series.description : null,
        stackLen: c.series ? c.series.sorted.length : 0,
        sliceIndex: c.index,
        hasSlice: !!vp.slice,
        wc: vp.wc, ww: vp.ww,
        sidebarCards: document.querySelectorAll('.series-card').length,
      };
    })()`);
    const r = load.result.value;
    check('at least one patient indexed', r && r.patients > 0, JSON.stringify(r));
    check('at least one study and series indexed', r && r.studies > 0 && r.series > 0, JSON.stringify(r));
    check('DICOM images indexed', r && r.images > 0, JSON.stringify(r));
    check('a series auto-opened with a rendered slice', r && r.hasSlice && r.stackLen > 0,
      JSON.stringify(r));
    check('sidebar card count matches indexed series', r && r.sidebarCards === r.series, JSON.stringify(r));

    // canvas actually shows an image (non-trivial pixel variance)
    const pix = await evalJs(`(() => {
      const c = document.querySelector('#view-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0, sum2 = 0, n = 0, nonBlack = 0;
      for (let i = 0; i < d.length; i += 40) {
        const v = d[i];
        sum += v; sum2 += v * v; n++;
        if (v > 8) nonBlack++;
      }
      const mean = sum / n;
      return { mean, std: Math.sqrt(sum2 / n - mean * mean), nonBlackFrac: nonBlack / n, w: c.width, h: c.height };
    })()`);
    const p = pix.result.value;
    check('canvas renders image content', p && p.std > 10 && p.nonBlackFrac > 0.03, JSON.stringify(p));

    // scroll through slices; verify content changes
    const nav = await evalJs(`(async () => {
      const c = document.querySelector('#view-canvas');
      const ctx = c.getContext('2d');
      const grab = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 400) s += d[i]; return s; };
      const before = grab();
      const c0 = window.__test.getCurrent().index;
      const len = window.__test.getCurrent().series.sorted.length;
      const target = Math.min(c0 + 5, len - 1);
      await window.__test.showSlice(c0 + 5);
      await new Promise(r => setTimeout(r, 400));
      const after = grab();
      return { before, after, target, idxAfter: window.__test.getCurrent().index };
    })()`);
    const nv = nav.result.value;
    check('slice navigation changes rendered image',
      nv && nv.idxAfter === nv.target && nv.before !== nv.after, JSON.stringify(nv));

    // switch to another series when the disc contains one
    const sw = await evalJs(`(async () => {
      const patients = [...window.__test.model.patients.values()];
      const allSeries = patients.flatMap(p => [...p.studies.values()].flatMap(s => [...s.series.values()]));
      const next = allSeries.find(s => s !== window.__test.getCurrent().series) || allSeries[0];
      await window.__test.openSeries(next);
      const cur = window.__test.getCurrent();
      return { desc: cur.series.description, len: cur.series.sorted.length };
    })()`);
    check('switching series works', sw.result.value && sw.result.value.len > 0,
      JSON.stringify(sw.result.value));

    if (process.env.SAVE_SCREENSHOT === '1') {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, 'artifacts/e2e-viewer.png'), Buffer.from(shot.data, 'base64'));
      console.log('  private screenshot saved under ignored test/artifacts/');
    }

    console.log(failed ? `\n${failed} FAILURES` : '\nE2E: all checks passed');
  } finally {
    if (chrome.exitCode == null && chrome.signalCode == null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill('SIGKILL');
      await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

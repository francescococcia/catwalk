// node render.mjs <spec.json> stills 0.5,3,7 <out_dir>
// node render.mjs <spec.json> video <out.mp4> [fps]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const [specPath, mode, a, b] = process.argv.slice(2);
const SPEC = path.resolve(specPath);
const SPECJ = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const INSERT = SPECJ.insert?.file, STYLE = SPECJ.style_clip?.file;
const VW = 720, VH = 1560;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.json': 'application/json', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = u === '/__spec.json' ? SPEC : u === '/__insert.webm' && INSERT ? INSERT : u === '/__style.webm' && STYLE ? STYLE : path.join(ROOT, u);
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    const type = types[path.extname(p)] || 'application/octet-stream';
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { // media elements need byte ranges to seek
      const s = +m[1], e2 = m[2] ? Math.min(+m[2], d.length - 1) : d.length - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e2}/${d.length}`, 'content-length': e2 - s + 1 });
      res.end(d.subarray(s, e2 + 1)); return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': d.length }); res.end(d);
  });
}).listen(0);
const port = server.address().port;
const GL = process.env.GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu'];
const browser = await chromium.launch({ args: [...GL, '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${port}/index.html?render=1&spec=/__spec.json`);
await page.waitForFunction(() => window.renderAt && window.ready, null, { timeout: 60000 });
const shot = (type = 'png') => page.screenshot({ clip: { x: 0, y: 0, width: VW, height: VH }, type, ...(type === 'jpeg' ? { quality: 92 } : {}) });

if (mode === 'stills') {
  fs.mkdirSync(b, { recursive: true });
  for (const t of a.split(',').map(Number)) {
    await page.evaluate(t => window.renderAt(t), t);
    fs.writeFileSync(path.join(b, `t_${t.toFixed(2).padStart(6, '0')}.png`), await shot());
  }
} else {
  const fps = Number(b || 30), dur = await page.evaluate(() => window.DURATION);
  const n1 = Math.floor(dur * fps);
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', a], { stdio: ['pipe', 'inherit', 'inherit'] });
  const T0 = Date.now();
  for (let n = 0; n < n1; n++) {
    await page.evaluate(t => window.renderAt(t), n / fps);
    const buf = await shot('jpeg');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (n % 90 === 0) console.log(`${path.basename(a)} frame ${n}/${n1} ${((Date.now() - T0) / (n + 1)).toFixed(0)} ms/frame`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
}
await browser.close();
server.close();

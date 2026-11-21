// DevTok reel renderer: an "architecture diagram tour" driven by one reel's shot plan (from the pipeline manifest).
// Everything is a pure function of t, so any frame can be rendered on its own: window.renderAt(t).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeCat, ARM_A, ARM_B } from './cat.js';
import { glowTexture } from './textures.js';
import { clamp, lerp, smooth, easeInOut, easeOut, range, V, ikArm } from './anim.js';

const W = 720, H = 1560; // ~19.5:9, the shape of current iPhones (no side cropping with aspect-fill)
const qs = new URLSearchParams(location.search);
const spec = await (await fetch(qs.get('spec') || 'spec.json')).json();
await Promise.all(['700 40px Inter', '600 30px Inter', '800 40px Cap', '500 20px Mono'].map(f => document.fonts.load(f)));

const reel = spec.reel, graph = spec.graph, words = spec.words || [];
const DURATION = spec.duration;
const ROLE = spec.role;
const INS = spec.insert || null; // {file, t0, t1, style} — a skill clip shown as a card
const STY = spec.style_clip || null; // {file, t0, t1, style} — a whole reel in a skill's style (clip full screen, slowed to the narration)
const styleVideo = document.getElementById('sty');
if (STY) {
  styleVideo.src = '/__style.webm';
  await new Promise(r => { styleVideo.onloadeddata = r; styleVideo.onerror = r; styleVideo.load(); });
  document.getElementById('styWrap').style.display = 'block';
}
const insVideo = document.getElementById('ins');
if (INS) {
  insVideo.src = '/__insert.webm';
  await new Promise(r => { insVideo.onloadeddata = r; insVideo.onerror = r; insVideo.load(); });
  document.getElementById('insTag').textContent = { graph: '📈 by the numbers', 'dan-koe': '🌳 blast radius', 'minimalistic-graphics': '🪜 step by step' }[INS.style] || '';
}

// ---------------------------------------------------------------- renderer + post
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
{ // bright studio sky gradient (Zach-style blue)
  const sky = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 p; void main(){ float y = normalize(p).y; vec3 a = vec3(0.56,0.78,0.98), b = vec3(0.17,0.45,0.86); gl_FragColor = vec4(mix(a, b, smoothstep(-0.05, 0.6, y)), 1.); }',
  }));
  scene.add(sky);
}
const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 400);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.HalfFloatType }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.3, 0.4, 1.05);
composer.addPass(bloom);
composer.addPass(new OutputPass());

scene.add(new THREE.HemisphereLight(0xe6f1ff, 0x6d82a0, 0.55));
const sun = new THREE.DirectionalLight(0xfff4e8, 1.7);
sun.position.set(-6, 12, 8); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- layout (longest-path layers, back to front)
const comps = graph.components, edges = graph.edges.filter(e => e.from !== e.to);
const layer = Object.fromEntries(comps.map(c => [c.id, 0]));
for (let k = 0; k < comps.length; k++) for (const e of edges) if (layer[e.from] + 1 > layer[e.to] && layer[e.from] < 5) layer[e.to] = layer[e.from] + 1;
const rows = [];
for (const c of comps) (rows[layer[c.id]] ||= []).push(c);
const ROWS = rows.filter(Boolean);
const pos = {};
ROWS.forEach((row, r) => row.forEach((c, i) => {
  pos[c.id] = V((i - (row.length - 1) / 2) * 2.35 + (r % 2 ? 0.35 : -0.35), 0, (r - (ROWS.length - 1) / 2) * 2.6);
}));
const center = new THREE.Vector3(); comps.forEach(c => center.add(pos[c.id])); center.divideScalar(comps.length);
const span = Math.max(...comps.map(c => Math.abs(pos[c.id].x - center.x))) * 2 + 2.4;
const depth = Math.max(...comps.map(c => Math.abs(pos[c.id].z - center.z))) * 2 + 2;

// floor with a faint blueprint grid
{
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#c9d8ea'; g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = 'rgba(40,90,160,0.18)'; g.lineWidth = 2;
  for (let i = 0; i <= 1024; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.moveTo(0, i); g.lineTo(1024, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 10);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2; floor.position.copy(center).setY(0); floor.receiveShadow = true; scene.add(floor);
}

// ---------------------------------------------------------------- components: rounded blocks + label billboards
const KIND = {
  external: [0x8e5bd8, 'cloud'], store: [0xf08a3e, 'db'], ui: [0xf0507e, 'phone'], test: [0x3bbf7a, 'check'],
  service: [0x3d7be8, 'server'], job: [0x2bb3b8, 'gear'], config: [0x7d8aa6, 'sliders'], module: [0x25a7c9, 'box'],
};
function iconPath(g, kind, x, y, s) { // tiny vector icons drawn on canvas
  g.save(); g.translate(x, y); g.scale(s, s); g.lineWidth = 3; g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  if (kind === 'cloud') { g.beginPath(); g.arc(-8, 4, 9, Math.PI * 0.5, Math.PI * 1.5); g.arc(2, -4, 11, Math.PI, 0); g.arc(12, 4, 8, Math.PI * 1.5, Math.PI * 0.5); g.closePath(); g.fill(); }
  else if (kind === 'db') { for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(0, -10 + i * 9, 13, 5, 0, 0, Math.PI * 2); g.stroke(); } g.beginPath(); g.moveTo(-13, -10); g.lineTo(-13, 8); g.moveTo(13, -10); g.lineTo(13, 8); g.stroke(); }
  else if (kind === 'phone') { g.strokeRect(-8, -14, 16, 28); g.fillRect(-3, 9, 6, 2); }
  else if (kind === 'check') { g.beginPath(); g.moveTo(-11, 0); g.lineTo(-3, 9); g.lineTo(12, -10); g.stroke(); }
  else if (kind === 'server') { for (let i = 0; i < 3; i++) { g.strokeRect(-13, -14 + i * 10, 26, 8); g.fillRect(6, -11 + i * 10, 3, 3); } }
  else if (kind === 'gear') { g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 2); g.stroke(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.beginPath(); g.moveTo(Math.cos(a) * 9, Math.sin(a) * 9); g.lineTo(Math.cos(a) * 14, Math.sin(a) * 14); g.stroke(); } }
  else if (kind === 'sliders') { for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-12, -9 + i * 9); g.lineTo(12, -9 + i * 9); g.stroke(); g.beginPath(); g.arc(-6 + i * 6, -9 + i * 9, 3, 0, 7); g.fill(); } }
  else { g.strokeRect(-12, -10, 24, 20); g.beginPath(); g.moveTo(-12, -10); g.lineTo(0, -2); g.lineTo(12, -10); g.stroke(); }
  g.restore();
}
function roleLine(c) {
  if (ROLE === 'paying_manager') return c.monthly_cost_usd ? `$${Math.round(c.monthly_cost_usd).toLocaleString('en-US')}/mo` : (c.vendor || (c.user_facing ? 'user-facing' : ''));
  if (ROLE === 'team_lead') return c.owner_team || (c.risk ? `risk: ${c.risk}` : '');
  return c.kind;
}
function labelSprite(c) {
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 220;
  const g = cv.getContext('2d');
  const [col, icon] = KIND[c.kind] || KIND.module;
  const hex = '#' + col.toString(16).padStart(6, '0');
  g.fillStyle = 'rgba(255,255,255,0.97)'; roundRect(g, 8, 8, 624, 150, 34); g.fill();
  g.fillStyle = hex; roundRect(g, 22, 22, 122, 122, 28); g.fill();
  iconPath(g, icon, 83, 83, 2.2);
  g.fillStyle = '#16202e'; g.font = '700 46px Inter';
  fitText(g, c.name, 166, 82, 450);
  g.fillStyle = '#5b6b80'; g.font = '600 30px Inter';
  fitText(g, roleLine(c) || '', 166, 126, 450);
  if (c.change === 'added' || c.change === 'modified') {
    g.fillStyle = c.change === 'added' ? '#2fbf6c' : '#f2a33a'; roundRect(g, 440, 150, 170, 56, 28); g.fill();
    g.fillStyle = '#fff'; g.font = '700 30px Inter'; g.textAlign = 'center'; g.fillText(c.change === 'added' ? 'NEW' : 'CHANGED', 525, 189); g.textAlign = 'left';
  }
  // tail
  g.fillStyle = 'rgba(255,255,255,0.97)'; g.beginPath(); g.moveTo(300, 157); g.lineTo(340, 157); g.lineTo(320, 190); g.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }));
  s.scale.set(LW, LW * 0.344, 1); s.renderOrder = 5;
  return s;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fitText(g, s, x, y, max) { let txt = s; while (g.measureText(txt).width > max && txt.length > 3) txt = txt.slice(0, -2); if (txt !== s) txt = txt.slice(0, -1) + '…'; g.fillText(txt, x, y); }

const LW = 0.36; // label width as a fraction of the screen height (fixed on screen)
const nodes = {};
for (const c of comps) {
  const [col] = KIND[c.kind] || KIND.module;
  const grp = new THREE.Group(); grp.position.copy(pos[c.id]); scene.add(grp);
  const mat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.3, emissive: new THREE.Color(col), emissiveIntensity: 0.05 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.55, 0.5, 1.05, 4, 0.14), mat);
  body.position.y = 0.25; body.castShadow = body.receiveShadow = true; grp.add(body);
  const top = new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.08, 0.75, 3, 0.04), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, transparent: true, opacity: 0.35 }));
  top.position.y = 0.53; grp.add(top);
  if (c.kind === 'external') { // a little cloud puff on top of external systems
    for (const [x, y, r] of [[-0.25, 0.62, 0.18], [0, 0.7, 0.24], [0.27, 0.62, 0.17]]) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })); m.position.set(x, y, 0); m.castShadow = true; grp.add(m); }
  }
  if (c.kind === 'store') for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 28), new THREE.MeshStandardMaterial({ color: 0xffe2c4, roughness: 0.4 })); m.position.set(0, 0.62 + i * 0.14, 0); m.castShadow = true; grp.add(m); }
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 64), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; ring.scale.set(1, 0.8, 1); grp.add(ring);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,220,90,1)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  glow.scale.set(3.2, 3.2, 1); glow.position.y = 0.3; grp.add(glow);
  const label = labelSprite(c); label.position.y = 1.15; grp.add(label);
  nodes[c.id] = { grp, body, mat, ring, glow, label, col: new THREE.Color(col) };
}

// ---------------------------------------------------------------- edges: tubes with arrow heads + packets
const edgeObjs = {};
const packetGeo = new THREE.SphereGeometry(0.075, 16, 12);
for (const e of edges) {
  const a = pos[e.from].clone().setY(0.22), b = pos[e.to].clone().setY(0.22);
  const dir = b.clone().sub(a).normalize();
  const a2 = a.clone().addScaledVector(dir, 0.85), b2 = b.clone().addScaledVector(dir, -0.9);
  const mid = a2.clone().lerp(b2, 0.5).setY(0.55 + a2.distanceTo(b2) * 0.08);
  const curve = new THREE.QuadraticBezierCurve3(a2, mid, b2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9fb3cc, roughness: 0.5, emissive: new THREE.Color(0x58c8ff), emissiveIntensity: 0 });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.035, 8, false), mat); tube.castShadow = true; scene.add(tube);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 16), mat);
  head.position.copy(curve.getPoint(1)); head.quaternion.setFromUnitVectors(V(0, 1, 0), curve.getTangent(1)); scene.add(head);
  const packets = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color: 0xfff3a0, toneMapped: false }));
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,230,120,1)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.set(0.5, 0.5, 1); m.add(s); scene.add(m); return m;
  });
  edgeObjs[e.id] = { e, curve, mat, packets };
}

// ---------------------------------------------------------------- the cat narrator
const CS = 0.95;
const cat = makeCat(); cat.root.scale.setScalar(CS); scene.add(cat.root);

// ---------------------------------------------------------------- shots -> camera / focus timeline
const shots = reel.shots.length ? reel.shots : [{ t_start: 0, t_end: DURATION, highlight_component_id: reel.focus_component_id, flow_edge_ids: [] }];
const brk = reel.break_it;
const refs = Object.fromEntries((reel.code_refs || []).map(r => [r.id, r]));
function shotAt(t) { let i = shots.findIndex(s => t < s.t_end); if (i < 0) i = shots.length - 1; return i; }
function focusOf(i) { const s = shots[i]; return nodes[s.highlight_component_id] ? s.highlight_component_id : reel.focus_component_id; }
function isOverview(i) { return i === 0 && (reel.order === 1 || reel.scene_type === 'diagram_tour'); }
function hasCode(i) { const s = shots[i]; return !isOverview(i) && !!(s.code_ref_id && refs[s.code_ref_id]); }
function camPose(i) {
  const s = Math.sin(i * 1.7) > 0 ? 1 : -1;
  if (isOverview(i)) {
    const dist = Math.max(span / (2 * Math.tan(THREE.MathUtils.degToRad(14.5))), depth * 1.5, 9);
    return { pos: center.clone().add(V(0, dist * 0.8, dist * 0.7)), look: center.clone().add(V(0, 0, 1.2)), fov: 48 };
  }
  const p = pos[focusOf(i)];
  const lookOff = hasCode(i) ? 2.6 : 0.8; // push the box up the frame when the code card is on screen
  return { pos: p.clone().add(V(s * 1.2, 6.0, 7.8)), look: p.clone().add(V(-0.4, 0.3, lookOff)), fov: 46 };
}
function catAnchor(i) {
  const p = pos[focusOf(i)];
  return isOverview(i) ? center.clone().add(V(-1.6, 0, depth / 2 + 1.2)) : p.clone().add(V(-1.35, 0, 1.55));
}

// ---------------------------------------------------------------- overlays
const $ = id => document.getElementById(id);
const roleLabel = { technical_engineer: 'ENGINEER', team_lead: 'TEAM LEAD', paying_manager: 'MANAGER' }[ROLE] || ROLE;
$('top').innerHTML = `<span class="chip">REEL ${reel.order}/${spec.reel_count}</span><span class="role">${roleLabel}</span>${STY ? `<span class="role sty">${STY.style.replace(/-/g, ' ')}</span>` : ''}<div class="title"></div>`;
$('top').querySelector('.title').textContent = reel.title;
$('hook').textContent = reel.hook || reel.title;

// 1-3 word subtitle chunks from word timings
const chunks = [];
{
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const txt = cur.map(x => x.w).join(' ');
    if (/[.,?!;:]$/.test(w.w) || cur.length >= 3 || txt.length > 16 || i === words.length - 1) { chunks.push(cur); cur = []; }
  });
}
const KW = new Set('def class return if else elif for while in is not and or None True False import from as with try except raise async await self lambda yield pass'.split(' '));
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tint(code) {
  const hash = code.indexOf('#');
  const body = hash >= 0 && !/["']/.test(code.slice(0, hash)) ? code.slice(0, hash) : code, cmt = body === code ? '' : code.slice(hash);
  let out = esc(body).replace(/(&quot;|"[^"]*"|'[^']*')/g, '<span class="s">$1</span>')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b(?![^<]*>)/g, (m) => KW.has(m) ? `<span class="k">${m}</span>` : /^[A-Z]/.test(m) ? `<span class="ty">${m}</span>` : m);
  return out + (cmt ? `<span class="c">${esc(cmt)}</span>` : '');
}
let codeKey = '';
function setCode(ref, breaking) {
  const key = ref ? ref.id + (breaking ? '!' : '') : '';
  if (key === codeKey) return; codeKey = key;
  if (!ref) return;
  const hl = new Set(ref.highlight_lines || []);
  const focus = (ref.highlight_lines || [])[0] ?? ref.start_line;
  let lines = ref.lines;
  if (lines.length > 9) { const k = Math.max(0, lines.findIndex(l => l.line === focus) - 3); lines = lines.slice(k, k + 9); }
  const isBrk = l => breaking && brk && brk.line === l.line;
  $('code').innerHTML = `<div class="hd"><span>${esc(ref.file.split('/').slice(-2).join('/'))}</span><span>L${ref.start_line}–${ref.end_line}</span></div>`
    + (ref.why ? `<div class="why">${esc(ref.why)}</div>` : '')
    + lines.map(l => `<div class="ln ${isBrk(l) ? 'brk' : hl.has(l.line) ? 'hl' : l.added ? 'add' : ''}"><span class="n">${l.line}</span><span class="p">${l.added ? '+' : ' '}</span><span class="t">${tint(l.code.replace(/^ {8}/, '    ').slice(0, 40))}</span></div>`).join('')
    + (breaking && brk ? `<div class="bi">⚡ Delete line ${brk.line} → ${esc(brk.what_breaks)}</div>` : '');
}

// ---------------------------------------------------------------- frame
const _a = new THREE.Vector3();
window.DURATION = DURATION;
window.renderAt = (t) => {
  const i = shotAt(t), s = shots[i];
  const prev = Math.max(0, i - 1);
  const k = i === 0 ? 1 : easeInOut(range(t, s.t_start, s.t_start + 0.9));
  const local = range(t, s.t_start, s.t_end);
  const breaking = !!(brk && s.code_ref_id && s.code_ref_id === brk.code_ref_id && local > 0.45);
  const bk = breaking ? smooth(range(local, 0.45, 0.55)) : 0;

  // camera: blend from previous shot pose + slow drift
  const A = camPose(prev), B = camPose(i);
  const cp = A.pos.clone().lerp(B.pos, k), cl = A.look.clone().lerp(B.look, k);
  const drift = V(Math.sin(t * 0.35) * 0.25, Math.sin(t * 0.5) * 0.08, 0);
  const shake = breaking ? V(Math.sin(t * 61) * 0.03, Math.sin(t * 47) * 0.03, 0).multiplyScalar(1 - range(local, 0.5, 0.8)) : V(0, 0, 0);
  camera.position.copy(cp.add(drift).add(shake));
  camera.fov = lerp(A.fov, B.fov, k); camera.updateProjectionMatrix();
  camera.lookAt(cl);
  camera.updateMatrixWorld();

  // components
  const focus = focusOf(i), prevFocus = focusOf(prev);
  for (const c of comps) {
    const n = nodes[c.id];
    const f = c.id === focus ? k : c.id === prevFocus && i > 0 ? 1 - k : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    n.grp.position.y = f * 0.12 * (0.7 + 0.3 * pulse);
    n.ring.material.opacity = f * (0.55 + 0.35 * pulse);
    n.glow.material.opacity = f * 0.22;
    const near = edges.some(e => (e.from === focus && e.to === c.id) || (e.to === focus && e.from === c.id));
    n.label.material.opacity = isOverview(i) ? 0.95 : Math.max(near ? 0.6 : 0.22, f);
    const ls = (isOverview(i) ? 0.72 : 0.85) * (1 + 0.25 * f);
    n.label.scale.set(LW * ls, LW * 0.344 * ls, 1);
    n.label.renderOrder = 5 + (c.id === focus ? 10 : 0);
    const red = c.id === focus ? bk * (0.6 + 0.4 * Math.sin(t * 20)) : 0;
    n.mat.color.copy(n.col).lerp(new THREE.Color(0xff3b3b), red * 0.8);
    n.mat.emissive.copy(n.col).lerp(new THREE.Color(0xff2020), red);
    n.mat.emissiveIntensity = 0.05 + f * 0.25 + red * 0.6;
  }

  // edges + packets (active = shot flows, else everything touching the focus; overview = all)
  const active = new Set(s.flow_edge_ids?.length ? s.flow_edge_ids : edges.filter(e => isOverview(i) || e.from === focus || e.to === focus).map(e => e.id));
  for (const { e, curve, mat, packets } of Object.values(edgeObjs)) {
    const on = active.has(e.id);
    const into = e.to === focus || e.from === focus;
    mat.emissiveIntensity = on ? 0.6 : 0;
    mat.color.set(on ? 0x58c8ff : 0x9fb3cc);
    if (breaking && into) { mat.color.set(0xff5050); mat.emissive.set(0xff2020); } else mat.emissive.set(0x58c8ff);
    packets.forEach((p, j) => {
      const u = ((t * 0.55 + j / 3 + e.id.length * 0.13) % 1);
      p.visible = on;
      curve.getPoint(u, p.position);
      if (breaking && into) { // packets fall off the broken edge
        const drop = clamp((u - 0.4) / 0.6);
        p.position.y -= drop * drop * 0.9; p.material.color.set(0xff6b6b);
      } else p.material.color.set(0xfff3a0);
    });
  }

  // cat: walks to the anchor, faces the camera, points at the focus box with its right paw
  const ca = catAnchor(prev).lerp(catAnchor(i), k);
  const moving = i > 0 && k > 0 && k < 1;
  const walk = moving ? Math.sin(t * 14) : 0;
  cat.root.position.copy(ca).setY(Math.abs(walk) * 0.04);
  cat.root.rotation.y = Math.atan2(camera.position.x - ca.x, camera.position.z - ca.z) * 0.85;
  cat.setPose({
    chest: [Math.sin(t * 2) * 0.015, 0, 0], drop: 0,
    lHip: [walk * 0.4, 0, 0.04], rHip: [-walk * 0.4, 0, -0.04], lAn: [-walk * 0.3, 0, 0], rAn: [walk * 0.3, 0, 0],
    neck: [0.08, 0, 0], head: [0.05, 0, Math.sin(t * 1.1) * 0.06],
  });
  cat.setTail(t, 1 + (moving ? 1 : 0));
  cat.root.updateMatrixWorld(true);
  const L = (x, y, z) => cat.root.localToWorld(V(x, y, z));
  const hint = V(0, 0, 1).applyQuaternion(cat.root.quaternion);
  const sh = cat.j.rSh.getWorldPosition(new THREE.Vector3());
  const boxTop = pos[focus].clone().setY(0.6);
  const point = smooth(range(local, 0.05, 0.25)) * (1 - smooth(range(local, 0.85, 1)));
  const reach = sh.clone().add(boxTop.clone().sub(sh).normalize().multiplyScalar((ARM_A + ARM_B) * CS * 0.95));
  const rest = L(-0.31, 0.6, 0.12);
  ikArm(cat, 'r', rest.lerp(reach, isOverview(i) ? 0 : point), L(-0.8, 0.4, -0.6), hint, ARM_A * CS, ARM_B * CS);
  const wave = isOverview(i) ? Math.max(0, Math.sin(range(t, 0.3, 2.5) * Math.PI)) : 0;
  ikArm(cat, 'l', L(0.31, 0.6, 0.12).lerp(L(0.34 + Math.sin(t * 9) * 0.05, 1.05, 0.25), wave), L(0.8, 0.4, -0.6), hint, ARM_A * CS, ARM_B * CS);
  let mouth = 0;
  for (const w of words) if (t > w.s - 0.03 && t < w.e + 0.02) mouth = Math.max(mouth, Math.sin(Math.PI * clamp((t - w.s) / (w.e - w.s))) ** 0.6 * (0.55 + 0.45 * Math.abs(Math.sin(t * 21 + w.s * 9))));
  cat.setMouth(mouth);
  let blink = 0; for (let b = 1.3; b < DURATION; b += 3.1) blink = Math.max(blink, 1 - Math.abs(t - b) / 0.08);
  cat.setFace({ blink: clamp(blink), brows: breaking ? -0.4 : 0.2 * point, browTilt: breaking ? 0.5 : 0, look: [0, -0.1], squint: breaking ? 0.4 : 0 });

  if (!STY) composer.render();

  // overlays
  const hookO = 1 - smooth(range(t, 1.5, 2.0));
  $('hook').style.opacity = hookO;
  $('top').style.opacity = 1 - hookO;
  const comp = comps.find(c => c.id === focus);
  const cap = s.caption || comp?.name || '';
  const sub2 = isOverview(i) ? `${comps.length} parts · ${edges.length} links` : (roleLine(comp) || comp?.kind || '');
  $('cap').innerHTML = cap && t > 1.6 ? `<span class="c">${esc(cap)}</span><br><span class="sub2">${esc(comp?.name && comp.name !== cap ? comp.name + ' · ' + sub2 : sub2)}</span>` : '';
  $('cap').style.opacity = smooth(range(t, s.t_start, s.t_start + 0.3));
  const ref = hasCode(i) ? refs[s.code_ref_id] : null;
  setCode(ref, breaking);
  const ci = ref ? easeOut(range(t, s.t_start + 0.2, s.t_start + 0.6)) * (1 - smooth(range(t, s.t_end - 0.25, s.t_end))) : 0;
  $('code').style.opacity = ci;
  $('code').style.transform = `translateY(${(1 - ci) * 60}px) scale(${0.96 + 0.04 * ci})`;
  $('code').style.borderColor = breaking ? '#ff3b3b' : '#2fd47a';
  $('flash').style.opacity = breaking ? 0.9 * Math.exp(-range(local, 0.45, 0.9) * 4) : 0;
  const ch = chunks.find(c => t >= c[0].s - 0.05 && t <= c[c.length - 1].e + 0.15);
  $('sub').innerHTML = ch ? ch.map(w => (t >= w.s && t <= w.e + 0.05 ? `<b>${esc(w.w)}</b>` : esc(w.w))).join(' ') : '';
  $('fade').style.opacity = 1 - smooth(range(t, 0, 0.25)) + smooth(range(t, DURATION - 0.3, DURATION));
  if (STY) { // full-screen skill style reel: no 3D, the clip carries the picture
    $('cap').style.opacity = 0; $('code').style.opacity = 0;
    const vt = Math.max(0, Math.min((styleVideo.duration || 4) - 0.04, (styleVideo.duration || 4) * range(t, STY.t0, STY.t1)));
    if (Math.abs(styleVideo.currentTime - vt) > 0.001) {
      return new Promise(r => { styleVideo.addEventListener('seeked', () => requestAnimationFrame(() => r(i)), { once: true }); styleVideo.currentTime = vt; });
    }
    return i;
  }
  // skill insert card (frame-exact: seek the clip and wait for it)
  if (INS) {
    const io = smooth(range(t, INS.t0, INS.t0 + 0.3)) * (1 - smooth(range(t, INS.t1 - 0.3, INS.t1)));
    const wrap = $('insWrap');
    wrap.style.opacity = io;
    wrap.style.transform = `translateY(${(1 - io) * 80}px) scale(${0.92 + 0.08 * io}) rotate(${(1 - io) * -2}deg)`;
    if (io > 0) {
      $('cap').style.opacity = 1 - io; $('code').style.opacity = Math.min(parseFloat($('code').style.opacity) || 0, 1 - io);
      const vt = Math.max(0, Math.min((insVideo.duration || 4) - 0.04, t - INS.t0));
      if (Math.abs(insVideo.currentTime - vt) > 0.001) {
        return new Promise(r => { insVideo.addEventListener('seeked', () => requestAnimationFrame(() => r(i)), { once: true }); insVideo.currentTime = vt; });
      }
    }
  }
  return i;
};
window.ready = Promise.resolve(true);
if (qs.has('t')) window.renderAt(parseFloat(qs.get('t')));

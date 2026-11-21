// Derived from claude-animation-skills (zach-d-films engine), MIT License, (c) 2026 Artem Novitckii.
import * as THREE from 'three';
import { rng } from './textures.js';

// ---------- fur textures (orange tabby, drawn in code) ----------
function furTexture(seed = 4, base = '#e8862e', stripe = 'rgba(150,62,10,0.75)', stripes = 9, repU = 1) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  // soft mottling
  for (let i = 0; i < 2600; i++) {
    const x = r() * W, y = r() * H, s = 2 + r() * 10;
    g.fillStyle = `rgba(${r() < 0.5 ? '255,190,120' : '170,80,20'},${0.05 + r() * 0.08})`;
    g.fillRect(x, y, s, s * 0.6);
  }
  // tabby stripes: wavy vertical bands across u (become rings around the body)
  g.strokeStyle = stripe; g.lineCap = 'round';
  for (let i = 0; i < stripes; i++) {
    const x0 = (i + 0.5) / stripes * W + (r() - 0.5) * 30;
    g.lineWidth = 16 + r() * 22;
    g.beginPath();
    for (let y = H * 0.08; y <= H * 0.78; y += 8) {
      const x = x0 + Math.sin(y * 0.02 + i) * 14 + Math.sin(y * 0.05 + i * 3) * 6;
      if (y === H * 0.08) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // fine fur strands
  for (let i = 0; i < 9000; i++) {
    const x = r() * W, y = r() * H;
    g.strokeStyle = `rgba(${r() < 0.5 ? '255,215,160' : '120,50,10'},${0.08 + r() * 0.1})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y + 5 + r() * 6); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(repU, 1); t.anisotropy = 4;
  return t;
}
function bumpTexture(seed = 8) {
  const W = 512, c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d'); const r = rng(seed);
  g.fillStyle = '#808080'; g.fillRect(0, 0, W, W);
  for (let i = 0; i < 14000; i++) {
    const x = r() * W, y = r() * W; const v = 90 + r() * 90 | 0;
    g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 2, y + 4 + r() * 4); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
  return t;
}

let CM = null;
export function catMaterials() {
  if (CM) return CM;
  const bump = bumpTexture();
  const fur = (map, color = 0xffffff) => new THREE.MeshPhysicalMaterial({
    color, map, roughness: 0.78, sheen: 1, sheenColor: new THREE.Color(0xffd29a), sheenRoughness: 0.45, bumpMap: bump, bumpScale: 1.2,
  });
  CM = {
    body: fur(furTexture(4, '#e8862e', 'rgba(160,66,12,0.7)', 11)),
    head: fur(furTexture(6, '#ec8b31', 'rgba(160,66,12,0.55)', 7)),
    limb: fur(furTexture(9, '#e8862e', 'rgba(160,66,12,0.6)', 6)),
    plain: fur(null, 0xe8862e),
    cream: new THREE.MeshPhysicalMaterial({ color: 0xfff1de, roughness: 0.85, sheen: 1, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.4, bumpMap: bump, bumpScale: 1.0 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0x9a3e0c, roughness: 0.85 }),
    pink: new THREE.MeshPhysicalMaterial({ color: 0xf2948f, roughness: 0.4, clearcoat: 0.4 }),
    earIn: new THREE.MeshStandardMaterial({ color: 0xf7b0a4, roughness: 0.7 }),
    eyeWhite: new THREE.MeshPhysicalMaterial({ color: 0xf7f6f0, roughness: 0.1, clearcoat: 1 }),
    iris: new THREE.MeshPhysicalMaterial({ color: 0x8fc23a, roughness: 0.2, clearcoat: 1, emissive: 0x2a4a08, emissiveIntensity: 0.25 }),
    pupil: new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.3 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    mouth: new THREE.MeshStandardMaterial({ color: 0x3a0f10, roughness: 0.9 }),
    tongue: new THREE.MeshStandardMaterial({ color: 0xe86a72, roughness: 0.5 }),
    whisker: new THREE.MeshStandardMaterial({ color: 0xfdfaf2, roughness: 0.4 }),
    glasses: new THREE.MeshPhysicalMaterial({ color: 0x2a2118, metalness: 0.6, roughness: 0.3, clearcoat: 1 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, transmission: 0.0, transparent: true, opacity: 0.12, clearcoat: 1 }),
    bow: new THREE.MeshStandardMaterial({ color: 0x2456b8, roughness: 0.55 }),
    bowDots: new THREE.MeshStandardMaterial({ color: 0xf6f2e6, roughness: 0.6 }),
    collar: new THREE.MeshStandardMaterial({ color: 0xc8283a, roughness: 0.5 }),
    gold: new THREE.MeshPhysicalMaterial({ color: 0xf0c048, metalness: 1, roughness: 0.25, clearcoat: 0.6 }),
  };
  return CM;
}

function sph(r, mat, pos = [0, 0, 0], scl = [1, 1, 1], seg = 40) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)), mat);
  m.position.set(...pos); m.scale.set(...scl);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function capsule(r, len, mat, seg = 20) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 10, seg), mat);
  m.position.y = -len / 2;
  m.castShadow = m.receiveShadow = true;
  return m;
}
function grp(parent, pos = [0, 0, 0]) { const g = new THREE.Group(); g.position.set(...pos); parent.add(g); return g; }

export const ARM_A = 0.23, ARM_B = 0.22;

// A fat, bipedal, orange tabby professor cat. Faces +z. Height about 1.25.
export function makeCat() {
  const M = catMaterials();
  const root = new THREE.Group();
  const j = {};
  j.pelvis = grp(root, [0, 0.3, 0]);
  // ---- the belly / body (pear shaped) ----
  const body = sph(0.32, M.body, [0, 0.2, 0], [1.0, 1.08, 0.92], 56); j.pelvis.add(body);
  const belly = sph(0.27, M.cream, [0, 0.16, 0.085], [0.92, 1.02, 0.82], 48); j.pelvis.add(belly);
  // fur tufts on the hips
  for (const s of [-1, 1]) j.pelvis.add(sph(0.11, M.body, [s * 0.24, 0.04, 0.0], [0.9, 0.8, 1.0]));
  j.chest = grp(j.pelvis, [0, 0.38, 0]);
  const chestM = sph(0.25, M.body, [0, 0.04, -0.01], [1.05, 0.85, 0.92], 48); j.chest.add(chestM);
  const bib = sph(0.17, M.cream, [0, 0.0, 0.13], [1.1, 1.0, 0.6], 40); j.chest.add(bib);
  // collar + bell + bow tie
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.018, 12, 48), M.collar);
  collar.rotation.x = Math.PI / 2 - 0.15; collar.position.set(0, 0.17, 0.01); collar.scale.set(1.08, 0.92, 1); j.chest.add(collar);
  const bell = sph(0.024, M.gold, [0.06, 0.125, 0.16]); j.chest.add(bell);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.01), M.mouth); slot.position.set(0.06, 0.118, 0.182); j.chest.add(slot);
  const bowG = grp(j.chest, [-0.025, 0.155, 0.175]); bowG.rotation.x = -0.25;
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.07, 4), M.bow);
    wing.rotation.z = s * Math.PI / 2; wing.position.x = s * 0.035; wing.scale.set(1, 1, 0.45); bowG.add(wing);
    for (let k = 0; k < 3; k++) bowG.add(sph(0.0045, M.bowDots, [s * (0.03 + k * 0.012), (k - 1) * 0.012, 0.012], [1, 1, 0.4], 8));
  }
  bowG.add(sph(0.016, M.bow, [0, 0, 0.005], [1.1, 1, 0.8]));
  j.neck = grp(j.chest, [0, 0.2, 0.0]);
  j.head = grp(j.neck, [0, 0.12, 0.02]);
  const face = buildHead(M, j.head);
  // ---- arms (hang along -Y, compatible with ikArm) ----
  for (const [s, k] of [[1, 'l'], [-1, 'r']]) {
    j[k + 'Sh'] = grp(j.chest, [s * 0.235, 0.06, 0.0]);
    j[k + 'Sh'].add(sph(0.075, M.limb, [0, -0.02, 0], [1, 1.1, 1]));
    j[k + 'Sh'].add(capsule(0.06, ARM_A - 0.03, M.limb));
    j[k + 'El'] = grp(j[k + 'Sh'], [0, -ARM_A, 0]);
    j[k + 'El'].add(capsule(0.054, ARM_B - 0.05, M.limb));
    j[k + 'Wr'] = grp(j[k + 'El'], [0, -ARM_B, 0]);
    // paw: mitten + toes + pink pads facing -z (palm side)
    j[k + 'Wr'].add(sph(0.064, M.cream, [0, 0.0, 0.0], [1.0, 0.95, 0.9]));
    for (let i = -1; i <= 1; i++) j[k + 'Wr'].add(sph(0.026, M.cream, [i * 0.032, -0.058, 0.012], [1, 1, 1], 16));
    j[k + 'Wr'].add(sph(0.022, M.pink, [0, -0.02, -0.062], [1.2, 1, 0.5], 16));
    for (let i = -1; i <= 1; i++) j[k + 'Wr'].add(sph(0.009, M.pink, [i * 0.03, -0.058, -0.012], [1, 1, 0.6], 10));
  }
  // ---- legs (short, stubby) ----
  for (const [s, k] of [[1, 'l'], [-1, 'r']]) {
    j[k + 'Hip'] = grp(j.pelvis, [s * 0.15, 0.02, 0.02]);
    j[k + 'Hip'].add(sph(0.11, M.limb, [0, -0.04, 0], [1, 1.1, 1]));
    j[k + 'Hip'].add(capsule(0.088, 0.14, M.limb));
    j[k + 'An'] = grp(j[k + 'Hip'], [0, -0.25, 0]);
    // foot; the right foot wears a white sock
    const foot = sph(0.085, k === 'r' ? M.cream : M.limb, [0, -0.0, 0.05], [0.95, 0.6, 1.4]); j[k + 'An'].add(foot);
    for (let i = -1; i <= 1; i++) j[k + 'An'].add(sph(0.03, k === 'r' ? M.cream : M.limb, [i * 0.035, -0.012, 0.155], [1, 0.75, 1], 14));
  }
  // ---- tail: chain of fur spheres along a curve ----
  const tailSegs = [];
  for (let i = 0; i < 34; i++) {
    const r = 0.058 - i * 0.0009;
    const m = sph(r, (i % 7 >= 5 || i >= 31) ? M.stripe : M.plain, [0, 0, 0], [1, 1, 1], 20);
    j.pelvis.add(m); tailSegs.push(m);
  }
  function setTail(t, k = 1) {
    let p = new THREE.Vector3(0, 0.08, -0.25), a = -0.4;
    for (let i = 0; i < tailSegs.length; i++) {
      const u = i / 34;
      const sway = Math.sin(t * 2.2 - u * 5.5) * 0.35 * k * u;
      const yaw = Math.sin(t * 1.3 - u * 4) * 0.3 * k * u + 0.15;
      a += (0.065 - (u > 0.66 ? 0.12 : 0));
      p = p.clone().add(new THREE.Vector3(Math.sin(yaw + sway) * 0.022, Math.sin(a) * 0.022 + 0.008, -Math.cos(yaw + sway) * 0.02 * Math.cos(a)));
      tailSegs[i].position.copy(p);
    }
  }
  setTail(0);

  const rest = {};
  for (const n of Object.keys(j)) rest[n] = j[n].position.clone();
  function setPose(p = {}) {
    for (const [n, g] of Object.entries(j)) {
      const r = p[n] || [0, 0, 0];
      g.rotation.set(r[0], r[1], r[2]);
    }
    j.pelvis.position.y = 0.3 + (p.drop || 0);
  }
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  face.lensMesh.forEach(m => { m.castShadow = false; });
  return { root, j, setPose, setTail, ...face };
}

function buildHead(M, head) {
  const parts = {};
  const skull = sph(0.2, M.head, [0, 0.07, 0], [1.12, 0.92, 0.98], 56); head.add(skull);
  // cheek fluff
  for (const s of [-1, 1]) {
    head.add(sph(0.11, M.head, [s * 0.15, 0.0, 0.03], [1.1, 0.8, 0.9], 32));
    for (let i = 0; i < 3; i++) {
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 10), M.head);
      tuft.position.set(s * (0.24 + i * 0.004), -0.02 - i * 0.03, 0.02 - i * 0.01);
      tuft.rotation.z = -s * (Math.PI / 2 + 0.3 + i * 0.25); head.add(tuft);
    }
  }
  // muzzle
  const muzzle = grp(head, [0, -0.005, 0.15]);
  for (const s of [-1, 1]) muzzle.add(sph(0.058, M.cream, [s * 0.042, 0, 0.0], [1, 0.82, 0.8], 32));
  const chinG = grp(muzzle, [0, -0.035, -0.01]);
  chinG.add(sph(0.045, M.cream, [0, -0.012, -0.0], [1.1, 0.7, 0.8], 24));
  // mouth (open hole + tongue), hidden behind muzzle when closed
  const mouthO = sph(0.03, M.mouth, [0, -0.045, 0.03], [1.0, 0.2, 0.5], 24); muzzle.add(mouthO);
  const tongue = sph(0.02, M.tongue, [0, -0.055, 0.036], [1.0, 0.2, 0.5], 16); muzzle.add(tongue);
  // "w" mouth line
  for (const s of [-1, 1]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0035, 6, 18, Math.PI), M.mouth);
    arc.rotation.z = Math.PI; arc.position.set(s * 0.018, -0.018, 0.047); muzzle.add(arc);
  }
  const philtrum = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.02, 6), M.mouth);
  philtrum.position.set(0, -0.006, 0.05); muzzle.add(philtrum);
  // nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.024, 3), M.pink);
  nose.rotation.set(Math.PI / 2 + 0.25, 0, Math.PI); nose.scale.set(1.3, 1, 0.7); nose.position.set(0, 0.024, 0.052); muzzle.add(nose);
  muzzle.add(sph(0.006, M.glint, [0.006, 0.03, 0.06], [1, 0.6, 0.5], 8));
  // whisker dots + whiskers
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      muzzle.add(sph(0.0035, M.stripe, [s * (0.035 + i * 0.012), 0.004 - i * 0.008, 0.045], [1, 1, 1], 6));
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0022, 0.2, 5), M.whisker);
      w.position.set(s * 0.13, 0.0 - i * 0.012, 0.03);
      w.rotation.z = s * (Math.PI / 2 + (i - 1) * 0.15); w.rotation.y = s * -0.25; muzzle.add(w);
    }
  }
  // eyes (big, green, slit pupils)
  for (const s of [-1, 1]) {
    const eye = grp(head, [s * 0.083, 0.085, 0.152]);
    eye.add(sph(0.052, M.eyeWhite, [0, 0, 0], [1, 1.08, 0.7]));
    const iris = sph(0.038, M.iris, [0, -0.002, 0.024], [1, 1.1, 0.45]); eye.add(iris);
    const pupil = sph(0.03, M.pupil, [0, -0.002, 0.031], [0.32, 1.0, 0.3]); eye.add(pupil);
    eye.add(sph(0.011, M.glint, [s * -0.012 + 0.008, 0.02, 0.041], [1, 1, 0.4], 10));
    eye.add(sph(0.005, M.glint, [0.012, -0.016, 0.04], [1, 1, 0.4], 8));
    // upper lid (fur) for blinks
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.056, 32, 16, 0, Math.PI * 2, 0, 1.2), M.head);
    lid.scale.set(1, 1.08, 0.72); eye.add(lid);
    parts['lid' + s] = lid; parts['pupil' + s] = pupil; parts['eye' + s] = eye; parts['iris' + s] = iris;
    // brow tuft
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.045, 4, 8), M.stripe);
    brow.rotation.z = Math.PI / 2 + s * 0.15; brow.position.set(s * 0.085, 0.16, 0.16); brow.scale.z = 0.6; head.add(brow);
    parts['brow' + s] = brow;
  }
  // tabby "M" forehead stripes
  for (const [x, rz, len] of [[0, 0, 0.07], [-0.035, 0.25, 0.055], [0.035, -0.25, 0.055], [-0.07, 0.5, 0.04], [0.07, -0.5, 0.04]]) {
    const st = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, len, 4, 8), M.stripe);
    st.position.set(x, 0.205 - Math.abs(x) * 0.6, 0.14 - Math.abs(x) * 0.5); st.rotation.set(-0.7, 0, rz); st.scale.z = 0.5; head.add(st);
  }
  // ears with pink insides and tufts
  for (const s of [-1, 1]) {
    const ear = grp(head, [s * 0.13, 0.2, -0.01]); ear.rotation.set(-0.1, s * -0.2, s * -0.38);
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 4, 1), M.head); outer.scale.set(1, 1, 0.45); outer.rotation.y = Math.PI / 4; outer.position.y = 0.06; ear.add(outer);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 4, 1), M.earIn); inner.scale.set(1, 1, 0.3); inner.rotation.y = Math.PI / 4; inner.position.set(0, 0.05, 0.022); ear.add(inner);
    for (let i = 0; i < 3; i++) { const tf = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.05, 5), M.cream); tf.position.set((i - 1) * 0.012, 0.06, 0.03); tf.rotation.z = (i - 1) * 0.3; ear.add(tf); }
    parts['ear' + s] = ear;
  }
  // round professor glasses
  const lensMesh = [];
  const gl = grp(head, [0, 0.085, 0.215]);
  for (const s of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0055, 10, 40), M.glasses); rim.position.x = s * 0.085; gl.add(rim);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.056, 32), M.lens); lens.position.x = s * 0.085; gl.add(lens); lensMesh.push(lens);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 6), M.glasses);
    arm.rotation.x = Math.PI / 2; arm.position.set(s * 0.15, 0.0, -0.1); arm.rotation.y = s * 0.15; gl.add(arm);
  }
  const bridge = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 6, 16, Math.PI), M.glasses); bridge.position.y = 0.004; gl.add(bridge);

  let blink = 0;
  function setMouth(o) {
    o = Math.max(0, Math.min(1, o));
    chinG.position.y = -0.035 - o * 0.035;
    mouthO.scale.set(0.9, 0.15 + o * 0.95, 0.5); mouthO.position.y = -0.045 - o * 0.016; mouthO.visible = o > 0.04;
    tongue.position.y = -0.05 - o * 0.03; tongue.scale.y = 0.15 + o * 0.35; tongue.visible = o > 0.15;
  }
  function setFace({ blink = 0, brows = 0, browTilt = 0, look = [0, 0], squint = 0, wink = 0 } = {}) {
    for (const s of [-1, 1]) {
      const b = Math.max(blink, s === 1 ? wink : 0, squint * 0.45);
      const lid = parts['lid' + s];
      lid.rotation.x = -1.0 + b * 2.35; // open .. closed
      const brow = parts['brow' + s];
      brow.position.y = 0.16 + brows * 0.02; brow.rotation.z = Math.PI / 2 + s * (-0.08 + browTilt * 0.4);
      parts['pupil' + s].position.x = look[0] * 0.012; parts['pupil' + s].position.y = -0.002 + look[1] * 0.012;
      parts['iris' + s].position.x = look[0] * 0.01; parts['iris' + s].position.y = -0.002 + look[1] * 0.01;
    }
  }
  setMouth(0); setFace();
  return { setMouth, setFace, parts, lensMesh, muzzle };
}

// marker pen: cap at +y, tip along -y, origin at the grip
export function marker(color = 0x2456b8) {
  const g = new THREE.Group();
  const bodyM = new THREE.MeshPhysicalMaterial({ color: 0xf4f4f2, roughness: 0.35, clearcoat: 0.6 });
  const col = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.13, 16), bodyM); g.add(b);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.0155, 0.04, 16), col); cap.position.y = 0.075; g.add(cap);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.03, 16), col); band.position.y = 0.0; g.add(band);
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.006, 0.02, 16), bodyM); cone.position.y = -0.075; g.add(cone);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.0045, 0.012, 10), col); tip.position.y = -0.09; g.add(tip);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.tipLocal = new THREE.Vector3(0, -0.097, 0);
  g.color = color;
  return g;
}

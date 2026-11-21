// Alternative "material" scenes in the claude-animation-skills look (dark studio, matte objects, thin white leader
// lines, numbered mono labels, one orange accent):
//   studio — the PR's services as floating devices joined by thin lines with data pulses, numbered labels
//   desk   — the cat at a desk in front of a live observability dashboard (traces / metrics / logs from the PR)
// Each builder returns { scene, camera, update(t, i, k, local, breaking) } and draws its labels into #lbl.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeCat, ARM_A, ARM_B } from './cat.js';
import { glowTexture } from './textures.js';
import { clamp, lerp, smooth, easeInOut, range, V, ikArm } from './anim.js';

const ACCENT = 0xff7a1a;
const put = (m, p, r) => { m.position.copy(p); if (r) m.rotation.copy(r); return m; };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function studioBase(scene) {
  const bg = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 p; void main(){ float y = normalize(p).y; vec3 a = vec3(0.035,0.04,0.055), b = vec3(0.10,0.11,0.15); gl_FragColor = vec4(mix(b, a, smoothstep(-0.1, 0.7, y)), 1.); }',
  }));
  scene.add(bg);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshPhysicalMaterial({ color: 0x14171e, roughness: 0.32, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.4 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x0a0c10, 0.5));
  const key = new THREE.DirectionalLight(0xfff1e0, 1.6); key.position.set(-4, 8, 5); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  const rim = new THREE.DirectionalLight(ACCENT, 1.1); rim.position.set(5, 3, -6);
  scene.add(key, rim);
  return { floor };
}

function catActor(scene, scale) {
  const cat = makeCat(); cat.root.scale.setScalar(scale); scene.add(cat.root);
  return cat;
}
function talk(words, t) {
  let m = 0;
  for (const w of words) if (t > w.s - 0.03 && t < w.e + 0.02) m = Math.max(m, Math.sin(Math.PI * clamp((t - w.s) / (w.e - w.s))) ** 0.6 * (0.55 + 0.45 * Math.abs(Math.sin(t * 21 + w.s * 9))));
  return m;
}
function blinkAt(t, dur) { let b = 0; for (let x = 1.3; x < dur; x += 3.1) b = Math.max(b, 1 - Math.abs(t - x) / 0.08); return clamp(b); }

// --------------------------------------------------------------------------------------------- studio
export function studioScene(ctx) {
  const { graph, reel, shots, focusOf, words, W, H, lbl, duration } = ctx;
  const scene = new THREE.Scene();
  studioBase(scene);
  const byId = Object.fromEntries(graph.components.map(c => [c.id, c]));
  // the components this reel is about: its path + focus + direct neighbours (max 6), ordered along the edges
  const want = [...new Set([...(reel.path_component_ids || []), reel.focus_component_id, ...shots.map(s => s.highlight_component_id).filter(Boolean)])].filter(id => byId[id]);
  for (const e of graph.edges) { if (want.length >= 6) break; if (want.includes(e.from) && !want.includes(e.to)) want.push(e.to); }
  const ids = want.slice(0, 6);
  const n = ids.length;
  const items = {};
  ids.forEach((id, k) => {
    const c = byId[id];
    const u = n === 1 ? 0.5 : k / (n - 1);
    // portrait layout: a vertical zig-zag flow, top to bottom along the data path
    const pos = V((k % 2 ? 1 : -1) * 0.38, lerp(3.65, 0.95, u), Math.sin(k * 1.3) * 0.25);
    const g = new THREE.Group(); g.position.copy(pos); scene.add(g);
    const body = new THREE.Mesh(new RoundedBoxGeometry(1.15, 0.26, 0.8, 4, 0.08), new THREE.MeshPhysicalMaterial({ color: 0x2b303b, roughness: 0.45, clearcoat: 0.5 }));
    body.castShadow = true; g.add(body);
    const top = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.03, 0.6, 2, 0.02), new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.6 }));
    top.position.y = 0.14; g.add(top);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.035, 0.05), new THREE.MeshBasicMaterial({ color: c.change === 'unchanged' ? 0x5c6475 : ACCENT, toneMapped: false }));
    stripe.position.set(0, 0, 0.405); g.add(stripe);
    const leds = [0, 1, 2].map(j => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0x9dffb0, toneMapped: false })); m.position.set(0.38 + j * 0.06, 0.06, 0.41); g.add(m); return m; });
    const halo = new THREE.Mesh(new RoundedBoxGeometry(1.24, 0.34, 0.9, 4, 0.1), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, side: THREE.BackSide, toneMapped: false }));
    g.add(halo);
    items[id] = { c, g, base: pos.clone(), halo, leds, k };
  });
  // thin connection lines + pulses for edges between shown items
  const links = graph.edges.filter(e => items[e.from] && items[e.to]).map(e => {
    const geo = new THREE.BufferGeometry().setFromPoints([V(), V()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd8dde6, transparent: true, opacity: 0.55 }));
    scene.add(line);
    const pulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,170,90,1)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pulse.scale.set(0.28, 0.28, 1); scene.add(pulse);
    return { e, line, pulse };
  });
  const cat = catActor(scene, 0.55);
  const camera = new THREE.PerspectiveCamera(36, W / H, 0.05, 200);
  const shotFocus = i => (items[focusOf(i)] ? focusOf(i) : ids[0]);

  return {
    scene, camera,
    update(t, i, k, local, breaking) {
      const f = shotFocus(i), pf = shotFocus(Math.max(0, i - 1));
      for (const it of Object.values(items)) {
        const on = it.c.id === f ? k : it.c.id === pf && i > 0 ? 1 - k : 0;
        it.g.position.copy(it.base).add(V(0, 0.05 * Math.sin(t * 1.4 + it.k), on * 0.45));
        it.g.scale.setScalar(0.78 * (1 + on * 0.15));
        it.g.rotation.y = Math.sin(t * 0.5 + it.k) * 0.1 + (it.base.x < 0 ? 0.35 : -0.35);
        it.g.rotation.x = 0.35;
        it.halo.material.opacity = on * (0.25 + 0.15 * Math.sin(t * 5)) + (breaking && it.c.id === f ? 0.4 : 0);
        it.halo.material.color.set(breaking && it.c.id === f ? 0xff3030 : ACCENT);
        it.leds.forEach((l, j) => l.visible = Math.sin(t * (5 + j * 2) + it.k * 3) > -0.3);
      }
      for (const L of links) {
        const a = items[L.e.from].g.position, b = items[L.e.to].g.position;
        L.line.geometry.setFromPoints([a, b]);
        const u = (t * 0.6 + L.e.id.length * 0.17) % 1;
        L.pulse.position.lerpVectors(a, b, u);
        const hot = L.e.from === f || L.e.to === f;
        L.pulse.material.opacity = hot ? 1 : 0.35;
        L.line.material.opacity = hot ? 0.9 : 0.35;
        L.line.material.color.set(breaking && hot ? 0xff5050 : 0xd8dde6);
      }
      // camera: front, low, slowly orbiting, leaning toward the focused device
      const fp = items[f].base, pp = items[pf].base;
      const fy = lerp(pp.y, fp.y, i === 0 ? 1 : k);
      const ang = Math.sin(t * 0.15) * 0.18;
      const ly = lerp(2.2, fy, 0.3);
      camera.position.set(Math.sin(ang) * 9.6, ly + 0.9, 9.6 * Math.cos(ang));
      camera.lookAt(0, ly - 0.15, 0);
      const fx = 0;
      camera.updateMatrixWorld();
      // cat: small, on the floor at the front, facing the focused device and pointing at it
      const cp = V(-0.95, 0, 1.2);
      cat.root.position.copy(cp);
      const target = items[f].g.position;
      cat.root.rotation.y = Math.atan2(target.x - cp.x, target.z - cp.z) * 0.6 + Math.atan2(camera.position.x - cp.x, camera.position.z - cp.z) * 0.4;
      cat.setPose({ neck: [0.05, 0, 0], head: [-0.15, 0, Math.sin(t) * 0.05], chest: [Math.sin(t * 2) * 0.015, 0, 0] });
      cat.setTail(t, 1);
      cat.root.updateMatrixWorld(true);
      const L2 = (x, y, z) => cat.root.localToWorld(V(x, y, z));
      const hint = V(0, 0, 1).applyQuaternion(cat.root.quaternion);
      const sh = cat.j.rSh.getWorldPosition(new THREE.Vector3());
      const point = smooth(range(local, 0.08, 0.3)) * (1 - smooth(range(local, 0.85, 1)));
      const reach = sh.clone().add(target.clone().sub(sh).normalize().multiplyScalar((ARM_A + ARM_B) * 0.55 * 0.95));
      ikArm(cat, 'r', L2(-0.31, 0.6, 0.12).lerp(reach, point), L2(-0.8, 0.4, -0.6), hint, ARM_A * 0.55, ARM_B * 0.55);
      ikArm(cat, 'l', L2(0.31, 0.6, 0.12), L2(0.8, 0.4, -0.6), hint, ARM_A * 0.55, ARM_B * 0.55);
      cat.setMouth(talk(words, t)); cat.setFace({ blink: blinkAt(t, duration), look: [0, 0.2] });
      // numbered labels with leader lines (breakdown style)
      let svg = '', html = '';
      const order = ids.map(id => items[id]);
      order.forEach((it, j) => {
        const p = it.g.position.clone().add(V(0, 0.2, 0)).project(camera);
        const x = (p.x * 0.5 + 0.5) * W, y = (-p.y * 0.5 + 0.5) * H;
        const left = it.base.x > 0; // label on the open side of the zig-zag
        const lx = left ? Math.max(20, x - 330) : Math.min(W - 222, x + 130), ly = y - 40;
        const on = it.c.id === f;
        svg += `<line x1="${x}" y1="${y}" x2="${left ? lx + 200 : lx}" y2="${ly + 34}" stroke="${on ? '#ff7a1a' : 'rgba(255,255,255,.55)'}" stroke-width="${on ? 2.5 : 1.3}"/><circle cx="${x}" cy="${y}" r="${on ? 6 : 4}" fill="${on ? '#ff7a1a' : '#fff'}"/>`;
        html += `<div class="lb ${on ? 'on' : ''}" style="left:${lx}px;top:${ly}px"><b>${String(j + 1).padStart(2, '0')}</b> ${esc(it.c.name)}<i>${esc(it.c.change === 'unchanged' ? 'existing · ' + it.c.kind : (it.c.change || '') + ' · ' + it.c.kind)}</i></div>`;
      });
      lbl.innerHTML = `<svg width="${W}" height="${H}">${svg}</svg>${html}`;
    },
  };
}

// --------------------------------------------------------------------------------------------- desk
export function deskScene(ctx) {
  const { graph, reel, shots, focusOf, words, W, H, lbl, data, duration, prTitle } = ctx;
  const scene = new THREE.Scene();
  studioBase(scene);
  const byId = Object.fromEntries(graph.components.map(c => [c.id, c]));
  // dashboard content: spans (a waterfall), metrics (counters) and logs — from the style spec, else from the graph
  const path = [...new Set([...(reel.path_component_ids || []), reel.focus_component_id])].filter(id => byId[id]);
  const spans = (data?.spans?.length ? data.spans : path.map((id, k) => ({ name: byId[id].name.toLowerCase().replace(/\s+/g, '.'), component_id: id, ms: 40 + k * 35 }))).slice(0, 7);
  const metrics = (data?.metrics?.length ? data.metrics : [{ name: 'spans exported', value: 128, unit: '' }, { name: 'llm tokens', value: 5320, unit: '' }, { name: 'p95 latency', value: 412, unit: 'ms' }]).slice(0, 3);
  const logs = (data?.logs?.length ? data.logs : shots.map(s => s.caption || '').filter(Boolean)).slice(0, 6);
  const title = data?.dashboard_title || (prTitle || 'Observability').slice(0, 34);

  // desk + monitor + props
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.55 });
  const desk = new THREE.Mesh(new RoundedBoxGeometry(4.2, 0.12, 1.1, 3, 0.04), wood); desk.position.set(0, 1.0, 0); desk.castShadow = desk.receiveShadow = true; scene.add(desk);
  for (const x of [-1.9, 1.9]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 1.0), new THREE.MeshStandardMaterial({ color: 0x1b1e25 })); leg.position.set(x, 0.5, 0); scene.add(leg); }
  const bezel = new THREE.Mesh(new RoundedBoxGeometry(3.5, 2.05, 0.1, 4, 0.05), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.4 }));
  bezel.position.set(0, 2.35, -0.45); bezel.castShadow = true; scene.add(bezel);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.12), new THREE.MeshStandardMaterial({ color: 0x22252c, metalness: 0.6, roughness: 0.3 })); stand.position.set(0, 1.25, -0.5); scene.add(stand);
  const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 920;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.36, 1.93), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, 2.35, -0.394); scene.add(screen);
  const glow = new THREE.PointLight(0x7fb8ff, 2.2, 6, 1.5); glow.position.set(0, 2.2, 0.4); scene.add(glow);
  const kb = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.04, 0.34, 2, 0.015), new THREE.MeshStandardMaterial({ color: 0x2a2d35 })); kb.position.set(0.05, 1.08, 0.4); scene.add(kb);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.2, 24), new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.5 })); mug.position.set(1.3, 1.16, 0.3); mug.castShadow = true; scene.add(mug);
  const plant = new THREE.Group(); plant.position.set(-1.6, 1.06, -0.2); scene.add(plant);
  plant.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.2, 20), new THREE.MeshStandardMaterial({ color: 0xd9d9d9 })), V(0, 0.1, 0)));
  for (let k = 0; k < 7; k++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), new THREE.MeshStandardMaterial({ color: 0x3f8f5a })); l.scale.set(0.5, 1.4, 0.2); l.position.set(Math.cos(k) * 0.06, 0.32 + (k % 3) * 0.06, Math.sin(k) * 0.06); l.rotation.set(0, k, (k - 3) * 0.25); plant.add(l); }
  // chair
  const chair = new THREE.Group(); chair.position.set(0.15, 0, 0.95); scene.add(chair);
  const seatM = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.7 });
  chair.add(put(new THREE.Mesh(new RoundedBoxGeometry(0.75, 0.1, 0.7, 3, 0.04), seatM), V(0, 0.62, 0)));
  chair.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 12), seatM), V(0, 0.33, 0)));
  chair.add(put(new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.42, 0.08, 3, 0.04), seatM), V(0, 0.9, 0.34), new THREE.Euler(0.12, 0, 0)));
  // the cat, sitting on the chair, facing the screen
  const CS = 0.62;
  const cat = catActor(scene, CS);
  const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 200);

  function drawDashboard(t, i, local, breaking) {
    const focus = focusOf(i);
    g.fillStyle = '#0b1018'; g.fillRect(0, 0, 1600, 920);
    g.fillStyle = '#111827'; g.fillRect(0, 0, 1600, 70);
    g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(40, 35, 12, 0, 7); g.fill();
    g.fillStyle = '#e8edf5'; g.font = '700 30px Inter, sans-serif'; g.fillText(title, 66, 46);
    g.fillStyle = '#7b8798'; g.font = '600 22px Inter, sans-serif'; g.fillText('LIVE · last 5 min', 1340, 44);
    // traces waterfall
    g.fillStyle = '#9aa6b8'; g.font = '700 22px Inter'; g.fillText('TRACES', 40, 115);
    const shown = Math.min(spans.length, 1 + Math.floor(t * 0.9));
    let x0 = 360;
    spans.forEach((sp, k) => {
      if (k >= shown) return;
      const y = 140 + k * 56;
      const grow = clamp((t * 0.9 - k) * 1.2);
      const w = (sp.ms || 60) * 2.2 * grow;
      const hot = sp.component_id && sp.component_id === focus;
      const bad = breaking && hot;
      g.fillStyle = hot ? '#e8edf5' : '#8f9bb0'; g.font = `${hot ? 700 : 600} 22px Mono, monospace`;
      g.fillText(('  '.repeat(Math.min(k, 4)) + sp.name).slice(0, 26), 40, y + 28);
      g.fillStyle = bad ? '#ff3b3b' : hot ? '#ff7a1a' : '#3d7be8';
      g.fillRect(x0 + k * 26, y + 8, w, 30);
      g.fillStyle = '#c8d0dc'; g.font = '600 18px Inter'; g.fillText(`${Math.round((sp.ms || 60) * grow)} ms`, x0 + k * 26 + w + 10, y + 30);
      if (bad) { g.fillStyle = '#ff3b3b'; g.font = '800 20px Inter'; g.fillText('✕ dropped', x0 + k * 26 + w + 90, y + 30); }
    });
    // metrics tiles
    const my = 560;
    metrics.forEach((m, k) => {
      const x = 40 + k * 520;
      g.fillStyle = '#111827'; g.fillRect(x, my, 490, 170);
      g.fillStyle = '#7b8798'; g.font = '700 22px Inter'; g.fillText(String(m.name).toUpperCase().slice(0, 24), x + 24, my + 44);
      const v = (Number(m.value) || 0) * clamp(t / 6);
      g.fillStyle = '#e8edf5'; g.font = '800 64px Inter'; g.fillText(`${Math.round(v).toLocaleString('en-US')}${m.unit ? ' ' + m.unit : ''}`, x + 24, my + 120);
      g.strokeStyle = k === 1 ? '#ff7a1a' : '#3d7be8'; g.lineWidth = 3; g.beginPath();
      for (let s = 0; s <= 40; s++) { const xx = x + 24 + s * 11, yy = my + 150 - 18 * (0.5 + 0.5 * Math.sin(s * 0.45 + t * 2 + k)); s ? g.lineTo(xx, yy) : g.moveTo(xx, yy); }
      g.stroke();
    });
    // logs
    g.fillStyle = '#9aa6b8'; g.font = '700 22px Inter'; g.fillText('LOGS', 40, 780);
    const nl = Math.min(logs.length, Math.floor(t * 0.8) + 1);
    logs.slice(Math.max(0, nl - 3), nl).forEach((l, k) => {
      g.fillStyle = breaking && k === 2 ? '#ff6b6b' : '#7ee2a8'; g.font = '500 22px Mono, monospace';
      g.fillText(`${String(10 + k).padStart(2, '0')}:4${k}:0${(k * 3) % 10}  ${String(l).slice(0, 70)}`, 40, 820 + k * 32);
    });
    tex.needsUpdate = true;
  }

  return {
    scene, camera,
    update(t, i, k, local, breaking) {
      drawDashboard(t, i, local, breaking);
      glow.color.set(breaking ? 0xff6a6a : 0x7fb8ff);
      // camera: over the cat's shoulder, pushing toward the dashboard over the reel
      const push = smooth(range(t, 0, duration));
      const side = Math.sin(i * 1.9) > 0 ? 1 : -1;
      const sx = lerp(side * 1.0, side * 0.5, k);
      camera.position.set(2.5 + sx, lerp(3.0, 2.7, push), lerp(7.0, 5.9, push));
      camera.lookAt(-0.15, 1.85, -0.3);
      camera.updateMatrixWorld();
      // cat on the chair: sitting, back three-quarters to us, turns its head to the viewer while it talks
      cat.root.position.set(0.15, 0.67, 0.82);
      const turn = 0.5 + 0.5 * Math.sin(t * 0.7);
      cat.root.rotation.y = Math.PI + 0.25;
      cat.setPose({ drop: -0.12, lHip: [-1.35, 0, 0.1], rHip: [-1.35, 0, -0.1], lAn: [1.2, 0, 0], rAn: [1.2, 0, 0],
        chest: [0.08 + Math.sin(t * 2) * 0.015, 0, 0], neck: [0, lerp(-0.2, -1.05, turn * smooth(range(local, 0.1, 0.4))), 0], head: [-0.05, -0.2 * turn, 0.05] });
      cat.setTail(t, 0.6);
      cat.root.updateMatrixWorld(true);
      const L2 = (x, y, z) => cat.root.localToWorld(V(x, y, z));
      const hint = V(0, 0, 1).applyQuaternion(cat.root.quaternion);
      const typing = Math.sin(t * 14) * 0.02;
      ikArm(cat, 'l', V(-0.1, 1.12 + typing, 0.45), L2(0.8, 0.4, -0.6), hint, ARM_A * CS, ARM_B * CS);
      // right paw points at the screen on the focused span
      const point = smooth(range(local, 0.15, 0.35)) * (1 - smooth(range(local, 0.8, 0.95)));
      ikArm(cat, 'r', V(0.3, 1.12 - typing, 0.45).lerp(V(0.45, 1.75, 0.1), point), L2(-0.8, 0.4, -0.6), hint, ARM_A * CS, ARM_B * CS);
      cat.setMouth(talk(words, t)); cat.setFace({ blink: blinkAt(t, duration), look: [0, 0] });
      lbl.innerHTML = '';
    },
  };
}

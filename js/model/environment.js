/**
 * environment.js — 风电场环境：物理天空、太阳位置、起伏地形、防护林带、道路、吊装平台、人/车比例参照
 * ------------------------------------------------------------------
 *  - 天空：Preetham 大气散射模型（three/addons Sky），太阳高度角/方位角按纬度 41.5°N（内蒙古中部）
 *    与日期计算，昼夜光照、色温、曝光随之变化
 *  - 地形：8 km × 8 km，分形噪声丘陵，风机周边 300 m 内平整（真实风场会平整机位与吊装平台）
 *  - 地物：杨树防护林带、砂石检修道路、45 × 25 m 吊装平台、1.75 m 人物、检修车
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/* ---------------- 噪声 ---------------- */
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

/** 地形高度（m）。机位周边平整 */
export function terrainHeight(x, z, sites = [[0, 0]]) {
  let h = (fbm(x / 1400 + 3.1, z / 1400 - 7.3) - 0.5) * 70 + (fbm(x / 380, z / 380) - 0.5) * 8;
  let flat = 1;
  for (const [sx, sz] of sites) {
    const d = Math.hypot(x - sx, z - sz);
    flat = Math.min(flat, THREE.MathUtils.smoothstep(d, 90, 420));
  }
  // 以主机位为基准：主机位附近高度为 0
  return h * flat;
}

export const SITE = { lat: 41.5, dayOfYear: 200 }; // 7 月中旬

/** 太阳方位：返回 {elev, azim}（弧度，方位角自正北顺时针） */
export function sunPosition(hour, lat = SITE.lat, doy = SITE.dayOfYear) {
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy - 81)) * (Math.PI / 180);
  const H = (hour - 12) * 15 * (Math.PI / 180);
  const phi = lat * (Math.PI / 180);
  const sinE = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const elev = Math.asin(sinE);
  const cosA = (Math.sin(decl) - Math.sin(elev) * Math.sin(phi)) / (Math.cos(elev) * Math.cos(phi));
  let azim = Math.acos(Math.min(1, Math.max(-1, cosA)));
  if (H > 0) azim = 2 * Math.PI - azim;
  return { elev, azim };
}

function detailTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const x = i % 256, y = (i / 256) | 0;
    const n = 0.55 * vnoise(x / 6, y / 6) + 0.3 * vnoise(x / 2, y / 2) + 0.15 * Math.random();
    const v = 180 + n * 75;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3200, 3200);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.2, 'rgba(255,80,60,0.8)');
  gr.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
export const GLOW_TEX = typeof document !== 'undefined' ? glowTexture() : null;

export function createEnvironment(scene, renderer, sites) {
  const env = {};
  const SIZE = 16000;

  /* ---------- 天空 ---------- */
  const sky = new Sky();
  sky.scale.setScalar(24000);
  sky.renderOrder = -10;
  scene.add(sky);
  const su = sky.material.uniforms;
  su.turbidity.value = 3.5;
  su.rayleigh.value = 2.2;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.82;

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -150; sc.right = 150; sc.top = 170; sc.bottom = -130; sc.near = 50; sc.far = 1400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5b5a3c, 0.8);
  scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xbfd3e6, 0.00016);

  /* ---------- 地形 ---------- */
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, 400, 400);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(0x6f8a45), cB = new THREE.Color(0x9a9a5a), cC = new THREE.Color(0x4f6e36), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z, sites);
    pos.setY(i, h);
    const n1 = fbm(x / 260, z / 260, 4), n2 = fbm(x / 60 + 9, z / 60, 3);
    // 田块条带（农牧交错带：草场 + 条状农田）
    const field = Math.floor((x + 9000) / 180) % 3 === 0 && Math.abs(z) > 600 ? 1 : 0;
    tmp.copy(cA).lerp(cB, THREE.MathUtils.clamp(n1 * 1.4 - 0.35 + field * 0.35, 0, 1)).lerp(cC, n2 * 0.35);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.97, metalness: 0, map: detailTexture(),
  }));
  ground.receiveShadow = true;
  scene.add(ground);
  env.ground = ground;

  /* ---------- 吊装平台（主机位）+ 检修道路 ---------- */
  const gravel = new THREE.MeshStandardMaterial({ color: 0xa39a88, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [sx, sz] of sites) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(45, 25), gravel);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(sx - 5, terrainHeight(sx, sz, sites) + 0.03, sz + 22);
    pad.receiveShadow = true;
    scene.add(pad);
    const ring = new THREE.Mesh(new THREE.CircleGeometry(9, 48), gravel);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sx, terrainHeight(sx, sz, sites) + 0.02, sz);
    ring.receiveShadow = true;
    scene.add(ring);
  }
  // 道路：连接各机位的平滑折线，贴地带状网格
  const pts = [new THREE.Vector3(-3600, 0, 180), new THREE.Vector3(-1200, 0, 120), new THREE.Vector3(-300, 0, 60), new THREE.Vector3(-5, 0, 36),
    new THREE.Vector3(400, 0, 250), new THREE.Vector3(1000, 0, 280), new THREE.Vector3(1500, 0, 600), new THREE.Vector3(3800, 0, 900)];
  const curve = new THREE.CatmullRomCurve3(pts);
  const N = 500, W = 5;
  const rp = new Float32Array((N + 1) * 2 * 3), ri = [];
  for (let i = 0; i <= N; i++) {
    const p = curve.getPoint(i / N), t = curve.getTangent(i / N);
    const nx = -t.z, nz = t.x;
    for (let s = 0; s < 2; s++) {
      const x = p.x + nx * W * (s ? 0.5 : -0.5), z = p.z + nz * W * (s ? 0.5 : -0.5);
      rp.set([x, terrainHeight(x, z, sites) + 0.06, z], (i * 2 + s) * 3);
    }
    if (i < N) { const a = i * 2; ri.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  rg.setIndex(ri); rg.computeVertexNormals();
  const road = new THREE.Mesh(rg, gravel);
  road.receiveShadow = true;
  scene.add(road);

  /* ---------- 杨树防护林带（实例化） ---------- */
  const trees = [];
  const rnd = (() => { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let row = -9; row <= 9; row++) {
    const zRow = row * 430 + 90;
    for (let x = -3800; x < 3800; x += 7 + rnd() * 3) {
      if (rnd() < 0.22) continue;
      const z = zRow + (rnd() - 0.5) * 3;
      if (sites.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 200)) continue;
      if (Math.abs(x) < 120 && Math.abs(z) < 300) continue;
      trees.push([x, z, 13 + rnd() * 8]);
    }
  }
  for (let k = 0; k < 900; k++) {
    const x = (rnd() - 0.5) * 7600, z = (rnd() - 0.5) * 7600;
    if (sites.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 260)) continue;
    trees.push([x, z, 6 + rnd() * 9]);
  }
  const crownGeo = new THREE.SphereGeometry(1, 8, 6);
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 5);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3f5f2a, roughness: 0.95 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6d5a45, roughness: 1 });
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
  const tc = new THREE.Color();
  trees.forEach(([x, z, h], i) => {
    const y = terrainHeight(x, z, sites);
    p3.set(x, y + h * 0.58, z); s3.set(h * 0.17, h * 0.45, h * 0.17);
    crowns.setMatrixAt(i, m4.compose(p3, q, s3));
    tc.setHSL(0.24 + rnd() * 0.05, 0.35, 0.22 + rnd() * 0.08);
    crowns.setColorAt(i, tc);
    p3.set(x, y + h * 0.2, z); s3.set(1, h * 0.4, 1);
    trunks.setMatrixAt(i, m4.compose(p3, q, s3));
  });
  crowns.castShadow = true; crowns.receiveShadow = true;
  scene.add(crowns, trunks);

  /* ---------- 比例参照：人物与检修车 ---------- */
  const person = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xd2a07c, roughness: 0.8 });
  const suit = new THREE.MeshStandardMaterial({ color: 0xf47a1f, roughness: 0.8 }); // 橙色工装
  const pants = new THREE.MeshStandardMaterial({ color: 0x2c3e57, roughness: 0.8 });
  const helmet = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const leg = new THREE.CylinderGeometry(0.085, 0.075, 0.86, 8);
  const l1 = new THREE.Mesh(leg, pants); l1.position.set(-0.1, 0.43, 0);
  const l2 = new THREE.Mesh(leg, pants); l2.position.set(0.1, 0.43, 0);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), suit); torso.position.y = 1.16;
  const arm = new THREE.CapsuleGeometry(0.055, 0.55, 4, 8);
  const a1 = new THREE.Mesh(arm, suit); a1.position.set(-0.26, 1.15, 0); a1.rotation.z = 0.12;
  const a2 = new THREE.Mesh(arm, suit); a2.position.set(0.26, 1.15, 0); a2.rotation.z = -0.12;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), skin); head.position.y = 1.58;
  const hat = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), helmet); hat.position.y = 1.62;
  person.add(l1, l2, torso, a1, a2, head, hat);
  person.traverse((o) => { o.castShadow = true; });
  person.position.set(2.2, 0.02, 7.5);
  person.rotation.y = Math.PI * 0.85;
  scene.add(person);
  env.person = person;

  const van = new THREE.Group();
  const vanMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.4, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.6 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(5.9, 2.2, 2.05), vanMat); body.position.y = 1.45;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 1.95), glass); cab.position.set(2.6, 1.95, 0);
  van.add(body, cab);
  for (const [x, z] of [[-1.9, 0.95], [-1.9, -0.95], [1.9, 0.95], [1.9, -0.95]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16), tyre);
    w.rotation.x = Math.PI / 2; w.position.set(x, 0.36, z);
    van.add(w);
  }
  van.traverse((o) => { o.castShadow = true; });
  van.position.set(-12, 0.05, 24);
  van.rotation.y = 0.15;
  scene.add(van);

  /* ---------- 夜间/昼间 ---------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  envScene.add(envSky);
  let envRT = null;

  env.update = (hour, center) => {
    const { elev, azim } = sunPosition(hour);
    const dir = new THREE.Vector3(Math.sin(azim) * Math.cos(elev), Math.sin(elev), -Math.cos(azim) * Math.cos(elev));
    su.sunPosition.value.copy(dir);
    const day = THREE.MathUtils.smoothstep(elev, -0.1, 0.12);
    const warm = 1 - THREE.MathUtils.smoothstep(elev, 0.02, 0.5);
    sun.color.setRGB(1, 1 - 0.35 * warm, 1 - 0.6 * warm);
    sun.intensity = 3.2 * THREE.MathUtils.smoothstep(elev, -0.02, 0.25);
    const d = elev > 0 ? dir : dir.clone().setY(Math.abs(dir.y) + 0.2);
    sun.position.copy(center).addScaledVector(d.normalize(), 800);
    sun.target.position.copy(center);
    hemi.intensity = 0.08 + 0.75 * day;
    hemi.color.setRGB(0.55 + 0.25 * day, 0.62 + 0.25 * day, 0.85 + 0.1 * day);
    renderer.toneMappingExposure = 0.35 + 0.35 * day;
    scene.fog.color.setRGB(0.05 + 0.7 * day, 0.07 + 0.76 * day, 0.12 + 0.8 * day).lerp(new THREE.Color(0.95, 0.6, 0.4), warm * day * 0.35);
    env.isNight = elev < -0.03;
    env.day = day;
    // 环境反射贴图（金属件反射天空）
    envSky.material.uniforms.sunPosition.value.copy(dir);
    Object.assign(envSky.material.uniforms.turbidity, { value: su.turbidity.value });
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(envScene);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.25 + 0.75 * day;
  };
  env.setHaze = (rh) => {
    su.turbidity.value = 1.6 + rh * 2.2;
    scene.fog.density = 0.00009 + rh * 0.00016;
  };
  env.sun = sun;
  return env;
}

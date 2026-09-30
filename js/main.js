/**
 * main.js — 场景装配、仿真主循环、界面绑定
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { NREL5MW, DEG } from './data/nrel5mw.js';
import { buildTables } from './aero/bem.js';
import { TurbineSim, MODES } from './sim/turbineSim.js';
import { TERRAINS } from './sim/atmosphere.js';
import { createTurbine, setCutaway, MAT } from './model/turbine.js';
import { createEnvironment, terrainHeight, GLOW_TEX } from './model/environment.js';
import { createFlow } from './model/flow.js';
import { Charts } from './ui/charts.js';

const $ = (id) => document.getElementById(id);
const T5 = NREL5MW;
const R = T5.rotorRadius;

/* ================= 渲染器 / 场景 / 相机 ================= */
const app = $('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 5 });
document.body.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.3, 40000);
camera.position.set(-230, 55, 190);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 70, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 3;
controls.maxDistance = 7000;
controls.maxPolarAngle = Math.PI * 0.94; // 允许在地面仰视（高度另行限制在地面以上）

/* ================= 风电场布置 ================= */
// 行内间距 4D = 504 m（南北向），排间距 8D = 1008 m（东西向），主导风向为西风
const FARM = [
  { name: 'A1', x: 0, z: -1008 }, { name: 'A2', x: 0, z: -504 }, { name: 'A3', x: 0, z: 0, main: true }, { name: 'A4', x: 0, z: 504 },
  { name: 'B1', x: 1008, z: -756 }, { name: 'B2', x: 1008, z: -252 }, { name: 'B3', x: 1008, z: 252 }, { name: 'B4', x: 1008, z: 756 },
];
const sites = FARM.map((f) => [f.x, f.z]);
const env = createEnvironment(scene, renderer, sites);

/* ================= 风机 ================= */
const main = createTurbine({ detail: 'full' });
scene.add(main.root);
const farmTurbines = FARM.filter((f) => !f.main).map((f) => {
  const t = createTurbine({ detail: 'far' });
  t.root.position.set(f.x, terrainHeight(f.x, f.z, sites), f.z);
  scene.add(t.root);
  return { ...f, t, az: Math.random() * 6.28, rpm: 0, pitch: 90, P: 0 };
});

// 航空障碍灯光晕（全场同步闪烁，符合民航规定）
const glowMat = new THREE.SpriteMaterial({ map: GLOW_TEX, color: 0xff3020, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const glows = [main, ...farmTurbines.map((f) => f.t)].map((t) => {
  const s = new THREE.Sprite(glowMat);
  s.scale.setScalar(9);
  t.obstacle.add(s);
  return s;
});

const flow = createFlow(scene);

/* ================= 仿真 ================= */
let sim = null;
let charts = null;
const ui = {
  timeScale: 1, cut: false, labels: false, showFlow: true, showProfile: true, hour: 10.5,
};

/* ================= 相机预设 ================= */
let camTween = null;
function headingVecs() {
  const H = (sim ? sim.heading : 270) * DEG;
  const u = new THREE.Vector3(Math.sin(H), 0, -Math.cos(H)); // 指向上风向
  const s = new THREE.Vector3(Math.cos(H), 0, Math.sin(H));  // 右侧
  return { u, s };
}
function viewPose(name) {
  const { u, s } = headingVecs();
  const hub = new THREE.Vector3(0, T5.hubHeight, 0).addScaledVector(u, 5);
  const nac = new THREE.Vector3(0, T5.tower.height + 2.4, 0).addScaledVector(u, -6);
  switch (name) {
    case 'front': return { pos: hub.clone().addScaledVector(u, 125).addScaledVector(s, -30).add(new THREE.Vector3(0, -22, 0)), tgt: hub };
    case 'human': return { pos: new THREE.Vector3(-9, 1.7, 45), tgt: new THREE.Vector3(0, 31, 0), fov: 68 };
    case 'nacelle': return { pos: nac.clone().addScaledVector(s, 26).addScaledVector(u, -14).add(new THREE.Vector3(0, 8, 0)), tgt: nac.clone().addScaledVector(u, 3) };
    case 'cutaway': return { pos: nac.clone().addScaledVector(s, 21).addScaledVector(u, -7).add(new THREE.Vector3(0, 7, 0)), tgt: nac.clone().addScaledVector(u, 1.5).add(new THREE.Vector3(0, -0.8, 0)) };
    case 'farm': return { pos: new THREE.Vector3(-1500, 950, 1700), tgt: new THREE.Vector3(420, 40, 0) };
    default: return { pos: hub.clone().addScaledVector(u, 200).addScaledVector(s, -170).add(new THREE.Vector3(0, -30, 0)), tgt: new THREE.Vector3(0, 68, 0) };
  }
}
function goView(name) {
  const p = viewPose(name);
  camTween = { t: 0, dur: 1.4, p0: camera.position.clone(), t0: controls.target.clone(), p1: p.pos, t1: p.tgt, f0: camera.fov, f1: p.fov || 42 };
  if (name === 'cutaway') { setToggle('tgCut', true); setToggle('tgLabels', true); }
  document.querySelectorAll('#viewBtns button').forEach((b) => b.classList.toggle('on', b.dataset.v === name));
}
function setToggle(id, v) { $(id).checked = v; $(id).dispatchEvent(new Event('change')); }

/* ================= 界面绑定 ================= */
function compassName(d) {
  const n = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return `${n[Math.round(d / 45) % 8]}风`;
}
function bindUI() {
  const e = sim.env;
  const rng = (id, fn) => $(id).addEventListener('input', (ev) => fn(+ev.target.value));
  rng('vMean', (v) => { e.Vmean = v; $('vVal').textContent = v.toFixed(1); sim.applyEnv(); });
  document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => {
    $('vMean').value = b.dataset.v; $('vMean').dispatchEvent(new Event('input'));
  }));
  rng('dir', (v) => { e.dirMean = v; });
  $('dirDrift').addEventListener('change', (ev) => { e.dirDrift = ev.target.checked; });
  $('turb').addEventListener('change', (ev) => { e.turbClass = ev.target.value; sim.applyEnv(); });
  $('terrain').addEventListener('change', (ev) => { e.terrain = ev.target.value; sim.applyEnv(); });
  rng('temp', (v) => { e.tempC = v; $('tVal').textContent = v; sim.applyEnv(); });
  rng('alt', (v) => { e.altitude = v; $('altVal').textContent = v; sim.applyEnv(); });
  rng('rh', (v) => { e.rh = v / 100; $('rhVal').textContent = v; sim.applyEnv(); env.setHaze(v / 100); });
  rng('hour', (v) => { ui.hour = v; envDirty = true; });
  rng('annual', (v) => { e.annualMean = v; $('annVal').textContent = v.toFixed(1); sim._curveDirty = true; });
  $('btnEOG').addEventListener('click', () => sim.triggerEOG());
  $('yawAuto').addEventListener('change', (ev) => {
    sim.yawAuto = ev.target.checked;
    $('yawManual').disabled = sim.yawAuto;
    if (!sim.yawAuto) { sim.yawTarget = Math.round(sim.heading); $('yawManual').value = sim.yawTarget; }
    else sim.yawState = 'HOLD';
  });
  rng('yawManual', (v) => { sim.yawTarget = v; });
  $('btnStop').addEventListener('click', () => { sim.toggleUserStop(); });
  $('btnEstop').addEventListener('click', () => sim.emergencyStop());
  $('btnReset').addEventListener('click', () => sim.resetFaults());

  document.querySelectorAll('#timeScale button').forEach((b) => b.addEventListener('click', () => {
    ui.timeScale = +b.dataset.s;
    document.querySelectorAll('#timeScale button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#viewBtns button').forEach((b) => b.addEventListener('click', () => goView(b.dataset.v)));
  $('tgCut').addEventListener('change', (ev) => { ui.cut = ev.target.checked; setCutaway(main, ui.cut); });
  $('tgLabels').addEventListener('change', (ev) => { ui.labels = ev.target.checked; });
  $('tgFlow').addEventListener('change', (ev) => { ui.showFlow = ev.target.checked; });
  $('tgProfile').addEventListener('change', (ev) => { ui.showProfile = ev.target.checked; });

  document.querySelectorAll('#chartTabs button[data-t]').forEach((b) => b.addEventListener('click', () => {
    charts.tab = b.dataset.t;
    document.querySelectorAll('#chartTabs button[data-t]').forEach((x) => x.classList.toggle('on', x === b));
    if ($('bottom').classList.contains('collapsed')) $('btnCollapse').click();
  }));
  $('btnCollapse').addEventListener('click', () => {
    const c = $('bottom').classList.toggle('collapsed');
    document.body.classList.toggle('charts-collapsed', c);
    $('btnCollapse').textContent = c ? '▴' : '▾';
  });
  const toggleUI = () => document.body.classList.toggle('hide-ui');
  $('btnHideUI').addEventListener('click', toggleUI);
  addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === 'h' || ev.key === 'H') toggleUI();
    if (ev.key === 'Escape') $('drawer').hidden = true;
  });
  $('btnInfo').addEventListener('click', () => { $('drawer').hidden = false; });
  $('drClose').addEventListener('click', () => { $('drawer').hidden = true; });
  $('drawer').addEventListener('click', (ev) => { if (ev.target.id === 'drawer') $('drawer').hidden = true; });
}

/* ---------------- SCADA 表格 ---------------- */
const SCADA = [
  ['风'],
  ['Vhub', '轮毂瞬时风速', 'm/s', (o) => o.Vhub.toFixed(2)],
  ['Vrews', '叶轮等效风速', 'm/s', (o) => o.Vrews.toFixed(2)],
  ['dir', '瞬时风向', '°', (o) => o.dir.toFixed(0)],
  ['yawErr', '对风误差', '°', (o) => o.yawErr.toFixed(1), (o) => (Math.abs(o.yawErr) > 15 ? 'crit' : Math.abs(o.yawErr) > 8 ? 'warn' : '')],
  ['叶轮'],
  ['rpm', '叶轮转速', 'rpm', (o) => o.rotorRpm.toFixed(2), (o) => (o.rotorRpm > 13.3 ? 'crit' : '')],
  ['tip', '叶尖线速度', 'm/s', (o) => o.tip.toFixed(1)],
  ['lambda', '叶尖速比 λ', '', (o) => (o.rotorRpm > 0.3 ? o.lambda.toFixed(2) : '—')],
  ['pitch', '桨距角 β', '°', (o) => o.pitchDeg.toFixed(2)],
  ['cp', '功率系数 Cp', '', (o) => o.Cp.toFixed(3)],
  ['ct', '推力系数 Ct', '', (o) => o.Ct.toFixed(3)],
  ['传动链'],
  ['genRpm', '发电机转速', 'rpm', (o) => o.genRpm.toFixed(0)],
  ['genTq', '发电机转矩', 'kN·m', (o) => (o.genTrq / 1e3).toFixed(1)],
  ['q', '主轴气动转矩', 'MN·m', (o) => (o.Qaero / 1e6).toFixed(2)],
  ['brake', '高速轴制动', '%', (o) => (o.brake * 100).toFixed(0), (o) => (o.brake > 0.05 ? 'crit' : '')],
  ['载荷与变形'],
  ['thrust', '叶轮推力', 'kN', (o) => (o.Thrust / 1e3).toFixed(0)],
  ['my', '塔底倾覆弯矩', 'MN·m', (o) => (o.towerBaseMy / 1e6).toFixed(1)],
  ['flap', '叶根挥舞(叶片1)', 'MN·m', (o) => (o.flap[0] / 1e6).toFixed(2)],
  ['edge', '叶根摆振(叶片1)', 'MN·m', (o) => (o.edge[0] / 1e6).toFixed(2)],
  ['defl', '叶尖挥舞变形', 'm', (o) => o.tipDefl[0].toFixed(2)],
  ['clr', '叶尖—塔筒净距*', 'm', (o) => o.clearance.toFixed(2), (o) => (o.clearance < 3 ? 'crit' : o.clearance < 5 ? 'warn' : '')],
  ['twr', '塔顶位移', 'm', (o) => o.twrX.toFixed(3)],
  ['偏航'],
  ['hdg', '机舱朝向', '°', (o) => o.heading.toFixed(1)],
  ['yst', '偏航状态', '', () => ({ HOLD: '保持', CW: '偏航中 →', CCW: '偏航中 ←', UNTWIST: '解缆中' })[sim.yawState]],
  ['cab', '电缆扭转', '圈', () => (sim.cableTwist / 360).toFixed(2)],
  ['rho', '空气密度', 'kg/m³', () => sim.rho.toFixed(3)],
];
const scadaEls = {};
function buildScada() {
  const g = $('scada');
  for (const row of SCADA) {
    if (row.length === 1) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = row[0]; g.appendChild(d); continue; }
    const [key, label, unit] = row;
    const d = document.createElement('div');
    d.innerHTML = `<span class="k">${label}</span><span class="v"><b>—</b><small>${unit}</small></span>`;
    g.appendChild(d);
    scadaEls[key] = { v: d.querySelector('.v'), b: d.querySelector('b'), row };
  }
  $('scada').insertAdjacentHTML('beforeend', '<small class="note" style="grid-column:1/-1">* 叶片转到正下方时的估算值（静态几何净距 − 叶尖变形 − 塔顶位移）</small>');
}
function updateScada() {
  const o = sim.out;
  for (const key in scadaEls) {
    const { v, b, row } = scadaEls[key];
    b.textContent = row[3](o);
    v.className = `v ${row[4] ? row[4](o) : ''}`;
  }
  const P = o.Pelec / 1e6;
  $('mP').textContent = P.toFixed(3);
  $('mPbar').style.width = `${Math.min(100, (P / 5) * 100)}%`;
  // 能量流：以来流风功率为 100%
  const w = Math.max(o.Pwind, 1);
  const set = (id, p) => { $(id).style.width = `${Math.max(0, Math.min(100, (p / w) * 100))}%`; $(`${id}v`).textContent = `${(p / 1e6).toFixed(2)} MW`; };
  set('efW', o.Pwind); set('efB', o.Pwind * 0.593); set('efA', Math.max(0, o.Paero)); set('efE', o.Pelec);

  const m = MODES[o.mode];
  const cm = $('chipMode');
  cm.textContent = m.label + (sim.userStop && o.mode !== 'ESTOP' ? '（人工停机）' : '') + (sim.estopLatched && o.mode === 'PARKED' ? '（急停锁定，需复位）' : '');
  cm.className = `chip ${m.tone === 'muted' ? '' : m.tone}`;
  const regTxt = { '1': '区域 1 · 启动加速', '1.5': '区域 1.5 · 最低转速过渡', '2': '区域 2 · 最佳 Cp 跟踪', '2.5': '区域 2.5 · 额定转速过渡', '3': '区域 3 · 恒功率变桨', '—': '控制区域 —' };
  $('chipRegion').textContent = regTxt[o.region] || o.region;
  const mm = Math.floor(o.t / 60), ss = Math.floor(o.t % 60);
  $('chipClock').textContent = `仿真时间 ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const wf = sim.env.wakeFactor;
  $('chipWake').hidden = wf > 0.995;
  $('chipWake').textContent = `A3 处于上游尾流中 · 风速 −${((1 - wf) * 100).toFixed(1)}%`;
  $('btnStop').textContent = sim.userStop ? '恢复运行' : '正常停机';

  $('rhoVal').textContent = `${sim.rho.toFixed(3)} kg/m³（${(sim.pressure / 1000).toFixed(1)} kPa）`;
  $('alphaVal').textContent = `${sim.alphaEq.toFixed(3)} · REWS/V_hub = ${sim.rews.toFixed(3)}`;
  $('sigmaVal').textContent = sim.Iref > 0 ? `${sim.sigma1.toFixed(2)} m/s（TI ${(sim.sigma1 / Math.max(sim.env.Vmean, 0.1) * 100).toFixed(1)}%）` : '0（层流）';
  $('dirVal').textContent = sim.env.dirMean.toFixed(0);
  $('dirName').textContent = compassName(sim.env.dirMean);
  if (sim.env.dirDrift) $('dir').value = sim.env.dirMean.toFixed(0);
  if (!sim.yawAuto) $('yawVal').textContent = sim.yawTarget.toFixed(0);
  else $('yawVal').textContent = sim.heading.toFixed(0);
  const h = Math.floor(ui.hour), mi = Math.round((ui.hour - h) * 60);
  $('hourVal').textContent = `${String(h % 24).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

  const pc = sim.powerCurve();
  $('aep').textContent = (pc.aepWh / 1e9).toFixed(2);
  $('cf').textContent = `${(pc.cf * 100).toFixed(1)}%`;
  $('flh').textContent = (pc.aepWh / 5e6).toFixed(0);
  $('homes').textContent = Math.round(pc.aepWh / 1e3 / 3000).toLocaleString();
}

/* ---------------- 风电场尾流（Jensen） ---------------- */
function circleOverlap(d, r1, r2) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}
let farmState = null;
function computeFarm() {
  const e = sim.env;
  const th = e.dirMean * DEG;
  const dx = -Math.sin(th), dz = Math.cos(th);
  const k = 0.4 * Math.max(sim.Iref, 0.04) + 0.004;
  const list = FARM.map((f) => ({ ...f, s: f.x * dx + f.z * dz, n: -f.x * dz + f.z * dx }));
  list.sort((a, b) => a.s - b.s);
  const free = sim.steadyState(e.Vmean * sim.rews);
  for (const t of list) {
    let sum2 = 0;
    for (const u of list) {
      if (u === t || u.s >= t.s - 1) continue;
      const ds = t.s - u.s;
      const Rw = R + k * ds;
      const frac = circleOverlap(Math.abs(t.n - u.n), R, Rw) / (Math.PI * R * R);
      const d = (1 - Math.sqrt(Math.max(0, 1 - Math.min(u.ct, 0.96)))) * (R / Rw) ** 2 * frac;
      sum2 += d * d;
    }
    t.deficit = Math.sqrt(sum2);
    t.V = e.Vmean * (1 - t.deficit);
    const ss = sim.steadyState(t.V * sim.rews);
    t.ct = ss.Ct; t.P = ss.P; t.Pfree = free.P; t.rpm = ss.rpm; t.pitch = ss.P > 0 ? ss.pitch : 90;
  }
  const m = list.find((t) => t.main);
  e.wakeFactor += ((1 - m.deficit) - e.wakeFactor) * 0.3;
  m.P = sim.out.Pelec;
  for (const ft of farmTurbines) {
    const r = list.find((t) => t.name === ft.name);
    ft.rpm = r.rpm; ft.pitch = r.pitch; ft.P = r.P;
  }
  farmState = FARM.map((f) => list.find((t) => t.name === f.name));
}

/* ================= 主循环 ================= */
const clock = new THREE.Clock();
let acc = 0, uiTimer = 0, chartTimer = 0, farmTimer = 0, spanTimer = 0, spanData = null;
let envDirty = true;
const tmpV = new THREE.Vector3();

function frame() {
  requestAnimationFrame(frame);
  tick(Math.min(clock.getDelta(), 0.1));
}

/** 单帧：仿真步进 + 场景同步 + 渲染（rdt 为真实经过时间 s） */
function tick(rdt) {
  const wall = performance.now() / 1000;

  // ---- 仿真步进（固定 20 ms 步长）----
  const simDt = rdt * ui.timeScale;
  acc += simDt;
  let steps = 0;
  while (acc >= 0.02 && steps < 600) { sim.step(0.02); acc -= 0.02; steps++; }
  const o = sim.out;

  // ---- 主风机姿态 ----
  const H = sim.heading * DEG;
  main.yaw.rotation.y = -H - Math.PI / 2;
  const down = tmpV.set(-Math.sin(H), 0, Math.cos(H)); // 顺风向（叶轮轴线指向下风）
  main.yaw.position.set(down.x * o.twrX, T5.tower.height, down.z * o.twrX);
  main.towerMat.userData.uniforms.uTopDisp.value = o.twrX;
  main.towerMat.userData.uniforms.uDir.value.copy(down);
  main.rotor.rotation.x = sim.azimuth;
  main.lss.rotation.x = sim.azimuth;
  main.hss.rotation.x = (main.hss.rotation.x + (sim.Omega * T5.drivetrain.gearRatio) * simDt) % (Math.PI * 2);
  const beta = sim.pitch;
  main.blades.forEach((b, i) => {
    b.pitch.rotation.y = -beta;
    const u = b.mat.userData.uniforms;
    u.uTipDefl.value = o.tipDefl[i];
    u.uFlapDir.value.set(Math.cos(beta), 0, -Math.sin(beta));
  });
  main.cups.rotation.y -= Math.max(0, o.Vhub) * 1.0 * rdt * Math.min(ui.timeScale, 1.5);
  main.vane.rotation.y = -o.yawErr * DEG;

  // ---- 陪衬风机（稳态解 + 各自尾流）----
  for (const f of farmTurbines) {
    f.t.yaw.rotation.y = -sim.env.dirMean * DEG - Math.PI / 2;
    f.az = (f.az + ((f.rpm * 2 * Math.PI) / 60) * simDt) % (Math.PI * 2);
    f.t.rotor.rotation.x = f.az;
    f.t.blades.forEach((b) => { b.pitch.rotation.y = -f.pitch * DEG; });
  }

  // ---- 航空障碍灯：夜间红闪 30 次/分，全场同步 ----
  const flashOn = env.isNight && (wall % 2) < 0.45;
  MAT.red.emissiveIntensity = flashOn ? 6 : env.isNight ? 0.15 : 0;
  for (const g of glows) g.visible = flashOn;
  for (const l of main.midLights) l.visible = true;

  // ---- 流场 ----
  const hubGround = new THREE.Vector3(Math.sin(H) * 5, 0, -Math.cos(H) * 5);
  flow.update(sim, simDt, hubGround, ui.showFlow, ui.showProfile, env.day ?? 1);

  // ---- 相机 ----
  if (camTween) {
    camTween.t += rdt;
    const k = Math.min(1, camTween.t / camTween.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    camera.fov = camTween.f0 + (camTween.f1 - camTween.f0) * e;
    if (k >= 1) camTween = null;
  }
  controls.update();
  const gy = terrainHeight(camera.position.x, camera.position.z, sites) + 1.2;
  if (camera.position.y < gy) camera.position.y = gy;
  const dist = camera.position.distanceTo(controls.target);
  camera.near = THREE.MathUtils.clamp(dist * 0.004, 0.05, 2);
  camera.updateProjectionMatrix();

  // 部件标注：开启且距离机舱不太远时显示
  const nearNac = camera.position.distanceTo(tmpV.set(0, 88, 0)) < 260;
  for (const l of main.labels) l.visible = ui.labels && (nearNac || camera.position.y < 30);

  // ---- 环境（太阳/天空）----
  if (envDirty) { env.update(ui.hour, new THREE.Vector3(0, 60, 0)); envDirty = false; }

  // ---- 界面刷新 ----
  uiTimer += rdt; chartTimer += rdt; farmTimer += rdt; spanTimer += rdt;
  if (farmTimer > 0.5) { farmTimer = 0; computeFarm(); }
  if (uiTimer > 0.2) { uiTimer = 0; updateScada(); }
  if (charts.tab === 'span' && spanTimer > 0.3) { spanTimer = 0; spanData = sim.spanwise(); }
  if (chartTimer > (charts.hover ? 0.05 : 0.15)) { chartTimer = 0; charts.draw(sim, { span: spanData, farm: farmState }); }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

/* ================= 启动 ================= */
function start() {
  const t0 = performance.now();
  const tables = buildTables();
  sim = new TurbineSim(tables);
  sim.calibrate();
  // 以正在运行的状态开场：先在后台“预跑” 150 s，让机组完成启动并网，时序图也有数据
  sim.heading = sim.env.dirMean;
  sim.windAvg = sim.env.Vmean;
  sim.gust3s = sim.env.Vmean;
  for (let i = 0; i < 150 / 0.02; i++) sim.step(0.02);
  console.info(`BEM 表 ${tables.nL}×${tables.nP}，初始化 ${(performance.now() - t0).toFixed(0)} ms`);
  charts = new Charts($('chart'), $('tooltip'));
  buildScada();
  bindUI();
  env.setHaze(0.6);
  computeFarm();
  goView('overview');
  camTween.dur = 0.01;
  $('loading').classList.add('done');
  window.twin = { sim, goView, camera, controls, tick }; // 便于在控制台调试
  frame();
}
setTimeout(() => {
  try { start(); } catch (err) {
    $('ldMsg').textContent = `初始化失败：${err.message}`;
    console.error(err);
  }
}, 50);

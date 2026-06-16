/**
 * main.js — 场景搭建、风场、动画循环与 UI 交互
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTurbine } from './turbine.js';
import { GeneratorViz } from './generator.js';
import * as P from './physics.js';

/* ============ 1. 场景 / 相机 / 渲染器 ============ */
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b7e8);
scene.fog = new THREE.Fog(0x9cc4ea, 250, 700);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(140, 90, 160);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 70, 0);
controls.maxPolarAngle = Math.PI / 2.05;
controls.minDistance = 60;
controls.maxDistance = 500;

/* ============ 2. 灯光 ============ */
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a6a4a, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(120, 180, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 600;
sun.shadow.camera.left = -200;
sun.shadow.camera.right = 200;
sun.shadow.camera.top = 200;
sun.shadow.camera.bottom = -200;
scene.add(sun);

/* ============ 3. 地面 ============ */
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(600, 64),
  new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 远处几台“陪衬”风机（静态，营造风电场感）
function addBackgroundTurbine(x, z, scale) {
  const { group, rotor } = createTurbine();
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  group.userData.rotor = rotor;
  scene.add(group);
  bgTurbines.push(group);
}
const bgTurbines = [];
addBackgroundTurbine(-220, -120, 0.7);
addBackgroundTurbine(180, -200, 0.85);
addBackgroundTurbine(-300, -260, 0.6);

/* ============ 4. 主风机 ============ */
const turbine = createTurbine();
scene.add(turbine.group);

/* ============ 4b. 输电线 + 小房子（发电去向）============ */
// 从塔基沿地面拉一条电缆到一组小房子，缆上跑“能量脉冲”表示送电。
const houseGroup = new THREE.Group();
houseGroup.position.set(140, 0, 60);
scene.add(houseGroup);
const houseWindows = [];
for (let i = 0; i < 4; i++) {
  const h = 6 + Math.random() * 3;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(8, h, 8),
    new THREE.MeshStandardMaterial({ color: 0xe9dcc4, roughness: 0.8 })
  );
  body.position.set((i % 2) * 14, h / 2, Math.floor(i / 2) * 14);
  body.castShadow = true;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(6.5, 4, 4),
    new THREE.MeshStandardMaterial({ color: 0xa8503a, roughness: 0.8 })
  );
  roof.position.set(body.position.x, h + 2, body.position.z);
  roof.rotation.y = Math.PI / 4;
  // 窗户（受电后会发光的小方块）
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0xffd34a, emissiveIntensity: 0 })
  );
  win.position.set(body.position.x, h * 0.5, body.position.z + 4.05);
  houseGroup.add(body, roof, win);
  houseWindows.push(win.material);
}

// 电缆（从塔基到房屋）
const cableStart = new THREE.Vector3(0, 4, 0);
const cableEnd = new THREE.Vector3(140, 4, 60);
const cable = new THREE.Mesh(
  new THREE.CylinderGeometry(0.4, 0.4, cableStart.distanceTo(cableEnd), 8),
  new THREE.MeshStandardMaterial({ color: 0x333a44 })
);
cable.position.copy(cableStart.clone().lerp(cableEnd, 0.5));
cable.lookAt(cableEnd);
cable.rotateX(Math.PI / 2);
scene.add(cable);

// 能量脉冲（沿电缆流动的发光小球）
const PULSE = 14;
const pulses = [];
const pulseGeo = new THREE.SphereGeometry(1.1, 8, 8);
const pulseMat = new THREE.MeshBasicMaterial({ color: 0x9cffd6 });
for (let i = 0; i < PULSE; i++) {
  const m = new THREE.Mesh(pulseGeo, pulseMat);
  m.userData.t = i / PULSE;
  pulses.push(m);
  scene.add(m);
}

/* ============ 5. 风向指示（地面大箭头 + 风粒子）============ */
const windArrow = new THREE.Group();
const shaft = new THREE.Mesh(
  new THREE.CylinderGeometry(1.2, 1.2, 40, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd34a })
);
shaft.rotation.z = -Math.PI / 2;
shaft.position.x = -8;
const head = new THREE.Mesh(
  new THREE.ConeGeometry(4, 12, 16),
  new THREE.MeshBasicMaterial({ color: 0xffd34a })
);
head.rotation.z = -Math.PI / 2;
head.position.x = 18;
windArrow.add(shaft, head);
windArrow.position.set(0, 3, 90);
scene.add(windArrow);

// 风粒子：一团点云，沿风向平移
const PCOUNT = 600;
const pPos = new Float32Array(PCOUNT * 3);
const pField = 240;
for (let i = 0; i < PCOUNT; i++) {
  pPos[i * 3] = (Math.random() - 0.5) * pField;
  pPos[i * 3 + 1] = Math.random() * 130 + 5;
  pPos[i * 3 + 2] = (Math.random() - 0.5) * pField;
}
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const particles = new THREE.Points(
  pGeo,
  new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, transparent: true, opacity: 0.5 })
);
scene.add(particles);

/* ============ 6. 状态 ============ */
const state = {
  windSpeed: 8,
  windDirDeg: 0,    // 风“来自”的方向，0°=从 +Z 吹向 -Z
  autoYaw: true,
  autoWind: false,
  nacelleYaw: 0,    // 机舱当前朝向（弧度），平滑趋近目标
  bladeAngle: 0,
};

/* ============ 7. UI 绑定 ============ */
const el = (id) => document.getElementById(id);
const ui = {
  windSpeed: el('windSpeed'), windSpeedVal: el('windSpeedVal'), windStage: el('windStage'),
  windDir: el('windDir'), windDirVal: el('windDirVal'),
  autoYaw: el('autoYaw'), autoWind: el('autoWind'),
  power: el('power'), windPower: el('windPower'), cp: el('cp'), rpm: el('rpm'),
  powerBar: el('powerBar'), ratedVal: el('ratedVal'),
  houses: el('houses'), houseIcons: el('houseIcons'),
  annualMWh: el('annualMWh'), hhUseVal: el('hhUseVal'), status: el('status'),
};
ui.ratedVal.textContent = P.TURBINE.ratedPower;
ui.hhUseVal.textContent = P.HOUSEHOLD_KWH_PER_YEAR;

// 发电机原理可视化
const genViz = new GeneratorViz(el('genCanvas'));

ui.windSpeed.addEventListener('input', (e) => { state.windSpeed = +e.target.value; });
ui.windDir.addEventListener('input', (e) => { state.windDirDeg = +e.target.value; });
ui.autoYaw.addEventListener('change', (e) => { state.autoYaw = e.target.checked; });
ui.autoWind.addEventListener('change', (e) => { state.autoWind = e.target.checked; });
document.querySelectorAll('.presets button').forEach((b) => {
  b.addEventListener('click', () => {
    state.windSpeed = +b.dataset.v;
    ui.windSpeed.value = state.windSpeed;
  });
});

/* ============ 8. 动画循环 ============ */
const clock = new THREE.Clock();
let dashTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // 自动阵风：风向缓慢游走
  if (state.autoWind) {
    state.windDirDeg = (state.windDirDeg + dt * 12) % 360;
    ui.windDir.value = state.windDirDeg.toFixed(0);
  }

  const v = state.windSpeed;
  const windRad = THREE.MathUtils.degToRad(state.windDirDeg);

  // 风向箭头绕风机旋转：指示风“吹去”的方向
  windArrow.position.set(Math.sin(windRad) * 90, 3, Math.cos(windRad) * 90);
  windArrow.rotation.y = windRad + Math.PI; // 箭头指向风机（即风的去向）

  // ---- 偏航控制 ----
  // 迎风目标：机舱（叶轮在 +X）要正对来风方向。
  let targetYaw = state.autoYaw ? windRad : state.nacelleYaw;
  if (state.autoYaw) {
    // 平滑趋近（偏航电机有限速，体现“缓慢转向对风”）
    let diff = ((targetYaw - state.nacelleYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
    const yawRate = 0.6; // rad/s
    state.nacelleYaw += THREE.MathUtils.clamp(diff, -yawRate * dt, yawRate * dt);
  }
  turbine.yaw.rotation.y = state.nacelleYaw;

  // 对风误差影响取能（余弦损失）
  let yawErr = state.autoYaw
    ? 0
    : Math.abs(((windRad - state.nacelleYaw + Math.PI) % (2 * Math.PI)) - Math.PI);
  const yawFactor = Math.max(0, Math.cos(yawErr));

  // ---- 叶片自转：转速由物理模型给出 ----
  const rpm = P.rotorRPM(v) * (state.autoYaw ? 1 : (0.5 + 0.5 * yawFactor));
  const omega = (rpm * 2 * Math.PI) / 60; // rad/s
  state.bladeAngle += omega * dt;
  turbine.rotor.rotation.x = state.bladeAngle;

  // 陪衬风机也转一点
  bgTurbines.forEach((t, i) => {
    t.userData.rotor.rotation.x += omega * dt * (0.6 + i * 0.1);
    t.rotation.y = state.nacelleYaw;
  });

  // ---- 发电机原理可视化 + 输电脉冲 ----
  const powerKW = P.electricalPowerKW(v) * yawFactor;
  const powerFrac = Math.min(1, powerKW / P.TURBINE.ratedPower);
  genViz.update(dt, rpm, powerFrac);

  // 能量脉冲沿电缆流动（速度/亮度 ∝ 功率）
  const moving = powerFrac > 0.001;
  pulseMat.color.setRGB(0.6 + 0.4 * powerFrac, 1, 0.84);
  pulses.forEach((m) => {
    if (moving) m.userData.t = (m.userData.t + dt * (0.15 + 0.5 * powerFrac)) % 1;
    m.position.lerpVectors(cableStart, cableEnd, m.userData.t);
    m.position.y = 4 + Math.sin(m.userData.t * Math.PI) * 8; // 缆线轻微下垂的反向弧
    m.visible = moving;
    m.scale.setScalar(0.5 + powerFrac);
  });

  // 房屋窗户随功率发光（接收到电）
  houseWindows.forEach((mat) => { mat.emissiveIntensity = powerFrac * 1.4; });

  // ---- 风粒子沿风向平移 ----
  const dirX = Math.sin(windRad + Math.PI);
  const dirZ = Math.cos(windRad + Math.PI);
  const speed = (5 + v * 3) * dt;
  const arr = pGeo.attributes.position.array;
  for (let i = 0; i < PCOUNT; i++) {
    arr[i * 3] += dirX * speed;
    arr[i * 3 + 2] += dirZ * speed;
    // 越界回卷
    if (Math.abs(arr[i * 3]) > pField / 2) arr[i * 3] -= Math.sign(arr[i * 3]) * pField;
    if (Math.abs(arr[i * 3 + 2]) > pField / 2) arr[i * 3 + 2] -= Math.sign(arr[i * 3 + 2]) * pField;
  }
  pGeo.attributes.position.needsUpdate = true;

  // ---- 仪表盘（每 0.15s 刷新，省 DOM 开销）----
  dashTimer += dt;
  if (dashTimer > 0.15) { dashTimer = 0; updateDashboard(v, yawFactor); }

  controls.update();
  renderer.render(scene, camera);
}

/* ============ 9. 仪表盘刷新 ============ */
function updateDashboard(v, yawFactor) {
  const powerKW = P.electricalPowerKW(v) * yawFactor;
  const windKW = P.windPowerW(v) / 1000;
  const cp = P.powerCoefficient(v);
  const rpm = P.rotorRPM(v);
  const stage = P.operatingStage(v);
  const hh = P.householdsServed(powerKW);

  ui.windSpeedVal.textContent = v.toFixed(1);
  ui.windDirVal.textContent = state.windDirDeg.toFixed(0);
  ui.power.textContent = powerKW.toFixed(0);
  ui.windPower.textContent = windKW.toFixed(0);
  ui.cp.textContent = cp.toFixed(2);
  ui.rpm.textContent = rpm.toFixed(1);
  ui.annualMWh.textContent = hh.annualMWh.toFixed(0);
  ui.houses.textContent = hh.houses.toLocaleString();

  // 功率条
  ui.powerBar.style.width = `${Math.min(100, (powerKW / P.TURBINE.ratedPower) * 100)}%`;

  // 阶段标签
  ui.windStage.textContent = stage.label;
  ui.windStage.style.color =
    stage.tone === 'danger' ? 'var(--danger)' :
    stage.tone === 'warn' ? 'var(--warn)' :
    stage.tone === 'ok' ? 'var(--accent)' : 'var(--muted)';

  // 状态角标
  ui.status.className = 'status ' + (stage.tone === 'muted' ? '' : stage.tone);
  ui.status.textContent =
    `风速 ${v.toFixed(1)} m/s · ${stage.label} · 输出 ${powerKW.toFixed(0)} kW`;

  // 家庭图标（最多画 60 个，每个代表一定户数）
  const maxIcons = 60;
  const perIcon = Math.max(1, Math.ceil(hh.houses / maxIcons));
  const n = Math.min(maxIcons, Math.floor(hh.houses / perIcon));
  if (ui.houseIcons.childElementCount !== n) {
    ui.houseIcons.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.textContent = '🏠';
      ui.houseIcons.appendChild(s);
    }
    ui.houseIcons.title = `每个 🏠 ≈ ${perIcon.toLocaleString()} 户`;
  }
}

/* ============ 10. 自适应窗口 ============ */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

ui.status.textContent = '就绪 · 拖动调节风速风向';
animate();

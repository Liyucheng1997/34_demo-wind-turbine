/**
 * turbine.js — NREL 5MW 整机 1:1 三维模型
 * ------------------------------------------------------------------
 * 场景层级（全部为米制，与 [J09] 几何参数一一对应）：
 *
 *   root                      塔基中心（地面）
 *    ├ foundation / tower     混凝土基础台 + 锥形钢塔 (Ø6.0 → Ø3.87 m, 87.6 m)
 *    └ yaw                    偏航轴承（塔顶 87.6 m），绕竖直轴转动 = 对风
 *        ├ nacelleShell       机舱罩 18 × 6 × 6 m（可切换剖视）
 *        ├ bedplate/yawDrives/converter/transformer …  机舱内固定设备
 *        └ shaft              主轴系，距塔顶 1.963 m，上仰 5°
 *            ├ mainShaft/gearbox/brake/generator      传动链（低速轴/高速轴转动）
 *            └ rotor          叶轮中心距偏航轴 5.019 m（悬伸），绕主轴转动
 *                ├ hub / spinner
 *                └ cone[i]    3 × 120°，锥角 2.5°
 *                    └ pitch[i]  变桨轴承，绕叶片轴转 β
 *                        └ blade  61.5 m 放样叶片
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NREL5MW } from '../data/nrel5mw.js';
import { createBladeGeometry, createBladeMaterial } from './blade.js';

const T = NREL5MW;
const D = Math.PI / 180;

/* ---------------- 共享材质 ---------------- */
export const MAT = {
  paint: new THREE.MeshStandardMaterial({ color: 0xe7eaec, roughness: 0.42, metalness: 0.12 }),     // RAL 7035 浅灰白
  shell: new THREE.MeshStandardMaterial({ color: 0xeef0f1, roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8a939b, roughness: 0.35, metalness: 0.85 }),
  darkSteel: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.7 }),
  cast: new THREE.MeshStandardMaterial({ color: 0x6f8190, roughness: 0.55, metalness: 0.5 }),       // 球墨铸铁（涂漆）
  gear: new THREE.MeshStandardMaterial({ color: 0x3f6f8f, roughness: 0.45, metalness: 0.4 }),       // 齿轮箱涂装
  gen: new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 0.5, metalness: 0.35 }),        // 发电机涂装
  cabinet: new THREE.MeshStandardMaterial({ color: 0xd9dde0, roughness: 0.6, metalness: 0.1 }),
  trafo: new THREE.MeshStandardMaterial({ color: 0x7f8a6a, roughness: 0.6, metalness: 0.2 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.5, metalness: 0.2 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xb7b4ad, roughness: 0.95 }),
  door: new THREE.MeshStandardMaterial({ color: 0x5b6570, roughness: 0.5, metalness: 0.5 }),
  red: new THREE.MeshStandardMaterial({ color: 0xa02020, roughness: 0.3, emissive: 0xff1a1a, emissiveIntensity: 0 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.6 }),
  brakeDisc: new THREE.MeshStandardMaterial({ color: 0xb8bec4, roughness: 0.25, metalness: 0.95 }),
};

/** 塔筒弯曲着色器：塔顶位移 uTopDisp 沿 uDir，形状 (y/H)² */
function towerMaterial() {
  const m = MAT.paint.clone();
  m.userData.uniforms = { uTopDisp: { value: 0 }, uDir: { value: new THREE.Vector3(1, 0, 0) } };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, m.userData.uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTopDisp; uniform vec3 uDir;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float eta = clamp(position.y / ${T.tower.height.toFixed(2)}, 0.0, 1.0);
        transformed += uDir * uTopDisp * eta * eta;`);
  };
  return m;
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
/** 沿 X 轴的圆柱 */
function cylX(r, len, mat, x0, seg = 32, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, len, seg);
  g.rotateZ(-Math.PI / 2); // +Y → +X
  const m = new THREE.Mesh(g, mat);
  m.position.x = x0 + len / 2;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function label(text, sub, obj, offset = [0, 0, 0]) {
  const div = document.createElement('div');
  div.className = 'part-label';
  div.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
  const l = new CSS2DObject(div);
  l.position.set(...offset);
  l.center.set(0, 1);
  obj.add(l);
  return l;
}

/**
 * 创建整机。
 *  detail: 'full' 主风机（含机舱内部与标注）| 'far' 远处风机（简化）
 */
export function createTurbine({ detail = 'full' } = {}) {
  const full = detail === 'full';
  const root = new THREE.Group();
  root.name = 'turbine';
  const labels = [];
  const addLabel = (...a) => { if (full) labels.push(label(...a)); };

  /* ================= 基础 + 塔筒 ================= */
  const H = T.tower.height;
  const rB = T.tower.baseDiameter / 2, rT = T.tower.topDiameter / 2;
  const found = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.8, 48), MAT.concrete);
  found.position.y = 0.2;
  found.receiveShadow = true; found.castShadow = true;
  root.add(found);

  const prof = [];
  const nH = 48;
  for (let i = 0; i <= nH; i++) {
    const y = (i / nH) * H;
    prof.push(new THREE.Vector2(rB - (rB - rT) * (y / H), y));
  }
  const towerMat = towerMaterial();
  const tower = new THREE.Mesh(new THREE.LatheGeometry(prof, full ? 72 : 32), towerMat);
  tower.castShadow = true; tower.receiveShadow = true;
  root.add(tower);

  if (full) {
    // 塔段法兰接缝（外观为细环线）
    for (const ys of T.tower.sections.slice(1, -1)) {
      const r = rB - (rB - rT) * (ys / H);
      const seam = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, 0.018, 6, 96), MAT.darkSteel);
      seam.rotation.x = Math.PI / 2; seam.position.y = ys;
      root.add(seam);
    }
    // 塔门 + 外部钢梯平台（朝南 +Z）
    const doorG = new THREE.Group();
    const dz = rB - 0.02;
    doorG.add(box(1.0, 2.2, 0.12, MAT.door, 0, 2.3, dz));
    doorG.add(box(1.25, 0.12, 0.2, MAT.darkSteel, 0, 3.45, dz + 0.02));
    // 平台与楼梯
    doorG.add(box(1.8, 0.1, 1.6, MAT.steel, 0, 1.15, dz + 0.8));
    for (let s = 0; s < 5; s++) doorG.add(box(1.0, 0.06, 0.3, MAT.steel, 1.4, 0.95 - s * 0.2, dz + 1.3 + s * 0.28));
    const rail = box(0.05, 1.1, 1.6, MAT.yellow, 0.9, 1.7, dz + 0.8);
    doorG.add(rail);
    root.add(doorG);
    addLabel('塔门 · 平台', '门高 2.2 m（人物 1.75 m 可对比）', doorG, [1.2, 3.6, dz + 0.5]);
    // 塔筒中部航空障碍灯（低光强，常亮红）
    root.userData.midLights = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      const y = 45, r = rB - (rB - rT) * (y / H) + 0.15;
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), MAT.red);
      l.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      root.add(l);
      root.userData.midLights.push(l);
    }
  }
  addLabel('锥形钢塔筒', `高 ${H} m · 底径 6.0 m / 顶径 3.87 m · 壁厚 27→19 mm · 347 t`, root, [rB + 0.5, 30, 0]);

  /* ================= 偏航层 ================= */
  const yaw = new THREE.Group();
  yaw.position.y = H;
  root.add(yaw);

  // 塔顶法兰 + 偏航轴承
  const yawBrg = new THREE.Mesh(new THREE.CylinderGeometry(rT + 0.12, rT + 0.12, 0.35, 64), MAT.darkSteel);
  yawBrg.position.y = -0.1;
  yaw.add(yawBrg);

  /* ---------- 机舱罩：侧面轮廓挤出 + 圆角 ---------- */
  const bev = 0.45;
  const shp = new THREE.Shape();
  const nx0 = -2.35, nx1 = 14.6, ny0 = -0.45, ny1 = 4.65;
  shp.moveTo(nx0, ny0);
  shp.lineTo(nx1 - 1.2, ny0);
  shp.lineTo(nx1, ny0 + 1.0);
  shp.lineTo(nx1, ny1 - 0.4);
  shp.lineTo(nx1 - 0.5, ny1);
  shp.lineTo(nx0 + 1.1, ny1);
  shp.lineTo(nx0, ny1 - 1.0);
  shp.closePath();
  const shellGeo = new THREE.ExtrudeGeometry(shp, {
    depth: 6.0 - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 5, curveSegments: 4,
  });
  shellGeo.translate(0, 0, -(6.0 - 2 * bev) / 2);
  // 底部开孔用于塔筒进入：视觉上不需要，塔筒被罩体遮挡
  const shellMat = MAT.shell.clone();
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.castShadow = true; shell.receiveShadow = true;
  yaw.add(shell);
  const shellEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(shellGeo, 25),
    new THREE.LineBasicMaterial({ color: 0x9fb4c6, transparent: true, opacity: 0.0 })
  );
  yaw.add(shellEdges);

  // 顶部冷却器（散热片）
  const cooler = new THREE.Group();
  cooler.add(box(3.8, 1.2, 4.6, MAT.cabinet, 12.2, ny1 + bev + 0.6, 0));
  for (let k = 0; k < 14; k++) cooler.add(box(0.05, 1.0, 4.4, MAT.darkSteel, 10.45 + k * 0.27, ny1 + bev + 0.62, 0));
  yaw.add(cooler);
  addLabel('顶置冷却器', '发电机/齿轮箱油/变流器散热，约 200 kW 热负荷', cooler, [12.2, ny1 + 1.8, 0]);

  // 测风支架：风杯风速计 + 风向标 + 航空障碍灯
  const mast = new THREE.Group();
  const mx = 13.6, my = ny1 + bev;
  mast.add(box(0.12, 2.6, 0.12, MAT.steel, mx, my + 1.3, 0));
  mast.add(box(0.08, 0.08, 3.0, MAT.steel, mx, my + 2.6, 0));
  mast.add(box(0.08, 0.6, 0.08, MAT.steel, mx, my + 2.9, 1.4));
  mast.add(box(0.08, 0.6, 0.08, MAT.steel, mx, my + 2.9, -1.4));
  // 风杯（三杯）
  const cups = new THREE.Group();
  cups.position.set(mx, my + 3.25, 1.4);
  for (let k = 0; k < 3; k++) {
    const arm = new THREE.Group();
    arm.rotation.y = (k * 2 * Math.PI) / 3;
    arm.add(box(0.28, 0.02, 0.02, MAT.black, 0.14, 0, 0));
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8, 0, Math.PI), MAT.black);
    cup.position.set(0.3, 0, 0); cup.rotation.y = Math.PI / 2;
    arm.add(cup);
    cups.add(arm);
  }
  mast.add(cups);
  // 风向标
  const vane = new THREE.Group();
  vane.position.set(mx, my + 3.25, -1.4);
  vane.add(box(0.7, 0.02, 0.02, MAT.black, 0.2, 0, 0));
  vane.add(box(0.02, 0.22, 0.26, MAT.black, 0.52, 0, 0));
  mast.add(vane);
  // 航空障碍灯（中光强 B 型，红色闪烁 20–60 次/分）
  const obst = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), MAT.red);
  obst.position.set(mx, my + 2.95, 0);
  mast.add(obst);
  yaw.add(mast);
  addLabel('测风系统', '风杯风速计 + 风向标（偏航控制输入）· 航空障碍灯', mast, [mx, my + 3.6, 0]);

  /* ---------- 机舱内部（固定件） ---------- */
  const internals = new THREE.Group();
  internals.visible = full;
  yaw.add(internals);
  if (full) {
    // 前机架（铸造底座）+ 后机架（焊接钢梁）
    const bedF = box(6.2, 1.0, 3.6, MAT.cast, -0.6, 0.35, 0);
    internals.add(bedF);
    internals.add(box(11.4, 0.5, 0.35, MAT.darkSteel, 8.2, 0.55, 2.0));
    internals.add(box(11.4, 0.5, 0.35, MAT.darkSteel, 8.2, 0.55, -2.0));
    for (let k = 0; k < 6; k++) internals.add(box(0.3, 0.3, 4.0, MAT.darkSteel, 3.2 + k * 2.1, 0.55, 0));
    internals.add(box(11.4, 0.06, 4.6, MAT.steel, 8.2, 0.85, 0)); // 格栅地板
    addLabel('铸造前机架 + 焊接后机架', '承载整个传动链并把载荷传给偏航轴承', bedF, [0, -0.6, 2.2]);

    // 偏航驱动：6 台电机 + 减速器，啮合偏航齿圈
    const yawDrives = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      const r = rT + 0.55;
      const dm = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 1.6, 16), MAT.yellow);
      dm.position.set(Math.cos(a) * r, 1.0, Math.sin(a) * r);
      dm.castShadow = true;
      yawDrives.add(dm);
    }
    internals.add(yawDrives);
    addLabel('偏航系统', '6 台偏航电机 · 0.3°/s · 液压偏航刹车', yawDrives, [0, 1.9, -rT - 0.6]);

    // 变流器柜（一排）、主控柜、液压站、变压器
    const conv = new THREE.Group();
    for (let k = 0; k < 3; k++) conv.add(box(0.95, 2.2, 1.2, MAT.cabinet, 9.3 + k * 1.0, 2.0, -1.75));
    internals.add(conv);
    addLabel('全功率/双馈变流器柜', '690 V · 控制发电机转矩 (区域 2 的 k·ω²)', conv, [10.3, 3.3, -1.8]);
    const ctrlCab = box(1.2, 2.0, 0.8, MAT.cabinet, 9.6, 1.9, 1.9);
    internals.add(ctrlCab);
    addLabel('主控柜 (PLC)', '运行 DISCON：转矩 + 变桨 + 偏航 + 安全链', ctrlCab, [9.6, 3.1, 1.9]);
    const trafo = new THREE.Group();
    trafo.add(box(2.0, 2.4, 2.4, MAT.trafo, 13.0, 2.1, 0.2));
    for (let k = 0; k < 8; k++) trafo.add(box(0.06, 1.8, 2.5, MAT.darkSteel, 12.1 + k * 0.26, 2.0, 0.2));
    internals.add(trafo);
    addLabel('升压变压器', '0.69 kV → 33 kV（机舱内布置，减小电缆电流）', trafo, [13.0, 3.5, 0.2]);
    const hyd = box(1.0, 1.0, 0.8, MAT.gear, 3.6, 1.35, -1.9);
    internals.add(hyd);
    addLabel('液压站', '驱动高速轴制动器与偏航刹车', hyd, [3.6, 2.0, -1.9]);
    // 维修吊车轨道
    internals.add(box(11.5, 0.25, 0.25, MAT.yellow, 8.0, ny1 - 0.3, 0));
    internals.add(box(0.8, 0.5, 0.6, MAT.yellow, 6.0, ny1 - 0.65, 0));
  }

  /* ================= 主轴系（上仰 5°） ================= */
  const shaft = new THREE.Group();
  shaft.position.y = T.twr2Shft;
  shaft.rotation.z = -T.shaftTilt * D;
  yaw.add(shaft);

  // 低速轴旋转件、高速轴旋转件
  const lss = new THREE.Group();
  const hss = new THREE.Group();
  const hssY = 0.55;
  hss.position.set(0, hssY, 0);
  shaft.add(lss, hss);

  if (full) {
    // 主轴
    const ms = cylX(0.42, 5.4, MAT.steel, -4.4, 32);
    lss.add(ms);
    // 标记条纹，便于观察转速
    const stripe = box(3.0, 0.05, 0.12, MAT.yellow, -1.5, 0.43, 0);
    lss.add(stripe);
    // 主轴承座
    const mb = new THREE.Group();
    mb.add(cylX(0.95, 0.9, MAT.cast, -3.55, 40));
    mb.add(box(1.0, 1.4, 1.6, MAT.cast, -3.1, -1.1, 0));
    shaft.add(mb);
    addLabel('主轴 + 主轴承', '低速轴 12.1 rpm · 额定转矩 4.18 MN·m', mb, [-3.1, 1.2, 0]);

    // 齿轮箱：一级行星 + 两级平行轴（97:1）
    const gb = new THREE.Group();
    gb.add(cylX(1.45, 1.8, MAT.gear, 1.0, 48));
    gb.add(cylX(1.2, 1.1, MAT.gear, 2.8, 40, 1.05));
    gb.add(box(1.0, 2.6, 2.3, MAT.gear, 4.4, 0.1, 0));
    // 扭力臂
    gb.add(box(0.8, 0.5, 1.0, MAT.cast, 1.9, -0.9, 1.75));
    gb.add(box(0.8, 0.5, 1.0, MAT.cast, 1.9, -0.9, -1.75));
    gb.add(box(0.7, 1.0, 0.7, MAT.darkSteel, 1.9, -1.45, 1.75));
    gb.add(box(0.7, 1.0, 0.7, MAT.darkSteel, 1.9, -1.45, -1.75));
    shaft.add(gb);
    addLabel('三级齿轮箱', '1 级行星 + 2 级平行轴 · 增速比 97:1 · 约 40 t', gb, [2.4, 1.7, 0]);

    // 高速轴：制动盘 + 联轴器 + 发电机
    const disc = cylX(0.48, 0.07, MAT.brakeDisc, 4.95, 40);
    hss.add(disc);
    hss.add(box(0.07, 0.6, 0.1, MAT.yellow, 4.99, 0.45, 0)); // 盘面标记
    const coup = cylX(0.2, 1.3, MAT.steel, 5.05, 20);
    hss.add(coup);
    hss.add(cylX(0.35, 0.12, MAT.darkSteel, 5.05, 24));
    hss.add(cylX(0.35, 0.12, MAT.darkSteel, 6.2, 24));
    hss.add(box(0.12, 0.08, 0.72, MAT.yellow, 6.26, 0, 0)); // 联轴器标记（高速旋转时可见频闪）
    const caliper = box(0.3, 0.35, 0.3, MAT.red, 4.98, hssY + 0.5, 0);
    caliper.material = MAT.yellow;
    shaft.add(caliper);
    addLabel('高速轴制动器', '制动转矩 28.1 kN·m（高速轴）· 急停时与顺桨同时动作', caliper, [4.98, hssY + 0.9, 0]);

    const genG = new THREE.Group();
    const gen = cylX(0.98, 2.9, MAT.gen, 6.4, 48);
    genG.add(gen);
    for (let k = 0; k < 16; k++) {
      const fin = box(2.7, 0.08, 0.05, MAT.gen, 7.85, 0, 0);
      const a = (k / 16) * Math.PI * 2;
      fin.position.y = Math.cos(a) * 1.0; fin.position.z = Math.sin(a) * 1.0;
      fin.rotation.x = a;
      genG.add(fin);
    }
    genG.add(box(3.0, 0.8, 1.8, MAT.darkSteel, 7.85, -1.05, 0));
    genG.position.y = hssY;
    shaft.add(genG);
    addLabel('双馈异步发电机', '额定 1173.7 rpm · 效率 94.4% · 690 V', genG, [7.85, 1.3, 0]);
  }

  /* ================= 叶轮 ================= */
  const rotor = new THREE.Group();
  rotor.position.x = -T.overhang;
  shaft.add(rotor);

  // 轮毂（铸件）
  const hub = new THREE.Group();
  const hubCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 3), MAT.cast);
  hubCore.scale.set(1.0, 1.0, 1.0);
  hub.add(hubCore);
  rotor.add(hub);

  // 导流罩（整流罩）：绕 X 轴的回转体
  const sp = [];
  const spN = 28, xTip = -3.4, xRear = 1.9, rMax = 2.45;
  for (let i = 0; i <= spN; i++) {
    const u = i / spN;
    const x = xTip + u * (xRear - xTip);
    const e = Math.min(1, (x - xTip) / (0.3 - xTip));
    let r = rMax * Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e)));
    if (x > 0.3) r = rMax - 0.25 * ((x - 0.3) / (xRear - 0.3)) ** 2;
    sp.push(new THREE.Vector2(Math.max(r, 0.001), x));
  }
  const spGeo = new THREE.LatheGeometry(sp, 64);
  spGeo.rotateZ(Math.PI / 2); // lathe 轴 Y → −X
  spGeo.scale(1, 1, 1);
  const spMat = MAT.shell.clone();
  const spinner = new THREE.Mesh(spGeo, spMat);
  spinner.castShadow = true;
  rotor.add(spinner);
  addLabel('轮毂 + 导流罩', `轮毂 56.8 t · 导流罩 Ø${(2 * rMax).toFixed(1)} m · 内含 3 套变桨系统`, rotor, [-3.4, 2.5, 0]);

  // 叶片
  const bladeGeo = createBladeGeometry(full ? 90 : 40, full ? 72 : 36);
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Group();
    cone.rotation.set((i * 2 * Math.PI) / 3, 0, T.precone * D);
    rotor.add(cone);
    // 变桨轴承（不随变桨转动的外圈）+ 变桨电机
    if (full) {
      const brg = new THREE.Mesh(new THREE.TorusGeometry(1.82, 0.14, 10, 48), MAT.darkSteel);
      brg.rotation.x = Math.PI / 2; brg.position.y = T.hubRadius;
      cone.add(brg);
      const pm = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.9, 14), MAT.yellow);
      pm.position.set(-0.9, T.hubRadius - 0.6, 1.1);
      cone.add(pm);
      if (i === 0) addLabel('变桨轴承 + 变桨电机', 'Ø3.5 m 四点接触球轴承 · 最大 8°/s', brg, [0, 0, 2.0]);
    }
    const pitch = new THREE.Group();
    cone.add(pitch);
    const mat = createBladeMaterial();
    const blade = new THREE.Mesh(bladeGeo, mat);
    blade.castShadow = true; blade.receiveShadow = true;
    pitch.add(blade);
    if (full) {
      // 叶根螺栓法兰
      const fl = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.12, 48), MAT.darkSteel);
      fl.position.y = T.hubRadius + 0.06;
      pitch.add(fl);
    }
    blades.push({ cone, pitch, blade, mat });
  }
  if (full) {
    const tipAnchor = new THREE.Object3D();
    tipAnchor.position.y = 45;
    blades[0].pitch.add(tipAnchor);
    addLabel('61.5 m 玻璃钢叶片', '17.7 t/片 · DU40→NACA64 翼型 · 扭角 13.3°→0°', tipAnchor, [0, 0, 0]);
  }

  return {
    root, yaw, shaft, rotor, blades, lss, hss, cups, vane, shell, shellEdges, spinner, internals, labels,
    towerMat, obstacle: obst, midLights: root.userData.midLights || [],
  };
}

/** 设置机舱/导流罩剖视（半透明） */
export function setCutaway(t, on) {
  for (const m of [t.shell.material, t.spinner.material]) {
    m.transparent = on;
    m.opacity = on ? 0.12 : 1;
    m.depthWrite = !on;
    m.needsUpdate = true;
  }
  t.shell.castShadow = !on;
  t.shellEdges.material.opacity = on ? 0.55 : 0;
}

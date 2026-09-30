/**
 * flow.js — 风场可视化：气流迹线粒子（含尾流/切变/湍流）+ 垂直风廓线
 * ------------------------------------------------------------------
 * 粒子速度场 u(s, n, z)（s 顺风向，n 横向，z 高度）由三部分叠加：
 *   1) 对数律风切变 U(z)
 *   2) 冻结湍流（Taylor 假设）：位置 s 处的脉动 = 轮毂处 (s/U) 秒之前的脉动
 *   3) 叶轮诱导 + 尾流：致动盘理论 a = ½(1 − √(1−Ct))，
 *      沿轴向亏损 a·(1 + s/√(s²+R²))（上游减速→盘面 a→远场 2a），
 *      尾流半径按质量守恒膨胀，再按 k = 0.4·TI 线性扩张（Niayifar & Porté-Agel 2016），
 *      尾流旋转方向与叶轮相反（角动量守恒）
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NREL5MW } from '../data/nrel5mw.js';
import { shearFactor } from '../sim/atmosphere.js';

const R = NREL5MW.rotorRadius;
const ZH = NREL5MW.hubHeight;

export function createFlow(scene) {
  const N = 1800;
  const S0 = -300, S1 = 900, NW = 95, Z0 = 4, Z1 = 175;
  const P = new Float32Array(N * 3);            // 风向坐标 (s, n, z)
  const V = new Float32Array(N * 3);            // 速度
  const rnd = Math.random;
  const spawn = (i, anywhere) => {
    P[i * 3] = anywhere ? S0 + rnd() * (S1 - S0) : S0 + rnd() * 20;
    P[i * 3 + 1] = (rnd() - 0.5) * 2 * NW;
    P[i * 3 + 2] = Z0 + rnd() * (Z1 - Z0);
  };
  for (let i = 0; i < N; i++) spawn(i, true);

  const lineGeo = new THREE.BufferGeometry();
  const LP = new Float32Array(N * 6), LC = new Float32Array(N * 6);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(LP, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(LC, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false,
  }));
  lines.frustumCulled = false;
  scene.add(lines);

  /* ---------- 风廓线箭头 ---------- */
  const prof = new THREE.Group();
  scene.add(prof);
  const heights = [10, 20, 27, 40, 55, 70, 90, 110, 130, 153, 175, 200];
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.9 });
  const shaftGeo = new THREE.CylinderGeometry(0.35, 0.35, 1, 8); shaftGeo.rotateZ(-Math.PI / 2); shaftGeo.translate(0.5, 0, 0);
  const headGeo = new THREE.ConeGeometry(1.4, 4, 12); headGeo.rotateZ(-Math.PI / 2);
  const arrows = heights.map((h) => {
    const g = new THREE.Group();
    const s = new THREE.Mesh(shaftGeo, arrowMat);
    const hd = new THREE.Mesh(headGeo, arrowMat);
    g.add(s, hd);
    g.position.y = h;
    prof.add(g);
    return { g, s, hd, h };
  });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 205, 6), arrowMat);
  pole.position.y = 102;
  prof.add(pole);
  const curveGeo = new THREE.BufferGeometry();
  const CP = new Float32Array(60 * 3);
  curveGeo.setAttribute('position', new THREE.BufferAttribute(CP, 3));
  const curveLine = new THREE.Line(curveGeo, new THREE.LineBasicMaterial({ color: 0xffe08a }));
  curveLine.frustumCulled = false;
  prof.add(curveLine);
  const tagFor = (h, name) => {
    const d = document.createElement('div');
    d.className = 'profile-tag';
    const o = new CSS2DObject(d);
    o.position.set(0, h, 0);
    o.center.set(0, 0.5);
    prof.add(o);
    return { d, o, h, name };
  };
  const tags = [tagFor(ZH + R, '叶尖上缘'), tagFor(ZH, '轮毂'), tagFor(ZH - R, '叶尖下缘')];
  // 叶轮上下缘参考虚线
  const refMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.5 });
  for (const h of [ZH - R, ZH, ZH + R]) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, h, 0), new THREE.Vector3(200, h, 0)]);
    const l = new THREE.Line(g, refMat); l.computeLineDistances();
    prof.add(l);
  }

  const color = new THREE.Color();
  const api = { lines, prof, visible: true };

  /**
   * 每帧更新
   *  sim: TurbineSim，dt: 仿真时间步（秒），origin: 叶轮中心的地面投影（世界坐标）
   */
  api.update = (sim, dt, origin, showFlow, showProfile, day = 1) => {
    lines.material.opacity = 0.14 + 0.24 * day;
    lines.visible = showFlow;
    prof.visible = showProfile;
    for (const t of tags) t.o.visible = showProfile; // CSS2D 标签不继承父级可见性
    const e = sim.env, o = sim.out;
    const Vm = Math.max(e.Vmean, 0.3);
    // 风的去向（世界坐标）：来向 θ → 去向 (−sinθ, 0, cosθ)，北 = −Z
    const th = (e.dirMean * Math.PI) / 180;
    const dx = -Math.sin(th), dz = Math.cos(th);
    const nx = -dz, nz = dx; // 横向单位向量
    const z0 = sim.z0;

    if (showProfile) {
      prof.position.set(origin.x - dx * 140 - nx * 120, 0, origin.z - dz * 140 - nz * 120);
      prof.rotation.y = Math.atan2(-dz, dx);
      const k = 3.2; // 每 m/s 对应的箭头长度 (m)
      for (const a of arrows) {
        const L = Math.max(0.5, Vm * shearFactor(a.h, ZH, z0) * k);
        a.s.scale.set(L - 3, 1, 1);
        a.hd.position.x = L - 2;
      }
      for (let i = 0; i < 60; i++) {
        const h = 2 + (i / 59) * 200;
        CP[i * 3] = Vm * shearFactor(h, ZH, z0) * k; CP[i * 3 + 1] = h; CP[i * 3 + 2] = 0;
      }
      curveGeo.attributes.position.needsUpdate = true;
      for (const t of tags) {
        const v = Vm * shearFactor(t.h, ZH, z0);
        t.o.position.x = v * k + 3;
        t.d.innerHTML = `${t.name} ${t.h.toFixed(0)} m · <b>${v.toFixed(1)}</b> m/s`;
      }
    }
    if (!showFlow) return;

    // 叶轮状态
    const running = o.rotorRpm > 0.5;
    const ct = Math.min(Math.max(o.Ct || 0, 0), 0.96) * Math.max(0, Math.cos(((o.yawErr || 0) * Math.PI) / 180)) ** 2;
    const a = 0.5 * (1 - Math.sqrt(1 - ct));
    const kW = 0.4 * Math.max(sim.Iref, 0.04) + 0.004;
    const lam = Math.max(o.lambda || 0, 1);
    const swirl0 = running ? 2 * a * (1 - a) / lam : 0;
    const DT = Math.min(dt, 0.25);

    for (let i = 0; i < N; i++) {
      let s = P[i * 3], n = P[i * 3 + 1], z = P[i * 3 + 2];
      const U = Vm * shearFactor(z, ZH, z0) + sim.uAgo((s - S0) / Vm); // 冻结湍流：随平均风向下游平移
      const dn = n, dzr = z - ZH;
      const rho = Math.hypot(dn, dzr);
      const g = 1 + s / Math.hypot(s, R);                      // 0 → 1 → 2
      const Rw0 = R * Math.sqrt((1 - a) / Math.max(1 - a * g, 0.05));
      const Rw = Rw0 + kW * Math.max(0, s);
      const deficit = a * g * (Rw0 / Rw) ** 2;
      const p = Math.max(2, 8 - Math.max(0, s) / 50);
      const shape = Math.exp(-Math.pow(rho / Rw, p));
      let u = U * (1 - deficit * shape);
      // 尾流旋转（仅下游）：从上风向看叶轮顺时针，尾流逆时针
      let vn = 0, vz = 0;
      if (s > 0 && rho > 0.5 && swirl0 > 0) {
        const vt = swirl0 * U * Math.min(1, R / (rho + 8)) * shape * Math.exp(-s / (5 * R)) * Math.min(1, s / 10);
        // 顺风看去 +n 在右、+z 在上，逆时针切向 = (−z, n)/ρ
        vn = (-dzr / rho) * vt;
        vz = (dn / rho) * vt;
      }
      // 上游流管扩张：接近叶轮时径向外流
      if (s > -2 * R && s < 3 * R && rho < 1.5 * R) {
        const out = a * U * 0.25 * (R * R / (s * s + R * R)) * (rho / R) * shape;
        vn += (dn / Math.max(rho, 1)) * out;
        vz += (dzr / Math.max(rho, 1)) * out;
      }
      V[i * 3] = u; V[i * 3 + 1] = vn; V[i * 3 + 2] = vz;
      s += u * DT; n += vn * DT; z += vz * DT;
      if (s > S1 || Math.abs(n) > NW || z < 2 || z > Z1 + 10) { spawn(i, false); s = P[i * 3]; n = P[i * 3 + 1]; z = P[i * 3 + 2]; }
      else { P[i * 3] = s; P[i * 3 + 1] = n; P[i * 3 + 2] = z; }

      // 转世界坐标
      const wx = origin.x + dx * s + nx * n, wz = origin.z + dz * s + nz * n;
      const tail = 1.1;
      LP[i * 6] = wx; LP[i * 6 + 1] = z; LP[i * 6 + 2] = wz;
      LP[i * 6 + 3] = wx - (dx * u + nx * vn) * tail; LP[i * 6 + 4] = z - vz * tail; LP[i * 6 + 5] = wz - (dz * u + nz * vn) * tail;
      // 颜色：相对来流速度（尾流亏损区为蓝）
      const r = THREE.MathUtils.clamp(u / (Vm * shearFactor(z, ZH, z0)), 0.3, 1.1);
      const t = (r - 0.45) / 0.55;
      color.setRGB(0.25 + 0.7 * t, 0.55 + 0.4 * t, 1.0);
      LC[i * 6] = color.r; LC[i * 6 + 1] = color.g; LC[i * 6 + 2] = color.b;
      LC[i * 6 + 3] = color.r * 0.2; LC[i * 6 + 4] = color.g * 0.2; LC[i * 6 + 5] = color.b * 0.3;
    }
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
  };
  return api;
}

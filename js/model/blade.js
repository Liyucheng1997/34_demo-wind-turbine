/**
 * blade.js — 按 NREL 5MW 叶片分布参数“放样”生成 61.5 m 叶片
 * ------------------------------------------------------------------
 * 放样（loft）= 沿展向布置若干翼型截面，再用三角面把相邻截面连接起来。
 * 每个截面由 4 个量决定：弦长 c(r)、扭角 θ(r)、相对厚度 t/c(r)、变桨轴位置。
 * 这些量在 [J09 Table 2-1] 的 17 个站位之间用单调三次插值（PCHIP），
 * 叶根 1.5 m 处为直径 3.542 m 的圆形法兰，11.75 m 起过渡为 DU40 翼型，
 * 15.85 m 为最大弦长 4.652 m（“叶肩”），尖部 44.55 m 以后为 NACA64-618。
 *
 * 叶片局部坐标（与 rotor 组一致）：
 *   +Y 展向（叶根→叶尖），+Z 旋转前进方向（前缘朝向），+X 顺风方向（吸力面朝向）
 */
import * as THREE from 'three';
import { airfoilShape } from '../aero/airfoil.js';
import { NREL5MW } from '../data/nrel5mw.js';

const D = Math.PI / 180;

/** 单调三次 Hermite 插值（Fritsch–Carlson），避免弦长/扭角插值出现过冲 */
function pchip(xs, ys) {
  const n = xs.length;
  const h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

/** 展向分布函数（几何用）。返回 {chord, twist, thick, pa} */
export function bladeDistribution() {
  const T = NREL5MW;
  const tab = T.blade;
  const Rt = T.rotorRadius, Rh = T.hubRadius;
  // 几何上的相对厚度：气动表里 5.6、8.33 m 标为圆柱，实际为圆→翼型的椭圆过渡段
  const geoThick = [1.0, 0.92, 0.70, 0.405, 0.35, 0.35, 0.30, 0.25, 0.25, 0.21, 0.21, 0.18, 0.18, 0.18, 0.18, 0.18, 0.18];
  const rs = [Rh, ...tab.map((b) => b.r), Rt];
  const chord = pchip(rs, [3.542, ...tab.map((b) => b.chord), 0.55]);
  const twist = pchip(rs, [13.308, ...tab.map((b) => b.twist), 0.0]);
  const thick = pchip(rs, [1.0, ...geoThick, 0.18]);
  // 变桨轴位置（距前缘的弦长比例）：圆形叶根 0.5 → 叶肩后 0.375
  const pa = pchip([Rh, 5.6, 11.75, 15.85, Rt], [0.5, 0.48, 0.42, 0.375, 0.375]);
  return { chord, twist, thick, pa, Rh, Rt };
}

/**
 * 生成叶片 BufferGeometry。nSpan 展向截面数，nPts 每个翼型轮廓点数。
 */
export function createBladeGeometry(nSpan = 90, nPts = 72) {
  const dist = bladeDistribution();
  const { Rh, Rt } = dist;
  // 展向站位：叶根与叶尖加密（余弦分布）
  const stations = [];
  for (let i = 0; i < nSpan; i++) {
    const u = i / (nSpan - 1);
    const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
    stations.push(Rh + (0.35 * u + 0.65 * s) * (Rt - Rh));
  }
  // 叶尖圆化：最后 1.2 m 弦长按椭圆收缩
  const ring = airfoilShape(0.2, 0.02, nPts).length;
  const pos = new Float32Array((nSpan * ring + 2) * 3);
  const spanAttr = new Float32Array(nSpan * ring + 2); // 0(根)→1(尖)，供着色器使用
  let p = 0;
  const v = new THREE.Vector3();
  let tipCenter = null, rootCenter = null;
  for (let i = 0; i < nSpan; i++) {
    const r = stations[i];
    let c = dist.chord(r);
    const tipZone = Rt - r;
    if (tipZone < 1.2) c *= Math.sqrt(Math.max(0.04, tipZone / 1.2));
    const tw = dist.twist(r) * D;
    const tk = dist.thick(r);
    const pa = dist.pa(r);
    const camber = tk > 0.5 ? 0 : 0.024;
    const shape = airfoilShape(tk, camber, nPts);
    const cs = Math.cos(-tw), sn = Math.sin(-tw);
    let cx = 0, cz = 0;
    for (const pt of shape) {
      const chordX = (pt.x - pa) * c;      // 沿弦向，正值朝后缘
      const X = pt.y * c;                  // 吸力面朝 +X（顺风）
      const Z = -chordX;                   // 前缘朝 +Z（旋转方向）
      // 扭角：绕 Y 轴旋转 −θ（正扭角使前缘转向上风向）
      v.set(X * cs + Z * sn, r, -X * sn + Z * cs);
      pos[p * 3] = v.x; pos[p * 3 + 1] = v.y; pos[p * 3 + 2] = v.z;
      spanAttr[p] = (r - Rh) / (Rt - Rh);
      cx += v.x; cz += v.z;
      p++;
    }
    if (i === 0) rootCenter = [cx / shape.length, r, cz / shape.length];
    if (i === nSpan - 1) tipCenter = [cx / shape.length, r + 0.05, cz / shape.length];
  }
  const iRoot = p; pos.set(rootCenter, p * 3); spanAttr[p] = 0; p++;
  const iTip = p; pos.set(tipCenter, p * 3); spanAttr[p] = 1; p++;

  const idx = [];
  for (let i = 0; i < nSpan - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j, b = i * ring + ((j + 1) % ring);
      const c2 = (i + 1) * ring + j, d2 = (i + 1) * ring + ((j + 1) % ring);
      idx.push(a, c2, b, b, c2, d2);
    }
  }
  for (let j = 0; j < ring; j++) {
    idx.push(iRoot, j, (j + 1) % ring);
    const base = (nSpan - 1) * ring;
    idx.push(iTip, base + ((j + 1) % ring), base + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('span', new THREE.BufferAttribute(spanAttr, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 叶片材质：白色胶衣 + 着色器内实现“挥舞弯曲”（叶尖在推力下向下风向偏移数米）。
 * 变形形状取均布载荷悬臂梁挠曲线 f(ξ) = (6ξ² − 4ξ³ + ξ⁴)/3，f(1)=1。
 */
export function createBladeMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf3f5f6, roughness: 0.38, metalness: 0.0 });
  mat.userData.uniforms = {
    uTipDefl: { value: 0 },
    uFlapDir: { value: new THREE.Vector3(1, 0, 0) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float span;
        uniform float uTipDefl;
        uniform vec3 uFlapDir;
        varying float vSpan;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float xi = clamp(span, 0.0, 1.0);
        float fdef = (6.0*xi*xi - 4.0*xi*xi*xi + xi*xi*xi*xi) / 3.0;
        transformed += uFlapDir * (uTipDefl * fdef);
        vSpan = span;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vSpan;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // 叶根法兰附近略灰（金属螺栓连接区），前缘保护膜不单独着色
        diffuseColor.rgb *= mix(0.86, 1.0, smoothstep(0.0, 0.012, vSpan));`);
  };
  return mat;
}

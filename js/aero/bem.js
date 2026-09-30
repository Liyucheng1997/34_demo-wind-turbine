/**
 * bem.js — 叶素动量理论（Blade Element Momentum, BEM）求解器
 * ------------------------------------------------------------------
 * 这是风机气动设计的核心：把叶片切成 17 个叶素，每个叶素同时满足
 *   (1) 动量理论：流过环形流管的气流被减速，产生推力与扭矩；
 *   (2) 叶素理论：该截面翼型在当地相对风速/攻角下产生升力与阻力。
 * 两者联立求出诱导因子 a（轴向）与 a'（切向），再积分得到 Cp、Ct。
 *
 * 实现细节（与 OpenFAST/AeroDyn、CCBlade 相同的做法）：
 *   - Ning (2014) 的单变量残差法：以入流角 φ 为未知量，Brent 法求根，保证收敛
 *   - Prandtl 叶尖/轮毂损失修正 F
 *   - Buhl 高诱导修正（a > 0.4 时动量理论失效，用经验公式替代）
 *   - 锥角修正：叶素位置与法向速度按 cos(precone) 投影
 */
import { polar } from './airfoil.js';
import { NREL5MW } from '../data/nrel5mw.js';

const PI = Math.PI;

/** Prandtl 叶尖+轮毂损失 */
function lossF(B, r, R, Rh, sphi) {
  const s = Math.max(Math.abs(sphi), 1e-6);
  const ft = (B / 2) * (R - r) / (r * s);
  const fh = (B / 2) * (r - Rh) / (Rh * s);
  const Ft = (2 / PI) * Math.acos(Math.min(1, Math.exp(-ft)));
  const Fh = (2 / PI) * Math.acos(Math.min(1, Math.exp(-fh)));
  return Math.max(Ft * Fh, 1e-4);
}

/**
 * 给定入流角 φ，计算诱导因子与残差。
 * Vx: 轴向来流（归一化），Vy: 当地切向速度 Ω·r
 */
function induction(phi, el, B, R, Rh, Vx, Vy, theta) {
  const sphi = Math.sin(phi), cphi = Math.cos(phi);
  const alpha = phi - theta;
  const { cl, cd } = polar(el.af, alpha);
  const cn = cl * cphi + cd * sphi;
  const ct = cl * sphi - cd * cphi;
  const F = lossF(B, el.r, R, Rh, sphi);
  const sigma = (B * el.chord) / (2 * PI * el.r);
  const k = (sigma * cn) / (4 * F * sphi * sphi);
  const kp = (sigma * ct) / (4 * F * sphi * cphi);
  let a, ap;
  if (phi > 0) {
    if (k <= 2 / 3) {
      a = k / (1 + k);
    } else {
      // Buhl 经验修正（Glauert 高推力区）
      const g1 = 2 * F * k - (10 / 9 - F);
      const g2 = Math.max(2 * F * k - F * (4 / 3 - F), 0);
      const g3 = 2 * F * k - (25 / 9 - 2 * F);
      a = Math.abs(g3) < 1e-6 ? 1 - 1 / (2 * Math.sqrt(g2)) : (g1 - Math.sqrt(g2)) / g3;
    }
  } else {
    // 螺旋桨制动区（φ<0）
    a = k > 1 ? k / (k - 1) : 0;
  }
  ap = kp / (1 - kp);
  if (!isFinite(ap)) ap = 0;
  const res = phi > 0
    ? sphi / (1 - a) - (Vx / Vy) * cphi / (1 + ap)
    : sphi * (1 - k) - (Vx / Vy) * cphi * (1 - kp);
  return { res, a, ap, alpha, cl, cd, cn, ct, F };
}

/** Brent 求根 */
function brent(f, a, b, fa, fb, tol = 1e-7, maxIt = 60) {
  let c = a, fc = fa, d = b - a, e = d;
  for (let it = 0; it < maxIt; it++) {
    if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
    const tol1 = 2e-12 * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      let p, q, r;
      const s = fb / fa;
      if (a === c) { p = 2 * xm * s; q = 1 - s; }
      else { q = fa / fc; r = fb / fc; p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1); }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; }
      else { d = xm; e = d; }
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(b);
  }
  return b;
}

/**
 * 求解单个叶素。返回该叶素的入流角、攻角、诱导因子及单位长度载荷系数。
 */
function solveElement(el, B, R, Rh, Vx, Vy, theta) {
  const f = (phi) => induction(phi, el, B, R, Rh, Vx, Vy, theta).res;
  const eps = 1e-6;
  let phi;
  // 1) 常规风车状态 φ∈(0, π/2]
  let fa = f(eps), fb = f(PI / 2);
  if (fa * fb < 0) phi = brent(f, eps, PI / 2, fa, fb);
  else {
    // 2) 螺旋桨制动 φ∈[-π/4, 0)
    fa = f(-PI / 4); fb = f(-eps);
    if (fa * fb < 0) phi = brent(f, -PI / 4, -eps, fa, fb);
    else {
      // 3) φ∈(π/2, π)
      fa = f(PI / 2); fb = f(PI - eps);
      phi = fa * fb < 0 ? brent(f, PI / 2, PI - eps, fa, fb) : Math.atan2(Vx, Vy);
    }
  }
  return { phi, ...induction(phi, el, B, R, Rh, Vx, Vy, theta) };
}

/**
 * 在给定叶尖速比 λ、桨距角 β（弧度）下求整个叶轮的 Cp、Ct、Cq 以及展向分布。
 *  V 取 1（无量纲），Ω = λ/R。
 */
export function solveRotor(lambda, pitch, turbine = NREL5MW, wantDist = false) {
  const B = turbine.numBlades, R = turbine.rotorRadius, Rh = turbine.hubRadius;
  const cone = (turbine.precone * PI) / 180;
  const cc = Math.cos(cone);
  const lam = Math.max(lambda, 1e-3);
  const Omega = lam / R; // V = 1
  let T = 0, Q = 0;
  const dist = wantDist ? [] : null;
  for (const el of turbine.blade) {
    const theta = (el.twist * PI) / 180 + pitch;
    const rr = el.r * cc; // 锥角使叶素到转轴的垂直距离缩短
    const Vx = cc;        // 法向来流分量
    const Vy = Omega * rr;
    const s = solveElement({ ...el, r: el.r }, B, R, Rh, Vx, Vy, theta);
    const W2 = (Vx * (1 - s.a)) ** 2 + (Vy * (1 + s.ap)) ** 2;
    // 单位长度推力/扭矩（ρ=1, V=1 归一化后的 ½ρW²c·Cn）
    const fN = 0.5 * W2 * el.chord * s.cn;
    const fT = 0.5 * W2 * el.chord * s.ct;
    T += B * fN * el.dr * cc;
    Q += B * fT * rr * el.dr;
    if (wantDist) {
      dist.push({
        r: el.r, chord: el.chord, twist: el.twist, af: el.af,
        phi: (s.phi * 180) / PI, alpha: (s.alpha * 180) / PI,
        a: s.a, ap: s.ap, cl: s.cl, cd: s.cd, F: s.F,
        W: Math.sqrt(W2),               // 相对风速 / V∞
        fN, fT,                         // 单位长度法向/切向力 / (ρV²)
      });
    }
  }
  const A = PI * R * R;
  const Ct = T / (0.5 * A);
  const Cq = Q / (0.5 * A * R);
  const Cp = Cq * lam;
  return { Cp, Ct, Cq, dist };
}

/**
 * 预计算 Cp/Ct/Cq 查找表：λ∈[0,18]、β∈[-4°,90°]。
 * 仿真每步只做双线性插值，这是实时仿真的常规做法（FAST 的线性化模型也基于此）。
 */
export function buildTables(turbine = NREL5MW) {
  const lam = [], pit = [];
  for (let l = 0; l <= 18.0001; l += 0.25) lam.push(l);
  for (let p = -4; p <= 30; p += 0.5) pit.push(p);
  for (let p = 31; p <= 90; p += 1) pit.push(p);
  const nL = lam.length, nP = pit.length;
  const Cp = new Float32Array(nL * nP), Ct = new Float32Array(nL * nP), Cq = new Float32Array(nL * nP);
  for (let j = 0; j < nP; j++) {
    for (let i = 0; i < nL; i++) {
      const s = solveRotor(Math.max(lam[i], 0.05), (pit[j] * PI) / 180, turbine);
      const k = j * nL + i;
      Cp[k] = lam[i] < 0.05 ? 0 : s.Cp;
      Ct[k] = s.Ct;
      Cq[k] = s.Cq;
    }
  }
  return { lam, pit, Cp, Ct, Cq, nL, nP };
}

function locate(arr, x) {
  if (x <= arr[0]) return [0, 0];
  const n = arr.length;
  if (x >= arr[n - 1]) return [n - 2, 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] > x) hi = m; else lo = m; }
  return [lo, (x - arr[lo]) / (arr[lo + 1] - arr[lo])];
}

/** 双线性插值查表。lambda 无量纲，pitchDeg 为角度 */
export function lookup(tables, key, lambda, pitchDeg) {
  const { lam, pit, nL } = tables;
  const tab = tables[key];
  const [i, fx] = locate(lam, lambda);
  const [j, fy] = locate(pit, pitchDeg);
  const v00 = tab[j * nL + i], v10 = tab[j * nL + i + 1];
  const v01 = tab[(j + 1) * nL + i], v11 = tab[(j + 1) * nL + i + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

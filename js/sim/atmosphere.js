/**
 * atmosphere.js — 大气与风况模型
 * ------------------------------------------------------------------
 *  1) 空气密度：国际标准大气（ISA）气压随海拔变化 + 理想气体定律
 *  2) 风切变：对数律 v(z) = v_hub · ln(z/z0) / ln(z_hub/z0)，z0 为地表粗糙度
 *  3) 湍流：IEC 61400-1 正常湍流模型（NTM）σ1 = Iref(0.75·V + 5.6)，
 *           纵向/横向 Kaimal 谱（积分尺度 L1 = 340.2 m、L2 = 113.4 m），
 *           用“谐波叠加法”合成时间序列（与 TurbSim 的思路相同，这里只取单点）
 *  4) 极端运行阵风 EOG：IEC 61400-1 式 (19)，“墨西哥帽”形状，持续 10.5 s
 *  5) Weibull/Rayleigh 风速分布 → 年发电量 AEP、容量系数
 */

export const TERRAINS = {
  sea: { label: '海面（海上风电场）', z0: 0.0002 },
  grass: { label: '开阔草原', z0: 0.03 },
  farm: { label: '农田 / 零星建筑', z0: 0.10 },
  shrub: { label: '灌木林 / 村庄', z0: 0.40 },
  forest: { label: '森林 / 城郊', z0: 1.00 },
};

export const TURB_CLASSES = {
  A: { label: 'A 类（高湍流 Iref=0.16）', Iref: 0.16 },
  B: { label: 'B 类（中湍流 Iref=0.14）', Iref: 0.14 },
  C: { label: 'C 类（低湍流 Iref=0.12）', Iref: 0.12 },
  L: { label: '层流（无湍流，理想）', Iref: 0 },
};

/** 空气密度 ρ (kg/m³)。altitude 海拔 m，tempC 气温 ℃，rh 相对湿度 0-1 */
export function airDensity(altitude, tempC, rh = 0.6) {
  const T = tempC + 273.15;
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588); // Pa
  // 水汽分压（Tetens 公式），湿空气比干空气轻
  const pv = rh * 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const pd = p - pv;
  return { rho: pd / (287.058 * T) + pv / (461.495 * T), p };
}

/** 对数律风廓线：高度 z 处风速与轮毂高度风速之比 */
export function shearFactor(z, zHub, z0) {
  const zz = Math.max(z, z0 * 1.5);
  return Math.log(zz / z0) / Math.log(zHub / z0);
}

/** 等效幂律指数 α（便于与 IEC 默认 0.2 对比），取叶轮上下缘拟合 */
export function equivalentAlpha(zHub, R, z0) {
  const z1 = zHub - R, z2 = zHub + R;
  return Math.log(shearFactor(z2, zHub, z0) / shearFactor(z1, zHub, z0)) / Math.log(z2 / z1);
}

/**
 * 叶轮等效风速 REWS 与轮毂风速之比：按 v³ 在扫掠面积上加权（IEC 61400-12-1 Ed.2）
 * 风切变越大，叶轮上半圈比下半圈风大越多
 */
export function rewsFactor(zHub, R, z0) {
  let s = 0, w = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    const y = -R + ((i + 0.5) / n) * 2 * R;          // 相对轮毂高度
    const chord = 2 * Math.sqrt(R * R - y * y);      // 该高度的圆盘弦长（面积权重）
    const f = shearFactor(zHub + y, zHub, z0);
    s += chord * f ** 3;
    w += chord;
  }
  return Math.cbrt(s / w);
}

/** 单片叶片（方位角 psi，0=竖直向上）按展向 v² 加权的有效风速比，用于挥舞载荷的 1P 波动 */
export function bladeShearFactor(psi, zHub, R, Rh, z0) {
  let s = 0, w = 0;
  for (let i = 0; i < 12; i++) {
    const r = Rh + ((i + 0.5) / 12) * (R - Rh);
    const f = shearFactor(zHub + r * Math.cos(psi), zHub, z0);
    const wt = r * r; // 载荷对根部弯矩的贡献 ∝ r（力臂）· r（线速度²近似）
    s += wt * f * f;
    w += wt;
  }
  return Math.sqrt(s / w);
}

/** 简单可复现随机数 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Kaimal 谱湍流合成器（单点、纵向 u + 横向 v）
 *  S(f) = σ² · 4L/V / (1 + 6 f L / V)^(5/3)
 * 谐波叠加：u(t) = Σ sqrt(2 S(f_k) Δf) cos(2π f_k t + φ_k)
 * 同时乘以“叶轮平均”传递函数，模拟 126 m 叶轮对小尺度涡的空间平滑。
 */
export class Turbulence {
  constructor(seed = 7) {
    const rnd = mulberry32(seed);
    this.N = 160;
    this.f = new Float32Array(this.N);
    this.df = new Float32Array(this.N);
    this.phU = new Float32Array(this.N);
    this.phV = new Float32Array(this.N);
    this.ampU = new Float32Array(this.N);
    this.ampV = new Float32Array(this.N);
    this.ampUpt = new Float32Array(this.N); // 单点（未平均）幅值，用于流场粒子
    // 对数分布频率 0.0015–1.5 Hz
    const f0 = 0.0015, f1 = 1.5;
    for (let k = 0; k < this.N; k++) {
      const a = Math.log(f0) + ((k + rnd()) / this.N) * Math.log(f1 / f0);
      this.f[k] = Math.exp(a);
      this.phU[k] = rnd() * Math.PI * 2;
      this.phV[k] = rnd() * Math.PI * 2;
    }
    for (let k = 0; k < this.N; k++) {
      const lo = k === 0 ? f0 : Math.sqrt(this.f[k - 1] * this.f[k]);
      const hi = k === this.N - 1 ? f1 : Math.sqrt(this.f[k] * this.f[k + 1]);
      this.df[k] = hi - lo;
    }
    this.sigmaU = 0;
  }

  /** 按平均风速与湍流等级更新谱幅值（相位不变 → 滑块拖动时时间序列连续） */
  configure(Vhub, Iref, R) {
    const V = Math.max(Vhub, 0.5);
    const sigma1 = Iref * (0.75 * V + 5.6);     // IEC NTM
    const sigma2 = 0.8 * sigma1;
    const L1 = 8.1 * 42, L2 = 2.7 * 42;         // IEC Kaimal 积分尺度 (Λ1 = 42 m @ hub>60 m)
    let varU = 0, varV = 0;
    for (let k = 0; k < this.N; k++) {
      const f = this.f[k];
      const Su = (sigma1 ** 2 * (4 * L1 / V)) / Math.pow(1 + (6 * f * L1) / V, 5 / 3);
      const Sv = (sigma2 ** 2 * (4 * L2 / V)) / Math.pow(1 + (6 * f * L2) / V, 5 / 3);
      // 叶轮平均：波长小于叶轮直径的阵风被“抹平”
      const Hr = 1 / (1 + ((2 * Math.PI * f * R) / (1.3 * V)) ** 2);
      this.ampUpt[k] = Math.sqrt(2 * Su * this.df[k]);
      this.ampU[k] = this.ampUpt[k] * Math.sqrt(Hr);
      this.ampV[k] = Math.sqrt(2 * Sv * this.df[k] * Hr);
      varU += Su * this.df[k];
      varV += Sv * this.df[k];
    }
    // 谱截断后按目标方差归一化
    const cu = varU > 0 ? sigma1 / Math.sqrt(varU) : 0;
    const cv = varV > 0 ? sigma2 / Math.sqrt(varV) : 0;
    for (let k = 0; k < this.N; k++) { this.ampU[k] *= cu; this.ampUpt[k] *= cu; this.ampV[k] *= cv; }
    this.sigmaU = sigma1;
    this.sigmaV = sigma2;
  }

  /** 返回 t 时刻叶轮等效纵向脉动 u'、横向脉动 v'（m/s）、以及单点 u' */
  sample(t) {
    let u = 0, v = 0, up = 0;
    const TWO_PI = Math.PI * 2;
    for (let k = 0; k < this.N; k++) {
      const w = TWO_PI * this.f[k] * t;
      const cu = Math.cos(w + this.phU[k]);
      u += this.ampU[k] * cu;
      up += this.ampUpt[k] * cu;
      v += this.ampV[k] * Math.cos(w + this.phV[k]);
    }
    return { u, v, up };
  }
}

/**
 * IEC 61400-1 极端运行阵风（EOG）
 *   Vgust = min{1.35(Ve1 − Vhub), 3.3·σ1 / (1 + 0.1·D/Λ1)}
 *   V(t) = V − 0.37·Vgust·sin(3πt/T)·(1 − cos(2πt/T)),  0 ≤ t ≤ T = 10.5 s
 */
export function eogAmplitude(Vhub, sigma1, D = 126, Vref = 50) {
  const Ve1 = 0.8 * 1.4 * Vref;
  return Math.min(1.35 * (Ve1 - Vhub), (3.3 * sigma1) / (1 + (0.1 * D) / 42));
}
export function eogShape(t, Vgust, T = 10.5) {
  if (t < 0 || t > T) return 0;
  return -0.37 * Vgust * Math.sin((3 * Math.PI * t) / T) * (1 - Math.cos((2 * Math.PI * t) / T));
}

/** Rayleigh（Weibull k=2）概率密度，Vavg 年平均风速 */
export function weibullPdf(v, Vavg, k = 2) {
  // 尺度参数 c = Vavg / Γ(1+1/k)；k=2 时 Γ(1.5)=√π/2
  const g = k === 2 ? Math.sqrt(Math.PI) / 2 : gamma(1 + 1 / k);
  const c = Vavg / g;
  return (k / c) * Math.pow(v / c, k - 1) * Math.exp(-Math.pow(v / c, k));
}
function gamma(z) {
  // Lanczos 近似
  const g = 7, p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

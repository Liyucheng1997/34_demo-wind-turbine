/**
 * airfoil.js — 翼型：气动极曲线 + 几何外形
 * ------------------------------------------------------------------
 * NREL 5MW 叶片从根到尖依次使用：圆柱 → DU40 → DU35 → DU30 → DU25 → DU21 → NACA64-618。
 * 原始极曲线是风洞数据表（含 3D 旋转修正），这里用“参数化极曲线”复现其关键特征：
 *   - 零升攻角 α0、升力线斜率、最大升力系数 Clmax 与失速攻角
 *   - 最小阻力系数 Cd0（厚翼型阻力大——这正是根部必须厚、尖部必须薄的矛盾）
 *   - 失速后按 Viterna–Corrigan 公式外推到 ±90°（大桨距/顺桨/启动工况需要这些数据）
 * 参数取自 DU/NACA 翼型公开数据的典型值，BEM 结果在 tests/validate.mjs 中与文献对比。
 */

const D = Math.PI / 180;

/** 各翼型参数：a0 升力线斜率(1/rad)、alpha0 零升攻角、clMax/clMin、stall 失速攻角、cd0 最小阻力 */
export const AIRFOILS = {
  Cylinder1: { cyl: true, cd: 0.50 },
  Cylinder2: { cyl: true, cd: 0.35 },
  DU40_A17: { a0: 5.8, alpha0: -3.2, clMax: 1.60, clMin: -0.80, stall: 14.0, cd0: 0.0130, camber: 0.020 },
  DU35_A17: { a0: 6.0, alpha0: -3.2, clMax: 1.65, clMin: -0.85, stall: 13.5, cd0: 0.0110, camber: 0.022 },
  DU30_A17: { a0: 6.4, alpha0: -3.0, clMax: 1.60, clMin: -0.90, stall: 12.0, cd0: 0.0090, camber: 0.024 },
  DU25_A17: { a0: 6.5, alpha0: -3.2, clMax: 1.45, clMin: -0.95, stall: 10.0, cd0: 0.0068, camber: 0.024 },
  DU21_A17: { a0: 6.55, alpha0: -3.4, clMax: 1.40, clMin: -1.00, stall: 9.5, cd0: 0.0062, camber: 0.024 },
  NACA64_A17: { a0: 6.6, alpha0: -4.4, clMax: 1.40, clMin: -1.00, stall: 9.5, cd0: 0.0058, camber: 0.028 },
};

const CD_MAX = 1.35; // Viterna：展弦比约 17 的叶片 Cd_max ≈ 1.11 + 0.018·AR

const sig = (x) => 1 / (1 + Math.exp(-x));

/** 附着流段：线性升力 + 接近 Clmax 时圆滑饱和；抛物线阻力极曲线 */
function attached(p, a) {
  const x = p.a0 * (a - p.alpha0 * D);
  const m = x >= 0 ? p.clMax : -p.clMin;
  const cl = x / Math.pow(1 + Math.pow(Math.abs(x) / m, 6), 1 / 6);
  const cd = p.cd0 + 0.006 * (cl - 0.4) ** 2;
  return { cl, cd };
}

/**
 * Viterna–Corrigan 失速后外推（AeroDyn 预处理 AirfoilPrep 同款公式）
 *   Cl = A1·sin2α + A2·cos²α / sinα
 *   Cd = B1·sin²α + B2·cosα
 * 系数由失速点 (αs, Cls, Cds) 连续性确定，保证 α=αs 处与附着段衔接。
 */
function viternaCoef(as, cls, cds) {
  const s = Math.sin(as), c = Math.cos(as);
  return {
    A1: CD_MAX / 2,
    A2: (cls - CD_MAX * s * c) * s / (c * c),
    B2: (cds - CD_MAX * s * s) / c,
  };
}
function viterna(k, a) {
  const s = Math.sin(a), c = Math.cos(a);
  return { cl: k.A1 * Math.sin(2 * a) + k.A2 * c * c / s, cd: CD_MAX * s * s + k.B2 * c };
}

// 预计算各翼型的正/负失速外推系数
for (const p of Object.values(AIRFOILS)) {
  if (p.cyl) continue;
  const asP = p.stall * D;
  const sp = attached(p, asP);
  p._vp = viternaCoef(asP, sp.cl, sp.cd);
  const asN = -(p.stall + 1) * D;
  const sn = attached(p, asN);
  p._vn = viternaCoef(-asN, -sn.cl, sn.cd); // 负攻角按镜像处理
}

/**
 * 查询升阻力系数。alpha 为弧度，范围任意（自动折算到 [-π, π]）。
 * 返回 {cl, cd}
 */
export function polar(name, alpha) {
  const p = AIRFOILS[name];
  const a = ((alpha + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (p.cyl) return { cl: 0, cd: p.cd };
  const HALF = Math.PI / 2;
  const asP = p.stall * D, asN = -(p.stall + 1) * D;

  // |α| > 90°：平板绕流（叶片被反吹，仅在极端工况出现）
  if (a > HALF || a < -HALF) {
    const aa = a > 0 ? Math.PI - a : -Math.PI - a; // 折回 ±90° 内
    return { cl: -0.7 * CD_MAX * Math.sin(aa) * Math.cos(aa), cd: CD_MAX * Math.sin(a) ** 2 + 0.02 };
  }
  const att = attached(p, a);
  if (a > asP - 2 * D) {
    const post = viterna(p._vp, Math.max(a, asP));
    const w = sig((a - asP) / (0.6 * D));
    return { cl: (1 - w) * att.cl + w * post.cl, cd: (1 - w) * att.cd + w * post.cd };
  }
  if (a < asN + 2 * D) {
    const pv = viterna(p._vn, Math.max(-a, -asN));
    const w = sig((asN - a) / (0.6 * D));
    return { cl: (1 - w) * att.cl - w * pv.cl, cd: (1 - w) * att.cd + w * pv.cd };
  }
  return att;
}

/**
 * 生成单位弦长翼型外形坐标（LE=0，TE=1），用于 3D 放样。
 *  thick: 相对厚度；圆柱（thick≥0.99）时正好退化为直径=弦长的圆。
 *  余弦分布 x = (1-cosθ)/2 时，圆的半厚度 sqrt(x(1-x)) = 0.5·sinθ，因此
 *  圆柱与翼型可按同一参数化线性混合，实现叶根“圆→翼型”的平滑过渡段。
 *  返回 n 个点的闭合轮廓数组 [{x, y}]，从 TE 沿上表面到 LE 再沿下表面回到 TE。
 */
export function airfoilShape(thick, camber = 0.024, n = 64) {
  const half = n / 2;
  const up = [], lo = [];
  const cylW = Math.min(1, Math.max(0, (thick - 0.40) / 0.60)); // 0 = 纯翼型，1 = 纯圆
  // 钝尾缘厚度：厚翼型/过渡段为结构需要使用“flatback”
  const teThick = 0.004 + 0.05 * Math.max(0, Math.min(1, (thick - 0.25) / 0.25)) * (1 - cylW);
  const tAf = Math.min(thick, 0.42);
  const m = camber * (1 - cylW), pc = 0.42;
  for (let i = 0; i <= half; i++) {
    const th = (i / half) * Math.PI;
    const x = (1 - Math.cos(th)) / 2;
    // NACA 四位数厚度分布（闭口尾缘系数）
    const ytAf =
      5 * tAf * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4) +
      (teThick / 2) * x;
    const ytCyl = 0.5 * Math.sin(th);
    const yt = (1 - cylW) * ytAf + cylW * ytCyl;
    // 中弧线（DU 翼型为后加载型，这里用最大弯度位于 42% 弦长近似）
    const yc = x < pc ? (m / (pc * pc)) * (2 * pc * x - x * x) : (m / ((1 - pc) ** 2)) * (1 - 2 * pc + 2 * pc * x - x * x);
    up.push({ x, y: yc + yt });
    lo.push({ x, y: yc - yt });
  }
  // 从 TE 上表面 → LE → 下表面 → TE
  const pts = [];
  for (let i = half; i >= 0; i--) pts.push(up[i]);
  for (let i = 1; i < half; i++) pts.push(lo[i]);
  // 下表面的尾缘点
  pts.push(lo[half]);
  return pts;
}

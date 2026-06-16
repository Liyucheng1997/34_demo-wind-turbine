/**
 * physics.js — 风力发电机物理模型
 * ------------------------------------------------------------
 * 这个文件不依赖 Three.js，可以单独阅读/测试，专注讲清楚
 * “风 → 机械能 → 电能” 的换算关系。
 */

/** 风机参数（一台典型陆上 3 MW 机组的近似值） */
export const TURBINE = {
  rotorRadius: 45,      // 叶轮半径 r (m)，直径约 90 m
  ratedPower: 3000,     // 额定电功率 (kW) = 3 MW
  cutIn: 3,             // 切入风速 (m/s)：低于此风速不发电
  rated: 12,            // 额定风速 (m/s)：达到额定功率
  cutOut: 25,           // 切出风速 (m/s)：超过此风速保护停机
  maxCp: 0.45,          // 实际最大功率系数（Betz 极限 0.593，工程上约 0.4~0.5）
  airDensity: 1.225,    // 空气密度 ρ (kg/m³，海平面 15℃)
  generatorEff: 0.95,   // 发电机+变流器效率
  tipSpeedRatio: 7,     // 最佳叶尖速比 λ = 叶尖线速度 / 风速
};

/** 每户家庭年用电量（kWh）。中国城镇家庭约 2000~4000，这里取 3000。 */
export const HOUSEHOLD_KWH_PER_YEAR = 3000;

/** 扫风面积 A = π r² (m²) */
export function sweptArea(r = TURBINE.rotorRadius) {
  return Math.PI * r * r;
}

/**
 * 气流中蕴含的理论风功率（瓦特）
 *   P_wind = ½ · ρ · A · v³
 * 注意：功率与风速的 **三次方** 成正比——风速翻倍，能量是 8 倍！
 */
export function windPowerW(v, t = TURBINE) {
  return 0.5 * t.airDensity * sweptArea(t.rotorRadius) * v ** 3;
}

/**
 * 功率系数 Cp(v)：实际能从风里取走多少比例的能量。
 * 这里用一个分段近似来体现真实机组的控制策略：
 *  - 风速 < 切入：Cp = 0（不发电）
 *  - 切入~额定：运行在最佳 Cp 附近（最大化取能）
 *  - 额定~切出：通过桨距控制“弃风”，Cp 下降以维持恒定额定功率
 *  - > 切出：停机，Cp = 0
 */
export function powerCoefficient(v, t = TURBINE) {
  if (v < t.cutIn || v >= t.cutOut) return 0;
  if (v <= t.rated) {
    // 切入附近平滑爬升到 maxCp
    const ramp = Math.min(1, (v - t.cutIn) / (t.rated - t.cutIn) + 0.25);
    return t.maxCp * ramp;
  }
  // 额定以上：为维持额定功率而主动降低 Cp（弃风）
  const ratedWind = windPowerW(t.rated, t) / 1000; // kW
  const curWind = windPowerW(v, t) / 1000;
  const ratedElec = ratedWind * t.maxCp;            // 额定区取到的功率
  return Math.max(0, (ratedElec / curWind));
}

/**
 * 实际并网电功率（kW）。
 *   P_elec = P_wind · Cp · η_generator，且不超过额定功率。
 */
export function electricalPowerKW(v, t = TURBINE) {
  if (v < t.cutIn || v >= t.cutOut) return 0;
  const pw = windPowerW(v, t) / 1000;          // 风功率 kW
  const cp = powerCoefficient(v, t);
  const p = pw * cp * t.generatorEff;
  return Math.min(p, t.ratedPower);
}

/**
 * 叶轮转速 (rpm)。
 *   叶尖线速度 = λ · v  →  角速度 ω = (λ·v)/r  →  rpm = ω·60/(2π)
 * 额定以上转速被限制在最大值附近（顺桨/变桨控制）。
 */
export function rotorRPM(v, t = TURBINE) {
  if (v < t.cutIn || v >= t.cutOut) return 0;
  const vEff = Math.min(v, t.rated);                 // 额定以上限速
  const tipSpeed = t.tipSpeedRatio * vEff;           // m/s
  const omega = tipSpeed / t.rotorRadius;            // rad/s
  return (omega * 60) / (2 * Math.PI);
}

/** 运行阶段（用于 UI 文案与颜色） */
export function operatingStage(v, t = TURBINE) {
  if (v < t.cutIn) return { key: 'idle', label: '风速过低 · 待机', tone: 'muted' };
  if (v < t.rated) return { key: 'run', label: '正常发电区', tone: 'ok' };
  if (v < t.cutOut) return { key: 'rated', label: '额定满发 · 弃风', tone: 'warn' };
  return { key: 'cutout', label: '风速过大 · 保护停机', tone: 'danger' };
}

/**
 * 由瞬时功率估算等效家庭户数。
 *   年发电量 (kWh) = 功率(kW) × 8760h × 利用率
 * 这里直接用瞬时功率乘以全年小时数（假设全年维持该功率）做教学近似，
 * 再除以每户年用电量。
 */
export function householdsServed(powerKW, hhKwh = HOUSEHOLD_KWH_PER_YEAR) {
  const annualKWh = powerKW * 8760;            // 全年发电量
  return {
    annualKWh,
    annualMWh: annualKWh / 1000,
    houses: Math.floor(annualKWh / hhKwh),
  };
}

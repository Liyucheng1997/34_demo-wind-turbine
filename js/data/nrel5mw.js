/**
 * nrel5mw.js — NREL 5 MW 参考风机（陆上版）完整设计参数
 * ------------------------------------------------------------------
 * 数据来源（全部为公开文献，可逐项核对）：
 *   [J09] J. Jonkman, S. Butterfield, W. Musial, G. Scott,
 *         "Definition of a 5-MW Reference Wind Turbine for Offshore System
 *          Development", NREL/TP-500-38060, 2009.
 *         - Table 1-1  总体参数
 *         - Table 2-1  叶片分布式气动参数（展向站位/扭角/弦长/翼型）
 *         - Table 2-2  叶片结构特性（质量、截面）
 *         - Ch.5       传动链（齿轮比 97:1、发电机效率 94.4%、惯量）
 *         - Ch.6       塔筒（底径 6 m、顶径 3.87 m、壁厚 27→19 mm）
 *         - Ch.7       基准控制器 DISCON（变速转矩 + 增益调度 PI 变桨）
 *   [IEC] IEC 61400-1 Ed.3 风机设计要求（湍流、风切变、极端阵风）
 *
 * 该机型以 REpower 5M 为原型，是全球风电学术界使用最广的“标准风机”，
 * OpenFAST、HAWC2、Bladed 等工具都用它做基准算例。
 * 本项目所有 3D 尺寸均为 1:1 米制，1 个场景单位 = 1 m。
 */

export const NREL5MW = {
  name: 'NREL 5 MW Reference Turbine (Onshore)',
  class: 'IEC IB',                 // 风区等级 I（Vref=50 m/s），湍流等级 B
  ratedPowerElec: 5.0e6,           // 额定电功率 W
  ratedPowerMech: 5.29661e6,       // 额定机械功率 W（= 5 MW / 0.944）
  rotorOrientation: '上风向，3 叶片，顺时针（从上风向看）',

  /* ---------------- 叶轮几何 [J09 Table 1-1] ---------------- */
  numBlades: 3,
  rotorRadius: 63.0,               // m，叶轮直径 126 m
  hubRadius: 1.5,                  // m，轮毂直径 3 m
  bladeLength: 61.5,               // m
  hubHeight: 90.0,                 // m
  precone: 2.5,                    // deg，叶片锥角（向上风向）
  shaftTilt: 5.0,                  // deg，主轴仰角
  overhang: 5.0191,                // m，叶轮中心到偏航轴线距离（沿主轴）
  twr2Shft: 1.96256,               // m，塔顶到主轴的竖直距离

  /* ---------------- 运行参数 [J09 Table 1-1] ---------------- */
  cutIn: 3.0,                      // m/s
  ratedWind: 11.4,                 // m/s
  cutOut: 25.0,                    // m/s
  minRotorRpm: 6.9,                // rpm
  ratedRotorRpm: 12.1,             // rpm
  ratedTipSpeed: 80.0,             // m/s
  optimalTSR: 7.55,                // 最佳叶尖速比 [J09 Ch.7]
  peakCp: 0.482,                   // 文献最大功率系数（用于校核我们的 BEM）

  /* ---------------- 质量 [J09 Table 1-1] ---------------- */
  mass: {
    blade: 17740,                  // kg / 片
    bladeCgFromRoot: 20.475,       // m，叶片重心距叶根
    hub: 56780,                    // kg
    rotor: 110000,                 // kg（3 叶片 + 轮毂）
    nacelle: 240000,               // kg
    tower: 347460,                 // kg
  },

  /* ---------------- 传动链 [J09 Ch.5] ---------------- */
  drivetrain: {
    gearRatio: 97,                 // 三级齿轮箱（1 级行星 + 2 级平行轴）
    genEfficiency: 0.944,          // 发电机+变流器效率
    ratedGenRpm: 1173.7,           // rpm
    rotorInertia: 38759228,        // kg·m²（叶轮对主轴）
    genInertiaHSS: 534.116,        // kg·m²（发电机对高速轴）
    hssBrakeTorque: 28116.2,       // N·m（高速轴制动器）
    ratedRotorTorque: 4.18e6,      // N·m（低速轴额定转矩约 4.18 MN·m）
  },

  /* ---------------- 塔筒 [J09 Ch.6，陆上版] ---------------- */
  tower: {
    height: 87.6,                  // m，塔顶（偏航轴承）高度
    baseDiameter: 6.0,             // m
    topDiameter: 3.87,             // m
    baseWall: 0.027,               // m
    topWall: 0.019,                // m
    // 实际塔筒分 3 段运输、法兰螺栓连接（典型分段高度）
    sections: [0, 21.9, 50.4, 87.6],
    steelDensity: 8500,            // kg/m³（含涂层/法兰等附件的等效密度）
  },

  /* ---------------- 叶片气动分布 [J09 Table 2-1] ----------------
   * r: 到叶轮中心的展向位置 (m)；twist: 气动扭角 (deg)；dr: 单元长度 (m)
   * chord: 弦长 (m)；af: 翼型；thick: 相对厚度 t/c
   */
  blade: [
    { r: 2.8667, twist: 13.308, dr: 2.7333, chord: 3.542, af: 'Cylinder1', thick: 1.00 },
    { r: 5.6000, twist: 13.308, dr: 2.7333, chord: 3.854, af: 'Cylinder1', thick: 1.00 },
    { r: 8.3333, twist: 13.308, dr: 2.7333, chord: 4.167, af: 'Cylinder2', thick: 1.00 },
    { r: 11.7500, twist: 13.308, dr: 4.1000, chord: 4.557, af: 'DU40_A17', thick: 0.405 },
    { r: 15.8500, twist: 11.480, dr: 4.1000, chord: 4.652, af: 'DU35_A17', thick: 0.35 },
    { r: 19.9500, twist: 10.162, dr: 4.1000, chord: 4.458, af: 'DU35_A17', thick: 0.35 },
    { r: 24.0500, twist: 9.011, dr: 4.1000, chord: 4.249, af: 'DU30_A17', thick: 0.30 },
    { r: 28.1500, twist: 7.795, dr: 4.1000, chord: 4.007, af: 'DU25_A17', thick: 0.25 },
    { r: 32.2500, twist: 6.544, dr: 4.1000, chord: 3.748, af: 'DU25_A17', thick: 0.25 },
    { r: 36.3500, twist: 5.361, dr: 4.1000, chord: 3.502, af: 'DU21_A17', thick: 0.21 },
    { r: 40.4500, twist: 4.188, dr: 4.1000, chord: 3.256, af: 'DU21_A17', thick: 0.21 },
    { r: 44.5500, twist: 3.125, dr: 4.1000, chord: 3.010, af: 'NACA64_A17', thick: 0.18 },
    { r: 48.6500, twist: 2.319, dr: 4.1000, chord: 2.764, af: 'NACA64_A17', thick: 0.18 },
    { r: 52.7500, twist: 1.526, dr: 4.1000, chord: 2.518, af: 'NACA64_A17', thick: 0.18 },
    { r: 56.1667, twist: 0.863, dr: 2.7333, chord: 2.313, af: 'NACA64_A17', thick: 0.18 },
    { r: 58.9000, twist: 0.370, dr: 2.7333, chord: 2.086, af: 'NACA64_A17', thick: 0.18 },
    { r: 61.6333, twist: 0.106, dr: 2.7333, chord: 1.419, af: 'NACA64_A17', thick: 0.18 },
  ],

  /* ---------------- 基准控制器 DISCON [J09 Ch.7] ----------------
   * 发电机侧（高速轴）单位：rad/s、N·m
   */
  control: {
    CornerFreq: 1.570796,          // rad/s，发电机转速低通滤波角频率（0.25 Hz）
    PC_KK: 0.1099965,              // rad，变桨增益调度：桨距角 6.3° 时增益减半
    PC_KI: 0.008068634,            // s·rad/rad ×1/s，积分增益（桨距角=0 时）
    PC_KP: 0.01882681,             // s，比例增益（桨距角=0 时）
    PC_MaxPit: 1.570796,           // rad，最大桨距角 90°（顺桨）
    PC_MaxRat: 0.1396263,          // rad/s，最大变桨速率 8°/s
    PC_MinPit: 0.0,                // rad
    PC_RefSpd: 122.9096,           // rad/s，额定发电机转速 1173.7 rpm
    VS_CtInSp: 70.16224,           // rad/s，区域 1/1.5 转换 670 rpm
    VS_MaxRat: 15000.0,            // N·m/s，转矩变化率限制
    VS_MaxTq: 47402.91,            // N·m，最大发电机转矩
    VS_Rgn2K: 2.332287,            // N·m/(rad/s)²，区域 2 最优转矩系数
    VS_Rgn2Sp: 91.21091,           // rad/s，区域 1.5/2 转换 871 rpm
    VS_Rgn3MP: 0.01745329,         // rad，桨距 >1° 视为区域 3
    VS_RtGnSp: 121.6805,           // rad/s，区域 2.5 起点 1161.963 rpm
    VS_RtPwr: 5296610.0,           // W，额定机械功率
    VS_SlPc: 10.0,                 // %，区域 2.5 同步转速滑差
  },

  /* ---------------- 偏航系统（典型值） ---------------- */
  yaw: {
    rate: 0.3,                     // deg/s，额定偏航速率 [J09 §5]
    startError: 8,                 // deg，持续对风误差超过此值启动偏航
    stopError: 1.0,                // deg
    filterTau: 20,                 // s，风向标信号滤波时间常数
    startDelay: 10,                // s
    maxCableTwist: 3,              // 圈，超过则自动解缆
  },
};

/** 由弧度/秒转 rpm */
export const radsToRpm = (w) => (w * 60) / (2 * Math.PI);
export const rpmToRads = (n) => (n * 2 * Math.PI) / 60;
export const DEG = Math.PI / 180;

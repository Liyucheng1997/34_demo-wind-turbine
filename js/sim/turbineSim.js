/**
 * turbineSim.js — 整机实时动力学仿真
 * ------------------------------------------------------------------
 * 每步 20 ms 固定步长，积分以下自由度：
 *   ▸ 传动链：J·dΩ/dt = Q_aero − N·Q_gen − Q_brake
 *       J = 叶轮 38.76e6 + 发电机 534.1×97² ≈ 43.78e6 kg·m²（刚性传动链）
 *   ▸ 塔顶前后振动：m·ẍ + c·ẋ + k·x = T（一阶模态 0.324 Hz）
 *       推力用相对风速 (V − ẋ) 计算，天然产生“气动阻尼”
 *   ▸ 变桨执行机构：速率限制 8°/s
 *   ▸ 偏航：风向标信号滤波、误差超限延时启动、0.3°/s 转动、电缆扭转计数
 *   ▸ 主控状态机：停机待风 → 启动 → 运行 → 正常停机 / 紧急停机
 * 气动力由 BEM 预计算的 Cp/Ct/Cq(λ, β) 表插值获得。
 */
import { NREL5MW, DEG, radsToRpm } from '../data/nrel5mw.js';
import { lookup, solveRotor } from '../aero/bem.js';
import { Discon, torqueLaw } from './controller.js';
import {
  Turbulence, airDensity, rewsFactor, shearFactor, bladeShearFactor, eogAmplitude, eogShape,
  TERRAINS, TURB_CLASSES, weibullPdf, equivalentAlpha,
} from './atmosphere.js';

const T5 = NREL5MW;
const R = T5.rotorRadius;
const N = T5.drivetrain.gearRatio;
const J = T5.drivetrain.rotorInertia + T5.drivetrain.genInertiaHSS * N * N;
const ETA = T5.drivetrain.genEfficiency;
const G = 9.80665;

// 塔架一阶前后模态（NREL 5MW 陆上塔：0.324 Hz）
const TWR_F = 0.324;
const TWR_M = 350000 + 0.25 * T5.mass.tower;         // 塔顶等效质量：机舱+叶轮 + 1/4 塔筒
const TWR_K = TWR_M * (2 * Math.PI * TWR_F) ** 2;
const TWR_C = 2 * 0.01 * Math.sqrt(TWR_K * TWR_M);   // 1% 结构阻尼

export const MODES = {
  PARKED: { label: '停机待风', tone: 'muted' },
  STARTUP: { label: '启动中（变桨开桨）', tone: 'warn' },
  RUN: { label: '并网发电', tone: 'ok' },
  STOP: { label: '正常停机（顺桨）', tone: 'warn' },
  ESTOP: { label: '紧急停机（8°/s 顺桨 + 高速轴制动）', tone: 'danger' },
};

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export class TurbineSim {
  constructor(tables) {
    this.tables = tables;
    this.turb = new Turbulence(11);
    this.ctrl = new Discon();

    // ------- 环境输入 -------
    this.env = {
      Vmean: 9.0,          // 10 分钟平均轮毂风速 m/s
      dirMean: 270,        // 平均风向（气象学：风的来向，270 = 西风）
      wakeFactor: 1,       // 上游风机尾流造成的风速折减（风电场模块给出）
      dirDrift: false,     // 风向缓慢漂移
      terrain: 'grass',
      turbClass: 'B',
      tempC: 15,
      altitude: 500,
      rh: 0.6,
      annualMean: 7.5,     // 年平均风速（AEP 用）
    };

    // ------- 状态 -------
    this.t = 0;
    this.Omega = 0.2;          // rad/s
    this.azimuth = 0;          // rad
    this.pitch = 90 * DEG;     // rad
    this.pitchCmd = 90 * DEG;
    this.genTrq = 0;
    this.brake = 0;            // 0-1
    this.mode = 'PARKED';
    this.estopLatched = false;
    this.userStop = false;
    this.windAvg = this.env.Vmean;  // 监控用长时平均风速（真实机组为 10 min，这里 60 s）
    this.gust3s = this.env.Vmean;
    this.parkTimer = 0;
    this.lowWindTimer = 0;
    this.highWindLock = 0;

    // 偏航
    this.heading = 270;        // 机舱朝向（叶轮所对的方位角）
    this.yawAuto = true;
    this.yawTarget = 270;
    this.yawState = 'HOLD';
    this.yawErrFilt = 0;
    this.yawErrFast = 0;
    this.yawTimer = 0;
    this.cableTwist = 0;       // deg，累积

    // 塔架
    this.twrX = 0; this.twrV = 0;

    // EOG
    this.eogT0 = -1; this.eogAmp = 0;

    // 输出（每步更新）
    this.out = {};
    this.history = [];         // 用于时序图（每 0.1 s 采样）
    this._histTimer = 0;
    this.uHist = new Float32Array(1200); // 单点湍流 u' 历史（0.05 s × 1200 = 60 s），供流场“冻结湍流”
    this.uHistIdx = 0; this._uTimer = 0;

    this.applyEnv();
  }

  /** 环境参数变化后重算派生量 */
  applyEnv() {
    const e = this.env;
    const z0 = TERRAINS[e.terrain].z0;
    const Iref = TURB_CLASSES[e.turbClass].Iref;
    this.z0 = z0;
    const air = airDensity(e.altitude, e.tempC, e.rh);
    this.rho = air.rho;
    this.pressure = air.p;
    this.rews = rewsFactor(T5.hubHeight, R, z0);
    this.alphaEq = equivalentAlpha(T5.hubHeight, R, z0);
    this.turb.configure(e.Vmean, Iref, R);
    this.sigma1 = this.turb.sigmaU;
    this.Iref = Iref;
    this._curveDirty = true;
  }

  /* ---------------- 操作接口 ---------------- */
  triggerEOG() {
    this.eogT0 = this.t;
    this.eogAmp = eogAmplitude(this.env.Vmean, Math.max(this.sigma1, 0.14 * (0.75 * this.env.Vmean + 5.6)), 2 * R);
  }
  emergencyStop() { this.estopLatched = true; this.mode = 'ESTOP'; }
  resetFaults() { this.estopLatched = false; this.userStop = false; if (this.mode === 'ESTOP') this.mode = 'PARKED'; this.brake = 0; }
  toggleUserStop() {
    this.userStop = !this.userStop;
    if (this.userStop && (this.mode === 'RUN' || this.mode === 'STARTUP')) this.mode = 'STOP';
  }

  /** 湍流 u' 历史查询（ago 秒之前），给流场粒子做 Taylor 冻结湍流 */
  uAgo(ago) {
    const k = Math.min(1199, Math.max(0, Math.round(ago / 0.05)));
    return this.uHist[(this.uHistIdx - k + 1200) % 1200];
  }

  /* ---------------- 主积分步 ---------------- */
  step(dt) {
    const e = this.env;
    this.t += dt;

    // ===== 1. 风 =====
    if (e.dirDrift) e.dirMean = (e.dirMean + dt * 0.08 * Math.sin(this.t / 97) + 360) % 360;
    const tu = this.turb.sample(this.t);
    let gust = 0;
    if (this.eogT0 >= 0) {
      const tg = this.t - this.eogT0;
      gust = eogShape(tg, this.eogAmp);
      if (tg > 10.5) this.eogT0 = -1;
    }
    const Vm = e.Vmean * e.wakeFactor;
    const Vhub = Math.max(0, Vm + tu.u + gust);                      // 轮毂高度瞬时风速
    const Vrews = Math.max(0, Vm * this.rews + tu.u + gust);         // 叶轮等效风速
    const dirInst = (e.dirMean + Math.atan2(tu.v, Math.max(Vhub, 0.5)) / DEG + 360) % 360;

    this._uTimer += dt;
    if (this._uTimer >= 0.05) { this._uTimer = 0; this.uHistIdx = (this.uHistIdx + 1) % 1200; this.uHist[this.uHistIdx] = tu.up + gust; }

    // 监控滤波
    this.windAvg += (Vhub - this.windAvg) * (dt / 60);
    this.gust3s += (Vhub - this.gust3s) * (dt / 3);

    // ===== 2. 偏航误差与法向风速 =====
    const yawErr = wrap180(dirInst - this.heading);        // 风向 − 机舱朝向
    const cg = Math.max(0, Math.cos(yawErr * DEG));
    const Vn = Vrews * cg - this.twrV;                     // 相对塔顶运动的法向风速
    const VnC = Math.max(Vn, 0.3);

    // ===== 3. 气动 =====
    const pitchDeg = this.pitch / DEG;
    const lam = (this.Omega * R) / VnC;
    const lamC = Math.min(lam, 18);
    const Cq = lookup(this.tables, 'Cq', lamC, pitchDeg);
    const Ct = lookup(this.tables, 'Ct', lamC, pitchDeg);
    const qd = 0.5 * this.rho * Math.PI * R * R * VnC * VnC;   // 动压 × 面积
    let Qaero = qd * R * Cq;
    if (lam > 18) Qaero *= Math.max(0, 1 - (lam - 18) * 0.2); // 超出表范围的保守外推
    const Thrust = qd * Ct;
    const Paero = Qaero * this.Omega;

    // ===== 4. 主控状态机 =====
    const genSpeed = this.Omega * N;
    const cutOut = this.windAvg > T5.cutOut || this.gust3s > 30;
    switch (this.mode) {
      case 'PARKED':
        this.pitchCmd = 90 * DEG;
        this.genTrq = 0;
        this.parkTimer += dt;
        if (this.highWindLock > 0) this.highWindLock -= dt;
        if (!this.estopLatched && !this.userStop && this.parkTimer > 5 && this.highWindLock <= 0 &&
            this.windAvg >= T5.cutIn && this.windAvg < 20 && this.gust3s < 25 &&
            Math.abs(this.yawErrFilt) < 20 && this.yawState !== 'UNTWIST') {
          this.mode = 'STARTUP';
        }
        break;
      case 'STARTUP':
        // 以 2°/s 开桨至 0°，发电机转矩由 DISCON 区域 1 决定（< 670 rpm 为 0）
        this.pitchCmd = Math.max(0, this.pitch - 2 * DEG * dt);
        this.ctrl.genSpeedF = genSpeed;
        this.genTrq = torqueLaw(genSpeed, 0).torque * (genSpeed > 70.16 ? 1 : 0);
        if (this.pitch <= 0.2 * DEG || (genSpeed > 110 && this.pitch < 20 * DEG)) {
          this.mode = 'RUN';
          this.ctrl.reset(this.pitch, genSpeed);
          this.ctrl.seedIntegrator(this.pitch);
          this.ctrl.genTrq = this.genTrq;
        }
        if (cutOut) { this.mode = 'STOP'; this.highWindLock = 180; }
        break;
      case 'RUN': {
        const c = this.ctrl.step(dt, genSpeed, this.pitch);
        this.genTrq = c.genTrq;
        this.pitchCmd = c.pitCom;
        if (cutOut) this.highWindLock = 180; // 大风切出后锁定：平均风速回落且等待 3 min（仿真时间）才允许再启动
        if (cutOut || this.userStop || this.yawState === 'UNTWIST') this.mode = 'STOP';
        // 小风：平均风速低于切入且转速掉到区域 1
        if (this.windAvg < T5.cutIn - 0.5 && genSpeed < 75) this.lowWindTimer += dt; else this.lowWindTimer = 0;
        if (this.lowWindTimer > 20) this.mode = 'STOP';
        break;
      }
      case 'STOP':
        // 正常停机：4°/s 顺桨，发电机按转矩律继续发电帮助减速
        this.pitchCmd = Math.min(90 * DEG, this.pitch + 4 * DEG * dt);
        this.genTrq = genSpeed > 70.16 ? Math.min(torqueLaw(genSpeed, 0).torque, C_MAXTQ) : 0;
        if (this.pitch >= 89 * DEG && this.Omega < 0.25) { this.mode = 'PARKED'; this.parkTimer = 0; }
        break;
      case 'ESTOP':
        this.pitchCmd = 90 * DEG;
        this.genTrq = 0;                // 电网断开
        break;
    }

    // ===== 5. 变桨执行机构（速率限制） =====
    const pr = (this.mode === 'STARTUP' ? 2 : this.mode === 'STOP' ? 4 : 8) * DEG * dt;
    this.pitch += Math.max(-pr, Math.min(pr, this.pitchCmd - this.pitch));

    // ===== 6. 高速轴制动器 =====
    const brakeOn = this.mode === 'ESTOP';
    this.brake += ((brakeOn ? 1 : 0) - this.brake) * Math.min(1, dt / 0.6);
    const Qbrake = this.brake * T5.drivetrain.hssBrakeTorque * N;

    // ===== 7. 传动链积分 =====
    let dOmega = (Qaero - N * this.genTrq) / J;
    if (this.Omega > 1e-4) dOmega -= Qbrake / J;
    this.Omega += dOmega * dt;
    if (this.Omega < 0) this.Omega = 0;
    if (this.brake > 0.5 && this.Omega < 0.01) this.Omega = 0;
    this.azimuth = (this.azimuth + this.Omega * dt) % (Math.PI * 2);

    // ===== 8. 塔架前后振动 =====
    const aT = (Thrust - TWR_K * this.twrX - TWR_C * this.twrV) / TWR_M;
    this.twrV += aT * dt;
    this.twrX += this.twrV * dt;

    // ===== 9. 偏航系统 =====
    this.yawErrFilt += (yawErr - this.yawErrFilt) * (dt / T5.yaw.filterTau);
    this.yawErrFast += (yawErr - this.yawErrFast) * (dt / 3);
    const yr = T5.yaw.rate * dt;
    let yawMove = 0;
    if (this.yawState === 'UNTWIST') {
      yawMove = -Math.sign(this.cableTwist) * yr * 3; // 解缆时约 1°/s
      if (Math.abs(this.cableTwist) < 30) { this.yawState = 'HOLD'; }
    } else if (this.yawAuto) {
      if (this.yawState === 'HOLD') {
        if (Math.abs(this.yawErrFilt) > T5.yaw.startError) this.yawTimer += dt; else this.yawTimer = 0;
        if (this.yawTimer > T5.yaw.startDelay) { this.yawState = this.yawErrFilt > 0 ? 'CW' : 'CCW'; this.yawTimer = 0; }
      } else {
        const sgn = this.yawState === 'CW' ? 1 : -1;
        yawMove = sgn * yr;
        if (sgn * this.yawErrFast < T5.yaw.stopError) this.yawState = 'HOLD';
      }
      if (Math.abs(this.cableTwist) > T5.yaw.maxCableTwist * 360 && this.windAvg < 6) this.yawState = 'UNTWIST';
    } else {
      const d = wrap180(this.yawTarget - this.heading);
      if (Math.abs(d) > 0.05) { yawMove = Math.sign(d) * Math.min(yr, Math.abs(d)); this.yawState = d > 0 ? 'CW' : 'CCW'; }
      else this.yawState = 'HOLD';
    }
    this.heading = (this.heading + yawMove + 360) % 360;
    this.cableTwist += yawMove;

    // ===== 10. 输出 =====
    const Pelec = Math.max(0, this.genTrq * genSpeed * ETA);
    const Pwind = 0.5 * this.rho * Math.PI * R * R * Vrews ** 3;
    const o = this.out;
    o.t = this.t;
    o.Vhub = Vhub; o.Vrews = Vrews; o.Vn = Vn; o.dir = dirInst; o.gust = gust;
    o.yawErr = yawErr; o.heading = this.heading;
    o.lambda = lam; o.pitchDeg = this.pitch / DEG;
    o.rotorRpm = radsToRpm(this.Omega);
    o.genRpm = radsToRpm(genSpeed);
    o.genTrq = this.genTrq;
    o.Qaero = Qaero; o.Thrust = Thrust; o.Paero = Paero; o.Pelec = Pelec; o.Pwind = Pwind;
    o.Cp = Pwind > 1 ? Paero / Pwind : 0;
    o.Ct = Ct;
    o.tip = this.Omega * R;
    o.region = this.mode === 'RUN' ? this.ctrl.region : '—';
    o.twrX = this.twrX;
    o.brake = this.brake;
    o.mode = this.mode;

    // 载荷估算
    o.towerBaseMy = Thrust * T5.hubHeight;                        // 塔底倾覆弯矩（推力部分）
    const rcT = this.thrustCentroid || 0.7 * R;
    o.flap = [];
    o.edge = [];
    for (let b = 0; b < 3; b++) {
      const psi = this.azimuth + (b * 2 * Math.PI) / 3;            // 0 = 向上
      const fs = bladeShearFactor(psi, T5.hubHeight, R, T5.hubRadius, this.z0) / this.rews;
      o.flap.push((Thrust / 3) * (rcT - T5.hubRadius) * fs * fs);
      // 摆振：重力（叶片水平时最大）+ 气动扭矩分担
      const grav = T5.mass.blade * G * (T5.mass.bladeCgFromRoot) * Math.sin(psi);
      o.edge.push(grav + Qaero / 3);
    }
    // 叶尖挥舞变形：以额定工况 BEM 挥舞弯矩标定到 NREL 报告的约 5.4 m
    const mRef = this.flapRef || 1.2e7;
    o.tipDefl = o.flap.map((m) => (5.4 * m) / mRef);
    o.clearance = this.staticClearance - Math.max(0, o.tipDefl[0]) - this.twrX; // 近似（叶片在下方时）

    // 历史
    this._histTimer += dt;
    if (this._histTimer >= 0.1) {
      this._histTimer = 0;
      this.history.push({
        t: this.t, V: Vhub, Vr: Vrews, P: Pelec / 1e6, pitch: o.pitchDeg, rpm: o.rotorRpm,
        flap: o.flap[0] / 1e6, edge: o.edge[0] / 1e6, twr: this.twrX, yawErr,
      });
      if (this.history.length > 1800) this.history.shift();
    }
  }

  /* ---------------- 稳态解（功率曲线 / AEP） ---------------- */
  /** 给定叶轮等效风速 V，求控制器稳态工作点 */
  steadyState(V, rho = this.rho) {
    if (V < T5.cutIn || V > T5.cutOut) return { V, P: 0, Paero: 0, rpm: 0, pitch: 0, Ct: 0, Cp: 0, T: 0, lambda: 0, region: '停机' };
    const qA = (Om, beta) => {
      const lam = Math.min((Om * R) / V, 18);
      return 0.5 * rho * Math.PI * R ** 3 * V * V * lookup(this.tables, 'Cq', lam, beta);
    };
    const f = (Om) => qA(Om, 0) - N * torqueLaw(Om * N, 0).torque;
    const OmRef = NREL5MW.control.PC_RefSpd / N;
    let Om, beta = 0;
    // 区域 3 判定：额定转速下，是否存在“顺桨侧”桨距使气动功率 ≥ 额定机械功率
    const Prt = NREL5MW.control.VS_RtPwr;
    let bHi = -1;
    for (let b = 0; b <= 45; b += 0.5) if (qA(OmRef, b) * OmRef >= Prt) bHi = b;
    if (bHi >= 0 && f(OmRef) > 0) {
      // 区域 3：额定转速，变桨（顺桨方向）使气动功率 = 额定机械功率
      Om = OmRef;
      let lo = bHi, hi = bHi + 0.5;
      for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        if (qA(Om, mid) * Om > Prt) lo = mid; else hi = mid;
      }
      beta = 0.5 * (lo + hi);
    } else {
      let lo = 0.05, hi = OmRef * 1.01;
      for (let i = 0; i < 60; i++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) > 0) lo = mid; else hi = mid;
      }
      Om = 0.5 * (lo + hi);
    }
    const lam = (Om * R) / V;
    const Q = qA(Om, beta);
    const Pa = Q * Om;
    const Ct = lookup(this.tables, 'Ct', Math.min(lam, 18), beta);
    const Pw = 0.5 * rho * Math.PI * R * R * V ** 3;
    const region = beta > 1 ? '3' : torqueLaw(Om * N, 0).region;
    return {
      V, P: Math.max(0, Math.min(Pa * ETA, 5e6)), Paero: Pa, rpm: radsToRpm(Om), pitch: beta,
      Ct, Cp: Pa / Pw, T: 0.5 * rho * Math.PI * R * R * V * V * Ct, lambda: lam, region, Om,
    };
  }

  /** 功率曲线 + AEP（Rayleigh 分布、轮毂高度年均风速） */
  powerCurve() {
    if (!this._curveDirty && this._curve) return this._curve;
    const pts = [];
    for (let v = 0; v <= 30.001; v += 0.25) pts.push(this.steadyState(v));
    // AEP：风速分布按轮毂风速，功率按等效风速（含切变修正）
    let aep = 0, hours = 0;
    for (let v = 0.125; v < 30; v += 0.25) {
      const p = this.steadyState(v * this.rews).P;
      const w = weibullPdf(v, this.env.annualMean) * 0.25;
      aep += p * w * 8760;
      if (p > 0) hours += w * 8760;
    }
    this._curve = { pts, aepWh: aep, cf: aep / (5e6 * 8760), genHours: hours };
    this._curveDirty = false;
    return this._curve;
  }

  /** 额定工况的展向分布：标定挥舞弯矩、推力作用点 */
  calibrate() {
    const ss = this.steadyState(T5.ratedWind, 1.225);
    const d = solveRotor(ss.lambda, ss.pitch * DEG, T5, true).dist;
    let M = 0, Tsum = 0, TM = 0;
    const cc = Math.cos(T5.precone * DEG);
    for (const el of d) {
      const f = el.fN * 1.225 * T5.ratedWind ** 2 * T5.blade.find((b) => b.r === el.r).dr * cc;
      M += f * (el.r - T5.hubRadius);
      Tsum += f; TM += f * el.r;
    }
    this.flapRef = M;
    this.thrustCentroid = TM / Tsum;
    // 静态叶尖—塔筒净距（叶片竖直向下时）
    const tilt = T5.shaftTilt * DEG, cone = T5.precone * DEG;
    const tipZ = T5.hubHeight - R * Math.cos(cone) * Math.cos(tilt);
    const xTip = T5.overhang * Math.cos(tilt) + R * Math.sin(cone) * Math.cos(tilt) + R * Math.cos(cone) * Math.sin(tilt);
    const twrR = (T5.tower.baseDiameter - (T5.tower.baseDiameter - T5.tower.topDiameter) * (tipZ / T5.tower.height)) / 2;
    this.staticClearance = xTip - twrR;
    this.ratedFlap = M;
    return { flapRef: M, centroid: this.thrustCentroid, clearance: this.staticClearance };
  }

  /** 当前工况的展向分布（叶片面板用） */
  spanwise() {
    const V = Math.max(this.out.Vn || 0, 0.5);
    const lam = Math.min(Math.max(this.out.lambda || 0, 0.05), 18);
    const d = solveRotor(lam, this.pitch, T5, true).dist;
    const q = this.rho * V * V;
    return d.map((el) => ({ ...el, dFn: el.fN * q, dFt: el.fT * q, Wabs: el.W * V }));
  }
}

const C_MAXTQ = NREL5MW.control.VS_MaxTq;

export { shearFactor, TWR_F };

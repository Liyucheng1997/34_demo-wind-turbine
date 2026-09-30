/**
 * controller.js — NREL 5MW 基准控制器（DISCON）的 JavaScript 移植
 * ------------------------------------------------------------------
 * 与 OpenFAST 中 DISCON.f90（Jonkman 2009, Ch.7）逐行对应，包括：
 *   ▸ 发电机转速一阶低通滤波（0.25 Hz）——滤掉 3P 转速波动，防止变桨抖动
 *   ▸ 变速转矩控制：区域 1 / 1.5 / 2（最优转矩 k·ω²）/ 2.5（滑差过渡）/ 3（恒功率）
 *   ▸ 增益调度 PI 变桨：GK = 1/(1 + θ/θK)，桨距越大，气动灵敏度 ∂P/∂θ 越大，增益越小
 *   ▸ 积分饱和抗饱和、变桨速率 8°/s 限制、转矩变化率 15 kN·m/s 限制
 */
import { NREL5MW } from '../data/nrel5mw.js';

const C = NREL5MW.control;

// 由基本参数导出的区域 2.5 常数（与 DISCON 初始化段完全一致）
const VS_SySp = C.VS_RtGnSp / (1 + 0.01 * C.VS_SlPc);
const VS_Slope15 = (C.VS_Rgn2K * C.VS_Rgn2Sp * C.VS_Rgn2Sp) / (C.VS_Rgn2Sp - C.VS_CtInSp);
const VS_Slope25 = C.VS_RtPwr / C.VS_RtGnSp / (C.VS_RtGnSp - VS_SySp);
const VS_TrGnSp = C.VS_Rgn2K === 0
  ? VS_SySp
  : (VS_Slope25 - Math.sqrt(VS_Slope25 * (VS_Slope25 - 4 * C.VS_Rgn2K * VS_SySp))) / (2 * C.VS_Rgn2K);

export const DERIVED = { VS_SySp, VS_Slope15, VS_Slope25, VS_TrGnSp };

/**
 * 转矩控制律：输入滤波后的发电机转速（rad/s）与当前桨距指令（rad）
 * 返回 {torque, region}
 */
export function torqueLaw(genSpeedF, pitchCom) {
  let tq, region;
  if (genSpeedF >= C.VS_RtGnSp || pitchCom >= C.VS_Rgn3MP) {
    tq = C.VS_RtPwr / genSpeedF; region = '3';
  } else if (genSpeedF <= C.VS_CtInSp) {
    tq = 0; region = '1';
  } else if (genSpeedF < C.VS_Rgn2Sp) {
    tq = VS_Slope15 * (genSpeedF - C.VS_CtInSp); region = '1.5';
  } else if (genSpeedF < VS_TrGnSp) {
    tq = C.VS_Rgn2K * genSpeedF * genSpeedF; region = '2';
  } else {
    tq = VS_Slope25 * (genSpeedF - VS_SySp); region = '2.5';
  }
  return { torque: Math.min(tq, C.VS_MaxTq), region };
}

export class Discon {
  constructor() { this.reset(); }

  reset(pitch = 0, genSpeed = C.VS_CtInSp) {
    this.genSpeedF = genSpeed;
    this.intSpdErr = 0;
    this.pitCom = pitch;
    this.genTrq = 0;
    this.region = '1';
    this.gk = 1;
    this.spdErr = 0;
  }

  /** 初始化积分器，使当前桨距连续（切入 RUN 模式时调用） */
  seedIntegrator(pitch) {
    const GK = 1 / (1 + pitch / C.PC_KK);
    this.intSpdErr = pitch / (GK * C.PC_KI);
    this.pitCom = pitch;
  }

  /**
   * 一个控制周期。genSpeed 高速轴实测转速 rad/s，pitchMeas 实际桨距 rad。
   * 返回 {genTrq, pitCom}
   */
  step(dt, genSpeed, pitchMeas) {
    // 1) 转速滤波
    const alpha = Math.exp(-dt * C.CornerFreq);
    this.genSpeedF = (1 - alpha) * genSpeed + alpha * this.genSpeedF;

    // 2) 变速转矩控制
    const { torque, region } = torqueLaw(this.genSpeedF, this.pitCom);
    const dTq = Math.max(-C.VS_MaxRat * dt, Math.min(C.VS_MaxRat * dt, torque - this.genTrq));
    this.genTrq += dTq;
    this.region = region;

    // 3) 增益调度 PI 变桨
    const GK = 1 / (1 + pitchMeas / C.PC_KK);
    const spdErr = this.genSpeedF - C.PC_RefSpd;
    this.intSpdErr += spdErr * dt;
    this.intSpdErr = Math.min(Math.max(this.intSpdErr, C.PC_MinPit / (GK * C.PC_KI)), C.PC_MaxPit / (GK * C.PC_KI));
    const pitComP = GK * C.PC_KP * spdErr;
    const pitComI = GK * C.PC_KI * this.intSpdErr;
    let pitComT = Math.min(Math.max(pitComP + pitComI, C.PC_MinPit), C.PC_MaxPit);
    // 速率限制
    const maxStep = C.PC_MaxRat * dt;
    pitComT = pitchMeas + Math.max(-maxStep, Math.min(maxStep, pitComT - pitchMeas));
    this.pitCom = pitComT;
    this.gk = GK;
    this.spdErr = spdErr;
    return { genTrq: this.genTrq, pitCom: this.pitCom };
  }
}

/**
 * validate.mjs — 物理模型与 NREL 5MW 文献值对比 + 动态仿真稳定性检查
 * 运行：node tests/validate.mjs
 */
import { buildTables, solveRotor } from '../js/aero/bem.js';
import { TurbineSim } from '../js/sim/turbineSim.js';
import { NREL5MW, DEG } from '../js/data/nrel5mw.js';

const t0 = Date.now();
const tables = buildTables();
console.log(`BEM 查找表: ${tables.nL}×${tables.nP} 工况，用时 ${Date.now() - t0} ms\n`);

// ---------- 1. 最大功率系数 ----------
let best = { Cp: 0 };
for (let l = 5; l <= 11; l += 0.05) {
  const s = solveRotor(l, 0);
  if (s.Cp > best.Cp) best = { Cp: s.Cp, l };
}
const rows = [];
const chk = (name, ours, ref, tol) => {
  const err = (ours - ref) / ref;
  rows.push({ 项目: name, 本模型: +ours.toFixed(3), 文献: ref, 偏差: `${(err * 100).toFixed(1)}%`, 结论: Math.abs(err) <= tol ? 'OK' : '偏差较大' });
};
chk('最大 Cp（β=0）', best.Cp, 0.482, 0.03);
chk('最佳叶尖速比 λ', best.l, 7.55, 0.08);

// ---------- 2. 稳态工作点 ----------
const sim = new TurbineSim(tables);
sim.env.altitude = 0; sim.env.tempC = 15; sim.env.rh = 0; sim.env.terrain = 'sea';
sim.applyEnv();
const cal = sim.calibrate();
const rho0 = 1.225;
const s8 = sim.steadyState(8, rho0);
chk('8 m/s 转速 (rpm)', s8.rpm, 9.16, 0.05);
chk('8 m/s 电功率 (MW)', s8.P / 1e6, 1.78, 0.06);
// 额定风速：功率首次达到 5 MW 的风速
let vRated = 0;
for (let v = 9; v < 14; v += 0.01) { if (sim.steadyState(v, rho0).P >= 4.999e6) { vRated = v; break; } }
chk('额定风速 (m/s)', vRated, 11.4, 0.04);
const s12 = sim.steadyState(11.4, rho0);
chk('额定转速 (rpm)', s12.rpm, 12.1, 0.02);
chk('额定推力 (kN)', s12.T / 1e3, 800, 0.10);
const s25 = sim.steadyState(25, rho0);
chk('25 m/s 桨距角 (°)', s25.pitch, 23.5, 0.10);
chk('额定低速轴转矩 (MN·m)', s12.Paero / (s12.Om) / 1e6, 4.18, 0.05);
console.table(rows);

console.log('\n稳态功率曲线（ρ=1.225）：');
const pc = [];
for (const v of [3, 4, 5, 6, 7, 8, 9, 10, 11, 11.4, 12, 14, 16, 18, 20, 22, 25]) {
  const s = sim.steadyState(v, rho0);
  pc.push({ V: v, 'P(MW)': +(s.P / 1e6).toFixed(3), rpm: +s.rpm.toFixed(2), '桨距°': +s.pitch.toFixed(2), Cp: +s.Cp.toFixed(3), Ct: +s.Ct.toFixed(3), λ: +s.lambda.toFixed(2), 区域: s.region });
}
console.table(pc);
console.log(`额定挥舞弯矩(叶根) ${(cal.flapRef / 1e6).toFixed(2)} MN·m，推力作用点 r=${cal.centroid.toFixed(1)} m，静态叶尖净距 ${cal.clearance.toFixed(2)} m`);

// ---------- 3. 动态仿真：阶跃 + 湍流 ----------
function run(Vmean, turb, seconds, label) {
  const s = new TurbineSim(tables);
  s.env.Vmean = Vmean; s.env.turbClass = turb; s.env.dirMean = 270; s.heading = 270;
  s.applyEnv(); s.calibrate();
  s.windAvg = Vmean; s.gust3s = Vmean;
  let pMax = 0, pSum = 0, n = 0, rpmMax = 0, pitchMax = 0, nan = false;
  const dt = 0.02;
  for (let i = 0; i < seconds / dt; i++) {
    s.step(dt);
    if (!isFinite(s.Omega) || !isFinite(s.pitch)) { nan = true; break; }
    if (s.t > seconds * 0.4) {
      pMax = Math.max(pMax, s.out.Pelec); pSum += s.out.Pelec; n++;
      rpmMax = Math.max(rpmMax, s.out.rotorRpm); pitchMax = Math.max(pitchMax, s.out.pitchDeg);
    }
  }
  console.log(`${label.padEnd(22)} 模式=${s.mode.padEnd(7)} 平均功率=${(pSum / n / 1e6).toFixed(2)} MW  最大=${(pMax / 1e6).toFixed(2)} MW  最大转速=${rpmMax.toFixed(2)} rpm  最大桨距=${pitchMax.toFixed(1)}°  ${nan ? '❌ NaN' : ''}`);
  return s;
}
console.log('\n动态仿真（启动 → 并网 → 稳态）：');
run(6, 'L', 300, '6 m/s 层流');
run(9, 'L', 300, '9 m/s 层流');
run(15, 'L', 300, '15 m/s 层流');
run(9, 'B', 600, '9 m/s IEC B 湍流');
run(15, 'A', 600, '15 m/s IEC A 湍流');
const sc = run(28, 'L', 200, '28 m/s 超切出');

// 紧急停机
const se = run(15, 'L', 250, '15 m/s → 急停前');
se.emergencyStop();
let tStop = 0;
for (let i = 0; i < 60 / 0.02; i++) { se.step(0.02); if (se.Omega < 0.01) { tStop = i * 0.02; break; } }
console.log(`紧急停机：叶轮从额定转速到静止用时 ${tStop.toFixed(1)} s，最终桨距 ${se.out.pitchDeg.toFixed(1)}°`);

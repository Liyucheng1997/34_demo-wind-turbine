/**
 * charts.js — 工程图表（Canvas 2D）
 *   时序曲线 | 功率曲线 | 叶片展向 | Cp–λ 曲线族 | 坎贝尔图 | 风电场尾流
 * 约定：单一 y 轴（多量纲用上下分栏小多图），≥2 条曲线必有图例，悬停显示读数。
 */
import { NREL5MW } from '../data/nrel5mw.js';
import { lookup } from '../aero/bem.js';

const C = {
  s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500',
  good: '#0ca30c', warn: '#fab219', crit: '#d03b3b',
  text: '#e8eef4', text2: '#b4c0cc', muted: '#7d8a97', grid: 'rgba(255,255,255,0.07)', axis: 'rgba(255,255,255,0.22)',
  seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'],
};
const FONT = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export class Charts {
  constructor(canvas, tooltip) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = tooltip;
    this.tab = 'ts';
    this.hover = null;
    this.hits = []; // 当前帧可悬停对象
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.style.opacity = 0; });
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return false;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    return true;
  }

  /** 画坐标框，返回映射函数 */
  frame(x, y, w, h, xr, yr, { xlabel = '', ylabel = '', xt, yt, xfmt = (v) => v, yfmt = (v) => v } = {}) {
    const g = this.ctx;
    const X = (v) => x + ((v - xr[0]) / (xr[1] - xr[0])) * w;
    const Y = (v) => y + h - ((v - yr[0]) / (yr[1] - yr[0])) * h;
    g.font = FONT;
    g.lineWidth = 1;
    g.strokeStyle = C.grid;
    g.fillStyle = C.muted;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const t of yt || niceTicks(yr[0], yr[1], 3)) {
      g.beginPath(); g.moveTo(x, Y(t)); g.lineTo(x + w, Y(t)); g.stroke();
      g.fillText(yfmt(t), x - 5, Y(t));
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of xt || niceTicks(xr[0], xr[1], 6)) {
      g.beginPath(); g.moveTo(X(t), y); g.lineTo(X(t), y + h); g.stroke();
      g.fillText(xfmt(t), X(t), y + h + 3);
    }
    g.strokeStyle = C.axis;
    g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w, y + h); g.stroke();
    g.fillStyle = C.text2;
    if (ylabel) { g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(ylabel, x, y - 2); }
    if (xlabel) { g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText(xlabel, x + w, y + h + 15); }
    return { X, Y, x, y, w, h, xr, yr };
  }

  line(f, xs, ys, color, width = 2, dash = null) {
    const g = this.ctx;
    g.save();
    g.beginPath(); g.rect(f.x, f.y - 1, f.w, f.h + 2); g.clip();
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      if (!isFinite(ys[i])) { started = false; continue; }
      const px = f.X(xs[i]), py = f.Y(ys[i]);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
    g.restore();
  }

  legend(items, x, y) {
    const g = this.ctx;
    g.font = FONT; g.textBaseline = 'middle'; g.textAlign = 'left';
    let cx = x;
    for (const it of items) {
      g.strokeStyle = it.color; g.lineWidth = 2;
      if (it.dash) g.setLineDash(it.dash);
      g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + 14, y); g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.text2;
      g.fillText(it.label, cx + 18, y);
      cx += 26 + g.measureText(it.label).width;
    }
  }

  showTip(html, px, py) {
    const t = this.tip;
    t.innerHTML = html;
    t.style.opacity = 1;
    const r = this.cv.getBoundingClientRect();
    const tw = t.offsetWidth;
    let left = r.left + px + 14;
    if (left + tw > innerWidth - 8) left = r.left + px - tw - 14;
    t.style.left = `${left}px`;
    t.style.top = `${r.top + py - 10}px`;
  }

  draw(sim, extra) {
    if (!this.resize()) return;
    const g = this.ctx;
    g.clearRect(0, 0, this.W, this.H);
    let tipShown = false;
    const fn = {
      ts: () => this.drawTS(sim), pc: () => this.drawPC(sim), span: () => this.drawSpan(extra.span),
      cp: () => this.drawCp(sim), camp: () => this.drawCampbell(sim), farm: () => this.drawFarm(sim, extra.farm),
    }[this.tab];
    tipShown = fn && fn();
    if (!tipShown) this.tip.style.opacity = 0;
  }

  /* ---------------- 时序曲线（小多图） ---------------- */
  drawTS(sim) {
    const hist = sim.history;
    if (hist.length < 2) return false;
    const tEnd = hist[hist.length - 1].t, span = 120;
    const tStart = tEnd - span;
    const rows = [
      { key: 'V', label: '轮毂风速 m/s', color: C.s1, fix: [0, null] },
      { key: 'P', label: '电功率 MW', color: C.s3, fix: [0, 5.5] },
      { key: 'pitch', label: '桨距角 °', color: C.s4, fix: [0, null] },
      { key: 'rpm', label: '叶轮转速 rpm', color: C.s1, fix: [0, 14] },
      { keys: ['flap', 'edge'], label: '叶片1 根部弯矩 MN·m', colors: [C.s2, C.s1], names: ['挥舞', '摆振'] },
      { key: 'twr', label: '塔顶前后位移 m', color: C.s3 },
    ];
    const L = 44, Rr = 12, top = 16, gap = 20;
    const rh = (this.H - top - 18 - gap * (rows.length - 1)) / rows.length;
    const data = hist.filter((h) => h.t >= tStart);
    const ts = data.map((d) => d.t - tEnd);
    let hoverIdx = -1;
    if (this.hover && this.hover.x > L && this.hover.x < this.W - Rr) {
      const tt = -span + ((this.hover.x - L) / (this.W - L - Rr)) * span;
      let best = 1e9;
      ts.forEach((t, i) => { if (Math.abs(t - tt) < best) { best = Math.abs(t - tt); hoverIdx = i; } });
    }
    rows.forEach((r, k) => {
      const y = top + k * (rh + gap);
      const keys = r.keys || [r.key];
      let lo = Infinity, hi = -Infinity;
      for (const d of data) for (const kk of keys) { lo = Math.min(lo, d[kk]); hi = Math.max(hi, d[kk]); }
      if (r.fix) { if (r.fix[0] !== null) lo = Math.min(lo, r.fix[0]); if (r.fix[1] !== null) hi = Math.max(hi, r.fix[1]); }
      if (hi - lo < 1e-3) { hi += 0.5; lo -= 0.5; }
      const pad = (hi - lo) * 0.08;
      const f = this.frame(L, y, this.W - L - Rr, rh, [-span, 0], [lo - pad, hi + pad], {
        ylabel: r.label, yt: niceTicks(lo, hi, 2), xt: k === rows.length - 1 ? undefined : [],
        xfmt: (v) => `${v}s`, yfmt: (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)),
      });
      keys.forEach((kk, j) => this.line(f, ts, data.map((d) => d[kk]), r.colors ? r.colors[j] : r.color, 1.6));
      if (r.names) this.legend(r.names.map((n, j) => ({ label: n, color: r.colors[j] })), L + 150, y - 7);
      if (hoverIdx >= 0) {
        const g = this.ctx;
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(f.X(ts[hoverIdx]), y); g.lineTo(f.X(ts[hoverIdx]), y + rh); g.stroke();
        keys.forEach((kk, j) => {
          g.fillStyle = r.colors ? r.colors[j] : r.color;
          g.strokeStyle = '#111a24'; g.lineWidth = 2;
          g.beginPath(); g.arc(f.X(ts[hoverIdx]), f.Y(data[hoverIdx][kk]), 4, 0, 7); g.fill(); g.stroke();
        });
      }
    });
    if (hoverIdx >= 0) {
      const d = data[hoverIdx];
      this.showTip(`<b>t = ${ts[hoverIdx].toFixed(1)} s</b><br>风速 ${d.V.toFixed(2)} m/s<br>功率 ${d.P.toFixed(2)} MW<br>桨距 ${d.pitch.toFixed(2)}°<br>转速 ${d.rpm.toFixed(2)} rpm<br>挥舞 ${d.flap.toFixed(2)} / 摆振 ${d.edge.toFixed(2)} MN·m<br>塔顶 ${d.twr.toFixed(3)} m`, this.hover.x, this.hover.y);
      return true;
    }
    return false;
  }

  /* ---------------- 功率曲线 ---------------- */
  drawPC(sim) {
    const pc = sim.powerCurve();
    const L = 44, Rr = 14, top = 18;
    const h1 = (this.H - top - 50) * 0.68, h2 = (this.H - top - 50) * 0.32;
    const V = pc.pts.map((p) => p.V);
    const f = this.frame(L, top, this.W - L - Rr, h1, [0, 30], [0, 6], { ylabel: '稳态电功率 MW（ρ 为当前气象条件）', xt: [] });
    // 区域着色
    const g = this.ctx;
    const T = NREL5MW;
    // 贝兹极限对应的功率（参考）
    const rho = sim.rho, A = Math.PI * T.rotorRadius ** 2;
    this.line(f, V, V.map((v) => Math.min(0.593 * 0.5 * rho * A * v ** 3 * 0.944 / 1e6, 99)), C.muted, 1.2, [4, 4]);
    this.line(f, V, pc.pts.map((p) => p.P / 1e6), C.s3, 2.2);
    // 实时散点（最近 60 s，风速取叶轮等效风速）
    const hist = sim.history.slice(-600);
    g.fillStyle = 'rgba(57,135,229,0.55)';
    for (const hh of hist) g.fillRect(f.X(hh.Vr || hh.V) - 1.5, f.Y(hh.P) - 1.5, 3, 3);
    const o = sim.out;
    g.fillStyle = C.s2; g.strokeStyle = '#0d141c'; g.lineWidth = 2;
    g.beginPath(); g.arc(f.X(o.Vrews), f.Y(o.Pelec / 1e6), 5, 0, 7); g.fill(); g.stroke();
    // 标注关键风速
    g.font = FONT; g.fillStyle = C.text2; g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (const [v, t] of [[T.cutIn, '切入 3'], [T.ratedWind, '额定 11.4'], [T.cutOut, '切出 25']]) {
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(f.X(v), top); g.lineTo(f.X(v), top + h1); g.stroke(); g.setLineDash([]);
      g.fillText(t, f.X(v), top + 11);
    }
    this.legend([{ label: '稳态功率曲线（BEM + DISCON）', color: C.s3 }, { label: '贝兹极限×η', color: C.muted, dash: [4, 4] }, { label: '实时 60 s', color: C.s1 }], L + 8, top + h1 - 10);
    const f2 = this.frame(L, top + h1 + 24, this.W - L - Rr, h2, [0, 30], [0, 25], { ylabel: '稳态桨距角 °', xlabel: '叶轮等效风速 m/s', yt: [0, 10, 20] });
    this.line(f2, V, pc.pts.map((p) => (p.P > 0 ? p.pitch : NaN)), C.s4, 2);
    // 悬停
    if (this.hover && this.hover.x > L && this.hover.x < this.W - Rr && this.hover.y < top + h1 + 24 + h2) {
      const v = ((this.hover.x - L) / (this.W - L - Rr)) * 30;
      const p = pc.pts[Math.max(0, Math.min(pc.pts.length - 1, Math.round(v / 0.25)))];
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(f.X(p.V), top); g.lineTo(f.X(p.V), top + h1 + 24 + h2); g.stroke();
      this.showTip(`<b>V = ${p.V.toFixed(2)} m/s</b><br>电功率 ${(p.P / 1e6).toFixed(3)} MW<br>转速 ${p.rpm.toFixed(2)} rpm · λ ${p.lambda.toFixed(2)}<br>桨距 ${p.pitch.toFixed(2)}°<br>Cp ${p.Cp.toFixed(3)} · Ct ${p.Ct.toFixed(3)}<br>推力 ${(p.T / 1e3).toFixed(0)} kN · 控制区域 ${p.region}`, this.hover.x, this.hover.y);
      return true;
    }
    return false;
  }

  /* ---------------- 叶片展向分布 ---------------- */
  drawSpan(d) {
    if (!d) return false;
    const L = 44, Rr = 14, top = 18, gap = 30;
    const hh = (this.H - top - 20 - 2 * gap) / 3;
    const r = d.map((e) => e.r);
    const xr = [0, 63];
    // 1. 平面形状（弦长）与扭角 —— 分两个 y 轴不同量纲 → 用两个小图：弦长
    const f1 = this.frame(L, top, (this.W - L - Rr) / 2 - 20, hh, xr, [0, 5], { ylabel: '弦长 m（叶肩 4.65 m @ r=15.9）', xt: [0, 20, 40, 60] });
    this.line(f1, r, d.map((e) => e.chord), C.s1, 2);
    const f1b = this.frame(L + (this.W - L - Rr) / 2 + 24, top, (this.W - L - Rr) / 2 - 24, hh, xr, [0, 15], { ylabel: '气动扭角 °', xt: [0, 20, 40, 60] });
    this.line(f1b, r, d.map((e) => e.twist), C.s4, 2);
    // 2. 攻角（圆柱段无升力，不画攻角）
    const af = d.filter((e) => !e.af.startsWith('Cylinder'));
    const aLo = Math.max(-25, Math.min(-5, ...af.map((e) => e.alpha))), aHi = Math.min(40, Math.max(15, ...af.map((e) => e.alpha)));
    const f2 = this.frame(L, top + hh + gap, this.W - L - Rr, hh, xr, [aLo, aHi], { ylabel: '当前攻角 α °（绿带 = 最佳升阻比区 4–7°，>12° 失速，<0 为变桨卸载）', xt: [] });
    const g = this.ctx;
    g.fillStyle = 'rgba(12,163,12,0.14)';
    g.fillRect(f2.x, f2.Y(7), f2.w, f2.Y(4) - f2.Y(7));
    this.line(f2, af.map((e) => e.r), af.map((e) => e.alpha), C.s2, 2);
    for (const e of af) {
      g.fillStyle = e.alpha > 12 ? C.crit : C.s2;
      g.beginPath(); g.arc(f2.X(e.r), f2.Y(Math.min(Math.max(e.alpha, aLo), aHi)), 3.5, 0, 7); g.fill();
    }
    // 3. 单位长度载荷
    const fn = d.map((e) => e.dFn / 1e3), ft = d.map((e) => e.dFt / 1e3);
    const lo = Math.min(0, ...fn, ...ft), hi = Math.max(1, ...fn, ...ft);
    const f3 = this.frame(L, top + 2 * (hh + gap), this.W - L - Rr, hh, xr, [lo, hi * 1.1], { ylabel: '单位长度载荷 kN/m', xlabel: '展向位置 r (m)' });
    this.line(f3, r, fn, C.s1, 2);
    this.line(f3, r, ft, C.s3, 2);
    this.legend([{ label: '法向（推力方向）', color: C.s1 }, { label: '切向（产生扭矩）', color: C.s3 }], L + 150, top + 2 * (hh + gap) - 8);
    // 悬停：最近叶素
    if (this.hover && this.hover.x > L) {
      const rr = ((this.hover.x - L) / (this.W - L - Rr)) * 63;
      let e = d[0];
      for (const x of d) if (Math.abs(x.r - rr) < Math.abs(e.r - rr)) e = x;
      this.showTip(`<b>叶素 r = ${e.r.toFixed(2)} m</b> · ${e.af}<br>弦长 ${e.chord.toFixed(3)} m · 扭角 ${e.twist.toFixed(2)}°<br>入流角 φ ${e.phi.toFixed(2)}° · 攻角 α ${e.alpha.toFixed(2)}°<br>Cl ${e.cl.toFixed(3)} · Cd ${e.cd.toFixed(4)} · L/D ${(e.cl / e.cd).toFixed(0)}<br>轴向诱导 a ${e.a.toFixed(3)} · 切向 a' ${e.ap.toFixed(4)}<br>相对风速 ${e.Wabs.toFixed(1)} m/s<br>法向 ${(e.dFn / 1e3).toFixed(2)} · 切向 ${(e.dFt / 1e3).toFixed(2)} kN/m`, this.hover.x, this.hover.y);
      return true;
    }
    return false;
  }

  /* ---------------- Cp–λ 曲线族 ---------------- */
  drawCp(sim) {
    const L = 44, Rr = 70, top = 22;
    const f = this.frame(L, top, this.W - L - Rr, this.H - top - 34, [0, 16], [0, 0.6], {
      ylabel: '功率系数 Cp（BEM 计算）', xlabel: '叶尖速比 λ = ΩR/V', yt: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.593],
      yfmt: (v) => (v === 0.593 ? '0.593 贝兹' : v.toFixed(1)),
    });
    const betas = [0, 2, 5, 10, 15, 20];
    const lam = [];
    for (let l = 0.5; l <= 16; l += 0.1) lam.push(l);
    const g = this.ctx;
    g.strokeStyle = 'rgba(208,59,59,0.55)'; g.setLineDash([5, 4]); g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(f.x, f.Y(0.593)); g.lineTo(f.x + f.w, f.Y(0.593)); g.stroke(); g.setLineDash([]);
    betas.forEach((b, i) => {
      const cp = lam.map((l) => lookup(sim.tables, 'Cp', l, b));
      this.line(f, lam, cp.map((c) => (c > -0.02 ? c : NaN)), C.seq[i], 2);
      // 直接标注：曲线峰值处
      let k = 0; cp.forEach((c, j) => { if (c > cp[k]) k = j; });
      g.fillStyle = C.text2; g.font = FONT; g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText(`β=${b}°`, f.X(lam[k]) + 3, f.Y(cp[k]) - 2);
    });
    const o = sim.out;
    if (o.rotorRpm > 0.3) {
      const cpNow = lookup(sim.tables, 'Cp', Math.min(o.lambda, 18), o.pitchDeg);
      g.fillStyle = C.s2; g.strokeStyle = '#0d141c'; g.lineWidth = 2;
      g.beginPath(); g.arc(f.X(Math.min(o.lambda, 16)), f.Y(Math.max(0, cpNow)), 6, 0, 7); g.fill(); g.stroke();
      g.fillStyle = C.text; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(`当前 λ=${o.lambda.toFixed(2)} β=${o.pitchDeg.toFixed(1)}°`, f.X(Math.min(o.lambda, 16)) + 9, f.Y(Math.max(0, cpNow)));
    }
    g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'top';
    g.fillText('区域 2：转矩控制把工作点“钉”在 β=0 曲线峰值附近；区域 3：增大 β 沿曲线族向下弃风', f.x + f.w, top + 2);
    if (this.hover && this.hover.x > L && this.hover.x < this.W - Rr) {
      const l = ((this.hover.x - L) / (this.W - L - Rr)) * 16;
      this.showTip(`<b>λ = ${l.toFixed(2)}</b><br>${betas.map((b) => `β=${b}°：Cp ${lookup(sim.tables, 'Cp', l, b).toFixed(3)}`).join('<br>')}`, this.hover.x, this.hover.y);
      return true;
    }
    return false;
  }

  /* ---------------- 坎贝尔图 ---------------- */
  drawCampbell(sim) {
    const L = 44, Rr = 120, top = 22;
    const f = this.frame(L, top, this.W - L - Rr, this.H - top - 34, [0, 14], [0, 1.4], {
      ylabel: '频率 Hz', xlabel: '叶轮转速 rpm',
    });
    const g = this.ctx;
    // 运行转速范围
    g.fillStyle = 'rgba(57,135,229,0.10)';
    g.fillRect(f.X(6.9), f.y, f.X(12.1) - f.X(6.9), f.h);
    const rpm = [0, 14];
    const ex = [[1, '1P', C.s1], [3, '3P', C.s2], [6, '6P', C.s3]];
    for (const [k, n, c] of ex) {
      this.line(f, rpm, rpm.map((r) => (k * r) / 60), c, 2);
      const rEnd = Math.min(14, (1.35 * 60) / k);
      g.fillStyle = C.text2; g.font = FONT; g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText(n, f.X(rEnd) + 3, f.Y((k * rEnd) / 60) - 1);
    }
    // 结构固有频率 [J09 Table 9-1]
    const modes = [[0.324, '塔架一阶前后 0.324 Hz'], [0.312, '塔架一阶侧向 0.312 Hz'], [0.6993, '叶片一阶挥舞 0.70 Hz'], [1.0793, '叶片一阶摆振 1.08 Hz']];
    g.setLineDash([5, 4]);
    for (const [fq, n] of modes) {
      g.strokeStyle = 'rgba(232,238,244,0.55)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(f.x, f.Y(fq)); g.lineTo(f.x + f.w, f.Y(fq)); g.stroke();
      g.fillStyle = C.text2; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(n, f.x + f.w + 4, f.Y(fq) + (fq === 0.312 ? 6 : fq === 0.324 ? -6 : 0));
    }
    g.setLineDash([]);
    const r = sim.out.rotorRpm || 0;
    g.strokeStyle = C.s2; g.lineWidth = 2;
    g.beginPath(); g.moveTo(f.X(r), f.y); g.lineTo(f.X(r), f.y + f.h); g.stroke();
    g.fillStyle = C.text; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(`当前 ${r.toFixed(2)} rpm：1P ${(r / 60).toFixed(3)} Hz · 3P ${(r / 20).toFixed(3)} Hz`, f.x + 6, f.y + 4);
    g.fillStyle = C.muted;
    g.fillText('“软-硬”塔设计：塔架频率 0.32 Hz 位于 1P(≤0.20 Hz) 与 3P(≥0.35 Hz) 之间，避免共振', f.x + 6, f.y + 20);
    // 3P 穿越塔架频率的转速
    const rc = 0.324 * 20;
    g.fillStyle = C.warn;
    g.beginPath(); g.arc(f.X(rc), f.Y(0.324), 5, 0, 7); g.fill();
    g.fillText(`3P 与塔架共振 ${rc.toFixed(2)} rpm（< 最低运行转速 6.9 rpm）`, f.X(rc) + 8, f.Y(0.324) + 6);
    return false;
  }

  /* ---------------- 风电场尾流（俯视图） ---------------- */
  drawFarm(sim, farm) {
    if (!farm) return false;
    const g = this.ctx;
    const pad = 20, mapW = Math.min(this.W * 0.58, this.W - 260);
    const xs = farm.map((t) => t.x), zs = farm.map((t) => t.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + 500;
    const sc = Math.min(mapW - 2 * pad, this.H - 2 * pad) / (2 * ext);
    const ox = pad + (mapW - 2 * pad) / 2, oy = this.H / 2;
    const P = (x, z) => [ox + (x - cx) * sc, oy + (z - cz) * sc];
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(pad / 2, pad / 2, mapW - pad, this.H - pad);
    // 尾流锥
    const th = (sim.env.dirMean * Math.PI) / 180;
    const dx = -Math.sin(th), dz = Math.cos(th), nx = -dz, nz = dx;
    const R = NREL5MW.rotorRadius, k = 0.4 * Math.max(sim.Iref, 0.04) + 0.004;
    for (const t of farm) {
      const Lw = 2600;
      const r0 = R, r1 = R + k * Lw * 1.6;
      const a = P(t.x + nx * r0, t.z + nz * r0), b = P(t.x - nx * r0, t.z - nz * r0);
      const c = P(t.x + dx * Lw - nx * r1, t.z + dz * Lw - nz * r1), d = P(t.x + dx * Lw + nx * r1, t.z + dz * Lw + nz * r1);
      const grd = g.createLinearGradient(...P(t.x, t.z), ...P(t.x + dx * Lw, t.z + dz * Lw));
      const s = Math.min(1, t.ct);
      grd.addColorStop(0, `rgba(57,135,229,${0.45 * s})`);
      grd.addColorStop(1, 'rgba(57,135,229,0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(...c); g.lineTo(...d); g.closePath(); g.fill();
    }
    // 风机
    g.font = FONT;
    for (const t of farm) {
      const [px, py] = P(t.x, t.z);
      g.strokeStyle = t.main ? C.s2 : C.text; g.lineWidth = 3;
      g.beginPath(); g.moveTo(px + nx * R * sc, py + nz * R * sc); g.lineTo(px - nx * R * sc, py - nz * R * sc); g.stroke();
      g.fillStyle = C.text; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(`${t.name} ${(t.P / 1e6).toFixed(2)} MW`, px + 8, py - 9);
    }
    // 风向箭头
    const [ax, ay] = [pad + 30, pad + 30];
    g.strokeStyle = C.warn; g.lineWidth = 2;
    g.beginPath(); g.moveTo(ax - dx * 16, ay - dz * 16); g.lineTo(ax + dx * 16, ay + dz * 16); g.stroke();
    g.beginPath(); g.arc(ax + dx * 16, ay + dz * 16, 3, 0, 7); g.fillStyle = C.warn; g.fill();
    g.fillStyle = C.text2; g.textAlign = 'left'; g.fillText('风向', ax + 22, ay);
    g.fillText('N↑', pad, this.H - pad);
    // 右侧表格
    const tx = mapW + 10;
    let ty = 16;
    g.fillStyle = C.text; g.font = 'bold 12px "Microsoft YaHei", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('Jensen/Park 尾流模型（平方和叠加）', tx, ty); ty += 20;
    g.font = FONT;
    const hdr = ['机位', '入流 m/s', '亏损', '功率 MW'];
    const cols = [0, 50, 118, 170];
    g.fillStyle = C.muted;
    hdr.forEach((h, i) => g.fillText(h, tx + cols[i], ty)); ty += 16;
    let sum = 0, sumFree = 0;
    for (const t of farm) {
      g.fillStyle = t.main ? C.s2 : C.text2;
      [t.name, t.V.toFixed(2), `${(t.deficit * 100).toFixed(1)}%`, (t.P / 1e6).toFixed(2)].forEach((v, i) => g.fillText(v, tx + cols[i], ty));
      ty += 15;
      sum += t.P; sumFree += t.Pfree;
    }
    ty += 6;
    g.fillStyle = C.text;
    g.fillText(`全场 ${(sum / 1e6).toFixed(2)} MW / 无尾流 ${(sumFree / 1e6).toFixed(2)} MW`, tx, ty); ty += 16;
    g.fillStyle = sumFree > 0 && sum / sumFree < 0.9 ? C.warn : C.text2;
    g.fillText(`尾流损失 ${sumFree > 0 ? ((1 - sum / sumFree) * 100).toFixed(1) : '0.0'}%（改变风向可观察）`, tx, ty);
    ty += 18;
    g.fillStyle = C.muted;
    g.fillText('排内间距 4D = 504 m，排间 8D = 1008 m', tx, ty);
    return false;
  }
}

/**
 * generator.js — 发电机“电磁感应发电”原理可视化（2D Canvas）
 * ------------------------------------------------------------
 * 画面分三部分，全部由真实转速/功率驱动：
 *   1) 发电机剖面：中心旋转磁体（转子 N/S）+ 外圈定子线圈
 *      磁体转动 → 穿过线圈的磁通量变化 → 感应出电流（法拉第电磁感应）
 *   2) 输出回路：感应电流点流向灯泡，灯泡亮度 ∝ 功率
 *   3) 交流电波形：输出电压随时间呈正弦变化（频率 ∝ 转速，幅值 ∝ 功率）
 *
 * 物理要点：发电机本质是“反过来的电动机”——
 *   电动机：通电 → 磁场作用 → 转动（电能→机械能）
 *   发电机：转动 → 磁通变化 → 生电（机械能→电能）
 */
export class GeneratorViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.angle = 0;       // 转子角度（弧度），平滑累积
    this.wavePhase = 0;   // 波形相位
    this.wave = new Array(120).fill(0); // 滚动波形缓冲
    this.power = 0;       // 0~1 功率占比
    this.rpm = 0;
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 280;
    const h = this.canvas.clientHeight || 240;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  /** 每帧调用。dt 秒，rpm 转速，powerFrac 0~1 功率占额定比例 */
  update(dt, rpm, powerFrac) {
    this.rpm = rpm;
    this.power = powerFrac;
    // 发电机转子电频率 = 机械转速（演示用，真实有磁极对数与齿轮箱倍增）
    const omega = (rpm / 60) * 2 * Math.PI * 4; // ×4 让波形更明显
    this.angle += omega * dt;
    this.wavePhase += omega * dt;
    // 推进波形缓冲
    this.wave.push(Math.sin(this.wavePhase) * powerFrac);
    this.wave.shift();
    this._draw();
  }

  _draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // 布局：上方圆形发电机，右侧灯泡，下方波形
    const cx = w * 0.34, cy = h * 0.36, R = Math.min(w, h) * 0.28;
    const p = this.power;
    const glow = `rgba(70,214,160,${0.25 + 0.75 * p})`;

    /* ---- 定子外壳 ---- */
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(155,176,196,0.5)';
    ctx.beginPath(); ctx.arc(cx, cy, R + 14, 0, Math.PI * 2); ctx.stroke();

    /* ---- 定子线圈（6 个），通电发亮 ---- */
    const coils = 6;
    for (let i = 0; i < coils; i++) {
      const a = (i / coils) * Math.PI * 2;
      const x = cx + Math.cos(a) * (R + 6);
      const y = cy + Math.sin(a) * (R + 6);
      // 该线圈与转子磁极的相对相位决定其“被切割”强度
      const lit = Math.abs(Math.cos(this.angle - a)) * p;
      ctx.fillStyle = `rgba(74,168,255,${0.15 + 0.85 * lit})`;
      ctx.strokeStyle = 'rgba(74,168,255,0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    /* ---- 中心旋转磁体（转子 N 红 / S 蓝）---- */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    // N 极
    ctx.fillStyle = '#ff6b6b';
    ctx.fillRect(-R * 0.18, -R * 0.85, R * 0.36, R * 0.85);
    // S 极
    ctx.fillStyle = '#4aa8ff';
    ctx.fillRect(-R * 0.18, 0, R * 0.36, R * 0.85);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -R * 0.55);
    ctx.fillText('S', 0, R * 0.62);
    // 转轴
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* ---- 磁力线（旋转的虚线提示磁场切割）---- */
    ctx.strokeStyle = `rgba(255,211,74,${0.2 + 0.5 * p})`;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (let k = 0; k < 2; k++) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(this.angle + k * Math.PI / 2);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.9, R * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setLineDash([]);

    /* ---- 输出导线 + 流动电子 → 灯泡 ---- */
    const bx = w * 0.82, by = cy;
    ctx.strokeStyle = glow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + R + 14, cy);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // 流动电子（速度 ∝ 功率；交流，方向随波形符号翻转）
    const dir = Math.sign(this.wave[this.wave.length - 1]) || 1;
    const flowLen = bx - (cx + R + 14);
    const n = 6;
    for (let i = 0; i < n; i++) {
      let t = (i / n + (performance.now() / 1000) * (0.3 + p) * dir) % 1;
      if (t < 0) t += 1;
      const x = cx + R + 14 + t * flowLen;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.7 * p})`;
      ctx.beginPath(); ctx.arc(x, cy, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    /* ---- 灯泡（亮度 ∝ 功率）---- */
    const r = 13;
    const grd = ctx.createRadialGradient(bx, by, 1, bx, by, r * 2.5);
    grd.addColorStop(0, `rgba(255,236,150,${0.2 + 0.8 * p})`);
    grd.addColorStop(1, 'rgba(255,236,150,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(bx, by, r * 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,224,120,${0.3 + 0.7 * p})`;
    ctx.strokeStyle = 'rgba(255,224,120,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    /* ---- 底部交流电波形 ---- */
    const wy = h * 0.82, wh = h * 0.13;
    // 基线
    ctx.strokeStyle = 'rgba(155,176,196,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, wy); ctx.lineTo(w - 8, wy); ctx.stroke();
    // 波形
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const span = w - 16;
    for (let i = 0; i < this.wave.length; i++) {
      const x = 8 + (i / (this.wave.length - 1)) * span;
      const y = wy - this.wave[i] * wh;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 文案
    ctx.fillStyle = 'rgba(155,176,196,0.9)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('交流电压 (AC)', 8, wy - wh - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.rpm.toFixed(0)} rpm`, w - 8, wy - wh - 4);
  }
}

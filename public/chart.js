/**
 * 自选股看板 · K 线图组件（可复用）
 *
 * 单图、四宫格共用同一个组件。相对第一版的改进：
 *  - 坐标标注更醒目：右侧刻度带独立底色、字号加大、加粗、当前价做成高亮标签
 *  - 顶部显示均线图例与数值（同花顺那种 MA5 / MA10 … 带当前值）
 *  - 支持 日/周/月/季/年 周期（服务端由日线聚合，前端只需正确切窗口）
 *  - compact 模式：四宫格里用更小的字号与更少的刻度
 *
 * 用法：const c = new KlineChart(canvas, { compact, onHover }); c.setData({...})
 */
(function () {
  const UP = '#e5484d';
  const DOWN = '#26a269';

  // 完整视图（自选股/复盘/回测的大图）：5 条均线，含 A 股常用的 MA30
  const MA_STYLE_FULL = [
    { period: 5, color: '#e8b339' },
    { period: 10, color: '#4c8dff' },
    { period: 20, color: '#c678dd' },
    { period: 30, color: '#e06c9f' },
    { period: 60, color: '#4aa181' },
  ];
  // 四宫格 compact：小图上不画均线图例，5 条无标注的线会分不清谁是谁，故保持 4 条
  const MA_STYLE_COMPACT = MA_STYLE_FULL.filter((m) => m.period !== 30);

  const PERIOD_LABEL = { day: '日', week: '周', month: '月', quarter: '季', year: '年' };

  const n2 = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(2));

  function fmtVol(v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return String(n);
  }

  function fmtDate(ms, withYear) {
    const d = new Date(ms);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return withYear ? `${String(d.getFullYear()).slice(2)}/${mm}/${dd}` : `${mm}/${dd}`;
  }

  /** 简单移动平均；前 period-1 根为 null。 */
  function computeMA(items, period) {
    const out = new Array(items.length).fill(null);
    let sum = 0;
    for (let i = 0; i < items.length; i++) {
      sum += Number(items[i].close_price);
      if (i >= period) sum -= Number(items[i - period].close_price);
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  class KlineChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;                    // _notifyView 需要它来取 onViewChange
      this.compact = Boolean(opts.compact);
      this.onHover = opts.onHover || null;
      this.items = [];
      this.displayStartMs = 0;
      this.markers = [];
      this.period = 'day';
      this.hoverIndex = null;
      this._geomCache = null;
      // 独立缩放：每张图各自维护，互不影响
      this.zoomCount = null;   // 显示多少根；null = 用默认窗口
      this.zoomStart = null;   // 窗口在 base 中的起始下标；null = 右对齐到最新

      canvas.addEventListener('mousemove', (e) => this._onMove(e));
      canvas.addEventListener('mouseleave', () => this._onLeave());
      // passive:false 才能 preventDefault，避免滚轮顺带滚动页面
      canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      canvas.addEventListener('dblclick', () => this.resetZoom());
    }

    /** 显示窗口（按 displayStartMs 切好）在完整序列中的起点下标 */
    _baseStart() {
      if (!this.displayStartMs) return 0;
      const i = this.items.findIndex((it) => it.date_ms >= this.displayStartMs);
      return i < 0 ? 0 : i;
    }

    /** 当前可见根数（供外部显示） */
    visibleCount() {
      const g = this._geomCache;
      return g ? g.n : 0;
    }

    /** 当前可见的 bar 数组（供外部显示统计） */
    visibleBars() {
      return this._geomCache ? this._geomCache.view : [];
    }

    /** 恢复为默认窗口（双击画布） */
    resetZoom() {
      if (this.zoomCount === null && this.zoomStart === null) return;
      this.zoomCount = null;
      this.zoomStart = null;
      this.draw();
      this._notifyView();
    }

    _notifyView() {
      if (this.opts && this.opts.onViewChange) this.opts.onViewChange(this.visibleCount());
    }

    /**
     * 滚轮缩放：以光标所在的那根为锚点，保证缩放时光标下的 K 线不动。
     * 只影响本图，不动其它图，也不改周期。
     */
    _onWheel(e) {
      const g = this._geomCache;
      if (!g || !g.baseLength) return;
      e.preventDefault();

      const total = g.baseLength;
      const curCount = this.zoomCount === null ? total : Math.min(this.zoomCount, total);
      const curStart = this.zoomStart === null ? total - curCount : this.zoomStart;

      // 光标在绘图区内的相对位置（0=最左，1=最右）
      const rect = this.canvas.getBoundingClientRect();
      const plotW = rect.width - g.padL - g.padR;
      let rel = plotW > 0 ? (e.clientX - rect.left - g.padL) / plotW : 1;
      rel = rel < 0 ? 0 : rel > 1 ? 1 : rel;

      const focus = curStart + rel * curCount;              // 光标下的（小数）下标
      const factor = e.deltaY < 0 ? 1 / 1.2 : 1.2;          // 上滚放大、下滚缩小
      const MIN_BARS = 8;
      let next = Math.round(curCount * factor);
      next = Math.max(MIN_BARS, Math.min(total, next));
      if (next === curCount) return;

      let nextStart = Math.round(focus - rel * next);
      nextStart = Math.max(0, Math.min(total - next, nextStart));

      this.zoomCount = next;
      this.zoomStart = nextStart;
      this.hoverIndex = null;
      this.draw();
      this._notifyView();
    }

    setData({ items, displayStartMs, markers, period } = {}) {
      this.items = items || [];
      this.displayStartMs = displayStartMs || 0;
      this.markers = markers || [];
      if (period) this.period = period;
      this.hoverIndex = null;
      this._geomCache = null;
      // 缩放的“级别”（显示多少根）作为该图的查看偏好保留；起始位置重置为右对齐最新
      this.zoomStart = null;
      this.draw();
      this._notifyView();
    }

    setMarkers(markers) {
      this.markers = markers || [];
      this.draw();
    }

    clear() {
      this.items = [];
      this._geomCache = null;
      this.draw();
    }

    _onMove(e) {
      const g = this._geomCache;
      if (!g || !g.n) return;
      const rect = this.canvas.getBoundingClientRect();
      const raw = Math.floor((e.clientX - rect.left - g.padL) / g.step);
      const i = raw < 0 ? 0 : raw >= g.n ? g.n - 1 : raw;
      if (this.hoverIndex === i) return;
      this.hoverIndex = i;
      this.draw();
      if (this.onHover) this.onHover(this.infoAt(i));
    }

    _onLeave() {
      if (this.hoverIndex === null) return;
      this.hoverIndex = null;
      this.draw();
      if (this.onHover) this.onHover(null);
    }

    /** 某根 bar 的摘要信息（供外部显示）。 */
    infoAt(i) {
      const g = this._geomCache;
      if (!g || i === null || i === undefined || !g.view[i]) return null;
      const bar = g.view[i];
      const o = Number(bar.open_price);
      const c = Number(bar.close_price);
      return {
        index: i,
        date_ms: bar.date_ms,
        date: fmtDate(bar.date_ms, true),
        open: o,
        high: Number(bar.high_price),
        low: Number(bar.low_price),
        close: c,
        pct: o ? ((c - o) / o) * 100 : null,
        volume: Number(bar.volume) || 0,
        turnover: Number(bar.turnover) || 0,
        ma: g.maView.map((m) => ({ period: m.period, color: m.color, value: m.values[i] })),
      };
    }

    draw() {
      const canvas = this.canvas;
      const wrap = canvas.parentElement;
      const ctx = this.ctx;
      const W = Math.max(1, wrap.clientWidth);
      const H = Math.max(1, wrap.clientHeight);
      // 折叠或隐藏时不绘制 —— 否则会按 1×1 的尺寸画出一团乱码
      if (W < 40 || H < 40) {
        this._geomCache = null;
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const full = this.items;
      if (full.length < 2) {
        this._geomCache = null;
        return;
      }

      // 均线在**完整序列**上计算（含预热段），再按显示窗口切片 —— 这样窗口左端均线也准确
      const maStyle = this.compact ? MA_STYLE_COMPACT : MA_STYLE_FULL;
      const mas = maStyle.map((s) => ({ ...s, values: computeMA(full, s.period) }));

      const i0 = this._baseStart();
      const baseLength = full.length - i0;
      if (baseLength < 2) { this._geomCache = null; return; }

      // 独立缩放：本图显示多少根、从哪根开始（其它图不受影响）
      const count = Math.max(2, Math.min(this.zoomCount ?? baseLength, baseLength));
      const offset = this.zoomStart === null
        ? baseLength - count
        : Math.max(0, Math.min(baseLength - count, this.zoomStart));

      const view = full.slice(i0 + offset, i0 + offset + count);
      const maView = mas.map((m) => ({ ...m, values: m.values.slice(i0 + offset, i0 + offset + count) }));
      const n = view.length;
      if (n < 2) { this._geomCache = null; return; }

      // ---- 价格范围（含均线，避免均线跑出画面）
      let lo = Infinity;
      let hi = -Infinity;
      for (const it of view) {
        lo = Math.min(lo, Number(it.low_price));
        hi = Math.max(hi, Number(it.high_price));
      }
      for (const m of maView) {
        for (const v of m.values) {
          if (v === null) continue;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { this._geomCache = null; return; }
      const pad = (hi - lo) * 0.06 || 1;
      lo -= pad;
      hi += pad;

      // ---- 布局
      const compact = this.compact;
      const padL = 6;
      const padR = compact ? 56 : 74;
      const padT = compact ? 8 : 26;          // 顶部留出均线图例的位置
      const padB = compact ? 16 : 22;
      const gap = compact ? 6 : 10;
      const usableH = H - padT - padB;
      const volH = Math.max(compact ? 18 : 34, usableH * (compact ? 0.2 : 0.22));
      const priceH = usableH - volH - gap;
      const priceTop = padT;
      const priceBot = padT + priceH;
      const volTop = priceBot + gap;
      const volBot = volTop + volH;

      const step = (W - padL - padR) / n;
      const x = (i) => padL + (i + 0.5) * step;
      const yP = (p) => priceBot - ((p - lo) / (hi - lo)) * priceH;

      let maxVol = 0;
      for (const it of view) maxVol = Math.max(maxVol, Number(it.volume) || 0);
      const yV = (v) => volBot - (maxVol ? (v / maxVol) * volH : 0);

      this._geomCache = { view, maView, n, step, padL, padR, baseLength, priceTop, priceBot, volTop, volBot, lo, hi, x, yP };

      // ---- 右侧刻度带底色（让标注跳出来）
      ctx.fillStyle = '#0f1621';
      ctx.fillRect(W - padR, 0, padR, H);
      ctx.strokeStyle = '#2a3646';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W - padR + 0.5, 0);
      ctx.lineTo(W - padR + 0.5, H);
      ctx.stroke();

      // ---- 价格网格与刻度
      const ticks = compact ? 3 : 5;
      ctx.font = `${compact ? 10 : 12}px Consolas, "Microsoft YaHei", monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let t = 0; t <= ticks; t++) {
        const p = lo + ((hi - lo) * t) / ticks;
        const y = Math.round(yP(p)) + 0.5;
        ctx.strokeStyle = t === 0 || t === ticks ? 'rgba(42,54,70,0.9)' : 'rgba(35,47,63,0.6)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
        // 刻度短线 + 高对比数字
        ctx.strokeStyle = '#3d4c60';
        ctx.beginPath();
        ctx.moveTo(W - padR, y);
        ctx.lineTo(W - padR + 5, y);
        ctx.stroke();
        ctx.fillStyle = '#dbe4ef';
        ctx.fillText(p.toFixed(2), W - padR + 9, y);
      }

      // 成交量区上下边界
      ctx.strokeStyle = 'rgba(42,54,70,0.9)';
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(volTop) + 0.5);
      ctx.lineTo(W - padR, Math.round(volTop) + 0.5);
      ctx.stroke();

      // ---- 蜡烛 + 成交量
      const bodyW = Math.max(1, Math.min(step * 0.72, compact ? 9 : 14));
      for (let i = 0; i < n; i++) {
        const it = view[i];
        const o = Number(it.open_price);
        const c = Number(it.close_price);
        const h = Number(it.high_price);
        const l = Number(it.low_price);
        const up = c >= o;
        const color = up ? UP : DOWN;
        const cx = x(i);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, yP(h));
        ctx.lineTo(cx + 0.5, yP(l));
        ctx.stroke();

        const yO = yP(o);
        const yC = yP(c);
        const top = Math.min(yO, yC);
        const hgt = Math.max(1, Math.abs(yC - yO));
        ctx.fillStyle = color;
        ctx.fillRect(cx - bodyW / 2, top, bodyW, hgt);

        const v = Number(it.volume) || 0;
        ctx.fillStyle = up ? 'rgba(229,72,77,0.6)' : 'rgba(38,162,105,0.6)';
        ctx.fillRect(cx - bodyW / 2, yV(v), bodyW, volBot - yV(v));
      }

      // ---- 均线
      for (const m of maView) {
        ctx.strokeStyle = m.color;
        ctx.lineWidth = this.compact ? 1 : 1.3;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = m.values[i];
          if (v === null) { started = false; continue; }
          const px = x(i);
          const py = yP(v);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // ---- 回测买卖点
      if (this.markers.length) {
        const byDate = new Map();
        for (let i = 0; i < n; i++) byDate.set(view[i].date_ms, i);
        for (const t of this.markers) {
          const i = byDate.get(t.date_ms);
          if (i === undefined) continue;
          const bar = view[i];
          const cx = x(i);
          if (t.side === 'buy') this._triangle(cx, yP(Number(bar.low_price)) + 8, 'up', UP);
          else this._triangle(cx, yP(Number(bar.high_price)) - 8, 'down', DOWN);
        }
      }

      // ---- 日期刻度
      const withYear = this.period !== 'day';
      ctx.fillStyle = '#a9b6c7';
      ctx.font = `${compact ? 10 : 12}px Consolas, "Microsoft YaHei", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const dateTicks = compact ? 3 : 8;
      for (let t = 0; t < dateTicks; t++) {
        const i = Math.round((t * (n - 1)) / Math.max(1, dateTicks - 1));
        ctx.fillText(fmtDate(view[i].date_ms, withYear && !compact), x(i), H - padB + 4);
      }

      // ---- 顶部均线图例（带当前值；悬停时显示悬停那根的）
      if (!compact) {
        const li = this.hoverIndex !== null && this.hoverIndex < n ? this.hoverIndex : n - 1;
        let lx = padL + 2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Consolas, "Microsoft YaHei", monospace';
        for (const m of maView) {
          const label = `MA${m.period} ${n2(m.values[li])}`;
          ctx.fillStyle = m.color;
          ctx.fillText(label, lx, 12);
          lx += ctx.measureText(label).width + 12;
        }
        const lastBar = view[li];
        const chg = Number(lastBar.open_price) ? Number(lastBar.close_price) - Number(lastBar.open_price) : 0;
        ctx.fillStyle = chg >= 0 ? UP : DOWN;
        ctx.textAlign = 'right';
        ctx.fillText(
          `${fmtDate(lastBar.date_ms, true)}  开${n2(lastBar.open_price)} 高${n2(lastBar.high_price)} 低${n2(lastBar.low_price)} 收${n2(lastBar.close_price)} 量${fmtVol(lastBar.volume)}`,
          W - padR - 6, 12,
        );
      }

      // ---- 当前价高亮标签（贴在右轴，和同花顺一样醒目）
      const tagIdx = this.hoverIndex !== null && this.hoverIndex < n ? this.hoverIndex : n - 1;
      const tagBar = view[tagIdx];
      const tagUp = Number(tagBar.close_price) >= Number(tagBar.open_price);
      const tagY = Math.max(priceTop + 7, Math.min(priceBot - 7, yP(Number(tagBar.close_price))));
      const tagText = n2(tagBar.close_price);
      ctx.font = `${compact ? 10 : 12}px Consolas, "Microsoft YaHei", monospace`;
      const tagW = ctx.measureText(tagText).width + 12;
      ctx.fillStyle = tagUp ? UP : DOWN;
      ctx.fillRect(W - padR + 1, tagY - 9, Math.max(tagW, padR - 2), 18);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, W - padR + 7, tagY);

      // ---- 十字光标
      if (this.hoverIndex !== null && this.hoverIndex < n) {
        const i = this.hoverIndex;
        const cx = x(i);
        ctx.save();
        ctx.strokeStyle = 'rgba(215,222,232,0.5)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, priceTop);
        ctx.lineTo(cx + 0.5, volBot);
        ctx.stroke();
        const cy = yP(Number(view[i].close_price));
        ctx.beginPath();
        ctx.moveTo(padL, cy + 0.5);
        ctx.lineTo(W - padR, cy + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    _triangle(cx, cy, dir, color) {
      const ctx = this.ctx;
      const s = this.compact ? 4 : 5;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(cx, cy - s);
        ctx.lineTo(cx - s, cy + s);
        ctx.lineTo(cx + s, cy + s);
      } else {
        ctx.moveTo(cx, cy + s);
        ctx.lineTo(cx - s, cy - s);
        ctx.lineTo(cx + s, cy - s);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  window.KlineChart = KlineChart;
  window.KLINE_MA_STYLE = MA_STYLE_FULL;
  window.KLINE_MA_STYLE_COMPACT = MA_STYLE_COMPACT;
  window.KLINE_PERIOD_LABEL = PERIOD_LABEL;
  window.KLINE_FMT = { n2, fmtVol, fmtDate };
})();

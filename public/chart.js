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

  /** 把 epoch 秒按上海时区（UTC+8）格式化成 HH:MM */
  function hhmm(sec) {
    const d = new Date((sec + 8 * 3600) * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }

  /** 毫秒时间戳 → 盘中第几分钟（与服务端 sessionMinuteOf 同口径，分时画笔定位要用） */
  function sessionMinuteFromMs(ms) {
    const d = new Date(ms + 8 * 3600 * 1000);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m < 9 * 60 + 30) return 0;
    if (m <= 11 * 60 + 30) return m - (9 * 60 + 30);
    if (m < 13 * 60) return 120;
    return 120 + Math.min(120, m - 13 * 60);
  }

  /** 点到线段的最短距离（橡皮擦命中判定） */
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** 自由曲线抽稀：等间隔取点并保留首尾 */
  function downsample(points, max) {
    if (points.length <= max) return points;
    const out = [];
    const stepF = (points.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) out.push(points[Math.round(i * stepF)]);
    return out;
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
      // 分时模式：数据是服务端自己按时采样的（上游没有 A 股分钟线）
      this.mode = 'kline';     // 'kline' | 'intraday'
      this.intraday = null;
      // 画笔（纯前端内存，不落盘：按需求不做持久化）
      this.annotations = [];
      this.drawTool = null;    // null | 'line' | 'arrow' | 'free' | 'rect' | 'erase'
      this.drawColor = '#e8b339';
      this.drawWidth = 2;
      this._draft = null;      // 正在画的那条
      this._drawing = false;

      canvas.addEventListener('mousemove', (e) => this._onMove(e));
      canvas.addEventListener('mouseleave', () => this._onLeave());
      canvas.addEventListener('mousedown', (e) => this._onDown(e));
      canvas.addEventListener('mouseup', (e) => this._onUp(e));
      // passive:false 才能 preventDefault，避免滚轮顺带滚动页面
      canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      canvas.addEventListener('dblclick', () => { if (!this.drawTool) this.resetZoom(); });
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

    /**
     * 切到分时模式。数据形如
     *   { t:[秒], p:[价], v:[累计量], avg:[均价], m:[盘中第几分钟], prevClose, date }
     * 分时不支持缩放（横轴固定铺满一个交易日，和行情软件一致）。
     */
    setIntraday(d) {
      this.mode = 'intraday';
      this.intraday = d && d.t && d.t.length ? d : null;
      this.hoverIndex = null;
      this._geomCache = null;
      this.draw();
      this._notifyView();
    }

    /** 当前是否分时模式且有数据 */
    get isIntraday() {
      return this.mode === 'intraday' && Boolean(this.intraday);
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
      if (this.drawTool) return; // 画笔开启时不缩放：免得画到一半图自己动了
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
      this.mode = 'kline';       // 从分时切回 K 线时必须复位，否则会继续按分时渲染
      this.intraday = null;
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
      const { x: mx, y: my } = this._localXY(e);

      // 正在画：把当前点并进草稿，此时不更新悬停信息
      if (this._drawing && this._draft) {
        const pt = { date_ms: this._dateAtX(mx), price: this._priceAtY(my) };
        if (Number.isFinite(pt.date_ms) && Number.isFinite(pt.price) && pt.price > 0) {
          const d = this._draft;
          if (d.tool === 'free') {
            const prev = d.points[d.points.length - 1];
            const px = this._xOfDate(prev.date_ms);
            const py = this._yOfPrice(prev.price);
            const cx = this._xOfDate(pt.date_ms);
            const cy = this._yOfPrice(pt.price);
            // 按**像素**距离抽点：只比时间会把垂直方向的笔画整个丢掉
            if (Number.isFinite(px) && Math.hypot(cx - px, cy - py) >= 2 && d.points.length < 600) {
              d.points.push(pt);
            }
          } else {
            d.points[d.points.length - 1] = pt;
          }
          this.draw();
        }
        return;
      }

      let i;
      if (g.intraday) {
        // 分时的点按时间摆放、间距不等，必须找最近的点而不是按等距下标算
        i = 0;
        let best = Infinity;
        for (let k = 0; k < g.xs.length; k++) {
          const dist = Math.abs(g.xs[k] - mx);
          if (dist < best) { best = dist; i = k; }
        }
      } else {
        const raw = Math.floor((mx - g.padL) / g.step);
        i = raw < 0 ? 0 : raw >= g.n ? g.n - 1 : raw;
      }
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

    /** 把 epoch 秒按上海时区（UTC+8）格式化成 HH:MM */
    _hhmm(sec) {
      return hhmm(sec);
    }

    /** 某个点的摘要信息（供外部显示）。分时与 K 线返回不同形状。 */
    infoAt(i) {
      const g = this._geomCache;
      if (!g || i === null || i === undefined) return null;

      if (g.intraday) {
        const d = this.intraday;
        if (!d || d.t[i] === undefined) return null;
        const pc = Number(d.prevClose) || Number(d.p[0]);
        const price = Number(d.p[i]);
        const avg = d.avg?.[i] ?? null;
        return {
          intraday: true,
          index: i,
          time: this._hhmm(d.t[i]),
          minute: d.m?.[i] ?? 0,
          price,
          avg,
          prevClose: pc,
          dev: pc ? ((price - pc) / pc) * 100 : null,
          avgDev: avg != null && pc ? ((avg - pc) / pc) * 100 : null,
          volume: d.v?.[i] ?? 0,
          turnover: d.to?.[i] ?? 0,
        };
      }

      if (!g.view || !g.view[i]) return null;
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

    /**
     * 分时渲染：横轴固定铺满一个交易日（0~240 分钟，中午休市不占宽度），
     * 纵轴按**昨收的百分比**对称展开（0% 居中），画价格线 + 均价线 + 成交量柱，
     * 与行情软件的分时图口径一致。
     */
    _drawIntraday(W, H) {
      const canvas = this.canvas;
      const ctx = this.ctx;
      const d = this.intraday;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (!d || !d.p || !d.p.length) {
        this._geomCache = null;
        return;
      }

      const compact = this.compact;
      const n = d.p.length;
      const pc = Number(d.prevClose) || Number(d.p[0]);
      const devOf = (x) => (x == null || !pc ? null : ((Number(x) - pc) / pc) * 100);

      // 纵轴范围：至少 ±0.2%（避免一条直线顶满屏），再留 10% 余量并取整到 0.1
      let maxAbs = 0.2;
      for (let i = 0; i < n; i++) {
        const a = devOf(d.p[i]);
        if (a != null) maxAbs = Math.max(maxAbs, Math.abs(a));
        const b = devOf(d.avg?.[i]);
        if (b != null) maxAbs = Math.max(maxAbs, Math.abs(b));
      }
      maxAbs = Math.ceil(maxAbs * 1.1 * 10) / 10;

      const padL = 6;
      const padR = compact ? 60 : 80;
      const padT = compact ? 8 : 24;
      const padB = compact ? 16 : 22;
      const gap = compact ? 6 : 10;
      const usableH = H - padT - padB;
      const volH = Math.max(compact ? 18 : 34, usableH * (compact ? 0.2 : 0.22));
      const priceH = usableH - volH - gap;
      const priceTop = padT;
      const priceBot = padT + priceH;
      const volTop = priceBot + gap;
      const volBot = volTop + volH;

      const xOf = (m) => padL + (Math.max(0, Math.min(240, m)) / 240) * (W - padL - padR);
      const yOf = (dev) => priceBot - ((dev + maxAbs) / (2 * maxAbs)) * priceH;

      const xs = new Array(n);
      for (let i = 0; i < n; i++) {
        const m = d.m?.[i];
        xs[i] = xOf(m === undefined ? (n === 1 ? 240 : (i / (n - 1)) * 240) : m);
      }
      this._geomCache = { intraday: true, n, xs, padL, padR, priceTop, priceBot, volTop, volBot, pc, maxAbs };

      // ---- 右轴底色
      ctx.fillStyle = '#0f1621';
      ctx.fillRect(W - padR, 0, padR, H);
      ctx.strokeStyle = '#2a3646';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W - padR + 0.5, 0);
      ctx.lineTo(W - padR + 0.5, H);
      ctx.stroke();

      // ---- 网格 + 双刻度（上行百分比、下行对应价格）
      const steps = compact ? 3 : 4;
      ctx.font = `${compact ? 10 : 12}px Consolas, "Microsoft YaHei", monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let k = -steps; k <= steps; k++) {
        const dev = (maxAbs * k) / steps;
        const y = Math.round(yOf(dev)) + 0.5;
        const zero = k === 0;
        ctx.strokeStyle = zero ? 'rgba(133,149,168,0.5)' : 'rgba(35,47,63,0.6)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
        ctx.strokeStyle = '#3d4c60';
        ctx.beginPath();
        ctx.moveTo(W - padR, y);
        ctx.lineTo(W - padR + 5, y);
        ctx.stroke();
        ctx.fillStyle = dev > 0 ? UP : dev < 0 ? DOWN : '#8595a8';
        ctx.fillText(`${dev > 0 ? '+' : ''}${dev.toFixed(2)}%`, W - padR + 9, y - (compact ? 5 : 6));
        ctx.fillStyle = '#dbe4ef';
        ctx.fillText((pc * (1 + dev / 100)).toFixed(2), W - padR + 9, y + (compact ? 6 : 7));
      }
      // 成交量区分隔
      ctx.strokeStyle = 'rgba(42,54,70,0.9)';
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(volTop) + 0.5);
      ctx.lineTo(W - padR, Math.round(volTop) + 0.5);
      ctx.stroke();

      // ---- 成交量柱（按与上一个采样点的涨跌着色）
      let maxVol = 0;
      for (let i = 0; i < n; i++) maxVol = Math.max(maxVol, Number(d.v?.[i]) || 0);
      const barW = Math.max(1, Math.min((W - padL - padR) / 240, compact ? 3 : 4));
      for (let i = 0; i < n; i++) {
        const v = Number(d.v?.[i]) || 0;
        if (!v || !maxVol) continue;
        const h = (v / maxVol) * volH;
        const rising = i === 0 ? true : Number(d.p[i]) >= Number(d.p[i - 1]);
        ctx.fillStyle = rising ? 'rgba(229,72,77,0.65)' : 'rgba(38,162,105,0.65)';
        ctx.fillRect(xs[i] - barW / 2, volBot - h, barW, h);
      }

      // ---- 均价线（先画，压在价格线下面）
      if (d.avg) {
        ctx.strokeStyle = '#e8b339';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const dev = devOf(d.avg[i]);
          if (dev == null) { started = false; continue; }
          const px = xs[i];
          const py = yOf(dev);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // ---- 价格线
      ctx.strokeStyle = '#d7dee8';
      ctx.lineWidth = compact ? 1 : 1.4;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const dev = devOf(d.p[i]);
        if (dev == null) continue;
        const px = xs[i];
        const py = yOf(dev);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // ---- 横轴时间刻度
      ctx.fillStyle = '#a9b6c7';
      ctx.font = `${compact ? 10 : 12}px Consolas, "Microsoft YaHei", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const marks = compact
        ? [[0, '9:30'], [120, '11:30/13:00'], [240, '15:00']]
        : [[0, '9:30'], [60, '10:30'], [120, '11:30 / 13:00'], [180, '14:00'], [240, '15:00']];
      for (const [m, label] of marks) {
        const px = xOf(m);
        if (px < padL + 12 || px > W - padR - 12) continue;
        ctx.fillText(label, px, H - padB + 4);
      }

      // ---- 顶部图例
      if (!compact) {
        const li = this.hoverIndex !== null && this.hoverIndex < n ? this.hoverIndex : n - 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Consolas, "Microsoft YaHei", monospace';
        const dev = devOf(d.p[li]);
        const adev = devOf(d.avg?.[li]);
        let lx = padL + 2;
        ctx.fillStyle = '#8595a8';
        const head = `分时 ${d.date ?? ''}  昨收 ${pc.toFixed(2)}`;
        ctx.fillText(head, lx, 12);
        lx += ctx.measureText(head).width + 14;
        ctx.fillStyle = dev != null && dev >= 0 ? UP : DOWN;
        const t1 = `${this._hhmm(d.t[li])} ${Number(d.p[li]).toFixed(2)} ${dev > 0 ? '+' : ''}${dev.toFixed(2)}%`;
        ctx.fillText(t1, lx, 12);
        lx += ctx.measureText(t1).width + 14;
        if (adev != null) {
          ctx.fillStyle = '#e8b339';
          ctx.fillText(`均价 ${Number(d.avg[li]).toFixed(2)} ${adev > 0 ? '+' : ''}${adev.toFixed(2)}%`, lx, 12);
        }
      }

      // ---- 画笔画记（画在图形之上、十字光标之下）
      this._renderAnnotations(ctx);

      // ---- 十字光标
      if (this.hoverIndex !== null && this.hoverIndex < n) {
        const i = this.hoverIndex;
        const dev = devOf(d.p[i]);
        const cx = xs[i];
        const cy = dev == null ? priceBot : yOf(dev);
        ctx.save();
        ctx.strokeStyle = 'rgba(215,222,232,0.5)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, priceTop);
        ctx.lineTo(cx + 0.5, volBot);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(padL, cy + 0.5);
        ctx.lineTo(W - padR, cy + 0.5);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#d7dee8';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---------------------------------------------------------------- 画笔
    // 设计要点：画记存的是**数据坐标**（date_ms + price），不是像素坐标。
    // 否则一缩放、换周期、改窗口大小，画的东西就全错位了。
    // 纯前端内存，不落盘（按需求不做持久化）。

    /** 换股票时把该股的画记交给图（由外部按股票暂存） */
    setAnnotations(list) {
      this.annotations = Array.isArray(list) ? list : [];
      this._draft = null;
      this._drawing = false;
      this.draw();
    }

    /** 切换画笔工具；传 null 关闭画笔 */
    setDrawTool(tool) {
      this.drawTool = tool || null;
      this._draft = null;
      this._drawing = false;
      this.canvas.style.cursor = this.drawTool ? 'crosshair' : '';
      this.draw();
    }

    setDrawStyle({ color, width } = {}) {
      if (color) this.drawColor = color;
      if (width) this.drawWidth = width;
    }

    /** 日期 → 屏幕 x（K 线在相邻两根之间按时间插值；分时取最近采样点） */
    _xOfDate(ms) {
      const g = this._geomCache;
      if (!g) return NaN;
      const w = this.canvas.parentElement.clientWidth;

      if (g.intraday) {
        const d = this.intraday;
        if (!d?.t?.length || !g.xs) return NaN;
        const sec = ms / 1000;
        let bi = 0;
        let bd = Infinity;
        for (let i = 0; i < d.t.length; i++) {
          const dd = Math.abs(d.t[i] - sec);
          if (dd < bd) { bd = dd; bi = i; }
        }
        return g.xs[bi];
      }

      const view = g.view;
      if (!view?.length) return NaN;
      const xOf = (i) => g.padL + (i + 0.5) * g.step;
      if (ms <= view[0].date_ms) return xOf(0);
      const last = view.length - 1;
      if (ms >= view[last].date_ms) return xOf(last);
      let lo = 0;
      let hi = last;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (view[mid].date_ms <= ms) lo = mid; else hi = mid;
      }
      const t0 = view[lo].date_ms;
      const t1 = view[hi].date_ms;
      const f = t1 > t0 ? (ms - t0) / (t1 - t0) : 0;
      return xOf(lo) + (xOf(hi) - xOf(lo)) * f;
    }

    /** 屏幕 x → 日期（吸附到最近的 bar / 采样点） */
    _dateAtX(x) {
      const g = this._geomCache;
      if (!g) return NaN;
      if (g.intraday) {
        const d = this.intraday;
        if (!d?.t?.length || !g.xs) return NaN;
        let bi = 0;
        let bd = Infinity;
        for (let i = 0; i < g.xs.length; i++) {
          const dd = Math.abs(g.xs[i] - x);
          if (dd < bd) { bd = dd; bi = i; }
        }
        return d.t[bi] * 1000;
      }
      if (!g.view?.length) return NaN;
      const raw = Math.round((x - g.padL) / g.step - 0.5);
      const i = Math.max(0, Math.min(g.n - 1, raw));
      return g.view[i].date_ms;
    }

    /** 价格 → 屏幕 y */
    _yOfPrice(p) {
      const g = this._geomCache;
      if (!g) return NaN;
      const h = g.priceBot - g.priceTop;
      if (!h) return NaN;
      if (g.intraday) {
        const pc = g.pc || 0;
        if (!pc || !g.maxAbs) return NaN;
        const dev = ((p - pc) / pc) * 100;
        return g.priceBot - ((dev + g.maxAbs) / (2 * g.maxAbs)) * h;
      }
      return g.priceBot - ((p - g.lo) / (g.hi - g.lo)) * h;
    }

    /** 屏幕 y → 价格 */
    _priceAtY(y) {
      const g = this._geomCache;
      if (!g) return NaN;
      const h = g.priceBot - g.priceTop;
      if (!h) return NaN;
      if (g.intraday) {
        const pc = g.pc || 0;
        if (!pc || !g.maxAbs) return NaN;
        const dev = ((g.priceBot - y) / h) * 2 * g.maxAbs - g.maxAbs;
        return pc * (1 + dev / 100);
      }
      return g.lo + ((g.priceBot - y) / h) * (g.hi - g.lo);
    }

    /** 一条画记的屏幕坐标（超范围的点会被 canvas 裁剪掉） */
    _annotationPts(a) {
      const out = [];
      for (const p of a.points ?? []) {
        const x = this._xOfDate(p.date_ms);
        const y = this._yOfPrice(p.price);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
      }
      return out;
    }

    /** 把画记（含正在画的草稿）画到画布上 */
    _renderAnnotations(ctx) {
      const list = this._draft ? [...this.annotations, this._draft] : this.annotations;
      if (!list.length) return;
      const wrap = this.canvas.parentElement;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, wrap.clientWidth, wrap.clientHeight);
      ctx.clip();
      for (const a of list) {
        const pts = this._annotationPts(a);
        if (pts.length < 2) continue;
        const color = a.color || '#e8b339';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = a.width || 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        if (a.tool === 'rect') {
          const p0 = pts[0];
          const p1 = pts[pts.length - 1];
          ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
        } else if (a.tool === 'arrow') {
          const p0 = pts[0];
          const p1 = pts[pts.length - 1];
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          const head = Math.max(8, (a.width || 2) * 4);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p1.x - head * Math.cos(ang - Math.PI / 7), p1.y - head * Math.sin(ang - Math.PI / 7));
          ctx.lineTo(p1.x - head * Math.cos(ang + Math.PI / 7), p1.y - head * Math.sin(ang + Math.PI / 7));
          ctx.closePath();
          ctx.fill();
        } else {
          // 直线与自由曲线都是折线
          ctx.beginPath();
          pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    /** 命中测试：返回被点到的画记下标，-1 表示没点到 */
    _hitAnnotation(x, y, tol = 8) {
      for (let k = this.annotations.length - 1; k >= 0; k--) {
        const a = this.annotations[k];
        const pts = this._annotationPts(a);
        if (pts.length < 2) continue;
        if (a.tool === 'rect') {
          const x0 = Math.min(pts[0].x, pts[pts.length - 1].x);
          const x1 = Math.max(pts[0].x, pts[pts.length - 1].x);
          const y0 = Math.min(pts[0].y, pts[pts.length - 1].y);
          const y1 = Math.max(pts[0].y, pts[pts.length - 1].y);
          const d = Math.min(
            distToSeg(x, y, x0, y0, x1, y0),
            distToSeg(x, y, x1, y0, x1, y1),
            distToSeg(x, y, x1, y1, x0, y1),
            distToSeg(x, y, x0, y1, x0, y0),
          );
          if (d <= tol) return k;
        } else {
          for (let i = 1; i < pts.length; i++) {
            if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return k;
          }
        }
      }
      return -1;
    }

    _localXY(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _onDown(e) {
      if (!this.drawTool || !this._geomCache) return;
      const { x, y } = this._localXY(e);

      if (this.drawTool === 'erase') {
        const k = this._hitAnnotation(x, y);
        if (k >= 0) {
          this.annotations.splice(k, 1);
          this.draw();
          if (this.opts.onAnnotationsChange) this.opts.onAnnotationsChange(this.annotations);
        }
        return;
      }

      const g = this._geomCache;
      const w = this.canvas.parentElement.clientWidth;
      if (x < g.padL || x > w - g.padR || y < g.priceTop || y > g.volBot) return;

      const pt = { date_ms: this._dateAtX(x), price: this._priceAtY(y) };
      if (!Number.isFinite(pt.date_ms) || !Number.isFinite(pt.price) || pt.price <= 0) return;

      this._drawing = true;
      this._draft = {
        tool: this.drawTool,
        color: this.drawColor,
        width: this.drawWidth,
        // 直线/箭头/方框先放两个相同的点，拖动时替换第二个；
        // 自由曲线只放一个，后续按像素距离追加
        points: this.drawTool === 'free' ? [pt] : [pt, { ...pt }],
      };
      this.draw();
    }

    _onUp() {
      if (!this._drawing) return;
      this._drawing = false;
      const d = this._draft;
      this._draft = null;
      if (d && d.points.length >= 2) {
        d.points = downsample(d.points, 600); // 兜一层点数上限
        d.id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        this.annotations.push(d);
        if (this.opts.onAnnotationsChange) this.opts.onAnnotationsChange(this.annotations);
      }
      this.draw();
    }

    /** 清空画记，返回清掉了多少条 */
    clearAnnotations() {
      const n = this.annotations.length;
      this.annotations = [];
      this._draft = null;
      this._drawing = false;
      this.draw();
      if (n && this.opts.onAnnotationsChange) this.opts.onAnnotationsChange(this.annotations);
      return n;
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
      if (this.mode === 'intraday') return this._drawIntraday(W, H);
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

      // ---- 画笔画记（画在图形之上、十字光标之下）
      this._renderAnnotations(ctx);

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
  window.KLINE_FMT = { n2, fmtVol, fmtDate, hhmm };
})();

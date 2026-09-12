/**
 * 自选股看板 · 前端
 *
 * 关键设计：全程单页状态切换。点击左侧任一股票只改 state.selected 并重绘右侧
 * 画布，不产生任何页面跳转或刷新，因此左侧的行情列表始终在视野里（全局观）。
 * 轮询刷新只更新左侧数字，不打断右侧图表与鼠标悬停。
 *
 * 绘图本身在 public/chart.js 的 KlineChart 组件里；本文件负责取数、状态与视图。
 */

const $ = (id) => document.getElementById(id);
const el = {
  list: $('list'),
  count: $('count'),
  addInput: $('add-input'),
  addBtn: $('add-btn'),
  addResult: $('add-result'),
  quoteStatus: $('quote-status'),
  refreshBtn: $('refresh-btn'),
  selName: $('sel-name'),
  selCode: $('sel-code'),
  addCurrent: $('add-current'),
  priceBox: $('sel-price-box'),
  chartInfo: $('chart-info'),
  chartWrap: $('chart-wrap'),
  canvas: $('chart'),
  empty: $('chart-empty'),
  loading: $('chart-loading'),
  stats: $('stats'),
  viewbar: $('viewbar'),
  sidebars: {
    watchlist: $('sidebar-watchlist'),
    review: $('sidebar-review'),
    screener: $('sidebar-screener'),
    backtest: $('sidebar-backtest'),
    alerts: $('sidebar-alerts'),
  },
  toastWrap: $('toast-wrap'),
  alertCount: $('alert-count'),
  alertMonitor: $('alert-monitor'),
  alertList: $('al-list'),
  alertStatus: $('al-status'),
  alInput: $('al-input'),
  alDirection: $('al-direction'),
  alTarget: $('al-target'),
  alNote: $('al-note'),
  alAdd: $('al-add'),
  alCheck: $('al-check'),
  alBeep: $('al-beep'),
  reviewPanels: $('review-panels'),
  reviewDate: $('review-date'),
  reviewDateInput: $('review-date-input'),
  reviewStatus: $('review-status'),
  reviewRefresh: $('review-refresh'),
  screenerCount: $('screener-count'),
  screenerResults: $('screener-results'),
  screenerStatus: $('screener-status'),
  btCount: $('bt-count'),
  btResults: $('bt-results'),
  btStatus: $('bt-status'),
};

const state = {
  view: 'watchlist',  // watchlist | review
  items: [],          // 自选股列表（含行情）
  selected: null,     // 当前选中 thscode
  kline: null,        // { thscode, name, items, adjust }
  days: 365,
  period: 'day',      // day | week | month | quarter | year
  adjust: 'forward',
  klineLoading: false,
  hoverIndex: null,
  lastQuoteAt: null,
  review: null,       // /api/review 的响应
  dragon: null,       // 龙虎榜数据
  dragonBoard: 'all',
  tradesByCode: {},   // 回测结果：thscode → 成交点
  tradeMarkers: [],   // 当前选中股票的成交点（画在 K 线上）
};

// 价格预警：服务端负责轮询与判定，前端只负责显示 + 弹窗 + 提示音
const alertState = {
  items: [],
  monitor: null,
  shownEvents: new Set(), // 本次会话已弹过窗的事件 id，避免重复弹
};

// ---------------------------------------------------------------- 格式化

const n2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(2));

function fmtVol(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return String(v);
}

function pctClass(v) {
  if (v === null || v === undefined) return '';
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

function signPct(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 自选股列表

async function loadQuotes({ silent = false } = {}) {
  if (!silent) el.quoteStatus.textContent = '加载中…';
  try {
    const res = await fetch('/api/watchlist');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.items = data.items ?? [];
    state.lastQuoteAt = new Date().toISOString();

    if (data.quoteError) {
      el.quoteStatus.innerHTML = `<span class="up">行情异常 code=${data.quoteError.code ?? '-'}</span>`;
    } else {
      el.quoteStatus.textContent = `行情 ${fmtTime(state.lastQuoteAt)} 更新`;
    }
    renderList();

    // 首次加载自动选中第一只，省掉一次点击
    if (!state.selected && state.items.length) selectStock(state.items[0].thscode);
    // 选中项已不在列表里（被删）→ 清空右侧
    if (state.selected && !state.items.some((i) => i.thscode === state.selected)) {
      state.selected = null;
      state.kline = null;
      renderMainChart();
      renderHeader();
    }
  } catch (err) {
    el.quoteStatus.innerHTML = `<span class="up">行情获取失败</span>`;
    console.error(err);
  }
}

function renderList() {
  const scrollTop = el.list.scrollTop;
  el.count.textContent = String(state.items.length);
  el.list.innerHTML = '';

  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'row' + (item.thscode === state.selected ? ' active' : '');
    li.dataset.code = item.thscode;

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.innerHTML = `${item.name || '—'}<span class="sub">${item.thscode}</span>`;

    const px = document.createElement('div');
    px.className = 'px ' + pctClass(item.price_change_ratio_pct);
    px.innerHTML = `${n2(item.last_price)}<span class="sub">${signPct(item.price_change_ratio_pct)}</span>`;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '从自选股移除';

    li.append(nm, px, del);

    // 点击整行 = 切换右侧图表（不跳页）
    li.addEventListener('click', () => selectStock(item.thscode));
    del.addEventListener('click', (ev) => {
      ev.stopPropagation(); // 避免触发选中
      removeStock(item.thscode);
    });

    el.list.appendChild(li);
  }
  el.list.scrollTop = scrollTop;
}

function selectStock(thscode) {
  // 四宫格的四格是**同一只股票**的不同周期，所以点左侧列表时四格一起换
  if (state.view === 'quad') {
    state.selected = thscode;
    renderList();
    setQuadCode(thscode);
    return;
  }

  if (state.selected === thscode && state.kline) return;
  state.selected = thscode;
  state.tradeMarkers = state.tradesByCode[thscode] ?? [];
  renderList();
  renderHeader();
  loadKline();
}

function renderHeader() {
  const item = state.items.find((i) => i.thscode === state.selected);

  if (!item) {
    // 选中项可能来自复盘面板（不在自选股里）：用 K 线数据兜底，并提供"加入自选"
    const k = state.kline;
    const last = k?.items?.length ? k.items[k.items.length - 1] : null;
    el.selName.textContent = k?.name || state.selected || '未选择';
    el.selCode.textContent = state.selected ?? '';
    el.priceBox.textContent = last ? n2(last.close_price) : '—';
    el.addCurrent.hidden = !state.selected;
    return;
  }

  el.addCurrent.hidden = true;
  el.selName.textContent = item.name || state.selected;
  el.selCode.textContent = state.selected;

  const cls = pctClass(item.price_change_ratio_pct);
  el.priceBox.innerHTML =
    `<span class="${cls}">${n2(item.last_price)}</span>` +
    `<span class="sub ${cls}">${item.price_change === null ? '' : (item.price_change > 0 ? '+' : '') + n2(item.price_change)}　${signPct(item.price_change_ratio_pct)}</span>`;
}

// ---------------------------------------------------------------- K 线

async function loadKline() {
  if (!state.selected) return;
  const code = state.selected;
  state.klineLoading = true;
  el.loading.hidden = false;
  el.empty.hidden = true;

  try {
    // 均线预热由服务端按周期折算负责，前端只要显示窗口
    const url =
      `/api/kline?thscode=${encodeURIComponent(code)}&days=${state.days}` +
      `&adjust=${state.adjust}&period=${state.period}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    // 请求返回期间用户可能已经切到别的股票，丢弃过期响应
    if (state.selected !== code) return;
    state.kline = data;
    renderHeader();
  } catch (err) {
    if (state.selected === code) {
      state.kline = { thscode: code, items: [], displayStartMs: 0, error: err.message };
    }
    console.error(err);
  } finally {
    if (state.selected === code) {
      state.klineLoading = false;
      el.loading.hidden = true;
      renderMainChart();
    }
  }
}

/* ===================================================================
   以下到「旧绘图实现结束」为止的代码已废弃，仅作留存追溯。
   绘图逻辑已迁移到 public/chart.js 的 KlineChart 组件（支持周期切换、
   更醒目的坐标标注，并被主图与四宫格共用）。
   ===================================================================
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

const MA_STYLE = [
  { period: 5, color: '#e8b339' },
  { period: 10, color: '#4c8dff' },
  { period: 20, color: '#c678dd' },
  { period: 60, color: '#4aa181' },
];

let currentView = null; // 供 crosshair 使用

// 画一个实心三角，用于标注回测的买入/卖出点。
function triangle(ctx, cx, cy, dir, color) {
  const s = 5;
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

function drawChart() {
  const canvas = el.canvas;
  const wrap = el.chartWrap;
  const ctx = canvas.getContext('2d');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(W * dpr));
  canvas.height = Math.max(1, Math.floor(H * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const full = state.kline?.items ?? [];
  if (full.length < 2) {
    el.empty.hidden = false;
    el.empty.textContent = state.kline?.error
      ? `加载失败：${state.kline.error}`
      : state.selected ? '暂无 K 线数据' : '从左侧选择一只股票';
    el.stats.innerHTML = '';
    el.chartInfo.textContent = '—';
    currentView = null;
    return;
  }
  el.empty.hidden = true;

  // 只显示窗口内的 bar；均线在完整序列上计算，因此窗口左端也是准确的
  const cutMs = Date.now() - state.days * 86400_000;
  let i0 = full.findIndex((it) => it.date_ms >= cutMs);
  if (i0 < 0) i0 = 0;

  const mas = MA_STYLE.map((s) => ({ ...s, values: computeMA(full, s.period) }));
  const view = full.slice(i0);
  const maView = mas.map((m) => ({ ...m, values: m.values.slice(i0) }));
  currentView = { view, maView };

  // 价格范围（含均线，避免均线跑出画面）
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
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;

  const padL = 6;
  const padR = 60;
  const padT = 12;
  const padB = 22;
  const gap = 12;
  const usableH = H - padT - padB;
  const volH = Math.max(30, usableH * 0.22);
  const priceH = usableH - volH - gap;
  const priceTop = padT;
  const priceBot = padT + priceH;
  const volTop = priceBot + gap;
  const volBot = volTop + volH;

  const n = view.length;
  const step = (W - padL - padR) / n;
  const x = (i) => padL + (i + 0.5) * step;
  const yP = (p) => priceBot - ((p - lo) / (hi - lo)) * priceH;

  let maxVol = 0;
  for (const it of view) maxVol = Math.max(maxVol, Number(it.volume) || 0);
  const yV = (v) => volBot - (maxVol ? (v / maxVol) * volH : 0);

  // --- 网格与价格刻度
  ctx.font = '11px Consolas, monospace';
  ctx.textBaseline = 'middle';
  const TICKS = 5;
  for (let t = 0; t <= TICKS; t++) {
    const p = lo + ((hi - lo) * t) / TICKS;
    const y = yP(p);
    ctx.strokeStyle = 'rgba(35,47,63,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(W - padR, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#8595a8';
    ctx.textAlign = 'left';
    ctx.fillText(p.toFixed(2), W - padR + 6, y);
  }
  // 成交量区分隔
  ctx.strokeStyle = 'rgba(35,47,63,0.85)';
  ctx.beginPath();
  ctx.moveTo(padL, volTop + 0.5);
  ctx.lineTo(W - padR, volTop + 0.5);
  ctx.stroke();

  // --- 蜡烛 + 成交量
  const bodyW = Math.max(1, Math.min(step * 0.72, 14));
  for (let i = 0; i < n; i++) {
    const it = view[i];
    const o = Number(it.open_price);
    const c = Number(it.close_price);
    const h = Number(it.high_price);
    const l = Number(it.low_price);
    const up = c >= o;
    const color = up ? '#e5484d' : '#26a269';
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

    // 成交量
    const v = Number(it.volume) || 0;
    ctx.fillStyle = up ? 'rgba(229,72,77,0.55)' : 'rgba(38,162,105,0.55)';
    ctx.fillRect(cx - bodyW / 2, yV(v), bodyW, volBot - yV(v));
  }

  // --- 均线
  for (const m of maView) {
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.2;
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

  // --- 回测买卖点标记
  if (state.tradeMarkers.length) {
    const byDate = new Map();
    for (let i = 0; i < n; i++) byDate.set(view[i].date_ms, i);
    for (const t of state.tradeMarkers) {
      const i = byDate.get(t.date_ms);
      if (i === undefined) continue;
      const bar = view[i];
      const cx = x(i);
      if (t.side === 'buy') {
        triangle(ctx, cx, yP(Number(bar.low_price)) + 8, 'up', '#e5484d');
      } else {
        triangle(ctx, cx, yP(Number(bar.high_price)) - 8, 'down', '#26a269');
      }
    }
  }

  // --- 日期刻度
  ctx.fillStyle = '#8595a8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const dateTicks = Math.min(6, n);
  for (let t = 0; t < dateTicks; t++) {
    const i = Math.round((t * (n - 1)) / Math.max(1, dateTicks - 1));
    const d = new Date(view[i].date_ms);
    ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, x(i), H - padB + 5);
  }

  // --- 十字光标
  if (state.hoverIndex !== null && state.hoverIndex >= 0 && state.hoverIndex < n) {
    const i = state.hoverIndex;
    const it = view[i];
    const cx = x(i);
    ctx.save();
    ctx.strokeStyle = 'rgba(215,222,232,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, priceTop);
    ctx.lineTo(cx + 0.5, volBot);
    ctx.stroke();
    const cy = yP(Number(it.close_price));
    ctx.beginPath();
    ctx.moveTo(padL, cy + 0.5);
    ctx.lineTo(W - padR, cy + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  updateInfoAndStats(view);
}

function updateInfoAndStats(view) {
  const i = state.hoverIndex !== null && state.hoverIndex < view.length ? state.hoverIndex : view.length - 1;
  const it = view[i];
  if (!it) return;
  const o = Number(it.open_price);
  const c = Number(it.close_price);
  const chg = ((c - o) / o) * 100;

  el.chartInfo.textContent =
    `${fmtDate(it.date_ms)}　开 ${n2(o)}　高 ${n2(it.high_price)}　低 ${n2(it.low_price)}　收 ${n2(c)}　` +
    `量 ${fmtVol(it.volume)}`;

  const markerNote = state.tradeMarkers.length
    ? `<span><span class="up">▲</span> 买入 <span class="down">▼</span> 卖出（回测 ${state.tradeMarkers.filter((t) => t.side === 'buy').length} 次建仓，共 ${state.tradeMarkers.length} 个成交点）</span>`
    : '';

  el.stats.innerHTML =
    `<span>区间 <b>${view.length}</b> 根日K</span>` +
    `<span>复权 <b>${state.kline?.adjust ?? state.adjust}</b></span>` +
    `<span>最新 <b>${fmtDate(view[view.length - 1].date_ms)}</b></span>` +
    `<span>当日涨跌 <b class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>` +
    `<span style="opacity:.75">均线 ${MA_STYLE.map((m) => `<span style="color:${m.color}">MA${m.period}</span>`).join(' ')}</span>` +
    markerNote;
}
   ===================== 旧绘图实现结束 ===================== */

// ---------------------------------------------------------------- K 线图实例

const KF = window.KLINE_FMT;
const PERIOD_LABEL = window.KLINE_PERIOD_LABEL;

/** 主图（右侧大图）。悬停信息通过回调写进工具条。 */
const mainChart = new KlineChart(el.canvas, {
  onHover: (info) => (info ? setChartInfo(info) : resetChartInfo()),
  onViewChange: () => updateStats(),   // 滚轮缩放后刷新底部统计
});

/** 当前显示窗口内的 bar（`displayStartMs` 之前的是服务端多取的均线预热数据） */
function displayedBars(items, displayStartMs) {
  const list = items ?? [];
  if (!displayStartMs) return list;
  let i0 = list.findIndex((it) => it.date_ms >= displayStartMs);
  if (i0 < 0) i0 = 0;
  return list.slice(i0);
}

function setChartInfo(info) {
  el.chartInfo.innerHTML =
    `${info.date}　开 ${KF.n2(info.open)}　高 ${KF.n2(info.high)}　低 ${KF.n2(info.low)}　收 ${KF.n2(info.close)}　` +
    `量 ${KF.fmtVol(info.volume)}`;
}

function resetChartInfo() {
  const bars = displayedBars(state.kline?.items, state.kline?.displayStartMs);
  const last = bars[bars.length - 1];
  if (!last) {
    el.chartInfo.textContent = '—';
    return;
  }
  setChartInfo({
    date: KF.fmtDate(last.date_ms, true),
    open: last.open_price,
    high: last.high_price,
    low: last.low_price,
    close: last.close_price,
    volume: last.volume,
  });
}

function renderMainChart() {
  const k = state.kline;
  const bars = k?.items ?? [];

  const showEmpty = (text) => {
    mainChart.clear();
    el.empty.hidden = false;
    el.empty.textContent = text;
    el.stats.innerHTML = '';
    el.chartInfo.textContent = '—';
  };

  if (k?.error) return showEmpty(`加载失败：${k.error}`);
  if (bars.length < 2) return showEmpty(state.selected ? '暂无 K 线数据' : '从左侧选择一只股票');

  el.empty.hidden = true;
  mainChart.setData({
    items: bars,
    displayStartMs: k.displayStartMs,
    markers: state.tradeMarkers,
    period: k.period ?? state.period,
  });
  resetChartInfo();
  updateStats();
}

function updateStats() {
  // 用「当前可见」的 bar，而不是默认窗口 —— 滚轮缩放后数字要跟着变
  const bars = mainChart.visibleBars();
  if (!bars.length) {
    el.stats.innerHTML = '';
    return;
  }
  const last = bars[bars.length - 1];
  const o = Number(last.open_price);
  const c = Number(last.close_price);
  const chg = o ? ((c - o) / o) * 100 : 0;
  const markerNote = state.tradeMarkers.length
    ? `<span><span class="up">▲</span> 买入 <span class="down">▼</span> 卖出（${state.tradeMarkers.filter((t) => t.side === 'buy').length} 次建仓，${state.tradeMarkers.length} 个成交点）</span>`
    : '';
  const zoomNote = mainChart.zoomCount === null
    ? '<span class="dim">滚轮缩放松开，双击复位</span>'
    : '<span class="warn">已缩放 · 双击复位</span>';

  el.stats.innerHTML =
    `<span>周期 <b>${PERIOD_LABEL[state.period] ?? '日'}线</b></span>` +
    `<span>显示 <b>${bars.length}</b> 根</span>` +
    `<span>复权 <b>${state.kline?.adjust ?? state.adjust}</b></span>` +
    `<span>末根 <b>${KF.fmtDate(last.date_ms, true)}</b></span>` +
    `<span>本根涨跌 <b class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>` +
    `<span style="opacity:.75">均线 ${window.KLINE_MA_STYLE.map((m) => `<span style="color:${m.color}">MA${m.period}</span>`).join(' ')}</span>` +
    zoomNote +
    markerNote;
}

// ---------------------------------------------------------------- 四宫格（同一只股票的多周期同屏）

const QUAD_SLOTS = 4;
const QUAD_DEFAULT_PERIODS = ['day', 'week', 'month', 'year'];

const quadCharts = [];
const quadCells = [];
const quadState = {
  code: null,                         // 四格显示的是同一只股票
  periods: QUAD_DEFAULT_PERIODS.slice(),
  meta: new Array(QUAD_SLOTS).fill(null),
  // 默认只展开 日线 / 周线（上下各占一半高度），月线与年线收成细条，需要时点开
  collapsed: QUAD_DEFAULT_PERIODS.map((p) => p === 'month' || p === 'year'),
  built: false,
};

function buildQuad() {
  const grid = $('quad-grid');
  grid.innerHTML = '';
  quadCharts.length = 0;
  quadCells.length = 0;

  for (let i = 0; i < QUAD_SLOTS; i++) {
    const cell = document.createElement('div');
    cell.className = 'quad-cell';

    const head = document.createElement('div');
    head.className = 'quad-head';

    const select = document.createElement('select');
    select.className = 'quad-period';
    for (const p of ['day', 'week', 'month', 'quarter', 'year']) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = `${PERIOD_LABEL[p]}线`;
      select.appendChild(opt);
    }
    select.value = quadState.periods[i];
    select.addEventListener('change', () => {
      quadState.periods[i] = select.value;
      if (quadState.code) loadQuadSlot(i);
    });

    const price = document.createElement('span');
    price.className = 'quad-price';
    price.textContent = '—';

    const count = document.createElement('span');
    count.className = 'quad-count';

    // 折叠/展开：月线、年线默认收起成细条，需要时点开
    const toggle = document.createElement('button');
    toggle.className = 'quad-toggle';
    toggle.title = '折叠 / 展开';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuadCollapse(i);
    });

    head.append(select, count, price, toggle);
    const wrap = document.createElement('div');
    wrap.className = 'quad-chart';
    wrap.appendChild(document.createElement('canvas'));
    cell.append(head, wrap);
    grid.appendChild(cell);

    const chart = new KlineChart(wrap.querySelector('canvas'), {
      compact: true,
      onHover: (info) => {
        if (!info) {
          updateQuadHead(i);
          return;
        }
        const pct = info.pct;
        price.innerHTML =
          `${KF.n2(info.close)}` +
          `<i class="${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}">${pct > 0 ? '+' : ''}${pct === null ? '—' : pct.toFixed(2) + '%'}</i>`;
      },
      onViewChange: (n) => {
        count.textContent = n ? `${n} 根` : '';
        count.classList.toggle('zoomed', chart.zoomCount !== null);
      },
    });

    quadCharts.push(chart);
    quadCells.push(cell);
  }
  quadState.built = true;
  applyQuadLayout();
}

/** 把 collapsed 状态同步到 DOM（尺寸由 CSS 的 flex 决定） */
function applyQuadLayout() {
  quadCells.forEach((cell, i) => {
    const collapsed = quadState.collapsed[i];
    cell.classList.toggle('collapsed', collapsed);
    const btn = cell.querySelector('.quad-toggle');
    if (btn) {
      btn.textContent = collapsed ? '▸' : '▾';
      btn.title = collapsed ? '展开' : '折叠';
    }
  });
}

/** 折叠 / 展开某一格；至少保留一格展开，否则整个区域会空掉 */
function toggleQuadCollapse(i) {
  const next = !quadState.collapsed[i];
  if (next && quadState.collapsed.filter((c) => !c).length <= 1) return;
  quadState.collapsed[i] = next;
  applyQuadLayout();
  updateQuadHint();
  // 等布局稳定后再重绘：折叠时尺寸过小会跳过绘制，展开后必须补一次
  setTimeout(() => quadCharts.forEach((c) => c.draw()), 60);
}

/** 当前展开的周期名，用于界面提示 */
function expandedPeriodNames() {
  return quadState.periods
    .filter((_, i) => !quadState.collapsed[i])
    .map((p) => `${PERIOD_LABEL[p]}线`)
    .join(' + ');
}

function updateQuadHead(i) {
  const cell = quadCells[i];
  if (!cell) return;
  const priceEl = cell.querySelector('.quad-price');
  const meta = quadState.meta[i];
  const code = quadState.code;

  const item = state.items.find((x) => x.thscode === code);
  if (meta?.error) {
    priceEl.innerHTML = '<i class="up">加载失败</i>';
    return;
  }
  if (item && item.last_price !== null) {
    const pct = item.price_change_ratio_pct;
    priceEl.innerHTML =
      `${KF.n2(item.last_price)}` +
      `<i class="${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}">${pct > 0 ? '+' : ''}${pct === null ? '' : pct.toFixed(2) + '%'}</i>`;
  } else if (meta?.last) {
    priceEl.textContent = KF.n2(meta.last.close_price);
  } else {
    priceEl.textContent = '—';
  }
}

/** 取第 i 格的周期，用当前股票加载该格。 */
async function loadQuadSlot(i) {
  const code = quadState.code;
  const chart = quadCharts[i];
  const cell = quadCells[i];
  if (!code || !chart) {
    chart?.clear();
    quadState.meta[i] = null;
    return;
  }
  const period = quadState.periods[i];
  cell.classList.add('loading');

  try {
    const url =
      `/api/kline?thscode=${encodeURIComponent(code)}&days=${state.days}` +
      `&adjust=${state.adjust}&period=${period}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    // 期间用户可能已经切到别的股票或改了周期，丢弃过期响应
    if (quadState.code !== code || quadState.periods[i] !== period) return;
    const bars = data.items ?? [];
    quadState.meta[i] = { name: data.name, last: bars[bars.length - 1], bars: bars.length };
    chart.setData({
      items: bars,
      displayStartMs: data.displayStartMs,
      period: data.period ?? period,
    });
  } catch (err) {
    if (quadState.code === code && quadState.periods[i] === period) {
      quadState.meta[i] = { error: err.message };
      chart.clear();
    }
  } finally {
    cell.classList.remove('loading');
    updateQuadHead(i);
  }
}

function loadQuadAll() {
  for (let i = 0; i < QUAD_SLOTS; i++) loadQuadSlot(i);
  updateQuadHint();
}

function updateQuadHint() {
  const item = state.items.find((x) => x.thscode === quadState.code);
  const name = item?.name || quadState.meta.find((m) => m?.name)?.name || quadState.code || '—';
  $('quad-hint').textContent = quadState.code
    ? `${name} ${quadState.code} —— 展开中：${expandedPeriodNames()}　·　滚轮单独缩放，双击复位，点 ▾/▸ 折叠展开`
    : '点左侧自选股，多格同步显示该股的不同周期';
}

/** 设置四宫格显示的股票（点左侧列表时调用），四格一起换 */
function setQuadCode(code) {
  if (quadState.code === code) return;
  quadState.code = code;
  loadQuadAll();
}

/** 周期 / 区间 / 复权变化后重载当前视图的图 */
function reloadCharts() {
  if (state.view === 'quad') loadQuadAll();
  else loadKline();
}

/** 把两套工具条上的按钮同步成同一状态 */
function syncGroups() {
  const mark = (attr, value) => {
    document.querySelectorAll(`button[${attr}]`).forEach((b) => {
      b.classList.toggle('active', b.getAttribute(attr) === String(value));
    });
  };
  mark('data-period', state.period);
  mark('data-days', String(state.days));
  mark('data-adjust', state.adjust);
}

/** 拖动窗口后所有画布都要重算尺寸 */
function redrawAllCharts() {
  mainChart.draw();
  if (quadState.built) quadCharts.forEach((c) => c.draw());
}

// ---------------------------------------------------------------- 增删

async function addStocks() {
  const input = el.addInput.value.trim();
  if (!input) return;
  el.addBtn.disabled = true;
  el.addResult.textContent = '解析中…';
  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    const parts = [];
    if (data.added?.length) {
      parts.push(`<span class="ok">已添加 ${data.added.length} 只：${data.added.map((a) => `${a.name || a.thscode}`).join('、')}</span>`);
    }
    // 名称有多个候选时不隐瞒：把服务端替你选的那只和备选一并说出来
    const fuzzy = (data.added ?? []).filter((a) => a.ambiguous);
    if (fuzzy.length) {
      parts.push(
        `<span style="color:#e8b339">名称不唯一，已按最匹配选择：` +
        fuzzy.map((a) => `${a.name}(${a.thscode}) ← ${a.alternatives.slice(0, 3).join(' / ')}`).join('；') +
        `。如不对请用 6 位代码添加</span>`,
      );
    }
    if (data.failed?.length) {
      parts.push(`<span class="bad">未识别 ${data.failed.length} 个：${data.failed.map((f) => f.token).join('、')}</span>`);
    }
    if (!data.added?.length && !data.failed?.length) parts.push('<span class="bad">没有可添加的内容</span>');
    el.addResult.innerHTML = parts.join('<br>');
    if (data.added?.length) el.addInput.value = '';

    await loadQuotes({ silent: true });
  } catch (err) {
    el.addResult.innerHTML = `<span class="bad">添加失败：${err.message}</span>`;
  } finally {
    el.addBtn.disabled = false;
  }
}

async function removeStock(thscode) {
  try {
    const res = await fetch(`/api/watchlist/${encodeURIComponent(thscode)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadQuotes({ silent: true });
  } catch (err) {
    el.quoteStatus.innerHTML = `<span class="up">删除失败</span>`;
    console.error(err);
  }
}

// ---------------------------------------------------------------- 盘面复盘

function switchView(view) {
  state.view = view;
  for (const b of el.viewbar.children) b.classList.toggle('active', b.dataset.view === view);

  // 四宫格复用「自选股」的左栏，右侧换成 2×2 网格
  const leftKey = view === 'quad' ? 'watchlist' : view;
  for (const [name, node] of Object.entries(el.sidebars)) node.hidden = name !== leftKey;

  const isQuad = view === 'quad';
  $('main').hidden = isQuad;
  $('quad-view').hidden = !isQuad;

  if (isQuad) {
    if (!quadState.built) buildQuad();
    // 优先沿用当前选中的股票，否则用自选股第一只
    const code = state.selected || state.items[0]?.thscode || null;
    if (code && quadState.code !== code) {
      quadState.code = code;
      loadQuadAll();
    } else if (!quadState.code) {
      updateQuadHint();
    }
    syncGroups();
  } else {
    // 从隐藏状态恢复时画布尺寸才有效，这里重绘一次
    renderMainChart();
  }

  // 懒加载：只在第一次进入复盘时取数，之后由刷新按钮控制
  if (view === 'review') {
    if (!state.review) loadReview();
    if (!state.dragon) loadDragon(state.dragonBoard);
  }
  if (view === 'alerts') loadAlerts();
}

async function loadReview(date) {
  el.reviewStatus.textContent = '加载中…';
  try {
    const qs = date ? `?date=${encodeURIComponent(date)}` : '';
    const res = await fetch('/api/review' + qs);
    const data = await res.json();
    if (!res.ok) {
      el.reviewStatus.innerHTML = `<span class="warn">${data.error ?? `HTTP ${res.status}`}</span>`;
      return;
    }
    state.review = data;
    state.reviewDate = data.tradeDate;
    state.reviewRequested = Boolean(data.requested);
    el.reviewDate.textContent = data.tradeDate ?? '—';
    if (!el.reviewDateInput.value) el.reviewDateInput.value = data.tradeDate ?? '';
    const errs = Object.keys(data.errors ?? {});
    const bits = [];
    if (data.fellBack) bits.push(`<span class="warn">最新日无数据→${data.tradeDate}</span>`);
    if (errs.length) bits.push(`<span class="warn">失败：${errs.join('、')}</span>`);
    if (!bits.length) bits.push(`更新于 ${fmtTime(new Date().toISOString())}`);
    el.reviewStatus.innerHTML = bits.join('　');
    renderReview();
  } catch (err) {
    el.reviewStatus.innerHTML = `<span class="warn">加载失败：${err.message}</span>`;
  }
}

async function loadDragon(board) {
  state.dragonBoard = board;
  try {
    const parts = [`board=${encodeURIComponent(board)}`];
    // 只有在用户显式选择了日期时才跟随，避免与默认口径不一致
    if (state.reviewRequested && state.reviewDate) parts.push(`date=${encodeURIComponent(state.reviewDate)}`);
    const res = await fetch(`/api/review/dragon-tiger?${parts.join('&')}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.dragon = data;
    renderReview();
  } catch (err) {
    console.error('龙虎榜加载失败', err);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yi = (v) => (v === null || v === undefined ? '—' : `${v < 0 ? '-' : ''}${(Math.abs(v) / 1e8).toFixed(2)}亿`);
const stk = (it) => `<a class="stk" data-code="${esc(it.thscode)}" title="${esc(it.thscode)}">${esc(it.name)}</a>`;

const BOARD_LABELS = {
  two_board: '2板', three_board: '3板', four_board: '4板',
  five_board: '5板', six_board: '6板', seven_over: '7板+',
};

function ladderCount(ladder) {
  if (!ladder?.boards) return 0;
  return Object.values(ladder.boards).reduce((n, arr) => n + (arr?.length ?? 0), 0);
}

function renderReview() {
  if (!state.review) {
    el.reviewPanels.innerHTML = '<div class="rv-empty">尚未加载</div>';
    return;
  }
  const { panels: p, tradeDate } = state.review;
  const out = [];

  // --- 情绪概览
  out.push(`<section class="panel">
    <h2>情绪概览 <span class="dim">${esc(tradeDate)}</span></h2>
    <div class="emotion">
      <div><b class="up">${p.limitUpTotal ?? p.limitUp.length}</b><span>涨停</span></div>
      <div><b class="down">${p.limitDown.length}</b><span>跌停</span></div>
      <div><b class="amber">${p.limitBreak.length}</b><span>炸板</span></div>
      <div><b>${p.ladder ? ladderCount(p.ladder) : 0}</b><span>连板</span></div>
    </div>
  </section>`);

  // --- 连板天梯
  if (p.ladder?.boards) {
    const groups = Object.entries(BOARD_LABELS)
      .map(([key, label]) => {
        const arr = p.ladder.boards[key] ?? [];
        if (!arr.length) return '';
        return `<div class="tier"><span class="tier-label">${label}</span>
          <span class="tier-items">${arr.map((s) => `${stk(s)}<i>${s.board_num}</i>`).join('')}</span></div>`;
      })
      .filter(Boolean)
      .join('');
    out.push(`<section class="panel">
      <h2>连板天梯 <span class="dim">${esc(p.ladder.date ?? '')}</span></h2>
      ${groups || '<div class="rv-empty">当日无连板</div>'}
    </section>`);
  }

  // --- 涨停池
  out.push(`<section class="panel">
    <h2>涨停池 <span class="dim">${p.limitUpTotal ?? p.limitUp.length} 家</span></h2>
    ${p.limitUp.length ? `<table class="rv"><thead><tr><th>名称</th><th>连板</th><th>封单</th><th>时间</th></tr></thead><tbody>
      ${p.limitUp.slice(0, 40).map((s) => `<tr>
        <td>${stk(s)}</td>
        <td class="c">${esc(s.continue_day_text ?? '')}</td>
        <td class="r">${yi(s.seal_money)}</td>
        <td class="c dim">${esc(s.limit_up_time ?? '')}</td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="rv-empty">无涨停</div>'}
  </section>`);

  // --- 跌停池 / 炸板池
  out.push(`<section class="panel">
    <h2>跌停池 <span class="dim">${p.limitDown.length} 家</span></h2>
    ${p.limitDown.length ? `<table class="rv"><thead><tr><th>名称</th><th>跌幅</th><th>换手</th><th>首次</th></tr></thead><tbody>
      ${p.limitDown.map((s) => `<tr>
        <td>${stk(s)}</td>
        <td class="r down">${s.price_change_ratio_pct?.toFixed(2)}%</td>
        <td class="r">${s.turnover_ratio_pct?.toFixed(2)}%</td>
        <td class="c dim">${esc(s.first_limit_time ?? '')}</td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="rv-empty">无跌停</div>'}
  </section>`);

  out.push(`<section class="panel">
    <h2>炸板池 <span class="dim">${p.limitBreak.length} 家</span></h2>
    ${p.limitBreak.length ? `<table class="rv"><thead><tr><th>名称</th><th>涨幅</th><th>开板</th><th>换手</th></tr></thead><tbody>
      ${p.limitBreak.map((s) => `<tr>
        <td>${stk(s)}</td>
        <td class="r up">${s.price_change_ratio_pct?.toFixed(2)}%</td>
        <td class="r">${s.open_times} 次</td>
        <td class="r">${s.turnover_ratio_pct?.toFixed(1)}%</td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="rv-empty">无炸板</div>'}
  </section>`);

  // --- 热榜
  const rankTable = (title, rows) => `<section class="panel">
    <h2>${title}</h2>
    ${rows.length ? `<table class="rv"><thead><tr><th>#</th><th>名称</th><th>热度</th><th>变动</th></tr></thead><tbody>
      ${rows.slice(0, 30).map((s) => `<tr>
        <td class="c dim">${s.rank}</td>
        <td>${stk(s)}</td>
        <td class="r">${esc(s.heat)}</td>
        <td class="c ${s.rank_change > 0 ? 'up' : s.rank_change < 0 ? 'down' : 'dim'}">${s.rank_change > 0 ? '+' : ''}${s.rank_change ?? 0}</td>
      </tr>`).join('')}
    </tbody></table>` : '<div class="rv-empty">无数据</div>'}
  </section>`;
  out.push(rankTable('热股榜', p.hot));
  out.push(rankTable('飙升榜', p.skyrocket));

  // --- 龙虎榜（独立接口 + 三档切换）
  const d = state.dragon;
  const boardBtn = (val, label) =>
    `<button data-board="${val}" class="${state.dragonBoard === val ? 'active' : ''}">${label}</button>`;
  let dragonBody = '<div class="rv-empty">加载中…</div>';
  if (d) {
    const rows = d.stockItems ?? [];
    if (rows.length) {
      const isOrg = d.boardType === 'org';
      dragonBody = `<div class="dim small">上榜 ${d.stockCount} 只 / 记录 ${d.count} 条 · ${esc(d.tradeDate ?? '')}</div>
        <table class="rv"><thead><tr><th>名称</th><th>涨跌</th><th>净买</th><th>${isOrg ? '机构净买' : '游资净买'}</th></tr></thead><tbody>
        ${rows.slice(0, 40).map((s) => {
          const chg = (s.change ?? 0) * 100;
          const focus = isOrg ? s.org_net_value : s.hot_money_net_value;
          return `<tr>
            <td>${stk(s)}<span class="dim small"> ${esc((s.concept_list ?? []).slice(0, 2).map((c) => c.name).join('/'))}</span></td>
            <td class="r ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${chg > 0 ? '+' : ''}${chg.toFixed(2)}%</td>
            <td class="r">${yi(s.net_value)}</td>
            <td class="r ${focus > 0 ? 'up' : focus < 0 ? 'down' : 'dim'}">${yi(focus)}</td>
          </tr>`;
        }).join('')}
      </tbody></table>`;
    } else {
      dragonBody = '<div class="rv-empty">当日无上榜记录</div>';
    }
  }
  out.push(`<section class="panel">
    <h2>龙虎榜 <span class="board-switch">${boardBtn('all', '全部')}${boardBtn('org', '机构')}${boardBtn('hot_money', '游资')}</span></h2>
    ${dragonBody}
  </section>`);

  el.reviewPanels.innerHTML = out.join('');
}

// ---------------------------------------------------------------- 选股筛选

const SCREENER_FIELDS = {
  minPrice: 'fs-minPrice', maxPrice: 'fs-maxPrice',
  minPct: 'fs-minPct', maxPct: 'fs-maxPct',
  minAmountYi: 'fs-minAmountYi', maxAmountYi: 'fs-maxAmountYi',
  minAmplitude: 'fs-minAmplitude', maxAmplitude: 'fs-maxAmplitude',
  minGap: 'fs-minGap', maxGap: 'fs-maxGap',
  minCloseStrength: 'fs-minCloseStrength', maxCloseStrength: 'fs-maxCloseStrength',
  minPe: 'fs-minPe', maxPe: 'fs-maxPe',
  minPb: 'fs-minPb', maxPb: 'fs-maxPb',
};

/** 一键预设：把常见条件填进表单并立刻筛选 */
const MA_PRESETS = {
  below20: { ref: '60', devMin: '-999', devMax: '-20' }, // 价格低于 MA60 20% 以上
  notBelow: { ref: '60', devMin: '0', devMax: '' },      // 价格不低于 MA60
  golden: { cross: 'golden' },                          // MA5 近 5 日金叉 MA10
};

async function runScreener() {
  const params = new URLSearchParams();
  for (const [key, id] of Object.entries(SCREENER_FIELDS)) {
    const v = $(id).value.trim();
    if (v !== '') params.set(key, v);
  }
  if ($('fs-excludeSt').checked) params.set('excludeSt', '1');
  const candle = $('fs-candle').value;
  if (candle) params.set('candle', candle);

  // 均线条件。偏离以所选均线为基准，正=价格在均线上方
  const maRef = $('fs-maRef').value;
  const maAlign = $('fs-maAlign').value;
  const maCross = $('fs-maCross').value;
  if (maRef) {
    params.set('maRef', maRef);
    const lo = $('fs-maDevMin').value.trim();
    const hi = $('fs-maDevMax').value.trim();
    if (lo !== '') params.set('maDevMin', lo);
    if (hi !== '') params.set('maDevMax', hi);
  }
  if (maAlign) params.set('maAlign', maAlign);
  if (maCross) {
    params.set('maCross', maCross);
    params.set('maCrossWithin', $('fs-maCrossWithin').value.trim() || '5');
  }
  const maScan = $('fs-maScan').value.trim() || '150';
  const needMaScan = Boolean(maRef || maAlign || maCross);
  if (needMaScan) params.set('maScan', maScan);

  // 资金与情绪类（各 1 次全市场请求）
  if ($('fs-limitUp').value) params.set('limitUp', '1');
  const minBoards = $('fs-minBoards').value.trim();
  if (minBoards !== '') params.set('minBoards', minBoards);
  const breakDown = $('fs-breakDown').value;
  if (breakDown === 'break') params.set('limitBreak', '1');
  if (breakDown === 'down') params.set('limitDown', '1');
  if ($('fs-dt').value) params.set('dt', $('fs-dt').value);
  const hotTop = $('fs-hotTop').value.trim();
  if (hotTop !== '') params.set('hotTop', hotTop);
  if ($('fs-anomaly').value) params.set('anomaly', $('fs-anomaly').value);

  // 均线扫描要逐只取 K 线，可能几十秒 —— 用计时器让用户知道在动，而不是界面卡死
  const t0 = Date.now();
  el.screenerCount.textContent = '…';
  const paint = (extra) => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    el.screenerStatus.innerHTML = `筛选中… ${sec}s${extra ? `　<span class="dim">${extra}</span>` : ''}`;
  };
  paint(needMaScan ? `均线扫描最多 ${maScan} 只，首次较慢` : '');
  const timer = needMaScan ? setInterval(() => paint('均线扫描中…'), 500) : null;

  try {
    const res = await fetch('/api/screener?' + params.toString());
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);

    const parts = [`扫描 ${d.scanned}`, `行情后 ${d.afterMarketFilters}`];
    if (d.tagStage) parts.push(`标签后 ${d.tagStage.after}`);
    if (d.maStage) {
      parts.push(`均线扫 ${d.maStage.scanned}（${(d.maStage.elapsedMs / 1000).toFixed(1)}s）→ ${d.maStage.matched}`);
    }
    parts.push(`估值 ${d.enriched}`, `命中 <b>${d.matched}</b>`);

    const extras = [];
    if (d.tagStage) {
      const pools = [];
      if (d.tagStage.limitUpPool !== null) pools.push(`涨停池 ${d.tagStage.limitUpPool}`);
      if (d.tagStage.limitBreakPool !== null) pools.push(`炸板池 ${d.tagStage.limitBreakPool}`);
      if (d.tagStage.limitDownPool !== null) pools.push(`跌停池 ${d.tagStage.limitDownPool}`);
      if (d.tagStage.dragonTigerPool !== null) pools.push(`龙虎榜 ${d.tagStage.dragonTigerPool}`);
      if (d.tagStage.hotPool !== null) pools.push(`热榜 ${d.tagStage.hotPool}`);
      if (d.tagStage.anomalyPool !== null) pools.push(`异动 ${d.tagStage.anomalyPool}`);
      if (pools.length) extras.push(pools.join(' / '));
    }
    if (d.maStage?.noHistory) extras.push(`${d.maStage.noHistory} 只上市不足 60 日被跳过`);
    // 异动接口只提供「当日」数据且没有日期参数，非交易日/盘前必然为空 —— 说明白，
    // 否则用户会以为是筛选器坏了
    if (d.tagStage && d.tagStage.anomalyPool === 0) {
      extras.push('异动接口只提供当日数据（无日期参数），今天非交易日或数据未就绪，故为空');
    }
    for (const n of d.notes ?? []) extras.push(n);

    el.screenerCount.textContent = String(d.matched);
    el.screenerStatus.innerHTML =
      `${parts.join(' → ')}<br><span class="dim">总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s</span>` +
      (extras.length ? `<br><span class="warn">${extras.join('；')}</span>` : '');
    renderScreenerRows(d.rows, d.maStage?.ref ?? (needMaScan ? 20 : null));
  } catch (err) {
    el.screenerStatus.innerHTML = `<span class="warn">筛选失败：${err.message}</span>`;
    el.screenerCount.textContent = '—';
  } finally {
    if (timer) clearInterval(timer);
  }
}

function renderScreenerRows(rows, maRef) {
  if (!rows?.length) {
    el.screenerResults.innerHTML = '<div class="rv-empty">没有符合条件的股票</div>';
    return;
  }
  const hasMa = rows.some((r) => r.ma);
  const hasTags = rows.some((r) => r.tags?.length);
  const ref = maRef ?? 20;
  const devCell = (v) => {
    if (v === null || v === undefined) return '<span class="dim">—</span>';
    const cls = v > 0 ? 'up' : 'down';
    return `<span class="${cls}">${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%</span>`;
  };
  const alignCell = (a) =>
    a === 'bull' ? '<span class="up">多头</span>' : a === 'bear' ? '<span class="down">空头</span>' : '<span class="dim">—</span>';

  el.screenerResults.innerHTML = `<table class="rv"><thead><tr>
      <th>名称</th>${hasTags ? '<th>标签</th>' : ''}<th>现价</th><th>涨跌</th><th>成交额</th><th>PE</th><th>PB</th>
      ${hasMa ? `<th>MA${ref}偏离</th><th>排列</th>` : ''}
    </tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td>${stk(r)}</td>
      ${hasTags ? `<td class="c">${(r.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>` : ''}
      <td class="r">${n2(r.last_price)}</td>
      <td class="r ${r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : ''}">${r.pct > 0 ? '+' : ''}${r.pct?.toFixed(2)}%</td>
      <td class="r">${r.amountYi?.toFixed(2)}亿</td>
      <td class="r">${r.pe_ttm === null ? '—' : Number(r.pe_ttm).toFixed(1)}</td>
      <td class="r">${r.pb_mrq === null ? '—' : Number(r.pb_mrq).toFixed(2)}</td>
      ${hasMa ? `<td class="r">${devCell(r.ma?.[`dev${ref}`])}</td><td class="c">${alignCell(r.ma?.align)}</td>` : ''}
    </tr>`).join('')}
  </tbody></table>
  ${hasMa ? `<div class="hint">偏离为正 = 价格在 MA${ref} 上方；排列指 MA5&gt;10&gt;20&gt;30&gt;60（多头）或反之（空头）。点股票名可在右侧看图。</div>` : ''}`;
}

// ---------------------------------------------------------------- 策略回测

async function runBacktest() {
  const params = new URLSearchParams();
  const codes = $('bt-codes').value.trim();
  if (codes) params.set('thscodes', codes);
  params.set('fast', $('bt-fast').value || '5');
  params.set('slow', $('bt-slow').value || '20');
  params.set('days', $('bt-days').value || '730');
  params.set('capital', $('bt-capital').value || '100000');
  params.set('fee', $('bt-fee').value || '0.0003');

  el.btStatus.textContent = '回测中…（逐只取历史 K 线，请稍候）';
  el.btCount.textContent = '…';
  try {
    const res = await fetch('/api/backtest?' + params.toString());
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
    state.tradesByCode = d.tradesByCode ?? {};
    el.btCount.textContent = String(d.rows.length);
    const errs = Object.keys(d.errors ?? {});
    el.btStatus.innerHTML =
      `MA${d.params.fast}／MA${d.params.slow} · ${d.params.days} 天 · 手续费 ${(d.params.fee * 100).toFixed(3)}%` +
      (errs.length ? `<br><span class="warn">跳过 ${errs.length} 只：${errs.join('、')}</span>` : '');
    renderBacktestRows(d.rows);
    // 自动选中第一只，右侧立刻显示买卖点标记
    if (d.rows.length) selectStock(d.rows[0].thscode);
  } catch (err) {
    el.btStatus.innerHTML = `<span class="warn">回测失败：${err.message}</span>`;
    el.btCount.textContent = '—';
  }
}

function renderBacktestRows(rows) {
  if (!rows?.length) {
    el.btResults.innerHTML = '<div class="rv-empty">没有可回测的结果</div>';
    return;
  }
  el.btResults.innerHTML = `<table class="rv"><thead><tr>
      <th>名称</th><th>收益</th><th>年化</th><th>回撤</th><th>交易</th><th>胜率</th><th>持有</th>
    </tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td>${stk(r)}${r.openPosition ? '<i class="pos">持仓中</i>' : ''}</td>
      <td class="r ${r.totalReturnPct > 0 ? 'up' : 'down'}">${r.totalReturnPct > 0 ? '+' : ''}${r.totalReturnPct.toFixed(1)}%</td>
      <td class="r">${r.annualizedPct === null ? '—' : `${r.annualizedPct > 0 ? '+' : ''}${r.annualizedPct.toFixed(1)}%`}</td>
      <td class="r dim">-${r.maxDrawdownPct.toFixed(1)}%</td>
      <td class="r">${r.tradeCount}</td>
      <td class="r">${r.winRatePct === null ? '—' : `${r.winRatePct.toFixed(0)}%`}</td>
      <td class="r dim">${r.buyHoldPct === null ? '—' : `${r.buyHoldPct > 0 ? '+' : ''}${r.buyHoldPct.toFixed(1)}%`}</td>
    </tr>`).join('')}
  </tbody></table>
  <div class="hint">「持有」= 同期买入并持有的收益。策略跑不赢它，就说明这套参数没有产生超额收益。</div>`;
}

// ---------------------------------------------------------------- 价格预警

/**
 * 铃声本体在 public/ring.js（AlertRing）：一段三音上行的「叮-咚-叮」，
 * 默认**连响三遍**（约 3.9 秒）。独立成文件是为了能在 Node 里用 AudioContext 桩
 * 断言"响几遍、间隔多久"，而不是只靠耳朵听一遍。
 */
function playAlertRing() {
  if (!window.AlertRing) return false;
  return Boolean(window.AlertRing.play({ times: 3 }));
}

function stopAlertRing() {
  try {
    window.AlertRing?.stop?.();
  } catch {
    /* 静音失败不影响别的 */
  }
}

// 浏览器要求音频必须由用户手势解锁：第一下点击把 AudioContext 建起来；
// 之后每一下点击都顺手把正在响的铃声掐掉（响三遍约 3.9 秒，太吵就点一下）。
document.addEventListener('pointerdown', () => {
  try {
    window.AlertRing?.unlock?.();
    stopAlertRing();
  } catch {
    /* 忽略 */
  }
});

function dirText(direction) {
  return direction === 'above' ? '涨到' : '跌到';
}
function dirSymbol(direction) {
  return direction === 'above' ? '≥' : '≤';
}

function showAlertToast(ev) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.innerHTML = `
    <div class="toast-head">🔔 价格预警触发</div>
    <div class="toast-body">
      <b>${esc(ev.name || ev.thscode)}</b> <span class="dim small">${esc(ev.thscode)}</span><br>
      ${dirText(ev.direction)} <b>${dirSymbol(ev.direction)}${esc(ev.target)}</b> 已满足 ·
      现价 <b>${esc(ev.price)}</b>
      ${ev.note ? `<br><span class="dim small">${esc(ev.note)}</span>` : ''}
      <br><span class="dim small">${fmtTime(ev.at)} · 点这里看 K 线</span>
    </div>
    <button class="toast-x" title="关闭">×</button>`;
  div.addEventListener('click', (e) => {
    if (e.target.closest('.toast-x')) {
      div.remove();
      return;
    }
    switchView('watchlist');
    selectStock(ev.thscode);
    div.remove();
  });
  el.toastWrap.appendChild(div);
  setTimeout(() => div.remove(), 30000);
}

/** 把服务端还没确认过的触发事件弹出来，然后回执确认（刷新页面不会重复弹）。 */
function handleAlertEvents(events) {
  const fresh = (events ?? []).filter((e) => !alertState.shownEvents.has(e.id));
  if (!fresh.length) return;
  for (const e of fresh) {
    alertState.shownEvents.add(e.id);
    showAlertToast(e);
  }
  playAlertRing(); // 一段铃声连响三遍；嫌吵就在页面任意处点一下静音
  fetch('/api/alerts/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: fresh.map((e) => e.id) }),
  }).catch(() => { /* 回执失败最多是刷新后再弹一次，不打断 */ });
}

async function loadAlerts({ silent = false } = {}) {
  try {
    const res = await fetch('/api/alerts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    alertState.items = data.items ?? [];
    alertState.monitor = data.monitor ?? null;
    handleAlertEvents(data.events ?? []);
    if (state.view === 'alerts') renderAlerts();
  } catch (err) {
    if (!silent) el.alertMonitor.innerHTML = `<span class="bad">预警加载失败：${esc(err.message)}</span>`;
  }
}

function renderAlertMonitor() {
  const m = alertState.monitor;
  if (!m) {
    el.alertMonitor.textContent = '—';
    return;
  }
  const bits = [];
  bits.push(`<span class="${m.session?.open ? 'down' : 'dim'}">${esc(m.session?.label ?? '—')}</span>`);
  bits.push(`<span class="dim">上海时间 ${esc(m.session?.time ?? '')}</span>`);
  if (m.lastError) {
    bits.push(`<span class="bad">最近一次取价失败：${esc(m.lastError)}</span>`);
  } else if (m.lastCheckAt) {
    bits.push(`<span class="dim">最近检查 ${fmtTime(m.lastCheckAt)} · 每 ${Math.round((m.intervalMs ?? 10000) / 1000)} 秒</span>`);
  }
  bits.push(`<span class="dim">服务端已触发 ${m.triggers ?? 0} 次</span>`);
  el.alertMonitor.innerHTML = bits.join('<br>');
}

function renderAlerts() {
  renderAlertMonitor();
  const items = alertState.items ?? [];
  el.alertCount.textContent = String(items.filter((a) => a.enabled && !a.triggeredAt).length);
  if (!items.length) {
    el.alertList.innerHTML =
      '<div class="rv-empty">还没有预警。上面填「股票 / 方向 / 目标价」就能加一条。</div>';
    return;
  }
  el.alertList.innerHTML = `<table class="rv"><thead><tr>
      <th>股票</th><th>条件</th><th class="r">现价</th><th class="r">距离目标</th><th>状态</th><th></th>
    </tr></thead><tbody>
    ${items.map((a) => {
      const gap =
        a.gapToTarget === null
          ? '<span class="dim">—</span>'
          : a.gapToTarget <= 0
            ? '<span class="warn">已满足</span>'
            : `${a.gapToTarget.toFixed(2)}<span class="dim small"> ${((a.gapToTarget / a.last_price) * 100).toFixed(1)}%</span>`;
      const pct =
        a.price_change_ratio_pct === null || a.price_change_ratio_pct === undefined
          ? ''
          : `<span class="small ${pctClass(a.price_change_ratio_pct)}"> ${signPct(a.price_change_ratio_pct)}</span>`;
      const status = !a.enabled
        ? '<span class="dim">已停用</span>'
        : a.triggeredAt
          ? '<span class="warn">已触发</span>'
          : '<span class="down">监控中</span>';
      return `<tr>
        <td>${stk(a)}<div class="dim small">${esc(a.note ?? '')}</div></td>
        <td>${dirText(a.direction)} ${dirSymbol(a.direction)}<b>${a.target}</b></td>
        <td class="r">${n2(a.last_price)}${pct}</td>
        <td class="r">${gap}</td>
        <td>${status}${a.triggeredAt ? `<div class="dim small">${fmtTime(a.triggeredAt)} @ ${n2(a.triggeredPrice)}</div>` : ''}</td>
        <td class="r">
          ${a.triggeredAt ? `<button class="mini" data-act="reset" data-id="${a.id}" title="复位后可再次触发">复位</button>` : ''}
          <button class="mini" data-act="${a.enabled ? 'disable' : 'enable'}" data-id="${a.id}">${a.enabled ? '停用' : '启用'}</button>
          <button class="mini danger" data-act="delete" data-id="${a.id}" title="删除">×</button>
        </td>
      </tr>`;
    }).join('')}
  </tbody></table>
  <div class="hint">「距离目标」为正表示还没到，为负（已满足）表示现价已越过目标价。</div>`;
}

async function addAlert() {
  const input = el.alInput.value.trim();
  const target = Number(el.alTarget.value);
  if (!input) {
    el.alertStatus.innerHTML = '<span class="bad">请先填股票代码或名称</span>';
    return;
  }
  if (!Number.isFinite(target) || target <= 0) {
    el.alertStatus.innerHTML = '<span class="bad">目标价要填正数</span>';
    return;
  }
  el.alAdd.disabled = true;
  el.alertStatus.textContent = '添加中…';
  try {
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        direction: el.alDirection.value,
        target,
        note: el.alNote.value.trim(),
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
    const parts = [];
    if (d.added?.length) {
      parts.push(
        `<span class="ok">已添加：${d.added
          .map((a) => `${esc(a.name || a.thscode)} ${dirText(a.direction)} ${dirSymbol(a.direction)}${a.target}`)
          .join('、')}</span>`,
      );
      el.alInput.value = '';
      el.alNote.value = '';
    }
    for (const s of d.skipped ?? []) parts.push(`<span class="dim">${esc(s.name || s.thscode)}：${esc(s.reason)}</span>`);
    for (const w of d.warnings ?? []) parts.push(`<span class="warn">${esc(w)}</span>`);
    if (d.failed?.length) parts.push(`<span class="bad">未识别：${d.failed.map((f) => esc(f.token)).join('、')}</span>`);
    el.alertStatus.innerHTML = parts.join('<br>') || '没有变化';
    alertState.items = d.items ?? alertState.items;
    alertState.monitor = d.monitor ?? alertState.monitor;
    handleAlertEvents(d.events ?? []);
    renderAlerts();
  } catch (err) {
    el.alertStatus.innerHTML = `<span class="bad">添加失败：${esc(err.message)}</span>`;
  } finally {
    el.alAdd.disabled = false;
  }
}

async function checkAlertsNow() {
  el.alertStatus.textContent = '检查中…（会真的取一次行情，条件满足就触发）';
  try {
    const res = await fetch('/api/alerts/check', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
    alertState.items = d.items ?? [];
    alertState.monitor = d.monitor ?? null;
    handleAlertEvents(d.events ?? []);
    renderAlerts();

    const rows = (d.items ?? []).filter((a) => a.enabled && !a.triggeredAt);
    const lines = rows.length
      ? rows.map((a) => {
          const cond = `${dirText(a.direction)} ${dirSymbol(a.direction)}${a.target}`;
          if (a.last_price === null) return `${a.name || a.thscode}：取不到行情（停牌或代码有问题）`;
          const gap = a.gapToTarget;
          return (
            `${a.name || a.thscode} 现价 ${a.last_price}，目标 ${cond}，` +
            (gap <= 0 ? '已满足' : `还差 ${gap.toFixed(2)}（${((gap / a.last_price) * 100).toFixed(1)}%）`)
          );
        })
      : ['没有启用中的预警'];
    el.alertStatus.innerHTML =
      `<span class="dim">${esc(d.session?.label ?? '')} · 判定 ${d.checked ?? 0} 条</span><br>` +
      lines.map((l) => `<span class="dim">${esc(l)}</span>`).join('<br>');
  } catch (err) {
    el.alertStatus.innerHTML = `<span class="bad">检查失败：${esc(err.message)}</span>`;
  }
}

// ---------------------------------------------------------------- 事件绑定

el.addBtn.addEventListener('click', addStocks);
el.addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addStocks();
});
el.refreshBtn.addEventListener('click', () => loadQuotes());

// 视图切换
el.viewbar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) switchView(btn.dataset.view);
});

// 复盘面板：点股票名 → 切右侧图表；点龙虎榜档位 → 重新取数
el.reviewRefresh.addEventListener('click', () => {
  loadReview(el.reviewDateInput.value || undefined);
  loadDragon(state.dragonBoard);
});
el.reviewDateInput.addEventListener('change', () => {
  loadReview(el.reviewDateInput.value || undefined);
  loadDragon(state.dragonBoard);
});
el.reviewPanels.addEventListener('click', (e) => {
  const link = e.target.closest('.stk');
  if (link) {
    e.preventDefault();
    selectStock(link.dataset.code);
    return;
  }
  const board = e.target.closest('button[data-board]');
  if (board) loadDragon(board.dataset.board);
});

// 把当前查看的股票加入自选
el.addCurrent.addEventListener('click', async () => {
  if (!state.selected) return;
  const code = state.selected;
  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await loadQuotes({ silent: true });
    renderHeader();
  } catch (err) {
    console.error('加入自选失败', err);
  }
});

// 选股筛选
$('fs-run').addEventListener('click', runScreener);
$('fs-excludeSt').addEventListener('change', runScreener);
for (const id of Object.values(SCREENER_FIELDS)) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runScreener();
  });
}
// 均线条件的输入框回车即筛选
for (const id of ['fs-maDevMin', 'fs-maDevMax', 'fs-maScan']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runScreener();
  });
}
// 一键预设（低于 MA60 20% / 不低于 MA60）
document.querySelectorAll('[data-ma-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = MA_PRESETS[btn.dataset.maPreset];
    if (!preset) return;
    if (preset.ref !== undefined) {
      $('fs-maRef').value = preset.ref;
      $('fs-maDevMin').value = preset.devMin ?? '';
      $('fs-maDevMax').value = preset.devMax ?? '';
    }
    if (preset.cross) {
      $('fs-maCross').value = preset.cross;
      $('fs-maCrossWithin').value = '5';
    }
    btn.closest('details')?.setAttribute('open', ''); // 展开该分类，让用户看到填了什么
    runScreener();
  });
});
el.screenerResults.addEventListener('click', (e) => {
  const link = e.target.closest('.stk');
  if (link) {
    e.preventDefault();
    selectStock(link.dataset.code);
  }
});

// 策略回测
$('bt-run').addEventListener('click', runBacktest);
for (const id of ['bt-codes', 'bt-fast', 'bt-slow', 'bt-days', 'bt-capital', 'bt-fee']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runBacktest();
  });
}
el.btResults.addEventListener('click', (e) => {
  const link = e.target.closest('.stk');
  if (link) {
    e.preventDefault();
    selectStock(link.dataset.code);
  }
});

// 价格预警
el.alAdd.addEventListener('click', addAlert);
el.alCheck.addEventListener('click', checkAlertsNow);
el.alBeep.addEventListener('click', () => {
  const r = window.AlertRing?.play({ times: 3 });
  el.alertStatus.innerHTML = r
    ? `<span class="dim">铃声已播放：三音一段（${window.AlertRing.NOTES.map((n) => Math.round(n.freq)).join('/')} Hz）、` +
      `连响 ${r.times} 遍、共约 ${(r.durationMs / 1000).toFixed(1)} 秒。` +
      `想立刻安静就在页面任意位置点一下；听不到请检查系统音量与标签页是否被静音。</span>`
    : '<span class="bad">当前浏览器不支持 WebAudio，出不了声</span>';
});
for (const node of [el.alInput, el.alTarget, el.alNote]) {
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAlert();
  });
}
el.alertList.addEventListener('click', async (e) => {
  const link = e.target.closest('.stk');
  if (link) {
    e.preventDefault();
    selectStock(link.dataset.code);
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  btn.disabled = true;
  try {
    const res =
      act === 'delete'
        ? await fetch(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' })
        : await fetch(`/api/alerts/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: act }),
          });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
    alertState.items = d.items ?? [];
    alertState.monitor = d.monitor ?? alertState.monitor;
    renderAlerts();
    el.alertStatus.innerHTML = `<span class="dim">已${act === 'delete' ? '删除' : act === 'reset' ? '复位' : act === 'enable' ? '启用' : '停用'}</span>`;
  } catch (err) {
    el.alertStatus.innerHTML = `<span class="bad">操作失败：${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// 周期 / 区间 / 复权：两套工具条（单图 + 四宫格）用同一个委托处理器，
// 保证点哪边的按钮都会同步另一边的激活态
document.addEventListener('click', (e) => {
  const period = e.target.closest('button[data-period]');
  if (period) {
    state.period = period.dataset.period;
    syncGroups();
    reloadCharts();
    return;
  }
  const days = e.target.closest('button[data-days]');
  if (days) {
    state.days = Number(days.dataset.days);
    syncGroups();
    reloadCharts();
    return;
  }
  const adjust = e.target.closest('button[data-adjust]');
  if (adjust) {
    state.adjust = adjust.dataset.adjust;
    syncGroups();
    reloadCharts();
  }
});

// 十字光标由 KlineChart 组件自己处理，这里只负责窗口尺寸变化后的重绘
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawAllCharts, 120);
});

// ---------------------------------------------------------------- 启动

syncGroups();
loadQuotes();
setInterval(() => loadQuotes({ silent: true }), 15000);

// 价格预警：与自选股行情各自轮询。这个接口只读服务端内存（不打上游），所以可以取 5 秒。
loadAlerts();
setInterval(() => loadAlerts({ silent: true }), 5000);

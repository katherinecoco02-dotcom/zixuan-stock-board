/**
 * 图表组件测试（无需浏览器）
 *
 * 用 canvas 桩把 public/chart.js 的 KlineChart 在 Node 里跑起来，验证：
 *  - 缩放数学：锚点保持、右边缘保持、上下限钳制
 *  - **各图独立**：缩放一张图不影响另一张（四宫格"单独收缩"的核心要求）
 *  - onViewChange 回调会触发（界面上的根数计数靠它刷新）
 *  - 空数据 / 单根 / 无几何缓存时滚轮操作不崩溃
 *  - 附带效果：draw() 的完整绘图路径被真实执行，能抓到运行时异常
 *
 * 用法：node scripts/chart-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHART_JS = fileURLToPath(new URL('../public/chart.js', import.meta.url));

// ---- canvas 桩：只保证绘图调用不报错，不校验像素
globalThis.window = { devicePixelRatio: 1 };
const noop = () => {};
const ctxStub = new Proxy({}, {
  get(_t, key) {
    if (key === 'measureText') return () => ({ width: 30 });
    return noop;
  },
  set() { return true; },
});

function makeCanvas(w = 800, h = 400) {
  const listeners = {};
  return {
    width: 0,
    height: 0,
    getContext: () => ctxStub,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    parentElement: { clientWidth: w, clientHeight: h },
    _listeners: listeners,
  };
}

// chart.js 是普通脚本（IIFE，挂在 window 上），用 eval 载入
eval(readFileSync(CHART_JS, 'utf8'));
const KlineChart = globalThis.window.KlineChart;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

// 300 根，displayStartMs 落在第 100 根 → 默认窗口 200 根
const items = Array.from({ length: 300 }, (_, i) => ({
  date_ms: Date.UTC(2024, 0, 1) + i * 86400000,
  open_price: 10 + i * 0.1,
  high_price: 10.5 + i * 0.1,
  low_price: 9.5 + i * 0.1,
  close_price: 10.2 + i * 0.1,
  volume: 1000 + i,
}));
const displayStartMs = items[100].date_ms;

const chartA = new KlineChart(makeCanvas(800, 400), { compact: false });
const chartB = new KlineChart(makeCanvas(800, 400), { compact: true });
let viewChanges = 0;
const chartC = new KlineChart(makeCanvas(), { onViewChange: () => { viewChanges += 1; } });
chartA.setData({ items, displayStartMs });
chartB.setData({ items, displayStartMs });
chartC.setData({ items, displayStartMs });

const wheel = (chart, deltaY, clientX) => chart._onWheel({ deltaY, clientX, preventDefault() {} });

console.log('=== 1) 初始状态 ===');
ok(chartA.visibleCount() === 200, `默认窗口 = 200 根（实际 ${chartA.visibleCount()}）`);
ok(chartA.zoomCount === null, 'zoomCount 初始为 null（未缩放）');

console.log('\n=== 2) 独立缩放：只影响自己那张图 ===');
const beforeB = chartB.visibleCount();
wheel(chartA, -100, 700);
ok(chartA.visibleCount() < 200, `A 图缩放到 ${chartA.visibleCount()} 根（<200）`);
ok(chartB.visibleCount() === beforeB && chartB.zoomCount === null,
  `B 图不受影响，仍为 ${chartB.visibleCount()} 根（"单独收缩"的核心要求）`);

console.log('\n=== 3) 锚点：光标下的那根 K 线应基本不动 ===');
const padL = 6;
const padR = 74;
const rel = (700 - padL) / (800 - padL - padR);
const beforeFocus = rel * 200;
const afterFocus = chartA.zoomStart + rel * chartA.zoomCount;
ok(Math.abs(beforeFocus - afterFocus) < 1.5,
  `锚点保持：${beforeFocus.toFixed(2)} → ${afterFocus.toFixed(2)}（偏差 ${Math.abs(beforeFocus - afterFocus).toFixed(2)} 根）`);

console.log('\n=== 4) 在右端放大不应露出空白 ===');
ok(chartA.zoomStart + chartA.zoomCount >= 199,
  `可见区间 [${chartA.zoomStart}, ${chartA.zoomStart + chartA.zoomCount - 1}] 贴着最新一根（下标 199）`);

console.log('\n=== 5) 边界钳制 ===');
for (let i = 0; i < 60; i++) wheel(chartA, -100, 400);
ok(chartA.visibleCount() >= 8, `一直放大仍 >= 8 根（实际 ${chartA.visibleCount()}）`);
ok(chartA.zoomStart >= 0, `起始下标不为负（${chartA.zoomStart}）`);
for (let i = 0; i < 80; i++) wheel(chartA, 100, 400);
ok(chartA.visibleCount() === 200, `一直缩小 = 200 根上限（实际 ${chartA.visibleCount()}）`);
ok(chartA.zoomStart >= 0 && chartA.zoomStart + chartA.zoomCount <= 200,
  `可见区间未越界：[${chartA.zoomStart}, ${chartA.zoomStart + chartA.zoomCount - 1}]`);

console.log('\n=== 6) 双击复位 ===');
wheel(chartA, -100, 700);
const zoomed = chartA.visibleCount();
chartA.resetZoom();
ok(zoomed < 200 && chartA.visibleCount() === 200, `复位：${zoomed} → ${chartA.visibleCount()} 根`);
ok(chartA.zoomCount === null && chartA.zoomStart === null, 'zoomCount / zoomStart 均回到 null');

console.log('\n=== 7) onViewChange 回调（界面根数计数依赖它）===');
const c0 = viewChanges;
wheel(chartC, -100, 700);
ok(viewChanges > c0, `缩放后回调触发（${c0} → ${viewChanges}）`);
chartC.resetZoom();
ok(viewChanges > c0 + 1, `复位也触发回调（→ ${viewChanges}）`);

console.log('\n=== 8) 异常输入不崩溃 ===');
const chartD = new KlineChart(makeCanvas(), {});
chartD.setData({ items: [], displayStartMs: 0 });
ok(chartD.visibleCount() === 0, '空序列：visibleCount = 0，未抛异常');
chartD.setData({ items: [items[0]], displayStartMs: 0 });
ok(chartD.visibleCount() === 0, '单根：不绘制、不抛异常');
wheel(chartD, -100, 400);
ok(true, '无几何缓存时滚轮操作安全返回');

console.log('\n=== 9) 切换股票后缩放级别保留、但窗口回到最新 ===');
wheel(chartB, -100, 700);
const keepCount = chartB.zoomCount;
const other = items.map((b, i) => ({ ...b, close_price: b.close_price + 1, date_ms: b.date_ms + 86400000 * 30 }));
chartB.setData({ items: other, displayStartMs: other[100].date_ms });
ok(chartB.zoomCount === keepCount, `缩放级别保留（${keepCount} 根）`);
ok(chartB.zoomStart === null || chartB.zoomStart + chartB.zoomCount === chartB._geomCache.n,
  '切换标的后窗口右对齐到最新一根');

console.log('\n=== 10) 均线配置：完整视图含 MA30，四宫格不含 ===');
const aMas = chartA._geomCache.maView.map((m) => m.period);
const bMas = chartB._geomCache.maView.map((m) => m.period);
ok(JSON.stringify(aMas) === JSON.stringify([5, 10, 20, 30, 60]), `完整视图均线 = ${aMas.join(' / ')}`);
ok(bMas.length === 4 && !bMas.includes(30), `四宫格（compact）保持 4 条且不含 MA30 = ${bMas.join(' / ')}`);
ok(window.KLINE_MA_STYLE.some((m) => m.period === 30), '导出的 KLINE_MA_STYLE（底部图例用）含 MA30');

console.log('\n=== 11) MA30 数值正确性：与手工均值逐位比对 ===');
const view = chartA._geomCache.view;
const maView = chartA._geomCache.maView;
const ma30 = maView.find((m) => m.period === 30).values;
ok(ma30.length === view.length, `MA30 长度与可见根数一致（${ma30.length}）`);

// 逐根回算 MA30：均值应等于该根及前 29 根的收盘均值
let mismatch = 0;
let firstBad = null;
for (let i = 0; i < view.length; i++) {
  if (ma30[i] === null) continue;
  const fullIdx = items.findIndex((it) => it.date_ms === view[i].date_ms);
  const expect = items.slice(fullIdx - 29, fullIdx + 1).reduce((s, b) => s + Number(b.close_price), 0) / 30;
  if (Math.abs(ma30[i] - expect) > 1e-9) {
    mismatch += 1;
    if (firstBad === null) firstBad = { i, got: ma30[i], expect };
  }
}
ok(mismatch === 0,
  mismatch === 0
    ? `全部 ${ma30.filter((v) => v !== null).length} 个 MA30 取值与手工均值完全一致`
    : `${mismatch} 个取值不符，首个：下标 ${firstBad.i} 得 ${firstBad.got} 应为 ${firstBad.expect}`);

console.log('\n=== 12) 均线图例数值取自"当前可见的最后一根" ===');
const legendIdx = view.length - 1;
ok(Math.abs(ma30[legendIdx] - items.slice(-30).reduce((s, b) => s + Number(b.close_price), 0) / 30) < 1e-9,
  '最新一根的 MA30 = 最近 30 根收盘均值');

console.log('\n=== 13) 真实数据：均线预热是否够用（需服务在跑；未运行则跳过，不计失败）===');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
let live = false;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
  live = r.ok;
} catch {
  live = false;
}

if (!live) {
  console.log(`  ○ ${BASE} 未运行，跳过本节（不影响其余结论）`);
} else {
  // 只有日/周/月要求可见窗口左端就有 MA30；季/年历史本来就不够 30 根，属正常
  for (const period of ['day', 'week', 'month', 'quarter', 'year']) {
    const d = await (await fetch(`${BASE}/api/kline?thscode=600519.SH&days=365&period=${period}`)).json();
    const c = new KlineChart(makeCanvas(900, 420), { compact: false });
    c.setData({ items: d.items, displayStartMs: d.displayStartMs, period });
    const v = c._geomCache.view;
    const ma = c._geomCache.maView;
    const m30 = ma.find((m) => m.period === 30).values;
    const m60 = ma.find((m) => m.period === 60).values;
    const filled30 = m30.filter((x) => x !== null).length;
    const strict = ['day', 'week', 'month'].includes(period);
    const headOk = m30[0] !== null;
    ok(strict ? headOk : true,
      `${period.padEnd(7)} 可见 ${String(v.length).padStart(3)} 根，MA30 有值 ${String(filled30).padStart(3)}/${v.length}` +
      `　MA60 ${m60[0] !== null ? '左端有值' : '左端无值'}${strict ? '' : '（历史不足，正常）'}`);
  }
}

console.log('\n=== 14) 尺寸过小时不绘制（四宫格折叠成细条的场景）===');
const liveWrap = { clientWidth: 900, clientHeight: 400 };
const canvasE = {
  width: 0,
  height: 0,
  getContext: () => ctxStub,
  addEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: liveWrap.clientWidth, height: liveWrap.clientHeight }),
  parentElement: liveWrap,
};
const chartE = new KlineChart(canvasE, { compact: true });
chartE.setData({ items, displayStartMs });
ok(chartE.visibleCount() > 0, `展开状态正常绘制（${chartE.visibleCount()} 根）`);

liveWrap.clientHeight = 27;          // 折叠成表头一条
chartE.draw();
ok(chartE.visibleCount() === 0, '折叠后（高 27px）跳过绘制，visibleCount = 0');

liveWrap.clientHeight = 400;         // 重新展开
chartE.draw();
ok(chartE.visibleCount() > 0, `展开后重绘恢复正常（${chartE.visibleCount()} 根）`);

liveWrap.clientHeight = 27;
chartE.draw();
wheel(chartE, -100, 400);
ok(true, '折叠状态下滚轮缩放安全返回（不会在 0 尺寸上算锚点）');

liveWrap.clientWidth = 30;           // 宽度也不足时同样跳过
liveWrap.clientHeight = 400;
chartE.draw();
ok(chartE.visibleCount() === 0, '宽度不足（30px）时同样跳过绘制');

console.log('\n=== 15) 分时模式：时间轴映射 ===');
// 造一个交易日的 6 个点：9:30 / 10:30 / 11:30 / 13:00 / 14:00 / 15:00
const shSec = (h, m) => Math.floor(Date.UTC(2026, 8, 14, h - 8, m, 0) / 1000);
const intraday = {
  date: '2026-09-14',
  prevClose: 100,
  t: [shSec(9, 30), shSec(10, 30), shSec(11, 30), shSec(13, 0), shSec(14, 0), shSec(15, 0)],
  p: [100, 102, 101, 101.5, 98, 99],
  v: [1000, 2000, 3000, 3500, 4000, 5000],
  to: [100000, 203000, 303000, 353500, 391500, 494000],
  avg: [100, 101.5, 101, 101.14, 97.88, 98.8],
  m: [0, 60, 120, 120, 180, 240],
};
const canvasI = makeCanvas(900, 420);
const chartI = new KlineChart(canvasI, { compact: false });
chartI.setIntraday(intraday);

ok(chartI.isIntraday === true, 'setIntraday 后进入分时模式');
const gi = chartI._geomCache;
ok(Boolean(gi) && gi.intraday === true, '几何缓存标记为 intraday');
ok(gi.n === 6, `点数 = ${gi.n}`);

const iL = 6;
const iR = 80;
const x0 = iL;
const x240 = 900 - iR;
const plotW = x240 - x0;
const near = (a, b, tol = 0.5) => Math.abs(a - b) < tol;
ok(near(gi.xs[0], x0), `9:30 落在最左（${gi.xs[0].toFixed(1)} ≈ ${x0}）`);
ok(near(gi.xs[5], x240), `15:00 落在最右（${gi.xs[5].toFixed(1)} ≈ ${x240}）`);
ok(near(gi.xs[1], x0 + plotW * 0.25), `10:30 在 1/4 处（${gi.xs[1].toFixed(1)}）`);
// 关键性质：中午休市不占宽度，11:30 与 13:00 必须落在同一个 x
ok(near(gi.xs[2], gi.xs[3], 0.01), `11:30 与 13:00 同一位置（${gi.xs[2].toFixed(1)}）—— 休市不占宽度`);
ok(near(gi.xs[2], x0 + plotW * 0.5), `半天分界在正中间（${gi.xs[2].toFixed(1)}）`);

console.log('\n=== 16) 分时：悬停取最近点 + 信息字段 ===');
const rectI = canvasI.getBoundingClientRect();
chartI._onMove({ clientX: rectI.left + gi.xs[4] });
ok(chartI.hoverIndex === 4, `鼠标落在第 5 点 → hoverIndex=${chartI.hoverIndex}`);
const inf = chartI.infoAt(4);
ok(inf.intraday === true, 'infoAt 返回分时形状');
ok(inf.time === '14:00', `时间格式化正确：${inf.time}`);
ok(near(inf.dev, -2, 0.01), `相对昨收偏离：${inf.dev.toFixed(2)}%（98 / 100）`);
ok(near(inf.avgDev, -2.12, 0.05), `均价偏离：${inf.avgDev.toFixed(2)}%`);
ok(near(inf.price, 98, 0.001) && near(inf.avg, 97.88, 0.001), '价格与均价读取正确');

console.log('\n=== 17) 分时：边界与模式切换 ===');
const emptyI = new KlineChart(makeCanvas(900, 420), {});
emptyI.setIntraday({ t: [], p: [] });
ok(emptyI.visibleCount() === 0 && emptyI.isIntraday === false, '空分时：不绘制、不抛异常');

// 从分时切回 K 线，模式必须复位（否则会继续按分时渲染）
chartI.setData({ items, displayStartMs, period: 'day' });
ok(chartI.isIntraday === false, 'setData 后退出分时模式');
ok(chartI.visibleCount() === 200, `K 线恢复正常绘制（${chartI.visibleCount()} 根）`);

// 只有一个点
const oneI = new KlineChart(makeCanvas(900, 420), {});
oneI.setIntraday({ t: [shSec(9, 30)], p: [100], v: [1], avg: [100], m: [0], prevClose: 100 });
ok(oneI._geomCache?.n === 1, '单点分时：几何缓存正常，不抛异常');

// 昨收缺失时应回退用首价做基准，而不是画出 NaN
const noPc = new KlineChart(makeCanvas(900, 420), {});
noPc.setIntraday({
  t: [shSec(9, 30), shSec(10, 0)], p: [50, 51], v: [1, 2], avg: [50, 50.5],
  m: [0, 30], prevClose: null,
});
const infN = noPc.infoAt(1);
ok(Number.isFinite(infN.dev), `昨收缺失时基准回退到首价，偏离 = ${infN.dev.toFixed(2)}%`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

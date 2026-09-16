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
    style: {},                    // 真实 canvas 一定有 style，画笔要靠它改 cursor
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

console.log('\n=== 18) 画笔：坐标映射往返一致 ===');
const canvasP = makeCanvas(900, 420);
const chartP = new KlineChart(canvasP, {});
chartP.setData({ items, displayStartMs, period: 'day' });
const gP = chartP._geomCache;

const iMid = Math.floor(gP.n / 2);
const dMid = gP.view[iMid].date_ms;
const xMid = chartP._xOfDate(dMid);
ok(Math.abs(xMid - gP.x(iMid)) < 0.01,
  `bar 日期 → x 落在该根中心（${xMid.toFixed(1)} vs ${gP.x(iMid).toFixed(1)}）`);
ok(chartP._dateAtX(xMid) === dMid, 'x → 日期 往返一致（吸附回同一根）');

const dA = gP.view[iMid].date_ms;
const dB = gP.view[iMid + 1].date_ms;
const xBetween = chartP._xOfDate((dA + dB) / 2);
ok(xBetween > gP.x(iMid) && xBetween < gP.x(iMid + 1),
  `两根之间按时间插值（${xBetween.toFixed(1)} 落在 ${gP.x(iMid).toFixed(1)}~${gP.x(iMid + 1).toFixed(1)}）`);

const priceMid = (gP.lo + gP.hi) / 2;
const yMid = chartP._yOfPrice(priceMid);
ok(Math.abs(yMid - (gP.priceTop + gP.priceBot) / 2) < 0.5, `中位价 → 绘图区中央（${yMid.toFixed(1)}）`);
ok(Math.abs(chartP._priceAtY(yMid) - priceMid) < 1e-6, 'y → 价格 往返一致');

console.log('\n=== 19) 画笔：画一条直线 ===');
chartP.setDrawTool('line');
chartP.setDrawStyle({ color: '#e5484d', width: 3 });
const y1 = chartP._yOfPrice(gP.lo + (gP.hi - gP.lo) * 0.3);
const y2 = chartP._yOfPrice(gP.lo + (gP.hi - gP.lo) * 0.7);
chartP._onDown({ clientX: gP.x(10), clientY: y1 });
ok(chartP._drawing === true && chartP._draft?.points.length === 2, '按下后生成两点草稿');
chartP._onMove({ clientX: gP.x(60), clientY: y2 });
ok(chartP._draft.points[1].date_ms === chartP._dateAtX(gP.x(60)), '拖动时更新终点');
chartP._onUp();
ok(chartP.annotations.length === 1, `抬起后落成 1 条画记（${chartP.annotations.length}）`);
ok(chartP.annotations[0].color === '#e5484d' && chartP.annotations[0].width === 3, '颜色与粗细被记下');
ok(chartP.annotations[0].points.every((p) => p.price > 0 && p.date_ms > 0), '存的是数据坐标（日期+价格）');

console.log('\n=== 20) 画笔：橡皮擦命中判定 ===');
const pts0 = chartP._annotationPts(chartP.annotations[0]);
const mp = { x: (pts0[0].x + pts0[1].x) / 2, y: (pts0[0].y + pts0[1].y) / 2 };
ok(chartP._hitAnnotation(mp.x, mp.y + 3) === 0, '线附近 3px 命中');
ok(chartP._hitAnnotation(mp.x, mp.y + 60) === -1, '线外 60px 不命中');
chartP.setDrawTool('erase');
chartP._onDown({ clientX: mp.x, clientY: mp.y });
ok(chartP.annotations.length === 0, '橡皮点中后画记被删除');

console.log('\n=== 21) 画笔：自由曲线按像素抽点 ===');
chartP.setDrawTool('free');
const fx = gP.x(10);
const fy = chartP._yOfPrice(gP.lo + (gP.hi - gP.lo) * 0.5);
chartP._onDown({ clientX: fx, clientY: fy });
for (let k = 0; k < 50; k++) chartP._onMove({ clientX: fx, clientY: fy }); // 原地不动 50 次
ok(chartP._draft.points.length === 1, `原地重复事件不增点（${chartP._draft.points.length} 个点）`);
for (let k = 1; k <= 60; k++) chartP._onMove({ clientX: fx + k * 3, clientY: fy + Math.sin(k / 6) * 25 });
chartP._onUp();
const freeAnn = chartP.annotations[0];
ok(freeAnn?.tool === 'free' && freeAnn.points.length > 5,
  `自由曲线落成一条，抽到 ${freeAnn.points.length} 个点`);
ok(freeAnn.points.length < 61, '点数少于事件数（抽稀生效）');

console.log('\n=== 22) 画笔：换窗口后仍按数据坐标定位 ===');
chartP.setDrawTool('line');
chartP._onDown({ clientX: gP.x(20), clientY: y1 });
chartP._onMove({ clientX: gP.x(40), clientY: y2 });
chartP._onUp();
const ann2 = chartP.annotations[chartP.annotations.length - 1];
const snapPts = JSON.stringify(ann2.points);
const xBefore = chartP._xOfDate(ann2.points[0].date_ms);
chartP.setData({ items, displayStartMs: items[150].date_ms, period: 'day' }); // 换成只看后半段
const xAfter = chartP._xOfDate(ann2.points[0].date_ms);
ok(JSON.stringify(chartP.annotations[chartP.annotations.length - 1].points) === snapPts,
  '换窗口后画记的数据坐标没有被改写');
ok(Math.abs(xAfter - xBefore) > 1,
  `同一日期在新窗口里的 x 随之改变（${xBefore.toFixed(0)} → ${xAfter.toFixed(0)}），证明是按数据定位`);

console.log('\n=== 23) 画笔：缩放守卫与一键清除 ===');
const zoomBefore = chartP.visibleCount();
chartP._onWheel({ deltaY: -100, clientX: 400, preventDefault() {} });
ok(chartP.visibleCount() === zoomBefore, '画笔开启时滚轮不缩放');
chartP.setDrawTool(null);
chartP._onWheel({ deltaY: -100, clientX: 400, preventDefault() {} });
ok(chartP.visibleCount() < zoomBefore, `关闭画笔后滚轮恢复缩放（${zoomBefore} → ${chartP.visibleCount()}）`);

const nClear = chartP.clearAnnotations();
ok(nClear >= 1 && chartP.annotations.length === 0, `一键清除清掉 ${nClear} 条`);
ok(chartP._draft === null, '清除时草稿也一并丢弃');

console.log('\n=== 24) 画笔：无数据时不崩 ===');
const bare = new KlineChart(makeCanvas(900, 420), {});
bare.setDrawTool('line');
bare._onDown({ clientX: 100, clientY: 100 });
bare._onMove({ clientX: 200, clientY: 200 });
bare._onUp();
ok(bare.annotations.length === 0, '无数据时画笔操作安全返回，不产生画记');
bare.setAnnotations(null);
ok(Array.isArray(bare.annotations) && bare.annotations.length === 0, 'setAnnotations(null) 归一成空数组');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

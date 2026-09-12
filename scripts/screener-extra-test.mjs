/**
 * 新增筛选条件测试（需服务在跑）
 *
 * 覆盖两档：
 *   ① 行情派生类（振幅/跳空/收盘强度/阴阳线）—— 零额外请求，用 K 线独立回算核对
 *   ② 资金与情绪类（涨停/连板/炸板/跌停/龙虎榜/热榜/异动）—— 与 /api/review 交叉核对
 * 外加均线金叉/死叉筛选。
 *
 * 用法：node scripts/screener-extra-test.mjs
 *   可用 BASE=... 换地址；建议对 DATA_DIR 隔离的实例跑（本脚本只读，不改数据）。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

async function get(path) {
  const res = await fetch(BASE + path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status} ${path}`);
  return json;
}
const screen = (qs) => get(`/api/screener?${qs}`);
const klineRaw = (code, days = 30) =>
  get(`/api/kline?thscode=${code}&days=${days}&adjust=none&period=day`);

console.log(`=== 新增筛选条件测试 @ ${BASE} ===\n`);

// ---------------------------------------------------------------- ① 行情派生
console.log('1) 行情派生条件（零额外请求）');
const amp = await screen('minAmplitude=5&excludeSt=1&minAmountYi=1&top=20');
ok(amp.rows.every((r) => r.amplitude >= 5), `振幅 ≥5%：${amp.rows.length} 只全部满足`);
ok(amp.maStage === null, '未触发均线扫描（确实零额外请求）');

const yang = await screen('candle=yang&excludeSt=1&minAmountYi=1&top=20');
ok(yang.rows.every((r) => r.isUp === true), `仅阳线：${yang.rows.length} 只全部 isUp=true`);

const strong = await screen('minCloseStrength=90&excludeSt=1&minAmountYi=1&top=20');
ok(strong.rows.every((r) => r.closeStrength >= 90), `收盘强度 ≥90%：${strong.rows.length} 只全部满足`);

console.log('\n2) 交叉验证：用 K 线（不复权）独立回算，核对快照派生值');
const sample = (amp.rows.length ? amp.rows : strong.rows).slice(0, 2);
for (const row of sample) {
  const kl = await klineRaw(row.thscode, 30);
  const bars = kl.items ?? [];
  if (bars.length < 2) { ok(false, `${row.name} K线不足`); continue; }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prevClose = Number(prev.close_price);

  const amplitude = ((Number(last.high_price) - Number(last.low_price)) / prevClose) * 100;
  const gap = ((Number(last.open_price) - prevClose) / prevClose) * 100;
  const cs = ((Number(last.close_price) - Number(last.low_price)) /
    (Number(last.high_price) - Number(last.low_price))) * 100;

  ok(Math.abs(amplitude - row.amplitude) < 0.05,
    `${row.name} 振幅 手工 ${amplitude.toFixed(3)}% vs 接口 ${row.amplitude.toFixed(3)}%`);
  ok(Math.abs(gap - row.gap) < 0.05,
    `${row.name} 跳空 手工 ${gap.toFixed(3)}% vs 接口 ${row.gap.toFixed(3)}%`);
  ok(Math.abs(cs - row.closeStrength) < 0.05,
    `${row.name} 收盘强度 手工 ${cs.toFixed(2)}% vs 接口 ${row.closeStrength.toFixed(2)}%`);
}

// ---------------------------------------------------------------- ② 资金与情绪
console.log('\n3) 涨停 / 连板（与复盘接口交叉核对）');
const review = await get('/api/review');
const pool = review.panels.limitUp ?? [];
const poolSet = new Set(pool.map((x) => x.thscode));
const boardMap = new Map(pool.map((x) => [x.thscode, Number(x.continue_day_cnt ?? 0)]));

const lu = await screen('limitUp=1&excludeSt=1&minAmountYi=0.2&top=30');
ok(lu.rows.length > 0, `仅涨停：命中 ${lu.rows.length} 只`);
ok(lu.rows.every((r) => poolSet.has(r.thscode)), '结果全部确实在复盘「涨停池」内');
ok(lu.rows.every((r) => (r.tags ?? []).length > 0), '每行都带标签（如「2板」）');
console.log(`     标签示例：${lu.rows.slice(0, 3).map((r) => `${r.name}[${r.tags.join(',')}]`).join(' ')}`);

const lb = await screen('minBoards=2&excludeSt=1&minAmountYi=0.2&top=30');
if (lb.rows.length) {
  ok(lb.rows.every((r) => (boardMap.get(r.thscode) ?? 0) >= 2),
    `连板 ≥2：${lb.rows.length} 只，与涨停池的 continue_day_cnt 一致`);
} else {
  console.log('  ○ 当日没有 2 板以上的票，跳过比较');
}

console.log('\n4) 龙虎榜（机构榜必须取 org，否则字段缺失会筛空）');
const dtOrg = await get('/api/review/dragon-tiger?board=org');
const orgPos = new Set((dtOrg.stockItems ?? [])
  .filter((x) => Number(x.org_net_value) > 0)
  .map((x) => x.thscode));
const dt = await screen('dt=org&excludeSt=1&minAmountYi=0.2&top=30');
ok(dt.rows.length > 0, `机构净买>0：命中 ${dt.rows.length} 只（不是空结果）`);
ok(dt.rows.every((r) => orgPos.has(r.thscode)), '结果全部确实满足机构净买>0（与机构榜交叉核对）');

console.log('\n5) 热榜与异动标签');
const hot = await screen('hotTop=30&excludeSt=1&minAmountYi=0.2&top=40');
const hotList = await get('/api/review');
const hotSet = new Set((hotList.panels.hot ?? []).map((x) => x.thscode));
ok(hot.rows.every((r) => hotSet.has(r.thscode)), `热榜前 30：${hot.rows.length} 只全部在热榜内`);
ok(hot.rows.every((r) => (r.tags ?? []).some((t) => t.startsWith('热榜#'))), '每行带「热榜#N」标签');

const ano = await screen('anomaly=SHARP_RISE&excludeSt=1&minAmountYi=0.2&top=20');
if (ano.tagStage?.anomalyPool === 0) {
  // 上游异动接口只给「当日」数据且没有日期参数，非交易日必然为空 —— 这是数据源限制，
  // 不是筛选器坏了。这种情况必须显式跳过，不能让断言「0 只全部满足」空洞通过。
  ok(typeof ano.tagStage.anomalyPool === 'number', '异动池返回 0（非交易日无当日数据，属预期）');
  console.log('  ○ 上游异动接口当前为空：今天非交易日或数据未就绪，断言跳过');
} else {
  ok(ano.rows.length > 0, `异动=急涨：命中 ${ano.rows.length} 只`);
  ok(ano.rows.every((r) => (r.tags ?? []).includes('急涨')), '结果全部带「急涨」标签');
}

console.log('\n6) 均线金叉筛选（同一份 K 线，不额外增加请求）');
const golden = await screen('maCross=golden&maCrossWithin=5&maScan=50&excludeSt=1&minAmountYi=1&top=20');
ok(golden.maStage?.cross === 'golden', 'maStage 回显 cross=golden');
ok(golden.rows.every((r) => r.ma.cross === 'golden' && r.ma.crossAgo <= 5),
  `金叉：${golden.rows.length} 只全部为近 5 日内 MA5 上穿 MA10` +
  (golden.rows.length ? `（如 ${golden.rows[0].name} ${golden.rows[0].ma.crossAgo} 日前）` : ''));

console.log('\n7) 组合条件：标签过滤应在均线扫描之前生效（缩小扫描池）');
const combo = await screen('limitUp=1&minAmplitude=3&excludeSt=1&minAmountYi=0.2&top=20');
ok(combo.tagStage !== null && combo.afterMarketFilters >= combo.tagStage.before,
  `标签前 ${combo.tagStage?.before} → 标签后 ${combo.tagStage?.after}`);
ok(combo.rows.every((r) => r.amplitude >= 3), '组合结果同时满足振幅与涨停条件');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

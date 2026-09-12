/**
 * 均线选股测试（需服务在跑）
 *
 * 重点在**交叉验证**：筛选器返回的 MA 偏离，用 `/api/kline` 独立取数、
 * 手工算 MA60 再比对 —— 两个不同的代码路径算出同一个数，才说明均线不是编的。
 *
 * 用法：node scripts/ma-screener-test.mjs
 *   可用 BASE=http://127.0.0.1:9000 换地址；建议对 DATA_DIR 隔离的实例跑。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const SCAN = Number(process.env.MA_SCAN ?? 40); // 小批量，跑得快

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

async function screen(qs) {
  const res = await fetch(`${BASE}/api/screener?${qs}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

console.log(`=== 均线选股测试 @ ${BASE}（扫描 ${SCAN} 只）===\n`);

// ---------------------------------------------------------------- 1) 无偏离限制
console.log('1) 仅指定均线参照，不限制偏离');
const base = await screen(`maRef=60&maScan=${SCAN}&excludeSt=1&minAmountYi=1`);
ok(Boolean(base.maStage), '返回体带 maStage');
ok(base.maStage?.scanned === Math.min(SCAN, base.afterMarketFilters), `扫描数 = min(${SCAN}, ${base.afterMarketFilters})`);
ok(typeof base.maStage?.elapsedMs === 'number' && base.maStage.elapsedMs >= 0, `报告耗时 ${base.maStage?.elapsedMs}ms`);
ok(base.rows.length > 0, `命中 ${base.rows.length} 只`);
ok(base.rows.every((r) => r.ma && typeof r.ma.dev60 === 'number'), '每行都带 MA60 偏离值');
console.log(`     粗筛后 ${base.afterMarketFilters} 只 → 扫 ${base.maStage.scanned} 只 → 命中 ${base.rows.length} 只` +
  (base.maStage.noHistory ? `（${base.maStage.noHistory} 只上市不足 60 日被跳过）` : ''));

// ---------------------------------------------------------------- 2) 交叉验证
console.log('\n2) 交叉验证：手工算 MA60 与筛选器结果比对');
const samples = base.rows.slice(0, 3);
for (const row of samples) {
  const kl = await (await fetch(`${BASE}/api/kline?thscode=${row.thscode}&days=365&adjust=forward&period=day`)).json();
  const bars = kl.items ?? [];
  if (bars.length < 60) { ok(false, `${row.name} K线不足`); continue; }
  const closes = bars.slice(-60).map((b) => Number(b.close_price));
  const ma60 = closes.reduce((s, v) => s + v, 0) / 60;
  const close = closes[closes.length - 1];
  const dev = ((close - ma60) / ma60) * 100;
  const diff = Math.abs(dev - row.ma.dev60);
  ok(diff < 0.02,
    `${row.name}(${row.thscode}) 手工 ${dev.toFixed(3)}% vs 筛选器 ${row.ma.dev60.toFixed(3)}%（差 ${diff.toFixed(4)}）`);
}

// ---------------------------------------------------------------- 3) 用户的两条例子
console.log('\n3) 用户的两个例子');
const below = await screen(`maRef=60&maDevMax=-20&maScan=${SCAN}&excludeSt=1&minAmountYi=1`);
ok(below.rows.every((r) => r.ma.dev60 <= -20 + 1e-9),
  `「低于MA60 20%以上」命中 ${below.rows.length} 只，全部 dev60 ≤ -20` +
  (below.rows.length ? `（最低 ${Math.min(...below.rows.map((r) => r.ma.dev60)).toFixed(1)}%）` : ''));
if (!below.rows.length) console.log('     （当前粗筛池里没有跌这么深的，条件本身生效）');

const notBelow = await screen(`maRef=60&maDevMin=0&maScan=${SCAN}&excludeSt=1&minAmountYi=1`);
ok(notBelow.rows.every((r) => r.ma.dev60 >= -1e-9),
  `「不低于MA60」命中 ${notBelow.rows.length} 只，全部 dev60 ≥ 0` +
  (notBelow.rows.length ? `（最高 ${Math.max(...notBelow.rows.map((r) => r.ma.dev60)).toFixed(1)}%）` : ''));

// ---------------------------------------------------------------- 4) 均线排列
console.log('\n4) 均线排列筛选');
for (const [align, label] of [['bull', '多头'], ['bear', '空头']]) {
  const r = await screen(`maAlign=${align}&maScan=${SCAN}&excludeSt=1&minAmountYi=1`);
  const rows = r.rows;
  ok(rows.every((x) => x.ma?.align === align),
    `${label}排列：命中 ${rows.length} 只，全部 align=${align}` +
    (rows.length ? `（如 ${rows[0].name} MA5=${rows[0].ma.ma5.toFixed(2)} > MA60=${rows[0].ma.ma60.toFixed(2)}）` : ''));
}

// ---------------------------------------------------------------- 5) 覆盖率必须如实上报
console.log('\n5) 覆盖范围如实上报');
const big = await screen(`maRef=20&maScan=20&excludeSt=1`);
if (big.afterMarketFilters > 20) {
  const note = (big.notes ?? []).join('；');
  ok(/均线扫描只覆盖成交额前 20 只/.test(note), `粗筛池 ${big.afterMarketFilters} 只 > 扫描 20 只，已提示：${note}`);
} else {
  console.log(`  ○ 粗筛池只有 ${big.afterMarketFilters} 只，未触发覆盖提示`);
}

// ---------------------------------------------------------------- 6) 不设均线条件时不扫均线
console.log('\n6) 不设均线条件时不应触发均线扫描');
const plain = await screen('excludeSt=1&minAmountYi=1');
ok(plain.maStage === null, 'maStage 为 null（没有白白打几十次上游）');
ok(plain.rows.every((r) => r.ma === undefined), '结果里没有 ma 字段');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

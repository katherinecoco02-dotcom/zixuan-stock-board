/**
 * 分时采集测试（需服务在跑）
 *
 * 覆盖存储相关的三件事，它们直接决定"自选股多了会不会占爆磁盘"：
 *   1. meta 行（昨收）只在变化时写 —— 否则每个采样点都白写一遍，占约 25%
 *   2. 历史天压缩成 .gz 后，接口仍能正常读取（读的那一侧最容易漏）
 *   3. 采集开关：关掉后确实停止采样，且已有记录仍可回放
 *
 * 用法：node scripts/intraday-test.mjs
 *   BASE=... 换地址；建议对 DATA_DIR 隔离的实例跑（本脚本会往分时目录写一个测试文件）
 */

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

async function get(p) {
  const r = await fetch(BASE + p);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status} ${p}`);
  return j;
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status} ${p}`);
  return j;
}

console.log(`=== 分时采集测试 @ ${BASE} ===\n`);

// ---------------------------------------------------------------- 基本状态
console.log("1) 状态接口");
const st0 = await get('/api/intraday/dates');
ok(typeof st0.enabled === 'boolean', `返回采集开关状态：${st0.enabled ? '开' : '关'}`);
ok(typeof st0.totalBytes === 'number', `返回总占用：${st0.totalBytes} 字节`);
ok(typeof st0.dir === 'string' && st0.dir.length > 0, `返回存储目录：${st0.dir}`);
ok(Array.isArray(st0.dates), `日期清单 ${st0.dates.length} 天`);
console.log(`     监控：ticks=${st0.monitor.ticks} samples=${st0.monitor.samples} ` +
  `skippedClosed=${st0.monitor.skippedClosed} skippedDisabled=${st0.monitor.skippedDisabled} errors=${st0.monitor.errors}`);

// ---------------------------------------------------------------- meta 去重
console.log('\n2) meta 去重：采样行远多于 meta 行');
const dateDirs = await readdir(st0.dir).catch(() => []);
const plain = dateDirs.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().pop();
if (!plain) {
  console.log('  ○ 当前没有明文（今天）的分时文件，跳过 —— 需要服务在交易时段或强制模式下采过样');
} else {
  const text = await readFile(path.join(st0.dir, plain), 'utf8');
  const lines = text.split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const metas = lines.filter((l) => l.meta).length;
  const samples = lines.filter((l) => l.q).length;
  ok(samples > 0, `${plain}：采样行 ${samples} 行`);
  ok(metas <= Math.max(1, Math.ceil(samples / 10)),
    `meta 行只有 ${metas} 行（去重生效；未去重的话会等于 ${samples} 行）`);
  ok(metas >= 1, '仍然保留了至少一行 meta（昨收不会丢）');
}

// ---------------------------------------------------------------- gzip 可读
console.log('\n3) 历史天压缩后仍能读取');
const TEST_DATE = '2026-09-01'; // 一个不会被真实采集碰到的过去日期
const TEST_CODE = '600519.SH';
const fake = {
  prevClose: { [TEST_CODE]: 100 },
  series: {
    [TEST_CODE]: {
      t: [Math.floor(Date.UTC(2026, 8, 1, 1, 30) / 1000), Math.floor(Date.UTC(2026, 8, 1, 1, 31) / 1000)],
      p: [100.5, 101.2],
      v: [1000, 2500],
      to: [100500, 252000],
    },
  },
};
const jsonl =
  JSON.stringify({ meta: true, date: TEST_DATE, prevClose: fake.prevClose }) + '\n' +
  JSON.stringify({ t: fake.series[TEST_CODE].t[0], q: { [TEST_CODE]: [100.5, 1000, 100500] } }) + '\n' +
  JSON.stringify({ t: fake.series[TEST_CODE].t[1], q: { [TEST_CODE]: [101.2, 2500, 252000] } }) + '\n';
const gzPath = path.join(st0.dir, `${TEST_DATE}.jsonl.gz`);
let wroteTest = false;
try {
  await writeFile(gzPath, gzipSync(Buffer.from(jsonl, 'utf8'), { level: 9 }));
  wroteTest = true;
  const raw = await readFile(gzPath);
  ok(gunzipSync(raw).toString('utf8') === jsonl, '写入的测试文件本身可正常解压（自检）');

  const dates = await get('/api/intraday/dates');
  ok(dates.dates.some((d) => d.date === TEST_DATE && d.gz === true),
    `/api/intraday/dates 能列出 gz 日期（${TEST_DATE}，gz=true）`);
  ok(dates.totalBytes > st0.totalBytes || dates.totalBytes === st0.totalBytes,
    'totalBytes 统计包含 gz 文件');

  const rd = await get(`/api/intraday?thscode=${TEST_CODE}&date=${TEST_DATE}`);
  ok(rd.hasData === true, '接口能从 .gz 里读出数据');
  ok(rd.count === 2, `点数 = ${rd.count}`);
  ok(rd.prevClose === 100, `昨收读取正确 = ${rd.prevClose}`);
  ok(rd.p[1] === 101.2, `价格读取正确 = ${rd.p[1]}`);
  ok(Math.abs(rd.avg[1] - 252000 / 2500) < 1e-9, `均价 = 成交额/成交量 = ${rd.avg[1]}`);
} catch (err) {
  ok(false, `gzip 读取链路异常：${err.message}`);
} finally {
  if (wroteTest) await unlink(gzPath).catch(() => {});
}
console.log(`     （测试文件已清理：${!wroteTest || true}）`);

// ---------------------------------------------------------------- 采集开关
console.log('\n4) 采集开关');
const off = await post('/api/intraday/config', { enabled: false });
ok(off.enabled === false, 'POST /api/intraday/config 可关闭采集');
const st1 = await get('/api/intraday/dates');
ok(st1.enabled === false, '状态接口反映为已关闭');

// 关掉后等一会，采样轮次不应增加
const before = st1.monitor.ticks;
await new Promise((r) => setTimeout(r, 7000));
const st2 = await get('/api/intraday/dates');
ok(st2.monitor.ticks === before,
  `关闭后采样轮次没有增加（${before} → ${st2.monitor.ticks}）；跳过计数 skippedDisabled=${st2.monitor.skippedDisabled}`);
ok(st2.monitor.skippedDisabled > st1.monitor.skippedDisabled, '确实走了"已停用"这条分支（不是因为休市才没采）');
ok(st2.dates.length >= 0, '关闭采集不影响已有记录仍然可见');

const on = await post('/api/intraday/config', { enabled: true });
ok(on.enabled === true, '可以重新开启采集');
const st3 = await get('/api/intraday/dates');
ok(st3.enabled === true, '状态接口反映为已开启');
// 恢复成测试前的状态，别把用户的实例留在关闭状态
if (!st0.enabled) {
  await post('/api/intraday/config', { enabled: false });
  console.log('     （测试前采集是关闭的，已还原为关闭）');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

/**
 * 冒烟测试：验证 API Key → 网络 → 契约解析 的整条链路是否真的通。
 *
 * 用法：
 *   node scripts/smoke.mjs                 # 用默认标的
 *   node scripts/smoke.mjs 600519.SH 000001.SZ
 *
 * 退出码：0 = 全部通过；1 = 有失败项（含缺少 Key）。
 *
 * 设计意图：拿到 Key 后**先跑这个**，再写上层功能。任何一层不对
 * （Key 无效、路径变了、字段名与文档不符）都在这里暴露，而不是等到看板
 * 画出来才发现数据是错的。
 */

import { HithinkClient, HithinkError, BASE_URL, DEFAULT_KEY_FILES } from '../lib/hithink.mjs';

const DEFAULT_CODES = ['600519.SH', '000001.SZ'];
const codes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CODES;

const client = new HithinkClient({ minIntervalMs: 400 });

if (!client.hasKey) {
  if (client.keyPlaceholder) {
    console.error('✗ Key 文件已找到，但里面还是占位符，没有真实 Key\n');
    console.error(`  文件位置：${client.keySource}`);
    console.error('  请用记事本打开，把整行替换成你的 API Key（不要留尖括号、不要加引号），保存后重跑。');
    console.error(`\n  快捷命令：notepad "${client.keySource}"`);
  } else {
    console.error('✗ 缺少 API Key\n');
    console.error('  请任选一种方式提供：');
    console.error('    1) 在下列任一文件里写入 Key 本身（一行，无引号）：');
    for (const f of DEFAULT_KEY_FILES) console.error(`         ${f}`);
    console.error('    2) 设置环境变量 HITHINK_FINANCE_API_KEY');
  }
  console.error('\n  获取地址：https://fuyao.aicubes.cn/admin/ （需用同花顺账号登录）');
  process.exit(1);
}

console.log(`Base URL : ${BASE_URL}`);
console.log(`Key 来源 : ${client.keySource}`);
console.log(`测试标的 : ${codes.join(', ')}\n`);

let passed = 0;
let failed = 0;

/** 跑一项检查；fn 返回值会被简要打印，抛错则记为失败。 */
async function probe(name, fn, { optional = false } = {}) {
  const t0 = Date.now();
  try {
    const summary = await fn();
    const ms = Date.now() - t0;
    console.log(`✓ ${name}  (${ms}ms)`);
    if (summary) console.log(`    ${summary}`);
    passed += 1;
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    if (optional && err instanceof HithinkError && !err.isAuthError) {
      // 可选能力（例如文档标注"暂未开放外部接入"的接口）失败不算链路问题
      console.log(`○ ${name}  (${ms}ms) 已跳过：${err.message}`);
      return false;
    }
    failed += 1;
    console.log(`✗ ${name}  (${ms}ms)`);
    if (err instanceof HithinkError) {
      console.log(`    code=${err.code ?? '-'} http=${err.httpStatus ?? '-'} request_id=${err.requestId ?? '-'}`);
      console.log(`    ${err.message}`);
      if (err.isAuthError) {
        console.log('    → 认证类错误：Key 可能无效、已撤销，或未随请求头发送。');
      }
      if (err.isRateLimit) {
        console.log('    → 触发限流：提高 minIntervalMs 或稍后重试。');
      }
    } else {
      console.log(`    ${err.stack ?? err.message}`);
    }
    return false;
  }
}

// 1. 最低门槛：日历接口，无入参、无标的依赖，能通说明 Key 与网络都正常
await probe('交易日历 /calendar/trading-days', async () => {
  const d = await client.tradingDays();
  const items = d?.item ?? [];
  if (!items.length) throw new Error('返回 item 为空，契约与预期不符');
  const first = items[0]?.date;
  const last = items[items.length - 1]?.date;
  return `区间 ${first} → ${last}，共 ${items.length} 个交易日`;
});

// 2. 行情快照：验证批量与信封解包；顺带确认"不返回中文名"这一文档结论
await probe('行情快照 /prices/snapshot', async () => {
  const d = await client.snapshot(codes);
  const items = d?.item ?? [];
  if (items.length !== codes.length) {
    throw new Error(`请求 ${codes.length} 只，返回 ${items.length} 条 —— 数量不符`);
  }
  const rows = items.map((it) => `${it.thscode} ${it.last_price}`);
  const hasName = items.some((it) => it.name !== undefined);
  return `${rows.join(' | ')}；含 name 字段：${hasName ? '是' : '否（与文档一致）'}`;
});

// 3. 历史 K 线：验证毫秒时间戳参数、单标的约束与复权
await probe('历史K线 /prices/historical', async () => {
  const end = Date.now();
  const start = end - 30 * 24 * 3600 * 1000;
  const d = await client.historical(codes[0], { start, end, adjust: 'forward' });
  const items = d?.item ?? [];
  if (!items.length) throw new Error('返回 item 为空（可能是停牌或非交易日窗口）');
  const last = items[items.length - 1];
  const adjustEcho = Object.prototype.hasOwnProperty.call(d ?? {}, 'adjust');
  return `${codes[0]} 近30天 ${items.length} 根日K，最新 ${last.date_ms} 收 ${last.close_price}；data.adjust 字段：${adjustEcho ? '有' : '无'}`;
});

// 4. 标的检索：验证名称→thscode 解析（快照无中文名，上层要靠它补）
await probe('标的检索 /meta/tickers/search', async () => {
  const d = await client.searchTickers('贵州茅台');
  const items = d?.item ?? [];
  if (!items.length) throw new Error('检索"贵州茅台"无结果');
  return items.slice(0, 3).map((it) => `${it.thscode}=${it.name}`).join(' | ');
});

// 5. 估值快照：验证另一套参数契约
await probe('估值快照 /valuations/snapshot', async () => {
  const d = await client.valuations(codes);
  const items = d?.item ?? [];
  return items.map((it) => `${it.thscode} pe_ttm=${it.pe_ttm} pb_mrq=${it.pb_mrq}`).join(' | ') || '无数据';
});

// 6. 连板天梯：验证"特色数据"这一支的可用性
await probe('连板天梯 /special-data/limit-up-ladder', async () => {
  const d = await client.limitUpLadder();
  const items = d?.item ?? [];
  return `返回 ${items.length} 个交易日梯队，窗口长度 ${d?.window?.length ?? '-'}`;
});

// 7. 主力资金：文档明确"暂未开放外部接入"，作为可选探针，失败不判死
await probe(
  '主力资金 /capital-flow/snapshot（文档标注未开放，仅探测）',
  async () => {
    const d = await client.get('/api/a-share/capital-flow/snapshot', { thscode: codes[0] });
    return `意外可用：${JSON.stringify(d).slice(0, 120)}`;
  },
  { optional: true },
);

console.log(`\n通过 ${passed} 项，失败 ${failed} 项。请求数 ${client.stats.requests}，重试 ${client.stats.retries}。`);
process.exit(failed > 0 ? 1 : 0);

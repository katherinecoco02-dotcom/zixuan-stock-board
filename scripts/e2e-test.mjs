/**
 * 端到端测试：对本地看板服务发真实 HTTP 请求，验证完整链路。
 *
 * 覆盖：健康检查 → 按名称/代码批量添加 → 列表与行情 → K 线 → 删除 → 持久化
 * 用法：先启动 server.mjs，再 node scripts/e2e-test.mjs
 *
 * 注意：本脚本用 Node 的 fetch 发送，body 走真实 UTF-8。
 * 用 PowerShell 的 Invoke-RestMethod 发中文会变成 `????`，那是客户端的编码问题，
 * 会让人误判成服务端 bug —— 所以中文路径必须用本脚本验证。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✓ ${name}`);
    if (detail) console.log(`    ${detail}`);
  } catch (err) {
    fail += 1;
    console.log(`✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

// 先清空到已知状态，让断言可重复
const before = await api('GET', '/api/watchlist');
for (const it of before.json?.items ?? []) {
  await api('DELETE', `/api/watchlist/${encodeURIComponent(it.thscode)}`);
}
console.log('已清空自选股，开始测试\n');

await check('健康检查 /api/health', async () => {
  const r = await api('GET', '/api/health');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json.ok === true, 'ok 不为 true');
  assert(r.json.hasKey === true, '服务端未读到 Key');
  return `Key 来源 ${r.json.keySource}`;
});

await check('批量添加：中文名称 + 纯代码 + 带后缀代码', async () => {
  const r = await api('POST', '/api/watchlist', { input: '贵州茅台, 000001, 300750.SZ' });
  assert(r.status === 200, `HTTP ${r.status}`);
  const codes = (r.json.added ?? []).map((a) => a.thscode).sort();
  assert(codes.includes('600519.SH'), `未解析出 600519.SH（实际 ${codes.join(',')}）`);
  assert(codes.includes('000001.SZ'), '未解析出 000001.SZ');
  assert(codes.includes('300750.SZ'), '未解析出 300750.SZ');
  const moutai = r.json.added.find((a) => a.thscode === '600519.SH');
  assert(moutai.name === '贵州茅台', `中文名解析错误：${moutai.name}`);
  return `新增 ${r.json.added.length} 只：${r.json.added.map((a) => `${a.name}(${a.thscode})`).join('、')}`;
});

await check('无效输入被拒绝且不影响有效项', async () => {
  const r = await api('POST', '/api/watchlist', { input: '这个股票不存在zzz' });
  assert(r.status === 200, `HTTP ${r.status}`);
  assert((r.json.added ?? []).length === 0, '无效输入竟然被添加了');
  assert((r.json.failed ?? []).length === 1, '未报告失败项');
  return `失败项：${r.json.failed[0].token} → ${r.json.failed[0].reason}`;
});

await check('重复添加幂等', async () => {
  const r = await api('POST', '/api/watchlist', { input: '600519' });
  assert((r.json.added ?? []).length === 0, '重复项被再次添加');
  return `total 仍为 ${r.json.total}`;
});

await check('列表返回名称与实时行情', async () => {
  const r = await api('GET', '/api/watchlist');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(!r.json.quoteError, `行情异常：${JSON.stringify(r.json.quoteError)}`);
  const items = r.json.items ?? [];
  assert(items.length === 3, `期望 3 只，实际 ${items.length}`);
  for (const it of items) {
    assert(it.name, `${it.thscode} 缺名称`);
    assert(typeof it.last_price === 'number', `${it.thscode} 缺 last_price`);
  }
  return items.map((i) => `${i.name} ${i.last_price} ${i.price_change_ratio_pct?.toFixed(2)}%`).join(' | ');
});

await check('K 线：1 年窗口 + 前复权（含均线预热）', async () => {
  const r = await api('GET', '/api/kline?thscode=600519.SH&days=565&adjust=forward');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json.adjust === 'forward', `adjust 未回显：${r.json.adjust}`);
  const items = r.json.items ?? [];
  assert(items.length > 250, `bar 数偏少：${items.length}`);
  const last = items[items.length - 1];
  for (const k of ['date_ms', 'open_price', 'high_price', 'low_price', 'close_price', 'volume']) {
    assert(last[k] !== undefined, `最新 bar 缺字段 ${k}`);
  }
  return `${r.json.name} 共 ${items.length} 根，最新 ${new Date(last.date_ms).toISOString().slice(0, 10)} 收 ${last.close_price}`;
});

await check('复权语义正确（前复权锚定最新价、调整历史；后复权锚定最早价）', async () => {
  const [f, n, b] = await Promise.all([
    api('GET', '/api/kline?thscode=600519.SH&days=765&adjust=forward'),
    api('GET', '/api/kline?thscode=600519.SH&days=765&adjust=none'),
    api('GET', '/api/kline?thscode=600519.SH&days=765&adjust=backward'),
  ]);
  assert(f.json.adjust === 'forward' && n.json.adjust === 'none' && b.json.adjust === 'backward', 'adjust 回显不对');

  const first = (r) => Number(r.json.items[0].close_price);
  const last = (r) => Number(r.json.items.at(-1).close_price);

  // 前复权：以最新价为锚 → 最新价与不复权相同，历史价被调整
  assert(last(f) === last(n), `前复权最新价应等于不复权（${last(f)} vs ${last(n)}）`);
  assert(first(f) !== first(n), `前复权历史价未被调整（均为 ${first(f)}）→ adjust 可能未生效`);

  // 后复权：以最早价为锚 → 最新价与不复权不同
  assert(last(b) !== last(n), `后复权最新价不应等于不复权（均为 ${last(b)}）`);

  return `首根 ${first(n)}→前${first(f).toFixed(2)}/后${first(b).toFixed(2)}；末根 不${last(n)}/前${last(f)}/后${last(b).toFixed(2)}`;
});

await check('不存在的标的返回明确错误而非空数据', async () => {
  const r = await api('GET', '/api/kline?thscode=999999.SH&days=90&adjust=forward');
  assert(r.status >= 400, `期望报错，实际 HTTP ${r.status}`);
  assert(r.json?.error, '未返回 error 字段');
  return `HTTP ${r.status} code=${r.json.code ?? '-'} ${String(r.json.error).slice(0, 60)}`;
});

await check('删除生效并持久化', async () => {
  const d = await api('DELETE', '/api/watchlist/000001.SZ');
  assert(d.status === 200, `HTTP ${d.status}`);
  assert(d.json.removed === 1, `removed=${d.json.removed}`);
  const r = await api('GET', '/api/watchlist');
  const codes = r.json.items.map((i) => i.thscode);
  assert(!codes.includes('000001.SZ'), '删除后仍在列表中');
  return `剩余 ${codes.join(', ')}`;
});

await check('复盘：非交易日也能取到有数据的交易日（不落到自然日）', async () => {
  const r = await api('GET', '/api/review');
  assert(r.status === 200, `HTTP ${r.status}`);
  const d = r.json;
  assert(!d.errors || Object.keys(d.errors).length === 0, `面板报错：${JSON.stringify(d.errors)}`);

  // 核心断言：必须显式解析交易日。省略 date_ms 会落到"服务端当前自然日"，
  // 周末/盘前返回空数组 —— 这里用"取到了数据"来证明日期解析生效。
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d.tradeDate ?? ''), `tradeDate 格式异常：${d.tradeDate}`);
  const poolEmpty = (d.panels.limitUp?.length ?? 0) + (d.panels.limitDown?.length ?? 0) + (d.panels.limitBreak?.length ?? 0);
  assert(poolEmpty > 0, `涨停/跌停/炸板三个池子全空，说明交易日解析失败（tradeDate=${d.tradeDate}）`);

  assert(d.panels.ladder?.boards, '连板天梯无 boards');
  assert((d.panels.hot?.length ?? 0) > 0, '热股榜为空');
  assert((d.panels.skyrocket?.length ?? 0) > 0, '飙升榜为空');

  return `交易日 ${d.tradeDate}（日历最新 ${d.calendarLastDate}，回退=${d.fellBack}）；`
    + `涨停 ${d.panels.limitUpTotal ?? d.panels.limitUp.length}、跌停 ${d.panels.limitDown.length}、炸板 ${d.panels.limitBreak.length}、`
    + `连板梯队 ${Object.values(d.panels.ladder.boards).reduce((n, a) => n + (a?.length ?? 0), 0)} 只`;
});

await check('复盘：涨停股字段完整（连板/封单/时间/原因）', async () => {
  const r = await api('GET', '/api/review');
  const first = r.json.panels.limitUp[0];
  assert(first, '涨停池为空');
  for (const k of ['thscode', 'name', 'last_price', 'limit_up_time', 'continue_day_text', 'seal_money']) {
    assert(first[k] !== undefined, `首行缺字段 ${k}`);
  }
  return `${first.name} ${first.thscode} 连板=${first.continue_day_text} 封单=${(first.seal_money / 1e8).toFixed(2)}亿 时间=${first.limit_up_time}`;
});

await check('龙虎榜：三档切换且机构档含机构字段', async () => {
  const [all, org] = await Promise.all([
    api('GET', '/api/review/dragon-tiger?board=all'),
    api('GET', '/api/review/dragon-tiger?board=org'),
  ]);
  assert(all.json.boardType === 'all', `boardType=${all.json.boardType}`);
  assert(org.json.boardType === 'org', `boardType=${org.json.boardType}`);
  assert(all.json.stockItems.length > 0, '全部档无数据');
  assert(org.json.stockItems.length > 0, '机构档无数据');
  const o = org.json.stockItems[0];
  assert(o.org_net_value !== undefined, '机构档缺 org_net_value');
  assert(o.change !== undefined && Math.abs(o.change) < 1.5, `change 应为小数形式，实际 ${o.change}`);
  return `全部 ${all.json.stockCount} 只 / 机构 ${org.json.stockCount} 只；机构首行 ${o.name} 净买 ${(o.org_net_value / 1e8).toFixed(2)}亿`;
});

await check('龙虎榜：非法档位回退到 all 而非报错', async () => {
  const r = await api('GET', '/api/review/dragon-tiger?board=不存在的档位');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json.boardType === 'all', `未回退，boardType=${r.json.boardType}`);
  return `boardType=${r.json.boardType}`;
});

await check('复盘：可指定历史交易日，非交易日被明确拒绝', async () => {
  const base = await api('GET', '/api/review');
  const past = base.json.panels.ladderDays?.[10];
  assert(past, '天梯未返回历史交易日列表');

  const r = await api('GET', `/api/review?date=${past}`);
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json.requested === true, '未标记为指定日期请求');
  assert(r.json.tradeDate === past, `指定 ${past}，实际返回 ${r.json.tradeDate}`);
  assert(r.json.fellBack === false, '指定日期时不应回退');

  // 元旦必然是非交易日；服务端应明确拒绝而不是静默给别的日期
  const bad = await api('GET', '/api/review?date=2026-01-01');
  assert(bad.status === 400, `非交易日应返回 400，实际 ${bad.status}`);
  assert(/不是交易日/.test(bad.json.error ?? ''), `错误信息不明确：${bad.json.error}`);

  return `指定 ${past} 取到 ${r.json.panels.limitUp.length} 只涨停；2026-01-01 → 400 ${bad.json.error}`;
});

await check('筛选：全市场扫描 + 估值筛选生效且如实报告覆盖上限', async () => {
  const r = await api('GET', '/api/screener?excludeSt=1&minPrice=5&maxPrice=200&minAmountYi=1&minPe=0&maxPe=25&minPb=0&maxPb=5');
  assert(r.status === 200, `HTTP ${r.status}`);
  const d = r.json;
  assert(d.scanned > 5000, `扫描数量偏少：${d.scanned}`);
  assert(d.afterMarketFilters <= d.scanned, '行情过滤后数量不应超过扫描数');
  assert(d.enriched <= 200, `估值入围不应超过 200，实际 ${d.enriched}`);
  assert(d.matched <= d.enriched, '命中数不应超过入围数');

  // 估值筛选必须真的生效：所有返回行的 PE/PB 都要在范围内
  for (const row of d.rows) {
    if (row.pe_ttm !== null) assert(row.pe_ttm >= 0 && row.pe_ttm <= 25, `${row.name} PE=${row.pe_ttm} 越界`);
    if (row.pb_mrq !== null) assert(row.pb_mrq >= 0 && row.pb_mrq <= 5, `${row.name} PB=${row.pb_mrq} 越界`);
    assert(row.last_price >= 5 && row.last_price <= 200, `${row.name} 价格越界`);
  }
  assert(/ST/i.test(d.rows.map((x) => x.name).join('')) === false, '排除 ST 未生效');

  // 触达上限时必须明确告知，不能让人以为筛的是全市场
  if (d.valuationCapped) assert(d.valuationNote, '触达估值上限却未给出提示');
  return `扫描 ${d.scanned} → 行情后 ${d.afterMarketFilters} → 估值 ${d.enriched} → 命中 ${d.matched}；上限提示：${d.valuationNote ?? '未触达'}`;
});

await check('回测：默认跑自选股池，收益/回撤/交易数完整', async () => {
  const r = await api('GET', '/api/backtest?fast=5&slow=20&days=730');
  assert(r.status === 200, `HTTP ${r.status}`);
  const d = r.json;
  assert(d.rows.length > 0, '回测结果为空');
  for (const row of d.rows) {
    for (const k of ['totalReturnPct', 'maxDrawdownPct', 'tradeCount', 'bars']) {
      assert(typeof row[k] === 'number', `${row.thscode} 缺 ${k}`);
    }
    assert(row.maxDrawdownPct >= 0 && row.maxDrawdownPct <= 100, `回撤越界：${row.maxDrawdownPct}`);
    assert(d.tradesByCode[row.thscode] !== undefined, `${row.thscode} 没有成交点数据`);
  }
  // 按收益降序
  for (let i = 1; i < d.rows.length; i++) {
    assert(d.rows[i - 1].totalReturnPct >= d.rows[i].totalReturnPct, '结果未按收益降序');
  }
  const best = d.rows[0];
  return `${d.rows.length} 只；最佳 ${best.name} ${best.totalReturnPct.toFixed(1)}%，回撤 -${best.maxDrawdownPct.toFixed(1)}%，${best.tradeCount} 次交易`;
});

await check('回测：买入持有收益与 K 线接口独立手算结果一致', async () => {
  const days = 730;
  const fee = 0.0003;
  const bt = await api('GET', `/api/backtest?fast=5&slow=20&days=${days}&fee=${fee}&thscodes=600519.SH`);
  assert(bt.status === 200, `HTTP ${bt.status}`);
  assert(bt.json.rows.length === 1, '未返回茅台的回测结果');

  // 用另一个接口（K 线）独立取同一窗口的数据手算，交叉验证回测引擎
  const kl = await api('GET', `/api/kline?thscode=600519.SH&days=${days}&adjust=forward`);
  assert(kl.status === 200, `HTTP ${kl.status}`);
  const bars = kl.json.items;
  assert(bars.length > 100, `K 线不足：${bars.length}`);
  // ⚠️ items 里 displayStartMs 之前的是**均线预热 bar**（比显示窗口多取约 40%+60 根），
  // 直接拿 bars[0] 手算会退回到 2023 年的更长窗口，与回测的 730 天窗口根本不是一回事
  // ——那会让这条交叉验证永远对不上。必须先按 displayStartMs 裁掉预热段。
  const win = bars.filter((b) => Number(b.date_ms) >= Number(kl.json.displayStartMs));
  assert(win.length > 100, `窗口内 K 线不足：${win.length}`);
  const firstOpen = Number(win[0].open_price);
  const lastClose = Number(win[win.length - 1].close_price);
  const expected = (lastClose / (firstOpen * (1 + fee)) - 1) * 100;

  const actual = bt.json.rows[0].buyHoldPct;
  assert(Math.abs(expected - actual) < 0.15,
    `买入持有对不上：K线手算 ${expected.toFixed(2)}% vs 回测 ${actual?.toFixed(2)}%` +
    `（窗口 ${new Date(win[0].date_ms).toISOString().slice(0, 10)} 起，共 ${win.length} 根）`);
  return `手算 ${expected.toFixed(2)}% ≈ 回测 ${actual.toFixed(2)}%（首开 ${firstOpen} → 末收 ${lastClose}）`;
});

await check('回测：成交点严格买卖交替且都在窗口内、无未来日期', async () => {
  const days = 730;
  const r = await api('GET', `/api/backtest?fast=5&slow=20&days=${days}&thscodes=000725.SZ`);
  const trades = r.json.tradesByCode['000725.SZ'] ?? [];
  assert(trades.length > 2, `成交点太少：${trades.length}`);

  let expectBuy = true;
  const lower = Date.now() - days * 86400e3 - 86400e3;
  for (const t of trades) {
    assert(t.side === (expectBuy ? 'buy' : 'sell'), `成交序列未交替：期望 ${expectBuy ? 'buy' : 'sell'}，实际 ${t.side}`);
    expectBuy = !expectBuy;
    assert(t.date_ms >= lower, `成交日早于窗口：${new Date(t.date_ms).toISOString().slice(0, 10)}`);
    assert(t.date_ms <= Date.now(), `成交日在未来：${new Date(t.date_ms).toISOString().slice(0, 10)}`);
    assert(t.price > 0, `成交价非正：${t.price}`);
    if (t.side === 'sell') assert(typeof t.pnlPct === 'number', '卖出点缺 pnlPct');
  }
  return `${trades.length} 个成交点，首 ${new Date(trades[0].date_ms).toISOString().slice(0, 10)} / 末 ${new Date(trades[trades.length - 1].date_ms).toISOString().slice(0, 10)}`;
});

await check('回测：参数非法时明确报错', async () => {
  const bad = await api('GET', '/api/backtest?fast=20&slow=5');
  assert(bad.status === 400, `快线>=慢线应报 400，实际 ${bad.status}`);
  assert(/快线/.test(bad.json.error ?? ''), `错误信息不明确：${bad.json.error}`);
  return `fast=20 slow=5 → 400 ${bad.json.error}`;
});

await check('周期切换：日/周/月/季/年 均可用且显示窗口合理', async () => {
  // 年线用区间最后交易日作时间戳，故 1 年窗口会跨到 2 根
  const expected = { day: 242, week: 52, month: 12, quarter: 4, year: 2 };
  const detail = [];
  for (const period of ['day', 'week', 'month', 'quarter', 'year']) {
    const r = await api('GET', `/api/kline?thscode=600519.SH&days=365&period=${period}`);
    assert(r.status === 200, `${period} HTTP ${r.status}`);
    assert(r.json.period === period, `${period} 回显错误：${r.json.period}`);
    const items = r.json.items ?? [];
    assert(items.length > 0, `${period} 无数据`);
    // 时间必须严格升序
    for (let i = 1; i < items.length; i++) {
      assert(items[i].date_ms > items[i - 1].date_ms, `${period} 时间未升序`);
    }
    const shown = items.filter((b) => b.date_ms >= r.json.displayStartMs);
    const exp = expected[period];
    assert(shown.length >= exp * 0.6 && shown.length <= exp * 1.6,
      `${period} 显示 ${shown.length} 根，偏离预期 ${exp} 太多`);
    detail.push(`${period} ${shown.length}根`);
  }
  return detail.join(' / ');
});

await check('周期聚合口径：周线 OHLCV 等于该周日线的聚合结果', async () => {
  const [d, w] = await Promise.all([
    api('GET', '/api/kline?thscode=600519.SH&days=365&period=day'),
    api('GET', '/api/kline?thscode=600519.SH&days=365&period=week'),
  ]);
  const daily = d.json.items;
  const weekly = w.json.items;
  const bar = weekly[weekly.length - 3]; // 避开窗口边缘
  assert(bar, '周线数据不足');
  const inWeek = daily.filter((b) => b.date_ms > bar.date_ms - 7 * 86400e3 && b.date_ms <= bar.date_ms);
  assert(inWeek.length > 0, '未找到该周对应的日线');

  const vol = inWeek.reduce((s, b) => s + (Number(b.volume) || 0), 0);
  const hi = Math.max(...inWeek.map((b) => Number(b.high_price)));
  const lo = Math.min(...inWeek.map((b) => Number(b.low_price)));
  const close = Number(inWeek[inWeek.length - 1].close_price);

  assert(Number(bar.volume) === vol, `成交量不符：周 ${bar.volume} vs 日线和 ${vol}`);
  assert(Number(bar.high_price) === hi, `最高价不符：${bar.high_price} vs ${hi}`);
  assert(Number(bar.low_price) === lo, `最低价不符：${bar.low_price} vs ${lo}`);
  assert(Number(bar.close_price) === close, `收盘价不符：${bar.close_price} vs ${close}`);
  return `该周 ${inWeek.length} 根日线：量 ${vol}、高 ${hi}、低 ${lo}、收 ${close} 全部一致`;
});

await check('周期接口：非法周期回退到日线而非报错', async () => {
  const r = await api('GET', '/api/kline?thscode=600519.SH&days=90&period=minute');
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json.period === 'day', `未回退，period=${r.json.period}`);
  assert((r.json.items ?? []).length > 0, '回退后无数据');
  return `period=minute → ${r.json.period}，${r.json.items.length} 根`;
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`);
process.exit(fail > 0 ? 1 : 0);

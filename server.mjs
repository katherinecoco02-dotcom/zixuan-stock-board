/**
 * 自选股看板 · 本地服务
 *
 * 设计要点：
 *  1. API Key 只存在于服务端（读 .apikey），浏览器永远拿不到 —— 前端只跟本服务说话。
 *  2. 快照支持批量，所以整个自选股列表的行情只需 **1 次**上游请求。
 *  3. 名称不来自行情快照（该接口不返回 name），而是用全市场代码表在本地做映射。
 *  4. K 线走客户端磁盘缓存（6 小时），反复切换股票不会反复打上游。
 *
 * 只监听 127.0.0.1，不对外暴露。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HithinkClient, HithinkError } from './lib/hithink.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
/** 数据目录可用 DATA_DIR 覆盖 —— 让测试能起一个完全隔离的实例，不碰真实自选股与预警。 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const ALERT_LOG_FILE = path.join(DATA_DIR, 'alert.log');
/** 价格预警的轮询间隔。上游只有快照行情（无 tick），10 秒已是这套数据源的合理下限。 */
const ALERT_INTERVAL_MS = Math.max(Number(process.env.ALERT_INTERVAL_MS ?? 10_000) || 10_000, 3_000);
/** 非交易时段不触发，但仍按这个间隔刷新一次价格用于展示 */
const CLOSED_QUOTE_REFRESH_MS = 60_000;

const PORT = Number(process.env.PORT ?? 8787);
const HOST = '127.0.0.1';

const client = new HithinkClient({
  minIntervalMs: 250,
  cacheDir: path.join(__dirname, '.cache', 'hithink'),
});

/**
 * 批量扫描专用客户端（均线筛选要逐只取历史 K 线）。
 *
 * 与交互式客户端**分开节流**，否则单只 250ms 的间隔会让 200 只扫上 50 秒。
 * 上游未公布 QPS 上限，这里取 100ms（≈10 req/s）配 5 路并发；触发 429 时
 * 客户端自身会指数退避重试，单只失败也只会让该只缺值，不影响整轮。
 * 两者共用同一个磁盘缓存目录，所以第二轮扫描基本全是缓存命中。
 */
const bulkClient = new HithinkClient({
  minIntervalMs: 100,
  cacheDir: path.join(__dirname, '.cache', 'hithink'),
});

if (!client.hasKey) {
  console.error('✗ 未找到 API Key：请在 .apikey 写入 Key，或设置 HITHINK_FINANCE_API_KEY');
  process.exit(1);
}

// ---------------------------------------------------------------- 自选股持久化

/** @returns {Promise<Array<{thscode: string, addedAt: string}>>} */
async function loadWatchlist() {
  try {
    const raw = JSON.parse(await readFile(WATCHLIST_FILE, 'utf8'));
    if (Array.isArray(raw?.items)) return raw.items;
  } catch {
    /* 首次运行没有文件 */
  }
  return [];
}

async function saveWatchlist(items) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    WATCHLIST_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------- 名称映射

let tickerIndexCache = null;
let tickerIndexLoadedAt = 0;

/** 全角字符转半角。上游名称用的是全角字母（如「京东方Ａ」的 Ａ 是 U+FF21），
 *  而用户必然输入半角 A，不做这层归一化就永远匹配不上。 */
function toHalfWidth(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 名称归一化：全角→半角、转小写、去空白。 */
function normalizeName(s) {
  return toHalfWidth(s).toLowerCase().replace(/\s+/g, '');
}

/** 去掉除权除息前缀：除息日上游会把名称临时改成 XD/XR/DR 开头。 */
function stripExPrefix(s) {
  return s.replace(/^(xd|xr|dr)/i, '');
}

/**
 * 全市场 A 股代码表 → 双向索引。
 *  - byCode: thscode → name
 *  - byName: 归一化名称 → { thscode, name }（额外收录去掉 XD/XR/DR 前缀的别名）
 * 本地索引让"按名称添加"既准确（能处理全角/前缀）又省掉每只一次的远端检索。
 */
async function getTickerIndex() {
  if (tickerIndexCache && Date.now() - tickerIndexLoadedAt < 6 * 3600_000) return tickerIndexCache;
  const rows = await client.allTickers({ assetType: 'a-share', pageSize: 10000 });
  const byCode = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (!r?.thscode) continue;
    const code = r.thscode.toUpperCase();
    const name = r.name ?? '';
    byCode.set(code, name);
    const norm = normalizeName(name);
    if (norm && !byName.has(norm)) byName.set(norm, { thscode: code, name });
    const stripped = stripExPrefix(norm);
    if (stripped && stripped !== norm && !byName.has(stripped)) {
      byName.set(stripped, { thscode: code, name });
    }
  }
  tickerIndexCache = { byCode, byName };
  tickerIndexLoadedAt = Date.now();
  console.log(`[names] 载入代码表 ${byCode.size} 条，名称索引 ${byName.size} 条`);
  return tickerIndexCache;
}

/** 在本地名称索引里查一只股票：精确 → 去前缀精确 → 唯一子串 → 前缀截断。
 *  返回 {thscode, name, ambiguous, alternatives}，ambiguity 由上层如实告知用户。 */
function lookupByName(index, rawToken) {
  const q = normalizeName(rawToken);
  if (!q) return null;
  const exact = index.byName.get(q) ?? index.byName.get(stripExPrefix(q));
  if (exact) return { ...exact, ambiguous: false, alternatives: [] };

  const candidates = [];
  for (const [key, val] of index.byName) {
    if (key.includes(q)) candidates.push({ key, ...val });
  }
  if (candidates.length) {
    // 优先以查询串开头的（「京东方」→「京东方Ａ」），其次名称最短的
    candidates.sort((a, b) => {
      const aStarts = a.key.startsWith(q) ? 0 : 1;
      const bStarts = b.key.startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.key.length - b.key.length;
    });
    return {
      ...candidates[0],
      ambiguous: candidates.length > 1,
      alternatives: candidates.slice(0, 4).map((c) => `${c.name}(${c.thscode})`),
    };
  }

  // 二轮：上游在除权除息日会把名称连同 XD 前缀一起截断（「万华化学」→「XD万华化」），
  // 此时索引键是查询串的**前缀**，方向与上面相反。仅在候选唯一、且键足够长时采用 ——
  // 拿不准就返回 null 让上层报错，绝不猜一个可能错的标的。
  const prefixHits = [];
  for (const [key, val] of index.byName) {
    if (key.length >= 3 && q.startsWith(key)) prefixHits.push({ key, ...val });
  }
  if (prefixHits.length) {
    prefixHits.sort((a, b) => b.key.length - a.key.length);
    const top = prefixHits[0];
    const second = prefixHits[1];
    if (!second || second.key.length < top.key.length) return { ...top, ambiguous: false, alternatives: [] };
  }
  return null;
}

// ---------------------------------------------------------------- 代码解析

/**
 * 把用户输入的 token 解析成 thscode。
 * 6 位纯数字按交易所规则补后缀（不发请求）；否则当作名称去检索。
 */
function codeFromDigits(digits) {
  const p = digits.slice(0, 3);
  const first = digits[0];
  if (['600', '601', '603', '605', '688', '689', '900'].includes(p)) return `${digits}.SH`;
  if (first === '9') return `${digits}.SH`;
  if (['000', '001', '002', '003', '300', '301', '200'].includes(p)) return `${digits}.SZ`;
  if (first === '2') return `${digits}.SZ`;
  if (first === '4' || first === '8') return `${digits}.BJ`;
  if (first === '6') return `${digits}.SH`;
  if (first === '0' || first === '3') return `${digits}.SZ`;
  return null;
}

/** 解析一批用户输入（逗号/空格/换行/顿号分隔），返回 {resolved, failed} */
async function resolveTokens(input) {
  const tokens = String(input ?? '')
    .split(/[\s,，、;；|]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const resolved = new Map(); // thscode -> { name, ambiguous, alternatives }
  const failed = [];

  let index = null;
  try {
    index = await getTickerIndex();
  } catch (err) {
    console.warn(`[resolve] 代码表载入失败，名称解析将回退到远端检索：${err.message}`);
  }

  for (const token of tokens) {
    const withSuffix = token.match(/^(\d{6})\.(SH|SZ|BJ)$/i);
    if (withSuffix) {
      resolved.set(`${withSuffix[1]}.${withSuffix[2].toUpperCase()}`, { name: null });
      continue;
    }
    if (/^\d{6}$/.test(token)) {
      const code = codeFromDigits(token);
      if (code) resolved.set(code, { name: null });
      else failed.push({ token, reason: '无法判断交易所后缀' });
      continue;
    }

    // 名称：优先本地索引（能处理全角字母与 XD/XR/DR 前缀），失败再走远端检索
    const local = index ? lookupByName(index, token) : null;
    if (local) {
      resolved.set(local.thscode, {
        name: local.name,
        ambiguous: local.ambiguous,
        alternatives: local.alternatives,
      });
      continue;
    }
    try {
      const data = await client.searchTickers(token, { assetType: 'a-share', limit: 5 });
      const hit = (data?.item ?? []).find((it) => it.asset_type === 'a-share') ?? data?.item?.[0];
      if (hit?.thscode) resolved.set(hit.thscode.toUpperCase(), { name: hit.name ?? null });
      else failed.push({ token, reason: '检索无结果（本地名称索引与远端检索均未命中）' });
    } catch (err) {
      failed.push({ token, reason: err instanceof HithinkError ? err.message : String(err.message) });
    }
  }

  // 补名称
  if (index) {
    for (const [code, v] of resolved) {
      if (!v.name) v.name = index.byCode.get(code) ?? '';
    }
  }

  return {
    resolved: [...resolved].map(([thscode, v]) => ({
      thscode,
      name: v.name,
      ambiguous: Boolean(v.ambiguous),
      alternatives: v.alternatives ?? [],
    })),
    failed,
  };
}

// ---------------------------------------------------------------- 交易日解析

let tradingDaysCache = null;

/** 近一年交易日序列（上游固定窗口，客户端缓存 6 小时）。 */
async function getTradingDays() {
  if (tradingDaysCache && Date.now() - tradingDaysCache.at < 6 * 3600_000) return tradingDaysCache.days;
  const data = await client.tradingDays();
  const days = data?.item ?? [];
  if (!days.length) throw new Error('交易日历返回为空');
  tradingDaysCache = { days, at: Date.now() };
  return days;
}

/**
 * 解析用于复盘的交易日。
 *
 * 必须显式传日期：涨停池等接口省略 `date_ms` 时回退到**服务端当前自然日**，
 * 周末或盘前调用会返回空数组（已实测确认）。所以这里从交易日历取最后一个交易日。
 */
async function resolveTradeDays() {
  const days = await getTradingDays();
  return { last: days[days.length - 1], prev: days[days.length - 2] ?? null };
}

// ---------------------------------------------------------------- 价格预警

/**
 * 上海时区（UTC+8）的日历字段。
 * 显式按偏移量换算而不是用本机时区——本机时区变了也不该影响"几点算盘中"。
 */
const SH_OFFSET_MS = 8 * 3600_000;

function shanghaiNow(ms = Date.now()) {
  const d = new Date(ms + SH_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const hh = d.getUTCHours();
  const mi = d.getUTCMinutes();
  return {
    ymd: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
    hhmm: `${pad(hh)}:${pad(mi)}`,
    minutes: hh * 60 + mi,
    weekday: d.getUTCDay(), // 0 = 周日
  };
}

/**
 * 当前是否处于"允许触发"的交易时段：工作日 + 09:15~11:30 / 13:00~15:00，
 * 并且**优先用交易日历排除法定节假日**（日历取不到时退化为"工作日即交易日"，
 * 不因为一个辅助判断失败就停掉监控）。
 *
 * 为什么必须拦：上游只有快照行情，非交易时段返回的是收盘价。周末拿收盘价去比
 * 「跌到 6.20」当然不会触发，但「涨到 6.70」这类就会立刻误报一笔。所以自动轮询
 * 一律在非交易时段跳过判定（手动"立即检查一次"是显式动作，不拦）。
 */
async function marketSession(ms = Date.now()) {
  const p = shanghaiNow(ms);
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  let isTradingDay = null;
  try {
    const days = await getTradingDays();
    isTradingDay = days.some((d) => d.date === p.ymd);
  } catch {
    /* 日历不可用：不据此判定休市 */
  }
  const morning = p.minutes >= 9 * 60 + 15 && p.minutes <= 11 * 60 + 30;
  const afternoon = p.minutes >= 13 * 60 && p.minutes <= 15 * 60;
  const open = weekday && isTradingDay !== false && (morning || afternoon);

  // 测试钩子：让"交易时段自动轮询触发"这条路径可以在周末被真实跑到
  // （scripts/alert-test.mjs 用独立实例 + 独立 DATA_DIR 验证）。
  // 正常运行时绝不能设置它——否则非交易时段会拿收盘价误报。
  if (process.env.ALERT_FORCE_SESSION === '1') {
    return { open: true, isTradingDay, weekday, time: p.hhmm, label: '交易中（ALERT_FORCE_SESSION 强制）', forced: true };
  }

  let label;
  if (!weekday) label = '周末休市';
  else if (isTradingDay === false) label = '今日休市（非交易日）';
  else if (open) label = p.minutes < 12 * 60 ? '交易中（上午）' : '交易中（下午）';
  else if (p.minutes < 9 * 60 + 15) label = '盘前 · 09:15 开始监控';
  else if (p.minutes < 13 * 60) label = '午间休市 · 13:00 恢复';
  else label = '已收盘 · 次日 09:15 恢复';

  return { open, isTradingDay, weekday, time: p.hhmm, label };
}

let alertsStore = null;

/** 预警与触发事件都存在 data/alerts.json；事件只保留最近 100 条。 */
async function loadAlerts() {
  if (alertsStore) return alertsStore;
  try {
    const raw = JSON.parse(await readFile(ALERTS_FILE, 'utf8'));
    alertsStore = {
      items: Array.isArray(raw?.items) ? raw.items : [],
      events: Array.isArray(raw?.events) ? raw.events : [],
    };
  } catch {
    alertsStore = { items: [], events: [] };
  }
  return alertsStore;
}

async function saveAlerts() {
  const store = await loadAlerts();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    ALERTS_FILE,
    JSON.stringify(
      { updatedAt: new Date().toISOString(), items: store.items, events: store.events.slice(-100) },
      null,
      2,
    ),
    'utf8',
  );
}

const alertMonitor = {
  intervalMs: ALERT_INTERVAL_MS,
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  lastQuoteAt: null,
  lastError: null,
  checks: 0,
  triggers: 0,
  quotes: new Map(), // thscode -> 最近一次快照（含 last_price）
  seq: 0,
};

function dirSymbol(direction) {
  return direction === 'above' ? '≥' : '≤';
}

function pushAlertEvent(store, alert, price, source) {
  alertMonitor.seq += 1;
  const ev = {
    id: `e${Date.now().toString(36)}_${alertMonitor.seq}`,
    seq: alertMonitor.seq,
    thscode: alert.thscode,
    name: alert.name ?? '',
    direction: alert.direction,
    target: alert.target,
    price,
    note: alert.note ?? '',
    source, // poll = 自动轮询；manual = 手动"立即检查一次"
    at: new Date().toISOString(),
    ack: false,
  };
  store.events.push(ev);
  if (store.events.length > 100) store.events.splice(0, store.events.length - 100);

  // 落盘留痕：浏览器没开的时候触发了，事后也能在 data/alert.log 里查到
  appendFile(
    ALERT_LOG_FILE,
    `${ev.at}\t${alert.thscode}\t${alert.name ?? ''}\t${dirSymbol(alert.direction)}${alert.target}\t现价 ${price}\t${source}\n`,
    'utf8',
  ).catch(() => {});
  console.log(`[alert] 触发 ${alert.name ?? ''}(${alert.thscode}) ${dirSymbol(alert.direction)}${alert.target} 现价 ${price} [${source}]`);
  return ev;
}

/**
 * 检查一轮所有「启用且未触发」的预警。
 *
 * @param {{force?: boolean, source?: 'poll'|'manual'}} [opts]
 *   force=true 时非交易时段也判定（手动触发用）；自动轮询一律跳过判定，
 *   但**仍会每 60 秒取一次价格**用于界面上显示"现价 / 距离目标多远"。
 */
async function checkAlerts({ force = false, source = 'poll' } = {}) {
  const store = await loadAlerts();
  const active = store.items.filter((a) => a.enabled && !a.triggeredAt);
  const session = await marketSession();
  const result = { session, checked: 0, triggers: [], skipped: null, error: null };
  if (!active.length) return result;

  const closed = !session.open && !force;
  const quotesStale = !alertMonitor.lastQuoteAt || Date.now() - alertMonitor.lastQuoteAt > CLOSED_QUOTE_REFRESH_MS;
  if (closed && !quotesStale) {
    result.skipped = '非交易时段，本轮不判定';
    return result;
  }

  const codes = [...new Set(active.map((a) => a.thscode))];
  let items;
  try {
    // ttlMs=0：绕过 10 秒磁盘缓存，保证比的是"当下这一笔"快照
    const data = await client.get(
      '/api/a-share/prices/snapshot',
      { thscodes: codes.join(',') },
      { ttlMs: 0 },
    );
    items = data?.item ?? [];
    alertMonitor.lastError = null;
  } catch (err) {
    alertMonitor.lastError = err instanceof HithinkError ? `[${err.code}] ${err.message}` : String(err.message);
    alertMonitor.lastCheckAt = new Date().toISOString();
    result.error = alertMonitor.lastError;
    return result;
  }

  const at = new Date().toISOString();
  for (const it of items) {
    alertMonitor.quotes.set(String(it.thscode).toUpperCase(), { ...it, at });
  }
  alertMonitor.lastQuoteAt = Date.now();

  for (const a of active) {
    const last = Number(alertMonitor.quotes.get(a.thscode)?.last_price);
    if (closed) continue; // 只刷价格，不判定
    if (!Number.isFinite(last) || last <= 0) continue; // 停牌 / 无行情：不猜
    result.checked += 1;
    const met = a.direction === 'above' ? last >= a.target : last <= a.target;
    if (!met) continue;

    a.triggeredAt = new Date().toISOString();
    a.triggeredPrice = last;
    a.triggeredBy = source;
    const ev = pushAlertEvent(store, a, last, source);
    result.triggers.push(ev);
    alertMonitor.triggers += 1;
  }

  alertMonitor.checks += 1;
  alertMonitor.lastCheckAt = new Date().toISOString();
  if (result.triggers.length) await saveAlerts();
  return result;
}

let alertTimer = null;

function startAlertMonitor() {
  if (alertTimer) return;
  const tick = async () => {
    try {
      await checkAlerts();
    } catch (err) {
      alertMonitor.lastError = String(err?.message ?? err);
      console.error(`[alert] 轮询异常：${alertMonitor.lastError}`);
    }
  };
  tick();
  alertTimer = setInterval(tick, ALERT_INTERVAL_MS);
  console.log(`[alert] 价格预警监控已启动，间隔 ${ALERT_INTERVAL_MS / 1000} 秒（仅交易时段判定）`);
}

// ---------------------------------------------------------------- 分时采样（自建分时图的数据来源）

/**
 * 上游**没有** A 股分钟数据（`high-frequency` 全部返回 code=2004「AI 客户端专用」，
 * 日线接口传 interval=1m 直接 1002 报错），所以分时图只能**自己采样攒**：
 * 交易时段内定期取一次快照，把价格/成交量/成交额按时间追加到当天文件里。
 *
 * 存储：`data/intraday/YYYY-MM-DD.jsonl`，**一行一个采样点**（追加写，O(1)），
 * 首行/新增标的时补一行 meta 记昨收。这样每天一个文件、可永久回放。
 * 采样间隔默认 30 秒（一天约 480 点，够画分时），可用 INTRADAY_INTERVAL_MS 调整。
 */
const INTRADAY_DIR = path.join(DATA_DIR, 'intraday');
const INTRADAY_INTERVAL_MS = Math.max(Number(process.env.INTRADAY_INTERVAL_MS ?? 30_000) || 30_000, 3_000);

const intradayMonitor = {
  intervalMs: INTRADAY_INTERVAL_MS,
  startedAt: null,
  lastTickAt: null,
  lastSampleAt: null,
  samples: 0,
  ticks: 0,
  skippedClosed: 0,
  errors: 0,
  lastError: null,
};

/** 上海时区的 YYYY-MM-DD */
function shDate(ms = Date.now()) {
  const y = shanghaiNow(ms).ymd;
  return `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
}

function intradayFile(date) {
  return path.join(INTRADAY_DIR, `${date}.jsonl`);
}

/**
 * 某个时刻对应"盘中第几分钟"：9:30 = 0，11:30 = 120，13:00 = 120，15:00 = 240。
 * 这样横轴可以按 0~240 固定铺满，不同股票、不同日期画出来的形状能直接对比
 * （和行情软件的分时图一致：中午休市不占宽度）。开盘前（集合竞价）一律算 0。
 */
function sessionMinuteOf(ms) {
  const m = shanghaiNow(ms).minutes;
  if (m < 9 * 60 + 30) return 0;
  if (m <= 11 * 60 + 30) return m - (9 * 60 + 30);
  if (m < 13 * 60) return 120;
  return 120 + Math.min(120, m - 13 * 60);
}

let intradayTimer = null;

async function intradayTick() {
  const forced = process.env.INTRADAY_FORCE_SESSION === '1';
  const session = await marketSession();
  if (!session.open && !forced) {
    intradayMonitor.skippedClosed += 1;
    return;
  }

  const items = await loadWatchlist();
  const codes = items.map((i) => i.thscode);
  if (!codes.length) return;

  const snap = await client.snapshot(codes); // 自选股一次批量快照
  const rows = snap?.item ?? [];
  if (!rows.length) return;

  const now = Date.now();
  const date = shDate(now);
  await mkdir(INTRADAY_DIR, { recursive: true });

  const quotes = {};
  const prevClose = {};
  for (const r of rows) {
    const code = String(r.thscode ?? '').toUpperCase();
    if (!code) continue;
    const p = Number(r.last_price);
    if (!Number.isFinite(p) || p <= 0) continue; // 停牌/无行情不记，避免画出一条假的 0 线
    quotes[code] = [p, Number(r.volume) || 0, Number(r.turnover) || 0];
    const pc = Number(r.prev_price);
    if (Number.isFinite(pc) && pc > 0) prevClose[code] = pc;
  }
  if (!Object.keys(quotes).length) return;

  const line = JSON.stringify({ t: Math.floor(now / 1000), q: quotes }) + '\n';
  await appendFile(intradayFile(date), line, 'utf8');

  // meta 每次都补一行（读取端取最后一条），这样盘中新加的自选股也能有昨收
  const metaLine = JSON.stringify({ meta: true, date, prevClose }) + '\n';
  await appendFile(intradayFile(date), metaLine, 'utf8');

  intradayMonitor.samples += Object.keys(quotes).length;
  intradayMonitor.ticks += 1;
  intradayMonitor.lastSampleAt = new Date().toISOString();
}

function startIntradayRecorder() {
  if (intradayTimer) return;
  const tick = async () => {
    try {
      await intradayTick();
      intradayMonitor.lastError = null;
    } catch (err) {
      intradayMonitor.errors += 1;
      intradayMonitor.lastError = String(err?.message ?? err);
      console.error(`[intraday] 采样异常：${intradayMonitor.lastError}`);
    } finally {
      intradayMonitor.lastTickAt = new Date().toISOString();
    }
  };
  intradayMonitor.startedAt = new Date().toISOString();
  tick();
  intradayTimer = setInterval(tick, INTRADAY_INTERVAL_MS);
  console.log(`[intraday] 分时采样已启动，间隔 ${INTRADAY_INTERVAL_MS / 1000} 秒（仅交易时段采集自选股，按天存 data/intraday/）`);
}

/** 读某天的分时：返回 { date, prevClose, series: { code: {t[],p[],v[],to[]} } } */
async function loadIntradayDay(date) {
  const file = intradayFile(date);
  let text = null;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const prevClose = {};
  const series = {};
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue; // 半行（写入中断）直接跳过，不让一行坏数据废掉整天
    }
    if (row.meta) {
      Object.assign(prevClose, row.prevClose ?? {});
      continue;
    }
    if (!row.q || !row.t) continue;
    for (const [code, v] of Object.entries(row.q)) {
      const s2 = (series[code] ??= { t: [], p: [], v: [], to: [] });
      if (s2.t.length && s2.t[s2.t.length - 1] >= row.t) continue; // 同一/倒退时间戳不重复记
      s2.t.push(row.t);
      s2.p.push(v[0]);
      s2.v.push(v[1]);
      s2.to.push(v[2]);
    }
  }
  return { date, prevClose, series };
}

/** 已录制的日期清单（含每个日期录了多少股票、多少点、文件多大） */
async function listIntradayDates() {
  let names = [];
  try {
    names = await readdir(INTRADAY_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const m = n.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const file = path.join(INTRADAY_DIR, n);
    let bytes = 0;
    try {
      bytes = (await stat(file)).size;
    } catch { /* ignore */ }
    out.push({ date: m[1], bytes, file });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

/** 一条预警的实时对照：现价、是否已满足、距离目标还差多少（>0 表示还没到）。 */
function compareRows(store) {
  return store.items.map((a) => {
    const last = Number(alertMonitor.quotes.get(a.thscode)?.last_price);
    const hasQuote = Number.isFinite(last) && last > 0;
    return {
      ...a,
      last_price: hasQuote ? last : null,
      price_change_ratio_pct: alertMonitor.quotes.get(a.thscode)?.price_change_ratio_pct ?? null,
      met: hasQuote ? (a.direction === 'above' ? last >= a.target : last <= a.target) : null,
      gapToTarget: hasQuote ? (a.direction === 'above' ? a.target - last : last - a.target) : null,
    };
  });
}

async function alertsPayload() {
  const store = await loadAlerts();
  return {
    items: compareRows(store),
    events: store.events.filter((e) => !e.ack),
    monitor: {
      intervalMs: alertMonitor.intervalMs,
      startedAt: alertMonitor.startedAt,
      lastCheckAt: alertMonitor.lastCheckAt,
      lastQuoteAt: alertMonitor.lastQuoteAt ? new Date(alertMonitor.lastQuoteAt).toISOString() : null,
      lastError: alertMonitor.lastError,
      checks: alertMonitor.checks,
      triggers: alertMonitor.triggers,
      session: await marketSession(),
    },
  };
}

// ---------------------------------------------------------------- 全市场快照（供筛选器使用）

let marketCache = null;

/**
 * 全市场行情快照（约 5571 只）。
 *
 * 实测：单页上限 ≥2000，全市场 3 页 ≈ 750ms。用**实际返回条数**推进 offset 而不是
 * 请求条数，这样即使上游静默下调单页上限也不会漏数据。内存缓存 30 秒，避免
 * 每次调筛选参数都重打 3 页。
 */
async function getMarketSnapshot() {
  if (marketCache && Date.now() - marketCache.at < 30_000) return marketCache;

  const pageSize = 2000;
  const rows = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const d = await client.get('/api/a-share/prices/snapshot', { limit: pageSize, offset });
    const items = d?.item ?? [];
    if (total === null) total = d?.total ?? null;
    rows.push(...items);
    if (!items.length) break;
    offset += items.length;
    if (total !== null && rows.length >= total) break;
    if (rows.length > 20000) break; // 安全阀
  }

  marketCache = { rows, at: Date.now(), total };
  console.log(`[market] 全市场快照 ${rows.length} 只（上游 total=${total}）`);
  return marketCache;
}

// ---------------------------------------------------------------- 均线扫描（供选股使用）

const MA_PERIODS = [5, 10, 20, 30, 60];

/** 限制并发的 map：既要跑得快，又不能一次性把上游打爆。 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 均线序列（前 period-1 根为 null）。 */
function maSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 取一只股票的日线，算出 MA5/10/20/30/60、最新价对每条均线的偏离（%）与均线排列。
 *
 * 偏离为正 = 价格在均线**上方**。例如 dev60 = -20 表示价格比 MA60 低 20%。
 * 返回 null 表示日线不足 60 根（新股、长期停牌），这类标的会被跳过而不是给个假值。
 */
async function computeMAs(code, endMs) {
  const start = endMs - 140 * 86400e3; // ≈100 个交易日，足够 MA60
  const data = await bulkClient.historical(code, { start, end: endMs, adjust: 'forward' });
  const bars = data?.item ?? [];
  if (bars.length < 60) return null;

  const closes = bars.map((b) => Number(b.close_price));
  const close = closes[closes.length - 1];
  const out = { close, bars: bars.length, lastDate: bars[bars.length - 1].date_ms };

  for (const p of MA_PERIODS) {
    const ma = closes.slice(-p).reduce((s, v) => s + v, 0) / p;
    out[`ma${p}`] = ma;
    out[`dev${p}`] = ((close - ma) / ma) * 100;
  }

  // 多头排列：短周期均线全在长周期之上（MA5>MA10>…>MA60）；空头反之
  const seq = MA_PERIODS.map((p) => out[`ma${p}`]);
  const desc = seq.every((v, i) => i === 0 || seq[i - 1] > v);
  const asc = seq.every((v, i) => i === 0 || seq[i - 1] < v);
  out.align = desc ? 'bull' : asc ? 'bear' : 'mixed';

  // 最近一次 MA5/MA10 交叉（金叉/死叉）距今多少根 —— 窗口由调用方决定，这里给出全部历史里最近的一次
  const s5 = maSeries(closes, 5);
  const s10 = maSeries(closes, 10);
  out.cross = null;
  out.crossAgo = null;
  for (let i = closes.length - 1; i >= 1; i--) {
    if (s5[i - 1] === null || s10[i - 1] === null) break;
    if (s5[i - 1] <= s10[i - 1] && s5[i] > s10[i]) {
      out.cross = 'golden';
      out.crossAgo = closes.length - 1 - i;
      break;
    }
    if (s5[i - 1] >= s10[i - 1] && s5[i] < s10[i]) {
      out.cross = 'death';
      out.crossAgo = closes.length - 1 - i;
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 情绪 / 资金类标签（供选股叠加）

/** 全市场集合类接口的短时内存缓存，避免同一轮筛选里重复取。 */
const tagCache = new Map();
async function cachedTag(key, ttlMs, fn) {
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  tagCache.set(key, { at: Date.now(), value });
  return value;
}

/** 涨停池：thscode → 该股涨停信息（连板数、封单等）。取不到当日则回退前一交易日。 */
function getLimitUpMap() {
  return cachedTag('limitUp', 60_000, async () => {
    const { last, prev } = await resolveTradeDays();
    let items = (await client.limitUpPool({ dateMs: last.date_ms, size: 200 }))?.item ?? [];
    if (!items.length && prev) {
      items = (await client.limitUpPool({ dateMs: prev.date_ms, size: 200 }))?.item ?? [];
    }
    const map = new Map();
    for (const it of items) map.set(String(it.thscode).toUpperCase(), it);
    return map;
  });
}

function getLimitBreakSet() {
  return cachedTag('limitBreak', 60_000, async () => {
    const { last, prev } = await resolveTradeDays();
    let items = (await client.get('/api/a-share/special-data/limit-break-pool', { date_ms: last.date_ms, size: 200 }))?.item ?? [];
    if (!items.length && prev) {
      items = (await client.get('/api/a-share/special-data/limit-break-pool', { date_ms: prev.date_ms, size: 200 }))?.item ?? [];
    }
    return new Map(items.map((it) => [String(it.thscode).toUpperCase(), it]));
  });
}

function getLimitDownSet() {
  return cachedTag('limitDown', 60_000, async () => {
    const { last, prev } = await resolveTradeDays();
    let items = (await client.get('/api/a-share/special-data/limit-down-pool', { date_ms: last.date_ms, size: 200 }))?.item ?? [];
    if (!items.length && prev) {
      items = (await client.get('/api/a-share/special-data/limit-down-pool', { date_ms: prev.date_ms, size: 200 }))?.item ?? [];
    }
    return new Map(items.map((it) => [String(it.thscode).toUpperCase(), it]));
  });
}

/**
 * 龙虎榜：thscode → 该股上榜信息。
 * **必须按档位取对应榜单**：`board_type=all` 的返回里只有 hot_money_net_value，没有
 * org_net_value（实测），想按机构净买筛选就必须取 `org` 榜，否则会筛出空结果。
 */
function getDragonTigerMap(board) {
  return cachedTag(`dragonTiger:${board}`, 3600_000, async () => {
    const d = await client.dragonTigerList({ boardType: board });
    const map = new Map();
    for (const it of d?.stock_items ?? []) map.set(String(it.thscode).toUpperCase(), it);
    return map;
  });
}

/** 热股榜：thscode → { rank, rank_change } */
function getHotMap() {
  return cachedTag('hot', 60_000, async () => {
    const d = await client.hotStockList({ period: 'day' });
    const map = new Map();
    for (const it of d?.item ?? []) map.set(String(it.thscode).toUpperCase(), it);
    return map;
  });
}

/** 个股异动榜（按标签，全市场一次取回）：tag 见 ANOMALY_TAGS */
const ANOMALY_TAGS = {
  LIMIT_UP: '涨停',
  LIMIT_DOWN: '跌停',
  SHARP_RISE: '急涨',
  SHARP_FALL: '急跌',
  RAPID_RALLY: '快速拉升',
  RAPID_DECLINE: '快速回落',
};

function getAnomalyMap(tag) {
  return cachedTag(`anomaly:${tag}`, 60_000, async () => {
    const d = await client.get('/api/a-share/special-data/anomaly-analysis-list', { tag_codes: tag });
    const map = new Map();
    for (const it of d?.item ?? []) {
      if (it?.thscode) map.set(String(it.thscode).toUpperCase(), it);
    }
    return map;
  });
}

// ---------------------------------------------------------------- 回测引擎

/**
 * 双均线策略回测（单标的）。
 *
 * 避免未来函数：第 i 根出现信号，用第 i+1 根的**开盘价**成交，而不是当根收盘价。
 * 满仓进出，买卖双边各收一次手续费。
 */
function backtestMACross(bars, { fast, slow, capital, fee, windowStartMs }) {
  const closes = bars.map((b) => Number(b.close_price));
  const ma = (period) => {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  };
  const maFast = ma(fast);
  const maSlow = ma(slow);

  let cash = capital;
  let shares = 0;
  let entryPrice = null;
  const trades = [];
  const equity = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 先按当根收盘价记录市值曲线
    equity.push({ date_ms: bar.date_ms, value: cash + shares * closes[i] });

    // 需要下一根才能成交
    const next = bars[i + 1];
    if (!next) break;
    if (maSlow[i] === null || maFast[i] === null || maSlow[i - 1] === null || maFast[i - 1] === null) continue;
    if (bar.date_ms < windowStartMs) continue; // 窗口外的 bar 只用于均线预热

    const goldenCross = maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i];
    const deathCross = maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i];
    const execPrice = Number(next.open_price);
    if (!Number.isFinite(execPrice) || execPrice <= 0) continue;

    if (goldenCross && shares === 0) {
      shares = cash / (execPrice * (1 + fee));
      cash = 0;
      entryPrice = execPrice;
      trades.push({ date_ms: next.date_ms, side: 'buy', price: execPrice });
    } else if (deathCross && shares > 0) {
      cash = shares * execPrice * (1 - fee);
      trades.push({
        date_ms: next.date_ms,
        side: 'sell',
        price: execPrice,
        pnlPct: ((execPrice - entryPrice) / entryPrice) * 100,
      });
      shares = 0;
      entryPrice = null;
    }
  }

  const lastClose = closes[closes.length - 1];
  const finalEquity = cash + shares * lastClose;

  // 最大回撤
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - p.value) / peak) * 100);
  }

  const inWindow = bars.filter((b) => b.date_ms >= windowStartMs);
  const firstOpen = inWindow.length ? Number(inWindow[0].open_price) : null;
  const buyHoldPct =
    firstOpen && firstOpen > 0 ? ((lastClose / (firstOpen * (1 + fee))) - 1) * 100 : null;

  const years = inWindow.length > 1
    ? (inWindow[inWindow.length - 1].date_ms - inWindow[0].date_ms) / (365 * 86400e3)
    : 0;
  const totalReturnPct = ((finalEquity - capital) / capital) * 100;
  const annualizedPct =
    years > 0.05 && finalEquity > 0 ? ((finalEquity / capital) ** (1 / years) - 1) * 100 : null;

  const sells = trades.filter((t) => t.side === 'sell');
  const wins = sells.filter((t) => t.pnlPct > 0).length;

  return {
    finalEquity,
    totalReturnPct,
    annualizedPct,
    maxDrawdownPct: maxDrawdown,
    buyHoldPct,
    trades,
    tradeCount: sells.length,
    winRatePct: sells.length ? (wins / sells.length) * 100 : null,
    bars: inWindow.length,
    openPosition: shares > 0,
  };
}

// ---------------------------------------------------------------- K 线周期聚合

/**
 * 把日线聚合成周/月/季/年线。
 *
 * 上游 `interval` 只接受 `1d`（无周/月/季/年，更没有分钟线），所以周期切换必须自己聚合。
 * 聚合口径与行情软件一致：开盘取区间首根开盘，最高/最低取区间极值，收盘取区间末根收盘，
 * 成交量/成交额求和；时间戳取区间**最后一个交易日**，使最新一根对齐到当前。
 * 入参 bars 按时间升序（上游行为，已实测）。
 */
function aggregateBars(bars, period) {
  if (period === 'day' || bars.length === 0) return bars;

  const bucketOf = (ms) => {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (period === 'week') {
      // 以周一为每周起点
      const t = new Date(y, m, d.getDate());
      t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    }
    if (period === 'month') return `${y}-${String(m + 1).padStart(2, '0')}`;
    if (period === 'quarter') return `${y}-Q${Math.floor(m / 3) + 1}`;
    if (period === 'year') return String(y);
    return String(ms);
  };

  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = bucketOf(b.date_ms);
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur.bar);
      cur = {
        key,
        bar: {
          date_ms: b.date_ms,
          open_price: b.open_price,
          high_price: b.high_price,
          low_price: b.low_price,
          close_price: b.close_price,
          volume: Number(b.volume) || 0,
          turnover: Number(b.turnover) || 0,
        },
      };
    } else {
      const c = cur.bar;
      c.high_price = Math.max(Number(c.high_price), Number(b.high_price));
      c.low_price = Math.min(Number(c.low_price), Number(b.low_price));
      c.close_price = b.close_price;
      c.volume += Number(b.volume) || 0;
      c.turnover += Number(b.turnover) || 0;
      c.date_ms = b.date_ms;
    }
  }
  if (cur) out.push(cur.bar);
  return out;
}

// ---------------------------------------------------------------- HTTP 辅助

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

// ---------------------------------------------------------------- 路由

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    // 自选股列表（含名称与实时行情）
    if (p === '/api/watchlist' && req.method === 'GET') {
      const items = await loadWatchlist();
      const codes = items.map((i) => i.thscode);
      let quotes = new Map();
      let quoteError = null;
      if (codes.length) {
        try {
          const snap = await client.snapshot(codes);
          quotes = new Map((snap?.item ?? []).map((it) => [it.thscode.toUpperCase(), it]));
        } catch (err) {
          quoteError = err instanceof HithinkError ? { code: err.code, message: err.message } : { message: String(err.message) };
        }
      }
      let byCode = new Map();
      try {
        byCode = (await getTickerIndex()).byCode;
      } catch {
        /* 名称可选，拿不到就显示空 */
      }
      const rows = items.map((it) => {
        const q = quotes.get(it.thscode) ?? {};
        return {
          thscode: it.thscode,
          name: byCode.get(it.thscode) ?? '',
          last_price: q.last_price ?? null,
          prev_price: q.prev_price ?? null,
          price_change: q.price_change ?? null,
          price_change_ratio_pct: q.price_change_ratio_pct ?? null,
          open_price: q.open_price ?? null,
          high_price: q.high_price ?? null,
          low_price: q.low_price ?? null,
          volume: q.volume ?? null,
          turnover: q.turnover ?? null,
        };
      });
      return sendJson(res, 200, { items: rows, quoteError });
    }

    // 批量添加
    if (p === '/api/watchlist' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { resolved, failed } = await resolveTokens(body.input);
      const items = await loadWatchlist();
      const existing = new Set(items.map((i) => i.thscode));
      const added = [];
      for (const r of resolved) {
        if (existing.has(r.thscode)) continue;
        items.push({ thscode: r.thscode, addedAt: new Date().toISOString() });
        existing.add(r.thscode);
        added.push(r);
      }
      await saveWatchlist(items);
      return sendJson(res, 200, { added, failed, total: items.length });
    }

    // 删除
    if (p.startsWith('/api/watchlist/') && req.method === 'DELETE') {
      const code = decodeURIComponent(p.slice('/api/watchlist/'.length)).toUpperCase();
      const items = await loadWatchlist();
      const next = items.filter((i) => i.thscode !== code);
      await saveWatchlist(next);
      return sendJson(res, 200, { removed: items.length - next.length, total: next.length });
    }

    // K 线
    if (p === '/api/kline' && req.method === 'GET') {
      const thscode = url.searchParams.get('thscode');
      if (!thscode) return sendJson(res, 400, { error: '缺少 thscode' });
      const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 365) || 365, 30), 3650);
      const adjust = url.searchParams.get('adjust') ?? 'forward';
      const periodRaw = url.searchParams.get('period') ?? 'day';
      const period = ['day', 'week', 'month', 'quarter', 'year'].includes(periodRaw) ? periodRaw : 'day';

      // 均线预热：按周期折算成额外日历天数（周线一根≈8天，月线≈33天……）
      const perBarDays = { day: 1.6, week: 8, month: 33, quarter: 96, year: 372 }[period];
      const WARMUP_BARS = 60;
      // 额外多取 40%，给前端的「滚轮缩小」留出空间；上限仍是上游的 10 年窗口
      const fetchDays = Math.min(Math.ceil(days * 1.4 + WARMUP_BARS * perBarDays), 3650);

      const end = Date.now();
      const start = end - fetchDays * 86400_000;
      const [data, index] = await Promise.all([
        client.historical(thscode.toUpperCase(), { start, end, adjust }),
        getTickerIndex().catch(() => ({ byCode: new Map() })),
      ]);

      const daily = data?.item ?? [];
      const items = aggregateBars(daily, period);

      return sendJson(res, 200, {
        thscode: thscode.toUpperCase(),
        name: index.byCode.get(thscode.toUpperCase()) ?? '',
        interval: data?.interval ?? '1d',
        period,
        adjust: data?.adjust ?? adjust,
        // 显示窗口起点：客户端据此裁掉用于均线预热的前置 bar
        displayStartMs: end - days * 86400_000,
        dailyBars: daily.length,
        items,
      });
    }

    // 复盘 / 情绪面板
    if (p === '/api/review' && req.method === 'GET') {
      const days = await getTradingDays();
      const { last, prev } = await resolveTradeDays();

      // 交易日历的 date 是 yyyyMMdd，龙虎榜是 yyyy-MM-dd —— 统一成后者再返回，
      // 否则前端会直接显示成 20260911 这种前后不一致的格式。
      const fmtDay = (s) => (/^\d{8}$/.test(s ?? '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (s ?? ''));

      // 可选 ?date= 指定复盘某个历史交易日（接受 yyyyMMdd 或 yyyy-MM-dd）
      const qDate = url.searchParams.get('date');
      let requestedMs = null;
      let requestedDay = null;
      if (qDate) {
        const compact = qDate.replace(/-/g, '');
        requestedDay = days.find((d) => d.date === compact) ?? null;
        if (!requestedDay) {
          return sendJson(res, 400, { error: `${qDate} 不是交易日（近一年内无此交易日）` });
        }
        requestedMs = requestedDay.date_ms;
      }

      const errors = {};
      const safe = async (key, fn) => {
        try {
          return await fn();
        } catch (err) {
          errors[key] = err instanceof HithinkError ? `[${err.code}] ${err.message}` : String(err.message);
          return null;
        }
      };

      const fetchPanels = (dateMs) =>
        Promise.all([
          safe('limitUp', () => client.limitUpPool({ dateMs, size: 60 })),
          safe('limitDown', () => client.get('/api/a-share/special-data/limit-down-pool', { date_ms: dateMs, size: 30 })),
          safe('limitBreak', () => client.get('/api/a-share/special-data/limit-break-pool', { date_ms: dateMs, size: 30 })),
          safe('ladder', () => client.limitUpLadder()),
          safe('hot', () => client.hotStockList({ period: 'day' })),
          safe('skyrocket', () => client.get('/api/a-share/special-data/skyrocket-list', { period: 'day' })),
        ]);

      let usedDay = requestedDay ?? last;
      let [limitUp, limitDown, limitBreak, ladder, hot, skyrocket] = await fetchPanels(usedDay.date_ms);

      // 未指定日期时：最新交易日三个池子全空，多为当日盘前/数据未就绪 →
      // 回退到前一交易日并标注实际使用的日期。指定日期时严格按指定日期，不回退。
      const emptySession =
        (limitUp?.item ?? []).length === 0 &&
        (limitDown?.item ?? []).length === 0 &&
        (limitBreak?.item ?? []).length === 0;
      if (!requestedDay && emptySession && prev) {
        usedDay = prev;
        [limitUp, limitDown, limitBreak, ladder, hot, skyrocket] = await fetchPanels(prev.date_ms);
      }

      // 连板天梯：item[0] 是最新日期（实测为降序）
      const ladderDays = ladder?.item ?? [];
      const latestLadder = ladderDays[0] ?? null;

      return sendJson(res, 200, {
        tradeDate: fmtDay(usedDay.date),
        tradeDateMs: usedDay.date_ms,
        requested: Boolean(requestedDay),
        fellBack: !requestedDay && usedDay.date !== last.date,
        calendarLastDate: fmtDay(last.date),
        errors,
        panels: {
          limitUp: limitUp?.item ?? [],
          limitUpTotal: limitUp?.pagination?.total ?? null,
          limitDown: limitDown?.item ?? [],
          limitBreak: limitBreak?.item ?? [],
          ladder: latestLadder,
          ladderDays: ladderDays.map((d) => d.date),
          hot: hot?.item ?? [],
          skyrocket: skyrocket?.item ?? [],
        },
      });
    }

    // 龙虎榜（独立接口：有 全部/机构/游资 三档切换）
    if (p === '/api/review/dragon-tiger' && req.method === 'GET') {
      const board = ['all', 'org', 'hot_money'].includes(url.searchParams.get('board'))
        ? url.searchParams.get('board')
        : 'all';
      // 指定日期时跟随复盘日期，保证同一屏里各面板口径一致
      const qDate = url.searchParams.get('date');
      const data = await client.dragonTigerList({ boardType: board, date: qDate || undefined });
      return sendJson(res, 200, {
        boardType: data?.board_type ?? board,
        tradeDate: data?.trade_date ?? null,
        count: data?.count ?? 0,
        stockCount: data?.stock_count ?? 0,
        stockItems: data?.stock_items ?? [],
        hotMoneyItems: data?.hot_money_items ?? [],
      });
    }

    // 选股筛选：全市场行情粗筛 → 入围股补估值
    if (p === '/api/screener' && req.method === 'GET') {
      const q = url.searchParams;
      const num = (k) => {
        const v = q.get(k);
        if (v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      /** v 为 null/NaN 时，只要设了任一边界就算不通过（上游空值不补零） */
      const inRange = (v, lo, hi) => {
        if (lo === null && hi === null) return true;
        if (v === null || v === undefined || !Number.isFinite(Number(v))) return false;
        const x = Number(v);
        if (lo !== null && x < lo) return false;
        if (hi !== null && x > hi) return false;
        return true;
      };

      const minPrice = num('minPrice');
      const maxPrice = num('maxPrice');
      const minPct = num('minPct');
      const maxPct = num('maxPct');
      const minAmountYi = num('minAmountYi');
      const maxAmountYi = num('maxAmountYi');
      const minPe = num('minPe');
      const maxPe = num('maxPe');
      const minPb = num('minPb');
      const maxPb = num('maxPb');
      const excludeSt = q.get('excludeSt') === '1';
      const top = Math.min(Math.max(num('top') ?? 50, 1), 200);
      const ENRICH_MAX = 200; // 估值单次上限 100 → 最多 2 批

      // ---- 均线条件
      const maRefRaw = q.get('maRef');
      const maRef = ['5', '10', '20', '30', '60'].includes(maRefRaw) ? Number(maRefRaw) : null;
      const maDevMin = num('maDevMin');     // 偏离%（相对所选均线，负=在均线下方）
      const maDevMax = num('maDevMax');
      const maAlignRaw = q.get('maAlign');
      const maAlign = ['bull', 'bear'].includes(maAlignRaw) ? maAlignRaw : '';
      // 均线要逐只取 K 线，必须设上限，否则一次筛选要打几千次上游
      const maScan = Math.min(Math.max(num('maScan') ?? 150, 20), 600);
      const maCrossRaw = q.get('maCross');
      const maCross = ['golden', 'death'].includes(maCrossRaw) ? maCrossRaw : '';
      const maCrossWithin = Math.min(Math.max(num('maCrossWithin') ?? 5, 1), 60);

      // ---- 行情派生条件：全部来自同一份快照，零额外请求
      const minAmplitude = num('minAmplitude');
      const maxAmplitude = num('maxAmplitude');
      const minGap = num('minGap');                 // 开盘跳空%
      const maxGap = num('maxGap');
      const minCloseStrength = num('minCloseStrength'); // 收盘在当日区间的位置%
      const maxCloseStrength = num('maxCloseStrength');
      const candleRaw = q.get('candle');
      const candle = ['yang', 'yin'].includes(candleRaw) ? candleRaw : '';

      // ---- 情绪 / 资金类条件：每个最多 1 次全市场请求，且有短时缓存
      const wantLimitUp = q.get('limitUp') === '1';
      const minBoards = num('minBoards');           // 连板数 >=
      const wantBreak = q.get('limitBreak') === '1';
      const wantDown = q.get('limitDown') === '1';
      const dtRaw = q.get('dt');
      const dtMode = ['all', 'org', 'hot'].includes(dtRaw) ? dtRaw : '';
      const hotTop = num('hotTop');                 // 热榜前 N
      const anomalyRaw = (q.get('anomaly') ?? '').trim().toUpperCase();
      const anomaly = ANOMALY_TAGS[anomalyRaw] ? anomalyRaw : '';

      const snap = await getMarketSnapshot();
      const index = await getTickerIndex().catch(() => ({ byCode: new Map() }));

      const all = [];
      for (const r of snap.rows) {
        const code = String(r.thscode ?? '').toUpperCase();
        if (!code) continue;
        const prev = Number(r.prev_price);
        const hi = Number(r.high_price);
        const lo = Number(r.low_price);
        const openP = Number(r.open_price);
        const closeP = Number(r.last_price);
        const num3 = (v) => (Number.isFinite(v) ? v : null);
        all.push({
          thscode: code,
          name: index.byCode.get(code) ?? '',
          last_price: r.last_price,
          pct: r.price_change_ratio_pct,
          amount: r.turnover,
          amountYi: r.turnover === null || r.turnover === undefined ? null : r.turnover / 1e8,
          amplitude: prev > 0 && num3(hi) !== null && num3(lo) !== null ? ((hi - lo) / prev) * 100 : null,
          gap: prev > 0 && num3(openP) !== null ? ((openP - prev) / prev) * 100 : null,
          closeStrength:
            num3(hi) !== null && num3(lo) !== null && num3(closeP) !== null && hi > lo
              ? ((closeP - lo) / (hi - lo)) * 100
              : null,
          isUp: num3(openP) !== null && num3(closeP) !== null ? closeP >= openP : null,
        });
      }

      const hasValuationFilter = [minPe, maxPe, minPb, maxPb].some((v) => v !== null);

      let rows = all.filter(
        (r) =>
          inRange(r.last_price, minPrice, maxPrice) &&
          inRange(r.pct, minPct, maxPct) &&
          inRange(r.amountYi, minAmountYi, maxAmountYi) &&
          inRange(r.amplitude, minAmplitude, maxAmplitude) &&
          inRange(r.gap, minGap, maxGap) &&
          inRange(r.closeStrength, minCloseStrength, maxCloseStrength) &&
          (!candle || (candle === 'yang' ? r.isUp === true : r.isUp === false)) &&
          (!excludeSt || !/ST/i.test(r.name)),
      );
      const afterMarketFilters = rows.length;

      // 按成交额降序：后面的情绪过滤、均线扫描与估值补全都从成交额大的开始
      rows.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

      // ---- 情绪 / 资金阶段：集合类接口一次取回全市场，然后按标签过滤
      const wantsTagFilter =
        wantLimitUp || minBoards !== null || wantBreak || wantDown || Boolean(dtMode) || hotTop !== null || Boolean(anomaly);

      let tagStage = null;
      if (wantsTagFilter) {
        const [luMap, bkMap, dnMap, dtMap, hotMap, anoMap] = await Promise.all([
          wantLimitUp || minBoards !== null ? getLimitUpMap() : null,
          wantBreak ? getLimitBreakSet() : null,
          wantDown ? getLimitDownSet() : null,
          dtMode ? getDragonTigerMap(dtMode === 'org' ? 'org' : dtMode === 'hot' ? 'hot_money' : 'all') : null,
          hotTop !== null ? getHotMap() : null,
          anomaly ? getAnomalyMap(anomaly) : null,
        ]);

        const before = rows.length;
        const kept = [];
        for (const r of rows) {
          const lu = luMap?.get(r.thscode);
          const tags = [];

          if (wantLimitUp && !lu) continue;
          if (minBoards !== null) {
            const boards = Number(lu?.continue_day_cnt ?? 0);
            if (!(boards >= minBoards)) continue;
          }
          if (wantBreak && !bkMap?.has(r.thscode)) continue;
          if (wantDown && !dnMap?.has(r.thscode)) continue;

          const dt = dtMap?.get(r.thscode);
          if (dtMode) {
            if (!dt) continue;
            if (dtMode === 'org' && !(Number(dt.org_net_value) > 0)) continue;
            if (dtMode === 'hot' && !(Number(dt.hot_money_net_value) > 0)) continue;
          }

          const hot = hotMap?.get(r.thscode);
          if (hotTop !== null && !(hot && Number(hot.rank) <= hotTop)) continue;

          const ano = anoMap?.get(r.thscode);
          if (anomaly && !ano) continue;

          // 打上标签，界面上直接能看到"为什么它被筛出来"
          if (lu) tags.push(lu.continue_day_cnt > 1 ? `${lu.continue_day_text || lu.continue_day_cnt + '板'}` : '涨停');
          if (bkMap?.has(r.thscode)) tags.push('炸板');
          if (dnMap?.has(r.thscode)) tags.push('跌停');
          if (dt) tags.push(dtMode === 'org' ? '机构净买' : dtMode === 'hot' ? '游资净买' : '龙虎榜');
          if (hot) tags.push(`热榜#${hot.rank}`);
          if (ano) tags.push(ANOMALY_TAGS[anomaly] ?? anomaly);
          if (tags.length) r.tags = tags;
          kept.push(r);
        }
        rows = kept;
        tagStage = {
          before,
          after: kept.length,
          limitUpPool: luMap?.size ?? null,
          limitBreakPool: bkMap?.size ?? null,
          limitDownPool: dnMap?.size ?? null,
          dragonTigerPool: dtMap?.size ?? null,
          hotPool: hotMap?.size ?? null,
          anomalyPool: anoMap?.size ?? null,
        };
      }

      // ---- 均线阶段：逐只取历史 K 线，只能扫前 maScan 只，覆盖范围如实上报
      const hasMaFilter = maRef !== null || maAlign !== '' || Boolean(maCross);
      let maStage = null;
      if (hasMaFilter && rows.length) {
        const t0 = Date.now();
        const candidates = rows.slice(0, maScan);
        const endMs = Date.now();
        // 5 路并发；单只失败只让该只缺值，不影响整轮
        const mas = await mapLimited(candidates, 5, (r) => computeMAs(r.thscode, endMs).catch(() => null));

        const kept = [];
        let noHistory = 0;
        candidates.forEach((r, i) => {
          const m = mas[i];
          if (!m) {
            noHistory += 1; // 日线不足 60 根（新股/长期停牌），跳过而不是给假值
            return;
          }
          r.ma = m;
          if (maRef !== null && !inRange(m[`dev${maRef}`], maDevMin, maDevMax)) return;
          if (maAlign && m.align !== maAlign) return;
          if (maCross && !(m.cross === maCross && m.crossAgo !== null && m.crossAgo <= maCrossWithin)) return;
          // 近期金叉/死叉也打个标签，方便一眼看出被筛出来的原因
          if (m.cross && m.crossAgo !== null && m.crossAgo <= 5) {
            r.tags = [...(r.tags ?? []), m.cross === 'golden' ? `金叉${m.crossAgo}日` : `死叉${m.crossAgo}日`];
          }
          kept.push(r);
        });

        maStage = {
          ref: maRef,
          align: maAlign || null,
          cross: maCross || null,
          crossWithin: maCross ? maCrossWithin : null,
          scanned: candidates.length,
          noHistory,
          matched: kept.length,
          elapsedMs: Date.now() - t0,
          poolSize: rows.length,
        };
        rows = kept;
      }

      // ---- 估值阶段：受上游 100 只/次限制，只补前 ENRICH_MAX 只
      const valuationCapped = rows.length > ENRICH_MAX;
      const toEnrich = rows.slice(0, ENRICH_MAX);

      const valMap = new Map();
      for (let i = 0; i < toEnrich.length; i += 100) {
        const batch = toEnrich.slice(i, i + 100).map((r) => r.thscode);
        const d = await client.valuations(batch);
        for (const it of d?.item ?? []) valMap.set(String(it.thscode).toUpperCase(), it);
      }
      for (const r of toEnrich) {
        const v = valMap.get(r.thscode);
        r.pe_ttm = v?.pe_ttm ?? null;
        r.pb_mrq = v?.pb_mrq ?? null;
        r.ps_ttm = v?.ps_ttm ?? null;
      }

      const final = toEnrich.filter(
        (r) => inRange(r.pe_ttm, minPe, maxPe) && inRange(r.pb_mrq, minPb, maxPb),
      );

      // 覆盖范围必须说清楚，不能让人以为筛的是全市场
      const notes = [];
      if (maStage && maStage.poolSize > maStage.scanned) {
        notes.push(`均线扫描只覆盖成交额前 ${maStage.scanned} 只（粗筛后共 ${maStage.poolSize} 只）`);
      }
      if (valuationCapped && hasValuationFilter) {
        notes.push(`估值筛选只覆盖成交额前 ${ENRICH_MAX} 只`);
      }

      return sendJson(res, 200, {
        scanned: all.length,
        afterMarketFilters,
        tagStage,
        maStage,
        enriched: toEnrich.length,
        matched: final.length,
        valuationCapped,
        notes,
        valuationNote: notes.length ? notes.join('；') : null,
        rows: final.slice(0, top),
      });
    }

    // 策略回测：双均线，默认跑自选股池
    if (p === '/api/backtest' && req.method === 'GET') {
      const q = url.searchParams;
      const num = (k) => {
        const v = q.get(k);
        if (v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      let codes = (q.get('thscodes') ?? '')
        .split(/[\s,，、]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (!codes.length) {
        codes = (await loadWatchlist()).map((i) => i.thscode);
      }
      if (!codes.length) {
        return sendJson(res, 400, { error: '没有可回测的标的：请先添加自选股，或用 thscodes 指定' });
      }
      if (codes.length > 30) codes = codes.slice(0, 30);

      const fast = Math.min(Math.max(num('fast') ?? 5, 2), 120);
      const slow = Math.min(Math.max(num('slow') ?? 20, 3), 250);
      if (fast >= slow) {
        return sendJson(res, 400, { error: `快线周期(${fast})必须小于慢线周期(${slow})` });
      }
      const days = Math.min(Math.max(num('days') ?? 730, 60), 3650);
      const capital = Math.min(Math.max(num('capital') ?? 100000, 1000), 1e9);
      const fee = Math.min(Math.max(num('fee') ?? 0.0003, 0), 0.02);

      const now = Date.now();
      const windowStartMs = now - days * 86400e3;
      // 均线预热：多取一段，只用于算均线，窗口外不产生交易
      const warmupDays = Math.ceil((slow + 10) * 1.7);
      const fetchStartMs = windowStartMs - warmupDays * 86400e3;

      const index = await getTickerIndex().catch(() => ({ byCode: new Map() }));
      const rows = [];
      const tradesByCode = {};
      const errors = {};

      for (const code of codes) {
        try {
          const d = await client.historical(code, { start: fetchStartMs, end: now, adjust: 'forward' });
          const bars = d?.item ?? [];
          if (bars.length < slow + 5) {
            errors[code] = `K 线不足（${bars.length} 根，慢线需 ${slow}）`;
            continue;
          }
          const r = backtestMACross(bars, { fast, slow, capital, fee, windowStartMs });
          tradesByCode[code] = r.trades;
          rows.push({
            thscode: code,
            name: index.byCode.get(code) ?? '',
            finalEquity: r.finalEquity,
            totalReturnPct: r.totalReturnPct,
            annualizedPct: r.annualizedPct,
            maxDrawdownPct: r.maxDrawdownPct,
            buyHoldPct: r.buyHoldPct,
            tradeCount: r.tradeCount,
            winRatePct: r.winRatePct,
            bars: r.bars,
            openPosition: r.openPosition,
          });
        } catch (err) {
          errors[code] = err instanceof HithinkError ? `[${err.code}] ${err.message}` : String(err.message);
        }
      }

      rows.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
      return sendJson(res, 200, {
        params: { fast, slow, days, capital, fee },
        rows,
        tradesByCode,
        errors,
      });
    }

    // ---- 价格预警 ----

    // 预警列表 + 未确认的触发事件 + 监控状态（不含上游请求，前端 5 秒轮询这个接口）
    if (p === '/api/alerts' && req.method === 'GET') {
      return sendJson(res, 200, await alertsPayload());
    }

    // 新增预警：{ input, direction: 'above'|'below', target, note }
    if (p === '/api/alerts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const direction = ['above', 'below'].includes(body.direction) ? body.direction : null;
      if (!direction) return sendJson(res, 400, { error: 'direction 必须是 above（涨到）或 below（跌到）' });
      const target = Number(body.target);
      if (!Number.isFinite(target) || target <= 0) return sendJson(res, 400, { error: '目标价必须是正数' });

      const { resolved, failed } = await resolveTokens(body.input);
      if (!resolved.length) return sendJson(res, 400, { error: '没有解析出可监控的标的', failed });

      const store = await loadAlerts();
      const added = [];
      const skipped = [];
      const warnings = [];
      for (const r of resolved) {
        const dup = store.items.find(
          (a) =>
            a.thscode === r.thscode &&
            a.direction === direction &&
            Number(a.target) === target &&
            a.enabled &&
            !a.triggeredAt,
        );
        if (dup) {
          skipped.push({ ...r, reason: '已存在完全相同的预警' });
          continue;
        }
        const item = {
          id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          thscode: r.thscode,
          name: r.name ?? '',
          direction,
          target,
          note: String(body.note ?? '').slice(0, 60),
          enabled: true,
          createdAt: new Date().toISOString(),
          triggeredAt: null,
          triggeredPrice: null,
        };
        store.items.push(item);
        added.push(item);
        if (r.ambiguous) {
          warnings.push(
            `名称不唯一，已按最匹配选择：${r.name}(${r.thscode}) ← ${(r.alternatives ?? []).slice(0, 3).join(' / ')}`,
          );
        }
      }
      if (added.length) await saveAlerts();

      // 立刻取一次价格：既填上"现价/距离目标"，也能发现"价位写反了、当下就已满足"
      if (added.length) {
        const check = await checkAlerts({ force: true, source: 'manual' });
        for (const ev of check.triggers) {
          warnings.push(`目标价当下已满足（现价 ${ev.price}），已立即触发一次 —— 请确认价位有没有写反`);
        }
      }
      return sendJson(res, 200, { added, skipped, failed, warnings, ...(await alertsPayload()) });
    }

    // 立即检查一次（非交易时段也判定，用于设置完当场确认价差）
    if (p === '/api/alerts/check' && req.method === 'POST') {
      const r = await checkAlerts({ force: true, source: 'manual' });
      return sendJson(res, 200, {
        session: r.session,
        checked: r.checked,
        triggers: r.triggers,
        error: r.error,
        ...(await alertsPayload()),
      });
    }

    // 确认提示（前端弹过窗之后调用，避免刷新页面重复弹）
    if (p === '/api/alerts/ack' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
      const store = await loadAlerts();
      let acked = 0;
      if (ids.size) {
        for (const e of store.events) {
          if (!e.ack && ids.has(e.id)) {
            e.ack = true;
            acked += 1;
          }
        }
        if (acked) await saveAlerts();
      }
      return sendJson(res, 200, { acked, ...(await alertsPayload()) });
    }

    // 单条预警操作：{ action: 'reset' | 'enable' | 'disable' }
    if (p.startsWith('/api/alerts/') && req.method === 'POST') {
      const id = decodeURIComponent(p.slice('/api/alerts/'.length));
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = await loadAlerts();
      const item = store.items.find((a) => a.id === id);
      if (!item) return sendJson(res, 404, { error: '预警不存在' });
      if (body.action === 'reset') {
        item.triggeredAt = null;
        item.triggeredPrice = null;
        delete item.triggeredBy;
        item.enabled = true;
      } else if (body.action === 'enable') {
        item.enabled = true;
      } else if (body.action === 'disable') {
        item.enabled = false;
      } else {
        return sendJson(res, 400, { error: `未知操作 ${body.action}` });
      }
      await saveAlerts();
      return sendJson(res, 200, { ok: true, ...(await alertsPayload()) });
    }

    if (p.startsWith('/api/alerts/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/alerts/'.length));
      const store = await loadAlerts();
      const before = store.items.length;
      store.items = store.items.filter((a) => a.id !== id);
      if (store.items.length !== before) await saveAlerts();
      return sendJson(res, 200, { removed: before - store.items.length, ...(await alertsPayload()) });
    }

    // ---- 分时（自建采样）----
    // 上游没有 A 股分钟数据，所以分时图的数据是服务自己按时采样的结果，按天存盘。
    if (p === '/api/intraday/dates' && req.method === 'GET') {
      const dates = await listIntradayDates();
      return sendJson(res, 200, {
        dates: dates.map((d) => ({ date: d.date, bytes: d.bytes })),
        intervalSec: INTRADAY_INTERVAL_MS / 1000,
        monitor: {
          startedAt: intradayMonitor.startedAt,
          lastSampleAt: intradayMonitor.lastSampleAt,
          ticks: intradayMonitor.ticks,
          samples: intradayMonitor.samples,
          skippedClosed: intradayMonitor.skippedClosed,
          errors: intradayMonitor.errors,
          lastError: intradayMonitor.lastError,
        },
        dir: INTRADAY_DIR,
      });
    }

    if (p === '/api/intraday' && req.method === 'GET') {
      const thscode = (url.searchParams.get('thscode') ?? '').trim().toUpperCase();
      if (!thscode) return sendJson(res, 400, { error: '缺少 thscode' });
      let date = (url.searchParams.get('date') ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const dates = await listIntradayDates();
        date = dates[0]?.date ?? '';
      }
      if (!date) {
        return sendJson(res, 200, { thscode, date: null, count: 0, hasData: false, reason: '尚无任何分时记录' });
      }
      const day = await loadIntradayDay(date);
      const s = day?.series?.[thscode];
      if (!s || !s.t.length) {
        return sendJson(res, 200, {
          thscode, date, count: 0, hasData: false,
          reason: day ? '该日期未录到这只股票（分时只采自选股）' : '该日期没有记录',
        });
      }
      // 均价线（VWAP）= 累计成交额 / 累计成交量：上游给的就是当日累计值，直接相除即可
      const avg = s.to.map((to, i) => (s.v[i] > 0 ? to / s.v[i] : null));
      return sendJson(res, 200, {
        thscode,
        date,
        prevClose: day.prevClose[thscode] ?? null,
        count: s.t.length,
        hasData: true,
        t: s.t, p: s.p, v: s.v, to: s.to, avg,
        m: s.t.map((sec) => sessionMinuteOf(sec * 1000)),
      });
    }

    // 健康检查
    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        hasKey: client.hasKey,
        keySource: client.keySource,
        upstreamStats: client.stats,
      });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: `未知接口 ${p}` });

    return serveStatic(res, p);
  } catch (err) {
    const status = err instanceof HithinkError ? 502 : 500;
    console.error(`[error] ${req.method} ${p} → ${err.message}`);
    return sendJson(res, status, {
      error: err.message,
      code: err instanceof HithinkError ? err.code : undefined,
      requestId: err instanceof HithinkError ? err.requestId : undefined,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`自选股看板已启动： http://${HOST}:${PORT}`);
  console.log(`Key 来源： ${client.keySource}`);
  console.log(`自选股文件： ${WATCHLIST_FILE}`);
  console.log(`预警文件： ${ALERTS_FILE}`);
  console.log(`分时目录： ${INTRADAY_DIR}`);
  startAlertMonitor();
  startIntradayRecorder();
});

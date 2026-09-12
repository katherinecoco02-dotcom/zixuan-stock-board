/**
 * 同花顺金融数据 API（hithink-finance）客户端
 *
 * 契约来源：docs/api-spec.md（由官方文档实际抓取整理）
 *   - 全部接口均为 GET，Base URL https://fuyao.aicubes.cn
 *   - 鉴权：请求头 X-api-key
 *   - 统一信封：{ code, message, request_id, data }，code === 0 为成功
 *
 * ⚠️ 本文件在拿到可用 API Key 之前**未经真实调用验证**。已按文档契约编写，
 *    但"能跑通"这件事必须用 scripts/smoke.mjs 实测确认，不要假设它已经正确。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BASE_URL = 'https://fuyao.aicubes.cn';

/** 文档错误码表（docs/api-spec.md §1.3）。实测偏差见 AUTH_ERROR_CODES。 */
export const ERROR_CODES = {
  0: '成功',
  1001: '缺少必填参数',
  1002: '参数格式错误',
  1003: '参数取值越界',
  1004: '参数冲突',
  2001: '未认证（文档口径）',
  2003: '权限不足／Key 缺失或无效（实测口径）',
  3001: '标的不存在',
  3002: '数据未就绪',
  3004: '标的类型不支持该能力',
  4001: '频率超限',
  5001: '服务内部错误',
  5002: '上游服务超时',
  5003: '数据源不可用',
};

/** 视为"认证失败"的错误码。文档写 2001，实测无 Key 返回的是 2003。 */
const AUTH_ERROR_CODES = new Set([2001, 2003]);

/** 触发限流、应当退避重试的错误码 / HTTP 状态。 */
const RATE_LIMIT_CODES = new Set([4001]);
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

export class HithinkError extends Error {
  constructor(message, { code, requestId, httpStatus, path: reqPath } = {}) {
    super(message);
    this.name = 'HithinkError';
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
    this.path = reqPath;
    this.isAuthError = AUTH_ERROR_CODES.has(code) || httpStatus === 401 || httpStatus === 403;
    this.isRateLimit = RATE_LIMIT_CODES.has(code) || httpStatus === 429;
  }
}

/** 默认查找的 Key 文件名，按优先级排列（Windows 下点开头文件不好新建，故容忍别名）。 */
export const DEFAULT_KEY_FILES = ['.apikey', 'apikey.txt', 'hithink.apikey'];

/** 判断一行文本是不是占位符而不是真实 Key。 */
function looksLikePlaceholder(value) {
  if (!value) return true;
  if (/^<.*>$/.test(value)) return true;      // <粘贴 Key>
  if (value.includes('粘贴') || value.includes('在此')) return true;
  if (/^(your[-_ ]?)?api[-_ ]?key$/i.test(value)) return true;
  return false;
}

/**
 * 解析 API Key：环境变量优先，其次工作目录下的 Key 文件。
 * @param {{ keyFile?: string | string[] }} [opts]
 */
export function resolveApiKey({ keyFile = DEFAULT_KEY_FILES } = {}) {
  const fromEnv = process.env.HITHINK_FINANCE_API_KEY?.trim();
  if (fromEnv && !looksLikePlaceholder(fromEnv)) {
    return { key: fromEnv, source: 'env:HITHINK_FINANCE_API_KEY' };
  }

  const candidates = Array.isArray(keyFile) ? keyFile : [keyFile];
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (!existsSync(abs)) continue;
    const raw = readFileSync(abs, 'utf8');
    // 取第一个非空行；允许首行是 # 注释
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      const key = line.replace(/^["']|["']$/g, '').trim();
      if (looksLikePlaceholder(key)) return { key: null, source: abs, placeholderOnly: true };
      return { key, source: abs };
    }
    return { key: null, source: abs, placeholderOnly: lines.length > 0 };
  }
  return { key: null, source: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HithinkClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]      省略则自动从 env/.apikey 解析
   * @param {string} [opts.cacheDir]    磁盘缓存目录，none 表示关闭缓存
   * @param {number} [opts.minIntervalMs] 两次请求之间的最小间隔（节流）
   *
   * 关于 minIntervalMs：文档**未公布任何 QPS / 并发阈值**，只说明"不限累计
   * 调用次数、但可能动态限流，触发时降低频率且不要立即连续重试"。因此这里的
   * 默认值是我们自己的保守取值，不是官方参数——按需调整。
   */
  constructor({ apiKey, cacheDir = '.cache/hithink', minIntervalMs = 300, maxRetries = 4, fetchImpl } = {}) {
    const resolved = apiKey ? { key: apiKey, source: 'argument' } : resolveApiKey();
    this.apiKey = resolved.key;
    this.keySource = resolved.source;
    this.keyPlaceholder = Boolean(resolved.placeholderOnly);
    this.cacheDir = cacheDir === 'none' ? null : cacheDir;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._lastRequestAt = 0;
    this._stats = { requests: 0, cacheHits: 0, retries: 0 };
  }

  get hasKey() {
    return Boolean(this.apiKey);
  }

  get stats() {
    return { ...this._stats };
  }

  /**
   * 发起一次 GET，解开信封后返回 data。非 0 code 抛 HithinkError。
   * @param {string} apiPath 例如 '/api/a-share/prices/snapshot'
   * @param {Record<string, string|number|undefined|null>} [params]
   * @param {{ ttlMs?: number, cacheKey?: string }} [opts] ttlMs > 0 时启用磁盘缓存
   */
  async get(apiPath, params = {}, { ttlMs = 0, cacheKey } = {}) {
    if (!this.hasKey) {
      throw new HithinkError(
        '缺少 API Key。请把 Key 写入工作目录的 .apikey 文件，或设置环境变量 HITHINK_FINANCE_API_KEY。',
        { path: apiPath },
      );
    }

    const url = new URL(apiPath, BASE_URL);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }

    const cKey = cacheKey ?? `${apiPath}?${url.searchParams.toString()}`;
    if (ttlMs > 0 && this.cacheDir) {
      const hit = await this._readCache(cKey, ttlMs);
      if (hit !== null) {
        this._stats.cacheHits += 1;
        return hit;
      }
    }

    let attempt = 0;
    // 退避策略：1s → 2s → 4s → 8s。文档明确要求"不要立即连续重试"。
    for (;;) {
      await this._throttle();
      let res;
      try {
        res = await this._fetch(url, { headers: { 'X-api-key': this.apiKey, Accept: 'application/json' } });
      } catch (err) {
        if (attempt >= this.maxRetries) {
          throw new HithinkError(`网络请求失败：${err.message}`, { path: apiPath });
        }
        attempt += 1;
        this._stats.retries += 1;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }

      this._stats.requests += 1;

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      const retryable =
        RETRYABLE_HTTP.has(res.status) ||
        RATE_LIMIT_CODES.has(body?.code);

      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        this._stats.retries += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** (attempt - 1);
        await sleep(waitMs);
        continue;
      }

      if (!body || typeof body.code !== 'number') {
        throw new HithinkError(
          `响应不符合 ApiResponse 信封（HTTP ${res.status}）`,
          { httpStatus: res.status, path: apiPath },
        );
      }

      if (body.code !== 0) {
        const label = ERROR_CODES[body.code] ?? '未知错误码';
        throw new HithinkError(`[${body.code} ${label}] ${body.message ?? ''}`.trim(), {
          code: body.code,
          requestId: body.request_id,
          httpStatus: res.status,
          path: apiPath,
        });
      }

      if (ttlMs > 0 && this.cacheDir) await this._writeCache(cKey, body.data);
      return body.data;
    }
  }

  // ---------- 具体接口封装（路径与参数名均取自 docs/api-spec.md §2.1） ----------

  /** #10 交易日历（固定近一年，无入参） */
  tradingDays() {
    return this.get('/api/a-share/calendar/trading-days', {}, { ttlMs: 6 * 3600_000 });
  }

  /** #1 行情快照。传 thscodes 时按入参顺序批量返回且忽略分页；不返回中文名。 */
  snapshot(thscodes, { limit, offset } = {}) {
    const list = Array.isArray(thscodes) ? thscodes.join(',') : thscodes;
    // 快照是实时数据，缓存时间要短——看板刷新时不应读到过期价格。
    return this.get('/api/a-share/prices/snapshot', { thscodes: list, limit, offset }, { ttlMs: 10_000 });
  }

  /** #2 历史 K 线。每次仅一只；start/end 为毫秒戳，跨度 ≤ 10 年；interval 当前仅 1d。 */
  historical(thscode, { start, end, interval = '1d', adjust = 'forward' }) {
    return this.get(
      '/api/a-share/prices/historical',
      { thscode, interval, start, end, adjust },
      { ttlMs: 6 * 3600_000 },
    );
  }

  /** #3 标的检索（名称 / 代码片段 → thscode） */
  searchTickers(q, { exchange, assetType, limit = 10 } = {}) {
    return this.get('/api/meta/tickers/search', {
      q,
      exchange,
      asset_type: Array.isArray(assetType) ? assetType.join(',') : assetType,
      limit,
    });
  }

  /**
   * #4 全市场代码表，循环递增 offset 取尽（单页上限 10000）。
   * 用途：快照不返回中文名，需要用它建立 thscode → name 映射。
   */
  async allTickers({ assetType = 'a-share', pageSize = 10000 } = {}) {
    const out = [];
    let offset = 0;
    for (;;) {
      const data = await this.get(
        '/api/meta/tickers/list',
        { asset_type: assetType, limit: pageSize, offset },
        { ttlMs: 24 * 3600_000 },
      );
      const items = data?.item ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  }

  /** #15 估值快照（≤100 个 token） */
  valuations(thscodes) {
    const list = Array.isArray(thscodes) ? thscodes.join(',') : thscodes;
    return this.get('/api/a-share/valuations/snapshot', { thscodes: list }, { ttlMs: 3600_000 });
  }

  /** #18 涨停池。注意：省略 date_ms 时回退到**服务端当前自然日**，不是最近交易日。 */
  limitUpPool({ dateMs, page = 1, size = 50, sortField = 'last_price', sortDir = 'desc' } = {}) {
    return this.get('/api/a-share/special-data/limit-up-pool', {
      date_ms: dateMs, page, size, sort_field: sortField, sort_dir: sortDir,
    }, { ttlMs: 60_000 });
  }

  /** #21 连板天梯（固定近 30 交易日，无入参） */
  limitUpLadder() {
    return this.get('/api/a-share/special-data/limit-up-ladder', {}, { ttlMs: 60_000 });
  }

  /** #23 热股榜（Top30） */
  hotStockList({ period = 'day' } = {}) {
    return this.get('/api/a-share/special-data/hot-stock-list', { period }, { ttlMs: 60_000 });
  }

  /** #26 龙虎榜。省略 date 时取上一个交易日；显式传非交易日会报 1002。 */
  dragonTigerList({ boardType = 'all', date } = {}) {
    return this.get('/api/a-share/special-data/dragon-tiger-list', {
      board_type: boardType, date,
    }, { ttlMs: 3600_000 });
  }

  // ---------- 内部：节流与缓存 ----------

  async _throttle() {
    const now = Date.now();
    const wait = this._lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  _cachePath(key) {
    const h = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return path.join(this.cacheDir, `${h}.json`);
  }

  async _readCache(key, ttlMs) {
    const file = this._cachePath(key);
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > ttlMs) return null;
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return parsed.data ?? null;
    } catch {
      return null;
    }
  }

  async _writeCache(key, data) {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this._cachePath(key), JSON.stringify({ cachedAt: new Date().toISOString(), data }), 'utf8');
    } catch {
      // 缓存写失败不影响主流程
    }
  }
}

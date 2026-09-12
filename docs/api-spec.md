# 同花顺金融数据 API（hithink-finance）接口契约规格

> 用途：供工程实现直接照抄的 REST / MCP / CLI / SDK 契约。
> 原则：**只写文档原文里实际出现过的路径、参数名与字段名**；任何未能核实的内容显式标注 `⚠️未验证`。

---

## 0. 来源与抓取时间

**抓取时间**：2026-09-12 16:19 (+08:00)
**官网**：https://fuyao.aicubes.cn · **API Key 管理**：https://fuyao.aicubes.cn/admin

### 0.1 抓取结果

| # | URL | 结果 | 备注 |
|---|---|---|---|
| 1 | https://fuyao.aicubes.cn/llms-full.txt | ✅ 成功（**被截断**） | 全站聚合，HTTP 200；返回内容在约 109 KB 处被工具截断，止于 `fund-managers` 章节开头。已捕获章节见 0.2 |
| 2 | https://fuyao.aicubes.cn/docs/mcp/overview/ | ✅ 成功 | 6 个 MCP 端点 + **78 个工具与对应 REST 路径全表** |
| 3 | https://fuyao.aicubes.cn/docs/developer-tools/overview/ | ✅ 成功 | CLI / Python SDK / Agent Skill 选型 |
| 4 | https://fuyao.aicubes.cn/docs/developer-tools/cli/ | ✅ 成功 | npm 包名、命令、Skills 清单 |
| 5 | https://fuyao.aicubes.cn/docs/developer-tools/python-sdk/ | ✅ 成功 | 源码安装方式、`marketdb` |
| 6 | https://fuyao.aicubes.cn/docs/developer-tools/agent-skill/ | ✅ 成功 | Skill 安装与凭据顺序 |
| 7 | https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/ | ✅ 成功 | 涨跌停/炸板/连板天梯全参数 |
| 8 | https://fuyao.aicubes.cn/docs/api-reference/hot-list-data/ | ✅ 成功 | 热榜四接口全参数 |
| 9 | https://fuyao.aicubes.cn/docs/api-reference/valuations/ | ✅ 成功 | 估值快照全参数 |
| 10 | https://fuyao.aicubes.cn/docs/api-reference/market-dumps/ | ✅ 成功（正文尾部截断） | dump 表 + Parquet schema 完整 |
| 11 | https://raw.githubusercontent.com/HiThink-Tech/Financial-API/main/README.md | ✅ 成功 | 官方仓库 README（MCP 六端点、CLI、Python、marketdb） |
| 12 | https://raw.githubusercontent.com/HiThink-Tech/Financial-API/main/docs/mcp.md | ✅ 成功 | MCP 端点职责与工具数、认证恢复 |
| 13 | `GET /api/a-share/prices/snapshot?thscodes=600519.SH`（无 Key 实测探针） | ✅ 成功 | 返回 `{"code":2003,"message":"Missing X-api-key",...}` |
| 14 | `GET /api/dump/market-dumps/daily-k/download-url`（无 Key 实测探针） | ✅ 成功 | 同上 2003 |
| 15 | `GET /api/does-not-exist/foo/bar`（**虚构路径**对照探针） | ✅ 成功 | **同样返回 2003** —— 见下方重要说明 |
| 16 | `GET /mcp/a-share`（裸 GET 探针） | ✅ HTTP 405 | JSON-RPC 错误 `-32601 Route and protocol analysis failed: SSE protocol is Unsupported` |

**❌ 抓取失败**

| URL | 失败原因 |
|---|---|
| https://raw.githubusercontent.com/HiThink-Tech/Financial-API/master/README.md | 网络抓取失败（默认分支为 `main`，`master` 不存在） |
| https://raw.githubusercontent.com/HiThink-Tech/Financial-API/main/skills/hithink-finance/references/api.md | 网络抓取失败（重试 1 次仍失败） |

### 0.2 llms-full.txt 中被截断而缺失的章节

已捕获（内容完整）：`ai-quickstart`、`docs/`、`introduction`、`quickstart`、`api-reference/overview`、`prices`、`market-dumps`、`ticker-search`、`corporate-actions`、`ticker-list`、`financials`、`calendar`、`a-share-index`、`funds`、`special-data`、`anomaly-analysis`、`auction`、`capital-flow`、`dragon-tiger-data`、`financial-indicators`，以及 `fund-backtest` 起的基金子章节（截断于 `fund-managers`）。

未包含在聚合文件内、已用**单页 web_fetch 补齐**：`limit-up-data`、`hot-list-data`、`valuations`、`mcp/overview`、`developer-tools/*`。
未抓取（本文不展开契约细节）：`high-frequency`、`stock-basics`、`futures-*`、`options-*`、`fund-quota`、`fund-portfolio`、`fund-performance` 等。

> ### ⚠️ 重要方法学说明（关于"实测探针"）
> 对本服务任意 `/api/**` 路径发无 Key 请求，**无论路径是否存在**，都返回
> `{"code":2003,"message":"Missing X-api-key","request_id":"...","data":null}`。
> 我用一个**虚构路径** `/api/does-not-exist/foo/bar` 做了对照，结果完全相同。
> 结论：**无 Key 探针无法证明任何路径存在**。本文所有路径的可信来源只有官方文档正文（llms-full.txt / 单页 / GitHub 仓库文档），探针仅用于确认"无 Key 时的实际错误码"，不用于路径存在性验证。

---

## 1. 鉴权与通用约定

来源：https://fuyao.aicubes.cn/docs/api-reference/overview/ 、https://fuyao.aicubes.cn/docs/quickstart/ 、https://fuyao.aicubes.cn/docs/mcp/overview/ 、https://fuyao.aicubes.cn/docs/introduction/

### 1.1 Base URL 与请求头

| 项 | 值 |
|---|---|
| Base URL | `https://fuyao.aicubes.cn` |
| 鉴权请求头 | `X-api-key: <your-api-key>` |
| 路径形态 | `/api/<标的宇宙>/<数据类型>/<动作>`，例：`GET /api/a-share/prices/snapshot` |
| Key 获取 | 用同花顺账号登录 https://fuyao.aicubes.cn/ → https://fuyao.aicubes.cn/admin → 创建 API Key（填别名） |
| Key 可见性 | 创建弹窗中完整 Key 只此一次可见（quickstart 另有一处表述为"关闭弹窗后只能在列表里再次查看"，两处说法不一致，以实际页面为准） |
| 复用关系 | REST / MCP / CLI / Python 远端取数**共用同一个 API Key**，无需重复签发 |

### 1.2 响应信封（ApiResponse）

所有业务结果（含业务错误）**HTTP 状态码通常为 200**，用信封里的 `code` 分发；触发限流时也可能返回 HTTP 429。

```json
{
  "code": 0,
  "message": "success",
  "request_id": "a1b2c3d4e5f6789012345678abcdef01",
  "data": {
    "timestamp": 1716105600000,
    "item": []
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | integer | 业务结果码，`0` 成功，非 0 为业务错误 |
| `message` | string | 结果描述 |
| `request_id` | string | 请求追踪 ID |
| `data` | object \| null | 业务数据容器；错误时固定保留，可能为 `null` |
| `data.timestamp` | long | 数据时间戳（毫秒）。注意：部分接口的 `timestamp` 是"数据就绪时间"，部分是"接口响应组装时间"，逐接口不同，见 §2 |
| `data.item` | array | 业务数据列表（**单条记录也以数组返回**） |

**客户端必须同时检查 HTTP 状态码与 `code`**；HTTP 429 一律按限流处理，即使响应体不是标准信封。

### 1.3 错误码表（文档 overview 原文全量）

| code | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | — |
| `1001` | 缺少必填参数 | `start` / `end` / `q` / `thscode` 漏传 |
| `1002` | 参数格式错误 | `thscode` 含逗号，或日期格式错误 |
| `1003` | 参数取值越界 | 枚举非法、`limit <= 0`，或历史查询窗口超过接口上限 |
| `1004` | 参数冲突 | `financials` 同时传 `start`/`end` 与 `limit`；仅传 `start` 或仅传 `end`（半开区间） |
| `2001` | 未认证 | `X-api-key` 缺失或无效 |
| `2003` | 权限不足 | API Key 无权调用该 capability |
| `2004` | **文档错误码表未收录**（实测发现） | 实测：`capital-flow/*` 返回「该数据为同花顺AI客户端专用」 |
| `3001` | 标的不存在 | 找不到目标标的 |
| `3002` | 数据未就绪 | 标的存在，但暂无可用业务数据 |
| `3004` | 标的类型不支持该能力 | 该标的类型不支持所请求的能力 |
| `4001` | 频率超限 | 超过约定 QPS |
| `5001` | 服务内部错误 | 服务端未知错误 |
| `5002` | 上游服务超时 | 数据源响应超时 |
| `5003` | 数据源不可用 | 上游服务暂时不可用、返回失败状态，或响应无法按契约解析和映射 |

**实测不一致（重要）**：无 Key 调用时实测返回
`{"code":2003,"message":"Missing X-api-key", ...}`，而不是错误码表里写的 `2001`。
→ 实现上应把「2001 或 2003 + message 含 `Missing X-api-key`」都当作"未传/无效 Key"处理。
官方仓库 `docs/mcp.md` 也确认：`code=2003`、`Invalid or revoked API key`、HTTP 401/403 通常表示 Key 缺失/无效/已撤销。

**文档缺失错误码 `2004`（实测发现，2026-09-12）**：调用 `/api/a-share/capital-flow/snapshot` 返回
`{"code":2004,"message":"该数据为同花顺AI客户端专用，前往[同花顺AI客户端](https://lumi.10jqka.com.cn/?channel=Hithink-API)即刻体验"}`，
HTTP 状态码为 **200**（不是 4xx）。`2004` 不在上文错误码表内，说明该表不完整。
→ **重要推论**：本服务把业务错误全部放在信封 `code` 里，HTTP 状态恒为 200。
因此实现**必须**解析 `body.code`，只判断 `res.ok` 会把所有业务错误当成功。

**子模块补充错误码**（各页原文给出，与总表并存）：

| 来源页 | 补充/细化 |
|---|---|
| `financials` | `1004`：同时传 `start`/`end` 与 `limit`，或半开区间 |
| `financial-indicators` | `5002`/`5003` 特指 Arsenal 财务指标数据源 |
| `valuations` | `1002` 每项必须为六位数字 + `.SH`/`.SZ`/`.BJ`；`1003` 原始 token 超服务端上限（默认 100）；`3001` 不在 A 股代码表；`5002`/`5003` 特指 DataAPI |
| `dragon-tiger-data` | `1002` `board_type`/`date` 非法或显式传入非交易日；`1003` `date` 不在一年内或晚于今天 |
| `hot-list-data` | `1002` 日期格式错；`1003` 日期不在一年内或窗口超一年；`1004` `start_date > end_date` |
| `limit-up-data` | `1002` `sort_field`/`sort_dir` 非白名单；`1003` `page < 1` 或 `size` 不在 `1..200` |
| `anomaly-analysis` | `1002` 空 token/格式错；`1003` 去重前 token 数 > 50；`3002` 当日数据未就绪 |
| `funds` 总览 | `1002` 历史行情 `thscode` 含逗号；`1003` `start > end` 或窗口超 5 年 |

### 1.4 分页约定（按接口分三类，**不统一**）

| 分页风格 | 参数 | 适用接口（原文确认） |
|---|---|---|
| `limit` + `offset` | 见各接口 | `GET /api/meta/tickers/list`（`limit` 默认 `1000`，最大 `10000`；`offset` 默认 `0`）；`GET /api/a-share/prices/snapshot`（`limit` 默认 `100`，`offset` 默认 `0`，**仅在省略 `thscodes` 时生效**） |
| `page` + `size` | `page` 从 1 起，`size` 范围 `1..200` | `limit-up-pool` / `limit-down-pool` / `limit-break-pool`（默认 `page=1`、`size=50`）；响应含 `data.pagination{total,pages,size,page}` |
| 无分页 / 固定窗口 | — | `calendar/trading-days`（固定近一年）、`limit-up-ladder`（固定 30 交易日）、`catalog/ths-index-list`（单 tag 全量）、`dragon-tiger-list`（固定全量不分页）、热榜类（Top30） |

**取尽方式**：`/api/meta/tickers/list` 循环递增 `offset` 直到 `item.length < limit`。
**"显式传 thscodes 则忽略分页"** 是与分页相关的高频坑：`/api/a-share/prices/snapshot` 传入 `thscodes` 时按入参顺序批量返回且**不分页**。

### 1.5 限流

原文（三处一致）：

- 当前**不限制累计调用次数**。
- 请按业务合理控制请求频率，避免短时间集中或高并发调用。
- 服务可能依据实时负载**动态调整**限流策略。
- HTTP **429** 响应或 `code=4001` 均表示触发限流；此时降低并发与频率，**不要立即连续重试**，稍后重新发起。

> ⚠️**文档未公布数值，但响应头里有**（2026-09-12 实测，见此节末）。
> 文档正文只说"动态调整、不公布阈值"，不要从文档臆造数字；要数字就自己看响应头。

#### 实测：响应头带短窗口限流计数（2026-09-12 补测）

`GET /api/a-share/prices/snapshot?thscodes=600519.SH` 的响应头里出现：

```
x-ratelimit-limit: 20
x-ratelimit-remaining: 20
```

连续 **24 次不间隔**请求（本机 Node，串行，总计数秒）全部 `HTTP 200 / code=0`，
`x-ratelimit-remaining` **始终是 20，一次都没往下掉**，也没有出现 `429` 或 `code=4001`。

结论与边界：

- 有一个**短窗口**限流（`limit=20`），但**窗口长度未知**——不能据此说"20 QPS"。
  按本机串行 RTT 估算（约 150ms/次 ≈ 6~7 次/秒）根本没碰到 20 的上限，
  所以"20"更可能是**每秒**或某个小时窗的额度，**未验证，不要写死**。
- 本客户端 `minIntervalMs=250`（≤4 req/s）在这个额度下是安全的。
- 响应头里**没有**任何配额/套餐/计费/剩余额度字段（只有这一对 ratelimit 头），
  也没有累计调用量的计数。配合文档"不限制累计调用次数"，指向"**限频不限量**"。
- ⚠️**未验证**：限流窗口的真实长度、是按 Key 还是按 IP 计、并发请求（非串行）下的表现。
  要确认得做压测，本文件不写没测过的数字。

### 1.6 时间戳、时区、币种

| 项 | 约定 |
|---|---|
| 时间戳单位 | **毫秒级 Unix 时间戳**（`long`），全站统一 |
| 时区 | `Asia/Shanghai`；日线类 `date_ms` 为当日 00:00:00 的毫秒戳 |
| 请求侧日期参数 | 例外：`corporate-actions` 的 `from`/`to`、`dragon-tiger-list` 的 `date`、`auction/short-term-benchmark` 的 `date`、热榜的 `date`/`start_date`/`end_date`、`financial-indicators` 的 `report` 使用**字符串**（`YYYY-MM-DD` 或 `yyyy-1..4`），不是毫秒戳 |
| 币种 | A 股恒为 `CNY`，响应/Parquet 均带显式 `currency` 字段 |
| 百分数口径 | 多数业务字段（涨跌幅、占比、收益率）为**百分数原值**，即 `1.74` 表示 +1.74% |
| 例外 | `dragon-tiger-data` 的 `change` / `net_rate` 为**小数形式**；`financial-indicators` 的 `value` 为**原始数值字符串**（如 `"89.12000000"` 表示 89.12%） |
| 空值 | 未披露返回 `null`，**不补零**（各页反复强调） |

### 1.7 thscode 格式

| 项 | 约定 |
|---|---|
| 形态 | `{6位代码}.{市场后缀}`，如 `600519.SH`、`000001.SZ`、`430047.BJ` |
| 股票/指数/基金 | 必须传**完整 thscode**，不接受纯代码 `600519` |
| 指数后缀 | `.SH`（上证指数）、`.SZ`（深证指数）、`.TI`（同花顺板块/行业指数，如 `886042.TI`、`881101.TI`） |
| 基金后缀 | `.OF`（场外）、`.SH`/`.SZ`（场内 ETF/LOF），如 `025480.OF`、`510300.SH`、`161725.SZ` |
| 基金特例 | `exchange` 字段对场外基金为 `null`；文档明确 **`.OF` 不是交易所** |
| 标准化 | 部分接口入参做 `trim().toUpperCase()`（如 `a-share-index` 系列） |
| 批量参数 | 逗号分隔的字符串参数名统一为复数 `thscodes`；**单标的接口用单数 `thscode` 且不接受逗号** |
| 批量上限 | 逐接口不同：`valuations/snapshot` 默认最多 100 个原始 token；`auction/snapshot` 单次最多 100 个（按去重前原始 token 校验）；`anomaly-analysis-stock` 去重前最多 50 个；`dragon-tiger-list` 无（单日全量） |
| 基金经理/公司 | 分别用 `manager_id`、`company_id`（非 thscode） |

### 1.8 其他实现要点

- `interval` 参数在 A 股/指数的历史 K 线接口中**当前仅支持 `1d`**（日线）。分钟 K、tick 明确不在公开能力内。
- 单标的接口的窗口上限：A 股历史 K 线 `[start, end]` 跨度 ≤ 10 年，超出 `code=1003`；财务报表区间模式同样 ≤ 10 年。
- 复权：`adjust` = `none` / `forward`（前复权）/ `backward`（后复权），默认 `forward`。指数接口**没有** `adjust` 参数。
- 文档设计原则：snake_case 字段、显式 `currency`、毫秒时间戳、原始数据为主（复权因子返回原始事件流，客户端自行推导）。

---

## 2. 接口清单（A 股 + 元信息 + 全市场导出）

所有接口均为 `GET`，Base URL `https://fuyao.aicubes.cn`，请求头 `X-api-key`。

### 2.1 一表速查（照抄用）

| # | 方法 + 完整路径 | 关键查询参数（`*` = 必填；`[默认]`） | 关键返回字段 |
|---|---|---|---|
| 1 | `GET /api/a-share/prices/snapshot` | `thscodes`（逗号分隔；给了就忽略分页）· `limit` `[100]` · `offset` `[0]` | `data.timestamp` `data.total` `item[].thscode/ticker/last_price/price_change/price_change_ratio_pct/open_price/high_price/low_price/prev_price/volume/turnover` |
| 2 | `GET /api/a-share/prices/historical` | `thscode`\*（单个，禁逗号）· `interval`\*`[1d]` · `start`\*（ms）· `end`\*（ms）· `adjust` `[forward]` | `data.timestamp` `item[].date_ms/open_price/high_price/low_price/close_price/volume/turnover` |
| 3 | `GET /api/meta/tickers/search` | `q`\* · `exchange` · `asset_type`（可多值逗号） · `limit` `[10]`（max 50） | `data.timestamp` `item[].thscode/ticker/name/exchange/asset_type/currency/list_date/end_date/last_trade_date/last_delivery_date` |
| 4 | `GET /api/meta/tickers/list` | `asset_type`（可多值逗号；省=全部） · `limit` `[1000]`（max 10000） · `offset` `[0]` | 同 #3 的 `item[]` 结构 |
| 5 | `GET /api/a-share/corporate-actions/adjustment-factors` | `thscode`\*（单个，禁逗号） · `from`（`YYYY-MM-DD`） · `to`（`YYYY-MM-DD`） | `data.thscode/ticker` `item[].ticker/ex_date_ms/dividend_per_share/per_share_bonus` |
| 6 | `GET /api/a-share/financials/income-statements` | `thscode`\* · `period`\*`[annual]`(`annual`/`quarterly`) · `limit` `[4]`(`1..20`) · `start` · `end`（`limit` 与 `start/end` 互斥） | 共有：`thscode/ticker/period/fiscal_year/fiscal_period/report_date_ms/period_end_ms/currency`；专有：`operating_income/operating_costs/operating_expenses/sales_fee/manage_fee/research_and_development_expenses/operating_profit/interest_expenses/profit_total/income_tax_expense/net_profit/parent_holder_net_profit/basic_eps` |
| 7 | `GET /api/a-share/financials/balance-sheets` | 同 #6（契约完全一致） | 共有字段 + `assets_total/total_current_assets/non_current_nets_total/cash/accounts_receivable/total_debt/holder_equity_total` |
| 8 | `GET /api/a-share/financials/cash-flow-statements` | 同 #6（契约完全一致） | 共有字段 + `act_cash_flow_net/invest_cash_flow_net/financing_cash_flow_net/pay_fixed_assets_etc_cash/pay_dividends_profits_interest_cash/cash_equivalents_net_addition` |
| 9 | `GET /api/a-share/financials/indicators` | `thscode`\* · `report`\*（`yyyy-1`/`-2`/`-3`/`-4`） | `data.thscode/report` `abilities[].ability/indicators[].index_id/.value`（固定顺序 `growth`,`profitability`,`solvency`,`operation`,`cash-flow`） |
| 10 | `GET /api/a-share/calendar/trading-days` | 无入参（固定窗口近一年） | `data.timestamp` `item[].date_ms/date`（`yyyyMMdd`） |
| 11 | `GET /api/a-share-index/catalog/ths-index-list` | `tag` `[cn_concept]`（`cn_concept`/`region`/`tszs`/`industry`，大小写不敏感） | `data.timestamp` `item[].thscode/name`（无 `ticker`） |
| 12 | `GET /api/a-share-index/constituents/ths-stock-list` | `thscode`\*（单个，禁逗号） | `data.timestamp` `item[].thscode/ticker/name` |
| 13 | `GET /api/a-share-index/prices/snapshot` | `thscodes`\*（**必填**，不支持空入参枚举全指数） · `limit`/`offset`（签名对齐，**对本接口无效**） | 同 #1 的 `item[]` 结构 + `data.total` |
| 14 | `GET /api/a-share-index/prices/historical` | `thscode`\* · `interval`\*`[1d]` · `start`\* · `end`\*（≤10 年；**无 `adjust`、无 `offset`**） | `data.timestamp` `data.adjust`（固定 `null`） `item[].date_ms/open_price/high_price/low_price/close_price/volume/turnover` |
| 15 | `GET /api/a-share/valuations/snapshot` | `thscodes`\*（逗号分隔，≤100 个原始 token） | `data.timestamp/total` `item[].thscode/ticker/name/pe_ttm/pe_mrq/pb_mrq/ps_ttm/pcf_ttm` |
| 16 | `GET /api/a-share/auction/snapshot` | `thscodes`\*（≤100 个原始 token） · `stage` `[final]`（`live`/`final`） | `data.timestamp/auction_phase/data_status/total` `item[].thscode/ticker/name/auction_price/auction_pct/auction_volume/auction_amount/auction_unmatched/auction_turnover_pct/auction_yesterday_ratio_pct/auction_volume_ratio/pre_close_price/open_price/last_price/float_market_cap` |
| 17 | `GET /api/a-share/auction/short-term-benchmark` | `date`（`yyyy-MM-dd`，`[上海时区当日]`） | `data.timestamp/date/date_ms` `item[].thscode/ticker/name/auction_pct/tags[]` |
| 18 | `GET /api/a-share/special-data/limit-up-pool` | `date_ms`（ms，`[服务端当前自然日]`） · `page` `[1]` · `size` `[50]`(1..200) · `sort_field` `[last_price]`(`last_price`/`continue_day_cnt`/`seal_money`/`limit_up_time`) · `sort_dir` `[desc]` | `data.timestamp/pagination{total,pages,size,page}` `item[].thscode/ticker/name/is_st/is_new/last_price/price_change_ratio_pct/limit_up_time/limit_up_reason/continue_day_text/continue_day_cnt/seal_money/max_seal_money` |
| 19 | `GET /api/a-share/special-data/limit-down-pool` | `date_ms` `[当前自然日]` · `page` `[1]` · `size` `[50]` · `sort_field` `[last_limit_time]`(`last_limit_time`/`first_limit_time`/`last_price`/`price_change_ratio_pct`/`turnover_ratio_pct`) · `sort_dir` `[desc]` | `data.timestamp/pagination` `item[].thscode/ticker/name/last_price/price_change_ratio_pct/first_limit_time/last_limit_time/turnover_ratio_pct` |
| 20 | `GET /api/a-share/special-data/limit-break-pool` | `date_ms` `[当前自然日]` · `page` `[1]` · `size` `[50]` · `sort_field` `[price_change_ratio_pct]`(`price_change_ratio_pct`/`open_times`/`last_price`/`turnover_ratio_pct`/`turnover`) · `sort_dir` `[desc]` | `data.timestamp/pagination` `item[].thscode/ticker/name/last_price/price_change_ratio_pct/open_times/turnover_ratio_pct/turnover` |
| 21 | `GET /api/a-share/special-data/limit-up-ladder` | 无入参（固定近 30 交易日） | `data.timestamp/window{length,date_list[],board_caps{two_board..seven_over}}` `item[].date/boards{two_board,three_board,four_board,five_board,six_board,seven_over}[].thscode/ticker/name/board_num/seal_nextday/sign_level` |
| 22 | `GET /api/a-share/special-data/skyrocket-list` | `period` `[day]`（`day`/`hour`） | `data.timestamp` `item[].thscode/ticker/name/rank(≤30)/heat(string)/rank_change/rank_trend(up|down|flat|unknown)` |
| 23 | `GET /api/a-share/special-data/hot-stock-list` | `period` `[day]`（`day`=24h 级别 / `hour`） | 同 #22 结构 |
| 24 | `GET /api/a-share/special-data/hot-stock-list-history` | `date`\*（`yyyy-MM-dd`，仅一年内） | `data.date/date_ms` `item[].thscode/ticker/name/rank`（≤30） |
| 25 | `GET /api/a-share/special-data/hot-stock-rank-trend` | `thscode`\* · `start_date`\* · `end_date`\*（均 `yyyy-MM-dd`；窗口 ≤1 年） | `data.timestamp` `item[].thscode/ticker/date/date_ms/rank` |
| 26 | `GET /api/a-share/special-data/dragon-tiger-list` | `board_type` `[all]`（`all`/`org`/`hot_money`） · `date`（`yyyy-MM-dd`，仅一年内，必须是交易日） | `data.timestamp/board_type/trade_date/count/stock_count/stock_items[]/hot_money_items[]`；`stock_items[].thscode/ticker/name/concept_list/change/net_value/net_rate/hot_rank/buy_value/sell_value/limit_reason/range_days/org_net_value/org_net_rate/org_buy_num/org_sell_num/amount/hot_money_net_value/hot_money_net_rate/hot_money_item_net_value/hot_money_item_net_rate`；`hot_money_items[].name/buying/rows[]` |
| 27 | `GET /api/a-share/special-data/anomaly-analysis-list` | `tag_codes`（逗号分隔，OR；`LIMIT_UP`/`LIMIT_DOWN`/`SHARP_RISE`/`SHARP_FALL`/`RAPID_RALLY`/`RAPID_DECLINE`，大小写不敏感，去重） | `data.timestamp` `item[].stock_name/analysis_content/keyword_list[]/thscode/tag_name` |
| 28 | `GET /api/a-share/special-data/anomaly-analysis-stock` | `thscodes`\*（≤50 个 token，支持 `SH`/`SZ`/`BJ`） | 同 #27 |
| 29 | `GET /api/dump/market-dumps/daily-k/download-url` | 文档未列参数（见 §5） | ⚠️未验证（响应体未在文档中给出） |
| 30 | `GET /api/dump/market-dumps/daily-k-10d/download-url` | 同上 | ⚠️未验证 |
| 31 | `GET /api/dump/market-dumps/adjustment-factors/download-url` | 同上 | ⚠️未验证 |
| 32 | `GET /api/a-share/capital-flow/snapshot` | `thscode`\*（单个）— **该能力暂未开放外部接入** | `data.timestamp/super_large/large/medium/small` → 各含 `inflow_amount/outflow_amount/net_amount` |
| 33 | `GET /api/a-share/capital-flow/historical` | `thscode`\* · `interval`\*（`1m`/`1d`） · `start`\* · `end`\*（`1m` ≤7 自然日；`1d` ≤1 年）— **未开放** | `data.timestamp/thscode/interval` `item[].date_ms/super_large/large/medium/small` → 各含 `inflow_amount/outflow_amount`（**历史不返回 `net_amount`**） |

> 注：#29–#31 的 `/api/dump/...` 路径来自 overview 的表述「API 客户端使用 `/api/dump/** + X-api-key`」，页面文档给出的下载端点是 Cookie 版 `/dump/market-dumps/<kind>/download-url`（见 §5）。

### 2.2 逐接口补充说明（原文明确、容易踩坑的点）

**#1 行情快照**
- 省略 `thscodes` 时遍历完整 A 股代码表（按 thscode 升序）并按 `limit`/`offset` 分页；`data.total` = 全市场代码表总数（用于估算页数）。
- `data.timestamp` 为「数据就绪时间」，取本次快照中最新的上游有效时间，无有效数据时为 `null`。
- **响应不返回标的中文名 `name`**；要中文名需配合 `#3`/`#4` 解析。

**#2 历史 K 线**
- 接口层强约束：**每次请求仅一个 thscode**；`end - start` 超过 10 年返回 `code=1003`；缺 `start` 返回 `code=1001`。
- ✅**已实测确认**（2026-09-12）：`data` 实际键为 `timestamp, item, thscode, interval, adjust` —— `adjust` **存在且回显请求值**（`adjust=forward` → `"forward"`），另外还回显 `thscode` 与 `interval`（文档字段表未列这三者）。
- `item[]` 实测键：`date_ms, volume, turnover, open_price, high_price, low_price, close_price`（与文档字段名一致，仅顺序不同）。

**#3/#4 标的检索 / 列表**
- `asset_type` 枚举（两接口一致）：`a-share`、`a-share-index`、`fund-otc`、`fund-etf`、`fund-lof`、`fund-reits`、`forex`、`futures`、`options`；非法值 `code=1003`；每条记录只返回一个叶子类型。
- `exchange` 支持证券交易所与 `CFFEX`、`SHFE`、`INE`、`DCE`、`CZCE`、`GFEX`、`SSE`、`SZSE`。
- `item[].exchange` 取值 `SH`/`SZ`/`BJ`；场外基金为 `null`。

**#5 除复权**
- 请求参数是 `from`/`to`（`YYYY-MM-DD` 字符串），响应事件日期是毫秒戳 `ex_date_ms`。
- `item` 按 `ex_date_ms` **降序**（最新在前）。
- **不返回** `event_type` / `record_date` / `adjust_factor`；事件类型由 `dividend_per_share` 与 `per_share_bonus` 隐式区分（纯现金分红时 `per_share_bonus=0`，非现金事件 `dividend_per_share=0`）。
- 返回的是原始事件流，**复权因子需自行推导**；只要复权后价格就直接用 `#2` 的 `adjust=forward|backward`。
- 注意：`allotment_ratio`（配股比例）、`allotment_price`（配股价格）**只出现在 market-dumps 的复权因子 Parquet 列**里，本 REST 接口的响应字段表**没有**它们。⚠️未验证：REST 是否也返回配股字段。

**#6/#7/#8 财务报表**
- 三接口入参契约**完全一致**，仅返回字段不同；取数模式**互斥二选一**：
  - 不传 `start`/`end` → 最近 `limit` 期，按 `period_end` 降序；
  - 同时传 `start`+`end` → `[start, end]` 闭区间全部报告期，按 `period_end` 降序；
  - 同时传区间与 `limit`，或半开区间 → `code=1004`。
- `data.timestamp` 取响应中最大的 `period_end_ms`。
- 金额单位为**原币元**；`basic_eps` 单位为**元/股**（量级远小，不可做单位换算）。

**#9 财务指标**
- `report` 格式 `yyyy-1`（一季报）/`-2`（中报）/`-3`（三季报）/`-4`（年报）。
- `value` 是**字符串或 null**，服务端保留数据源原始数值字符串，不承诺固定小数位；百分比类按百分数值表达。
- 五类能力块固定顺序：`growth`、`profitability`、`solvency`、`operation`、`cash-flow`。
- `index_id` 白名单（共 24 个，原文列出）：
  - growth：`total_assets_growth_ratio`、`net_profit_yoy_growth_ratio`、`operating_income_yoy_growth_ratio`、`operating_profit_yoy_growth_ratio`
  - profitability：`sale_gross_margin`、`sale_net_interest_ratio`、`total_assets_net_ratio`、`index_deduct_weighted_avg_roe`、`index_weighted_avg_roe`
  - solvency：`current_ratio`、`quick_ratio`、`assets_debt_ratio`、`cash_ratio`、`earned_interest_multiple`
  - operation：`long_term_debt_equity_ratio`、`total_assets_turnover_ratio`、`inventory_turnover_ratio`、`current_assets_turnover_ratio`、`receive_account_turnover_ratio`
  - cash-flow：`cash_operating_index`、`operating_cash_flow_net_divide_income`、`net_profit_cash_content`、`operating_cash_net_yoy_growth_ratio`、`cash_meet_invest_ratio`

**#10 交易日历**
- 固定窗口 `[今日 - 1 年, 今日]`（Asia/Shanghai 自然日），**无任何请求参数**；`item` 按时间升序。

**#11–#14 指数**
- 入参 `thscode` 会做 `trim().toUpperCase()`，**不接受逗号**，单次仅一个指数。
- 覆盖上证交易所指数、深证交易所指数、同花顺板块（`886042.TI`）、同花顺行业指数（`881101.TI`）。
- `#13` 与 A 股快照不同：**必须传 `thscodes`**，不支持空入参枚举全指数；`limit`/`offset` 仅为签名对齐保留、**无效**。
- `#14` 无复权语义，因此没有 `adjust`；也没有 `offset`；`data.adjust` 固定 `null`。
- `#11` 单 tag 一次性全量返回，无分页参数；指数维度**不暴露 `ticker`**。

**#15 估值**
- 固定返回 5 个指标，不支持历史估值、分页、指标选择或高低估结论：`pe_ttm`、`pe_mrq`、`pb_mrq`、`ps_ttm`、`pcf_ttm`。
- `data.timestamp` 是本次响应所用上游指标元数据中的**最大有效时间**（不代表所有指标同步更新），无有效时间时为 `null`。
- 上游空值返回 `null`，不补零；负值/高精度原样返回，服务端不做计算、聚合、取绝对值或四舍五入。
- 上游未返回的股票**不生成占位项**；无匹配返回 `code=0`、`total=0`、`item=[]`。
- 格式错/不存在 → `code=1002`/`3001`；超 token 上限 → `code=1003`。

**#16 集合竞价快照**
- 服务端按请求顺序**去重**返回；`stage`=`live`(实时) / `final`(终态)，默认 `final`。
- `data.timestamp` 为**接口响应组装时间**，实时、终态、停牌及 `not_ready` 场景均会返回；上游竞价行情时间仅用于判断新鲜度。

**#17 短线风向标竞价基准**
- `date` 缺失或空字符串时用 `Asia/Shanghai` 当日；**显式指定非交易日时不自动回退**（`dragon-tiger-list` 则明确返回 `1002`）。

**#18–#21 涨跌停/炸板/连板天梯**
- 涨停池：后端固定取全部连板与 `main,chinext,ssestar,north` 四类板块；返回字段聚焦涨停语义，**不含**资金流/行业/分时预览等通用字段。
- `date_ms` 是"查询交易日上海时区零点毫秒戳"，省略时回退到**服务端当前自然日**（注意：不是"最近交易日"）。
- 连板天梯固定近 30 交易日，每个板位最多 4 只；`boards` 固定含 6 个键，上游缺失补 `[]`；`seal_nextday` 在最近交易日固定为 `null`。

**#22–#25 热榜**
- 四接口均为 Top30 或日线点位；`heat` 是**保留上游原始字符串**；`rank_trend` ∈ `up`/`down`/`flat`/`unknown`。
- `hot-stock-list-history` 只接受 `date`，服务端统一按 `Asia/Shanghai` 当日 00:00 转上游秒级时间戳（调用方不要直接传时间戳）。
- `hot-stock-rank-trend` 返回走势点位，**不做 Top30 截断**。

**#26 龙虎榜**
- 省略 `date` 时：今天是交易日 → 取**上一个**交易日；今天非交易日 → 取今天之前最近一个交易日。显式非交易日 → 参数错误，不自动回退。
- `stock_items` 在 `board_type=all/org` 时填充，`hot_money` 时为空数组；`hot_money_items` 反之。
- `count` 是上游记录数（同一股票可能同时出现当日榜和 3 日榜），`stock_count` 是股票去重数量；`range_days`=1 当日榜 / 3 三日榜。
- `change`、`net_rate`、`org_net_rate` 等为**小数形式**（不是百分数原值）。

**#27/#28 个股异动**
- `anomaly-analysis-list` **仅提供 REST，不同步为 MCP 工具**。
- 均为"当日"数据；有快照但无匹配 → `code=0` 且 `item=[]`；当日数据未就绪 → `code=3002`。

**#32/#33 主力资金**
- 文档明确标注：**该能力暂未开放外部接入**，将在后续版本接入同花顺 AI 客户端；页面上的 curl 示例「仅展示接口路径与参数格式，当前不可用于外部调用」。
- 资金金额单位为元；缺失返回 `null` 不转 `0`。
- 历史接口**不返回 `net_amount`**；合法时间窗内无数据 → `code=0` + `timestamp=null` + 空 `item`。

---

## 3. MCP 接入方式

来源：https://fuyao.aicubes.cn/docs/mcp/overview/ 、https://raw.githubusercontent.com/HiThink-Tech/Financial-API/main/docs/mcp.md 、https://fuyao.aicubes.cn/docs/developer-tools/overview/

### 3.1 结论：**远程托管 HTTP 端点，不需要本地起进程**

官方原文（`docs/mcp.md`）：*"同花顺金融数据服务提供 6 个托管 MCP 端点…**无需在本地运行 MCP Server**。"*

六个服务（MCP 端点 host 均为 `fuyao.aicubes.cn`）：

| 客户端服务名（推荐） | 地址 | 职责 | 工具数 |
|---|---|---|---|
| `hithink-finance-a-share`（官网示例写作 `fuyao-a-share`） | `https://fuyao.aicubes.cn/mcp/a-share` | A 股行情、公司行为、财务、估值、集合竞价、日历、特色数据 | 21 |
| `hithink-finance-a-share-index` | `https://fuyao.aicubes.cn/mcp/a-share-index` | 指数/板块目录、成分、行情 | 4 |
| `hithink-finance-meta` | `https://fuyao.aicubes.cn/mcp/meta` | 标的检索/消歧、代码表 | 2 |
| `hithink-finance-fund` | `https://fuyao.aicubes.cn/mcp/fund` | 基金资料/经理/披露/财务/回测/指标/QDII/净值/收益/资讯/场内行情 | 34 |
| `hithink-finance-futures` | `https://fuyao.aicubes.cn/mcp/futures` | 期货品种/合约/持仓/仓单/基差/日程/行情 | 13 |
| `hithink-finance-options` | `https://fuyao.aicubes.cn/mcp/options` | 期权品种/合约/行情 | 4 |

合计 **78 个工具**（官网 overview 与仓库 `docs/mcp.md` 一致）。
`fuyao-meta-mcp` 的标的检索是其余业务工具的**前置步骤**，建议与任一业务服务一起挂载。

### 3.2 客户端配置（可直接粘贴）

```json
{
  "mcpServers": {
    "hithink-finance-a-share": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/a-share",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    },
    "hithink-finance-a-share-index": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/a-share-index",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    },
    "hithink-finance-meta": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/meta",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    },
    "hithink-finance-fund": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/fund",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    },
    "hithink-finance-futures": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/futures",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    },
    "hithink-finance-options": {
      "type": "http",
      "url": "https://fuyao.aicubes.cn/mcp/options",
      "headers": { "X-api-key": "${HITHINK_FINANCE_API_KEY}" }
    }
  }
}
```

官网 overview 给的是**简化版**（4 个服务，服务名 `fuyao-a-share` / `fuyao-a-share-index` / `fuyao-fund` / `fuyao-meta`，Key 直接内联 `<your-api-key>`）。两版都能用；仓库版的服务名与变量插值更规范。

配置文件位置：

| 客户端 | 路径 |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）· `%APPDATA%\Claude\claude_desktop_config.json`（Windows） |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline (VS Code) | 命令面板 → `Cline: Open MCP Settings` |

改完需**重启/重连客户端**生效。

### 3.3 鉴权与环境变量名

| 形态 | 入口 | 鉴权 |
|---|---|---|
| 托管 MCP Server（**正常用法**） | 上游网关代理 | 网关校验 **`X-api-key` header**（写在客户端配置的 `headers` 里） |
| 自托管 / 本地调试 | 通过 MCP 客户端本地启动 | 环境变量 **`API_KEY`** 注入：`export API_KEY="<your-api-key>"` |

- 代码仓库与开发工具链统一推荐变量：**`HITHINK_FINANCE_API_KEY`**（REST/MCP/CLI/Python 共用）。
- Skill 复用凭据顺序：① 任务内安全输入的 Key → ② `HITHINK_FINANCE_API_KEY` → ③ 用户级 `hithink-finance/credentials.env` → ④ 兼容的旧凭据来源或已有 CLI 系统凭据。
- 认证失败（`code=2003` / `Invalid or revoked API key` / HTTP 401、403）：先查环境变量与凭据文件，再考虑重新签发。
- ⚠️未验证：「自托管 / 本地调试」**没有给出任何具体启动命令**（没有 npx 包名、没有 stdio 启动示例、没有仓库内 MCP server 入口）。因此**不要假设存在 `npx ...` 本地 MCP 命令**；除托管端点外，本地启动方式在文档中不可执行化。

### 3.4 工具命名规则

形如 `get_<universe>_<data-domain>_<action>`，与 REST 一一对应、数据语义完全一致（薄包装：工具层只调 REST router，错误体 `{code,message,request_id}` 原样透传）：

| 模式 | 示例 |
|---|---|
| A 股 | `get_a_share_prices_snapshot`、`get_a_share_prices_historical`、`get_a_share_financials_income_statements`、`get_a_share_calendar_trading_days`、`get_a_share_valuations_snapshot`、`get_a_share_corporate_actions_adjustment_factors`、`get_a_share_auction_snapshot`、`get_a_share_auction_short_term_benchmark` |
| 特色数据 | `get_a_share_special_data_limit_up_pool`、`..._limit_down_pool`、`..._limit_break_pool`、`..._limit_up_ladder`、`..._skyrocket_list`、`..._hot_stock_list`、`..._hot_stock_list_history`、`..._hot_stock_rank_trend`、`..._dragon_tiger_list`、`..._anomaly_analysis_stock` |
| 指数 | `get_a_share_index_catalog_ths_index_list`、`get_a_share_index_constituents_ths_stock_list`、`get_a_share_index_prices_snapshot`、`get_a_share_index_prices_historical` |
| 元信息 | `get_meta_tickers_search`、`get_meta_tickers_list` |
| 基金 / 期货 / 期权 | `get_fund_*`、`get_futures_*`、`get_options_*`（完整表见官网 MCP 工具一览） |

- **唯一已知的"有 REST 无 MCP"例外**：`GET /api/a-share/special-data/anomaly-analysis-list`（文档明确「不提供 MCP」）。
- 计划接入同花顺 AI 客户端的能力**不进入 MCP 工具列表**。
- 实测补充：对 `https://fuyao.aicubes.cn/mcp/a-share` 直接发裸 GET 返回 HTTP 405 + JSON-RPC `{"error":{"code":-32601,"message":"Route and protocol analysis failed: SSE protocol is Unsupported"}}` → 该端点是 **Streamable HTTP** 传输，不是老的 HTTP+SSE GET 探测方式。

---

## 4. CLI 与 Python SDK

来源：https://fuyao.aicubes.cn/docs/developer-tools/cli/ 、https://fuyao.aicubes.cn/docs/developer-tools/python-sdk/ 、https://fuyao.aicubes.cn/docs/developer-tools/agent-skill/ 、仓库 README

### 4.1 CLI（`hithink-finance`）

| 项 | 值 |
|---|---|
| 包名 | **`@hithink-tech/hithink-finance-cli`**（npm 全局包） |
| 运行时 | Node.js **≥ 22.12**、npm |
| 安装 | `npm install -g @hithink-tech/hithink-finance-cli`；国内镜像：`--registry=https://registry.npmmirror.com` |
| 验证 | `hithink-finance --version` · `hithink-finance version --format json` |
| 登录（交互） | `hithink-finance auth login`（隐藏输入，凭据存**系统凭据库**） |
| 登录（Agent/CI） | `printf '%s' "$HITHINK_FINANCE_API_KEY" \| hithink-finance auth login --api-key-stdin --format json`；更新用 `--api-key-stdin --replace`（无需先 logout） |
| 状态 | `hithink-finance auth status --format json` |
| 诊断/能力发现 | `hithink-finance doctor --format json` · `hithink-finance capabilities --format json` · `hithink-finance schema market.snapshot --format json` |
| Skills 修复 | `hithink-finance skills sync --repair --format json` · `hithink-finance skills status --format json` |

**最小可运行示例**

```bash
hithink-finance symbol search --q "贵州茅台" --limit 1 --format json   # → thscode 600519.SH
hithink-finance market snapshot --thscodes 600519.SH --format json
hithink-finance financials income --thscode 600519.SH --limit 4 --format json
hithink-finance index constituents --thscode 000300.SH --format json
```

**成功判定**：退出码 0 + JSON 顶层 `"ok": true` + 返回真实非空记录（`doctor`/`--help` 通过**不能**证明线上权限可用）。
**不要用** `--api-key <value>`（仅为旧脚本兼容，会暴露在 shell 历史与进程列表）。
**不要猜参数**：先 `capabilities`，再 `schema <command>` 或 `--help`。

**postinstall 会自动安装 10 个领域 Skills**（best-effort，失败日志出现 `Skills sync incomplete`）：`hithink-finance-shared`、`-symbol`、`-market`、`-financials`、`-valuation`、`-index`、`-special-data`、`-fund`、`-data`（本地 DuckDB）、`-research`。

其余命令（README 给出）：`hithink-finance data init|status`、`hithink-finance db query --sql "SELECT ... FROM v_daily_qfq LIMIT 10" --format json`。

### 4.2 Python SDK

| 项 | 值 |
|---|---|
| 包名 | **无独立 PyPI 包**。原文：「Python 子项目当前从 GitHub monorepo 源码安装，不是独立 PyPI 包」 |
| 运行时 | Python **≥ 3.11**、Git、pip |
| 安装 | `git clone https://github.com/HiThink-Tech/Financial-API.git` → `cd Financial-API` → `python -m venv .venv` → 激活 → **`python -m pip install -e ./python`**（必须在仓库根目录执行） |
| 凭据 | 环境变量 `HITHINK_FINANCE_API_KEY`（进程级），或用户级 `hithink-finance/credentials.env` |
| 包名/模块 | 远程 client 模块名为 `fuyao_client`（位于 `python/toolkit/fuyao/scripts/`）；业务错误异常类为 `FuyaoApiError`（暴露 `code`、`message`、`request_id`） |

**最小可运行示例（远程 JSON CLI）**

```bash
python python/toolkit/fuyao/scripts/fuyao.py --help
python python/toolkit/fuyao/scripts/fuyao.py tickers-search --q "贵州茅台"
python python/toolkit/fuyao/scripts/fuyao.py prices-snapshot --thscodes 600519.SH
```

退出码约定：`0` 成功、`2` 上游业务错误、`3` 本地参数错误、`4` 环境或运行错误。

**最小可运行示例（Python 代码）**

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path("python/toolkit/fuyao/scripts").resolve()))
from fuyao_client import prices_snapshot, tickers_search

hit = tickers_search("贵州茅台", limit=1)[0]
snapshot = prices_snapshot([hit["thscode"]])
print(snapshot)
```

### 4.3 本地依赖：`marketdb` 是否必需？

**不是必需的。** Python SDK 分两条路径：

1. **远程 toolkit**（`fuyao_client` / `fuyao.py`）：只依赖 HTTP + API Key，**无本地数据库依赖**。
2. **`marketdb`（可选）**：本地 **DuckDB** 历史库，需额外初始化。只需最新数据可跳过。

`marketdb` 安装与初始化（原文）：

```bash
python python/bootstrap.py            # 安装包 + 初始化 DB + 按配置同步数据（可能耗时较长）
marketdb status   --json --db data/market.duckdb
marketdb validate --json --db data/market.duckdb
marketdb query --json --db data/market.duckdb --sql "SELECT date, close FROM v_daily_qfq WHERE thscode='600519.SH' ORDER BY date DESC LIMIT 10"
```

```python
from marketdb import MarketDB
with MarketDB.open("data/market.duckdb") as db:
    daily = db.get_daily("600519.SH", start="2025-01-01", adjust="forward")
    print(daily.tail())
```

其他已知细节：
- CLI **运行时不依赖 Python**（Node.js CLI 子项目）。
- `bootstrap.py` 可能耗时较长，需等命令完整结束后再查询同一数据库。
- 两个入口的模块路径坑：`fuyao_client.py` 需要把 `python/toolkit/fuyao/scripts` 加入 `sys.path`，且命令从 monorepo 根目录执行。

### 4.4 Agent Skill

```bash
npx skills add HiThink-Tech/Financial-API --skill hithink-finance -g --yes
```

- 也支持经 Skill Hub 安装（`https://skillhub.cn/skills/hithink-finance`）；手工安装时必须复制**完整目录并保留 `references/`**，不能只复制 `SKILL.md`。
- 它是 REST / MCP / CLI / Python 之间的**统一路由入口**（用自然语言选入口），**不是另一份 API 契约**，也不绕过账号权限。
- 自动更新：会话首次使用时静默检查并自更新（设 `HITHINK_FINANCE_NO_SKILL_UPDATE=1` 关闭）。
- 安装后必须**新建 Agent 会话**再验证。

---

## 5. 全市场导出（market-dumps）

来源：https://fuyao.aicubes.cn/docs/api-reference/market-dumps/ 、https://fuyao.aicubes.cn/docs/api-reference/overview/

### 5.1 预签名链接怎么拿

- 下载接口返回**短时有效的 S3 预签名链接**（有效期**通常 5 分钟**）；**不能**把链接本身当长期数据地址，也不要持久化/缓存，每次下载前重新获取。
- 两种入口（overview 原文）：
  - **浏览器**：页面下载按钮走 `/dump/**` 登录态 **Cookie** 入口；
  - **API 客户端**：走 **`/api/dump/**` + `X-api-key`**。
- 页面文档实际列出的下载端点（Cookie 版）：

| dump | 下载端点 |
|---|---|
| 10 年全量日 K | `GET /dump/market-dumps/daily-k/download-url` |
| 最近 10 交易日日 K | `GET /dump/market-dumps/daily-k-10d/download-url` |
| 复权因子全量 | `GET /dump/market-dumps/adjustment-factors/download-url` |

- 对应 API Key 版（按 `/api/dump/**` 前缀推导）：`/api/dump/market-dumps/daily-k/download-url` 等。
  → 我实测该路径无 Key 时返回 `{"code":2003,"message":"Missing X-api-key"}`，但**虚构路径返回完全相同的结果**，所以这**不能**证明路径存在。
  → `⚠️未验证`：`/api/dump/...` 的完整可用路径与请求参数（页面文档只给出了 Cookie 版端点原文）。

### 5.2 覆盖范围

| dump 名 | `dump_id` | `data_type` | `mode` | 默认窗口 | 触发 profile overlay |
|---|---|---|---|---|---|
| 10 年全量日 K | `a_share_daily_k_1d_none_10y` | `daily_k` | `FULL` | `years=10` | base profile 默认 |
| 最近 10 交易日日 K | `a_share_daily_k_1d_none_10d` | `daily_k` | `RECENT_TRADING_DAYS` | `trading_days=10` | `dump-builder-daily-k-10d` |
| 复权因子全量 | `a_share_adjustment_factors_event_none_all` | `adjustment_factors` | `FULL` | 全量事件 | `dump-builder-adjustment-factors` |

- 覆盖范围：全 A 股。10 年日 K 为最近约 10 年**未复权**日线；`daily-k-10d` 为轻量增量窗口；复权因子为**全历史事件流**。
- 主键 / 时间字段：日 K `(thscode, date_ms)` / `date_ms`；复权因子 `(thscode, ex_date_ms)` / `ex_date_ms`。
- 文件中的日期时间为毫秒 Unix 时间戳，交易日按 `Asia/Shanghai` 解释；A 股价格按原始货币计价，币种 `CNY`。

### 5.3 文件格式：Parquet

**日 K 列**

| 列 | 类型 | 说明 |
|---|---|---|
| `thscode` | string | 带交易所后缀的完整代码 |
| `currency` | string | A 股为 `CNY` |
| `interval` | string | 固定 `1d` |
| `adjusted` | string | 固定 `none`（未复权） |
| `date_ms` | long | K 线日期（毫秒，Asia/Shanghai 零点） |
| `open_price` / `high_price` / `low_price` / `close_price` | number | OHLC，原始货币计价 |
| `volume` | number | 成交量（股） |
| `turnover` | number | 成交额（原始货币） |

**复权因子列**

| 列 | 类型 | 说明 |
|---|---|---|
| `thscode` | string | 带交易所后缀的完整代码 |
| `ticker` | string | 展示用代码 |
| `ex_date_ms` | long | 除权除息日（毫秒，Asia/Shanghai 零点） |
| `dividend_per_share` | number | 每股现金分红（税前） |
| `per_share_bonus` | number | 每股送股比例 |
| `allotment_ratio` | number | 配股比例 |
| `allotment_price` | number | 配股价格（原始货币） |
| `currency` | string | A 股为 `CNY` |

读取依赖：`pyarrow`（`python3 -m pip install pyarrow`）。文档给出的解读脚本支持：按 `thscode` 过滤（`--ticker`）、日期范围导出 CSV（`--from-date/--to-date/--export-csv`）、`(thscode,date_ms)` 唯一性检查（`--check-duplicates`）、schema 自动识别日 K / 复权因子（靠是否存在 `ex_date_ms`）。

文档脚本中出现的 **manifest 结构线索**（间接证据，非下载接口响应契约）：示例路径形如
`build/dump/a_share_daily_k_1d_none_10y/20260602/manifest.json`，脚本会读取 `manifest.file_name`、
`manifest.compact_file.path`，并支持对 manifest 做 **sha256 校验**。

> `⚠️未验证`：
> 1. `/dump/market-dumps/<kind>/download-url`（及 `/api/dump/...` 版本）的**响应 JSON 字段名**（预签名 URL 放在哪个键里）——文档未给出响应示例。
> 2. 该接口是否有请求参数（如日期、版本选择）——文档未列出参数表。
> 3. manifest.json 的完整字段集与 sha256 字段名——仅从解读脚本反推，无契约原文。

---

## 6. `⚠️未验证` 项清单（汇总）

| # | 未验证内容 | 原因 |
|---|---|---|
| 1 | market-dumps 下载接口的**响应体字段名**（预签名 URL 键名） | 文档无响应示例 |
| 2 | market-dumps 下载接口的**请求参数表** | 文档未列参数 |
| 3 | `/api/dump/**` 逐条完整路径（仅确认前缀约定，未逐条列出） | overview 只写 `/api/dump/** + X-api-key` |
| 4 | 本地/自托管 MCP Server 的**启动命令**（无 npx / stdio 示例） | 文档只提"通过 MCP 客户端本地启动 + 环境变量 `API_KEY`" |
| 5 | ~~A 股 `prices/historical` 响应中是否存在 `adjust` 回显字段~~ | ✅ **已解决**（2026-09-12 实测）：存在，且回显 `thscode`/`interval`/`adjust` 三者 |
| 6 | REST `corporate-actions/adjustment-factors` 是否返回配股字段（`allotment_ratio`/`allotment_price`） | 这些列只出现在 market-dumps 的 Parquet schema；REST 响应字段表未列，且文档明确"不返回 `event_type`/`record_date`/`adjust_factor`" |
| 7 | manifest.json 完整字段集与 sha256 字段名 | 仅从文档内解读脚本反推 |
| 8 | 具体限流阈值（QPS / 并发数） | ✅ **部分解决**（2026-09-12 实测）：响应头有 `x-ratelimit-limit: 20` / `x-ratelimit-remaining`；但**窗口长度仍未知**，24 次串行未见 remaining 下降、无 429。详见 §1.5 |
| 8b | 该服务是否收费 | ✅ **文档层面已查**（2026-09-12）：文档站（introduction/quickstart/overview/llms.txt）**没有任何收费、套餐、计费页面**，原文只承诺"不限制累计调用次数"；响应头也没有配额/账单字段 → 指向"限频不限量"。⚠️**注意区分**：同花顺另有付费产品 iFinD 量化接口（`ftwc.51ifind.com`，免费版按"单元格/月"计额度），与本服务不是一回事 |
| 9 | `high-frequency`（高频动向）、`stock-basics`、`futures-*`、`options-*`、`fund-quota`/`fund-portfolio`/`fund-performance` 的**参数与字段契约** | 只抓到路径索引（见附录），未逐页抓取 |
| 10 | 创建 API Key 弹窗的 Key 是否可再次完整查看 | quickstart 与 ai-quickstart 两处表述不一致 |
| 11 | `prices/snapshot` 批量 `thscodes` 的**单次上限** | 文档未给（valuations/auction 给了 100，anomaly 给了 50，快照没给） |

---

## 7. 附录：其他标的宇宙 REST 路径索引

来源：https://fuyao.aicubes.cn/docs/mcp/overview/ 的完整工具表（MCP 工具 ↔ REST 路径一一对应）。
**仅路径索引；参数与返回字段未抓取，使用前请按对应页面核对。**

### 7.1 基金（/api/fund，34 条）

| REST 路径 | 说明 |
|---|---|
| `GET /api/fund/profile/detail` | 基金基本资料 |
| `GET /api/fund/portfolio/holdings` | 基金重仓股 |
| `GET /api/fund/portfolio/industry-allocation` | 基金行业配置 |
| `GET /api/fund/portfolio/stock-history` | 基金历史股票持仓 |
| `GET /api/fund/portfolio/stock-report-dates` | 基金股票持仓报告日期 |
| `GET /api/fund/portfolio/bond-history` | 基金历史债券持仓 |
| `GET /api/fund/portfolio/bond-report-dates` | 基金债券持仓报告日期 |
| `GET /api/fund/portfolio/asset-allocation` | 基金资产配置 |
| `GET /api/fund/performance/nav` | 基金净值 |
| `GET /api/fund/performance/returns` | 基金区间收益 |
| `GET /api/fund/performance/indicators-historical` | 基金历史业绩指标 |
| `GET /api/fund/performance/drawdowns` | 基金回撤指标 |
| `GET /api/fund/market/snapshot` | 基金行情快照 |
| `GET /api/fund/market/historical` | ETF 历史日线行情 |
| `GET /api/fund/companies/detail` | 基金公司详情 |
| `GET /api/fund/holders/detail` | 基金持有人结构 |
| `GET /api/fund/holders/top` | 基金前十大持有人 |
| `GET /api/fund/corporate-actions/dividends` | 基金分红记录 |
| `GET /api/fund/diagnostics/detail` | 基金诊断详情 |
| `GET /api/fund/financials/indicators` | 基金财务指标 |
| `GET /api/fund/financials/income-statements` | 基金利润表 |
| `GET /api/fund/financials/balance-sheets` | 基金资产负债表 |
| `GET /api/fund/backtest/result` | 基金在线回测 |
| `GET /api/fund/backtest/indicators` | 基金回测指标 |
| `GET /api/fund/indicators/line` | 基金画线指标 |
| `GET /api/fund/indicators/table` | 基金表格指标 |
| `GET /api/fund/quota/summary` | QDII 额度汇总 |
| `GET /api/fund/quota/list` | QDII 额度列表 |
| `GET /api/fund/managers/investment-style` | 基金经理投资风格 |
| `GET /api/fund/managers/performance` | 基金经理业绩 |
| `GET /api/fund/managers/experience` | 基金经理从业经历 |
| `GET /api/fund/managers/detail` | 基金经理详情 |
| `GET /api/fund/news/article-list` | 基金资讯列表 |
| `GET /api/fund/offerings/list` | 基金募集列表 |

### 7.2 期货（/api/futures，13 条）

`GET /api/futures/varieties/list`、`/api/futures/contracts/detail`、`/api/futures/positions/variety-daily`、`/api/futures/positions/company-variety-daily`、`/api/futures/positions/contract-daily`、`/api/futures/positions/contract-historical`、`/api/futures/positions/company-list`、`/api/futures/warehouse-receipts/historical`、`/api/futures/basis/main-continuous-latest`、`/api/futures/basis/historical`、`/api/futures/calendar/trading-schedule`、`/api/futures/prices/intraday`、`/api/futures/prices/daily`

### 7.3 期权（/api/options，4 条）

`GET /api/options/varieties/list`、`/api/options/contracts/detail`、`/api/options/prices/intraday`、`/api/options/prices/daily`

### 7.4 overview 中的其他分组（未展开）

| 分组 | 路径前缀 | 状态 |
|---|---|---|
| 高频动向 | `/api/a-share/high-frequency` | 计划接入同花顺 AI 客户端，非公开入口 |
| 期货合约扩展资料 / F10 历史指标 / 会话时间轴 | `/api/futures/...` | 计划接入 AI 客户端 |
| 期权会话时间轴 | `/api/options/calendar/session-timeline` | 计划接入 AI 客户端 |
| 股票基础信息 | `/docs/api-reference/stock-basics/` | 敬请期待 |

### 7.5 明确不在公开能力内

分钟 K、tick、Level-2、海外/港美股行情、宏观数据、新闻与公告原文、研报原文、基金申赎交易、自建回测引擎。

---

## 8. 实测基线（2026-09-12，持有效 API Key）

来源：`node scripts/smoke.mjs` + `scripts/_probe-tmp.mjs` 的真实调用结果。
这是**唯一**来自实际响应的证据层；上文 §1–§7 除标注外均来自官方文档。

### 8.1 冒烟测试结果

| 探针 | 结果 | 关键观测 |
|---|---|---|
| `/api/a-share/calendar/trading-days` | ✅ | 区间 `20250912 → 20260911`，242 个交易日 |
| `/api/a-share/prices/snapshot` | ✅ | 批量 2 只按序返回；**确认无 `name` 字段** |
| `/api/a-share/prices/historical` | ✅ | 近 30 天 21 根日 K；`data.adjust="forward"` |
| `/api/meta/tickers/search` | ✅ | `q=贵州茅台` → `600519.SH` |
| `/api/a-share/valuations/snapshot` | ✅ | 返回 `pe_ttm`/`pe_mrq`/`pb_mrq` 等 |
| `/api/a-share/special-data/limit-up-ladder` | ✅ | 30 个交易日梯队，`window.length=30` |
| `/api/a-share/capital-flow/snapshot` | ❌ 预期内 | `code=2004`，仅同花顺 AI 客户端可用 |

合计 7 次请求，0 次重试，单次耗时 119–427 ms。

### 8.2 实测响应结构（照抄用）

**`/api/a-share/prices/snapshot`** — `data` 键：`timestamp, total, item`
`item[]` 键：`thscode, ticker, volume, turnover, last_price, price_change, price_change_ratio_pct, open_price, high_price, low_price, prev_price`（**无 `name`**）

样本（`600519.SH`）：`last_price=1275.16, price_change=-9.97, prev_price=1285.13`
→ 校验：`-9.97 / 1285.13 = -0.776%`，与 `price_change_ratio_pct=-0.775797` 一致，说明该字段确为**百分数原值**（文档 §1.6 口径正确）。

**`/api/a-share/prices/historical`** — `data` 键：`timestamp, item, thscode, interval, adjust`
`item[]` 键：`date_ms, volume, turnover, open_price, high_price, low_price, close_price`

### 8.3 由实测推出的实现约束

1. **HTTP 状态恒为 200**，业务错误全在信封 `code` 里 —— 判断 `res.ok` 会把 `2004` 当成功。必须解析 `body.code`。
2. 错误码表不完整（缺 `2004`），遇到未知 `code` 不应崩溃，应连同 `message` 原样上报。
3. `historical` 回显 `adjust`，可用于校验请求是否被正确应用。
4. 快照与历史 K 线对同一标的的 `close_price`/`last_price` 一致（均为 `1275.16`），两个端点数据自洽。


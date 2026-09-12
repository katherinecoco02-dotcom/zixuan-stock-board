/**
 * 价格预警端到端测试（需服务在跑：node server.mjs）
 *
 * 覆盖：新增 → 立即取价 → 触发 → 未确认事件 → 回执 → 手动检查 → 复位 → 停用/启用 → 删除，
 * 以及参数校验，和「非交易时段不误报」（自动轮询那一步真的等一个轮询周期）。
 *
 * 安全性：只用 600519.SH 作为测试标的，结束时删掉自己建的预警，
 * 并在最后断言"测试开始前已存在的预警一条都没被动过"。
 *
 * 用法：node scripts/alert-test.mjs      （可用 BASE=http://127.0.0.1:9000 换地址）
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const TEST_CODE = '600519.SH'; // 测试标的：贵州茅台（不碰用户真实的预警）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERT_LOG = path.join(__dirname, '..', 'data', 'alert.log');

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

async function api(method, apiPath, body) {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应留空，断言里会体现 */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = []; // 本脚本创建的预警 id
const seenEventIds = new Set();

async function cleanup() {
  for (const id of created) {
    await api('DELETE', `/api/alerts/${encodeURIComponent(id)}`).catch(() => {});
  }
  // 把本次测试产生、还没确认的触发事件标记掉，免得用户页面弹一堆测试提示
  const ids = [...seenEventIds];
  if (ids.length) await api('POST', '/api/alerts/ack', { ids }).catch(() => {});
}

async function main() {
  console.log(`=== 价格预警端到端测试 @ ${BASE} ===\n`);

  // 0) 服务是否在跑
  const health = await api('GET', '/api/health');
  if (!health.ok) {
    console.error(`✗ 服务没在跑（${BASE}）。先执行 node server.mjs 或点桌面开关。`);
    process.exit(1);
  }

  const before = await api('GET', '/api/alerts');
  if (!before.ok) {
    console.error(`✗ GET /api/alerts 失败 HTTP ${before.status}: ${before.text.slice(0, 200)}`);
    process.exit(1);
  }
  const baselineIds = new Set((before.json.items ?? []).map((a) => a.id));
  const monitor = before.json.monitor ?? {};
  console.log(
    `基线：已有预警 ${baselineIds.size} 条；交易时段=${monitor.session?.open ? '是' : '否'}` +
      `（${monitor.session?.label ?? '—'}，间隔 ${monitor.intervalMs}ms）\n`,
  );

  // 1) 结构
  check(
    'GET /api/alerts 返回 items/events/monitor',
    Array.isArray(before.json.items) && Array.isArray(before.json.events) && Boolean(before.json.monitor),
  );
  check(
    'monitor.session 带上海时间与中文状态',
    typeof monitor.session?.time === 'string' && typeof monitor.session?.label === 'string',
    `${monitor.session?.time} ${monitor.session?.label}`,
  );

  // 2) 新增一条"不可能触发"的预警：跌到 0.01
  const addA = await api('POST', '/api/alerts', {
    input: TEST_CODE,
    direction: 'below',
    target: 0.01,
    note: '测试-不可能触发',
  });
  check('POST /api/alerts 创建成功（HTTP 200）', addA.ok && addA.json.added?.length === 1);
  const alertA = addA.json.added?.[0];
  if (alertA) created.push(alertA.id);
  check('返回体带名称（来自本地代码表）', Boolean(alertA?.name), alertA?.name ?? '');
  const rowA = (addA.json.items ?? []).find((a) => a.id === alertA?.id);
  check('创建时立刻取了现价', typeof rowA?.last_price === 'number', `last_price=${rowA?.last_price}`);
  check('该预警未被触发（0.01 是个不可能达到的价位）', rowA?.triggeredAt === null && rowA?.met === false,
    `gapToTarget=${rowA?.gapToTarget?.toFixed?.(2)}`);

  // 3) 新增一条"当下就已满足"的预警：涨到 1.00 → 应立刻触发并给出警告
  const addB = await api('POST', '/api/alerts', {
    input: TEST_CODE,
    direction: 'above',
    target: 1,
    note: '测试-已满足',
  });
  const alertB = addB.json.added?.[0];
  if (alertB) created.push(alertB.id);
  check('创建"已满足"的预警会立刻触发一次', addB.json.triggers?.length === 1 || (addB.json.events ?? []).length >= 1);
  check(
    '并明确警告"价位可能写反"（不静默触发）',
    (addB.json.warnings ?? []).some((w) => w.includes('已满足')),
    (addB.json.warnings ?? []).join(' | ').slice(0, 80),
  );
  const evB = (addB.json.events ?? []).find((e) => e.thscode === TEST_CODE);
  if (evB) seenEventIds.add(evB.id);
  check('触发事件带现价与方向', Boolean(evB) && Number.isFinite(evB.price) && evB.direction === 'above',
    evB ? `price=${evB.price} target=${evB.target}` : '无事件');

  // 4) 回执后事件不再重复下发（刷新页面不会重复弹窗）
  if (evB) {
    const ack = await api('POST', '/api/alerts/ack', { ids: [evB.id] });
    check('POST /api/alerts/ack 确认成功', ack.ok && ack.json.acked === 1, `acked=${ack.json.acked}`);
    const after = await api('GET', '/api/alerts');
    check('确认后该事件不再返回', !(after.json.events ?? []).some((e) => e.id === evB.id));
  }

  // 5) 手动"立即检查一次"：非交易时段也会判定，并如实报出价差
  const chk = await api('POST', '/api/alerts/check');
  check('POST /api/alerts/check 返回 200', chk.ok);
  const chkA = (chk.json.items ?? []).find((a) => a.id === alertA?.id);
  check('手动检查给出每条预警的现价与是否满足', Boolean(chkA) && chkA.met === false,
    chkA ? `现价 ${chkA.last_price} / 目标 ≤${chkA.target}` : '无该条');
  check('非交易时段手动检查不会误触发"不可能"的预警', chkA?.triggeredAt === null);

  // 6) 复位 + 自动轮询：复位后的 B 是"当下已满足但未触发"，
  //    交易时段内一个轮询周期后应被自动触发；非交易时段必须不触发（这是本轮最关键的断言）
  const reset = await api('POST', `/api/alerts/${encodeURIComponent(alertB.id)}`, { action: 'reset' });
  const rowB2 = (reset.json.items ?? []).find((a) => a.id === alertB.id);
  check('复位后 triggeredAt 清空、重新启用', rowB2?.triggeredAt === null && rowB2?.enabled === true);

  const waitMs = (monitor.intervalMs ?? 10000) + 3000;
  console.log(`… 等 ${Math.round(waitMs / 1000)} 秒，观察自动轮询（每 ${(monitor.intervalMs ?? 10000) / 1000} 秒一次）`);
  await sleep(waitMs);
  const afterWait = await api('GET', '/api/alerts');
  const rowB3 = (afterWait.json.items ?? []).find((a) => a.id === alertB.id);
  const newEvents = (afterWait.json.events ?? []).filter((e) => e.thscode === TEST_CODE);
  for (const e of newEvents) seenEventIds.add(e.id);

  if (monitor.session?.open) {
    check('交易时段：自动轮询按 10 秒周期自行触发（无需刷新页面）', Boolean(rowB3?.triggeredAt),
      rowB3?.triggeredAt ? `触发于 ${rowB3.triggeredAt} @ ${rowB3.triggeredPrice}` : '未触发');
  } else {
    check('非交易时段：自动轮询不判定，已满足的预警也不会误报', rowB3?.triggeredAt === null,
      `时段=${afterWait.json.monitor?.session?.label}`);
    check('但价格仍在刷新（界面能看到现价）', typeof rowB3?.last_price === 'number', `last_price=${rowB3?.last_price}`);
  }
  if (newEvents.length) await api('POST', '/api/alerts/ack', { ids: newEvents.map((e) => e.id) });

  // 7) 停用 / 启用
  const off = await api('POST', `/api/alerts/${encodeURIComponent(alertA.id)}`, { action: 'disable' });
  check('停用生效', (off.json.items ?? []).find((a) => a.id === alertA.id)?.enabled === false);
  const on = await api('POST', `/api/alerts/${encodeURIComponent(alertA.id)}`, { action: 'enable' });
  check('启用生效', (on.json.items ?? []).find((a) => a.id === alertA.id)?.enabled === true);

  // 8) 参数校验：错的一律报错，不静默成功
  const badDir = await api('POST', '/api/alerts', { input: TEST_CODE, direction: 'up', target: 1 });
  check('非法 direction 返回 400', badDir.status === 400, badDir.json?.error ?? '');
  const badTarget = await api('POST', '/api/alerts', { input: TEST_CODE, direction: 'above', target: -1 });
  check('非法 target 返回 400', badTarget.status === 400, badTarget.json?.error ?? '');
  const badInput = await api('POST', '/api/alerts', { input: '   ', direction: 'above', target: 1 });
  check('空标的返回 400', badInput.status === 400, badInput.json?.error ?? '');
  const badAction = await api('POST', `/api/alerts/${encodeURIComponent(alertA.id)}`, { action: 'explode' });
  check('未知 action 返回 400', badAction.status === 400, badAction.json?.error ?? '');
  const missing = await api('POST', '/api/alerts/no-such-id', { action: 'reset' });
  check('不存在的预警 id 返回 404', missing.status === 404, missing.json?.error ?? '');

  // 9) 触发留痕：data/alert.log 里应有本次测试标的的记录
  let logText = '';
  try {
    logText = await readFile(ALERT_LOG, 'utf8');
  } catch {
    /* 没有日志文件说明这次没触发过 */
  }
  if (seenEventIds.size) {
    check('触发记录写入了 data/alert.log', logText.includes(TEST_CODE), `日志 ${logText.split('\n').filter(Boolean).length} 行`);
  }

  // 11) 前端接线一致性（静态检查，不需要浏览器）：
  //     app.js 引用的每个元素 id 都必须在 index.html 里存在 —— 少了就是白屏级的错。
  const html = await readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = await readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
  check('app.js 引用的元素 id 在 index.html 里都存在', missingIds.length === 0, missingIds.join(', ') || `${jsIds.size} 个 id`);

  const needIds = [
    'sidebar-alerts', 'alert-count', 'alert-monitor', 'al-input', 'al-direction',
    'al-target', 'al-note', 'al-add', 'al-check', 'al-beep', 'al-status', 'al-list', 'toast-wrap',
  ];
  const missingUi = needIds.filter((id) => !htmlIds.has(id));
  check('价格预警界面元素齐全', missingUi.length === 0, missingUi.join(', ') || `${needIds.length} 个`);
  check(
    '「价格预警」页签已挂上，且 sidebars 映射里注册了 alerts',
    html.includes('data-view="alerts"') && /alerts:\s*\$\('sidebar-alerts'\)/.test(js),
  );
  const ringJs = await readFile(path.join(__dirname, '..', 'public', 'ring.js'), 'utf8');
  check(
    '前端具备弹窗与铃声（showAlertToast / AlertRing.play）',
    js.includes('function showAlertToast') && js.includes('AlertRing.play'),
  );
  check(
    '铃声独立成 public/ring.js、被页面加载、且默认连响三遍',
    html.includes('src="/ring.js"') && /DEFAULT_TIMES\s*=\s*3/.test(ringJs) && js.includes('play({ times: 3 })'),
  );
  check('铃声有"点一下静音"的退路（stopAlertRing）', js.includes('stopAlertRing') && ringJs.includes('function stop'));
  check('预警轮询已启动（每 5 秒拉一次本地状态）', js.includes('loadAlerts({ silent: true }), 5000'));

  // 10) 删除 + 不碰用户的预警
  const del = await api('DELETE', `/api/alerts/${encodeURIComponent(alertA.id)}`);
  check('DELETE 删除成功', del.ok && del.json.removed === 1);
  for (const id of [alertB.id]) {
    await api('DELETE', `/api/alerts/${encodeURIComponent(id)}`);
  }
  const final = await api('GET', '/api/alerts');
  const finalIds = new Set((final.json.items ?? []).map((a) => a.id));
  check('测试创建的预警已全部清掉', ![...created].some((id) => finalIds.has(id)), `剩 ${finalIds.size} 条`);
  check(
    '测试开始前已有的预警一条都没被动过',
    [...baselineIds].every((id) => finalIds.has(id)),
    `基线 ${baselineIds.size} 条`,
  );

  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
  return fail === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`✗ 测试异常：${err.stack ?? err.message}`);
  code = 1;
} finally {
  await cleanup();
  if (code === 0) console.log('（已清理测试数据）');
}
process.exit(code);

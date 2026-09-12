/**
 * MCP 连通性检查：直接对同花顺的远程 MCP 端点走一遍 initialize + tools/list。
 *
 * 目的：把"DSH 配置写对了"和"MCP 服务真能用"分开验证。
 * 若本脚本通过而 DSH 里看不到工具，问题就在 DSH 侧，不必怀疑服务。
 *
 * 用法：node scripts/mcp-check.mjs
 */

import { resolveApiKey } from '../lib/hithink.mjs';

const HOST = 'https://fuyao.aicubes.cn';
const SERVERS = ['a-share', 'meta'];

const { key, source } = resolveApiKey();
if (!key) {
  console.error('✗ 未找到 API Key（.apikey 或 HITHINK_FINANCE_API_KEY）');
  process.exit(1);
}
console.log(`Key 来源: ${source}`);
console.log(`Key 长度: ${key.length}（不打印内容）\n`);

/** 解析 MCP 响应：可能是纯 JSON，也可能是 SSE（text/event-stream）。 */
function parseBody(contentType, text) {
  if (contentType?.includes('text/event-stream')) {
    const payloads = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (const p of payloads) {
      try {
        const obj = JSON.parse(p);
        if (obj && (obj.result || obj.error)) return obj;
      } catch {
        /* 忽略无法解析的心跳等载荷 */
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(name, method, params, sessionId) {
  const res = await fetch(`${HOST}/mcp/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-api-key': key,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') ?? sessionId,
    contentType: res.headers.get('content-type'),
    body: parseBody(res.headers.get('content-type'), text),
    rawHead: text.slice(0, 200),
  };
}

let failures = 0;

for (const server of SERVERS) {
  console.log(`=== /mcp/${server} ===`);
  try {
    const init = await rpc(server, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-check', version: '1.0.0' },
    });

    if (init.status !== 200 || !init.body?.result) {
      failures += 1;
      console.log(`✗ initialize 失败 HTTP ${init.status} content-type=${init.contentType}`);
      console.log(`  原始响应前 200 字符: ${init.rawHead}`);
      console.log('');
      continue;
    }

    const info = init.body.result;
    console.log(`✓ initialize  HTTP ${init.status}`);
    console.log(`  协议版本 : ${info.protocolVersion}`);
    console.log(`  服务端   : ${info.serverInfo?.name} ${info.serverInfo?.version ?? ''}`);
    console.log(`  session  : ${init.sessionId ? '已下发' : '未下发'}`);

    const list = await rpc(server, 'tools/list', {}, init.sessionId);
    const tools = list.body?.result?.tools ?? [];
    if (!tools.length) {
      failures += 1;
      console.log(`✗ tools/list 返回 0 个工具（HTTP ${list.status}）`);
      console.log(`  原始响应前 200 字符: ${list.rawHead}`);
    } else {
      console.log(`✓ tools/list  ${tools.length} 个工具`);
      console.log(`  示例: ${tools.slice(0, 3).map((t) => t.name).join(', ')}`);
    }
  } catch (err) {
    failures += 1;
    console.log(`✗ 请求异常: ${err.message}`);
  }
  console.log('');
}

console.log(failures === 0 ? '全部通过。' : `${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);

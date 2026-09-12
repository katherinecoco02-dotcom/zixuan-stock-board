/**
 * 预警铃声测试（无需浏览器、无需声卡）
 *
 * 用 AudioContext 桩把 public/ring.js 在 Node 里跑起来，断言铃声的**结构**：
 *   - 默认连响 **3 遍**，每遍 3 个音（A5 → C#6 → E6），每音 3 个泛音
 *   - 每遍起点等距（短句时长 + 0.7 秒留白），音的相对位置是 0 / 0.2 / 0.4 秒
 *   - 起音时刻是"当前时间 + 0.03 秒"的绝对时间（不是 0，否则会立刻响/被吞）
 *   - stop() 能把主增益降到 0 并停掉所有振荡器；再 play() 会先掐掉上一段
 *   - 没有 WebAudio 时返回 null 而不是抛异常（预警本身不能因此挂掉）
 *
 * 用法：node scripts/ring-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RING_JS = fileURLToPath(new URL('../public/ring.js', import.meta.url));

// ---- AudioContext 桩：记录"排了什么音、什么时候起、什么时候停"，不产生真实声音
function makeStub(startTime = 100) {
  const log = { oscillators: [], gains: [], starts: [], stops: [], ramps: [] };
  const ctx = {
    currentTime: startTime,
    state: 'running',
    destination: { name: 'destination' },
    resume: () => Promise.resolve(),
    createGain() {
      const node = {
        gain: {
          value: 1,
          setValueAtTime(v, t) { log.ramps.push({ kind: 'set', v, t, node }); this.value = v; },
          exponentialRampToValueAtTime(v, t) { log.ramps.push({ kind: 'exp', v, t, node }); this.value = v; },
          cancelScheduledValues(t) { log.ramps.push({ kind: 'cancel', t, node }); },
        },
        connect(dest) { node.connectedTo = dest; return dest; },
        kind: 'gain',
      };
      log.gains.push(node);
      return node;
    },
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        connect(dest) { osc.connectedTo = dest; return dest; },
        start(t) { log.starts.push({ osc, t }); },
        stop(t) { log.stops.push({ osc, t }); },
        kind: 'osc',
      };
      log.oscillators.push(osc);
      return osc;
    },
  };
  return { ctx, log };
}

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}`);
  }
};
const near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;

function loadRing(stubCtx) {
  globalThis.window = {};
  if (stubCtx) globalThis.window.AudioContext = function StubAudioContext() { return stubCtx; };
  eval(readFileSync(RING_JS, 'utf8'));
  return globalThis.window.AlertRing;
}

// ---------------------------------------------------------------- 1. 默认：三遍
console.log('=== 默认参数：应当连响三遍 ===');
{
  const { ctx, log } = makeStub(100);
  const ring = loadRing(ctx);
  ok(Boolean(ring), 'ring.js 挂出了 window.AlertRing');

  const r = ring.play();
  ok(r !== null && r.times === 3, `默认连响 ${r?.times} 遍（期望 3）`);
  ok(r.noteCount === 9, `共 ${r.noteCount} 个音（3 音 × 3 遍 = 9）`);
  ok(r.oscillators === 27, `共 ${r.oscillators} 个振荡器（9 音 × 3 泛音 = 27）`);
  ok(ring.NOTES.length === 3, `每遍 ${ring.NOTES.length} 个音`);

  // 每遍的起点：等距 = 短句时长 + 留白
  const period = ring.PHRASE + ring.REPEAT_GAP;
  const repeatStarts = [1, 2, 3].map((n) => {
    const first = r.schedule.filter((s) => s.repeat === n).map((s) => s.at).sort((a, b) => a - b)[0];
    return first;
  });
  ok(near(repeatStarts[0], 0) && near(repeatStarts[1], period) && near(repeatStarts[2], 2 * period),
    `三遍起点等距：${repeatStarts.map((s) => s.toFixed(2)).join(' / ')} 秒（周期 ${period.toFixed(2)} 秒）`);
  ok(near(r.durationMs / 1000, 3 * period - ring.REPEAT_GAP, 0.01),
    `总时长约 ${(r.durationMs / 1000).toFixed(2)} 秒（= 3 遍 − 末尾留白）`);

  // 每遍内部：0 / 0.2 / 0.4 秒，频率是三音上行
  const fundamentals = ring.NOTES.map((n) => n.freq);
  let intraOk = true;
  let freqOk = true;
  for (const n of [1, 2, 3]) {
    const base = repeatStarts[n - 1];
    const notes = r.schedule.filter((s) => s.repeat === n);
    const uniq = [...new Set(notes.map((s) => s.at))].sort((a, b) => a - b);
    if (!(uniq.length === 3 && near(uniq[0], base) && near(uniq[1], base + 0.2) && near(uniq[2], base + 0.4))) intraOk = false;
    for (const f of fundamentals) {
      if (!notes.some((s) => near(s.freq, f, 0.01))) freqOk = false;
    }
  }
  ok(intraOk, '每遍内部三个音落在 0 / 0.20 / 0.40 秒');
  ok(freqOk, `每遍都含三个基频 ${fundamentals.map((f) => Math.round(f)).join('/')} Hz（上行三音）`);
  ok([...fundamentals].sort((a, b) => a - b).join() === fundamentals.join(), '三个音是上行排列（听感上"叮-咚-叮"）');

  // 泛音：×1 / ×2 / ×2.76
  const partials = ring.PARTIALS.map(([m]) => m);
  const hasAll = fundamentals.every((f) => partials.every((m) => r.schedule.some((s) => near(s.freq, f * m, 0.01))));
  ok(hasAll, `每个音都排了 ${partials.length} 个泛音（×${partials.join(' / ×')}）`);

  // 绝对时刻：不是从 0 开始，而是 currentTime + 0.03
  const firstStart = Math.min(...log.starts.map((s) => s.t));
  ok(near(firstStart, ctx.currentTime + 0.03, 0.005),
    `起音时刻基于当前时间：${firstStart.toFixed(3)}（currentTime=${ctx.currentTime} + 0.03）`);
  ok(log.starts.length === 27 && log.stops.length === 27, `每个振荡器都排了 start 与 stop（${log.starts.length}/${log.stops.length}）`);
  ok(log.starts.every((s) => log.stops.some((p) => p.osc === s.osc && p.t > s.t)), '每个振荡器的 stop 都晚于它的 start');
  ok(ring.playing === true, 'play() 后 playing = true');

  // 音量包络：快起音 + 指数衰减（不是方波式的硬切）
  const noteGains = log.gains.filter((g) => g !== log.gains[0]); // 第 0 个是 master
  ok(noteGains.length === 27, `每个音一个增益节点（${noteGains.length} 个）`);
  ok(log.ramps.filter((x) => x.kind === 'exp').length === 27 * 2, '每个音有"快速起音 + 指数衰减"两条指数包络');

  console.log(`    第 1 遍：${r.schedule.filter((s) => s.repeat === 1 && s.freq === fundamentals[0] || (s.repeat === 1 && fundamentals.some((f) => near(s.freq, f)))) .slice(0, 3).map((s) => `${s.freq}Hz@${s.at}s`).join(', ')}`);
}

// ---------------------------------------------------------------- 2. 静音
console.log('\n=== stop()：能不能立刻安静 ===');
{
  const { ctx, log } = makeStub(50);
  const ring = loadRing(ctx);
  const r = ring.play();
  const before = log.stops.length;
  const stopped = ring.stop();
  ok(stopped === true, 'stop() 返回 true 表示确实掐掉了正在响的铃声');
  ok(ring.playing === false, 'stop() 后 playing = false');
  const master = log.gains[0];
  const cancel = log.ramps.find((x) => x.kind === 'cancel' && x.node === master);
  const fade = log.ramps.find((x) => x.kind === 'exp' && x.node === master && x.v < 0.01);
  ok(Boolean(cancel) && Boolean(fade), `主增益被取消原计划并快速淡出（${fade ? `降到 ${fade.v}` : '无淡出'}）`);
  ok(log.stops.length === before + r.oscillators, `所有 ${r.oscillators} 个振荡器都被停掉（新增 ${log.stops.length - before} 次 stop）`);
  ok(log.stops.slice(before).every((s) => s.t <= ctx.currentTime + 0.1), '停止时刻都在当前时间附近（不会等它放完）');
  ok(ring.stop() === false, '没在响的时候再 stop() 返回 false，不报错');
}

// ---------------------------------------------------------------- 3. 连点两下
console.log('\n=== 连点两次「试听铃」：不该两段铃声叠在一起 ===');
{
  const { ctx, log } = makeStub(10);
  const ring = loadRing(ctx);
  ring.play();
  const masters = log.gains.length; // master + 27 音增益
  ring.play({ times: 3 });
  const firstMaster = log.gains[0];
  ok(log.ramps.some((x) => x.kind === 'cancel' && x.node === firstMaster),
    '第二次 play() 会先把上一段的 master 取消掉（不叠加）');
  ok(log.gains.length === masters * 2 - 27 - 1 + 27 + 1, `共排了两段铃声的节点（${log.gains.length} 个增益）`);
  ok(ring.playing === true, '第二次播放处于进行中');
}

// ---------------------------------------------------------------- 4. 参数与降级
console.log('\n=== 参数与降级 ===');
{
  const { ctx, log } = makeStub(0);
  const ring = loadRing(ctx);
  ok(ring.play({ times: 1 }).times === 1, 'times=1 → 只响一遍');
  ok(ring.play({ times: 2 }).times === 2, 'times=2 → 响两遍');
  ok(ring.play({ times: 99 }).times === 10, 'times 超上限被钳到 10（防止误设成响一小时）');
  // 非法值回落到**默认 3 遍**：预警是"必须听到"的场景，宁可响默认次数也不能因此变哑
  ok(ring.play({ times: 0 }).times === 3, 'times=0 → 回落到默认 3 遍（不静音）');
  ok(ring.play({ times: -5 }).times === 3, 'times=-5 → 回落到默认 3 遍');
  ok(ring.play({ times: 'abc' }).times === 3, 'times 非数字 → 回落到默认 3 遍');
  const oscBefore = log.oscillators.length;
  ring.play({ times: 2 });
  ok(log.oscillators.length - oscBefore === 18, 'times=2 → 18 个振荡器（2 遍 × 3 音 × 3 泛音）');

  // 没有 WebAudio：返回 null，不抛
  const noAudio = loadRing(null);
  let threw = false;
  let res = 'unset';
  try {
    res = noAudio.play();
  } catch (err) {
    threw = true;
    res = String(err.message);
  }
  ok(!threw && res === null, `无 AudioContext 时 play() 返回 null 且不抛异常（实际：${res}）`);
  ok(noAudio.unlock() === false, 'unlock() 在无 AudioContext 时返回 false');
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);

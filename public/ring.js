/**
 * 价格预警铃声（独立文件：这样"响几遍、每遍几个音、间隔多久"可以在 Node 里
 * 用 AudioContext 桩断言，而不是只能靠耳朵听一遍 —— 见 scripts/ring-test.mjs）
 *
 * 声音设计：
 *   - 一段**三音上行**的「叮-咚-叮」短句：A5(880) → C#6(1108.73) → E6(1318.51)，
 *     比两声"滴滴"更接近门铃/铃声，也更容易在一片静音里被注意到。
 *   - 每个音用 **基频 + 2 个非整数倍泛音（×2、×2.76）** 叠加，12ms 快速起音、
 *     指数衰减 —— 这是钟/铃类音色的常用做法，纯正弦听起来像测试音。
 *   - 短句之间留 0.7 秒空白，**默认连响 3 遍**（约 3.9 秒）。
 *   - 想立刻安静：在页面任意位置点一下（app.js 的 pointerdown 会调用 stop()）。
 */
(function (global) {
  /** 短句里的音：频率 Hz、相对短句起点的秒数、时值秒 */
  const NOTES = [
    { freq: 880.0, at: 0.0, dur: 0.34 }, // A5
    { freq: 1108.73, at: 0.2, dur: 0.34 }, // C#6
    { freq: 1318.51, at: 0.4, dur: 0.44 }, // E6（收尾音稍长，听感更"完整"）
  ];
  /** 泛音： [相对基频的倍数, 相对音量] */
  const PARTIALS = [[1, 0.52], [2, 0.16], [2.76, 0.09]];
  /** 每遍之间的留白（秒） */
  const REPEAT_GAP = 0.7;
  const DEFAULT_TIMES = 3;
  const DEFAULT_VOLUME = 0.5;
  const ATTACK = 0.012;
  const MAX_TIMES = 10;

  /** 短句自身时长 = 最后一个音的起点 + 时值 */
  const PHRASE = NOTES[NOTES.length - 1].at + NOTES[NOTES.length - 1].dur;

  let ctx = null;
  let current = null; // { master, sources, endAt }

  function ensureCtx() {
    if (!ctx) {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return null;
      try {
        ctx = new Ctx();
      } catch {
        return null;
      }
    }
    // 浏览器要求音频必须由用户手势解锁：没解锁时 resume 一下，失败就下次再说
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        ctx.resume().catch(() => {});
      } catch {
        /* 忽略 */
      }
    }
    return ctx;
  }

  /** 停掉正在响的铃声：主增益快速降到 0 并把所有振荡器停掉。 */
  function stop() {
    if (!current || !ctx) {
      current = null;
      return false;
    }
    const { master, sources } = current;
    const now = ctx.currentTime;
    try {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      for (const s of sources) {
        try {
          s.stop(now + 0.08);
        } catch {
          /* 已经自然结束了 */
        }
      }
    } catch {
      /* 环境异常不该影响预警本身 */
    }
    current = null;
    return true;
  }

  /**
   * 播放铃声。
   * @param {{times?: number, volume?: number}} [opts]
   * @returns {null | {times: number, durationMs: number, oscillators: number,
   *                   noteCount: number, schedule: Array}} 不支持 WebAudio 时返回 null
   */
  function play(opts = {}) {
    const rawTimes = Number(opts.times);
    const times = Math.max(1, Math.min(Number.isFinite(rawTimes) && rawTimes > 0 ? Math.round(rawTimes) : DEFAULT_TIMES, MAX_TIMES));
    const volume = Number.isFinite(Number(opts.volume)) && Number(opts.volume) > 0 ? Number(opts.volume) : DEFAULT_VOLUME;

    const c = ensureCtx();
    if (!c) return null;

    stop(); // 上一段还没放完就直接掐掉，避免两段铃声叠在一起

    const t0 = c.currentTime + 0.03;
    const period = PHRASE + REPEAT_GAP;
    const master = c.createGain();
    master.gain.value = volume;
    master.connect(c.destination);

    const sources = [];
    const schedule = [];
    for (let r = 0; r < times; r++) {
      for (const n of NOTES) {
        const at = t0 + r * period + n.at;
        for (const [mult, level] of PARTIALS) {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = 'sine';
          osc.frequency.value = n.freq * mult;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(level, at + ATTACK);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + n.dur);
          osc.connect(gain);
          gain.connect(master);
          osc.start(at);
          osc.stop(at + n.dur + 0.02);
          sources.push(osc);
          schedule.push({
            repeat: r + 1,
            freq: Math.round(n.freq * mult * 100) / 100,
            at: Number((at - t0).toFixed(4)),
            dur: n.dur,
          });
        }
      }
    }

    const durationMs = Math.round((times * period - REPEAT_GAP) * 1000);
    current = { master, sources, endAt: t0 + times * period };
    // 自然放完后清掉引用（不影响已排好的音）
    setTimeout(() => {
      if (current && current.master === master) current = null;
    }, durationMs + 300);

    return {
      times,
      durationMs,
      oscillators: sources.length,
      noteCount: NOTES.length * times,
      schedule,
    };
  }

  global.AlertRing = {
    play,
    stop,
    unlock: () => Boolean(ensureCtx()),
    get playing() {
      return Boolean(current);
    },
    NOTES,
    PARTIALS,
    REPEAT_GAP,
    PHRASE,
    DEFAULT_TIMES,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * 播放器：以音频时钟为主时钟的关卡播放。
 *  - 谱面时间 = 音乐时间 − offset（官方 offset 单位为秒，RPE 在解析时已换成秒）
 *  - 支持播放/暂停、精准跳转、倍速（项目要求）
 *  - 没有音频时退化为 performance.now() 时钟，便于快速预览与测试
 */
export function createPlayer() {
  const player = {
    state: null,
    offset: 0,
    rate: 1,
    playing: false,
    audioBuffer: null,
    audioCtx: null,
    source: null,
    startedAt: 0, // 起播时的音乐位置（秒）
    startedClock: 0, // 起播时的时钟读数（秒）
    clock: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
    onEnded: null,
    hitsActive: [],
  };

  function ensureCtx() {
    if (player.audioCtx) return player.audioCtx;
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      player.audioCtx = new Ctx();
      player.clock = () => player.audioCtx.currentTime;
    } catch {
      player.audioCtx = null;
    }
    return player.audioCtx;
  }

  /** 加载音频（URL 或 Blob） */
  async function loadAudio(url) {
    const ctx = ensureCtx();
    if (!ctx) return null;
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    player.audioBuffer = await ctx.decodeAudioData(buf);
    return player.audioBuffer;
  }

  function audioPosition() {
    if (!player.playing) return player.startedAt;
    return player.startedAt + (player.clock() - player.startedClock) * player.rate;
  }

  /** 当前谱面时间（秒） */
  function chartTime() {
    return audioPosition() - player.offset;
  }

  function stopSource() {
    if (player.source) {
      try {
        player.source.onended = null;
        player.source.stop();
      } catch {
        /* ignore */
      }
      player.source = null;
    }
  }

  function play() {
    if (player.playing) return;
    const ctx = ensureCtx();
    player.playing = true;
    player.startedClock = player.clock();
    if (ctx && player.audioBuffer) {
      if (ctx.state === 'suspended') ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = player.audioBuffer;
      src.playbackRate.value = player.rate;
      const offset = Math.max(0, Math.min(player.startedAt, player.audioBuffer.duration - 0.001));
      src.connect(ctx.destination);
      src.onended = () => {
        if (player.source === src && player.playing && audioPosition() >= player.audioBuffer.duration - 0.05) {
          player.playing = false;
          player.startedAt = player.audioBuffer.duration;
          player.source = null;
          player.onEnded?.();
        }
      };
      src.start(0, offset);
      player.source = src;
    }
  }

  function pause() {
    if (!player.playing) return;
    player.startedAt = audioPosition();
    player.playing = false;
    stopSource();
  }

  function seek(chartSeconds) {
    const wasPlaying = player.playing;
    if (wasPlaying) pause();
    player.startedAt = Math.max(0, chartSeconds + player.offset);
    if (wasPlaying) play();
  }

  function setRate(rate) {
    const pos = audioPosition();
    player.rate = rate;
    player.startedAt = pos;
    player.startedClock = player.clock();
    if (player.source) player.source.playbackRate.value = rate;
  }

  /** 每帧调用：更新状态求值与打击特效生命周期 */
  function update(state, evaluateFn, judgeFn) {
    const t = chartTime();
    evaluateFn(state, t);
    const newHits = judgeFn(state, t);
    for (const hit of newHits) player.hitsActive.push(hit);
    const expire = t - 1;
    player.hitsActive = player.hitsActive.filter((h) => h.time > expire);
    return t;
  }

  return {
    player,
    loadAudio,
    play,
    pause,
    seek,
    setRate,
    chartTime,
    audioPosition,
    update,
    get duration() {
      return player.audioBuffer?.duration ?? null;
    },
    get hits() {
      return player.hitsActive;
    },
  };
}

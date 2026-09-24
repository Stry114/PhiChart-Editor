/**
 * 播放器：以音频时钟为主时钟的关卡播放。
 *  - 谱面时间 = 音乐时间 − offset（官方 offset 单位为秒，RPE 在解析时已换成秒）
 *  - 支持播放/暂停、精准跳转、倍速（项目要求）
 *  - 没有音频时退化为 performance.now() 时钟，便于快速预览与测试
 */
/** 待播音效最多迟到多久就丢弃（秒）：跳转/暂停跨太久时不要补一串音效 */
const NOTE_SOUND_LATE_LIMIT = 0.35;

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
    /** 打击音效：tap/hold 共用 click.wav，drag/flick 各自一个（键为音符类型） */
    sounds: {},
    soundGain: null,
    soundVolume: 1,
    hitSoundEnabled: true,
    /** 音乐（谱面音频）输出：开关 + 音量，供预览面板的「音频」开关控制 */
    musicGain: null,
    musicVolume: 1,
    musicEnabled: true,
  };

  /** 待播的打击音效队列：`[{ at, type }]`（Drag / Flick 提前判定时等落线再响） */
  const pendingSounds = [];

  function ensureCtx() {    if (player.audioCtx) return player.audioCtx;
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

  /** 加载打击音效：tap/hold 共用 click.wav；缺文件时静默跳过（不影响其他声音） */
  async function loadHitSounds(baseUrl = 'assets/') {
    const ctx = ensureCtx();
    if (!ctx) return {};
    const files = { tap: 'click.wav', hold: 'click.wav', drag: 'drag.wav', flick: 'flick.wav' };
    await Promise.all(
      Object.entries(files).map(async ([type, file]) => {
        try {
          const res = await fetch(baseUrl + file);
          if (!res.ok) return;
          player.sounds[type] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch (err) {
          console.warn(`打击音效加载失败：${file}`, err);
        }
      }),
    );
    return player.sounds;
  }

  /** 播放一次打击音效（每次新建 source，避免互相打断）；任何环境问题都静默跳过 */
  function playHitSound(type) {
    try {
      const ctx = player.audioCtx;
      const buf = player.sounds[type] ?? player.sounds.tap;
      if (!ctx || !buf || !player.hitSoundEnabled) return;
      if (ctx.state === 'suspended') ctx.resume();
      if (!player.soundGain) {
        player.soundGain = ctx.createGain();
        player.soundGain.connect(ctx.destination);
      }
      player.soundGain.gain.value = player.soundVolume;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(player.soundGain);
      src.start();
    } catch (err) {
      player.hitSoundEnabled = false; // 只报一次，避免每帧刷屏
      console.warn('打击音效播放失败，已关闭：', err);
    }
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

  /** 音乐输出增益（音乐开关用；打击音效走自己的 soundGain） */
  function ensureMusicGain(ctx) {
    if (!player.musicGain) {
      player.musicGain = ctx.createGain();
      player.musicGain.connect(ctx.destination);
    }
    player.musicGain.gain.value = player.musicEnabled ? player.musicVolume : 0;
    return player.musicGain;
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
      src.connect(ensureMusicGain(ctx));
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
    pendingSounds.length = 0; // 跳转：丢掉上一条时间线的待播音效
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
    for (const hit of newHits) {
      player.hitsActive.push(hit);
      // Hold 的重复打击动画不重复播放音效（只在头部命中时响一次）
      if (hit.repeat) continue;
      // 音效时刻：Drag / Flick 提前判定时等音符落线再响（见 core/state.js 的 soundTime），
      // 其余一律立刻响。到点的先攒起来，下一帧（或本帧稍后）再播。
      const at = Number.isFinite(hit.soundTime) ? hit.soundTime : t;
      if (at <= t + 1e-6) playHitSound(hit.type ?? 'tap');
      else pendingSounds.push({ at, type: hit.type ?? 'tap' });
    }
    // 待播音效：到点就播（按时刻升序处理，超出视野的旧条目直接丢掉）
    for (let i = pendingSounds.length - 1; i >= 0; i--) {
      const item = pendingSounds[i];
      if (item.at <= t + 1e-6) {
        pendingSounds.splice(i, 1);
        if (t - item.at < NOTE_SOUND_LATE_LIMIT) playHitSound(item.type);
      }
    }
    const expire = t - 1;
    player.hitsActive = player.hitsActive.filter((h) => h.time > expire);
    return t;
  }

  /** 清掉待播音效（跳转 / 换谱 / 重开时用，避免把上一条时间线的音效带过来） */
  function clearPendingSounds() {
    pendingSounds.length = 0;
    return 0;
  }

  /** 卸载当前音频（换谱面时用，避免还播着上一个包的音乐） */
  function unloadAudio() {
    stopSource();
    player.audioBuffer = null;
    player.startedAt = 0;
    clearPendingSounds();
    return null;
  }

  /** 音乐开关：立即生效（正在播放时实时改增益） */
  function setMusicEnabled(on) {
    player.musicEnabled = !!on;
    if (player.musicGain) player.musicGain.gain.value = player.musicEnabled ? player.musicVolume : 0;
    return player.musicEnabled;
  }

  /** 打击音效开关 */
  function setHitSoundEnabled(on) {
    player.hitSoundEnabled = !!on;
    return player.hitSoundEnabled;
  }

  return {
    player,
    loadAudio,
    unloadAudio,
    loadHitSounds,
    playHitSound,
    setMusicEnabled,
    setHitSoundEnabled,
    play,
    pause,
    seek,
    setRate,
    chartTime,
    audioPosition,
    update,
    clearPendingSounds,
    /** 待播音效条数（测试/诊断用） */
    get pendingSoundCount() {
      return pendingSounds.length;
    },
    get hasAudio() {
      return !!player.audioBuffer;
    },
    get duration() {
      return player.audioBuffer?.duration ?? null;
    },
    get hits() {
      return player.hitsActive;
    },
  };
}

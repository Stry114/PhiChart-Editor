/**
 * 右上角「预览」：直接复用渲染器（src/render）与播放器（src/app/player.js）。
 *  - 指针（时间轴 playhead）指到哪就渲染哪一帧：不播放时也能实时拖动查看
 *  - 播放时用音频时钟推进，并把指针同步回时间轴
 */
import { createCanvasRenderer } from '../render/canvas2d.js';
import { loadTextures } from '../render/textures.js';
import { detectFormat, prepareChart } from '../core/model.js';
import { parseOfficialChart } from '../core/parse-official.js';
import { parseRpeChart } from '../core/parse-rpe.js';
import { createState, evaluate, advanceJudging, resetState } from '../core/state.js';
import { createPlayer } from '../app/player.js';
import { Diagnostics } from '../core/sanitize.js';
import { loadZipPackage, loadFilePackage, parseInfoTxt } from '../core/package.js';
import { resolveMeta, applyMetaToChart, metaToInfoTxt, META_PRIORITY_HINT } from '../core/meta.js';

export const SAMPLES = [
  {
    id: 'official',
    label: '白复生 AT（official）',
    dir: 'packages/白复生 AT（official格式）',
    chart: 'Chart_AT #3649.json',
    // 包内 info.txt 里写的 Song/Picture 与真实文件名不一致，这里给出实际文件名作为首选
    audio: 'music #1988.wav',
    background: 'Illustration #4286.png',
  },
  {
    id: 'rpe',
    label: '领土战争 AT（RPE）',
    dir: 'packages/领土战争AT（RPE格式）',
    chart: '29519800.json',
    audio: '29519800.wav',
    background: '29519800.png',
  },
];

const url = (p) => p.split('/').map(encodeURIComponent).join('/');

export async function createPreview(dom) {
  const { canvas, emptyEl, infoEl, timeEl, fpsEl } = dom;
  const playback = createPlayer();
  let textures = null;
  let renderer = null;
  let state = null;
  let chart = null;
  let raf = 0;
  let lastFrame = 0;
  let lastFpsAt = 0;
  let fps = 0;
  let onTime = null;
  let frameCount = 0; // 性能诊断：累计渲染帧数
  let lastTimeText = '';
  let backgroundImage = null; // 已加载的曲绘（关掉开关时只是不画）
  let backgroundSource = null; // 曲绘实际用的地址（诊断用）
  let audioSource = null; // 音频实际用的地址（诊断用）
  let fromPackage = false; // 这次载入是否来自完整谱面包（决定要不要提示「缺音频/曲绘」）
  let bgEnabled = true; // 背景图开关（默认开启）
  let audioEnabled = true; // 音频开关（默认开启）
  let autoRollback = false; // 自动回滚：暂停后回到播放起点
  let playStartTime = 0; // 本次播放的起始时刻

  /**
   * 解析谱面并**按权威顺序套用元数据**：info.txt > info.csv > 谱面 JSON 元数据 > 包名。
   * @param {object} json 原始谱面 JSON
   * @param {{file?:string, packageName?:string, infoTxt?:object, infoCsv?:object, chartMeta?:object}} opts
   */
  function build(json, { file, packageName, infoTxt, infoCsv, chartMeta } = {}) {
    const diagnostics = new Diagnostics();
    const format = detectFormat(json);
    const resolved = resolveMeta({
      infoTxt,
      infoCsv,
      chartMeta: chartMeta ?? json?.META,
      packageName: packageName ?? file,
    });
    const options = { file, meta: resolved.meta, diagnostics };
    const model =
      format === 'rpe'
        ? parseRpeChart(json, options)
        : format === 'official'
          ? parseOfficialChart(json, options)
          : null;
    if (!model) throw new Error('无法识别的谱面格式（缺少 judgeLineList）');
    applyMetaToChart(model, resolved);
    const prepared = prepareChart(model, { diagnostics });
    prepared.diagnostics = { summary: diagnostics.summary, messages: diagnostics.messages };
    return prepared;
  }

  function apply(chartModel, label, opts = {}) {
    chart = chartModel;
    fromPackage = !!opts.fromPackage;
    // 换谱面先清掉上一个包的音频与曲绘，避免残留（也让「缺媒体」提示如实反映）
    backgroundSource = null;
    audioSource = null;
    backgroundImage = null;
    renderer.setBackground(null);
    playback.unloadAudio?.();
    state = createState(chart, { aspect: renderer.view.areaW / renderer.view.areaH });
    playback.player.offset = chart.meta.offset || 0;
    playback.player.startedAt = 0;
    playback.player.playing = false;
    playback.player.hitsActive = [];
    if (emptyEl) emptyEl.classList.add('hidden');
    if (infoEl) {
      const parts = [
        label ?? chart.meta.name ?? '',
        chart.format === 'rpe' ? `RPE v${chart.source.rpeVersion}` : `official v${chart.source.formatVersion}`,
        `${chart.lines.length} 线 / ${chart.notes.length} 音符`,
        `${chart.endTime.toFixed(2)}s`,
        `诊断 ${chart.diagnostics?.summary ?? '-'}`,
      ];
      if (!playback.hasAudio) parts.push('⚠ 无音频');
      if (!backgroundImage) parts.push('⚠ 无曲绘');
      infoEl.textContent = parts.join('｜');
    }
    // 先求值一帧，保证外部（时间轴/结构树）能立刻拿到音符与事件
    evaluate(state, 0);
    return chart;
  }

  async function loadSample(sample) {
    const base = `${url(sample.dir)}/`;
    const res = await fetch(base + url(sample.chart));
    if (!res.ok) throw new Error(`谱面读取失败：${res.status}`);
    const json = await res.json();
    // 包内 info.txt 是元数据的最高权威来源（见 src/core/meta.js）
    const infoRes = await fetch(`${base}info.txt`).catch(() => null);
    const infoTxt = infoRes?.ok ? parseInfoTxt(await infoRes.text()) : null;
    const prepared = apply(build(json, { file: sample.chart, packageName: sample.dir.split('/').pop(), infoTxt }), sample.label, { fromPackage: true });
    const baseName = sample.chart.replace(/\.json$/i, '');
    // 音频：示例里的实际文件名 → info.txt 的 Song → 与谱面同名的 .wav
    await loadFirstAudio([sample.audio, infoTxt?.Song, `${baseName}.wav`].map((name) => (name ? base + url(name) : null)));
    // 曲绘：示例里的实际文件名 → info.txt 的 Picture → 与谱面同名的 .png
    await loadFirstImage([sample.background, infoTxt?.Picture, `${baseName}.png`].map((name) => (name ? base + url(name) : null)));
    return prepared;
  }

  /** 依次尝试若干候选地址，成功后加载音频；全失败也不报错（预览仍可看） */
  async function loadFirstAudio(candidates) {
    for (const src of candidates.filter(Boolean)) {
      try {
        const buf = await playback.loadAudio(src);
        if (buf) {
          audioSource = src;
          applyAudioSwitch();
          return src;
        }
      } catch {
        /* 试下一个候选 */
      }
    }
    console.warn('预览：没有找到可用的音频文件', candidates);
    return null;
  }

  /** 依次尝试若干候选地址，成功后设为背景图 */
  async function loadFirstImage(candidates) {
    for (const src of candidates.filter(Boolean)) {
      const img = await loadImageUrl(src);
      if (img) {
        backgroundImage = img;
        backgroundSource = src;
        applyBgSwitch();
        return src;
      }
    }
    console.warn('预览：没有找到可用的曲绘文件', candidates);
    return null;
  }

  /** 把「背景图开关」状态应用到渲染器 */
  function applyBgSwitch() {
    renderer.setBackground(bgEnabled ? backgroundImage : null);
  }

  /** 把「音频开关」状态应用到播放器 */
  function applyAudioSwitch() {
    playback.setMusicEnabled?.(audioEnabled);
  }

  function loadImageUrl(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadJson(json, label) {
    // 纯 JSON：谱面里没有音频与曲绘，界面上会提示改用「谱面包」
    return apply(build(json, { file: label, packageName: label }), label, { fromPackage: false });
  }

  async function loadZip(file) {
    const buffer = await file.arrayBuffer();
    const pkg = await loadZipPackage(buffer, file.name);
    const prepared = apply(
      build(pkg.chartJson, { file: pkg.chartPath, packageName: pkg.name, infoTxt: pkg.info, infoCsv: pkg.infoCsv }),
      pkg.name,
      { fromPackage: true },
    );
    // 注意：包对象给的是 songPath/backgroundPath + urlFor()，没有 songBlob/backgroundBlob
    const songUrl = pkg.songPath ? pkg.urlFor(pkg.songPath) : null;
    if (songUrl) {
      audioSource = pkg.songPath;
      await playback.loadAudio(songUrl).then(applyAudioSwitch).catch(() => null);
    }
    const bgUrl = pkg.backgroundPath ? pkg.urlFor(pkg.backgroundPath) : null;
    if (bgUrl) {
      backgroundImage = await loadImageUrl(bgUrl);
      backgroundSource = pkg.backgroundPath;
      applyBgSwitch();
    }
    return prepared;
  }

  async function loadFiles(fileList) {
    const pkg = await loadFilePackage(fileList);
    const prepared = apply(
      build(pkg.chartJson, { file: pkg.chartPath, packageName: pkg.name, infoTxt: pkg.info, infoCsv: pkg.infoCsv }),
      pkg.name,
      { fromPackage: true },
    );
    const songUrl = pkg.songPath ? pkg.urlFor(pkg.songPath) : null;
    if (songUrl) {
      audioSource = pkg.songPath;
      await playback.loadAudio(songUrl).then(applyAudioSwitch).catch(() => null);
    }
    const bgUrl = pkg.backgroundPath ? pkg.urlFor(pkg.backgroundPath) : null;
    if (bgUrl) {
      backgroundImage = await loadImageUrl(bgUrl);
      backgroundSource = pkg.backgroundPath;
      applyBgSwitch();
    }
    return prepared;
  }

  function blobToImage(blob) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(blob);
    });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = lastFrame ? now - lastFrame : 16;
    // 页面不可见时没必要渲染；另外限帧到 ~60fps（高刷屏上原样跑会白白吃满 CPU）
    if (globalThis.document?.hidden) {
      lastFrame = now;
      return;
    }
    if (dt < 15) return;
    lastFrame = now;
    fps = fps ? fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1 : 1000 / Math.max(1, dt);
    if (fpsEl && now - lastFpsAt > 500) {
      lastFpsAt = now;
      fpsEl.textContent = `${fps.toFixed(0)} fps`;
    }

    if (!state) {
      renderer.draw(createEmptyState(), []);
      return;
    }
    const t = playback.chartTime();
    evaluate(state, t);
    const hits = advanceJudging(state, t);
    for (const hit of hits) playback.player.hitsActive.push(hit);
    playback.player.hitsActive = playback.player.hitsActive.filter((h) => h.time > t - 1);
    renderer.draw(state, playback.player.hitsActive);
    frameCount++;
    onTime?.(t);
    if (timeEl) {
      // 只在文本真的变化时写 DOM（每帧写会造成持续的布局/绘制开销）
      const text = `${t.toFixed(2)} / ${(playback.duration ?? chart?.endTime ?? 0).toFixed(2)} s`;
      if (text !== lastTimeText) {
        lastTimeText = text;
        timeEl.textContent = text;
      }
    }
  }

  /** 未载入谱面时也要有东西可画（背景色） */
  let emptyState = null;
  function createEmptyState() {
    if (!emptyState) {
      const model = prepareChart({ lines: [], notes: [], timing: { bpmList: [{ beat: 0, bpm: 120 }], bpmFactor: 1 }, meta: {}, warnings: [] });
      emptyState = createState(model, { aspect: 16 / 9 });
    }
    return emptyState;
  }

  let lastW = 0;
  let lastH = 0;
  function resize() {
    const wrap = canvas.parentElement;
    const rect = wrap?.getBoundingClientRect?.() ?? { width: 640, height: 360 };
    const w = Math.max(64, Math.round(rect.width));
    const h = Math.max(64, Math.round(rect.height));
    // 尺寸没变就直接返回：重设 canvas 尺寸会再触发 ResizeObserver，
    // 且会重建模糊背景（很贵），反复触发就会让页面越来越卡。
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    renderer.resize(w, h);
    if (state) state.aspect = renderer.view.areaW / renderer.view.areaH;
    applyBgSwitch(); // 跟随「背景图」开关（关闭时不画背景）
  }

  // ── 初始化 ──
  textures = await loadTextures('assets/');
  renderer = createCanvasRenderer(canvas, textures);
  // 编辑器里的预览是「工作视图」：曲绘别糊成一片，看得清才方便对位置
  renderer.opts.backgroundBlur = 36;
  renderer.opts.backgroundBrightness = 0.85;
  renderer.resize(640, 360, 1);
  if (globalThis.ResizeObserver) new ResizeObserver(() => resize()).observe(canvas.parentElement);
  globalThis.addEventListener?.('resize', () => resize());
  raf = requestAnimationFrame(frame);

  /** 跳转（内部与外部共用） */
  function seekTo(t) {
    if (!state) return;
    playback.seek(Math.max(0, t));
    evaluate(state, playback.chartTime());
  }

  return {
    get chart() {
      return chart;
    },
    get state() {
      return state;
    },
    renderer,
    playback,
    opts: renderer.opts,
    loadSample,
    loadJson,
    loadZip,
    loadFiles,
    resize,
    play() {
      playStartTime = playback.chartTime();
      playback.play();
    },
    pause() {
      playback.pause();
      // 自动回滚：暂停后指针回到本次播放的起始位置
      if (autoRollback && state) seekTo(playStartTime);
    },
    toggle() {
      if (playback.player.playing) this.pause();
      else this.play();
    },
    restart() {
      if (!state) return;
      resetState(state);
      playback.player.hitsActive = [];
      playStartTime = 0;
      playback.seek(0);
    },
    seek: seekTo,
    setRate(r) {
      playback.setRate(r);
    },
    get rate() {
      return playback.player.rate;
    },
    get playing() {
      return playback.player.playing;
    },
    /**
     * 缺音频/曲绘时的提示（没有就是 null）。
     * 只载入谱面 JSON 时必然缺，这里给出下一步该怎么做。
     */
    get mediaHint() {
      const miss = [];
      if (!playback.hasAudio) miss.push('音频');
      if (!backgroundImage) miss.push('曲绘');
      if (!miss.length) return null;
      if (!fromPackage) {
        return `当前只载入了谱面，没有${miss.join('与')}：用「选择谱面包目录」或「选择 zip 谱面包」载入完整包（也可以直接把包目录拖进这个页面）`;
      }
      return `谱面包里没有找到${miss.join('与')}（包内需要音频文件与曲绘图片）`;
    },
    /** 性能诊断：累计渲染帧数 */
    get stats() {
      return { frames: frameCount };
    },
    /** 背景图开关（默认开启） */
    get backgroundEnabled() {
      return bgEnabled;
    },
    setBackgroundEnabled(on) {
      bgEnabled = !!on;
      applyBgSwitch();
      return bgEnabled;
    },
    get hasBackground() {
      return !!backgroundImage;
    },
    get backgroundSource() {
      return backgroundSource;
    },
    get audioSource() {
      return audioSource;
    },
    /** 音频开关（默认开启） */
    get audioEnabled() {
      return audioEnabled;
    },
    setAudioEnabled(on) {
      audioEnabled = !!on;
      applyAudioSwitch();
      return audioEnabled;
    },
    get hasAudio() {
      return !!playback.hasAudio;
    },
    /** 自动回滚开关（暂停后回到播放起点） */
    get autoRollback() {
      return autoRollback;
    },
    setAutoRollback(on) {
      autoRollback = !!on;
      return autoRollback;
    },
    get playStartTime() {
      return playStartTime;
    },
    onTime(fn) {
      onTime = fn;
    },
    dispose() {
      cancelAnimationFrame(raf);
    },
    /** 导出时统一元数据：写成标准 info.txt（见 src/core/meta.js） */
    metaToInfoTxt: (meta) => metaToInfoTxt(meta ?? chart?.meta ?? {}),
    META_PRIORITY_HINT,
  };
}

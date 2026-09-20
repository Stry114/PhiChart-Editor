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
import { parseProject } from '../core/project.js';
import { createState, evaluate, advanceJudging, resetState, resyncJudgeCursor } from '../core/state.js';
import { createPlayer } from '../app/player.js';
import { Diagnostics } from '../core/sanitize.js';
import { loadFilePackage, parseInfoTxt, unzipToFiles, buildPackage, findProjectFile } from '../core/package.js';
import { resolveMeta, applyMetaToChart } from '../core/meta.js';

const AUDIO_EXT_RE = /\.(wav|mp3|ogg|m4a|aac|flac)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** 从 URL / 路径里取出文件名（带 %20 的会被解码；文件名里的 `#` 是合法字符，只有真 URL 才当片段标记） */
function fileNameOf(path) {
  let clean = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) clean = clean.split(/[?#]/)[0]; // http(s)/blob/data：去掉 query 与 hash
  const base = clean.split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

const url = (p) => p.split('/').map(encodeURIComponent).join('/');

export async function createPreview(dom) {
  const { canvas, emptyEl, infoEl, timeEl, fpsEl, onDocumentLoaded } = dom;
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
  // 音频/曲绘的**原始来源**（导出 zip 时要把它们原样打进包里）：
  //   { blob, name }  —— 来自谱面包/项目附带的文件，直接有内容
  //   { url, name }   —— 来自示例包的 URL，导出时再 fetch 一次
  let mediaSources = { song: null, background: null };
  // 本次载入的谱面包/项目包里的**全部文件**（保存项目时连自定义贴图、打击音一起打包）
  let packageFiles = null;

  /**
   * 解析谱面并**按权威顺序套用元数据**：info.txt > info.csv > 谱面 JSON 元数据 > 包名。
   * @param {object} json 原始谱面 JSON
   * @param {{file?:string, packageName?:string, infoTxt?:object, infoCsv?:object, chartMeta?:object}} opts
   */
  function build(json, { file, packageName, infoTxt, infoCsv, chartMeta } = {}) {
    const diagnostics = new Diagnostics();
    const format = detectFormat(json);
    // 项目文件（内部格式）的元数据在 chart.meta 里，而不是 RPE 的 META
    const inlineMeta = format === 'project' ? json?.chart?.meta : json?.META;
    const resolved = resolveMeta({
      infoTxt,
      infoCsv,
      chartMeta: chartMeta ?? inlineMeta,
      packageName: packageName ?? file,
    });
    const options = { file, meta: resolved.meta, diagnostics };
    const model =
      format === 'rpe'
        ? parseRpeChart(json, options)
        : format === 'official'
          ? parseOfficialChart(json, options)
          : format === 'project'
            ? parseProject(json, options)
            : null;
    if (!model) throw new Error('无法识别的谱面格式（缺少 judgeLineList，也不是本编辑器的项目文件）');
    applyMetaToChart(model, resolved);
    const prepared = prepareChart(model, { diagnostics });
    prepared.diagnostics = { summary: diagnostics.summary, messages: diagnostics.messages };
    return prepared;
  }

  /** 格式标签（项目文件用的是它原本的源格式；无法判断时写「项目」） */
  function formatLabel(model = chart) {
    if (!model) return '';
    if (model.source?.projectVersion !== undefined || model.format === 'project') {
      const src = model.source?.sourceFormat;
      return `项目文件${src === 'rpe' ? '（源：RPE）' : src === 'official' ? '（源：官方）' : ''}`;
    }
    return model.format === 'rpe' ? `RPE v${model.source?.rpeVersion}` : `official v${model.source?.formatVersion}`;
  }

  function apply(chartModel, label, opts = {}) {
    chart = chartModel;
    fromPackage = !!opts.fromPackage;
    // 换谱面先清掉上一个包的音频与曲绘，避免残留（也让「缺媒体」提示如实反映）
    backgroundSource = null;
    audioSource = null;
    backgroundImage = null;
    mediaSources = { song: null, background: null };
    packageFiles = null;
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
        formatLabel(chart),
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
    onDocumentLoaded?.(chartModel); // 换文档：自动保存据此清「未保存」状态
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
          mediaSources.song = { url: src, name: fileNameOf(src) };
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
        mediaSources.background = { url: src, name: fileNameOf(src) };
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

  /**
   * 载入谱面 JSON（官方 / RPE / **本编辑器的项目文件**都走这里）。
   * @param {object} json
   * @param {string} label
   * @param {(File|{name:string, blob:Blob})[]} [files] 可选的附带文件
   *        （项目文件没有内嵌媒体；草稿恢复给的是 `{name, blob}`，文件选择给的是 File）
   */
  async function loadJson(json, label, files = null) {
    // 纯 JSON：谱面里没有音频与曲绘，界面上会提示改用「谱面包」
    const prepared = apply(build(json, { file: label, packageName: label }), label, { fromPackage: !!(files && files.length) });
    if (files?.length) {
      // 一起选中的文件既用来挂媒体，也当作「包内资源」留着（保存项目时一起打包）
      const entries = [...files].map((f) => ({ name: f.webkitRelativePath || f.name || '', blob: f.blob ?? f }));
      packageFiles = new Map(entries.map((e) => [e.name, { blob: e.blob, size: e.blob.size ?? 0 }]));
      await attachMedia(entries, prepared.meta);
    }
    return prepared;
  }

  /**
   * 从一组 `{name, blob}` 里按 `meta.song` / `meta.background` 的文件名认出音频与曲绘并挂上。
   * 认不出名字时退回「第一个音频 / 第一张图片」。
   * @returns {Promise<{song:boolean, background:boolean}>}
   */
  async function attachMedia(entries, meta = {}) {
    const base = (p) => String(p ?? '').split(/[\\/]/).pop().toLowerCase();
    const pick = (field, re) => {
      const target = base(meta[field]);
      return (target ? entries.find((e) => base(e.name) === target) : null) ?? entries.find((e) => re.test(e.name)) ?? null;
    };
    const song = pick('song', AUDIO_EXT_RE);
    if (song?.blob) {
      try {
        await playback.loadAudio(URL.createObjectURL(song.blob));
        audioSource = fileNameOf(song.name);
        mediaSources.song = { blob: song.blob, name: song.name };
        applyAudioSwitch();
      } catch {
        /* 音频坏了也不影响谱面载入 */
      }
    }
    const picture = pick('background', IMAGE_EXT_RE);
    if (picture?.blob) {
      const img = await blobToImage(picture.blob);
      if (img) {
        backgroundImage = img;
        backgroundSource = fileNameOf(picture.name);
        mediaSources.background = { blob: picture.blob, name: picture.name };
        applyBgSwitch();
      }
    }
    return { song: !!song, background: !!picture };
  }

  /** 把包里的媒体与全部资源记下来：导出 zip / 保存项目时要原样写回 */
  function rememberPackageMedia(pkg) {
    packageFiles = pkg.files ?? null;
    const blobOf = (path) => (path ? pkg.files?.get(path)?.blob ?? null : null);
    if (pkg.songPath) mediaSources.song = { blob: blobOf(pkg.songPath), name: fileNameOf(pkg.songPath) };
    if (pkg.backgroundPath) mediaSources.background = { blob: blobOf(pkg.backgroundPath), name: fileNameOf(pkg.backgroundPath) };
  }

  /** 把文件登记为包内资源：保存项目与导出 zip 时会一起打包 */
  function rememberResource(name, blob) {
    if (!name || !blob) return;
    packageFiles ??= new Map();
    packageFiles.set(name, { blob, size: blob.size ?? 0 });
  }

  /**
   * 手动编辑元数据（「谱面总览」页用）：写入模型并标注来源。
   * offset 会影响播放同步，这里一并应用。
   */
  function setMetaField(field, value) {
    if (!chart || !field) return false;
    chart.meta[field] = value;
    chart.metaSources ??= {};
    chart.metaSources[field] = '手动编辑';
    if (field === 'offset') playback.player.offset = Number(value) || 0;
    return true;
  }

  /** 更换或补充音频：解码后立即生效，并写回 `meta.song` 与包内资源 */
  async function setAudioFile(file) {
    if (!file) return false;
    const url = URL.createObjectURL(file);
    try {
      await playback.loadAudio(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error(`音频无法解码（${err?.message ?? err}）`);
    }
    audioSource = file.name;
    mediaSources.song = { blob: file, name: file.name };
    rememberResource(file.name, file);
    setMetaField('song', file.name);
    applyAudioSwitch();
    return true;
  }

  /** 更换或补充背景图：加载后立即生效，并写回 `meta.background` 与包内资源 */
  async function setBackgroundFile(file) {
    if (!file) return false;
    const img = await blobToImage(file);
    if (!img) throw new Error('图片无法解码');
    backgroundImage = img;
    backgroundSource = file.name;
    mediaSources.background = { blob: file, name: file.name };
    rememberResource(file.name, file);
    setMetaField('background', file.name);
    applyBgSwitch();
    return true;
  }

  /** 载入谱面包对象（zip / 目录共用的一条通路） */
  async function ingestPackage(pkgLike) {
    const pkg = await pkgLike; // 防御：调用方漏 await 时也不至于把 Promise 当包对象用
    const prepared = apply(
      build(pkg.chartJson, { file: pkg.chartPath, packageName: pkg.name, infoTxt: pkg.info, infoCsv: pkg.infoCsv }),
      pkg.name,
      { fromPackage: true },
    );
    rememberPackageMedia(pkg);
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

  /** 载入内部项目 zip（`.pce.zip`）：项目 JSON + 包内资源 */
  async function ingestProjectZip(files, project, name) {
    const prepared = apply(build(project.json, { file: project.path, packageName: name }), name, { fromPackage: true });
    packageFiles = files;
    await attachMedia(
      [...files].map(([path, entry]) => ({ name: path, blob: entry.blob })),
      prepared.meta,
    );
    return prepared;
  }

  /**
   * 导出用的媒体内容：`{ song: {name, blob}|null, background: {name, blob}|null }`。
   * 谱面包里的文件直接用包内的 blob；示例包（URL）在导出时重新取一次。
   */
  async function media() {
    const resolve = async (slot) => {
      if (!slot) return null;
      if (slot.blob) return { name: slot.name, blob: slot.blob };
      if (!slot.url || typeof fetch !== 'function') return null;
      try {
        const res = await fetch(slot.url);
        if (!res || res.ok === false) return null;
        const blob = await res.blob();
        return blob && blob.size ? { name: slot.name, blob } : null;
      } catch {
        return null;
      }
    };
    return { song: await resolve(mediaSources.song), background: await resolve(mediaSources.background) };
  }

  /**
   * 保存项目时要一起打包的**全部资源文件**：本次载入的谱面包里除谱面 JSON 与 info.* 以外的文件
   * （音频、曲绘、自定义判定线贴图、GIF、打击音…）。示例包（fetch 来的）没有包文件表，
   * 退回音频/曲绘两份。
   * @returns {Promise<{name:string, blob:Blob}[]>}
   */
  async function resources() {
    const out = [];
    const seen = new Set();
    const push = (name, blob) => {
      if (!blob || seen.has(name)) return;
      seen.add(name);
      out.push({ name, blob });
    };
    for (const [path, entry] of packageFiles ?? []) {
      if (/\.json$/i.test(path) || /^info\.(txt|csv)$/i.test(path)) continue;
      push(path, entry.blob);
    }
    const m = await media();
    for (const item of [m.song, m.background]) if (item) push(item.name, item.blob);
    return out;
  }

  async function loadZip(file) {
    const files = await unzipToFiles(await file.arrayBuffer());
    const project = await findProjectFile(files); // 项目 zip（.pce.zip）优先
    if (project) return ingestProjectZip(files, project, file.name);
    // 注意：buildPackage 是 async —— 忘了 await 会把 Promise 传进去，
    // 结果 pkg.chartJson 为 undefined，所有 zip 都会报「无法识别的谱面格式」。
    return ingestPackage(await buildPackage(file.name, files));
  }

  async function loadFiles(fileList) {
    return ingestPackage(await loadFilePackage(fileList));
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
    // 每一帧都渲染（跟随显示器刷新率，高刷屏上不再人为限帧）；
    // 只有页面不可见时才跳过 —— 这时候渲染没有意义。
    if (globalThis.document?.hidden) {
      lastFrame = now;
      return;
    }
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
    /** 载入内部项目文件（反序列化）：json 是 .pce.json 的内容，files 可选（音频/曲绘一起选中） */
    loadProject: (json, label, files) => loadJson(json, label, files),
    loadZip,
    loadFiles,
    resize,
    /** 导出用的媒体内容（谱面包里的音频/曲绘） */
    media,
    /** 保存项目时要一起打包的全部资源文件（音频/曲绘/贴图/打击音…） */
    resources,
    /** 元数据编辑（谱面总览页）：写字段、更换音频、更换背景图 */
    setMetaField,
    setAudioFile,
    setBackgroundFile,
    /** 当前谱面的格式标签（含「项目文件」） */
    formatLabel,
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
    /** 谱面音符的时间被改过（拖动写回 / 面板编辑）后，重新定位判定游标 */
    resyncJudging() {
      if (state) resyncJudgeCursor(state);
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
      if (!fromPackage) return `缺${miss.join('与')}：请用谱面包（文件夹或 zip）载入。`;
      return `包内未找到${miss.join('与')}。`;
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
  };
}

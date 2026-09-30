/**
 * 音频波形（声纹）的降采样：把 `AudioBuffer` 压成绘制用的「峰值对」，供时间轴的音乐轨使用。
 *
 * 为什么单独一个模块：整段音频可能有上千万个采样点，而一屏最多几千像素 ——
 * 直接把采样点交给绘制等于每帧扫全曲。这里一次性把「每秒 N 个桶」的最小/最大值算好并缓存，
 * 之后滚动与缩放只是按拍区间取一小段桶，开销与音频长度无关。
 *
 * **DOM-free、无第三方依赖**：只吃 `AudioBuffer` 的形状（`numberOfChannels` / `length` /
 * `sampleRate` / `getChannelData`），因此测试里传一个普通对象也能跑。
 */

/** 默认每秒多少个桶（2 个桶 ≈ 1 像素时也够细；一屏 1000px 覆盖 500 拍以上才需要更细） */
export const DEFAULT_BUCKETS_PER_SECOND = 200;

/** 桶总数上限：超长音频自动下调 bucketsPerSecond，避免内存失控（4e6 桶 ≈ 16 MB Float32） */
export const MAX_BUCKETS = 4e6;

/** 算好的包络（`min` / `max` 交替存放，长度 = buckets × 2） */
const cache = new WeakMap();

/**
 * 把音频压成峰值包络。
 *
 * 取所有声道**绝对值的最大值**作为该桶的 `max`（不看相位：多声道相消时用最大值最接近听觉上的响度），
 * `min` 为负的同样最大值，于是绘制时以 0 为中线上下对称，读起来像常规声纹。
 *
 * @param {{numberOfChannels:number, length:number, sampleRate:number, getChannelData:(i:number)=>Float32Array}} audioBuffer
 * @param {{bucketsPerSecond?:number}} [opts]
 * @returns {{bucketsPerSecond:number, buckets:number, duration:number, peaks:Float32Array}|null}
 */
export function computePeaks(audioBuffer, { bucketsPerSecond = DEFAULT_BUCKETS_PER_SECOND } = {}) {
  if (!audioBuffer) return null;
  const cached = cache.get(audioBuffer);
  if (cached && cached.bucketsPerSecond === bucketsPerSecond) return cached;

  const duration = Number(audioBuffer.duration);
  const sampleRate = Number(audioBuffer.sampleRate);
  const length = Number(audioBuffer.length);
  const channels = Number(audioBuffer.numberOfChannels) || 0;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !(length > 0) || !channels) {
    return null;
  }

  // 桶数封顶：超长音频按比例下调（保持「整段一致」，不要在末尾截断）
  const wanted = Math.max(1, Math.ceil(duration * bucketsPerSecond));
  const buckets = Math.min(wanted, MAX_BUCKETS);
  const perBucket = Math.max(1, Math.floor(length / buckets));
  const peaks = new Float32Array(buckets * 2);

  // 逐声道累加「绝对值最大」：多声道取最大，比求平均更接近听感（相消时不会凭空变小）
  const data = [];
  for (let c = 0; c < channels; c++) {
    const d = typeof audioBuffer.getChannelData === 'function' ? audioBuffer.getChannelData(c) : null;
    if (d && d.length) data.push(d);
  }
  if (!data.length) return null;

  for (let b = 0; b < buckets; b++) {
    const from = b * perBucket;
    const to = b === buckets - 1 ? length : Math.min(length, from + perBucket);
    let peak = 0;
    for (let i = from; i < to; i++) {
      for (const d of data) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) peak = v;
      }
    }
    if (peak > 1) peak = 1; // 削顶的素材按 1 画，不把行画爆
    peaks[b * 2] = -peak;
    peaks[b * 2 + 1] = peak;
  }

  const out = { bucketsPerSecond: (buckets / duration) || bucketsPerSecond, buckets, duration, peaks };
  cache.set(audioBuffer, out);
  return out;
}

/** 某个时间（秒）落在第几个桶 */
const bucketAt = (peaks, t) => Math.floor(t * peaks.bucketsPerSecond);

/**
 * 取 [t0, t1) 这段音乐时间对应的峰值（秒越界会被夹到有效范围）。
 *
 * 返回的数组是 **`[min0, max0, min1, max1, …]`**，长度 = `2 × 桶数`；
 * 区间完全在音频之外（或宽度为 0）时返回空数组。
 *
 * 不做重采样：调用方按像素取用它 —— 每个像素覆盖的秒数通常远大于一个桶，
 * 直接把这一段的桶画成折线就足够精确，且比先降采样再画更省。
 *
 * @param {{bucketsPerSecond:number, buckets:number, duration:number, peaks:Float32Array}} info
 * @param {number} t0 音乐秒（含）
 * @param {number} t1 音乐秒（不含）
 */
export function peaksForRange(info, t0, t1) {
  if (!info?.peaks || !(info.buckets > 0)) return EMPTY;
  const from = Math.max(0, Math.min(info.buckets, bucketAt(info, Math.min(t0, t1))));
  const to = Math.max(0, Math.min(info.buckets, bucketAt(info, Math.max(t0, t1))));
  if (!(to > from)) return EMPTY;
  return info.peaks.subarray(from * 2, to * 2);
}

const EMPTY = new Float32Array(0);

/** 这段音乐时间在波形里的平均响度（0..1）：画 RMS 线用。空区间返回 0 */
export function rmsForRange(info, t0, t1) {
  const seg = peaksForRange(info, t0, t1);
  if (!seg.length) return 0;
  let sum = 0;
  for (let i = 1; i < seg.length; i += 2) sum += seg[i];
  return sum / (seg.length / 2);
}

/** 清掉缓存（测试用：同一对象要重算时） */
export function clearPeaksCache(audioBuffer) {
  if (audioBuffer) cache.delete(audioBuffer);
}

/**
 * 求一段峰值的**纵向映射**：把这段音频自己的响度范围铺满行高，让起伏看得出来。
 *
 * 为什么不能只除以一个常数：很多音频整段都接近满幅（母带压得很响，动态只有 0.81~1.0）。
 * 实测这类素材无论除以中位数（0.84）还是高分位数（1.0），除完都齐刷刷贴到行顶 ——
 * 整行实心色块，鼓点之间的差别全没了，正是要修的那个问题。
 *
 * 办法是把 `[floor, ceil]` 线性映射到 `[0, 1]`：
 *  - `floor`：低分位（默认 2%），代表「这一段最安静的地方」；取低分位而非最小值，
 *    免得一个孤立的静音桶把整段抬起来。再与中位数取一个比例下限，避免把底噪放大；
 *  - `ceil`：高分位（默认 98%），高于它的少数尖峰被 `clamp` 到行边缘（允许削峰）；
 *  - `floor` 恰好等于 `ceil`（整段完全恒定，例如纯静音）时退化为不缩放。
 *
 * 返回的是 `{ floor, ceil }`，绘制端用 `(v - floor) / (ceil - floor)` 取值。
 *
 * @param {Float32Array} seg `[min,max,…]`（来自 peaksForRange）
 * @param {{lowQuantile?:number, highQuantile?:number, minSpan?:number}} [opts]
 * @returns {{floor:number, ceil:number}}
 */
export function normalizeRange(seg, { lowQuantile = 0.02, highQuantile = 0.98, minSpan = 0.02 } = {}) {
  const none = { floor: 0, ceil: 1 };
  if (!seg?.length) return none;
  const bins = new Uint32Array(256);
  let count = 0;
  for (let i = 1; i < seg.length; i += 2) {
    const v = seg[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    count++;
    bins[Math.min(255, Math.floor(v * 255))]++;
  }
  if (!count) return none; // 全静音：保持平线，不放大底噪
  /** 分位数（直方图近似，O(256) 查表） */
  const quantile = (qq) => {
    const target = Math.max(1, Math.ceil(count * qq));
    let seen = 0;
    for (let b = 0; b < 256; b++) {
      seen += bins[b];
      if (seen >= target) return (b + 1) / 256;
    }
    return 1;
  };
  // 先按素材**真实**的高低分位判断「有没有动态」：跨度太小（恒定电平）就不缩放，
  // 否则下面的 minSpan 兜底会把 0.005 的恒定电平抬成 0.02，反而被当成有动态而放大。
  const rawCeil = quantile(highQuantile);
  const rawFloor = quantile(lowQuantile);
  if (!(rawCeil - rawFloor > minSpan * 0.5)) return none; // 整段恒定（纯静音 / 纯满幅 / 纯底噪）

  const ceil = Math.max(rawCeil, minSpan);
  /**
   * 地板 = 低分位（这一段最安静的地方）。
   *
   * **不要**再拿「中位数的一半」之类的比例去压它：实测「顶满型」素材的低分位就是它真实的弱拍电平
   * （0.815），压到 0.4 会让弱拍被抬高到行中部、反而更糊。
   */
  const floor = Math.max(0, Math.min(rawFloor, ceil - minSpan));
  return { floor, ceil };
}

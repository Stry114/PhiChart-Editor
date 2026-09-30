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

/**
 * 示例谱面包的位置与「缺包就跳过」的约定。
 *
 * 背景：`packages/` 里的是第三方谱面包（合计 120+ MB），**不属于本项目自有资源**，
 * 已从版本库移除（`.gitignore` 也挡着）。克隆下来的仓库默认没有它们，
 * 依赖示例包的测试与工具必须优雅跳过，而不是崩在 ENOENT 上。
 *
 * 想跑这些用例：把谱面包放进 `packages/`（目录名与下面一致）即可。
 */
import fs from 'node:fs';

export const SAMPLES = {
  official: {
    label: '白复生 AT（official）',
    dir: 'packages/白复生 AT（official格式）',
    chart: 'Chart_AT #3649.json',
  },
  rpe: {
    label: '领土战争 AT（RPE）',
    dir: 'packages/领土战争AT（RPE格式）',
    chart: '29519800.json',
  },
};

/** 谱面包里某个文件的相对路径（相对仓库根） */
export function samplePath(key, file) {
  const s = SAMPLES[key];
  if (!s) return null;
  return `${s.dir}/${file ?? s.chart}`;
}

/** 仓库里现在有没有这个谱面包（看谱面文件在不在） */
export function hasSample(key) {
  const p = samplePath(key);
  return !!p && fs.existsSync(p);
}

/** 打印一行统一的「跳过」说明（不算失败） */
export function skipSample(label) {
  console.log(`  - 跳过「${label}」：仓库里没有第三方谱面包（放进 packages/ 后即可运行）`);
}

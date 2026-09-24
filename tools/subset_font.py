"""把 assets/phigros.ttf（8.8 MB，3 万字形的中日文字体）裁剪成渲染器真正用得到的子集。

为什么要裁：
    渲染器页面的 HUD 只显示数字 / 拉丁字母 / 少量符号，暂停页的中文是固定的界面文案；
    整份字体的 7.66 MB `glyf` 里绝大多数是渲染器用不到的字形。裁完之后文件从 8.8 MB
    降到几百 KB，首次进入页面的下载时间随之降一个数量级。

收录范围：
    1. `player.html` 与 `src/app/*.js` 里出现的**所有字符**（界面文案、按钮文字、提示、告警标题）；
    2. ASCII / Latin-1 符号、常用标点（…—·「」：｜／（））、箭头、几何与杂项符号（▶ ⏸ ⚠ ✓ 等）；
    3. CJK 标点与全角形式（U+3000–U+303F、U+FF00–U+FFEF）。
**不收录**汉字与假名：它们占字体体积的绝大部分，而谱面标题/告警里的汉字数量无法预估 ——
    缺字形时浏览器会回退到字体栈后面的系统字体（见 styles.css 的 --font），仍然能正常显示。

用法：
    python tools/subset_font.py                  # 就地生成 assets/phigros.ttf（覆盖为子集）
    python tools/subset_font.py --source full.ttf --out phigros.ttf
"""
from __future__ import annotations

import argparse
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SOURCE = os.path.join(ROOT, 'assets', 'phigros.ttf')

# 界面用到的字符来源：HTML 与渲染器脚本（直接整文件扫字符，够用且不会漏）
TEXT_SOURCES = [
    'player.html',
    'src/app/main.js',
    'src/app/player.js',
    'src/app/touch-input.js',
    'src/ui/icons.js',
]

# 额外兜底的符号（界面可能动态拼出来的：时间、倍速、难度、状态标记等）
EXTRA = (
    '0123456789'
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
    '\u00a0\u00ab\u00bb\u00b0\u00b1\u00b7\u00d7\u00f7'
    '\u2010\u2011\u2012\u2013\u2014\u2015\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2022\u2026\u2030'
    '\u2039\u203a\u2044\u20ac\u2122'
    '\u2190\u2191\u2192\u2193\u2194\u2195\u21ba\u21bb'
    '\u2212\u2213\u221a\u221e\u2248\u2260\u2264\u2265'
    '\u23ee\u23f8\u23f9\u25a0\u25a1\u25b2\u25b6\u25bc\u25c0\u25cb\u25cf\u2605\u2606\u2713\u2714\u26a0'
    '\u3000\u3001\u3002\u3008\u3009\u300a\u300b\u300c\u300d\u300e\u300f\u3010\u3011\u3014\u3015\u301c\u30fb'
    '\uff01\uff08\uff09\uff0c\uff0e\uff0f\uff1a\uff1b\uff1f\uff5c\uff5e'
)

# 需要保留的连续区段（ASCII / Latin-1 常用符号）
UNICODE_RANGES = ['U+0020-007E', 'U+00A0-00FF']


def collect_text() -> str:
    chars: set[str] = set(EXTRA)
    for rel in TEXT_SOURCES:
        path = os.path.join(ROOT, rel)
        try:
            with open(path, encoding='utf-8') as fh:
                text = fh.read()
        except OSError as err:  # 文件不在就跳过，不阻塞
            print(f'  · 跳过 {rel}：{err}')
            continue
        # 行尾空白等控制字符不需要字形
        chars.update(c for c in text if c >= ' ' and c != '\u007f' and ord(c) != 0)
    return ''.join(sorted(chars))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default=DEFAULT_SOURCE, help='完整字体（默认 assets/phigros.ttf）')
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'phigros.ttf'), help='输出路径')
    ap.add_argument('--text-file', default=os.path.join(ROOT, 'tools', 'out', 'font-chars.txt'))
    args = ap.parse_args()

    from fontTools import subset  # 延迟导入：缺 fontTools 时给出可读提示

    text = collect_text()
    os.makedirs(os.path.dirname(args.text_file), exist_ok=True)
    with open(args.text_file, 'w', encoding='utf-8') as fh:
        fh.write(text)
    before = os.path.getsize(args.source)
    print(f'字符集 {len(text)} 个（写入 {os.path.relpath(args.text_file, ROOT)}），源字体 {before/1048576:.2f} MB')

    options = subset.Options()
    options.layout_features = ['*']       # 保留 GPOS/GSUB（很小，且影响字形替换）
    options.hinting = True                # 保留 hinting（仅几百字节）
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ['BASE']       # 基线表：渲染器用不到
    font = subset.load_font(args.source, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text, unicodes=[])
    subsetter.subset(font)

    tmp = args.out + '.tmp'
    subset.save_font(font, tmp, options)
    after = os.path.getsize(tmp)
    print(f'子集 {after/1024:.0f} KB（缩小到 {after / before * 100:.1f}%）')
    if os.path.abspath(args.out) == os.path.abspath(args.source):
        print('提示：源字体就是目标文件，覆盖前先把原始文件另存一份再用 --source 指定')
    os.replace(tmp, args.out)
    print(f'已写出 {os.path.relpath(args.out, ROOT)}')

    # 校验：所有字符都能映射到字形（控制台可能是 GBK，缺字形用 \uXXXX 转义打印，避免 UnicodeEncodeError）
    from fontTools.ttLib import TTFont

    check = TTFont(args.out)
    cmap = check.getBestCmap()
    missing = [c for c in text if ord(c) not in cmap and not c.isspace()]
    names = ''.join(c if ord(c) < 0x80 else f'\\u{ord(c):04X}' for c in missing[:60])
    print(f'缺字形 {len(missing)} 个' + (f'：{names}' if missing else '（全部覆盖）'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

# 02 · RPE（Re:PhiEdit）谱面格式规格

> 来源：Lchzh Docs《Re:PhiEdit 谱面格式说明》（<https://docs.lchzh.top/learning/phiediter/>）、Phira Documents《RPE 格式》章节（<https://teamflos.github.io/phira-docs/chart-standard/chart-format/rpe/note.html>）、Phira 的 RPE 解析实现（`prpr/src/parse/rpe.rs`），并用本仓库 `packages/领土战争AT（RPE格式）`（RPEVersion 140）实测校验。
>
> **版本标记**：参考文档用「`A-B+`」「`81+`」「`81-`」这类写法表示支持范围；其自述含义为「`-` 表示该版本及以前不支持，`+` 表示该版本及以后支持」。本文沿用原文档的标记，遇到含义不明处直接标注，不擅自解释。

---

## 1. 时间：Beat

```
Beat = [int, int, int]
拍值 = Beat[0] + Beat[1] / Beat[2]        （RPE 界面显示为 [0]:[1]/[2]）
秒   = 拍值 × 60 / BPM
```

`[文档][实测]`：`[6,1,4]` = 6.25 拍；`[-4,7,8]` = −3.125 拍（**允许负时间**）；`[115,1,32]` = 115.03125 拍。`[实测]` 本样本共出现 32 种分母（都是 2 的幂，最大 1/32），即制谱精度到 1/32 拍，但格式本身不限制分母。

多 BPM 时按 `BPMList` 分段换算 `[文档]`：

```python
# bpmfactor 为判定线的 bpmfactor 字段
def sec2beat(t, bpmfactor):
    beat = 0.0
    for i, e in enumerate(BPMList):
        bpmv = e.bpm / bpmfactor                  # 注意：线 BPM = 全局 BPM / bpmfactor
        if i != len(BPMList) - 1:
            et_beat = BPMList[i+1].startTime - e.startTime
            et_sec  = et_beat * 60 / bpmv
            if t >= et_sec: beat += et_beat; t -= et_sec
            else:           beat += t / (60 / bpmv); break
        else:
            beat += t / (60 / bpmv)
    return beat
```

（`beat2sec` 为其逆运算，官方文档给出等价实现。）

**哨兵值** `[实测]`：本样本用 `[31250000,0,1]`（3125 万拍）作为「无限远」的 `endTime`，与官方格式的 `1000000000` 哨兵异曲同工。

---

## 2. 根结构 root

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `META` | object | 谱面信息（见下）。 |
| `BPMList` | Array&lt;BPMEvent&gt; | `{startTime: Beat, bpm: float}`。 |
| `judgeLineList` | Array&lt;JudgeLine&gt; | 判定线列表。 |
| `judgeLineGroup` | Array&lt;string&gt; | 判定线分组名（供 RPE 标记，读取时可忽略）。 |
| `multiLineString` | string | RPE 多线编辑用（空格分隔的线号，`1:20` 表示范围，`all` 表示全部）。读取时可忽略。 |
| `multiScale` | float | RPE 多线编辑缩放。读取时可忽略。 |
| `chartTime` | double | 谱面编辑时长，单位**秒**（RPE 141+；模拟器不需要）。 |
| `timeTags` | Array | 时间标记 `{name, time: Beat}`（RPE 130+）。 |
| `xybind` | bool | 是否启用 XY 绑定（启用时每个 XEvent 必有等长的 YEvent）。 |

`[实测]` 本样本根字段：`BPMList`、`META`、`judgeLineGroup`、`judgeLineList`、`multiLineString`、`multiScale`。

### 2.1 META

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `RPEVersion` | int | RPE 版本，如 `140` = v1.4.0、`113` = v1.1.3。缺省按 160 处理 `[文档]`（Phira 实现）。允许是字符串 `[文档]`。 |
| `offset` | int | 谱面偏移，单位**毫秒**（注意与官方格式的「秒」不同）。 |
| `name` | string | 曲名/谱面名。 |
| `id` | string | 唯一标识（RPE 自动生成时是 long，实际可为任意字符串）。 |
| `song` | string | 音乐文件（相对谱面根目录路径）。 |
| `background` | string | 背景文件路径。 |
| `composer` | string | 曲师。 |
| `charter` | string | 谱师。 |
| `level` | string | 难度等级（如 `AT Lv.15`）。 |
| `illustration` | string | 曲绘画师（RPE 141+）。 |

偏移语义 `[文档]`：负数表示音乐在谱面开始前 `|offset|` 毫秒播放，正数表示音乐在谱面开始后 `offset` 毫秒播放。

`[实测]` 样本 META：`{RPEVersion: 140, background: "29519800.png", charter: "JKy feat. 0419_Guardian", composer: "ツユ", id: "29519800", level: "AT Lv.15", name: "テリトリーバトル", offset: 0, song: "29519800.wav"}`。

---

## 3. 判定线 JudgeLine

| 字段 | 类型 | 默认值 | 版本 | 说明 |
| --- | --- | --- | --- | --- |
| `Group` | int | 0 | 81-99+ | 所属组（索引/标记，读取可忽略）。 |
| `Name` | string | Untitled | 81-99+ | 判定线名称（仅制谱器使用）。 |
| `Texture` | string | `line.png` | 81+ | 判定线纹理；非默认值时为相对谱面根目录的路径。`line.png` 是内置默认线材质，**不需要包内存在该文件**。 |
| `anchor` | float[2] | [0.5, 0.5] | 142+ | 纹理锚点（每像素对应一个 RPE 坐标单位，忽略宽高比）。 |
| `eventLayers` | Array&lt;EventLayer&gt; | — | 81+ | 事件层，最多 5 层。可能为 `null`、可能缺省；层内某类事件不存在时该字段不出现；所有层都空时字段不出现（143 版本起为空则无字段）。 |
| `extended` | object | — | 81+ 可选 | 扩展（故事板）事件层，见 §6。 |
| `father` | int | −1 | — | 父线索引（−1 = 无父线）。父线允许嵌套；子线坐标叠加父线，是否继承旋转取决于 `rotateWithFather`。 |
| `rotateWithFather` | bool | true | 163+ | 子线是否继承父线旋转；字段缺省时应视为 `false`（兼容 163 以前）。 |
| `isCover` | int | 1 | 81+ | 遮罩：为 1 时，位于判定线**背面**的音符（`above != 1` 视为正面）不渲染；其他值不遮罩。 |
| `notes` | Array&lt;Note&gt; | — | 81+ | 音符列表（可为空或字段缺省）。 |
| `numOfNotes` | int | 0 | 81+ | 音符数量。`[文档]` 定义为「包含 FakeNote，**不包含 Hold**」；`[实测]` 样本 1417 个 note、`numOfNotes` 之和 1252，差值 165 恰为 Hold（type 2）数量，**与文档定义吻合**。 |
| `zOrder` | int | 0 | 100-105+ | 线 z 轴/图层，范围约 ±100（原文标注「范围需要验证」）。 |
| `bpmfactor` | float | 1.0 | — | BPM 因子（RPE 界面不可编辑）。**线当前 BPM = 全局 BPM / bpmfactor**。 |
| `posControl` | Array&lt;CtrlEvent&gt; | — | 105-113+ | 见 §7。 |
| `sizeControl` | Array&lt;CtrlEvent&gt; | — | 105-113+ | 见 §7。 |
| `skewControl` | Array&lt;CtrlEvent&gt; | — | 105-113+ | 见 §7。 |
| `yControl` | Array&lt;CtrlEvent&gt; | — | 105-113+ | 见 §7。 |
| `alphaControl` | Array&lt;CtrlEvent&gt; | — | 105-113+ | 见 §7。 |
| `isGif` | bool | false | 150+ | 纹理是否为 GIF。 |
| `attachUI` | string? | — | 150+? | UI 绑定（Phira 特有扩展，见 `docs/04`）。 |

`[实测]` 样本 24 条线的字段集合：`Group`、`Name`、`Texture`、`alphaControl`、`bpmfactor`、`eventLayers`、`extended`、`father`、`isCover`、`notes`(18/24 条有)、`numOfNotes`、`posControl`、`sizeControl`、`skewControl`、`yControl`、`zOrder`；取值 `father = -1`、`isCover = 1`、`Group = 0`、`zOrder = 0`、`Texture = "line.png"`、`bpmfactor = 1.0`。

### 3.1 坐标与单位 `[文档][实测]`

- 坐标锚点在**屏幕中心**；x 范围 −675 – 675，y 范围 −450 – 450。
- 即：**1 x 单位 = 屏宽 / 1350，1 y 单位 = 屏高 / 900**。
- Phira 的换算（`prpr/src/parse/rpe.rs`）：`RPE_WIDTH = 1350`、`RPE_HEIGHT = 900`；`moveX × 2/1350`、`moveY × 2/900`、`positionX / 675` 换算到 prpr 画布（画布宽度 = 2）。
- 旋转：**顺时针为正**（Phira 转换时乘 `-1` 以适配逆时针为正的内部约定）。
- `alpha` 事件正常范围 0–255（0 全透明、255 不透明）。**alpha 事件为负数时，会连该判定线上的所有 note 一起隐藏**（作者称这是废弃的非法功能，但仍然有效）。`[文档]`

---

## 4. 事件层 EventLayer 与事件 LineEvent

五种普通事件：`alphaEvents`、`moveXEvents`、`moveYEvents`、`rotateEvents`、`speedEvents`。`[文档]`

**多层叠加 = 相加**：`[文档]` Phira 实现把各层链成「和」——`a1(t) = a1.关键帧(t) + a2(t)`（`prpr/src/core/anim.rs` 的 `Anim::chain`，注释原文：`a1.next = a2` 时 `a1(t) = a1.keyframes(t) + a2(t)`）。因此 `[未验证]` 未覆盖的时间段里，该层取「该层事件默认值」（move/rotate 为 0；Phira 中「无该事件的层」贡献 0），所以实践上每条线都需要至少一条覆盖全时间轴的 alpha 事件（本样本的 alpha 事件从 −3.125 拍开始、`endTime` 为哨兵）。

### 4.1 除速度事件外的 LineEvent 字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `startTime` / `endTime` | Beat | — | 事件起止时间。 |
| `start` / `end` | float \| string \| int[3] | — | 起止值。类型随事件而定（颜色事件为 `int[3]`，文本事件为 string）。 |
| `easingType` | int | 1 | 缓动类型编号，见 §5。 |
| `easingLeft` / `easingRight` | float | 0.0 / 1.0 | 缓动裁剪区间（只取缓动曲线的一部分）。 |
| `bezier` | int | 0 | 是否使用自定义贝塞尔缓动（0/1）。RPE 123+。 |
| `bezierPoints` | float[4] | [0,0,0,0] | 贝塞尔控制点（等价 `cubic-bezier(p1,p2,p3,p4)`）。RPE 123+。 |
| `linkgroup` | int | — | RPE 标记用，**对谱面读取没有影响**（不要把 `linkgroup` 当作「链接上一事件末值」的机制）。 |

**取值的两种格式**（Phira 实现，兼容官方约定）`[文档]`：`start`/`end` 可以是
① 数值 → 用缓动函数在 `[startTime, endTime]` 内插值；
② 字符串 → 直接返回该字符串（文本事件）；
③ `int[3]` → 分别对 R/G/B 三个通道插值。

插值实现（Phira 版本）：

```python
def easing_interpolation(t, st, et, sv, ev, f):
    if t == st: return sv
    return f((t - st) / (et - st)) * (ev - sv) + sv
```

### 4.2 速度事件 speedEvents 的特殊性

- 字段只有 `startTime`、`endTime`、`start`、`end`、`linkgroup`（**没有** `easingType`/`bezier`/`bezierPoints`）。`[文档][实测]`
- RPE 162 起速度事件也支持缓动字段，但仍不支持贝塞尔。`[文档]`
- 缓动语义在历史上反复变化：RPE 作者原文说明「速度事件缓动不为 1 时，实际速度变化与缓动函数的导函数形状相同，从而 floorPosition 的变化遵循缓动曲线；为了兼容，缓动为 1 时保持原含义（缓动 1 与 5 都代表二次型 floorPosition 变化）」；RPE 1.7.0 起「回归最原始逻辑，用缓动函数缓动速度数值，效果有待考证」。`[文档]`
- Phira 的做法：按 RPE 版本选择 `SpeedEasingMode::Legacy` / `Modern`（`RPEVersion >= 170` 用 Modern），速度为正负号跨越 0 的情况会拆成两段并做特殊处理（`prpr/src/parse/rpe.rs` 的 `parse_speed_events` / `parse_speed_events_legacy` / `speed_segment_tween`）。**实现建议：先做线性（easingType = 1）即可覆盖绝大多数谱面**，再按需补。
- 流速为负数时音符向上飞；Hold 在尾部出现时整个音符一起出现（与本家行为不符）。`[文档]`

---

## 5. easingType 完整对照表

来源：Phira Documents《extend》的对照表 + `prpr/src/parse.rs` 的 `RPE_TWEEN_MAP`（30 项数组，索引 0 未使用，1–29 为可用编号）。`[文档]`

| 编号 | 名称 | 编号 | 名称 | 编号 | 名称 |
| --- | --- | --- | --- | --- | --- |
| 1 | Linear | 11 | In Quart | 21 | In Back |
| 2 | Out Sine | 12 | In Out Cubic | 22 | In Out Circ |
| 3 | In Sine | 13 | In Out Quart | 23 | In Out Back |
| 4 | Out Quad | 14 | Out Quint | 24 | Out Elastic |
| 5 | In Quad | 15 | In Quint | 25 | In Elastic |
| 6 | In Out Sine | 16 | Out Expo | 26 | Out Bounce |
| 7 | In Out Quad | 17 | In Expo | 27 | In Bounce |
| 8 | Out Cubic | 18 | Out Circ | 28 | In Out Bounce |
| 9 | In Cubic | 19 | In Circ | 29 | In Out Elastic |
| 10 | Out Quart | 20 | Out Back | | | |

要点：

- 编号 1 = 线性（也是缺省值 `easingType = 1`）；编号越界时的实现是**钳制**到合法范围（`easingType < 1` → 1，`> 29` → 29）。`[文档]`
- 编号 0 在本样本里出现（`inclineEvents`），Phira 会把它钳到 1（线性），可视为等同于线性。`[实测][文档]`
- 29（In Out Elastic）不能用于速度事件。`[文档]`
- 常用缓动函数的定义（Phira `rpe_easing` 示例）：

```python
lambda t: t                                  # 1 linear
lambda t: math.sin((t * math.pi) / 2)        # 2 out sine
lambda t: 1 - math.cos((t * math.pi) / 2)    # 3 in sine
lambda t: -(math.cos(math.pi * t) - 1) / 2   # 6 in-out sine
```

- 自定义贝塞尔：`bezier = 1` 时用 `bezierPoints = [p1, p2, p3, p4]`（等价 `cubic-bezier(p1,p2,p3,p4)`），`easingLeft/easingRight` 用于裁剪缓动曲线区间。`[文档]`

---

## 6. 扩展（故事板）事件 `extended`

位于事件编辑的「第五个层级」。除 `inclineEvents` 外，其余事件在未使用时**不出现该字段**。`[文档]`

| 字段 | 作用 | 值类型 | 说明 |
| --- | --- | --- | --- |
| `inclineEvents` | 倾斜 | float | 判定线/纹理倾斜。Phira 实现中缺省值为 0。 |
| `scaleXEvents` | 宽度缩放 | float（默认 1） | 缩放判定线、纹理或文字宽度。 |
| `scaleYEvents` | 高度缩放 | float（默认 1） | 缩放高度。 |
| `colorEvents` | 颜色 | `int[3]`（RGB 0–255） | 控制判定线或纹理颜色。 |
| `textEvents` | 文本 | string | 把判定线变成文字（Phira 中缺省空串）。 |
| `paintEvents` | 渐变/油漆 | float | Phira 中缺省值 −1；与 `paintEvents` 组合使用（Phira 的渐变油漆功能）。 |
| `gifEvents` | GIF 帧控制 | float | 纹理为 GIF 时使用；**使用该事件后流速事件会被替换**，因此理论上不会与 speedEvents 同时出现。 |

Phira 的实际支持范围就是上表 7 种（`RPEExtendedEvents` 结构体）`[文档]`；RPE 后续版本可能还有其它扩展（如纹理切换类事件），`[未验证]` 本项目暂不实现。

注意 `[文档]`：`scaleXEvents`/`scaleYEvents` 在纹理不是内置 `line.png` 时单位会变（Phira：内置线材质的 scale 因子为 1，自定义纹理时为 `2/1350`）；内置 `line.png` 且无文本、无 `attachUI` 时，X 缩放因子还会额外乘 0.5。

---

## 7. Controls（`posControl` / `sizeControl` / `skewControl` / `yControl` / `alphaControl`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `x` | float | **时间（秒）**。`[文档][实测]`：样本中为 `0` 与哨兵 `9999999`。Phira 直接把 `x` 当作以秒为单位的关键帧时间（`Keyframe { time: it.x, .. }`）。 |
| `easing` | int | 缓动类型编号（同 §5）。 |
| 值字段 | float | 名称随 Control 而定：`pos`、`size`、`skew`、`y`、`alpha`。`[实测]` 样本中 `alpha = 1`、`pos = 1`、`size = 1`、`y = 1`、`skew = 0`（alpha 这里是 0–1 归一化，不是 0–255）。 |

**缓动归属** `[文档]`（Phira 源码注释）：RPE 中每个 control 事件的 `easing` 作用于**以该事件为终点**的区间，而不是从它开始的区间；实现时要把缓动赋值向前平移一格。Phira 还做了一条特判：若只有两个事件且 `easing == 1` 且值等于 1，则视为「默认值」直接忽略。

---

## 8. 音符 Note

| 字段 | 类型 | 默认值 | 版本 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | int | 1 (Tap) | 81+ | 类型编号，**与官方格式不同**，见下表。 |
| `startTime` / `endTime` | Beat | — | 81+ | 非 Hold 时两者相同；Hold 时 `endTime` 为尾部时刻。 |
| `positionX` | float | — | 81+ | 相对判定线中心的 x 坐标（1 单位 = 屏宽/1350）。 |
| `above` | int | 1 | 81+ | 1 = 从线的正面下落，**其他数值 = 从线的背面下落**。 |
| `isFake` | int | 0 | 81+ | 1 = 假音符：不判定、无打击特效与音效、不计分、不计物量；Hold 假音符始终显示为未打击样式。 |
| `speed` | float | 1.0 | 81+ | 流速倍率。 |
| `size` | float | 1.0 | 81+ | **仅控制音符宽度**（不是整体大小）。 |
| `yOffset` | float | 0 | 81+ | Y 偏移（正数向上）。注意：**实际偏移量 = `yOffset × speed`**，`speed = 0` 时偏移恒为 0；同时偏移打击特效位置。 |
| `visibleTime` | float | 999999 | 81+ | 音符可见时间，单位**秒**。 |
| `alpha` | int | 255 | 99-100+ | 不透明度 0–255。Phira 实测存在 256 这样的越界值（用 u16 读取）。 |
| `hitsound` | string? | — | 142+ | 自定义打击音，相对谱面根目录路径；无自定义音效时该字段不存在。 |
| `judgeArea` | float | 1.0 | 170+ | 判定区域宽度倍率。 |
| `tint` / `color` | int[3] | [255,255,255] | 170+ | 音符颜色（顶点色相乘：`noteColor = noteColor × color`）。字段名从 `color` 改为 `tint`，**两个名字都可能出现，需同时兼容**。 |
| `tintHitEffects` | int[3]? | [255,255,255] | 170+ | 打击特效颜色（出现时无视 Good/Perfect 都用该色）。 |

**类型编号对照** `[文档][实测]`（**本表与官方格式完全不同，是最常见的 bug 来源**）：

| 值 | RPE | 官方格式的同名编号 |
| --- | --- | --- |
| 1 | Tap | 1 Tap |
| 2 | **Hold** | 2 **Drag** |
| 3 | **Flick** | 3 **Hold** |
| 4 | **Drag** | 4 Flick |

`visibleTime` 的实现语义 `[文档]`（Phira）：note 在 `note.time − visibleTime` 秒之后才可见；Phira 用「从 0 渐显到 `alpha`」实现，若 `visibleTime >= note.time`（按秒计）则恒可见（即默认的 999999 表示「一直可见」）。

---

## 9. 与官方格式的换算（写导入/导出时的公式）

| 量 | RPE → 官方/内部 | 说明 |
| --- | --- | --- |
| 时间 | `秒 = 拍 × 60 / BPM`（多 BPM 分段）；官方 `time = 秒 × bpm / 1.875` | RPE 支持变速，官方不支持 |
| x 坐标 | `官方 X = x / 675 × (W/2) / (0.05625 W) = x / 675 × 8.888…` | 1 RPE 单位 = W/1350，1 X = W/17.778 |
| y 坐标 | 1 RPE 单位 = H/900；1 Y = 0.6H → `官方 Y = y × (H/900) / (0.6H) = y / 540` | |
| 旋转 | `官方角度 = −RPE角度` | 两者方向相反 |
| alpha | `官方 alpha = alpha / 255` | RPE note/事件为 0–255 |
| 速度 | `官方等效(Y/s) = RPE值 × 2/9`（1 RPE 速度 = 120 RPE长度单位/秒 = 2/15 屏幕高度/秒） | `[文档]` Phichain《速度》+ 样本实测（999 ↔ 4495.5 = 999 × 4.5） |
| note 类型 | 1→1、2→3、3→4、4→2 | |

---

## 10. RPE 样本参考数据 `[实测]`

样本：`packages/领土战争AT（RPE格式）/29519800.json`（40.8 MB，RPEVersion 140，全局 BPM 140）。

| 项目 | 值 |
| --- | --- |
| 判定线 | 24 条；18 条有 `notes` 字段（其余 6 条字段缺省） |
| 事件层 | 每条线 1 层；事件总数 81320（`alphaEvents` 10122、`moveXEvents` 28207、`moveYEvents` 28207、`rotateEvents` 14271、`speedEvents` 513） |
| `easingType` | 实际用到 0–23（本样本中除 `inclineEvents` 外全部为 1，即线性） |
| `bezier` / `linkgroup` | 全为 0；`easingLeft` 全为 0、`easingRight` 全为 1 |
| 事件时间 | 最早为 −3.125 拍（`[-4,7,8]`），`endTime` 哨兵 `[31250000,0,1]` |
| note | 1417 个：1 Tap 624、2 Hold 165、3 Flick 158、4 Drag 470 |
| note 字段取值 | `above = 1`、`alpha = 255`、`size = 1`、`speed = 1`、`visibleTime = 999999`、`yOffset = 0`、`isFake = 0` |
| `positionX` | ±568.75（≈ ±0.42 W） |
| `numOfNotes` 之和 | 1252 = 1417 − 165（Hold 数），验证了「不含 Hold」 |
| 速度事件取值 | 0（停止）、0.0045–10.8（常规，本谱线速基准约 10.8）、4495.5（瞬移） |
| `extended` | 只有 `inclineEvents`（每条线 1 条，值恒为 0） |
| 其它 | `father = -1`、`isCover = 1`、`Group = 0`、`zOrder = 0`、`Texture = "line.png"`、`bpmfactor = 1.0`；`judgeLineGroup = ["Default"]` |

> 复现方式：`node tools/inspect-chart.mjs "packages/领土战争AT（RPE格式）/29519800.json" > out.txt`。

---

## 11. 实现建议（踩坑清单）

1. **不要把 RPE 的类型编号当成官方的编号**；内部模型统一（Tap/Drag/Hold/Flick），只在解析层映射。
2. **Beat 用有理数处理**：`[a, b, c]` 先转成 `a + b/c` 的浮点，或直接保留分数做精确比较/排序（相邻事件的衔接比较会受浮点误差影响）。
3. **事件层相加**，不是覆盖；某一层缺某类事件时贡献 0。
4. **`eventLayers` 可能是 `null`**，`notes` 可能缺省，`extended` 可能不存在，`bezier` 等字段可能缺省——解析器必须对每个字段做默认值兜底。
5. **负时间合法**（本样本存在 −3.125 拍的事件），但渲染开始前的时间不用求值。
6. **速度事件不要用贝塞尔缓动**，先实现线性；跨越正负号时按 Phira 的做法拆段。
7. **`linkgroup` 无渲染语义**，别把它当「链接事件」实现。
8. `hitsound` 的默认名字有意思：Phira 把 `flick.mp3`/`tap.mp3`/`drag.mp3` 映射为内置音效，其他名字按包内文件加载。

# Phigros 与谱面格式文档

面向「为本项目以及相似项目提供格式与实现依据」的读者。内容分三部分：

1. **通用概念与两种谱面格式**（official / RPE）的字段级规格；
2. **渲染与判定的数学**：速度积分、音符位置、可见性、判定与计分；
3. **本项目的实现方案**：逐项说明上述规格在 `src/` 中如何落地、哪些未实现、依据是什么。

谱师操作制谱器的内容见 [谱师文档.md](谱师文档.md)；代码结构与开发流程见 [项目文档.md](项目文档.md)。

## 0. 阅读约定

### 0.1 依据标记

正文中每条结论都标注依据，便于核对与更新：

| 标记 | 含义 |
| --- | --- |
| **【实测】** | 由本仓库样本或脚本验证：`packages/` 下两份谱面包、`assets/` 资源、`tools/` 下的测量脚本 |
| **【引用】** | 来自外部文档或开源实现，见 §8 资料清单 |
| **【待验证】** | 暂无可靠来源，属推测或社区说法，实现前需再确认 |

不使用无标记的结论。单位与字段名必须能追溯到上表之一。

### 0.2 术语

| 术语 | 含义 |
| --- | --- |
| 判定线（line） | 音符下落的目标线。位置、旋转、透明度、下落速度均随时间变化 |
| 音符（note） | 四种类型：Tap / Drag / Hold / Flick；从判定线的正面或背面靠近 |
| 事件（event） | 决定判定线某属性随时间变化的区间数据 |
| 事件层（event layer） | RPE 概念：同一判定线的多组事件，**多层取值相加** |
| 扩展（故事板）事件 | RPE 概念：不分层的判定线附加事件（缩放、颜色、倾斜、文本等） |
| 谱面包（package） | 谱面 JSON + 音频 + 曲绘（+ 可选元数据与自定义资源）的集合 |
| 拍（beat） | 模型层的时间单位；运行期换算成秒 |
| X / Y / T | official 格式的三个单位，定义见 §1.1 |

---

# 第一部分：格式规格

## 1. official（游戏本体）格式

数据来源：Lchzh Docs 的《Phigros 谱面格式说明》《相关计算》《实测数据》，Phira 的官方格式解析实现（`prpr/src/parse/pgr.rs`），并用本仓库样本 `packages/白复生 AT（official格式）/Chart_AT #3649.json` 校验。

### 1.1 单位与常量

| 名称 | 定义 | 1920×1080 下的值 | 用途 |
| --- | --- | --- | --- |
| `W` / `H` | 画面宽度 / 高度 | 1920 / 1080 px | — |
| `X` | `0.05625 W` | 108 px | `Note.positionX` |
| `Y` | `0.6 H` | 648 px | `Note.floorPosition`、速度事件值 |
| `T` | `1.875 / bpm` 秒 = 1/32 拍 | 174 BPM 时 0.010776 s | `time`、`holdTime`、事件时间 |

```
秒   = time × 1.875 / bpm
time = 秒 × bpm / 1.875
```

**【实测】** bpm 174、`time = 256` → 2.758621 s。

### 1.2 根结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | int | 只影响**判定线移动事件**的坐标读取方式，见 §1.3 |
| `offset` | float | 谱面偏移，单位**秒**。语义见 §5 |
| `judgeLineList` | Array&lt;JudgeLine&gt; | 判定线列表 |

历史字段 `numOfNotes` / `numOfNotesAbove` / `numOfNotesBelow` 自 v2.5.0 移除：读取旧谱时应忽略，不要依赖。

### 1.3 `formatVersion` 与移动事件坐标

| 版本 | 坐标原点 | 右上角坐标 | 事件值含义 |
| --- | --- | --- | --- |
| 1 | 屏幕左下角 | (880, 520) | 位置压缩为单个整数 `v = 1000·x + y`；`x = (v − v mod 1000)/1000`，`y = v mod 1000`，再按 880 / 520 归一化。⚠️ 负数取模在 Rust（向零取整）与 Python（向下取整）下不同，本项目按 Python 语义实现 |
| 3 | 屏幕左下角 | (1, 1) | `start`/`end` = x，`start2`/`end2` = y，取值 0–1 |
| 2 及其它未被文档承认的值 | **屏幕中心** | 两轴单位长度均为 `0.1 H` | `start/end` = x，`start2/end2` = y。该规则仅见于 Lchzh 文档的折叠块。注意 16:9 下 `0.1 H = 0.05625 W = 1 X`，故 x 的数值等同 X 单位 |
| 3473 | — | — | 仅 sim-phi 显式接受，**与 3 同构**（彩蛋值），未见于官方文档 |

**【实测】** 样本 `formatVersion = 3`：移动事件 x ∈ [−0.8, 1.8]、y ∈ [−2, 5]（可以离开屏幕）；样本开头 `x = 0.5` 即水平中心、`y = 0.5` 即垂直中心，与「左下角为原点」吻合。若按「屏幕中心为原点」解释，0.5 将是半屏偏移，与谱面实际居中不符。

### 1.4 判定线

| 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `bpm` | float | BPM | 决定该判定线的时间单位 `T`；不能为 0 或负数 |
| `notesAbove` | Array&lt;Note&gt; | — | 从线的**正面**下落的音符 |
| `notesBelow` | Array&lt;Note&gt; | — | 从线的**背面**下落的音符 |
| `speedEvents` | Array&lt;SpeedEvent&gt; | — | 下落速度事件，单位 Y/s |
| `judgeLineMoveEvents` | Array&lt;JudgeLineEvent&gt; | — | 移动事件（x、y） |
| `judgeLineRotateEvents` | Array&lt;JudgeLineEvent&gt; | 度 | 旋转事件，**逆时针为正** |
| `judgeLineDisappearEvents` | Array&lt;JudgeLineEvent&gt; | 0–1 | 不透明度事件，≤0 全透明、≥1 不透明 |

**【实测】** 样本 24 条判定线只使用上述字段，无 `eventLayers` / `extended` / `name` / `texture`，即官谱是**扁平布局**。

**事件列表规范**（不满足会导致游戏卡死或异常，见 §4.3）：

- 除速度事件外，第一条事件的 `startTime` 为极小哨兵（**【实测】** 官谱用 `-999999`）；速度事件第一条为 `0`；
- 最后一条事件的 `endTime` 为极大哨兵（**【实测】** 官谱用 `1000000000`）；
- 相邻事件的 `startTime` 等于上一条的 `endTime`（首尾相接）；
- 事件列表不能是空数组。

### 1.5 音符

| 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `type` | int | — | 类型编号，见下 |
| `time` | int | `T` | 判定时刻 |
| `positionX` | float | `X` | 沿判定线方向、相对线中心的水平位置 |
| `holdTime` | int | `T` | 长按时间。非 Hold 恒为 0；为 0 时 Hold 不可见。即使写成 `0.0` 游戏仍按整数读取 |
| `speed` | float | 倍率 | 速度倍率。**Hold 头部速度恒为 1，此值表示尾部速度倍率** |
| `floorPosition` | float | `Y` | 判定时距判定线的垂直位置。游戏**会重新计算**而不读取该值 |

| 值 | 类型 | 玩家操作 |
| --- | --- | --- |
| 1 | Tap | 判定时刻点击 |
| 2 | **Drag** | 判定时刻手指位于判定区域内（无需点击） |
| 3 | **Hold** | 判定时刻点击并长按至音符消失 |
| 4 | Flick | 判定时刻向任意方向滑动 |

Hold 长度（单位 Y）：`d = η · tH · 1.875 / bpm`，其中 `η = speed`（尾速度）、`tH = holdTime`。设计惯例是令 `η` 等于判定线在判定时刻的实时速度 `VJ(tN)`，使打击前后的尾速度连续。

### 1.6 速度事件与判定线事件

| SpeedEvent 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `startTime` / `endTime` | int | `T` | 区间（第一条 `startTime` 应为 0） |
| `value` | float | Y/s | 该区间内的判定线速度（常量） |

约定取值 **【实测】**：`0` = 判定线停止、音符冻结（样本 196 处）；`999` = 瞬移/无限远（样本末段 `[14400, 1000000000] value = 999`）；`< 0` = 音符反向向上飞；常规值为 1、1.1、1.65、2.2、6.6 等。样本共 1262 条速度事件。

历史字段 `floorPosition`（v3 旧版）已被游戏忽略，不要读取。

| JudgeLineEvent 字段 | 类型 | 适用 | 说明 |
| --- | --- | --- | --- |
| `startTime` / `endTime` | int | 全部 | 单位 `T` |
| `start` / `end` | float | 全部 | 起始 / 结束值 |
| `start2` / `end2` | float | 移动（v3） | y 坐标；x 用 `start/end` |

**【实测】** 样本取值：不透明度 ∈ [0, 1]、旋转 ∈ [−2130, 1530] 度、移动 x ∈ [−0.8, 1.8] / y ∈ [−2, 5]。v2.5.0 之前消失与旋转事件也带 `start2/end2`（恒为 0）；之后不再包含。

### 1.7 事件规范化规则（解析器必须实现）

**【引用】** Lchzh Docs《实测数据》：

1. 事件按 `startTime` 升序使用；
2. 速度事件列表若第一条 `startTime ≠ 0`，等价于在其前插入一条 `[0, startTime] value = 1` 的事件；
3. 与上一事件**相离**（有空隙）：在空隙内按斜率做解析延拓；
4. 与上一事件**相交**：相交部分被忽略 —— `startTime` 截到上一事件的 `endTime`，保持 `end` 与斜率不变地重算 `start`；
5. `startTime >= endTime` 的事件被忽略；
6. 读到**重复 JSON 键时取第一个**（与 `JSON.parse` 取最后一个相反）；
7. 浮点精度为 float32；数字支持科学计数法；`int` 字段遇小数**截断**（非四舍五入）；
8. 所有字段都有默认值（int = 0、float = 0.0、数组 = []、对象 = {}），但默认值**不保证是合法谱面**，保存时必须显式写全。

**【引用】** Phira 的实现另外做两件事：解析时把 `startTime` 为负的事件时间截到 0；对 `notesAbove` / `notesBelow` 分别按 `time` 排序。

### 1.8 包内元数据（`info.csv` / `line.csv` / `info.txt`）

官方格式自身只有一个 JSON，元数据与判定线贴图在包内的 CSV 中 **【引用】**：

- `info.csv`：首行为列名，其后每行一个谱面。常见列：`Chart`（必需）、`Name`、`Musician`/`Composer`/`Artist`、`Level`、`Illustrator`、`Designer`/`Charter`、`Music`、`Image`、`AspectRatio`、`NoteScale`、`ScaleRatio`（旧）、`BackgroundDim`、`GlobalAlpha`（旧）、`Offset`。
- `line.csv`：逐判定线贴图配置，列形如 `Chart, LineId, Image, Scale, Aspect, UseBackgroundDim, UseLineColor, UseLineScale`（旧列名 `Vert`/`Horz`/`IsDark`）。
- `info.txt`：社区打包工具与 Phira 兼容的写法。首行必须是 `#`，其后每行严格 `Key: Value`（分隔符必须是 `": "`），键包括 `Name`、`Music`|`Song`、`Chart`、`Image`|`Picture`、`Level`、`Illustrator`、`Artist`|`Composer`|`Musician`、`Charter`|`Designer`；`Path` 被忽略。

**【实测】** 官方格式的包**不带元数据**（曲名、曲师、谱师、难度），编辑器必须允许手动填写；RPE 的 `META` 才是完整元数据的来源。

### 1.9 样本参考数据

**【实测】** `packages/白复生 AT（official格式）/Chart_AT #3649.json`（25.8 MB，formatVersion 3，offset 0）：

| 项目 | 值 |
| --- | --- |
| 判定线 | 24 条全部有音符（`notesAbove` 1031、`notesBelow` 125） |
| 音符类型分布 | Tap 616、Drag 324、Hold 180、Flick 36（合计 1156） |
| `time` 范围 | 256–14400（`T`），即 2.76–155.2 s（174 BPM） |
| `holdTime` | 0–480，16 种取值 |
| `positionX` | −7 – 7（50 种取值），跨约 ±0.394 W |
| `speed` | {1, 1.65, 2.2, 999} |
| 速度事件 | 1262 条；`value` 含 0、负数、999 |
| 事件哨兵 | 首条 `-999999`，末条 `1000000000` |
| 验证结论 | 第 1 条线 280 个音符的 `floorPosition` 与其速度事件积分**逐一相等** |

复现：`node tools/inspect-chart.mjs "packages/白复生 AT（official格式）/Chart_AT #3649.json"`、`node tools/deep-check.mjs`。

---

## 2. RPE（Re:PhiEdit）格式

数据来源：Lchzh Docs《Re:PhiEdit 谱面格式说明》、Phira Documents《RPE 格式》章节、Phira 的 RPE 解析实现（`prpr/src/parse/rpe.rs`），并用样本 `packages/领土战争AT（RPE格式）/29519800.json`（RPEVersion 140）校验。

### 2.1 时间：Beat

```
Beat = [int, int, int]
拍值 = Beat[0] + Beat[1] / Beat[2]
秒   = 拍值 × 60 / BPM
```

**【实测】** `[6,1,4]` = 6.25 拍；`[-4,7,8]` = −3.125 拍（**允许负时间**）；`[115,1,32]` = 115.03125 拍。样本共 32 种分母（均为 2 的幂，最大 1/32），但格式本身不限制分母。

多 BPM 时按 `BPMList` 分段换算，注意**线 BPM = 全局 BPM / bpmfactor**：

```python
def sec2beat(t, bpmfactor):
    beat = 0.0
    for i, e in enumerate(BPMList):
        bpmv = e.bpm / bpmfactor
        if i != len(BPMList) - 1:
            et_beat = BPMList[i+1].startTime - e.startTime
            et_sec  = et_beat * 60 / bpmv
            if t >= et_sec: beat += et_beat; t -= et_sec
            else:           beat += t / (60 / bpmv); break
        else:
            beat += t / (60 / bpmv)
    return beat
```

**【实测】** 样本用 `[31250000,0,1]`（3125 万拍）作为「无限远」的 `endTime` 哨兵。

### 2.2 根结构

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `META` | object | 谱面信息，见 §2.3 |
| `BPMList` | Array | `{startTime: Beat, bpm: float}`，全局变速 |
| `judgeLineList` | Array | 判定线列表 |
| `judgeLineGroup` | Array&lt;string&gt; | 判定线分组名，读取可忽略 |
| `multiLineString` | string | 多线编辑用（如 `1:20`、`all`），读取可忽略 |
| `multiScale` | float | 多线编辑缩放，读取可忽略 |
| `chartTime` | double | 谱面编辑时长（秒），RPE 141+ |
| `timeTags` | Array | 时间标记 `{name, time: Beat}`，RPE 130+ |
| `xybind` | bool | 是否启用 XY 绑定（启用时每个 X 事件必有等长 Y 事件） |

### 2.3 META

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `RPEVersion` | int | 如 `140` = v1.4.0。缺省按 160 处理；允许是字符串 |
| `offset` | int | 谱面偏移，单位**毫秒**（与 official 的秒不同） |
| `name` / `id` / `song` / `background` / `composer` / `charter` / `level` | string | 曲名 / 标识 / 音乐 / 背景 / 曲师 / 谱师 / 难度 |
| `illustration` | string | 曲绘画师，RPE 141+ |

偏移语义：负数表示音乐在谱面开始前 `|offset|` 毫秒播放，正数表示在其后播放。

### 2.4 判定线

| 字段 | 类型 | 默认值 | 版本 | 说明 |
| --- | --- | --- | --- | --- |
| `Group` | int | 0 | 81-99+ | 所属组，读取可忽略 |
| `Name` | string | Untitled | 81-99+ | 判定线名称，仅制谱器使用 |
| `Texture` | string | `line.png` | 81+ | 判定线纹理路径。`line.png` 是内置默认材质，**不需要包内存在该文件** |
| `anchor` | float[2] | [0.5, 0.5] | 142+ | 纹理锚点 |
| `eventLayers` | Array | — | 81+ | 事件层，最多 5 层。可能为 `null` 或缺省；层内某类事件不存在时该字段不出现 |
| `extended` | object | — | 81+ 可选 | 扩展事件，见 §2.7 |
| `father` | int | −1 | — | 父线索引，允许嵌套，见 §2.6 |
| `rotateWithFather` | bool | true（163 起新建） | 163+ | 子线是否继承父线旋转；**字段缺省应视为 `false`** |
| `isCover` | int | 1 | 81+ | 为 1 时判定线**背面**的音符不渲染 |
| `notes` | Array | — | 81+ | 音符列表，可为空或缺省 |
| `numOfNotes` | int | 0 | 81+ | 定义为「含假音符、**不含 Hold**」 **【实测】** 样本 1252 = 1417 − 165（Hold 数） |
| `zOrder` | int | 0 | 100-105+ | 图层顺序，约 ±100 |
| `bpmfactor` | float | 1.0 | — | **线当前 BPM = 全局 BPM / bpmfactor** |
| `posControl` / `sizeControl` / `skewControl` / `yControl` / `alphaControl` | Array | — | 105-113+ | 见 §2.8 |
| `isGif` | bool | false | 150+ | 纹理是否为 GIF |
| `attachUI` | string? | — | 150+? | UI 绑定（Phira 特有扩展） |

#### 坐标与单位

- 坐标锚点在**屏幕中心**：x ∈ [−675, 675]、y ∈ [−450, 450]，即 **1 x 单位 = 屏宽 / 1350、1 y 单位 = 屏高 / 900**；
- 旋转：**顺时针为正**；
- alpha 事件正常范围 0–255；**alpha 为负数时连该线上的所有音符一起隐藏**（作者称这是废弃的非法功能，但仍然有效）。

### 2.5 事件层与事件

五种普通事件：`alphaEvents`、`moveXEvents`、`moveYEvents`、`rotateEvents`、`speedEvents`。

**多层叠加 = 相加** **【引用】**：Phira 把各层链成和 —— `a1(t) = a1.关键帧(t) + a2(t)`（`prpr/src/core/anim.rs` 的 `Anim::chain`）。因此未覆盖的时间段里该层贡献 0，实践中每条线都需要至少一条覆盖全时间轴的 alpha 事件。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `startTime` / `endTime` | Beat | — | 事件起止时间 |
| `start` / `end` | float \| string \| int[3] | — | 起止值。数值 → 按缓动插值；字符串 → 直接返回（文本事件）；`int[3]` → 三通道分别插值 |
| `easingType` | int | 1 | 缓动编号，见 §2.9 |
| `easingLeft` / `easingRight` | float | 0.0 / 1.0 | 缓动裁剪区间 |
| `bezier` | int | 0 | 是否使用自定义贝塞尔（0/1），RPE 123+ |
| `bezierPoints` | float[4] | [0,0,0,0] | 贝塞尔控制点，等价 `cubic-bezier(p1,p2,p3,p4)` |
| `linkgroup` | int | — | 仅编辑器标记，**无渲染语义**，不要当作「链接上一事件末值」 |

插值（Phira 版本）：

```python
def easing_interpolation(t, st, et, sv, ev, f):
    if t == st: return sv
    return f((t - st) / (et - st)) * (ev - sv) + sv
```

**速度事件的特殊性**：

- 字段只有 `startTime`、`endTime`、`start`、`end`、`linkgroup`，**没有**缓动字段 **【实测】**；RPE 162 起支持缓动但仍不支持贝塞尔；
- 缓动语义在历史上多次变化（作者原文：速度事件缓动不为 1 时，floorPosition 的变化遵循缓动曲线；RPE 1.7.0 起改为用缓动函数缓动速度数值）；
- Phira 按版本选择 `SpeedEasingMode::Legacy` / `Modern`（`RPEVersion >= 170` 用 Modern），速度跨越正负号时拆成两段；
- **实现建议：先做线性（`easingType = 1`）即可覆盖绝大多数谱面**；
- 流速为负时音符向上飞；Hold 在尾部出现时整个音符一起出现（与本家行为不符）。

### 2.6 父子判定线

Phira 文档只给出字段含义，叠加方式以代码为准（`prpr/src/core/line.rs` 的 `fetch_rot` / `fetch_pos`）：

```rust
fn fetch_rot(&self, lines) -> f32 {
    let mut rot = self.object.rotation.now();
    if self.rot_with_parent { if let Some(p) = self.parent { rot += lines[p].fetch_rot(lines); } }
    rot
}
fn fetch_pos(&self, res, lines) -> Vector {
    if let Some(p) = self.parent {
        return lines[p].fetch_pos(res, lines)
             + Rotation2::new(lines[p].fetch_rot(lines).to_radians()) * self.object.now_translation(res);
    }
    self.object.now_translation(res)
}
```

即：

```
父线世界旋转  rot_p = 父线自身 rot + (父线.rotateWithFather ? 祖父线 rot : 0)     （递归）
子线世界旋转  rot_c = 子线自身 rot + (子线.rotateWithFather ? rot_p : 0)
子线世界位置  pos_c = pos_p + R(rot_p) · 子线自身偏移
```

- **子线偏移会被父线旋转**，与 `rotateWithFather` 无关；
- 缺省 `rotateWithFather` 视为 `false`（`rot_with_parent: rpe.rotate_with_father.unwrap_or(false)`）；
- 父线可嵌套，父线旋转本身也是递归结果；
- **成环**：Phira 报 `found infinite recursive parent relations` 并拒绝谱面；
- 父线的缩放不参与子线变换（`scaleX/scaleY` 扩展事件只影响自身绘制）。

**【待验证】** Phichain 文档的能力对比表称 RPE 子线「不继承旋转」，与 Phira 的 `rotateWithFather`（163+）口径不同。本项目**采用 Phira 口径**；RPE 编辑器自身的确切行为未验证。

### 2.7 扩展（故事板）事件 `extended`

位于事件编辑的第五个层级。除 `inclineEvents` 外，未使用时**不出现该字段** **【引用】**。

| 字段 | 作用 | 值类型 | 说明 |
| --- | --- | --- | --- |
| `inclineEvents` | 倾斜 | float | 判定线 / 纹理倾斜，缺省 0 |
| `scaleXEvents` | 宽度缩放 | float（默认 1） | 缩放判定线、纹理或文字宽度 |
| `scaleYEvents` | 高度缩放 | float（默认 1） | 缩放高度 |
| `colorEvents` | 颜色 | `int[3]`（RGB 0–255） | 控制判定线或纹理颜色 |
| `textEvents` | 文本 | string | 把判定线变成文字，缺省空串 |
| `paintEvents` | 渐变/油漆 | float | 缺省 −1 |
| `gifEvents` | GIF 帧控制 | float | 纹理为 GIF 时使用；使用后流速事件会被替换，故理论上不与 `speedEvents` 同时出现 |

Phira 的支持范围即上表 7 种（`RPEExtendedEvents` 结构体）；后续版本是否新增其它扩展 **【待验证】**。

**【引用】** 注意单位差异：`scaleXEvents` / `scaleYEvents` 在纹理不是内置 `line.png` 时单位会变（内置线材质的 scale 因子为 1，自定义纹理时为 `2/1350`）；内置 `line.png` 且无文本、无 `attachUI` 时，X 缩放因子还会额外乘 0.5。

#### 本项目的（伪）3D 自有扩展 **【本项目】**

官方与 RPE 都没有以下两项，本项目把它们放进 `extended` 里（别的工具会忽略这两个键，读写往返保留）：

| 字段 | 作用 | 值类型 | 单位与符号 |
| --- | --- | --- | --- |
| `moveZEvents` | Z 轴位移（判定线沿视线前后移动） | float | RPE 长度单位（`900` = 一个画面高）；**正 = 往屏幕内**、负 = 往屏幕外。内部存「画面高比例」 |
| `thetaEvents` | 下落面倾斜（绕判定线**长轴**旋转下落面） | float | 角度制；**正 = 下落面向屏幕内倾**。内部存弧度（与 `rotate` 同口径，**不取反**） |

- 语义见 §3.5（投影）与 §7.3（判定范围）；两键都属于「已实现」的扩展事件，`EXTENDED_DEFAULTS` 里 `z = 0`、`theta = 0`（不改变画面）；
- 谱面相机写在**根节点**的自有扩展键 `camera` 里：`{ xEvents, yEvents, zEvents, angleEvents }`，与扩展事件同构（拍值 + 起止值 + 缓动）。单位：`x` 用长度单位（`1350` = 一个画面宽）、`y` / `z` 用长度单位（`900` = 一个画面高）、`angle`（**视角**）用角度制（缺省 ≈53.13°）。详见 §3.5.1。

### 2.8 Controls

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `x` | float | **时间（秒）**。样本中为 `0` 与哨兵 `9999999`。Phira 直接把它当秒 |
| `easing` | int | 缓动编号（同 §2.9） |
| 值字段 | float | 名称随 Control 而定：`pos`、`size`、`skew`、`y`、`alpha`。样本中 `alpha = 1`、`pos = 1`、`size = 1`、`y = 1`、`skew = 0`（alpha 为 0–1 归一化，不是 0–255） |

**【引用】** 缓动归属（Phira 源码注释）：每个 control 事件的 `easing` 作用于**以该事件为终点**的区间，而不是从它开始的区间，实现时需把缓动赋值向前平移一格。Phira 另有一条特判：若只有两个事件、`easing == 1` 且值等于 1，视为默认值直接忽略。

### 2.9 easingType 对照表

来源：Phira Documents《extend》对照表 + `prpr/src/parse.rs` 的 `RPE_TWEEN_MAP`（30 项数组，索引 0 未使用，1–29 可用）。

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

- 编号 1 = 线性（也是缺省值）；越界时的实现是**钳制**（`< 1` → 1、`> 29` → 29）；
- **【实测】** 样本里 `inclineEvents` 出现过编号 0，Phira 会钳到 1，可视为线性；
- 29（In Out Elastic）不能用于速度事件；
- 自定义贝塞尔：`bezier = 1` 时用 `bezierPoints`，配合 `easingLeft/easingRight` 裁剪曲线区间；
- 常用函数定义（Phira `rpe_easing` 示例）：

```python
lambda t: t                                  # 1 linear
lambda t: math.sin((t * math.pi) / 2)        # 2 out sine
lambda t: 1 - math.cos((t * math.pi) / 2)    # 3 in sine
lambda t: -(math.cos(math.pi * t) - 1) / 2   # 6 in-out sine
```

### 2.10 音符

| 字段 | 类型 | 默认值 | 版本 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | int | 1 (Tap) | 81+ | 编号**与 official 不同**，见下 |
| `startTime` / `endTime` | Beat | — | 81+ | 非 Hold 时两者相同；Hold 时 `endTime` 为尾部时刻 |
| `positionX` | float | — | 81+ | 相对判定线中心的 x 坐标（1 单位 = 屏宽/1350） |
| `above` | int | 1 | 81+ | 1 = 从正面下落，**其它数值 = 从背面下落** |
| `isFake` | int | 0 | 81+ | 假音符：不判定、无特效音效、不计分、不计物量；假 Hold 始终显示为未打击样式 |
| `speed` | float | 1.0 | 81+ | 流速倍率 |
| `size` | float | 1.0 | 81+ | **仅控制宽度**，不是整体大小 |
| `yOffset` | float | 0 | 81+ | Y 偏移（正数向上）。**实际偏移 = `yOffset × speed`**，`speed = 0` 时恒为 0；同时偏移打击特效 |
| `visibleTime` | float | 999999 | 81+ | 可见时间，单位**秒**。语义见下 |
| `alpha` | int | 255 | 99-100+ | 不透明度 0–255（Phira 实测存在 256 这样的越界值） |
| `hitsound` | string? | — | 142+ | 自定义打击音路径；无自定义音效时字段不存在 |
| `judgeArea` | float | 1.0 | 170+ | 判定区域宽度倍率 |
| `tint` / `color` | int[3] | [255,255,255] | 170+ | 音符颜色（顶点色相乘）。字段名由 `color` 改为 `tint`，**两个名字都可能出现** |
| `tintHitEffects` | int[3]? | [255,255,255] | 170+ | 打击特效颜色（出现时无视 Good/Perfect） |

**类型编号对照**（**本表与 official 完全不同，是最常见的 bug 来源**）：

| 值 | RPE | official 的同名编号 |
| --- | --- | --- |
| 1 | Tap | 1 Tap |
| 2 | **Hold** | 2 **Drag** |
| 3 | **Flick** | 3 **Hold** |
| 4 | **Drag** | 4 Flick |

**【引用】** `visibleTime` 的实现语义（Phira）：音符在 `note.time − visibleTime` 秒之后才可见，Phira 用「从 0 渐显到 `alpha`」实现；若 `visibleTime >= note.time`（按秒计）则恒可见，即默认的 999999 表示一直可见。

### 2.11 与 official 的换算

| 量 | RPE → official / 内部 | 说明 |
| --- | --- | --- |
| 时间 | `秒 = 拍 × 60 / BPM`（多 BPM 分段）；official `time = 秒 × bpm / 1.875` | RPE 支持变速，official 不支持 |
| x 坐标 | `官方 X = x / 675 × (W/2) / (0.05625 W) = x / 675 × 8.888…`，即 `x × 1/75.9375` | 1 RPE 单位 = W/1350，1 X = W/17.778 |
| y 坐标 | `官方 Y = y × (H/900) / (0.6H) = y / 540` | |
| 旋转 | `官方角度 = −RPE 角度` | 两者方向相反 |
| alpha | `官方 alpha = alpha / 255` | RPE 音符与事件为 0–255 |
| 速度 | `官方等效(Y/s) = RPE值 × 2/9` | 见 §3.1 |
| 音符类型 | 1→1、2→3、3→4、4→2 | |

### 2.12 样本参考数据

**【实测】** `packages/领土战争AT（RPE格式）/29519800.json`（40.8 MB，RPEVersion 140，全局 BPM 140）：

| 项目 | 值 |
| --- | --- |
| 判定线 | 24 条；18 条有 `notes` 字段 |
| 事件层 | 每条线 1 层；事件总数 81320（alpha 10122、moveX 28207、moveY 28207、rotate 14271、speed 513） |
| `easingType` | 用到 0–23；除 `inclineEvents` 外全为 1（线性） |
| `bezier` / `linkgroup` | 全为 0；`easingLeft` 全 0、`easingRight` 全 1 |
| 事件时间 | 最早 −3.125 拍；`endTime` 哨兵 `[31250000,0,1]` |
| 音符 | 1417 个：Tap 624、Hold 165、Flick 158、Drag 470 |
| 音符字段取值 | `above = 1`、`alpha = 255`、`size = 1`、`speed = 1`、`visibleTime = 999999`、`yOffset = 0`、`isFake = 0` |
| `positionX` | ±568.75（≈ ±0.42 W） |
| `numOfNotes` 之和 | 1252 = 1417 − 165（Hold 数），验证「不含 Hold」 |
| 速度事件取值 | 0（停止）、0.0045–10.8（常规，本谱基准约 10.8）、4495.5（瞬移 = 999 × 4.5） |
| `extended` | 只有 `inclineEvents`（每条线 1 条，值恒为 0） |
| 其它 | `father = -1`、`isCover = 1`、`Group = 0`、`zOrder = 0`、`Texture = "line.png"`、`bpmfactor = 1.0` |

复现：`node tools/inspect-chart.mjs "packages/领土战争AT（RPE格式）/29519800.json"`。

### 2.13 两种格式的差异速查

| 项目 | official | RPE |
| --- | --- | --- |
| 时间单位 | `T` = 1/32 拍；秒 = `time × 1.875 / bpm` | `Beat = [a,b,c]`；秒 = `拍 × 60 / bpm` |
| BPM | 每线一个恒定 `bpm` | 全局 `BPMList` + 每线 `bpmfactor` |
| X 单位 | `1 X = 0.05625 W` | `1 单位 = W/1350`（中心原点，x ∈ ±675） |
| Y 单位 | `1 Y = 0.6 H` | `1 单位 = H/900`（中心原点，y ∈ ±450） |
| 线坐标（移动事件） | v3：左下角原点 0–1；v1：压缩整数 | 中心原点，x ∈ ±675、y ∈ ±450 |
| 旋转方向 | **逆时针为正** | **顺时针为正** |
| 速度单位 | Y/s | 1 = 120 长度单位/秒 = 2/15 屏高/秒 |
| 不透明度 | 0–1 浮点 | 0–255 整数（线 `alphaControl` 为 0–1） |
| 音符类型编号 | 1 Tap / 2 Drag / 3 Hold / 4 Flick | 1 Tap / 2 Hold / 3 Flick / 4 Drag |
| `offset` 单位 | **秒** | **毫秒** |
| 上下方向 | `notesAbove` / `notesBelow` 两个数组 | 每个音符 `above` |
| 事件层 | 只有一层 | 最多 5 层，相加 |
| 缓动 | 无（只有线性） | 29 种 + 贝塞尔 + 裁剪 |
| 扩展事件 / 父子线 / 假音符 / 自定义材质 | 无 | 有 |

**四个必踩的坑**：音符类型编号不同、旋转方向相反、`offset` 单位不同、速度值单位不同。解析器必须让内部模型与格式解耦，只在解析 / 序列化层换算。

---

# 第二部分：渲染与判定的数学

## 3. 坐标系与变换

### 3.1 速度值的换算

- official：速度事件 `value` 的单位是 Y/s，即速度为 1 时音符以 0.6 个屏幕高度/秒靠近判定线；
- RPE：**1 的速度 = 每秒下落 120 个单位，画布高 900 单位，即每秒 2/15 屏幕高度** **【引用】**（Phichain 文档《速度》；Phichain 的导入器原样搬运速度值，故该值即 RPE 单位）。于是：

```
1 RPE 速度 = 120 长度单位/s = (2/15) H/s = (2/15)/0.6 Y/s = 2/9 Y/s ≈ 0.2222 Y/s
官方等效速度(Y/s) = RPE速度 × 2/9        ⇒  RPE速度 = 官方速度 × 4.5
```

**【实测】** 与样本吻合：官方样本的瞬移是 `999`，RPE 样本的同类手法是 `4495.5 = 999 × 4.5`。

**【待验证】** Phira 的 `SPEED_RATIO = (10/45)/HEIGHT_RATIO` 中 `10/45` 正是 `2/9`，但额外除以 `HEIGHT_RATIO = 0.83175`（换算到 prpr 自己的画布单位），结果约 `0.267`，比 `2/9` 快约 20%。原因未明。本项目内部统一用 Y/s 并按 `2/9` 换算，系数做成可配置项以便与 Phira 逐帧对齐。

### 3.2 坐标空间

| 空间 | 原点 | 单位 |
| --- | --- | --- |
| official v3 | 屏幕左下角 | x、y ∈ [0,1]（右上角 (1,1)） |
| official v1 | 屏幕左下角 | 右上角 (880, 520)，事件值 = `1000x + y` |
| RPE | **屏幕中心** | x ∈ [−675,675]、y ∈ [−450,450] |
| 本项目内部 | **屏幕中心** | x 为画面宽比例、y 为画面高比例（y 向上为正）；音符横向用官方 X 单位、纵向与速度用官方 Y 单位 |

### 3.3 音符的屏幕位置

```
lineA = 判定线在 t 时刻的旋转角（弧度，逆时针为正）+ 父线旋转（若继承）
lineP = 判定线在 t 时刻的中心位置（屏幕坐标）+ 父线平移

dx_local = Note.positionX × 0.05625 × W        # official；RPE 为 positionX × (W/1350)
dy_local = Y(t) × 0.6 × H                      # Y(t) 见 §4.2

notePos = lineP + R(lineA) · (dx_local, ±dy_local)
```

- `notesBelow`（official）或 `above != 1`（RPE）的音符从线的背面下落，`dy_local` 取反；
- 音符贴图与判定线平行，渲染时应用 `lineA`。

### 3.4 判定线的渲染参数

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 长度 | **5.76 H**（6220.8 px @1920×1080；与屏高成正比、与屏宽无关）= 3.24 W @16:9 = 57.6 X | **【引用】** Lchzh 实测（v1.6.11 / v2.3.1 一致）+ sim-phi 硬编码 `6220.8` |
| 宽度 | 名义 0.0075 H（8.1 px） | **【引用】** 实测 (6.712±0.997)×10⁻³ H；Phira 绘制用 0.01（缩放时 0.0076）画布单位 ≈ 0.006 H |
| 颜色（普通 / FC / AP） | 白 / `#a2eeff` / `#feffa9` | **【引用】** Lchzh 实测 |
| 多条线叠加不透明度 | `a = a1 + a2 − a1a2` | **【引用】** |
| 判定线 alpha 与音符 | **不作用于音符**：隐藏判定线时其上的音符照常显示（三个参考实现一致）。例外：RPE 负 alpha 编码、PEC 的 `pe_alpha_extension` | **【引用】** + **【实测】**（合成用例 `lineAlpha = 0` 时音符 alpha 仍为 1） |

**【待验证】** 判定线长度的权威口径：Lchzh 实测 5.76 H 与 sim-phi 源码一致；Phira 的 `lineLength` 默认 6.0、phi-chart-render 3 W、PEC 3.91 W。它们都远超屏宽，默认外观几乎看不出差异，长度只在自定义线贴图被拉伸时才可见。本项目取 5.76 H 并可配置。

**绘制顺序与层级**：

- official 无层级字段，按 `judgeLineList` 顺序绘制；
- RPE 有 `zOrder`；`isCover = 1` 时不渲染线背面的音符；
- 音符跟随其判定线一起变换。

### 3.5 （伪）3D 投影（本项目的自有扩展）**【本项目】**

官方与 RPE 都是纯 2D。本项目在渲染层加了一台**小孔相机**，让「Z 轴位移」「下落面倾斜」和「谱面相机」共用同一套投影（实现：`src/render/projection.js`，常数：`src/core/units.js` 的 `PSEUDO3D`）。

设：

- `z` = 该点相对判定线所在平面（z = 0）的深度，**往屏幕内为正**，单位画面高（像素时乘 `areaH`）；
- `θ`（视角，弧度，谱面相机的 `angle` 通道）→ `F = 1/(2·tan(θ/2))`（画面高；缺省 `θ ≈ 53.13°` → `F = PSEUDO3D.FOCAL_H = 1`）；
- 相机位置 `C = (Cx, Cy)`（谱面相机通道，屏幕像素），沿轴推拉 `Cz`（正 = 往屏幕内）。

每个点按「中心 + (偏移 − 相机位置) × k」投影，**缩放系数**：

```
k = F / (深度 + F − Cz)        # 深度逼近 −(F − Cz) 前夹住：rel ≥ F × MIN_DEPTH_RATIO (0.05)
屏幕坐标 = 画面中心 + (世界偏移 − 相机位置) × k
```

推论（与实现一致）：

- `z = 0` 且相机在缺省位置（`Cx = Cy = Cz = 0`、缺省视角）时 `k = 1`，画面与「没有 3D」逐像素一致（所有旧公式都不变）；
- 判定线的 `z > 0` → 整条线（含其上的音符、线长与线厚）缩小并向画面中心靠拢；
- 相机的 `z` 通道（`Cz > 0`，往屏幕内推）→ `k > 1` → 画面整体放大、透视更强；相机 `x` / `y` 平移 → 画面整体反向平移，且**近处移动多、远处移动少**（视差）；
- **视角**只改透视强弱：z = 0 平面上的东西大小恒为 1:1，越远的点对视角越敏感（视角越大 → `F` 越小 → 越「广角」，透视越强；视角越小越接近正交投影）。

**下落面倾斜**（`theta`，弧度，绕判定线**长轴**）：设某音符到线的距离为 `d`（沿下落方向，屏幕上方为正），则

```
屏幕上距离 = d · cosθ          # 沿下落方向按透视缩短
深度分量   = d · sinθ          # 「屏幕上方」一侧往屏幕内走（θ > 0）
k          = F / (z·H + d·sinθ·H + F − Cz)
```

即音符沿**下落方向**到线的屏幕距离缩短为 `d·cosθ`（判定线旋转时，这个「缩短」在屏幕上就表现为横向偏移），同时按深度 `d·sinθ` 缩小；贴图再按 `cosθ` 沿下落方向压扁（`squashY`）。倾斜只作用于该线自己的音符（含 Hold 头尾），**子线不继承**。

**Hold 长条的梯形**（实现说明）：长条沿下落方向**跨越一段距离**，两端在倾斜面上的深度差看得见 —— 远端必须更窄，所以整条长条应当是个梯形。Canvas2D 的一次仿射变换画不出梯形（只能得到平行四边形），因此长条在 `|sinθ| > 0` 时改走**逐行投影**：把长条（先按切片分好头尾帽 / 主体 / 光效）沿下落方向切成约 7px 一行（上限 64 行），每行用**行中心**的深度算 `k` 与屏幕位置，行内横向乘 `k`、纵向再乘 `cosθ`，相邻行重叠约 1px 避免接缝（`src/render/canvas2d.js` 的 `drawTiltedHold`）。于是：

- 宽度从贴线一端向远端连续收窄（梯形），头尾帽各自按自己那一端的 `k` 缩放；
- 判定线旋转时远端在屏幕上还会沿线方向横向偏移（每行取点都用 `noteTransform` 的同一套公式，因此与音符落点严格一致）；
- 倾斜为 0（或「垂直判定」的 `ignore3D`）时走原来的单次变换路径，与旧版本逐像素一致；
- 单行内部仍按仿射近似（误差是半行的曲率，约 1px），这是逐行法的固有代价，7px 行高下肉眼不可见。

#### 3.5.1 谱面相机**【本项目】**

相机是**谱面级**的关键帧（`chart.camera`，与 BPMList 一样按拍给值、支持 29 种缓动 / 贝塞尔），四个通道：

| 通道 | 含义 | 内部单位 | RPE 字段（根节点 `camera`） |
| --- | --- | --- | --- |
| `x` | 横向平移（正 = 相机往右 → 画面往左） | 画面宽比例 | `xEvents`（长度单位，1350 = 一画面宽） |
| `y` | 纵向平移（正 = 相机往上 → 画面往下） | 画面高比例 | `yEvents`（长度单位，900 = 一画面高） |
| `z` | 沿轴推拉（正 = 往屏幕内 → 放大） | 画面高比例 | `zEvents`（长度单位） |
| `angle` | **视角**（越大透视越强；越小越接近正交） | 弧度（缺省 `PSEUDO3D.ANGLE_DEFAULT ≈ 53.13°`） | `angleEvents`（角度制，≈53.13° = 焦距 1 屏高） |

- 求值：每帧从 `chart.cameraRt` 求出 `state.camera = { x, y, z, angle }`，投影层按它变换（见上面的公式）；
- 缺省（无关键帧）= `{ x: 0, y: 0, z: 0, angle: ≈53.13° }`，画面与完全没有相机时一致；
- **焦距不再是一个通道**：视角与焦距一一对应（`F = 1/(2·tan(θ/2))`），焦距只作为内部换算量；
  早期版本写过的 `focalEvents` 仍能读入（换算成等价的 `angleEvents`）并给出告警；
- 相机是「看的人」，`z` / 倾斜是「物体」的位移，两者叠加；
- 官谱格式无法表达相机 → 导出时丢弃并告警。

## 4. 核心公式

### 4.1 判定线高度（速度积分）

设速度事件列表第 k 条为 `{startTime: tk, endTime: tk+1, value: vk}`，判定线在该事件开始时刻的累计垂直位置为 `pk`（单位 Y）：

```
p1 = 0
pk = p(k-1) + v(k-1) × (tk − t(k-1)) × 1.875 / bpm          # k ≥ 2

VJ(t) = vk                                                  # Y/s
PJ(t) = pk + vk × (t − tk) × 1.875 / bpm                    # Y，tk ≤ t < tk+1
```

注意 `(tk − t(k-1)) × 1.875 / bpm` 即把时间单位换算成秒：**积分变量是秒，不是拍**。

规范化补充：若第一条速度事件的 `startTime ≠ 0`，等价于在其前插入一条 `[0, startTime] value = 1` 的事件；Phira 的做法是把首条事件的 `startTime` 强制置 0。

**【实测】** 官方样本第 1 条判定线 280 个音符的 `floorPosition` 与 `PJ(time)` **逐一相等**（含 `speed = 999` 的音符，最大误差 4.07e-4，属 float32 存储舍入）。因此**实现时应直接用速度事件积分求 `PJ`，不要读取 `Note.floorPosition`**。

### 4.2 音符位置

```
pN = Note.floorPosition            # 等于 PJ(Note.time)
η  = Note.speed                    # 非 Hold；Hold 头部速度为 1，η 用于尾部

非 Hold：            Y(t) = η × (pN − PJ(t))
Hold 头部 (t ≤ tN)： Y(t) = pN − PJ(t)
Hold 尾部：          YT(t) = Y(t) + η × tH × 1.875 / bpm          # tH = holdTime
Hold 已命中后尾部：  YT(t) = η × (tN + tH − t) × 1.875 / bpm
```

RPE 侧没有存 `floorPosition`，导入时需自行生成：把 Beat 时间轴转成秒 → 速度按 `2/9` 换算成 Y/s → 对秒积分得到 `PJ(t)` 关键帧 → 每个音符的 `pN = PJ(startTime)`。

**yOffset**：实际偏移（RPE y 单位）= `yOffset × speed`；`speed = 0` 时偏移为 0。

### 4.3 可见性剔除

**【引用】** 官方实测规则（v2.3.1 / v2.0.0）：

| 条件 | 结果 |
| --- | --- |
| `currentFloorPosition < −0.001` 且未打击 | 不渲染 |
| `speed × currentFloorPosition > 3.3333336`（即 Y > 2H） | 不渲染（v2.0.0+） |
| Hold 长度为 0（`speed = 0` 或 `holdTime` 取整后为 0） | 不渲染 |
| RPE `visibleTime` | 仅当 `t ≥ note.time − visibleTime` 秒时可见 |
| RPE `isCover = 1` | 线背面的音符不渲染 |
| RPE `isFake` | 照常下落渲染，但不判定、无特效音效、不计分、不计物量 |

**实现建议**：不要照抄浮点边界，统一用「`0 ≤ 距离 ≤ 2H` 才渲染」的保守判据，另留一个可选的 float32 精确模式。

### 4.4 漏接与命中的视觉表现

| 音符 | 命中（Perfect / Good） | 漏接（Miss） |
| --- | --- | --- |
| Tap / Drag / Flick | 立即消失，只留打击特效 | 越过判定线后继续下落，0.16 s 内淡出后消失，不产生特效 |
| Hold | 头部贴线、尾巴收回来，直到尾部过线 | **没点到头部的**：正常不透明地继续下落（不再半透明），尾部过线后 0.16 s 淡出；**按住过又断连判 Miss 的**：半透明继续下落 —— 位置**连续**（断连那一刻还贴在判定线上，之后从线上按自己的速度往下走，不会瞬间掉到线下面），尾部过线后淡出 |

**Bad** 的音符用 Tap 贴图整体着色 `#6C4343`，并在 500 ms 内淡出 **【引用】**（sim-phi）。

## 5. 判定与计分

### 5.1 判定窗口

| 判定 | Tap / Hold | Drag | Flick | 判定分比例 |
| --- | --- | --- | --- | --- |
| Perfect | ±80 ms | ±100 ms | ±140 ms | 100% |
| Good | ±80–180 ms | — | — | 65% |
| Bad | ±180–220 ms（Hold 无 Bad） | — | — | 0% |
| Miss | 未命中 | 未命中 | 未命中 | 0% |

其它规则：一次点击只能判定一个 Tap/Hold（优先最早出现的可判定音符）；Drag 只需判定时刻有手指在判定区域；Flick 需滑动；Hold 可提前松手、可换手，已判 Miss 的 Hold 不能再判。

**本项目口径（模拟器落地值）**：Drag / Flick 的窗口统一取 **±80 ms**（上表的 ±100 / ±140 ms 是参考实现给的官方值，本项目按 ±80 ms 实现，见 `JUDGE.DRAG` / `JUDGE.FLICK`）：

- **Hold 的断连与提前松手**（`JUDGE.HOLD_GRACE_SEC` / `HOLD_RELEASE_RATIO` / `HOLD_RELEASE_MAX_BEATS` / `HOLD_LENIENT_BEATS`）：
  头部点中后，持续时间内判定范围里只要有任一根手指（可换手）就算没断；没手指时开始计时，**断连 ≤ 80 ms** 内接上不算断，更久才判 Miss。
  **提前松手**的允许量 = `min(时长 × 30%, 1 拍)`：松在这个窗口内按头部等级记分（保持贴线收尾）；
  **短于半拍的 Hold 不设断连概念** —— 头部点中之后随便什么时候松手都算按完（例如 1/4 拍的长条，要求「一直按着」没有意义）。短 Hold 的判定仍要求点头部（头部窗口 ±0.18 s）；
- **Flick 必须有位移**：窗口内一次位移 ≥ `JUDGE.SWIPE_MIN_PX`（16 px，且距上次上报 ≤ `SWIPE_MAX_MS` = 250 ms）的滑动，其线段与判定范围相交即 Perfect；
  不要求滑动**起点**在范围内、一次滑动可同时点亮多个 Flick；纯点击 / 按住不动不判（曾经按「范围内有手指就算」实现过，等于点一下就算划，已改回）；
- **音效时刻**：Drag / Flick 的判定条件可能在音符落线**之前**就满足（手指早按在带里、或提前划过）—— 这时音效要等音符真的落线（`note.timeSec`）再响；落线之后才判定的（最多晚 80 ms）立刻响。Tap / Hold 是玩家主动点出来的，音效就是即时反馈，不推迟。实现：`core/state.js` 的 `pushHit()` 写 `soundTime`，`app/player.js` 用待播队列到点再播；
- **暂停时不再重复判定**：暂停后判定函数返回空数组（以前返回上一帧的 `state.hits`，导致暂停时正好落线的音符**音效每帧循环播放**）。

参考实现的窗口常量：Phira 用 Perfect ±0.08 / Good ±0.16 / Bad ±0.22 秒；phi-chart-render 用 bad 180 ms / good 160 ms / perfect 80 ms —— 两者在 Bad 窗口上不一致，**【待验证】** 哪个等于官方。

### 5.2 计分

**【引用】** 三个独立实现（PhiZone/player、lchzh sim-phi、Phira）给出同一公式：

```
物量 N = 谱面全部**非假音符**数量（Drag 计入；Hold 记 1 个）
score  = round( (900000·Perfect + 585000·Good + 100000·maxCombo) / N )     # 585000 = 900000 × 0.65
Acc    = (Perfect + 0.65·Good) / N
```

- 全 Perfect 恰好 1,000,000（`0.9 + 0.1`）；
- ⚠️ 少数实现（phi-chart-render）把 0.65 放在**连击项**，属少数派；
- ❌「`numOfNotes` 排除 Drag 是评分规则」是误读：官方自 v2.5.0 已移除该字段，物量由游戏实时计算；RPE 编辑器写出的 `numOfNotes` 不含 Hold，只是编辑器行为，**不参与计分**。

分数显示 **【引用】**（v2.3.1 实测）：实时分数 ≥ 1000000 时恒显示 `1000000`；否则显示为 `'0' + (round(score) / 1e5).toFixed(5)` 去掉小数点（例如 7812.5 → `0007813`）。

### 5.3 时间与音频同步

- **【引用】** `谱面时间 = 音乐时间 − offset`；Phira 的表述为「offset 为正时，若音乐同时开始，谱面开始更晚」；
- **offset 的来源按元数据权威顺序仲裁**：official 的包内 `info.csv` / `info.txt` 有 `Offset` 列（游戏读它），
  它优先于谱面 JSON 里的 `offset`；单位是秒（RPE 的毫秒在解析时换算）。实现见 `src/core/meta.js` 的 `readMetaOffset()`；
- RPE 的 `offset` 单位是毫秒，official 是秒，导入时必须换算；
- 官方播放流程：音乐进度到 `音乐时长 − 0.22049 s` 时停止并结算；
- 参考实现提到「mp3 可能产生不可预测的延迟，建议使用 ogg」。

### 5.4 参考实现的关键渲染常数

来源：**lchzh3473/sim-phi**（官方格式模拟器，`src/core.ts` / `src/index.ts`）**【引用】**，与 Phira 的实现互相印证：

| 项 | 值 |
| --- | --- |
| 画面画布 | `画布宽 = min(实际宽, 实际高 × 16/9)`，高 = 实际高（超宽屏加黑边） |
| 判定线贴图 | 6220.8 × 7.68 px（1920×1080 参考），缩放 = 画布高 / 1080 |
| 判定线缩放基准 | `lineScale = H / 18.75`（宽高比 > 4:3；否则 `W / 14.0625`） |
| X / Y 单位（像素） | `0.05625 × 画布宽` / `0.6 × 画布高` |
| 音符贴图归一化 | `noteScaleRatio = 画布宽 × noteScale / 8080`；贴图先按 `8080 / 原图宽` 预缩放 |
| 打击特效 | 缩放 `noteScaleRatio × 6`；Perfect `rgba(255,236,160,0.882)`、Good `rgba(180,225,255,0.922)` |
| 音符过线淡出 | 0.16 s（`alpha = max(1 − (t − t_hit)/0.16, 0)`），与 prpr 的 `FADEOUT_TIME` 一致 |
| 判定区域宽度 | `0.118125 × 画布宽`（= 2.1 X） |
| HL（多押）贴图 | 同一时刻存在 ≥ 2 个音符（按秒比较到 1e-6）且开启多押提示时使用 |
| Hold 打击特效间隔 | 与 bpm 成反比（`(now − lastHit) × holdTime ≥ 1.6e4 × holdSeconds`） |
| 渲染顺序 | 判定线（背景后 → 背景前）→ Hold → Drag → Tap → Flick → 打击特效 → UI |
| floorPosition | 全程用 `Math.fround`（float32）逐项累加 |

### 5.5 官方引擎的行为约束

摘自 Lchzh Docs《实测数据》**【引用】**。生成或保存谱面时必须保证不产生下列情况，否则游戏会卡死或表现异常：

1. 任何一条判定线的事件列表**不能为空数组**（要么不写该字段，要么给出完整事件）；
2. 运行时刻**不能超过任何一条事件列表所有事件的结束时刻**（因此每条列表末尾都要有足够大的哨兵）；
3. 判定线 `bpm` 不能为 0 或负数；
4. 判定线数目不要超过 100（超过会导致音符不再垂直移动、动画中断）；
5. 速度事件列表第一条 `startTime` 应为 0；其它列表第一条 `startTime` 应为 `-999999` 之类的极小值，最后一条 `endTime` 为 `1000000000` 之类的极大值；
6. 事件与上一事件相离时在空隙内做解析延拓；相交时相交部分被忽略（`startTime` 截到上一事件的 `endTime`，保持斜率与 `end` 不变地重算 `start`）；
7. `startTime >= endTime` 的事件被忽略；
8. JSON 读取细节见 §1.7 第 6–8 条；
9. `value = 0` 表示判定线停止（音符冻结），`999` 是常见的瞬移手法，`< 0` 表示音符反向向上飞；
10. 官方引擎读音符的时间复杂度是 **O(n²)**（65536 个音符需约 6 s 打开），事件为 O(n) —— 编辑器与渲染器不要继承这个复杂度。

## 6. 格式能力对比与转换取舍

**【引用】** 转述自 Phichain 文档（✅ 支持 / 🔶 可用其它特性实现 / 🟡 计划中 / 🛑 不支持）：

| 特性 | official | RPE | Phichain |
| --- | --- | --- | --- |
| 音符 / 事件 | ✅ | ✅ | ✅ |
| BPM 列表（变速） | 🛑 | ✅ | ✅ |
| 事件缓动 / 贝塞尔 | 🛑 | ✅ | ✅ |
| Elastic / Steps 缓动 | 🛑 | 🛑 | ✅ |
| 常量事件 | 🛑 | ✅ | ✅ |
| 父子判定线 | 🛑 | ✅ | ✅（除透明度外继承全部） |
| 曲线轨迹音符 | 🛑 | 🛑 | ✅ |
| 音符级事件 | 🛑 | 🛑 | 🟡 |
| 判定线材质 / 锚点 | 🛑 | ✅ | 🟡 |
| 假音符 / 事件层 | 🛑 | ✅ | 🟡 |
| 音符可见时间 / Y 偏移 | 🛑 | ✅ | 🔶 |
| 缓动裁剪（easingLeft/Right） | 🛑 | ✅ | 🛑 |
| 元数据 / 扩展事件 / 遮罩 / UI 绑定 / 音符透明度·大小·自定义打击特效 | 🛑 | ✅ | 🛑 |

Phichain 的 RPE 导入器会忽略 `META` 中除 `offset` 以外的字段、`judgeLineGroup`、判定线的 `extended` / `father` / `numOfNotes` / 各 `*Control` / `zOrder`、事件的 `linkgroup` / `easingLeft` / `easingRight`、音符的 `alpha` / `isFake` / `size` / `visibleTime` / `yOffset`，并把所有事件层合并为一层。该清单可作为「哪些字段是渲染必需、哪些只是编辑器元数据」的参考。

**本项目采用的转换取舍**：

| 转换 | 有损之处 |
| --- | --- |
| official → 内部 | 无（v1 的压缩整数坐标按 Python 取模语义还原） |
| RPE → 内部 | 速度事件的缓动按线性处理，`*Control` / `attachUI` / `isGif` / `hitsound` 播放未实现 |
| 内部 → official | 多层事件相加合并为单层、缓动按 12 段折线近似、扩展事件与 `*Control` 无法表达（丢弃 + 告警） |
| 内部 → RPE | 未实现字段原样写回；alpha 由 0–1 量化到 0–255（误差 ≤ 1/255） |

---

# 第三部分：本项目的实现方案

## 7. 实现映射与差异

### 7.1 内部统一模型

做法：**以 RPE 的概念为超集，official 向它对齐**。official 缺少的能力（变速、事件层、缓动、假音符）在模型里天然是「默认值 / 单层 / 线性」；RPE 缺少的归一化坐标在解析时折算。实现见 `src/core/model.js`、`src/core/units.js`。

| 量 | official | RPE | 内部表示 |
| --- | --- | --- | --- |
| 时间 | `time`（1/32 拍）→ `time/32` 拍 | `Beat = [a,b,c]` → `a + b/c` 拍 | 模型层用**拍**，运行期用**秒**（由 `timeline` 换算） |
| 速度变化 | 每线一个恒定 `bpm` | `BPMList` + 每线 `bpmfactor` | `createTimeline(bpmList, bpmFactor)` |
| 判定线位置 | v3：`start/end`、`start2/end2`（0..1）→ 减 0.5；v1：`1000x+y` | `x/1350`、`y/900` | 以画面中心为原点的比例偏移（y 向上为正） |
| 旋转 | 度，逆时针为正 | 度，顺时针为正 → 取负 | 弧度，逆时针为正 |
| 不透明度 | 0..1 | 0..255 → /255 | 0..1 |
| 下落速度 | Y/s | 值 × 2/9 | Y/s |
| 音符横向位置 | `positionX`（X 单位） | `positionX × 1/75.9375` | X 单位（`1 X = 0.05625 W`） |
| 音符类型 | 1/2/3/4 = Tap/Drag/Hold/Flick | 1/2/3/4 = Tap/Hold/Flick/Drag | `'tap' \| 'drag' \| 'hold' \| 'flick'` |
| 上下方向 | `notesAbove` / `notesBelow` | `above` | `note.above: boolean` |
| Hold 长度 | `holdTime` | `startTime → endTime` | `durationSec` |
| 其它音符属性 | 仅 `speed` | 见 §2.10 | 同名规范字段（`yOffset` 换算成 Y、`visibleTime` 秒或 `Infinity`） |
| `offset` | 秒 | 毫秒 → /1000 | 秒；`谱面时间 = 音乐时间 − offset` |
| 事件层 | 只有一层 | 最多 5 层 | `line.layers[]`，每层含五类事件 |
| 扩展事件 | 无 | `extended.<键>Events` | `line.extended[key]`（已实现键）+ `line.extendedRaw`（原样保留的未实现键） |
| 谱面相机 | 无 | 无（本项目在根节点加 `camera`） | `chart.camera[key]`（谱面级关键帧，与扩展事件同构）；每帧求值出 `state.camera` |

**事件层的求值规则**：只有「含该事件的层」参与求和；所有层都没有该事件时取默认值 —— `x = y = rotate = 0`（画面中心、不旋转）、`alpha = 0`（不显示）、`speed = 1 Y/s`。这与 RPE 的语义一致（层相加、新建判定线自带覆盖全时间的 alpha 事件），也兼容 official「每条线都有 4 类事件数组」的写法。

### 7.2 逐项实现状态

状态口径：✅ 完整可用；🟡 部分实现或与官方/参考实现有已知差异；⬜ 未实现。

**解析层**

| 项 | official | RPE | 说明 |
| --- | --- | --- | --- |
| 格式自动识别 | ✅ | ✅ | 有 `META`/`BPMList` → RPE；有 `formatVersion` 且有 `judgeLineList` → official |
| 位置 / 旋转 / 透明度事件 | ✅ | ✅ | 统一为「中心比例偏移 + 弧度（逆时针正）+ 0..1」 |
| 速度事件 | ✅ | ✅ | 积分成 `PJ(t)`；RPE 速度 × 2/9 |
| 事件层相加 | 只有一层 | ✅ | 只有含该事件的层参与求和 |
| 缓动 | 无（线性） | ✅ 29 种 + 贝塞尔 + 裁剪 | `src/core/easing.js` |
| 速度事件的缓动 | — | ⬜ 按线性 | RPE 162+/170 的语义未实现 |
| 四类音符 | ✅ | ✅ | 抹平编号差异 |
| 上下方向 / Hold 时长 | ✅ | ✅ | |
| 音符速度 / 假音符 / 宽度 / Y 偏移 | 仅速度 | ✅ | `yOffset` 按 × speed 生效 |
| 音符可见时间 | — | 🟡 硬切 | Phira 用渐显，行为略有差异 |
| 音符染色 / 特效染色 / 判定区宽度 | — | 🟡 已解析未使用 | `tint`/`color`、`tintHitEffects`、`judgeArea` |
| 变速 BPM | 每线单一 | ✅ | 统一为 `timeline` |
| 父子判定线 | — | ✅ | 按 §2.6 的 Phira 口径；成环/越界降级为无父线 + 告警 |
| 自定义判定线材质 | — | ✅ | 包内 `Texture` 文件；`isGif` 不支持 |
| 图层顺序 | 按数组顺序 | ✅ `zOrder` | |
| 遮罩 | — | 🟡 `isCover = 1` 时背面音符不渲染 | 近似（真实行为是被线遮挡） |
| `formatVersion` 兼容 | ✅ 1 / 3 / 3473 / 其它 | — | v2 规则按 16:9 假设换算 |
| 包元数据 | `info.txt` / `info.csv` | `META` | `info.csv` 的 `NoteScale` / `BackgroundDim` 已解析未应用 |
| `line.csv` | ⬜ 仅告警 | — | |
| RPE 制谱器专用字段 | — | ⬜ 忽略 | `xybind` / `timeTags` / `multiLineString` / `multiScale` / `chartTime` |
| `anchor` | — | ⬜ 未解析 | |
| `*Control` / `attachUI` | — | ⬜ 未实现 | 解析时合并告警 |

**扩展（故事板）事件**（不分层：每条线的每个键只有一份列表，求值时不与其它层相加）：

| 事件 | 状态 | 本项目的语义 |
| --- | --- | --- |
| `scaleXEvents` / `scaleYEvents` | ✅ | 判定线长度 × scaleX、厚度 × scaleY（内置 `line.png` 口径，1 = 原尺寸，非正数回退 1） |
| `colorEvents` | ✅ | **完全按事件颜色着色**：三通道各按同一缓动插值后直接作为线色（有该事件的线不再显示 AP 金 / FC 蓝 / 白；没有该事件的线保持判定色）。线段两端颜色不同时按**线性渐变**画满整条线 |
| `moveZEvents`（Z 轴位移）**【本项目】** | ✅ | 判定线（含其音符、线长、线厚）沿视线前后移动：RPE 长度单位（900 = 一画面高），正 = 往屏幕内。投影见 §3.5 |
| `thetaEvents`（下落面倾斜）**【本项目】** | ✅ | 绕判定线**长轴**旋转下落面：角度制，正 = 向屏幕内倾；音符沿下落方向到线的屏幕距离按 `cosθ` 缩短（判定线旋转时表现为横向偏移）并按深度缩小，贴图按 `cosθ` 压扁；只影响本线自己的音符（含 Hold 头尾），**子线不继承** |
| 谱面相机 `camera`（根节点）**【本项目】** | ✅ | 谱面级关键帧 `x` / `y` / `z` / `angle`（视角，四个通道各有列表，支持缓动 / 贝塞尔）；每帧求值后供投影使用。见 §3.5.1 与 §7.3 |
| `inclineEvents` / `textEvents` / `paintEvents` / `gifEvents` | ⬜ | 原样保留在 `line.extendedRaw`、导出时写回，界面标注「本版本未实现」 |
| 其它未识别键 | ⬜ | 同上一行（原样保留） |

**渲染与游玩**

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 背景（cover + 模糊 + 压暗 0.4） | ✅ | 结果缓存到离屏画布。WebKit 未实现 `ctx.filter`，检测不可用时改用「缩小 → 放大」近似模糊；压暗一律用不依赖 filter 的黑色叠加层 |
| 判定线绘制 | ✅ | 长 5.76H、厚 0.00711H；白 / FC `#a2eeff` / AP `#feffa9`；多条线用 source-over 合成（等效 `a1+a2−a1a2`）；扩展事件可缩放与着色 |
| （伪）3D 投影 | ✅ | 小孔相机（§3.5）：`k = F/(F + z − Cz)`、`F = 1/(2·tan(视角/2))`，位置与尺寸一起乘 k；`z` / `theta` 事件 + 谱面相机 `x`/`y`/`z`/`angle` 共用同一套公式；缺省参数下与 2D 逐像素一致；打击特效按命中时刻的相机快照定位与缩放 |
| 音符绘制（Tap / Drag / Flick） | ✅ | 普通 / `*HL` 两套贴图；背面音符旋转 180° |
| Hold 绘制 | ✅ | 固定分段（48px 帽 + 48px 光效，按本体裁切）固定高度 + 主体拉伸；切片间重叠 1px 消除接缝；尾部 / 头部随时间收拢；**下落面倾斜时逐行投影成梯形**（`drawTiltedHold`：约 7px 一行、上限 64 行，每行按自己的深度算 k 与位置，行内纵向再乘 `cosθ`），倾斜为 0 时走原来的单次变换路径（逐像素与旧版一致） |
| 打击特效 | ✅ | `assets/hit.png` 7×6 = 42 帧，0.7 s 播完；Perfect 金色 / Good 蓝色；缩放 1.5× 音符宽度；方向恒为屏幕正方向 |
| 特效溅射小方块 | ✅ | 每次命中 4–8 个，颜色同特效、略半透明、三次缓出；随机量由命中记录派生（每帧稳定） |
| 特效锚点与生成窗口 | ✅ | 锚在音符落线时刻的位置；补判落后 > 0.25 s 的旧音符只计分不补特效 |
| Hold 重复特效 | ✅ | 头部命中后每 10 帧重放，直到结束前；不重复播音效 |
| 可见性剔除 | ✅ | `speed×ΔY > 3.3333336` 不渲染；命中后立即消失；漏接的继续下落并淡出；Hold 长度为 0 不渲染 |
| 自动游玩 | ✅ | 音符落线即 Perfect；用于预览与播放器默认模式 |
| 真实游玩（触屏） | ✅ | 判定范围**三档可选**：垂直判定（默认，完全按 2D）/ 轨道判定（跟着相机与 `z` / 倾斜走）/ 全屏判定（见 §7.3，判定带两边各 80% 音符宽）；Tap ±0.08/±0.18/±0.22 s，Hold 无 Bad；多指判定（每根手指独立记账 + `touches` 对账，界面上的手指不拖累别的手指）；Hold **允许换手**，持续时间内判定范围里有任一根手指即算保持、断连 ≤80 ms 接上不算断、提前松手 ≤min(30% 时长, 1 拍) 仍记分、**短于半拍的 Hold 随时松手都不算断**；Drag 需判定时刻有手指在带里；Flick **必须有位移**（≥16 px / 250 ms 的滑动线段与判定范围相交，起点不必在范围内、一次滑动可点亮多个），纯点击不算 |
| 调试叠加层 | ✅ | 设置页两个开关（默认关）：**判定范围**（把每个音符的判定带画成半透明竖条）、**手指位置**（按住屏幕时画小圆点）；实现见 `canvas2d.js` 的 `showJudgeRange` / `showFingers` |
| 浅色模式 | ✅ | 渲染器界面跟随系统 / 浏览器主题（`prefers-color-scheme`，`styles.css` / `start.css` 末尾）：浅色主题下图标与文字转深色，不再「白底白字」；**舞台与 HUD 不跟着变色**（游戏画面始终黑底白字，否则看不清曲绘）。编辑器（`editor.css`）按项目要求固定暗色，并显式声明 `color-scheme: dark`，避免浅色系统下原生控件发白 |
| 计分 / 连击 / ACC / 物量 | ✅ | 按 §5.2 的公式；分数显示用 `0 + 定点` 格式 |
| 打击音效 | ✅ | `assets` 下三种音效；Hold 重复特效不重复播放；加载或播放失败自动静默关闭。Drag / Flick 提前判定时**音效等音符落线再响**（`soundTime` + `player.js` 待播队列）；暂停时不再重复判定（音效不会每帧循环）。⬜ RPE 逐音符 `hitsound` 未播放 |
| 局内 HUD | ✅ | 布局按参考图：**顶部** 5px 进度条（轨道白色 50% 半透明、已播部分纯白）、**左上** 暂停键（白底深色图标）、**正上方** 连击数（大）+ 状态小字、**右上** 分数（下方 ACC）、**左下** 曲名、**右下** 难度；调试信息（时间/FPS/判定数/长条取样）移到底部居中。界面文字与图标固定白色（盖在游戏画面上，不跟随浅色主题）。见 `player.html` + `styles.css` 的 `#hud-*` |
| 字体 | ✅ | `assets/phigros.ttf`（8.8 MB）在**渲染器**里全局使用（`@font-face` + `--font`，中文等缺字形回退系统字体；`font-display: swap`）；开发服务器已为 `.ttf` 补上 `font/ttf` |
| 连击小字（可配置） | ✅ | 连击数下方那行小字默认按状态取值：自动游玩 `AUTOPLAY`、触屏游玩有连击 `COMBO`、其余为空；控制台可自定义（`PhiChartPlayer.setHudLabels({ custom: 'ELEVATED' })`，存 localStorage），实现见 `main.js` 的 `hudLabels` / `comboLabelText()` |
| 评级（φ / V / S / A…） | ⬜ | |
| 开场 / 结束动画 | ⬜ | 按项目范围不做 |
| WebGL2 后端 | ⬜ | 现为 Canvas2D；绘制接口已按后端无关划分 |
| 事件的解析延拓 | 🟡 | 空隙处保持上一事件的末值（官方是在空隙内按斜率延拓） |
| float32 位级还原 | 🟡 | 计算用 float64，仅在浮点末位与游戏有差别 |

**已知差异与取舍**：

- 判定线长度、音符宽度、Phira 速度系数三项的口径分歧见 §3.4 与 §3.1 的 **【待验证】** 说明，本项目的选择均已在上文注明；
- 音符宽度按**可修改的默认值**处理，默认 `W/8`，可由用户调整。对照：prpr ≈0.132 W、phi-chart-render ≈0.118 W（均为资源包口径）、仓库参考效果图实测 ≈0.17 W；
- 判定线颜色由「当前为止的判定质量」决定：无任何非 Perfect → 金色、全连无 Bad/Miss → 蓝色、否则白色。自动游玩必然满分，因此线始终为金色。

### 7.3 判定范围（本项目对「判定区域」的落地）

官方只规定判定区域宽度 `0.118125 W`，未规定纵向范围。本项目在触屏游玩里给出**三档可选**的判定范围（`src/app/main.js` 的 `judgeArea`，记忆在 localStorage）：

| 档位 | 代码 | 含义 |
| --- | --- | --- |
| **垂直判定**（默认） | `band`（`opts.ignore3D = true`） | 完全按 2D 判定：判定带始终是音符在**判定线上的那条列**，相机与 `z` / 倾斜都不参与 |
| **轨道判定** | `tilt` | 跟着画面走：音符被相机 / Z 轴位移 / 下落面倾斜画到哪里，判定带就在哪里 |
| **全屏判定** | `screen` | 点屏幕任意位置都算（不传 `hitTest`） |

共用的实现（`src/render/projection.js`）：

- 位置全部经渲染器投影：`judgeBand()` 给出带中心与半宽，`hitJudgeBand()` 判点、`hitJudgeBandSegment()` 判「滑动是否经过带」；
- 判据只有一条：把点击 / 滑动端点换算到**判定带中心**的局部坐标后，**沿判定线方向的偏移是否在半宽内**。沿下落方向的那一维不参与判断，因此判定线上下两侧无限远都算；
- 半宽 = **音符宽 × 0.8**（两边各 80% 音符宽，判定宽度 = 音符宽的 160%；`JUDGE.BAND_HALF_RATIO`）；
- 判定线旋转时带子跟着转；`positionX` 偏移的音符带子跟着走；Hold 用**头部**所在的列；
- **两档的差别只在 `ignore3D` 上做**：半宽与「列位置」都在 z = 0 空间里算，命中测试把点换成「相对投影后带中心、除以深度缩放 k」再比较，因此两种模式共用同一套判据（实测：`z = 0.5` 屏高时同一条列在两档下的带中心相差 `k = 0.667` 倍的位置）；
- ⚠️ 背面音符的判定范围与同 `positionX` 的正面音符是**同一列**：背面音符只是从另一侧落下、贴图旋转 180°，不会把列镜像到另一边。绘制用的 `localX` 取反，判定必须用取反前的值。

### 7.4 健壮性策略

目标：**任何脏数据都不闪退**；要么取缺省值、要么丢弃并给出可读诊断。分四层实现：

1. **解析层**（`parse-official.js` / `parse-rpe.js` + `sanitize.js`）：容器类型错误视为空并告警、数组内非对象条目逐条丢弃并计数；数值统一走 `num(v, def, {min,max})`（接受数字与数字字符串，`null`/`NaN`/`±Infinity`/对象取缺省值，越界钳制）；同类问题合并成一条告警；缺省值取「保持原状」的一侧（`alpha = 255` 避免整条线消失、`bpm ≤ 0 → 120`、`bpmFactor ≤ 0 → 1`）；语义问题（未知音符类型、`endTime < startTime`、`father` 越界/自引用/成环、缺失事件层）各有明确处理。只有「整个 JSON 不是对象」才抛错。
2. **编译层**（`prepareChart`）：非对象层 / 音符、`startBeat` 非有限 → 丢弃并告警；被丢弃的判定线在数组里置 `null` 以保持 id 与下标一致；同一层同一键的事件区间重叠时逐条告警（最多 8 条）并汇总；记录 `chart.dropped`。
3. **求值层**（`events.js` / `state.js`）：非对象 / 时间非有限 / 值非有限的事件直接跳过（回退默认值）；自定义缓动抛错时退回线性；线的变换量与音符的 `headY` / `tailY` / `renderAlpha` 全部做 `Number.isFinite` 兜底；判定跳过 `timeSec` 非有限的音符（否则游标会卡住）。
4. **诊断展示**：`Diagnostics`（`sanitize.js`）分级收集 `error/warn/info`，同一条消息去重、默认上限 200 条；`chart.diagnostics` 提供 `{ summary, messages }`。

验证方式：`render-tests.mjs` 的「健壮性」小节有 20 余个手写脏数据用例；另外对两套真实样本各做 150 次随机变异（删字段 / 换类型 / 塞入 `null`/`NaN`/`±Infinity`/`1e18`/字符串 / 数组清空或反转 / 插入垃圾），每次跑「解析 → 编译 → 求值 → 判定」，断言 0 次异常、0 个非有限值。

### 7.5 性能设计

| 项 | 做法 |
| --- | --- |
| 事件求值 | 每层每类事件编译成按秒排序的关键帧数组，运行期二分查找 + 插值，**O(log n)**；一帧每条线每种属性只求值一次，不把事件遍历写进音符循环 |
| 判定线高度 | 速度事件对秒积分；分段积分端点取 `t1 − ε`（用 `t === t1` 会因浮点 ulp 把下一段速度采进来） |
| 音符 | 解析时一次性算好 `timeSec` / `durationSec` / `height`，运行期按时间排序 + 游标推进；不做 O(n²) 扫描 |
| 增量重编译 | 编辑器改一条线时只重编译该线（`refreshLine()`），拖动时按 120 ms 节流 |
| 相机求值 | 每帧只求 4 个通道（二分查找 + 插值），结果放在 `state.camera` 上；投影层按 `opts.camera` 取用，不重复求值 |
| 纠错缓存 | 按判定线缓存签名；谱面相机单独占一条（哨兵 `lineId = -1`），改动相机只重扫这一条 |
| 编辑器时间轴 | 只绘制可见时间窗内的事件；事件块趋势线按宽度降细节 |
| 大谱面 | `prepareChart` 仍是全量重编译（1417 音符 + 8.1 万事件约 0.2–0.5 s）；40 MB JSON 的主线程解析约 0.3–1 s |
| 后端 | Canvas2D；已有 `projection` 层隔离「屏幕坐标」与「渲染变换」 |

## 8. 参考项目与许可

本项目在实现过程中**参考了以下项目的文档与行为**，用以核对单位、语义与常数。所有实现代码均为本仓库原创，未复制下列项目的源码。

| 项目 | 用途 | 许可 |
| --- | --- | --- |
| [Phira / prpr](https://github.com/TeamFlos/phira)（`prpr/src/parse/*.rs`、`core/anim.rs`、`core/line.rs`） | 单位换算、速度、事件层相加、缓动的行为参考；父子判定线语义与 RPE 速度事件的处理方式 | GPL-3.0 |
| [Phira Documents](https://teamflos.github.io/phira-docs/) | RPE 格式章节、格式对照表、谱包与资源包约定 | 见 `TeamFlos/phira-docs`（文档仓库 CC-BY-4.0） |
| [lchzh3473/sim-phi](https://github.com/lchzh3473/sim-phi) | official 渲染的具体常数与行为（线贴图尺寸、判定区宽、淡出时间、特效配色、HL 贴图触发） | GPL-3.0 |
| [Lchzh Docs](https://docs.lchzh.top/learning/phigros/)（《Phigros 谱面格式说明》《相关计算》《实测数据》《Re:PhiEdit 谱面格式说明》） | official 字段与单位、事件规范化规则、官方引擎行为约束、RPE 字段与版本标记 | CC-BY-NC-4.0（引用时保留出处） |
| [Phichain](https://github.com/Ivan-1F/phichain)（文档《速度》《谱面格式》） | RPE 速度单位定义、各格式能力对比、RPE 导入器的忽略项清单 | LGPL-3.0（文档另注） |
| 萌娘百科 [Phigros](https://mzh.moegirl.org.cn/Phigros) | 判定窗口、计分公式、各音符玩法 | 见站点声明 |
| [PhiZone/player](https://github.com/PhiZone) 等实现 | 计分公式的交叉印证 | 见各仓库 |

引用与使用约定：

1. 本仓库采用的部分结论来自上表项目，正文均已标注 **【引用】** 与出处；本项目自身以 `packages/` 样本与 `tools/` 脚本复核，标注 **【实测】**。
2. 上述 GPL-3.0 / LGPL-3.0 项目与本项目的许可兼容：本项目整体以 GPL-3.0 发布（见仓库根 `LICENSE`），未复制其代码，仅在行为层面参考。
3. Lchzh Docs 采用 CC-BY-NC-4.0：本仓库转载其结论时保留出处链接，未整段复制原文；如需商用请另行确认。
4. 资源文件与谱面包：`assets/` 下的贴图与音效提取自游戏本体，`packages/` 下的样本为第三方谱面包，均**不在版本库内**。分发本仓库或其构建产物前请自行确认相应权利。

## 9. 待确认清单

需要人工核实后才能作为实现依据的问题：

1. 判定线长度的权威定义（5.76 H vs Phira `lineLength = 6.0`）；
2. Phira 的 RPE 速度系数（约 0.267）与文档语义（2/9）相差约 20% 的原因；
3. 官方判定线颜色与宽度的最终值（不同版本可能存在差异）；
4. RPE 1.7.0+ 与更高版本新增的扩展事件与音符字段（如 `textureEvents` 是否真实存在）；
5. 官方 `formatVersion` 非 1/3 时的坐标规则（文档称「屏幕中心原点、单位 0.1 H」，Phira 直接报错不支持）；
6. 官谱是否已出现 `eventLayers` / `extended` 风格的新布局；
7. 官方音符贴图的实际宽度口径（三处参考实现互不一致，见 §3.4）；
8. 「42 帧打击特效」只对本仓库 `assets/hit.png` 成立；参考实现把帧网格做成资源包参数（Phira `hitFx: [列,行]`，文档示例 [5,6]、默认包 [8,7]），官方帧数未验证；
9. Hold 打击特效循环间隔的官方口径（实测与判定线 bpm 成反比）；
10. 第三方「统一格式」PhiCommonChart（<https://docs.nuanr-mxi.com/>）是否需要支持；
11. 官方 PBC 格式（Phira 支持但文档未完善）。

## 10. 复现方式

```powershell
# 谱面结构画像（两种格式通用）
node tools/inspect-chart.mjs "packages\白复生 AT（official格式）\Chart_AT #3649.json" > tools\profile-official.txt
node tools/inspect-chart.mjs "packages\领土战争AT（RPE格式）\29519800.json" > tools\profile-rpe.txt

# 关键公式的数值验证（floorPosition 逐条比对、RPE 字段分布）
node tools/deep-check.mjs            # 输出 tools/deep-findings.txt

# 贴图与几何测量
node tools/sample-colors.mjs          # 贴图主色采样
node tools/measure-trim.mjs           # 本体 bbox 与光效外扩（TEXTURE_TRIM 表的来源）
node tools/measure-hold-structure.mjs # Hold 贴图逐行 alpha / 颜色 / 宽度

# 离屏渲染（无浏览器即可查看渲染结果）
node tools/render-frame.mjs --help
```

`packages/` 下的两份谱面包是第三方资源，不在版本库内；缺少时相关脚本与测试用例会自动跳过（判定依据见 `tools/samples.mjs`），按该文件给出的目录名与文件名自行放入即可。

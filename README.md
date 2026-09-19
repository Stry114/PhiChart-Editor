# PhiChart Editor

Phigros 谱面渲染器 + 制谱器。仓库现状：**规格文档齐全 + 第一版渲染器（v1）+ 编辑器骨架可运行**。

| 入口 | 说明 |
| --- | --- |
| `start.html` | 开始页：打开项目 / 谱面包、新建项目、内置测试项目 |
| `index.html` | 播放器：只播放与查看谱面 |
| `edit.html` | 编辑器：时间轴编辑（选择 / 拖动 / 参数面板 / 事件曲线） |

## 快速开始

### 启动

**方式 A（Windows 一键，推荐）**：双击项目根目录的 `启动渲染器.cmd`。它会自动找到 Python、启动内置开发服务器、打开浏览器，并把**局域网可用地址**一并打印出来（服务器日志就在那个窗口，Ctrl+C 结束）。

**方式 B（手动）**：在项目根目录执行，然后打开 <http://127.0.0.1:8099/start.html>：

```powershell
python tools/dev_server.py                 # 默认 8099，监听 0.0.0.0（局域网可访问）
python tools/dev_server.py --host 127.0.0.1 # 只允许本机访问
python -m http.server 8099                 # 不推荐，见下方说明
```

> **为什么用自己的服务器**：`python -m http.server` 不发任何缓存头，浏览器会对 ES 模块与谱面 JSON 做启发式缓存，
> 于是很容易出现「页面已经更新、但某个 `.js` / 谱面还是旧的」这种混搭状态 —— 表现是改了没反应、面板显示旧值、
> 结构树层数对不上…… 排查起来极费时间。`tools/dev_server.py` 显式发 `Cache-Control: no-store`，从根上避免这类问题。

### 局域网访问（平板 / 手机 / 另一台电脑）

服务器默认监听 `0.0.0.0`，启动时会列出可用地址，例如：

```
LAN      : 同一局域网的其他设备用这些地址打开
           http://192.168.1.23:8099/edit.html
           首次运行 Windows 防火墙会弹窗，要选「允许访问」其他设备才连得上
```

- 只需本机可访问：`set PHICHART_HOST=127.0.0.1 && 启动渲染器.cmd`
- 换端口：`set PHICHART_PORT=8100 && 启动渲染器.cmd`
- 机器上可能有多个网卡（WSL / Hyper-V 虚拟网卡也会列出来），选和对方同一网段的那个 IP。
- ⚠️ 这是开发服务器，**整个项目目录**（含 `assets/`、`packages/`）都会对局域网可见，只在可信网络里开。

### 打开仓库里的测试包

服务器启动后，开始页里有两个**内置示例包按钮**，点一下即可（会自动读取 `packages/` 下的谱面、音频、曲绘）：

| 按钮 | 包目录 | 谱面 | 规模 |
| --- | --- | --- | --- |
| 白复生 AT（official） | `packages/白复生 AT（official格式）` | `Chart_AT #3649.json`（25.8 MB） | 24 线 / 1156 音符 / 174 BPM / 161.7 s |
| 领土战争 AT（RPE） | `packages/领土战争AT（RPE格式）` | `29519800.json`（40.8 MB） | 24 线 / 1417 音符 / 8.1 万事件 / 140 BPM / 150.9 s |

其它载入方式（不受 `file://` 限制）：

- **选择谱面包目录** → 选 `packages/白复生 AT（official格式）` 或 `packages/领土战争AT（RPE格式）` 整个文件夹；
- **拖拽**：把包文件夹或 zip 直接拖到窗口里；
- **选择 zip 谱面包**：把包压成 zip 后选它（内置解压，无需第三方库）；
- **只选谱面 JSON**：只加载谱面本体（没有音乐/曲绘，用于快速看结构）。

播放器里按 `空格` 播放；`←/→` 跳转 5s、`R` 重开、`[` `]` 倍速、`N` `M` 调音符宽度（默认 W/8）。
编辑器的界面与操作（时间轴、选择与拖动、详情面板、两级缓动、事件曲线）见 [docs/06-编辑器.md](docs/06-编辑器.md)。

长条（Hold）分段是**硬编码**的：源像素 `[48px 光效][48px 尾帽][主体][48px 头帽][48px 光效]`（见 `src/render/textures.js` 的 `TEXTURE_TRIM`），
不做运行时识别、也不考虑换资源包；贴图一律取 `assets/`。

## 分发与路线图

### 分发：GitHub Pages 静态托管

- **形态**：纯静态资源，**零构建步骤**，直接把文件推到 Pages 即可；本地开发用 `启动渲染器.cmd`（`tools/dev_server.py`）。
- **为什么合适**：Pages 走 **HTTPS**，因此后续要用到的安全上下文能力（Service Worker / PWA 离线、File System Access 直接读写本地文件）都可用 —— 这是局域网 http 给不了的。
- **本站点已经准备好了**：仓库里带了 `.github/workflows/pages.yml`（**白名单部署**，只发布应用本体，默认排除 `packages/`）与 `.nojekyll`。
  在 GitHub 上把仓库的 Settings → Pages → Source 选成 **GitHub Actions**，之后每次推送到 `main` 就会自动发布。
- **站点内容与体积**：不含 `packages/`（约 140 MB 的第三方谱面包）时站点只有几 MB；Pages 对文本资源会自动 gzip。
- **⚠️ 公开仓库前的授权问题**：`assets/`（提取自游戏的贴图与音效）与 `packages/`（第三方谱面包）都**不属于自有资源**。
  - `packages/` 已经**在 git 历史里**了（早先的提交），所以仓库一旦公开就等于公开了这些内容 —— 若在意，需 `git rm -r --cached packages` 并重写历史（`git filter-repo`）或改用一个干净的新仓库。
  - `assets/` 是渲染必需的最小资源（3 MB）。要么接受现状，要么替换成自制/占位贴图，并在工作流里排除它（工作流里有注释说明怎么改）。
  - 不想公开：仓库设为 private 并把 Pages 也设为私有需要 GitHub Pro；免费账号的 Pages 只能来自公开仓库。
- **多端访问**：同一 URL 在电脑 / 平板 / 手机都能打开（播放端已按 DPR 与宽高比自适应）；触屏编辑属后期。
- **其它分发形态**（按需再做，不在当前计划内）：单文件离线 HTML（内联 JS/CSS/贴图，可 `file://` 双击直开，谱面包用文件夹/zip 载入）、桌面封装（Tauri/Electron，换取原生文件管理与无 CORS 限制）。

### 内部保存格式：自有项目格式（不以 RPE 作为存储格式）

- **决定**：内存真值继续用现有的统一模型（`src/core/model.js`）；磁盘上用**自有的、带版本的项目格式**（`.pce.json`），official / RPE 只作为**导入与导出**的互操作格式。
- **理由**：① RPE 并非开源格式；② 计划加入专属功能，需要一个能无损容纳它们的自有格式；③ 用 RPE 存盘会在往返中丢信息（未实现的扩展事件、`*Control`、`attachUI`、`isGif`、`anchor`、`line.csv` 等）。
- **格式草案**：`{ format: "phichart-project", version: 1, editor: {...}, meta, timing, lines: [{ name, layers, notes, extensions, editor: {...} }] }`；
  编辑器专属数据放 `editor` / `extensions` 里，导出成 official / RPE 时按规则丢弃并在导出报告里列出。
- **序列化要点**：只写「源数据」（拍、值、缓动类型/参数、贝塞尔点），**跳过所有运行时编译产物**（`rt`、`easingFn`、`timeSec`、判定状态等），保证重新读入后能完整重编译。
- **导出**：official（formatVersion 3，线自带 bpm、单一事件层）与 RPE（事件层、Beat 数组、毫秒 offset）各一个 writer；导出前跑一遍现成的诊断系统，把会被丢弃的字段汇总成报告。
- **验证**：往返测试 —— `parse(export(项目))` 与源模型在关键字段上一致（音符数/时间/位置/事件数/缓动）。

### 编辑器持久化与自动保存（可行性结论：可行）

分三层，按可靠性递增：

1. **IndexedDB 草稿**（任何源都可用）：编辑改动**去抖 1–2s** 后写快照，保留最近若干个版本，启动时检测到未保存草稿就提示恢复；可用 `CompressionStream('gzip')` 压缩后再存。注意 iOS Safari 会在长期不用时回收站点数据，因此**只能当草稿缓存，不能当唯一存储**。
2. **File System Access 直接写文件**（需安全上下文，GitHub Pages / localhost 满足）：`showSaveFilePicker` / `showDirectoryPicker` 拿到文件句柄后即可真正「自动保存到原文件」；不支持的浏览器退回「导出/下载」。
3. **文件句柄持久化**：把句柄存进 IndexedDB，重开页面后一键恢复上次编辑的文件（权限需用户再确认一次）。

实现细节约定：自动保存只写**项目格式**（无损），不反复写 official/RPE（有损）；仅在有未保存改动时写；`visibilitychange` / 页面隐藏前兜底 flush 一次。

### 路线图（阶段目标）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | **反向序列化**：项目格式读写 + official/RPE 导出 | 往返测试通过；导出文件能被本项目与游戏/编辑器读入 |
| 2 | **持久化与自动保存**：IndexedDB 草稿 + 文件句柄 + 导出 | 关掉页面重开能恢复未保存改动；可直接覆盖原文件保存 |
| 3 | **编辑 UI**（**进行中**）：时间轴、轨道、选择与拖动、吸附、详情面板、事件曲线页 | ✅ 骨架可用（见 [docs/06-编辑器.md](docs/06-编辑器.md)）；⬜ 撤销栈、新建对象、导出闭环 |
| 4 | **增量重编译**：现在 `prepareChart` 是全量重编译，改为按线/按音符增量 | 大谱面（40 MB JSON）编辑时不卡顿 |
| 5 | **性能**：同屏数千音符时切到预留的 WebGL2 后端 | 目标帧率达标 |
| 6 | **按需项**：触屏编辑、PWA 离线、单文件离线版、桌面封装 | — |

编辑器与播放器是**同一个静态应用的两个入口**（`index.html` 播放 / `edit.html` 编辑 / `start.html` 开始页），共用 `src/core` + `src/render`，因此上面任何一种分发方式都自动覆盖编辑器。

## 测试

```powershell
node tools/render-tests.mjs        # 解析 / 单位与公式 / 判定计分 / 父子线 / zip / info.csv / 缓动语义（141 项）
node tools/render-smoke.mjs        # 渲染路径 + 投影拾取 + 长条几何 + 命中特效与溅射方块（50 项）
node tools/app-smoke.mjs           # 播放器应用层：启动 / 载入示例包 / 播放计分 / 交互 / 错误提示（26 项）
node tools/start-smoke.mjs         # 开始页：打开项目 / 新建 / 内置测试项目（23 项）
node tools/editor-smoke.mjs        # 编辑器：布局 / 时间轴 / 选择与拖动 / 详情面板 / 曲线页 / 性能约定（282 项）
node tools/browser-check.mjs       # 真浏览器自检（Edge/Chrome 无头，两种窗口尺寸，161 项）—— 控件可点、曲线不拉伸、画布不压扁
node tools/http-smoke.mjs http://127.0.0.1:8099   # 页面/模块/示例包 URL（需先起服务器）
```

`browser-check` 是唯一能查出「浏览器里才算数」那类问题的工具（控件被布局挤到点不到、Canvas/SVG 被拉伸、窗口宽度变化后不重排、旧脚本被缓存）。它需要本机有 Edge 或 Chrome，没有就跳过。

离屏诊断工具（无浏览器也能看渲染结果）：`tools/render-frame.mjs`（帧渲染器）、`frame-sweep.mjs`、`hold-sheet.mjs`、`fx-preview.mjs`、`probe-frame.mjs`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [格式说明.md](格式说明.md) | 项目目标、包结构、单位对照表、核心数学、渲染规格、计分、官方引擎怪癖、存疑清单 |
| [docs/01-官方格式规格.md](docs/01-官方格式规格.md) | official 格式的字段级规格（类型/单位/默认值/版本差异/规范化规则） |
| [docs/02-RPE格式规格.md](docs/02-RPE格式规格.md) | RPE 格式的字段级规格（Beat、事件层、29 种缓动、扩展事件、Controls、类型编号差异） |
| [docs/03-渲染与数学.md](docs/03-渲染与数学.md) | 速度积分与音符位置公式、剔除规则、判定/计分、音频同步、性能设计、参考实现常数 |
| [docs/04-参考资料与工具.md](docs/04-参考资料与工具.md) | 参考资料（含链接与可信度）、格式能力对比、分析工具用法、网络环境说明 |
| [docs/05-渲染器实现.md](docs/05-渲染器实现.md) | **v1 渲染器**：兼容两套格式的内部统一模型、渲染管线、已实现/未实现清单、测试与下一步 |
| [docs/06-编辑器.md](docs/06-编辑器.md) | **编辑器**：界面结构、时间轴交互、详情面板与两级缓动、事件曲线、数据流、已知缺口、开发工具 |

## 目录结构

```
start.html / start.css         开始页（打开项目 / 新建 / 测试项目）
index.html / styles.css        播放器页面与暗色 UI
edit.html / editor.css         编辑器页面与暗色 UI
src/core/                      内部统一模型、两套格式解析器、事件/时间/计分/元数据
src/render/                    Canvas2D 渲染后端与贴图处理
src/app/                       播放器、主循环与 UI 绑定
src/editor/                    编辑器：布局、时间轴、预览、结构树、详情面板、事件曲线
src/ui/                        共用 UI：图标、跨页交接（IndexedDB）、项目生成器
src/start/                     开始页逻辑
tools/                         解析/渲染/编辑器测试、真浏览器自检、开发服务器、谱面画像与测量
assets/                        音符/打击特效贴图与打击音效（提取自游戏）+ assets/icons、assets/notes（编辑器用）
packages/                      调试谱面包（official 与 RPE）——非自有资源，不随站点发布
.github/workflows/pages.yml    GitHub Pages 白名单部署
渲染效果图.png                  渲染结果参考图（与 docs/05 §4.2 的视觉常量对应）
```

> 文档中所有结论都标注了来源：`[实测]`（本仓库脚本验证）、`[文档]`（外部权威来源，附链接）、`[未验证]`（待确认）。
> 修改结论时请一并更新标记与出处。

> ⚠️ 公开仓库 / 发布站点前请注意：`assets/`（提取自游戏的贴图与音效）与 `packages/`（第三方谱面包，合计 140+ MB）都**不属于自有资源**。
> `packages/` 已经在 git 历史里，仓库一旦公开就等于公开了这些内容；处理办法与工作流里的排除开关见上文「分发：GitHub Pages 静态托管」。

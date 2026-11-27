# dsh-imagegen Issue / PR 分析与修改报告

- 仓库：`dickpy/dsh-imagegen`
- 分析基线：`origin/main` `8b6ce53`（v1.22.1，2026-11-26 发布）
- 本地工作区：`eea1f45`（v1.22.0，落后 `origin/main` 3 个提交；实施前先同步）
- 数据时间：2026-11-27 19:35（Asia/Shanghai）
- 数据来源：GitHub REST API（`gh` CLI，仓库 owner 账号），共 67 个 issue、40 个 PR
- 实施状态：已在 `unified-issue-fixes` 分支统一实现（#109/#105/#108/#106/#107/#104），版本号未改、未发布；测试结果见 [本地测试报告](local-test-report-2026-11-27.md)

---

## 一、结论摘要

当前仓库处于“迭代快、待办少、但新回归集中”的状态：67 个 issue 中只有 4 个未关闭，40 个 PR 中 37 个已合并，issue 中位关闭时间约 1.1 天，PR 中位合并时间约 0.3 天。打开的事项全部集中在 2026-11-26 之后，说明最近一次 v1.22.0 / v1.22.1 的侧栏接管与结果区布局改动带来了新的反馈。

**建议按以下顺序处理：**

| 顺序 | 事项 | 类型 | 结论 | 目标版本 |
|---|---|---|---|---|
| 1 | [#109](https://github.com/dickpy/dsh-imagegen/pull/109) | 回归修复 | **立即合并**：v1.22.0 接管侧栏时把 macOS 交通灯带与品牌行一起隐藏，属于阻塞性视觉回归 | v1.22.2 |
| 2 | [#108](https://github.com/dickpy/dsh-imagegen/issues/108) | Bug | **优先修**：大图自定义路径下载概率性 0 字节，根因在 `data:` URL 下载链路，改动小、收益直接 | v1.22.3 |
| 3 | [#105](https://github.com/dickpy/dsh-imagegen/pull/105) | 体验改进 | **审核后合并**：结果卡片按原图比例显示，直接解决 #106 截图中的大面积空白 | v1.22.3 |
| 4 | [#106](https://github.com/dickpy/dsh-imagegen/issues/106) | 体验改进 | 放大预览层 + 调整关闭按钮位置；结果卡片比例部分由 #105 解决 | v1.22.3 |
| 5 | [#107](https://github.com/dickpy/dsh-imagegen/issues/107) | 体验改进 | 参数栏改抽屉式过渡、去掉重复箭头；历史分组/拖拽另立 PR | v1.22.3 / v1.23.0 |
| 6 | [#104](https://github.com/dickpy/dsh-imagegen/issues/104) | 新 Provider | 需要新增 Cloudflare Workers AI 原生协议适配，非配置项可解决 | v1.23.0+ |
| — | [#102](https://github.com/dickpy/dsh-imagegen/pull/102) | 社区 PR | **不建议按现状合并**：与 #105 重叠，且未更新 `result-layout` 单元测试，合并后测试必挂；建议关闭并致谢，必要时拆分 | — |

一句话总结：**先合并 #109 止血，再修 #108 的下载正确性，然后用 #105 + #106 收掉结果区/预览区的观感问题；#107 的抽屉动效可以做，#104 的 Cloudflare 适配要单独立项。**

---

## 二、项目现状数据

### 2.1 总量与状态

| 指标 | 数值 |
|---|---:|
| Issue 总数 | 67 |
| Open Issues | 4 |
| Closed Issues | 63 |
| PR 总数 | 40 |
| Open PRs | 3 |
| Merged PRs | 37 |
| 最新 Release | v1.22.1（2026-11-26） |
| Issue 中位关闭时间 | 1.1 天 |
| PR 中位合并时间 | 0.3 天 |
| 2026-11 新增 Issue | 30 |

### 2.2 Open Issues

| # | 标题 | 类型 | 作者 | 创建时间 |
|---|---|---|---|---|
| [#108](https://github.com/dickpy/dsh-imagegen/issues/108) | 无限画布下载图片时手动选择保存路径，概率性生成 0 字节空文件 | Bug | LingYingNX | 2026-11-26 15:06 |
| [#107](https://github.com/dickpy/dsh-imagegen/issues/107) | 这里布局可以改一下 | Enhancement | LingYingNX | 2026-11-26 13:20 |
| [#106](https://github.com/dickpy/dsh-imagegen/issues/106) | 希望放大后的图片会更大一些 | Enhancement | LingYingNX | 2026-11-26 13:11 |
| [#104](https://github.com/dickpy/dsh-imagegen/issues/104) | 能适配一下 Cloudflare Workers AI 吗？ | Enhancement | yumoii789 | 2026-11-26 12:14 |

### 2.3 Open PRs

| # | 标题 | 作者 | 规模 | 状态 |
|---|---|---|---|---|
| [#109](https://github.com/dickpy/dsh-imagegen/pull/109) | fix(侧栏): 接管生图左栏时保留窗口按钮带与品牌行 | tianji-qingtian | +57 / -174，5 文件 | `MERGEABLE` / `CLEAN`，CI chromium 通过 |
| [#105](https://github.com/dickpy/dsh-imagegen/pull/105) | 让生图结果卡片贴合原图比例 | dickpy | +235 / -115，6 文件 | `MERGEABLE` / `UNSTABLE`；最新提交 chromium 通过，早期提交失败已修复 |
| [#102](https://github.com/dickpy/dsh-imagegen/pull/102) | 对图片进行了排版 | LingYingNX | +353 / -74，7 文件 | `MERGEABLE` / `UNSTABLE`，无 CI 检查 |

### 2.4 历史问题主题（按最近 issue 归纳）

- **UI / 侧栏 / 布局类最多**：#107、#106、#101、#97、#98、#92、#91、#79、#75、#53、#51、#37、#20、#8、#7。侧栏和结果区是反复出现回归的区域，说明宿主 DOM 适配需要固定的多平台截图回归。
- **Provider / 协议兼容类其次**：#104、#86、#80、#63、#57、#56、#35、#29、#10、#12、#73、#99。新协议通常需要独立 adapter，不能只靠增加一个 OpenAI 兼容地址。
- **安装 / 分发类**：#90、#41、#36、#33、#32、#9、#2。最近 #90 的安装失败已关闭，但说明桌面 profile 与 pnpm 环境仍是外部用户的主要门槛。
- **历史 / 迭代 / 存储类**：#94、#88、#89、#96、#79。v1.19.0—v1.20.0 已完成“连续编辑、参考图持久化、历史分页”的主链路。

### 2.5 近期已合并 PR 主线

| PR | 内容 | 对应版本 / 日期 |
|---|---|---|
| [#103](https://github.com/dickpy/dsh-imagegen/pull/103) | 侧栏 launcher 行在打开工作室时不再跳动，并保持选中态 | v1.22.1 / 2026-11-26 |
| [#100](https://github.com/dickpy/dsh-imagegen/pull/100) | 重试防重复扣费、收藏存储加固、短批次报告 | v1.21.1 / 2026-11-23 |
| [#96](https://github.com/dickpy/dsh-imagegen/pull/96) | 历史记录底部分页（每页 10 组）并发布 v1.20.0 | v1.20.0 / 2026-11-21 |
| [#95](https://github.com/dickpy/dsh-imagegen/pull/95) | 保留生成历史、恢复历史结果板和模型列表交互 | v1.20.0 / 2026-11-21 |
| [#93](https://github.com/dickpy/dsh-imagegen/pull/93) | 历史浏览后恢复结果板、模型下拉内滚动不关闭 | v1.20.0 / 2026-11-21 |
| [#89](https://github.com/dickpy/dsh-imagegen/pull/89) | 连续编辑、参考图持久化、历史版本分支 | v1.19.0 / 2026-11-17 |
| [#87](https://github.com/dickpy/dsh-imagegen/pull/87) | 暗色主题适配与设置页保存栏贴底 | v1.19.0 / 2026-11-17 |

这条主线说明：结果卡片/历史/连续编辑的底层能力已经比较完整，当前 open issue 主要是**布局观感、下载健壮性和新 Provider 适配**，不是核心链路缺失。

---

## 三、Issue 详细分析与修改方案

### 3.1 #108：无限画布下载图片概率性 0 字节

**状态**：Open · Bug · P1（数据正确性）

**现象**

- 无限画布中生成约 7.5 MB PNG，点击下载后手动选择桌面路径，概率性得到 0 字节文件（空文件 SHA-256 为 `E3B0C442...`）。
- 同一张图不选路径、用默认下载目录时得到 7,499,673 字节的完整文件；大图更容易出现。
- 用户环境：插件 v1.22.1，DSH Web GUI / Windows。

**代码核对**

当前存在至少三条互不一致的下载路径：

1. `src/client/result-board.ts:21-28` 的 `downloadImage()`：`anchor.href = data:${mime};base64,${b64}`。这是 issue 中提到的 `lib/client.js` 约 5412 行对应的实现。
2. `src/client/ImageGenPanel.tsx:3884-3892` 的 `downloadGeneratedImage()`：同样拼 `data:` URL，和 `downloadImage()` 重复。
3. `src/client/CanvasWorkspace.tsx:1726-1735` 的 `downloadNode()`：使用 `asset.url`，但给 `<a>` 设了 `target="_blank"`，`download` 属性在部分浏览器组合下会被忽略，且没有利用宿主已经支持的 `?download=0`。

此外：

- 预览层下载按钮 `src/client/ImageGenPanel.tsx:3813-3819` 直接把 `srcOf(previewImage)`（`data:` URL）交给 `<a download>`；
- 画廊批量下载 `src/client/ImageGenPanel.tsx:2214-2223` 直接使用 `image.url`，没有统一 helper；
- 宿主 asset 路由 `src/routes.ts:1489-1523` 已经支持 `?download=0` 并把响应设为 `application/octet-stream` + `Content-Disposition: attachment`，画布节点可以直接使用该入口；
- `src/client/image-toolview.tsx:297-313` 已有 `URL.createObjectURL(blob)` 的正确先例，可以复用同一模式。

**根因判断**

7.5 MB PNG 转 base64 后约 10 MB；Chromium 在对 `data:` URL 执行“另存为”时，浏览器要先创建目标文件再解码/写入大体积 data URL，存在竞态。默认下载目录路径走的是更短的内部流程，所以正常；自定义保存路径更容易触发 0 字节。问题不在上游生成，也不在历史存储，而在浏览器端下载实现。`target="_blank"` 和重复实现会进一步放大不同入口的差异。

**修改方案**

1. 在 `src/client/result-board.ts` 增加统一的 `downloadBlob(blob, filename)`：
   - 用 `Uint8Array` 从 base64 解码；
   - `new Blob([bytes], { type: image.mime })`；
   - `URL.createObjectURL(blob)`；
   - `<a download>` 点击后延迟回收对象 URL（建议 60 秒，覆盖保存对话框时间）；
   - 不使用 `data:` URL。
2. 把 `downloadImage()` 改为调用 `downloadBlob`；`ImageGenPanel.tsx` 的 `downloadGeneratedImage()` 删除，统一 import `downloadImage`。
3. 预览层下载从 `<a href={srcOf(...)} download>` 改成按钮 + `downloadImage(previewImage, filename)`，避免再走 data URL。
4. `CanvasWorkspace.downloadNode()`：
   - `link.href = `${asset.url}?download=0``；
   - 删除 `link.target = '_blank'`；
   - 如仍需兼容桌面壳对 blob/anchor 的限制，改为 `fetch(asset.url).then(r => r.blob()).then(blob => downloadBlob(blob, name))`。
5. 画廊批量下载统一调用 `downloadImage` 或 `downloadBlob`，不要直接使用 `image.url`。

建议补丁骨架：

```ts
// src/client/result-board.ts
function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 保存对话框可能异步读取；过早 revoke 会让部分浏览器写成 0 字节。
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function downloadImage(image: GeneratedImage, name: string): void {
  downloadBlob(new Blob([bytesFromBase64(image.b64)], { type: image.mime }), `${name}.${extensionOf(image.mime)}`)
}
```

**验收标准**

- 7.5 MB PNG 在自定义保存路径下连续下载 20 次，文件大小与 `image.b64` 解码后的字节数完全一致，无 0 字节；
- 默认目录、桌面、其他磁盘路径均正常；
- 结果卡片、预览层、右键菜单、画廊批量、画布节点五个入口行为一致；
- 浏览器 `download` 事件的文件名、扩展名、字节数均有断言覆盖。

**测试计划**

- 在 `scripts/studio-browser-test.mjs` 或新增 `scripts/download-browser-test.mjs` 中监听 Playwright `download` 事件，读取 `download.path()` 并断言文件大小；
- 用 7.5 MB 以上 fixture 覆盖大图路径；
- 保留现有 `scripts/smoke.mjs` 对 canvas asset 路由 `Content-Disposition` 的检查。

**工作量 / 风险**：0.5—1 人日；低风险。唯一注意点是 `URL.createObjectURL` 在 jsdom 中不存在，纯 DOM 测试需 mock 或把 `bytesFromBase64` 单独导出做单测。

---

### 3.2 #107：布局改抽屉式、去掉重复箭头

**状态**：Open · Enhancement · P2（体验）

**诉求拆解**

1. 参数面板收起/展开太生硬，希望“像抽屉一样把左侧栏挤走”，而不是瞬间闪现；
2. 面板左上角的收起箭头与宿主侧栏的收起箭头重复，右边那个可以去掉；
3. 后续会另提 PR：左侧历史栏做文件/项目分类，支持图片拖拽归档。

**代码核对**

- `src/client/panel.module.css:776-831`：
  - `.config` 是一个 `width: clamp(240px, ..., 480px)` 的 flex 列；
  - `[data-collapsed='true']` 直接把宽度改成 `38px`，且 `> :not(.configHeader) { display: none }`，没有任何 transition，所以视觉上是瞬间跳变。
- `src/client/ImageGenPanel.tsx:2728-2741`：收起按钮 `.configToggle` 放在 `.configHeader` 右上角，正好贴近宿主侧栏的折叠按钮；截图 107-c 中左侧的 `›` 是宿主侧栏 opener，右侧的 `‹` 是插件自己的按钮，两者相邻造成“重复箭头”的观感。
- `src/client/panel.module.css:319-354`：侧栏接管（`data-dsh-imagegen-sidebar-takeover`）同样是 `display: none` 硬切，没有入场/退场动画。

**修改方案**

1. **参数栏抽屉过渡**
   - 给 `.config` 增加 `transition: width 180ms ease, min-width 180ms ease, max-width 180ms ease`；
   - 拖动 resizer 时给 `.config` 加 `data-resizing="true"`，并在该状态下 `transition: none`，避免拖拽延迟；
   - 把非 header 内容包一层 `.configBody`，收起时用 `opacity: 0; transform: translateX(6px)` 过渡，展开时反向，避免内容先消失；
   - `@media (prefers-reduced-motion: reduce)` 下全部取消动画。
2. **去掉重复箭头**
   - 推荐把 `configToggle` 从 `.configHeader` 移到 `panelHeaderActions`（`ImageGenPanel.tsx:2684-2709`），使用“面板/侧栏”图标或文字按钮“参数”，不要再用与宿主相同的 `‹` 箭头；
   - 或者在宿主侧栏存在折叠 opener 时隐藏插件按钮（`html[data-dsh-frame][data-sidebar-collapsed] .configToggle { display: none }`），但这会牺牲参数栏的独立收起能力，不如移到 header。
3. **侧栏接管的入场动效**
   - 给 `.sidebarHistoryHost` 增加 `animation: dsh-history-slide-in 180ms ease-out`（`translateX(-12px)` + `opacity 0` 到 `translateX(0)` + `opacity 1`）；
   - 不直接改宿主 grid 宽度，避免破坏 Islands 等皮肤的 grid-template-rows/columns；视觉上已经是“从左侧抽屉出来”的效果，风险最低。
4. **历史分组/拖拽（后续独立 PR）**
   - 数据层：`StoredEntry` 增加可选 `folderId?: string`，`index.json` 增加 `folders?: { id, name, createdAt }[]`；旧数据无需迁移；
   - UI：历史侧栏增加文件夹树/分组标题，`draggable` 图片卡片 `dragstart` 写入 entry id，文件夹 `dragover/drop` 调用 `PATCH` 或新 route 更新 `folderId`；
   - 建议作为 v1.23.0 功能项单独评审，不与本次动效补丁混在一起。

**验收标准**

- 点击参数栏收起按钮，宽度在约 180 ms 内从当前宽度过渡到 38px，没有瞬间跳变；展开同理；
- 拖拽 resizer 时无过渡延迟；
- 面板 header 区域只保留一个收起/展开控制，视觉上与宿主侧栏 opener 不再并排；
- `prefers-reduced-motion` 下无动画；
- 侧栏接管打开时历史面板有轻微滑入，不影响宿主按钮带和品牌行。

**测试计划**

- 新增 Chromium 测试：记录点击前后多个时间点的 `getBoundingClientRect().width`，断言存在中间值（证明动画）；
- 截图对比 107-b/107-c 场景：箭头不重叠、面板 header 不跳动；
- 现有 `sidebar-takeover-dom-e2e` 继续通过。

**工作量 / 风险**：动效 + 箭头 0.5—1 人日；历史分组/拖拽 3—5 人日。风险主要是宿主/皮肤 DOM 差异，建议只做面板自身动画，不直接改宿主 grid。

---

### 3.3 #106：放大后的图片更大、画布更大

**状态**：Open · Enhancement · P2（体验）

**现象拆解**

- 截图 106-a：结果区两张图并排，卡片被拉伸到整行高度，图片只占上方一部分，下面是大块空白。这是结果卡片没有按原图比例收缩，属于 #105 要解决的核心问题。
- 截图 106-b：打开图片预览后，图片显示区域约 1000×560，用户认为在 27 寸屏幕上太小，希望“画布”更大；还提到换到 24 寸屏幕后更局促。
- 106-c 评论：预览右上角的关闭按钮离 Windows 窗口关闭按钮太近，容易误触，希望往左下移一些。

**代码核对**

- `src/client/panel.module.css:3181-3195`：`.lightboxClose` 固定在 `top: 16px; right: 16px`，正好在窗口右上角热区。
- `src/client/panel.module.css:3229-3237`：`.lightboxFigure` 固定 `max-width: min(1100px, calc(100vw - 160px))`、`height: min(820px, calc(100vh - 48px))`；在 2068px 宽窗口上最多只用约 53% 宽度。
- `src/client/studio-results.module.css:102-126`：`.grid` / `.row` 用 `flex: 1 1 0` 填满高度，卡片被拉高，`object-fit: contain` 导致图片上下留白；PR #105 已用 `ResultSheet` + 容器查询修复。

**修改方案**

1. **预览层尺寸**
   - 把 `.lightboxFigure` 改为随视口：
     ```css
     width: min(1680px, calc(100vw - 96px));
     max-width: min(1680px, calc(100vw - 96px));
     height: min(1200px, calc(100vh - 40px));
     ```
   - 同步调整 `.lightboxNav[data-dir='prev'/'next']` 的 `left/right: max(20px, calc(50% - 840px))`，避免导航按钮贴边。
   - 保持现有 720px 以下的移动端规则。
2. **关闭按钮位置**
   - 改到 `top: 44px; right: 64px`（或 `inset-block-start: calc(env(titlebar-area-height, 0px) + 12px)` + `inset-inline-end: 56px`），并保持最小 44×44 点击区域；
   - 保留 `Escape` 和点击空白关闭，避免用户只能依赖 X。
3. **结果卡片比例**
   - 直接合并 #105；不要在本 issue 里再写一套 CSS，否则两套布局方案会冲突。
4. **如果用户指的是无限画布工作区**
   - 建议另做“专注模式”：一键收起参数栏（#107）或对话栏，让画布接近全宽；这比单纯放大 lightbox 更符合“画布更大”的诉求。按 106-b 截图，主诉求仍是预览层尺寸。

**验收标准**

- 2560×1440、1920×1080、1440×900 三种视口下，预览图片区域宽度 ≥ 视口宽度的 55%（大图时），且无横向滚动；
- 关闭按钮与窗口右上角至少保持 48px 距离，点击热区不小于 44×44；
- 106-a 场景：两张结果卡片高度贴合图片比例，无大块空白（由 #105 覆盖）。

**测试计划**

- Playwright 截图三档视口，断言 `.lightboxFigure` 尺寸和关闭按钮坐标；
- 现有 `scripts/studio-browser-test.mjs` / `history-browser-test.mjs` 继续跑；
- 人工在 24/27 寸显示器各验证一次。

**工作量 / 风险**：0.5 人日；低风险。注意 4K 屏幕上设上限 1680px 仍可能被用户认为小，可后续加“适应窗口 / 100%”切换。

---

### 3.4 #104：适配 Cloudflare Workers AI

**状态**：Open · Enhancement · P3（新 Provider）

**结论**

可以做，但**不是加一个 OpenAI 兼容地址就能解决**。Cloudflare Workers AI 的图像模型通过 `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}` 调用，每个模型的请求/响应 schema 不一致，且没有统一的 `/models` 列表；需要新增一个原生协议 adapter。

**模型差异（已核对 Cloudflare 官方文档）**

| 模型 | 请求 | 响应 | 图生图 |
|---|---|---|---|
| `@cf/black-forest-labs/flux-1-schnell` | JSON `{ prompt, steps?, seed? }` | JSON `{ result: { image: base64(JPEG) } }` | 不支持 |
| `@cf/stabilityai/stable-diffusion-xl-base-1.0` | JSON `{ prompt, width, height, num_steps, guidance, image_b64? }` | 二进制 `image/png` 流 | 支持 img2img / mask，但官方标记 2026-11-20 已弃用 |
| `@cf/black-forest-labs/flux-2-dev` / `flux-2-klein-*` | multipart 表单（含图片输入） | JSON `{ result: { image: base64 } }` | 支持多图输入（后续阶段） |

**修改方案（分阶段）**

1. **协议层**
   - `src/protocol.ts:29-55`：增加 `'cloudflare'` 到 `ChannelProtocol` / `ChannelProtocolPreference`，保留旧值默认行为；
   - 或在 `ChannelConfig` 增加 `preset: 'cloudflare-workers-ai'` 并让 engine 按 preset 分派，避免污染所有渠道的协议枚举。推荐后者更稳。
2. **模型目录**
   - `src/model-catalog.ts:11` 增加 `'cloudflare'` family；
   - `describeFamily()` 增加 `/^@cf\//` 识别；
   - `supportsEdit` 按具体模型区分（flux-1-schnell false；flux-2-dev true），`supportsAspectRatio` 可标记为 true（映射 width/height），质量档位不适用。
3. **Engine adapter**
   - 新增 `generateCloudflareImage()`，参考 `generateQwenImage()` / `generateMiniMaxImage()` 的结构（`src/engine.ts:1233-1352`、`1361+`）；
   - 在 `generateImage()` 的 dispatch（`src/engine.ts:1606-1639`）中优先按 preset/family 分派；
   - 处理两种响应：
     - `content-type: application/json` → 解析 `result.image` base64；
     - `content-type: image/*` → `arrayBuffer()` 转 base64；
   - `n > 1` 用并行单图请求；`size` 比例映射为 256—2048 的 width/height；`quality` 忽略并提示。
4. **设置与发现**
   - `src/presets.ts` 新增 `cloudflare-workers-ai` 预设：apiUrl 使用 `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run`，模型预填 `@cf/black-forest-labs/flux-1-schnell`；
   - 设置页检测模型按钮对 Cloudflare 跳过或提示“该渠道需手动维护模型目录”（没有 `/models` 图像目录）。
5. **文档/范围**
   - 第一版只承诺 **flux-1-schnell 文生图**；SDXL base 已弃用，不建议作为主推；
   - 图生图、FLUX.2 multipart 放在第二版；
   - README 写清 Account ID 放在 apiUrl、Token 放 apiKey，以及各模型能力差异。

**验收标准**

- Mock 测试：JSON 响应（flux-1-schnell）和二进制响应（SDXL）都能转成 `GeneratedImage`；
- 真实 smoke：用户提供 Account ID + Token 后，flux-1-schnell 生成成功，面板显示正确模型/尺寸；
- 图生图选择 flux-1-schnell 时明确提示“不支持编辑”，不发出无效请求；
- 设置页保存/重载后渠道配置不丢失。

**工作量 / 风险**：3—5 人日；中高风险。Cloudflare 模型 schema 变动频繁，建议先做单模型适配并标 `experimental`，不要一次性承诺全模型。

---

## 四、PR 审核与处置

### 4.1 #109：接管侧栏保留窗口按钮带与品牌行（建议立即合并）

**变更内容**

- 删除 `markTakeoverSurfaces()` 中对 `logoRow` 和 `topStrip` 的隐藏标记；
- 接管时只隐藏真正占高度的两行：全局面板列表与“新会话”行；
- 删除收起按钮浮动到 `top:8px/right:8px` 的规则，让它留在品牌行；
- 删除 Islands 皮肤把前两行栅格收成 `0 0` 的规则；
- 更新三语设置提示和 `sidebar-takeover-dom-e2e` 断言。

**审核意见**

- 这是对 v1.22.0 的明确回归修复：v1.22.0 release note 自己写了“品牌行与收起按钮暂时让位”，但实际把 macOS 交通灯预留带一起隐藏，导致历史面板从 y=0 开始画；#109 恢复宿主 chrome，符合 #51 的历史修复方向。
- 移除的 `SIDEBAR_TOGGLE_*` 常量、清理逻辑、CSS 规则在仓库中没有残留引用；`SIDEBAR_CHROME_ATTR` 仍用于 New Session 行，语义一致。
- 测试从“隐藏品牌、浮动按钮”改成“保留品牌行、按钮留在行内、Islands 顶部 8px+36px 保留”，覆盖了新行为。
- 唯一代价是历史区少约 90px 高度；但面板列表/新会话仍隐藏，装插件不会再压缩历史，#101 的目标保持不变。

**结论**：**Approve & merge**。建议作为 v1.22.2 的唯一代码改动发布，发布说明写“修复 v1.22.0 接管侧栏时 macOS 交通灯带/品牌行消失的回归（#101 后续）”。

### 4.2 #105：结果卡片贴合原图比例（建议合并）

**变更内容**

- 新增 `src/client/ResultSheet.tsx`，实时结果、历史记录、素材详情共用同一结果网格；
- 卡片按原图比例在格子里缩放，旧记录缺少宽高时从已加载图片读取；
- 两张横图在宽栏并排；结果区宽度 ≤420px 且高度足够时上下堆叠；
- 三图保持两上一下，四图 2×2，长批次保留滚动；
- 新增 `history-browser-test.mjs`、`studio-browser-test.mjs` 回归。

**审核意见**

- 复用了现有 `planResultLayout` 的固定分块表，不改 `result-layout.ts` 的契约，因此不会破坏 `scripts/result-layout.test.mjs`；这是与 #102 最大的区别。
- `keepFullCell` 用于 pending/failed/missing/historyError，避免加载中/失败卡片被压扁；`onImageLoad` 从 `naturalWidth/naturalHeight` 补旧记录的尺寸，兼容性考虑完整。
- CSS 用 `container-type: size` + `@supports (width: 1cqh)` 渐进增强；不支持容器查询的环境退回旧布局，不会硬坏。
- 最新提交 `02d9d86` 的 `chromium` check 通过；早先 `812fd93` 失败是修正前提交，不能算当前问题。`mergeStateStatus=UNSTABLE` 主要来自重复 push 触发的 cancelled workflow，不是代码失败。
- 需要人工确认：`revisedPrompt` 的 `figcaption` 固定 32px 高度是否覆盖当前单行省略样式（`panel.module.css:3096-3106` 是 nowrap，应该够）；4K/24 寸屏幕和窄侧栏都跑一遍。

**结论**：**建议合并**，排在 #109 之后（两者文件不冲突，先后都可）。合并时在 release note 里感谢 #102 作者对卡片布局的启发，避免社区贡献被忽略。

### 4.3 #102：社区排版 PR（不建议按现状合并）

**变更内容**

- 重写 `result-layout.ts`：从固定分块表改为按图片宽高比 + 面板宽度动态选择列数；
- 新增 `src/client/result-measure.ts`（`useSheetSize`、`useResultAspects`）；
- 修改 `ImageGenPanel`、`StudioResults`、`panel.module.css`、`studio-results.module.css`、`templates.module.css`；
- 把模板入口从浮动按钮改为结果角落的 pill。

**审核发现**

1. **现有单元测试会失败**：`scripts/result-layout.test.mjs` 仍断言 `planResultLayout()` 返回 `{ rows, scroll }`；#102 把返回类型改成 `{ rows, boxes }`，且未修改这个测试文件。合并后 `pnpm test:unit` 中所有 `plan()` 断言都会失败。
2. **没有 CI 检查**：PR 没有 GitHub Actions 运行记录，无法证明 typecheck/build/e2e 通过；作者也在 body 里说“还有一些 UI 布局下次弄”，属于 WIP。
3. **与 #105 重复**：两者都改 `ImageGenPanel` / `StudioResults` / `studio-results.module.css`，但实现路线不同。一个用固定分块 + 卡片 fit（#105，改动小、测试绿），一个重写 planner + 动态测量（#102，改动大、无测试）。同时合并会产生严重冲突。
4. **可保留的部分**：`templates.module.css` 的模板入口从浮动按钮移到结果角落，可能是独立的体验改进；如果维护者喜欢，可让作者单独提一个小 PR。

**结论**：**关闭 #102 并致谢**，标注 `superseded by #105`。如果作者愿意继续贡献，建议在 #105 合并后基于最新 main 重做动态测量版本，并先补 `result-layout.test.mjs`、`result-measure` 单测和 Chromium 回归。不要直接关闭而不解释，社区 PR 需要明确反馈。

---

## 五、建议的代码修改清单（按文件）

| 文件 | 修改内容 | 关联 |
|---|---|---|
| `src/client/result-board.ts` | 新增 `downloadBlob` / `bytesFromBase64`，`downloadImage` 改用 Blob URL；延迟 revoke | #108 |
| `src/client/ImageGenPanel.tsx` | 删除重复 `downloadGeneratedImage`，统一 import；预览层下载改按钮；`configToggle` 移到 header | #108 / #107 |
| `src/client/CanvasWorkspace.tsx` | `downloadNode` 使用 `asset.url?download=0`，去掉 `target=_blank` | #108 |
| `src/client/panel.module.css` | `.config` 宽度过渡 + `data-resizing`；`.sidebarHistoryHost` 入场动画；`.lightboxFigure` 放大；`.lightboxClose` 左下移 | #106 / #107 |
| `src/client/ResultSheet.tsx` / `StudioResults.tsx` | 合并 #105，统一结果卡片比例 | #105 |
| `src/client/studio-results.module.css` | #105 的 `.cell` / `data-fit-image` / container query | #105 |
| `src/model-catalog.ts` | 增加 Cloudflare family 与模型识别 | #104 |
| `src/presets.ts` | 增加 `cloudflare-workers-ai` 预设 | #104 |
| `src/engine.ts` | 新增 `generateCloudflareImage` 并接入 dispatch | #104 |
| `src/protocol.ts` | 如采用协议枚举方案，增加 `'cloudflare'`；否则仅扩展 preset 类型 | #104 |
| `scripts/sidebar-takeover-dom-e2e.mjs` | #109 已更新，保持 | #109 |
| `scripts/result-layout.test.mjs` | 若跟进 #102 动态布局，需重写；#105 不需要 | #102 |
| `scripts/studio-browser-test.mjs` / `history-browser-test.mjs` | 增加大图下载、卡片比例、预览尺寸断言 | #105 / #106 / #108 |

---

## 六、测试与验收计划

### 6.1 必跑基线

```bash
pnpm typecheck
pnpm test:unit
pnpm test:history
pnpm test:studio:browser
pnpm test:history:browser
```

### 6.2 按改动追加

| 改动 | 追加验证 |
|---|---|
| #109 | `node scripts/sidebar-takeover-dom-e2e.mjs`；macOS 桌面版实跑，Islands 皮肤；Windows caption row 截图 |
| #105 | `scripts/history-browser-test.mjs`（旧记录尺寸、横图并排/堆叠、横竖混排、四图比例）；1440×840 与 420px 窄栏 |
| #108 | 7.5 MB / 10 MB 大图下载事件，断言文件字节数；五个下载入口逐一验证 |
| #106 | 2560×1440、1920×1080、1440×900 预览截图；关闭按钮坐标 |
| #107 | 点击收起按钮的宽度采样（动画中间帧）；`prefers-reduced-motion`；重复箭头截图 |
| #104 | mock fetch 两种响应；真实 Cloudflare flux-1-schnell smoke；无 Account ID / Token 的错误提示 |

### 6.3 多平台矩阵

- macOS Desktop：交通灯带、品牌行、Islands 皮肤；
- Windows Desktop：caption row、自定义保存路径、窗口关闭按钮附近点击；
- DSH Web：Chromium 最新版；
- 视口：1280×800、1440×900、1920×1080、2560×1440。

---

## 七、发布建议

### v1.22.2（建议今天/明天）

- 仅包含 **#109**；
- 发布说明：修复 v1.22.0 “生图接管左侧栏”在 macOS 下遮住交通灯、隐藏品牌行的问题；历史面板从品牌行下方开始，收起按钮回到原位；
- 请 issue #101 报告者与 Islands 皮肤用户复验。

### v1.22.3（建议本周）

- **#108** 下载修复；
- **#105** 结果卡片比例；
- **#106** 预览层尺寸 + 关闭按钮；
- **#107** 参数栏抽屉动效 + 去重箭头（历史分组/拖拽不进这个补丁）。

### v1.23.0（下一功能版）

- **#104** Cloudflare Workers AI（先 flux-1-schnell 文生图，标 experimental）；
- **#107** 历史文件/项目分类 + 拖拽（等作者 PR）；
- 可考虑把 #105 的 `ResultSheet` 扩展到电商/批量结果，统一所有结果面。

---

## 八、风险与注意事项

1. **先同步本地工作区**：当前 `E:\dsh-plugin` 在 `eea1f45`（v1.22.0），`origin/main` 已到 `8b6ce53`（v1.22.1，含 #103 的 launcher 修复）。实施前执行 `git fetch origin && git merge origin/main` 或新建 worktree，否则会基于旧 CSS 行号改错位置。
2. **#109 与 #105 的顺序**：两者文件基本不重叠，但都涉及 `panel.module.css` 的不同段落；建议 #109 先合并，减少后续 rebase。
3. **#102 不要直接合并**：除了与 #105 冲突，`result-layout.test.mjs` 的契约变更未同步，合并会破坏单测；如要采纳动态布局，先补测试再评审。
4. **#108 不要只修一个入口**：issue 提到“无限画布”，但实际存在 result-board、ImageGenPanel、CanvasWorkspace、预览 anchor、画廊批量五条下载路径；只改一条会留下同样的 0 字节问题。
5. **Cloudflare 模型生命周期**：SDXL base 官方已标记 2026-11-20 弃用，不要把旧模型写进默认预设；先做 flux-1-schnell，后续按用户需求扩展 FLUX.2 multipart。
6. **动画可访问性**：所有新增 transition/animation 都要加 `prefers-reduced-motion: reduce` 分支，避免影响对动效敏感的用户。
7. **发布节奏**：仓库最近 10 天连续发布 v1.17.x—v1.22.1，维护者响应很快；建议把 #109 作为 hotfix 单独发，不要和 #104 这类大改动混版，降低回滚成本。

---

## 九、建议回复 / 沟通话术

### 9.1 回复 #108

> 已定位到下载实现：当前用的是 `<a download>` + `data:image/...;base64`，7.5 MB 的图会膨胀到约 10 MB 的 data URL，Chromium 在“另存为”自定义路径时存在创建文件与写入内容的竞态，所以概率性出现 0 字节。计划改为 Blob URL，并统一结果卡片、预览、画廊批量、画布节点的下载入口；下个补丁版修复。感谢提供文件大小和 SHA-256，便于回归验证。

### 9.2 回复 #104

> Cloudflare Workers AI 不是 OpenAI 兼容图像接口，每个图像模型的请求体和响应格式都不同（flux-1-schnell 返回 JSON base64，SDXL 返回二进制流，FLUX.2 还是 multipart），需要单独的原生 adapter。计划先支持 `@cf/black-forest-labs/flux-1-schnell` 文生图（需要 Account ID + API Token），图生图和更多模型后续按需求扩展；不会把它伪装成普通 OpenAI 渠道。

### 9.3 回复 #106

> 结果卡片比例问题由 #105 处理（卡片按原图比例收缩，不再整行拉伸）。预览层会放宽到接近全屏，并把右上角关闭按钮往左下移，避免和 Windows 窗口关闭按钮误触；24/27 寸屏幕都会做回归。

### 9.4 回复 #107

> 参数栏收起会改成抽屉式宽度过渡，收起按钮从参数栏 header 移到面板 header，避免和宿主侧栏的折叠箭头并排重复。历史文件/项目分类和拖拽是独立功能，欢迎单独提 PR，我们会按 v1.23.0 规划评审。

### 9.5 回复 #102（社区 PR）

> 感谢这个 PR 对结果卡片排版的探索，#105 已经借鉴了其中的卡片布局思路。当前 #102 与 #105 改动范围重叠，且 `result-layout.test.mjs` 还停留在旧的 `{ rows, scroll }` 契约，直接合并会让单测失败，所以先不合并。欢迎在 #105 合并后基于最新 main 重推动态测量方案，或把模板入口、任务托盘这些不重叠的改动拆成小 PR。

---

## 附录 A：本次分析使用的关键代码位置

| 主题 | 文件 / 行号（基线 `origin/main` 8b6ce53） |
|---|---|
| 下载实现 | `src/client/result-board.ts:21-28`、`src/client/ImageGenPanel.tsx:3813-3819`、`src/client/ImageGenPanel.tsx:3884-3892`、`src/client/CanvasWorkspace.tsx:1726-1735` |
| 画布 asset 路由 | `src/routes.ts:1489-1523` |
| Blob URL 先例 | `src/client/image-toolview.tsx:297-313` |
| 参数栏折叠 | `src/client/panel.module.css:776-831`、`src/client/ImageGenPanel.tsx:2728-2741` |
| 侧栏接管 | `src/client/panel.module.css:319-354`、`src/client/sidebar-entry.ts:180-230` |
| 预览层 | `src/client/panel.module.css:3181-3195`、`3229-3237`、`src/client/ImageGenPanel.tsx:3719-3826` |
| 结果区布局 | `src/client/studio-results.module.css:102-126`、`src/client/result-layout.ts` |
| Cloudflare 相关 | `src/protocol.ts:29-55`、`src/model-catalog.ts:11`、`143-155`、`src/presets.ts:31-129`、`src/engine.ts:1606-1639` |

## 附录 B：数据口径

- Issue 总数不包含 PR；GitHub `gh issue list --state all` 返回 67 条。
- “中位关闭时间”按 63 个已关闭 issue 的 `closedAt - createdAt` 计算；“中位合并时间”按 37 个已合并 PR 的 `mergedAt - createdAt` 计算。
- 标签统计：30 个 `enhancement`、22 个 `bug`、1 个 `question`、14 个未标签。
- 本报告只分析当前仓库状态，不代表上游 Cloudflare / DSH 宿主的未来版本承诺。

---

*报告结束。*

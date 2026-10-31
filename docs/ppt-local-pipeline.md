# 图片转可编辑 PPT · 本地确定性管线（设计）

目标：把「图片转可编辑 PPT」从「无头 Agent 自由发挥」改为**插件宿主进程驱动的确定性管线**。
文字坐标来自 OCR 测量，文字内容与图形判断来自一次多模态模型调用，拼装/校验/合成全部交给上游
`editppt` CLI。不再依赖 Agent 的 shell 权限、子 Agent 能力与审批入口（Windows 上正是这些环节挂了）。

## 为什么

现有链路（v1.11.0）：`ppt.fromImages` → 起无头 Agent → Agent 读 SKILL.md → Agent 自己调 `editppt`。
实测问题：
- 无头 Agent 在 workspace-write 沙箱里起不了 shell（`0xC0000142`），任务空转到超时；
- headless 会话里审批无处可点，任务永远显示「正在执行工具」；
- 产物只校验 ZIP 结构与页数，整页位图也会被判定 `completed`；
- 默认 20 分钟超时对「单页 10+ 分钟」的量级根本不够。

本管线里插件自己就是编排者：`editppt` 由宿主进程直接 spawn（与 `editppt doctor` 同一通道，已验证可用），
模型只负责「看图 + 出结构化判断」，每页 1 次调用 + 最多 2 次修复。

## 阶段

```
queued → preparing(逐页落盘 + editppt prepare)
       → per page: hints 合成草稿 manifest → 模型判断 → 合并 manifest → page build → page validate
                   → (失败则把 validation 报告回灌模型，最多 repair 2 次) → run record
       → finalizing(run finalize)
       → accepting(统一验收入口)
       → completed / failed / cancelled
```

## 模块与接口（新增/修改）

### `src/ppt-deck-pipeline.ts`（新）

```ts
export interface DeckPipelineDeps {
  /** 绝对路径：venv 里的 editppt 可执行（PptRuntime.command() 提供）。 */
  editppt: () => Promise<string>
  /** 宿主进程执行命令（复用 skill-config.runCommand）。 */
  run: (argv: string[], options: { cwd: string; timeoutMs?: number }) => Promise<{ code: number; output: string }>
  /** 多模态模型（复用 SkillRunner 的 chat seam）。 */
  chat: SkillChatBackend
  /** 读取本机 skill 的参考文档（manifest 字段契约），缺失时用插件内置精简版兜底。 */
  readSkillDoc: (relative: string) => Promise<string | undefined>
  /** 每页并发数（1-3，默认 2）。 */
  concurrency: () => number
  /** 单页预算（毫秒），超时只失败该页并重试/跳过策略由上层决定。 */
  pageBudgetMs: () => number
  onEvent: (event: { time: number; label: string; state: 'running' | 'done' | 'warning'; page?: number }) => void
  signal: AbortSignal
}

export interface DeckPipelineResult {
  deckPath: string          // final/*.pptx
  reportPath: string        // final/validation.json
  runSummaryPath: string    // final/run_summary.json
  previews: string[]        // pages/page_NNN/preview.png
  pages: Array<{ page: number; state: 'recorded' | 'failed'; objects: number; warnings: string[] }>
  runDirectory: string
}

export async function runDeckPipeline(
  inputs: Array<{ path: string; name: string }>,   // 已按幻灯片顺序落盘的图片
  runDir: string,
  options: { offlineOcr: boolean; language: string },
  deps: DeckPipelineDeps,
): Promise<DeckPipelineResult>
```

### `src/ppt-deck-check.ts`（新，纯函数，便于单测）

```ts
export interface DeckInspection {
  slides: number
  textRuns: number          // 全部 <a:t> 数量
  nativeShapes: number      // 非图片形状（sp 且无 blipFill）
  pictures: number
  fullBleedPictures: number // 覆盖 >= 85% 页面积的 p:pic
}
export function inspectDeck(buffer: Buffer): DeckInspection | undefined  // 不是合法 pptx → undefined
export function acceptDeck(input: {
  inspection: DeckInspection | undefined
  expectedSlides: number
  reportPassed: boolean
}): { ok: true } | { ok: false; reason: 'invalid-package' | 'slide-count' | 'report-not-passed' | 'raster-only' }
```

验收规则（**唯一入口**，直接交付与恢复交付都必须过）：合法 OOXML；页数 == 输入页数；
`final/validation.json.passed === true`；每页至少 1 个文本 run 或 1 个原生形状；
且不允许「整页位图当页」：某页只有 picture 且 `textRuns == 0` → `raster-only` 拒绝。

### 模型契约（每页一次）

输入给模型的内容（顺序固定，图片在前）：
1. `pages/page_NNN/source.png`
2. `pages/page_NNN/text_hints.png`（有则给）
3. 文本：OCR 行列表 JSON（`box_px`、`height_px`、`font_size_pt`、`text`（Paddle 模式才有））
4. 文本：插件内置的精简 manifest 字段契约 + 页面尺寸

模型**只输出一个 JSON**（无 markdown、无解释）：

```json
{
  "background": { "type": "color", "value": "#FFFFFF" },
  "shapes": [ { "kind": "rect|roundRect|ellipse|line|arrow", "box": [x1,y1,x2,y2],
                "fill": "#RRGGBB|null", "stroke": "#RRGGBB|null", "stroke_pt": 1.5 } ],
  "pictures": [ { "box": [x1,y1,x2,y2], "source_box": [x1,y1,x2,y2], "label": "照片/插画描述" } ],
  "text": [ { "hint_index": 0, "content": "识别出的文字" } ]
}
```

插件侧合并规则（**决定可靠性**）：
- 文本框位置/字号**只来自 text_hints**（模型不得改坐标）；`hint_index` 提供内容，模型没给的行按 OCR `text`，
  两者都缺 → 该行不生成（避免编造）。
- `shapes` 由模型给粗框，插件按 hints 对齐修正；`pictures` 一律是**从 source.png 裁剪**的区域
  （确定性裁图，不调用任何生图 API），因此照片页也能出片，代价是照片本身仍是位图。
- 背景：默认纯色（取四角采样），`type: "image"` 不接受（防整页位图）。

这样模型输出量小、坐标不可幻觉，`editppt page validate` 仍会兜底，错误回灌最多 2 次。

## 视觉还原层（实测后补：像素测量兜底）

真页面上模型经常一个图形都不给，只靠模型 = 白底加几行字（用户实测反馈）。现在视觉层由
`src/ppt-visual-regions.ts` 从像素测出来，与模型判断并列、不被模型否决：

1. 半分辨率 `MEDIANCUT` 量化成 12 色调色板；**背景 = 边框 3px 一圈里出现最多的 index 的中位 RGB**
   （不再用四角平均：装饰页会把背景采成脏色，实测过 `#6A6371` 这种错值）。
2. 每个非背景 index 做 8-邻域连通域；丢弃 <0.4% 面积或 bbox 边 <28px 的碎块；坐标 ×2 回到源图像素。
3. 度量与分类：`color_spread`=该 index 像素 RGB std 均值，`text_share`=OCR 文本框在该 bbox 内占比，
   短边 <30px → `line`；`spread < 8 或 text_share > 0.4` → `panel`（落原生形状，填充取中位色）；
   其余 → `bitmap`（从 `source.png` 确定性裁剪）。
4. **文本行中心落在 bitmap 区域内 → 不再生成文本框**（文字留在图里，避免重影）；panel 内文字仍保留可编辑。
5. `visualMode`：`hybrid`（默认，允许整页级区域走 `editppt image edit` 的 clean base，
   `source_type:"imagegen"`——上游唯一许可的整页背景做法）、`regions`（零图像额度；此时整页底图无法还原，
   该页**明确失败**并说明原因）、`text`（只重建文字）。整页级 bbox（≥85% 页面积）在 `user-provided`
   下会被上游判违规，所以不能当普通贴图塞进去。
6. 用了 clean base 的页**不再叠加位图裁剪**（clean base 保留插画，重复裁剪就是重影）；表格/图表/照片属于
   「会被 clean base 擦掉的贴片」，仍然裁剪保留。
7. 逐页上报 `panels / bitmaps / lines / fidelity / sourceInk`，宿主写进任务卡片
   （「图形 9 · 贴图 2 · 视觉还原 79%」，<60% 追减低还原提示）。`fidelity` 管线内是 0-1 比率，宿主 ×100 上报。
8. 验收新增 `visual-loss`：`sourceInk ≥ 8%` 的页如果成片里既没有贴图也没有几何形状
   （**文本框不算几何形状**，`txBox="1"` 被排除），整次转换判失败——就是为了堵死「只有文字」被当成成功。

## 执行方式开关

`pptExecutionMode`: `'local' | 'agent'`，默认 `local`（本管线）。`agent` 保留现有无头 Agent 路径，
在 `SettingsCard` 的技能区暴露；`local` 不需要长任务开关/子 Agent/审批。

## 与现有代码的接缝

- `src/skill-runner.ts`：`runPpt` 仍建 `CanvasSkillTask`、串行队列、`PptTaskStore` 检查点不变；
  PPT 分支改为调用 `runDeckPipeline`，`progress.events` 用现有标签键（`ppt.activity*`），
  `phase` 复用 `preparing/running/collecting`，新增 `finalizing`。
- 产物发布：`collectHeavyOutput` 的 PPT 分支改为「验收后再发布」（先跑 `acceptDeck`，再 `putFile`），
  并递归 `final/` 目录，避免 `output/final/xxx.pptx` 判 `noDeck`。
- 失败出口：模型不可用 / editppt 非 0 退出 / 单页 repair 用尽 → 明确 `failed` + 可读原因 + 保留 runDirectory 诊断。
- 超时：`skillHeavyTimeoutMinutes` 默认 20 → 90；`local` 模式另设每页预算 `pptPageBudgetMinutes`（默认 6）。

## 不做（本版本）

- 不调用任何生图 API 做背景修复/前景抠图（`editppt image generate/edit`）——留待后续作为可选增强；
- 公式 LaTeX 重建、演讲者备注保留、PDF/PPTX 输入（仍只接受 1-12 张 PNG/JPEG/WebP）；
- 上游 skill 的 `page-decision-tree.md` 全部规则（本管线用简化且可验收的子集）。

## 使用前提（用户视角）

1. 「生图配置 → 图片转可编辑 PPT」装好 skill 与运行环境（Python 3.10+，`editppt doctor` 全绿）。
2. 「提示词增强」配置一个**支持视觉**的聊天模型（API 地址 + 模型名）。留空或选了纯文本模型时，
   转换按钮会直接禁用并写明原因（`ppt.noVisionModel`），不会启动一个空转到超时的付费任务。
3. 可选：PaddleOCR token。配了 → 文字内容与行框更准；没配 → 离线检测只给位置与尺寸，
   文字内容完全依赖模型识读，质量下降但仍可出片。
4. 本地模式不再需要：长任务开关、无头 Agent 预设、文件/命令权限、子 Agent、审批入口。

## 实测记录（2026-10-30，Windows Desktop）

- 2 页输入（1600×900 中文业务页，在线 OCR + `gpt-6.1-sol` 视觉判断）：**50 秒**出片，
  `final/validation.json.passed = true`，验收 `acceptDeck` 通过；
  第 2 页实测 10 个文本框 + 5 个自绘形状，标题 40pt、三张卡片标题横向分布于
  x=0.87/4.96/9.02 in、y≈2.78 in，与源图一致，`pictures = 0`（不是贴图糊弄）。
- 同一渠道探测：`api.xlinks.site` 接受 `image_url`，`cf.api.fan` 对 `gpt-6.1-sol` 返回 503
  （无可用渠道）——所以「可读图的聊天模型」是真实前提，不是可选项。
- 复现脚本：`node scripts/ppt-pipeline-selftest.mjs`（stub 模型 + 真实 CLI）与
  `node scripts/ppt-pipeline-live-test.mjs <图片...>`（真实模型 + 真实 CLI，密钥只在本机进程内使用）；
  `node scripts/ppt-chat-vision-probe.mjs <model>` 用来一次性确认渠道是否吃 `image_url`。
- 已知 Windows 侧坑（本管线已处理）：上游预览渲染器字体候选全是 macOS 路径，中文预览会渲染成空白，
  因此 manifest 需要带 `preview_font`；`slide.background` 必须写成 `#RRGGBB`；
  manifest 必须是**无 BOM** 的 UTF-8；`run record` 需要页目录里的七件套文件且 `agent-id` 与 dispatch 一致。


# dsh-imagegen

<p align="center">
  <a href="https://www.npmjs.com/package/@dickpy/dsh-imagegen"><img src="https://img.shields.io/npm/v/@dickpy/dsh-imagegen?color=cb3837&logo=npm&label=npm" alt="npm" /></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg" alt="License" /></a>
  &nbsp;
  <a href="https://github.com/dickpy/dsh-imagegen"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827" alt="Platform" /></a>
</p>

<p align="center">
  <img src="docs/images/imagegen-overview.png" alt="dsh-imagegen AI image studio" width="100%" />
</p>

<div align="center">

让 Agent 把想法变成图片，并在成图上继续迭代。

**生成 → 查看 → 加入对话 → 继续编辑**，在同一条工作流里完成。

[快速开始](#quick-start)&nbsp;&nbsp;·&nbsp;&nbsp;[核心工作流](#workflow)&nbsp;&nbsp;·&nbsp;&nbsp;[多模型对比](#compare)&nbsp;&nbsp;·&nbsp;&nbsp;[工作台](#studio)&nbsp;&nbsp;·&nbsp;&nbsp;[模板库](#templates)&nbsp;&nbsp;·&nbsp;&nbsp;[画廊](#gallery)&nbsp;&nbsp;·&nbsp;&nbsp;[配置](#configuration)&nbsp;&nbsp;·&nbsp;&nbsp;[交流群](#community)

</div>

`dsh-imagegen` 是 DeepSeek Harness（DSH）的原生 AI 图像工作台。配置任意 OpenAI 兼容生图接口后，Agent 对话生图、`/edit_image` 斜杠命令连续编辑、多模型并列对比、441 条案例模板库与画廊资产管理都在同一个窗口完成。生成任务由宿主进程排队执行，不卡界面、不打断对话，图片也不必在多个工具之间来回搬运。

<a id="quick-start"></a>
## 快速开始

前置条件：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 和 Node.js 20+。

```bash
dsh plugin --profile web add @dickpy/dsh-imagegen
```

安装后重启 `dsh web`，侧边栏的“新会话”入口会变成“新会话 / 生图”双 Tab（Windows 如遇 PowerShell 脚本策略限制，请使用 `dsh.cmd`）。

首次使用：

1. 打开“设置 → 插件 → AI 生图”，添加一个提供方，填入 API 地址和密钥，点击“检测可用模型”，勾选生图模型后保存。
2. 点击“生图”Tab，输入一句提示词，生成第一张图。
3. 想让 Agent 也能画图？保持“允许 Agent 调用生图”开启即可（默认开启）。

<details>
<summary><b>其他安装方式与升级</b></summary>

**让 Agent 帮你安装** —— 将下面内容直接发给 DSH、Codex 或其他 coding agent：

```text
用 dsh plugin --profile web add @dickpy/dsh-imagegen 安装 AI 生图插件。完成后重启 dsh web，点击“新会话 / 生图”中的“生图” Tab，并打开设置中的 AI 生图配置。
```

**从 Release 安装** —— 从 [GitHub Releases](https://github.com/dickpy/dsh-imagegen/releases) 下载目标版本的 tgz 后执行：

```bash
dsh plugin --profile web add <下载路径>/dickpy-dsh-imagegen-<版本号>.tgz
```

**升级与回滚** —— 重复执行 `add` 命令即可更新到最新版；面板打开时也会自动检测新版本，出现顶部横幅后可在线更新，完成后重启 `dsh web` 生效。渠道配置、历史记录和画廊数据由 DSH 宿主保存，正常升级不会清空。需要固定版本时，使用 `@dickpy/dsh-imagegen@<版本号>` 或指定 Release tgz。

</details>

<a id="highlights"></a>
<a id="what-it-solves"></a>
## 功能总览

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#workflow">连续编辑工作流</a></b><br/>
      <sub>查看、加入对话、继续编辑，不换工具、不重新传图</sub><br/>
      <br/>
    </td>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#slash">/edit_image 斜杠命令</a></b><br/>
      <sub>一行命令调用插件模型改图，不依赖对话模型</sub><br/>
      <br/>
    </td>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#compare">多模型并列对比</a></b><br/>
      <sub>同一提示词、相同参数，多个模型并排出图</sub><br/>
      <br/>
    </td>
  </tr>
  <tr>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#studio">三栏工作台</a></b><br/>
      <sub>历史、生图、对话同屏，任务队列可取消、可重试</sub><br/>
      <br/>
    </td>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#templates">案例模板库</a></b><br/>
      <sub>441 条 gpt-image-2 案例，搜索筛选、一键回填</sub><br/>
      <br/>
    </td>
    <td width="33%" align="center" valign="top">
      <br/>
      <b><a href="#gallery">画廊</a></b><br/>
      <sub>标签、收藏、批量下载，收藏跨设备可见</sub><br/>
      <br/>
    </td>
  </tr>
</table>

<a id="workflow"></a>
<a id="agent-workflow"></a>
## 核心工作流

开启“允许 Agent 调用生图”后，从生成到修改都在 DSH 内完成：

| 步骤 | 在哪操作 | 发生什么 |
| --- | --- | --- |
| **生成** | 在对话里直接说，或在生图区输入提示词 | Agent 调用 `generate_image`，或工作台提交任务，由宿主排队执行 |
| **查看** | 工具结果旁 / 工作台画布 / 全屏预览 | 图片内联显示在对应位置，支持缩放、翻页、复制提示词 |
| **加入对话** | 结果卡或画廊点“加入对话” | 图片进入当前会话，自动适配附件限制，无需手动上传 |
| **继续编辑** | 对 Agent 说，或输入 `/edit_image …` | 以上一张成图为参考提交图生图，只需描述要改的地方 |

<div align="center">
  <img src="docs/videos/agent-chat-edit.gif" alt="Agent 对话生图与连续编辑演示" width="100%" />
  <p><sub><a href="docs/videos/agent-chat-edit.mp4">查看高清 MP4</a> — 从把图片加入对话到 /edit_image 继续修改的完整流程</sub></p>
</div>

<a id="slash"></a>
### 继续编辑的两种方式

| | 直接对 Agent 说 | `/edit_image` 斜杠命令 |
| --- | --- | --- |
| 怎么用 | 在对话里描述修改要求，如“把背景改成夜景” | 输入 `/edit_image 把背景改成夜景` |
| 背后发生什么 | Agent 携带该图片的引用调用 `edit_image` 工具提交图生图 | 命令直接调用插件配置的图片模型 |
| 是否经过对话模型 | 是，可结合上下文理解模糊意图 | 否，对话模型不支持图片输入时同样可用 |
| 适合 | 需求复杂、需要 Agent 记住整体目标 | 快速、明确的一次性修改 |

两种方式都不必重新上传图片，也不必重新描述全部需求——第二轮只需要说变化。

**可直接使用的案例提示词**

第一轮，让 Agent 生成一张项目海报：

```text
帮我为 dsh-imagegen 设计一张 16:9 横版项目海报。深色未来感背景，青蓝和紫色霓虹光效；画面中心展示 AI 生图工作台，包含赛博城市、人物肖像、雪山和抽象流体四张示例图；下方展示 Agent 对话生图、多模型对比和画廊三个能力区。整体干净、专业、有产品发布感，不要杂乱的小字。
```

第二轮，基于刚才的成图继续修改：

```text
保留当前海报的整体构图和深色科技风。把中心的赛博城市替换成更明亮的夜景，增强青蓝与紫色的边缘光；底部“Agent 对话生图”区域更突出，其他两项保持弱一级。不要重新生成一张完全不同的海报。
```

Agent 会把上一轮图片作为参考图提交图生图任务，因此第二轮只需要描述变化。

<details>
<summary><b>Agent 生图工具参考</b></summary>

| 工具 | 用途 |
| --- | --- |
| `generate_image` | 提交文生图任务；完成后在工具结果旁显示图片，并返回可继续编辑的图片引用。传 `wait_for_completion: false` 可改为后台模式，稍后用 `get_image_generation_task` 查询。等待上限 300 秒，超时自动取消。 |
| `edit_image` | 以已有图片为参考提交图生图任务；引用需原样传入之前工具返回的图片对象。 |
| `get_image_generation_task` | 查询任务状态；完成时显示图片并返回下一步编辑所需的引用。 |
| `cancel_image_generation_task` | 取消排队中或正在执行的任务。 |

> 配置了多个生图模型时，Agent 会先询问你想用哪个，而不是擅自选择；未配置 API 地址、密钥或模型时，会明确引导到“设置 → 插件 → AI 生图”，不会静默失败。

</details>

<a id="model-comparison"></a>
<a id="compare"></a>
## 多模型并列对比

同一个提示词在不同模型上往往呈现完全不同的构图、质感与文字处理。打开“多模型对比”，勾选多个已配置模型，插件会以相同参数提交任务，并在画布和全屏预览中并列展示，方便挑出真正适合当前任务的模型。

<div align="center">
  <img src="docs/images/multi-model-comparison.png" alt="gpt-image-2、grok-imagine-image 与 doubao-seedream 的三模型并列结果对比" width="100%" />
  <p><sub>同一提示词在三个模型下的并列结果，画布与全屏预览均支持对比视图</sub></p>
</div>

<details>
<summary><b>对比相关的细节</b></summary>

- 画布显示每个任务的进度与用时，可进入全屏并列对比。
- 对比生成的多条历史在历史记录中自动折叠为一组（显示模型列表与总图数），点“恢复”会连同对比模型选择一起回填，也可整组删除。
- 对比任务在宿主队列中并行执行，与普通任务共用同一条队列，取消、重试、历史语义一致。

</details>

<a id="studio"></a>
## 图像工作台

点击“新会话 / 生图”中的“生图”Tab，工作区按“历史记录 | 生图区 | AI 对话”三栏排列，拖动分隔线即可调整对话区宽度；左侧历史区与结果预览区均可收起，专注查看大图。

<div align="center">
  <img src="docs/images/image-generation-studio-three-column.png" alt="三栏工作台" width="100%" />
  <p><sub>历史记录 ｜ 生图区 ｜ AI 对话 三栏同屏，分隔线可拖拽</sub></p>
</div>

<div align="center">
  <img src="docs/images/image-generation-studio-four.png" alt="AI 生图工作台四图结果布局" width="100%" />
  <p><sub>一次生成多张时的结果布局，可全屏缩放、翻页查看</sub></p>
</div>

- **生成参数**：9 档比例（1:1 至 21:9）、4 档清晰度（自动/1K/2K/4K）、一次 1–4 张、细节等级透传。
- **任务队列**：生成由宿主进程排队执行，画布上方的任务托盘可随时取消，失败后一键重试，长任务不会卡住面板。
- **全屏预览**：滚轮或快捷键缩放（0.5–3x）、←/→ 前后翻页、复制提示词、下载、加入对话或画廊、一键作为下一次图生图的参考。
- **历史记录**：保留提示词、模型与参数（最近 50 条），支持关键词、模型、比例筛选，点击即可恢复参数；旧版本记录的尺寸与质量会自动映射为新的比例与清晰度词汇。
- **图生图参考图**：支持本地上传或拖拽（≤10MB），也可从结果卡、全屏预览、历史和画廊一键转为参考图。

<a id="enhance"></a>
### 提示词增强

只有一句“画只猫”也想出好图：点击增强按钮，插件会把简短想法发给一个对话模型扩写成结构完整的生图提示词，再提交生成；增强模型可复用生图 API 凭据。未配置增强模型时会弹窗引导，并自动打开设置页的对应卡片。

<a id="templates"></a>
## 模板库

随插件内置 441 条精选 `gpt-image-2` 提示词案例（含参考图快照），没有灵感时可以先看看别人怎么写。

<div align="center">
  <img src="docs/images/prompt-template-library.png" alt="提示词模板库：分类筛选与案例卡片" width="100%" />
  <p><sub>按 18 个分类浏览，案例详情含参考图、作者署名与原链，可一键回填</sub></p>
</div>

- 案例详情包含参考图、作者署名与原链，可复制或一键回填到生图输入框。
- “缓存全部图片”把参考图缓存到本机（带进度显示），之后离线也能浏览。
- 支持“刷新模板库”在线更新案例，界面会标明当前来源（内置快照 / 在线刷新）。

<a id="gallery"></a>
## 画廊

满意的图片可从结果卡、全屏预览或历史记录一键加入画廊；画廊中的图片也能直接加入当前对话，再用 `/edit_image` 修改。画廊为持续积累作品设计：左侧筛选，右侧瀑布流或整齐网格，点击任意图片即可打开大图预览。

<div align="center">
  <img src="docs/images/gallery-workspace.png" alt="画廊工作区：分类筛选、瀑布流和大图预览" width="100%" />
  <p><sub>左侧分类筛选带计数，右侧瀑布流 / 网格可切换</sub></p>
</div>

- 关键词搜索；按生成模式、模型、比例和自建标签过滤，分类侧栏带数量统计。
- 瀑布流 / 整齐网格两种视图，支持最新、最早排序。
- 标签可新建、编辑、删除；多选图片后可批量打标签、批量下载，或导出 JSON 元数据作为备份。
- 收藏由 DSH 宿主持久化保存，跨同一宿主的浏览器/设备可见；同一图片内容按哈希去重，不会重复加入。

<a id="configuration"></a>
## 配置模型

打开 DSH 的“设置 → 插件”，展开 **AI 生图（dsh-imagegen）**。每个提供方都有独立的 API 地址、密钥和模型目录，可同时配置多个服务；预置了 OpenAI、智谱、xAI、字节火山方舟（Seedream）等常用渠道，也可添加任意自定义 OpenAI 兼容渠道。

<div align="center">
  <img src="docs/images/plugin-settings.png" alt="DSH 设置页中的 AI 生图插件配置" width="72%" />
  <p><sub>设置 → 插件 → AI 生图（dsh-imagegen）</sub></p>
</div>

| 配置项 | 说明 |
| --- | --- |
| 提供方 | 预置提供方可直接选择，也可添加自定义渠道。 |
| API 地址 | OpenAI 兼容接口根地址，例如 `https://api.openai.com/v1`，插件会自动追加图像接口路径。 |
| API 密钥 | 每个提供方单独配置；密钥仅保存在 DSH 宿主侧，浏览器与 Agent 都拿不到明文。 |
| 模型目录 | 保存地址和密钥后点击“检测可用模型”，插件会过滤聊天、Embedding 等非图片模型；没有 `/models` 的网关可手动添加并设置别名。 |
| 提示词增强模型 | 可选。选择一个支持 `/chat/completions` 的模型，通常可复用生图 API 凭据。 |
| 允许 Agent 调用生图 | 默认开启。关闭后 Agent 不能提交、查询和取消任务，侧边栏工作台不受影响。 |

**关于“检测可用模型”**

- 优先读取上游返回的能力字段，并结合命名启发式（image / flux / seedream / nanobanana / kolors…）过滤非图片模型，但仍建议只勾选你的上游实际支持生图的模型。
- 支持用尚未保存的地址和密钥先探测、确认可用后再保存。
- 未被识别的 OpenAI 兼容图片模型仍可手动加入清单，按通用协议尝试调用。

<details>
<summary><b>已适配的接口与模型家族</b></summary>

- **OpenAI 兼容接口**：支持 `/images/generations`、`/images/edits` 和 `{ data: [{ b64_json | url }] }` 格式响应。
- **Grok Imagine**：原生支持 `grok-imagine-image` 与 `grok-imagine-image-2.0`（地址 `https://api.x.ai/v1`），图生图使用其 JSON `image_url` 协议，比例和清晰度映射为 `aspect_ratio` 与 `resolution`。
- **Nano Banana（谷歌 Gemini 图像系列）**：内置 `nanobanana2` / `nanobanana2-lite` / `nanobanana-pro`（也识别官方 `gemini-3.x-image*` ID），清晰度映射为 `image_size`（1K/2K/4K）。
- **Seedream（字节跳动生图系列）**：内置 `seedream-5.0-pro`（也识别 `seedream-4.x`、`doubao-seedream-…`），文生图与图生图统一走 `/images/generations`，参考图以 JSON `image` 数组发送。
- **智谱 GLM-Image**：内置 `glm-image`，文生图质量参数映射为 `hd`；当前不支持图生图，选择编辑模型时会被自动排除。
- **后续模型**：未被识别的 OpenAI 兼容图片模型可手动添加；厂商专属鉴权或请求协议需要单独适配。

</details>

<a id="security"></a>
## 数据与安全

- API 请求由 DSH 宿主进程代理，浏览器不直接连接上游：没有 CORS 问题，密钥不会出现在前端；宿主路由仅监听本机回环地址并校验同源请求。
- 密钥保存于本机 DSH 设置中，设置页面仅展示“已配置”状态。
- 历史、画廊和图片数据保存在宿主的 `~/.dsh/dsh-imagegen/`，由你控制；画廊图片按内容去重，模板展示图经宿主同源代理按需拉取与缓存，文件访问有严格白名单。
- 图生图会把参考图发送到当前渠道的上游 API，请确认渠道服务商的数据处理政策，不要上传敏感图片。
- 生图会消耗上游 API 额度。图片内容由上游模型生成，可能出现不准确、不适宜或不符合预期的结果，请在使用前人工检查。
- API 密钥属于敏感信息，请不要提交到 GitHub Issue、日志、截图或 README；发现密钥泄露时应立即在上游服务商处轮换。

<a id="community"></a>
## 交流群

欢迎加入 QQ 群，一起交流 DSH、AI 生图和插件使用体验，也欢迎分享提示词、工作流与改进建议。

<p align="center">
  <img src="docs/images/community-qq.png" alt="扫码加入 dsh-imagegen QQ 交流群" width="360" />
</p>

<a id="development"></a>
## 开发与反馈

```bash
pnpm run typecheck
pnpm run build
pnpm run watch
node scripts/smoke.mjs
```

- 发现问题请提交 [Bug 报告](https://github.com/dickpy/dsh-imagegen/issues/new?template=bug_report.yml)，附带插件版本、DSH 版本和复现步骤。请勿粘贴 API 密钥。
- 有改进想法请提交 [功能建议](https://github.com/dickpy/dsh-imagegen/issues/new?template=feature_request.yml)。
- 查看全部 [Release](https://github.com/dickpy/dsh-imagegen/releases) 和 [Issue](https://github.com/dickpy/dsh-imagegen/issues)。
- 如果这个插件对你有帮助，欢迎 Star。

## 许可证

[Apache-2.0](./LICENSE)

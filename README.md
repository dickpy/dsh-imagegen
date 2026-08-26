# dsh-imagegen

[![npm](https://img.shields.io/npm/v/@dickpy/dsh-imagegen?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@dickpy/dsh-imagegen)
[![License](https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-111827)](https://github.com/dickpy/dsh-imagegen)

<p align="center">
  <img src="docs/images/imagegen-overview.png" alt="dsh-imagegen AI image studio" width="100%" />
</p>

> 让 DeepSeek Harness 中的 Agent 不只会回答，还能把想法变成图片，并围绕成图继续迭代。

`dsh-imagegen` 是 DSH 的原生 AI 图像工作台。它把可配置的 OpenAI 兼容生图接口、Agent 工具调用、后台任务、文生图、图生图、多模型比较和作品管理放进同一条工作流。你不需要在生成期间守着界面，也不需要把图片在多个工具之间来回搬运。

<p align="center">
  <strong>
    <a href="#what-it-solves">能解决什么</a>&nbsp;&nbsp;&nbsp;|
    <a href="#agent-workflow">Agent 对话生图</a>&nbsp;&nbsp;&nbsp;|
    <a href="#model-comparison">多模型对比</a>
  </strong>
  <br />
  <strong>
    <a href="#gallery">画廊管理</a>&nbsp;&nbsp;&nbsp;|
    <a href="#quick-start">快速开始</a>&nbsp;&nbsp;&nbsp;|
    <a href="#configuration">配置模型</a>&nbsp;&nbsp;&nbsp;|
    <a href="#community">交流群</a>
  </strong>
</p>

<a id="what-it-solves"></a>
## 它解决什么问题

| 过去要反复做的事 | 现在的工作方式 |
| --- | --- |
| 在对话、网页生图工具和本地文件夹之间切换 | 在 DSH 对话里描述目标，Agent 等待任务并把图片显示在工具调用对应的左侧结果区域 |
| 生图耗时很长，只能盯着页面或不断询问状态 | Agent 工具调用会保持等待直到完成，结果同时保存在对话和工作台 |
| 第一张图不对，就重新组织全部提示词 | 直接说“换成黄色”“保留构图但改成夜景”，Agent 复用上一张图继续图生图 |
| 多个模型各有优缺点，难以公平比较 | 用同一提示词和参数并行生成，在并列全屏视图中挑选结果 |
| 收藏变多后无法找回、筛选或导出 | 画廊支持瀑布流、搜索、标签、批量下载和 JSON 备份 |

<a id="agent-workflow"></a>
## Agent 对话生图与连续编辑

这是插件的核心体验。开启“允许 Agent 调用生图”后，直接在 DSH 对话中说出你想要的画面即可。Agent 会从已允许的模型中选择合适项，提交任务并等待完成；真实图片会显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外产生一条用户消息。

接着，你可以基于结果继续提出修改。Agent 会携带该图片的引用调用图生图，不必重新上传文件，也不必重新描述全部上下文。它适合快速探索视觉方向、反复打磨 UI 视觉稿、海报或产品素材。

![Agent 在对话中提交海报生成任务，成图作为工具结果显示](docs/images/agent-chat-poster-workflow.png)

### 可直接使用的案例提示词

**第一轮：让 Agent 生成一张项目海报**

```text
帮我为 dsh-imagegen 设计一张 16:9 横版项目海报。深色未来感背景，青蓝和紫色霓虹光效；画面中心展示 AI 生图工作台，包含赛博城市、人物肖像、雪山和抽象流体四张示例图；下方展示 Agent 对话生图、多模型对比和画廊三个能力区。整体干净、专业、有产品发布感，不要杂乱的小字。
```

**第二轮：基于刚才的成图继续修改**

```text
保留当前海报的整体构图和深色科技风。把中心的赛博城市替换成更明亮的夜景，增强青蓝与紫色的边缘光；底部“Agent 对话生图”区域更突出，其他两项保持弱一级。不要重新生成一张完全不同的海报。
```

Agent 会把上一轮图片作为参考图提交图生图任务，因此第二轮只需要描述变化，而不必再次上传图片或重复全部需求。

**对话中可用的能力**

| 工具 | 用途 |
| --- | --- |
| `generate_image` | 提交文生图任务，默认等待完成后在左侧工具结果显示图片，并返回附件引用；传 `wait_for_completion: false` 可改为后台模式。 |
| `get_image_generation_task` | 查询任务；完成时在左侧工具结果显示图片，并返回下一步编辑所需的图片引用。 |
| `edit_image` | 以已有图片为参考提交图生图任务，默认等待完成后在左侧工具结果显示图片。 |
| `cancel_image_generation_task` | 取消排队中或正在执行的任务。 |

未配置 API 地址、密钥或可用生图模型时，工具会明确引导到 DSH 的“设置 → 插件 → AI 生图”，而不是静默失败。Agent 调用默认开启，也可按需关闭，仅保留侧边栏工作台。

<a id="model-comparison"></a>
## 多模型并列对比

同一个提示词往往在不同模型上呈现出完全不同的构图、质感与文字处理。打开“多模型对比”，选择多个已配置模型后，插件会以相同参数提交任务，并在画布和全屏预览中将结果并列展示。这样能更快选出真正适合当前任务的模型，而不是凭感觉反复试错。

![gpt-image-2 与 grok-imagine-image 的多模型并列结果对比](docs/images/multi-model-comparison.png)

<a id="studio"></a>
## 原生图像工作台

侧边栏打开后，参数、生成结果、后台任务和历史记录处于同一工作区。文生图和图生图均支持尺寸、清晰度、数量与细节等级；结果可下载、全屏查看、缩放、前后切换、复制提示词或一键作为下一次图生图的参考。

![AI 生图工作台四图结果布局](docs/images/image-generation-studio-four.png)

**让首次生成更可控**

- 提示词增强可检测当前 API 支持的对话模型，把一句简短想法扩写成更完整的生图提示词。
- 生成任务由宿主进程排队执行，支持查看状态、取消和失败重试，长任务不会卡住整个面板。
- 历史记录保留提示词、模型与参数，支持关键词、模型和比例筛选；最多保存 50 条最近记录。
- 内置 441 个 `gpt-image-2` 提示词案例，可搜索、筛选、复制并一键回填。

<a id="gallery"></a>
## 画廊：把生成结果变成可用资产

满意的图片可从结果卡、全屏预览或历史记录一键加入画廊。画廊不是横向缩略图条，而是为持续积累作品设计的纵向工作区：左侧筛选，右侧瀑布流或整齐网格，点击任意图片即可打开大图预览。

![画廊工作区：分类筛选、瀑布流和大图预览](docs/images/gallery-workspace.png)

- 关键词搜索，按生成模式、模型、比例和自建标签过滤。
- 标签可新建、编辑和删除；标签入口会同步出现在左侧筛选区。
- 多选图片后可批量下载，或导出 JSON 元数据作为备份。
- 收藏由 DSH 宿主持久化保存，跨同一宿主的浏览器/设备可见，同一图片内容不会重复加入。

<a id="quick-start"></a>
## 快速开始

前置条件：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 和 Node.js 20+。安装完成后重启 `dsh web`，侧边栏会出现“AI 生图”。

### 一条命令安装

```bash
dsh plugin --profile web add @dickpy/dsh-imagegen
```

Windows 如遇 PowerShell 脚本策略限制，请使用 `dsh.cmd`。安装后进入“设置 → 插件 → AI 生图”，填写 API 地址和密钥，检测并选中可用模型后保存。

### 让 Agent 帮你安装

将下面内容直接发给 DSH、Codex 或其他 coding agent：

```text
用 dsh plugin --profile web add @dickpy/dsh-imagegen 安装 AI 生图插件。完成后重启 dsh web，并打开设置中的 AI 生图配置。
```

### 从 Release 安装

从 [GitHub Releases](https://github.com/dickpy/dsh-imagegen/releases) 下载 tgz 后执行：

```bash
dsh plugin --profile web add <下载路径>/dickpy-dsh-imagegen-1.3.0.tgz
```

<a id="configuration"></a>
## 配置模型

打开 DSH 的“设置 → 插件”，展开 **AI 生图（dsh-imagegen）**，先添加一个提供方。每个提供方都有独立的 API 地址、密钥和模型目录，可同时配置多个服务。

| 配置项 | 如何使用 |
| --- | --- |
| 提供方 | 预置提供方可直接选择；也可以添加自定义渠道。 |
| API 地址 | OpenAI 兼容接口根地址，例如 `https://api.openai.com/v1`。插件会自动追加图像接口路径。 |
| API 密钥 | 每个提供方单独配置，密钥仅保存在 DSH 宿主侧，浏览器与 Agent 都不会获得明文。 |
| 模型目录 | 保存地址和密钥后点击“检测可用模型”；勾选实际支持生图的项目。没有 `/models` 的网关可手动添加，并可设置显示别名。 |
| 提示词增强模型 | 可选。点击“获取可用模型”，选择支持 `/chat/completions` 的模型；通常可复用生图 API 凭据。 |
| 允许 Agent 调用生图 | 默认开启。关闭后，Agent 不能提交、查询和取消任务，侧边栏工作台不受影响。 |

> `/models` 的标准响应通常不含“是否支持生图”的能力字段，因此它提供的是候选列表，不是兼容性认证。请只选择你的上游实际支持的生图模型。

### 已适配的接口

- **OpenAI 兼容接口**：支持 `/images/generations`、`/images/edits` 和 `{ data: [{ b64_json | url }] }` 格式响应。
- **Grok Imagine**：原生支持 `grok-imagine-image` 与 `grok-imagine-image-2.0`。将地址设为 `https://api.x.ai/v1` 后，图生图会使用其 JSON `image_url` 协议，比例和清晰度映射为 `aspect_ratio` 与 `resolution`。
- **Nano Banana（谷歌 Gemini 图像系列）**：内置 `nanobanana2` / `nanobanana2-lite` / `nanobanana-pro`（也识别官方 `gemini-3.x-image*` ID）。走 OpenAI 兼容接口时，比例和清晰度映射为 `aspect_ratio` 与 `image_size`（1K/2K/4K），输出请求 base64。
- **Seedream（字节跳动生图系列）**：内置 `seedream-5.0-pro`（也识别 `seedream-4.x`、`doubao-seedream-…`）。无 `/images/edits`，文生图与图生图统一走 `/images/generations`，参考图以 JSON `image` 数组发送；官方 Ark 接口的 `size` 用于清晰度档位（1K/2K，5.0-pro 上限 2K），面板比例不会误传为 Ark 的 `size`。
- **后续模型**：可将 `qwen-image`、Gemini 等 OpenAI 兼容网关模型加入清单；厂商专属鉴权或请求协议需要单独适配。

<a id="community"></a>
## 交流群

欢迎加入 QQ 群，一起交流 DSH、AI 生图和插件使用体验，也欢迎分享提示词、工作流与改进建议。

<p align="center">
  <img src="docs/images/community-qq.png" alt="扫码加入 dsh-imagegen QQ 交流群" width="360" />
</p>

<a id="security"></a>
## 数据与安全

- API 请求由 DSH 宿主进程代理，浏览器不直接连接上游，因此没有 CORS 问题，也不会暴露 API 密钥。
- 密钥保存于本机 DSH 设置中，设置页面仅展示“已配置”状态。
- 历史、画廊和图片数据保存在宿主的 `~/.dsh/dsh-imagegen/`，由你控制；画廊图片按内容去重。
- 模板库随插件发布提示词快照，展示图通过宿主同源代理按需拉取与缓存。

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

## 许可证

[Apache-2.0](./LICENSE)

# dsh-imagegen

<div align="center">
  <a href="https://www.npmjs.com/package/@dickpy/dsh-imagegen"><img src="https://img.shields.io/npm/v/@dickpy/dsh-imagegen?color=cb3837&logo=npm&label=npm" alt="npm" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@dickpy/dsh-imagegen"><img src="https://badgen.net/npm/dt/@dickpy/dsh-imagegen?label=downloads&color=blue" alt="npm total downloads" /></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg" alt="License" /></a>
  &nbsp;
  <a href="https://github.com/dickpy/dsh-imagegen"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827" alt="Platform" /></a>

  <p><strong>在 DeepSeek Harness 里，生成、编辑、管理，一站完成。</strong></p>
  <p><strong>快速导航</strong></p>
  <p><a href="#quick-start">🚀 快速开始</a>　·　<a href="#canvas">无限画布</a>　·　<a href="#ecommerce">电商套图</a>　·　<a href="#txt2img">文生图 / 图生图</a>　·　<a href="#editable-ppt">图片转 PPT</a>　·　<a href="#gallery">模板 / 画廊</a>　·　<a href="#configuration">模型配置</a>　·　<a href="#community">👥 QQ 交流群</a></p>
</div>

<a id="quick-start"></a>
## 快速开始

需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 和 Node.js 20+。

```bash
dsh plugin --profile web add @dickpy/dsh-imagegen
```

安装后重启 `dsh web`，侧边栏会出现「生图」入口。到「设置 → 生图配置」添加提供方、填写 API 地址与密钥、检测并选择生图模型，保存后即可开始创作。Windows 若遇 PowerShell 脚本策略限制，请使用 `dsh.cmd`。

<details>
<summary><b>其他安装方式、升级与回滚</b></summary>

- **让 Agent 安装：**把上面的安装命令发给 DSH、Codex 或其他 coding agent。
- **指定版本：**使用 `@dickpy/dsh-imagegen@<版本号>`，或从 [GitHub Releases](https://github.com/dickpy/dsh-imagegen/releases) 下载 tgz 后安装。
- **Web / CLI 升级：**重复执行 `add` 命令；插件也会在面板中提示新版本。更新后重启 `dsh web`。
- **桌面端升级：**从插件1.8.2起，检测到宿主插件安装接口时，可直接在插件面板点击「在线更新」，由DSH内置插件管理器安装新版，完成后重启DSH。1.8.0/1.8.1的按钮已被旧逻辑禁用，首次需通过宿主支持的方式安装修复包。宿主未提供安装接口时需先升级DSH。详见 [v1.8.2 更新说明](docs/releases/v1.8.2.md)。
- 渠道配置、历史记录和画廊数据保存在 DSH 宿主侧，正常升级不会清空。

</details>

<a id="features"></a>
## 核心功能

| 能力 | 用途 |
| --- | --- |
| **无限画布** | 把提示词、参考图和生成节点连成可迭代的创作流程。 |
| **图片转可编辑 PPT** | 上传图片或从生图结果一键带入，直接执行官方 skill，下载可编辑 PPTX。 |
| **电商套图** | 从商品参考图生成主图、卖点图、场景图等成套素材。 |
| **文生图 / 图生图** | 使用兼容的生图渠道生成、编辑并比较图片。 |
| **对话与 Agent** | 在 DSH 对话中生成图片、继续编辑，并把结果带回会话。 |
| **画廊与历史** | 管理创作结果、模板与标签；在不同设备上接续创作。 |

<a id="canvas"></a>

把文字、图片和生成配置连起来；从历史或画廊加入素材，再继续生成和迭代。

<div align="center">
  <img src="docs/images/infinite-canvas-demo.gif" alt="无限画布：连接节点并继续创作的演示" width="100%" />
</div>

<details>
<summary><b>画布、文件节点与技能细节</b></summary>

- 支持图片、文本、生成配置和文件节点；图片节点可标注、移除背景或拆分图层。
- 单个文件最大 50MB；可在画布内预览常见文档、表格、PDF、图片与音视频。
- 生图结果可右键选择「复制图片」，也可通过结果或放大预览中的按钮复制；剪贴板不可用时会提示，图片仍可下载。
- 顶部「隐藏图片」或 `Alt+Shift+H` 可暂时遮住工作室图片预览，再次操作恢复；该功能不会隐藏 DSH 原生对话中的图片，也不会删除文件或清空剪贴板。
- 内置文本润色、图片描述和内容抽取等技能。图片转 PPT 复用上游 `image-to-editable-ppt` 技能，可在设置中安装该技能与 Python 运行环境。
- 图片转 PPT 由宿主 Agent 按上游流程重建可编辑页面；可配置图像后端，PaddleOCR token 为可选项，离线文字检测仅提供位置和尺寸提示。
- 也可安装和管理外部技能。重任务技能会启动具有本机文件读写与命令执行能力的无头 Agent；运行前请检查技能来源和权限。
- 技能配置格式与安全边界见 [`docs/skill-config.md`](docs/skill-config.md)。

</details>

<a id="ecommerce"></a>

从商品主体和可选风格参考出发，先预览套图计划、逐张调整提示词，再批量生成；主图可作为其他用途图片的一致性参考。

<div align="center">
  <img src="docs/images/ecommerce-mode.png" alt="电商模式：配置商品参考图并生成成套商品视觉" width="100%" />
</div>

<a id="txt2img"></a>

输入提示词即可生成，也可上传参考图进行编辑；支持多张结果、比例与清晰度设置、任务队列、历史恢复和全屏预览。

<div align="center">
  <img src="docs/images/image-generation-studio-four.png" alt="文生图与图生图工作台" width="100%" />
</div>

在 DSH 对话里可让 Agent 调用生图；用 `/edit_image` 描述修改内容，也可从工作台或画廊把图片加入当前会话继续编辑。

#### 多模型对比

同一提示词可提交给多个模型并列查看结果，便于快速挑选风格与质量。

<div align="center">
  <img src="docs/images/multi-model-comparison.png" alt="多个生图模型的并列结果对比" width="100%" />
</div>

<a id="gallery"></a>

提示词模板库内置精选案例、沧河、手绘、Prompt/Signal 与 GPT Image 2 五个来源，可搜索、筛选、收藏并直接带入生图。生成结果可在画廊中用标签和收藏继续整理。

<p align="center">
  <img src="docs/images/prompt-template-library.png" alt="提示词案例模板库" width="49%" />
  <img src="docs/images/gallery-workspace.png" alt="画廊工作区" width="49%" />
</p>

<a id="configuration"></a>
## 可编辑海报：文字与 Logo

在无限画布的图片工具栏或右键菜单选择 **「海报编辑：文字 / Logo」**，即可叠加可编辑标题、价格和品牌 Logo。支持多行文字、自动换行、字体类别、字号、颜色、对齐、Logo 等比缩放、拖动定位、图层顺序及撤销重做。

- **保存到画布**：生成新图片节点并保存可编辑图层，原图保持原样；再次打开新节点可继续编辑。请等待画布保存完成再关闭页面。
- **导出 PNG**：下载与预览一致的合成图；PNG 本身不保存可编辑工程。
- 合成过程在本地完成，不调用模型；底图已有文字不会自动移除。最长边上限 4096 像素。

## 模型配置

在「设置 → 生图配置」添加渠道，填写 API 地址与密钥，检测并选择生图模型。可配置多个提供方，并设置默认生图模型和可选的提示词增强聊天模型。

支持 OpenAI 兼容的 Images API / Chat Completions，以及 xAI Grok、Google Nano Banana、Seedream、Qwen-Image、GLM-Image、MiniMax 等预置渠道；也可手动添加兼容模型。

<details>
<summary><b>接口与渠道补充说明</b></summary>

- 通用渠道默认自动判断 Images API 与 Chat Completions；也可在设置中手动指定。
- One-API、New API、LiteLLM 等只暴露 `/chat/completions` 的网关，可填写完整接口地址并选择对应模型。
- API 密钥保存在 DSH 宿主设置中；未被自动识别的兼容模型可手动添加。
- 不同服务商的图生图、尺寸与返回格式可能不同，请确认所选模型实际支持的能力。
- 火山方舟 / BytePlus 的 Seedream 默认在图片右下角叠加「AI 生成」角标；渠道编辑里的「图片添加「AI 生成」水印」可关闭，关闭后请求体透传 `watermark: false`。该角标属于生成合成内容标识，关闭后的对外发布标注义务由使用者承担。

</details>

<a id="security"></a>
## 数据与安全

- API 请求经 DSH 宿主转发；密钥保存在本机设置中，不直接暴露给浏览器。
- 历史、画廊、画布和图片保存在 DSH 数据目录 `~/.dsh/dsh-imagegen/`，由你控制。
- 生图与图生图会把提示词或参考图发送给所配置的上游服务；请按服务商政策处理敏感内容。
- 内置轻量技能会把所选内容发送给配置的聊天模型。图片转 PPT 由宿主 Agent 调用上游技能和所配置的模型或服务，在本地输出 PPTX；结果和可编辑程度需人工检查。
- 外部重任务技能可能读写本机文件并执行命令；运行前请确认技能可信、输入内容可共享。
- 生图会消耗上游 API 额度；请人工检查生成结果。不要把 API 密钥贴到 Issue、日志或截图中。

<a id="community"></a>
## QQ 交流群与支持

欢迎加入 QQ 群，一起交流 DSH、AI 生图与插件使用，也欢迎分享提示词、工作流和改进建议。

<p align="center">
  <img src="docs/images/community-qq.png" alt="扫码加入 dsh-imagegen QQ 交流群" width="360" />
</p>

- [Bug 报告](https://github.com/dickpy/dsh-imagegen/issues/new?template=bug_report.yml) · [功能建议](https://github.com/dickpy/dsh-imagegen/issues/new?template=feature_request.yml)
- [查看所有 Issues](https://github.com/dickpy/dsh-imagegen/issues) · [GitHub Releases](https://github.com/dickpy/dsh-imagegen/releases)
- 如果这个插件对你有帮助，欢迎给项目点个 Star。

<details>
<summary><b>本地开发</b></summary>

```bash
pnpm run typecheck
pnpm run build
pnpm run watch
node scripts/smoke.mjs
```

冒烟测试会把数据根目录重定向到临时目录，不会写入你的 `~/.dsh/dsh-imagegen`。

本地打包并安装到 DSH 验收：

```bash
pnpm pack --pack-destination .
dsh plugin --profile web add ./dickpy-dsh-imagegen-<版本>.tgz
```

</details>

## 许可证

[Apache-2.0](./LICENSE)

内置模板所引用的第三方项目与许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

<a id="editable-ppt"></a>
## 图片转可编辑 PPT

在「图片转 PPT」上传最多12张 PNG/JPG/WebP（每张20MB），调整缩略图顺序后转换；文生图、图生图、多模型对比和放大预览中的「生成可编辑 PPT」可直接带入。

首次在「生图配置 → 图片转可编辑 PPT」安装 [官方 skill](https://github.com/ningzimu/image-to-editable-ppt-skill) 与运行环境，需 Python 3.10+。按需填写 PaddleOCR token、图像 API 并保存应用；也可选离线文字检测，图像后端支持已有 Codex OAuth。转换由宿主默认模型及 Agent 预设执行，需文件/命令能力，多页需子 Agent；请启用技能和长任务。

转换可能耗时数分钟并产生模型/API费用。任务支持取消、刷新恢复、下载及复用图片；宿主重启会中断在途任务。还原质量取决于原图、OCR和模型，失败时会保留明确状态。详细前提和审核范围见 [PPT模式说明](docs/ppt-mode-review.md)。

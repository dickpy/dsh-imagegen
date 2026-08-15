# dsh-imagegen

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-111827)](https://github.com/dickpy/dsh-imagegen)

DeepSeek Harness (DSH) Web GUI 的 AI 生图插件。它通过宿主进程安全地代理 OpenAI 兼容的图像生成接口，为 DSH 提供文生图、图生图编辑、生成历史和一体化设置页。

> 默认模型为 `gpt-image-2`，也兼容提供 `/images/generations` 和 `/images/edits` 的 OpenAI 兼容端点。

## 效果预览

### AI 生图工作台

三栏工作台将参数、生成结果和历史记录放在同一视图中；生成的图片可预览、下载，并从历史记录恢复参数。

![AI 生图工作台](docs/images/image-generation-studio.png)

### 独立配置卡片

在 DSH 的“设置 -> 插件 -> 可配置”中填写 API 地址和密钥。密钥只保存在宿主侧设置文件，浏览器端不会获取明文。

![插件配置卡片](docs/images/plugin-settings.png)

## 功能

- **文生图与图生图**：输入提示词生成图片，或上传 PNG、JPG、WEBP 参考图进行编辑。
- **可调生成参数**：尺寸、清晰度、生成数量和细节等级均可在界面中选择；未指定的参数保持自动。
- **结果操作**：支持加载、失败提示、图片网格、全屏预览、前后切换与下载。
- **持久化历史**：保存提示词、参数和图片；支持查看、恢复、单条删除和清空，最多保留 50 条。
- **跨设备查看**：历史保存在 DSH 宿主侧，连接同一 DSH 的浏览器或设备共享同一份记录。
- **原生 DSH 体验**：侧栏入口、主题适配和设置卡片均遵循 DSH Web GUI 的 UI 规范。

## 快速开始

### 1. 构建插件

前置条件：Node.js 20+、pnpm，以及一个可运行的 DSH Web profile。

```bash
git clone https://github.com/dickpy/dsh-imagegen.git
cd dsh-imagegen
pnpm install
pnpm run build
```

### 2. 接入 DSH Web profile

在 DSH Web profile 的 `package.json` 中加入本地依赖：

```json
{
  "dependencies": {
    "@dsh-local/dsh-imagegen": "link:E:/dsh-plugin"
  }
}
```

然后在该 profile 的 `cordis.patch.yml` 追加插件条目：

```yaml
- insert:
    - id: imagegen
      name: '@dsh-local/dsh-imagegen'
```

在 profile 目录执行安装并重启 DSH：

```bash
pnpm install
```

`lib` 内的宿主与客户端 bundle 变更需要重新构建；开发时可运行 `pnpm run watch` 持续构建。

## 配置 API

打开 DSH 的“设置 -> 插件 -> 可配置”，展开 **AI 生图 (dsh-imagegen)**：

| 配置项 | 说明 |
| --- | --- |
| `api_url` | OpenAI 兼容接口根地址，例如 `https://api.openai.com/v1`。插件会自动追加接口路径。 |
| `api_key` | Bearer API 密钥。界面仅显示是否已配置；输入新值可覆盖，清空后保存可删除。 |
| 启用插件 | 关闭后生图工作台不可用，设置卡片仍可用于重新启用。 |
| 向 Agent 播报 | 开启后，将插件能力写入 Agent 系统提示词。 |

配置完成后，从 DSH 侧栏打开“AI 生图”即可开始使用。

## 接口兼容性

| 场景 | 请求 |
| --- | --- |
| 文生图 | `POST {api_url}/images/generations`，JSON 请求体 |
| 图生图 | `POST {api_url}/images/edits`，`multipart/form-data`，包含 `image`、`prompt`、`model` 与参数 |
| 响应 | 支持 OpenAI 兼容的 `{ data: [{ b64_json | url }] }`；URL 图片由宿主下载并转为 base64，再返回浏览器 |

`detail` 是透传参数，部分 `gpt-image-2` 网关支持。官方 OpenAI 端点若不接受该字段，请保持界面中的“自动”。

## 数据与安全

- API 请求由 DSH 宿主进程代理，浏览器不直接连接上游 API，因此不暴露 API 密钥，也没有浏览器 CORS 问题。
- API 密钥保存在宿主侧 `~/.dsh/settings.yaml`；设置桥会对密钥进行脱敏。
- 历史数据存放在 `~/.dsh/dsh-imagegen/`：图片独立落盘，`index.json` 保存索引。
- 插件通过专用 loopback 路由 `/api/dsh-imagegen/settings/{describe,mutate}` 访问设置，不需要修改 DSH 源码或依赖第三方命名空间白名单。

## 项目结构

| 位置 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口、设置注册、路由挂载和 Agent 提示词播报 |
| `src/routes.ts` | `/api/dsh-imagegen/*` 宿主路由 |
| `src/engine.ts` | 上游图像生成代理与响应归一化 |
| `src/history-store.ts` | 历史记录和图片持久化 |
| `src/client/ImageGenPanel.tsx` | 生图工作台、结果、历史与大图预览 |
| `src/client/SettingsCard.tsx` | 插件配置卡片 |

## 开发

```bash
pnpm run typecheck  # TypeScript 类型检查
pnpm run build      # 构建宿主与 Web bundle
pnpm run watch      # 持续构建
```

## 许可证

[Apache-2.0](./LICENSE)

# 🎨 dsh-imagegen

> DSH（DeepSeek Harness）Web GUI 的 AI 生图插件：对接 OpenAI 兼容图像生成 API，提供文生图与图生图能力。

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Version](https://img.shields.io/badge/version-1.0.0-green)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Platform](https://img.shields.io/badge/platform-web-brightgreen)

在 DSH Web GUI 侧边栏新增「AI 生图」入口，打开三栏生图工作台（参数配置 / 结果画布 / 历史记录）。
模型默认为 `gpt-image-2`，兼容 `gpt-image-1`、`dall-e-3` 等 OpenAI 兼容端点。界面控件复用系统
UI 原语（`@deepseek-ai/dsh-client-ui-primitives` 的 Button / Pill），与 dsh 外壳风格一致并跟随主题。

## ✨ 功能特性

- **文生图 / 图生图**：文本生成图片；上传参考图（multipart `image` + `prompt`）进行图生图编辑。
- **三栏生图工作台**：
  - 左侧：卡片分组配置面板 —— 模式切换（Pill）、参考图上传、提示词输入（右下角 `0/2000` 字符计数）、
    Pill 圆角选择参数组（尺寸 / 清晰度 / 生成数量 / 细节）；底部「模型 + 开始生成」为独立固定栏。
  - 中间：结果展示画布（加载态 / 空态 / 错误提示 / 图片网格，支持下载）；点击图片打开大图预览
    （左右切换、缩放、下载，ESC 关闭）。
  - 右侧：**历史记录**列 —— 每次生成自动保存（提示词、参数与图片），**跨设备共享**。
- **历史跨设备共享**：历史存于 DSH 宿主侧 `~/.dsh/dsh-imagegen/`（图片落盘为独立文件 + `index.json`
  索引），所有连到同一台 DSH 的浏览器/设备看到同一份；最多 50 条、超出自动淘汰最旧，
  支持点击查看、恢复参数、单条删除与一键清空。
- **独立配置卡片**：「设置 → 插件 → 可配置」中提供本插件的**独立**配置卡片（官方插件配置槽位，
  与 dsh-web-ui 全家桶的「Web UI 插件」分组无关）：**api_url**、**api_key**（以及启停开关与
  Agent 播报开关）。

## 🛡️ 安全设计

- **API 密钥不出浏览器**：生成请求由宿主进程代理转发，`api_key` 只存在宿主侧设置文档
  （`~/.dsh/settings.yaml`，明文，本机私有），设置桥（describe/mutate）一律 `redactSecrets`，
  浏览器只能看到"密钥是否已设置"。
- **设置命名空间自给自足**：rc.6 的 host-apiproxy 只放行内置命名空间白名单，第三方插件命名空间
  一律 `settings-not-exposed`；本插件用自己的 loopback 路由 `/api/dsh-imagegen/settings/{describe,mutate}`
  重新托起命名空间，不依赖 dsh-web-ui-settings 包的家族白名单，也不修改 dsh 源码。
- **单占位中栏**：与 dsh-task-board / dsh-ssh 互斥（`dsh-panel-activate` 事件 + `<html>` 激活属性），
  侧栏条目与面板挂载均为 DOM 级自愈注入。

## 🏗️ 架构

| 面 | 文件 | 职责 |
| --- | --- | --- |
| Host（Node） | `src/index.ts` | 插件入口：settings 段注册、路由挂载、系统提示词播报 |
| Host（Node） | `src/routes.ts` | `/api/dsh-imagegen/*` 路由族（loopback 专用） |
| Host（Node） | `src/engine.ts` | 上游代理：`/images/generations` 与 `/images/edits`，响应归一化 |
| Host（Node） | `src/history-store.ts` | 历史持久化：`~/.dsh/dsh-imagegen/`（图片落盘 + index.json） |
| Client（Web） | `src/client/index.ts` | 浏览器入口：语言包、设置卡片槽位、侧栏入口与面板挂载 |
| Client（Web） | `src/client/ImageGenPanel.tsx` | 生图工作台 UI（三栏布局 / 历史列 / 大图预览） |
| Client（Web） | `src/client/api.ts` | 浏览器数据入口：生成 + 历史 list/append/remove/clear |
| Client（Web） | `src/client/SettingsCard.tsx` | 配置卡片（api_url / api_key） |

### 上游协议

- **文生图**：`POST {api_url}/images/generations`（JSON）
- **图生图**：`POST {api_url}/images/edits`（multipart，`image` + `prompt` + `model` + 参数）
- 响应支持 OpenAI 兼容的 `{ data: [{ b64_json | url }] }`；返回 `url` 时由宿主下载并转 base64，
  浏览器无 CORS 问题。
- **参数透传**：`detail`（细节）为透传参数，部分 gpt-image-2 网关支持；官方 OpenAI 接口会拒绝
  未知参数，请保持「自动」（不发送）。宿主侧保留对非 gpt-image-2 模型名的防御性钳制，UI 仅提供
  gpt-image-2。

## 📦 安装到 DSH（web profile）

```bash
# 1) 构建（需要 node >= 20 与 pnpm）
pnpm install
pnpm run build

# 2) 注册到 web profile（路径按实际修改）
#    - 在 profile 的 package.json dependencies 中加入：
#        "@dsh-local/dsh-imagegen": "link:E:/dsh-plugin"
#    - 在 profile 的 cordis.patch.yml 追加：
#        - insert:
#            - id: imagegen
#              name: '@dsh-local/dsh-imagegen'
#    - 在 profile 目录执行：pnpm install

# 3) 重启 DSH 桌面应用（插件集变更需重启；bundle 内容变更由 client-hmr 轮询自动热更）
```

## ⚙️ 配置

在 GUI「设置 → 插件 → 可配置」中展开「AI 生图（dsh-imagegen）」卡片（该卡片注册在官方
`settings.plugin.item` 槽位，独立于 dsh-web-ui 全家桶的「Web UI 插件」分组）：

- **API 地址（api_url）**：OpenAI 兼容接口基址，如 `https://api.openai.com/v1`
  （自动拼接 `/images/generations`、`/images/edits`）。
- **API 密钥（api_key）**：Bearer 密钥；界面只显示是否已设置，可随时更换或清除；
  留空保存表示"不修改"，不会误清已存密钥。

## 🔧 开发

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsdown：lib/index.js（Host）+ lib/client.js（Web bundle）
pnpm run watch       # 增量构建
```

构建产物契约（与 dsh `packages/client/tsdown.client.ts` 预设一致）：客户端 bundle 以
`window.__ModuleLoader__.load({ id, factory })` 注册，平台模块（react、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-runtime/client` 等）走注入的 require，
其余依赖内联；`*.module.css` 由 lightningcss 编译并以 `<style data-plugin-css>` 注入。

## 📄 许可

[Apache-2.0](./LICENSE)

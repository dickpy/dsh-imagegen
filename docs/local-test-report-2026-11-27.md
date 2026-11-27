# dsh-imagegen 统一修改本地测试报告

- 修改分支：`unified-issue-fixes`
- 基线：`origin/main` `8b6ce53`（v1.22.1）
- 当前版本：仍为 `1.22.1`，未改版本号、未创建 Release、未发布 npm 包
- 本地已安装：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@dickpy\dsh-imagegen\lib`
- 安装备份：`lib.__old-20261127-212447`（最近一次安装；更早备份 `lib.__old-20261127-210850`、`lib.__old-20261127-200922`、`lib.__old-20261127-200643`、`lib.__old-20261127-200446`）

## 一、本次统一修改内容

| 事项 | 实现 |
|---|---|
| #109 侧栏接管回归 | 合入 PR：接管时只隐藏面板列表与「新会话」行，保留窗口按钮带、品牌行与收起按钮；Islands 顶部 8px + 36px 保留 |
| #105 结果卡片比例 | 合入 PR：新增 `ResultSheet`，实时结果/历史/素材详情共用；卡片按原图比例收缩，旧记录按自然尺寸补齐 |
| #108 下载 0 字节 | 新增统一 Blob 下载 helper；结果卡片、预览、右键菜单、电商、画廊批量、画布节点全部改走 Blob URL / attachment 路由，不再用大体积 `data:` URL 下载 |
| #106 预览放大与关闭按钮 | lightbox 从 1100×820 放宽到 `min(1680px, 100vw-96px)` × `min(1200px, 100vh-40px)`；关闭按钮移到右上偏左下（44×44），并加 `z-index` 保证可点 |
| #107 参数栏抽屉与重复箭头 | 参数栏宽度 180ms 过渡，拖动 resizer 时禁用过渡；侧栏历史入场滑入；参数栏收起按钮放在面板 header 的 GitHub 按钮右侧，使用面板图标；旧的 `‹` 箭头移除 |
| 侧栏收起按钮 | 面板 header 最左侧按钮改为“收起/展开最左侧边栏”，转发宿主 `[data-sidebar-toggle]`，再点恢复；「回到对话」保留为退出工作室 |
| 多图动态排版 | 结果区测量宽度与每张图宽高比，按可读列数动态分行；三张竖图从 2+1 改为同排三列，两图保持并排，横图保持 2+1/2×2 |
| 预览滚轮切图 | 文生图/图生图结果区滚轮切换上一条/下一条历史记录（260ms 节流）；点击大图后的 lightbox 滚轮仍为缩放 |
| #104 Cloudflare Workers AI | 新增 `cloudflare` model family、原生 Run API adapter、`cloudflare-workers-ai` 预设和 `@cf/black-forest-labs/flux-1-schnell` 模型；支持 JSON base64 与二进制两种响应；图生图暂不支持 |
| 额外 | 增加下载单元测试、Cloudflare 协议测试、结果下载/预览尺寸/参数栏收起浏览器断言 |

## 二、本地测试结果

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过（exit 0） |
| `pnpm test` | 通过：单测 120 项、remote 14 项、iterations 6 项、全部 DOM E2E 通过 |
| `node scripts/smoke.mjs` | 通过：全量 host smoke（客户端 apply、侧栏、画布与下载相关路径） |
| `pnpm run test:studio:browser` | 通过；含结果下载文件大小、预览宽度/关闭按钮位置、参数栏收起宽度/位置断言 |
| `pnpm run test:history:browser` | 通过；含历史、分页、侧栏几何、结果卡片比例、三张竖图动态同排、滚轮切历史图回归 |
| `pnpm run test:history` | 通过；`sidebar-takeover-dom-e2e` 验证品牌行/收起按钮/Islands 顶部带保留 |
| `install-to-profile.ps1 -DryRun` | 通过：5 个文件、6775 KB、所有相对 import 可解析 |
| `install-to-profile.ps1 -KeepBackup` | 通过：原子替换完成，宿主入口 import smoke `IMPORT_OK 120` |

## 三、未覆盖 / 需要人工确认

1. **Cloudflare 真实上游没有跑通**：本次没有可用的 Cloudflare Account ID / API Token，只验证了 mock 的 JSON base64、二进制 PNG、错误与配置缺失路径。拿到 Token 后建议用 `@cf/black-forest-labs/flux-1-schnell` 做一次真实 smoke。
2. **历史文件/项目分类与拖拽**：#107 的后半段是 issue 作者计划另提 PR 的功能，本次只做参数栏抽屉、侧栏收起按钮和去重箭头，没有擅自设计文件夹数据模型。
3. **侧栏顶部空白**：接管态保留的是宿主自己的品牌行/窗口按钮带；如果所用皮肤本身不绘制品牌，剩余空白属于宿主预留带，本次没有强改宿主 grid（避免 macOS 交通灯回归），可在具体皮肤上再单独适配。
4. **macOS 真机**：本地测试在 Windows + Edge Chromium 完成；#109 的 macOS 交通灯场景按 PR 作者描述和 DOM/CSS 断言验证，建议在 macOS 桌面版再截图确认。
5. **4K 超大屏**：预览上限 1680×1200，若用户希望完全铺满 4K，需要再讨论是否增加“适应窗口/100%”切换。

## 四、本地打开方式

1. 当前已把构建产物安装到 desktop profile；重启 DSH 桌面应用（或让宿主重新加载插件）后生效。
2. 打开「生图」面板，重点检查：
   - 左侧栏顶部：交通灯/品牌行/「回到对话」/「生图历史」自上而下不重叠；
   - 生成一张较大图片，右键或卡片下载，选择桌面路径保存，检查文件非 0 字节；
   - 点图片打开预览，确认预览区域明显变大、右上角关闭按钮不再贴窗口关闭按钮；
   - 点面板 header 的参数栏图标，确认参数栏抽屉式收合，且没有第二个箭头；
   - 设置 → 生图配置 → 新增渠道，选择 Cloudflare Workers AI（实验），确认预填 `flux-1-schnell` 和 `{ACCOUNT_ID}` 地址。
3. 若要重新构建并安装：`pnpm run build` 后执行 `.\install-to-profile.ps1 -KeepBackup`。

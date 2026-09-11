/**
 * dsh-imagegen — host half. Mounts the plugin's settings section (channels
 * with per-channel model catalogs on the host settings seam), the
 * /api/dsh-imagegen route family (loopback-only settings bridge + presets /
 * usage / image-generation proxy that keeps every API key host-side), and a
 * system-prompt announcement. The browser half (./client) renders the sidebar
 * entry and the split-pane generation studio.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installSettingsSectionCompat, settingsNamespaceCompat } from './settings-compat.ts'
import z from 'schemastery'// Type-only: pulls the webServer Context merge (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge (announcement section).
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: pulls the human slash-command registry Context merge.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
// The skills + agents seams are reached through `ctx.inject` and read
// structurally (see CanvasSkillServices): the host half must not import those
// packages at runtime, and this deployment does not resolve them at
// type-check time either.
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGEGEN_SETTINGS_NAMESPACE, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type ChannelConfig, type ModelMapping } from './protocol.ts'
import { makeRoutes, type SettingsSeam } from './routes.ts'
import { syncAllTemplates } from './templates-store.ts'
import { setStorageSyncHandler, putObject, type StorageSyncConfig } from './storage-sync.ts'

/**
 * The concrete driver contract behind `ctx.agents`. The registry's published
 * `Agent` type only guarantees an id (the driver augmentation lives in
 * `dsh-agent-loop`), so the canvas skill runner reads the driver surface it
 * actually needs and fails loudly at runtime if a host shells out a different
 * driver without it.
 */
interface CanvasSkillAgent {
  readonly session: { deriveMessages: () => readonly unknown[] }
  followup: (message: { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'plugin'; plugin: string } }) => void
  whenIdle: () => Promise<void>
  cancel: (cause: string) => void
}

/** Error text for user-facing copy (never a bare `[object Object]`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Structural view of the injected host services (skills registry, agents). */
interface CanvasSkillServices {
  skills: {
    list: () => Promise<Array<{ name: string; description: string; whenToUse?: string; path?: string; invocation?: { modelInvocable?: boolean }; metadata?: Readonly<Record<string, unknown>> }>>
    get: (name: string) => Promise<{ name: string; content: string; metadata?: Readonly<Record<string, unknown>> } | undefined>
  }
  agents: {
    create: (options: {
      sessionId: string
      meta?: { cwd?: string; origin?: 'subagent'; agentPreset?: string }
      signal?: AbortSignal
      setup?: (agentCtx: Context) => void
    }) => Promise<{ agent: CanvasSkillAgent; dispose: () => Promise<void> }>
  }
}

/**
 * Wrap the host skill registry for the canvas runner: only model-invocable
 * skills are offered (the canvas runs every skill through a model, so a
 * user-only slash-command skill would fail halfway), and the summary is
 * narrowed to the fields the tier heuristic reads.
 * @param skills - the injected `ctx.skills` service.
 * @returns the runner's registry seam.
 */
export function createSkillRegistryBackend(skills: CanvasSkillServices['skills']): SkillRegistryBackend {
  return {
    list: async () => {
      const listed = await skills.list()
      return listed
        .filter(summary => summary.invocation?.modelInvocable !== false)
        .map(summary => ({
          name: summary.name,
          description: summary.description,
          ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
          ...summary.path === undefined ? {} : { path: summary.path },
          ...summary.metadata === undefined ? {} : { metadata: summary.metadata },
        }))
    },
    get: async name => {
      const definition = await skills.get(name)
      if (definition === undefined) return undefined
      return {
        name: definition.name,
        content: definition.content,
        ...definition.metadata === undefined ? {} : { metadata: definition.metadata },
      }
    },
  }
}

/** Content type for a saved image file name (object uploads). */
function mimeOfPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}
import { ImageGenerationRuntime, type ChannelsView, type RuntimeChannel } from './generation-runtime.ts'
import { registerAgentImageTools } from './agent-image-tools.ts'
import { registerEditImageCommand } from './edit-image-command.ts'
import { setImageDataRoot, imageDataRoot } from './image-storage-path.ts'
import { presetById } from './presets.ts'
import { chatComplete } from './prompt-enhancer.ts'
import { SkillRunner, setSkillTranslate, type SkillAgentBackend, type SkillCanvasBackend, type SkillChatBackend, type SkillRegistryBackend } from './skill-runner.ts'
import { installFromArchive, installFromUrl, knownSkillUrl, listLibrary, removeSkill, SkillStoreError, skillsRoot } from './skill-store.ts'
import { EDITABLE_PPT_SKILL } from './skills-catalog.ts'
import { canvasStore } from './canvas-store.ts'
import { imageGenLanguageOf, interpolate } from './locale-tables.ts'

/** Stable cordis plugin name. */
export const name = 'imagegen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt', 'commands']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, ImageGenError } from './engine.ts'
export { promptCharLimit } from './model-catalog.ts'
export { analyzeLayers, normalizeLayerPlan, MAX_LAYER_IMAGE_BYTES } from './layer-analyzer.ts'
export { ImageGenerationRuntime } from './generation-runtime.ts'
export { registerAgentImageTools } from './agent-image-tools.ts'
export { latestSessionImage, registerEditImageCommand } from './edit-image-command.ts'
export { appendGallery, clearGallery, listGallery, readGalleryImage, removeGallery, updateGalleryTags } from './gallery-store.ts'
export { listTemplates, readTemplateImage, refreshTemplates, sampleTemplates, syncAllTemplates, clearTemplateMemo } from './templates-store.ts'
export { addTemplateFavorite, clearTemplateFavoritesMemo, listTemplateFavorites, removeTemplateFavorite } from './template-favorites.ts'
export { putObject, setStorageSyncHandler, testStorage, type StorageSyncConfig } from './storage-sync.ts'
export { SkillRunner, setSkillTranslate, setSkillLanguage } from './skill-runner.ts'
export { builtinCanvasSkills, canvasSkillCatalog, EDITABLE_PPT_SKILL, findCanvasSkill, isEditablePptSkill, mergeExternalSkills, tierOfExternalSkill } from './skills-catalog.ts'
export { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
export { classifySource, installFromArchive, installFromUrl, isValidSkillName, KNOWN_SKILL_SOURCES, knownSkillUrl, listLibrary, parseSkillFrontmatter, removeSkill, SkillStoreError, skillsRoot, MAX_SKILL_ARCHIVE_BYTES } from './skill-store.ts'
export { isZipDirectory, readZipDirectory, readZipEntry } from './zip.ts'
export { canvasStore, isBlockedFileName, fileKindOf, MAX_CANVAS_FILE_BYTES, mimeFromFileName, safeFileName } from './canvas-store.ts'
export { checkForUpdate, clearUpdateCache, compareVersions, CURRENT_VERSION, installUpdate, profileFromProcess } from './updater.ts'

/** The branded settings namespace of this plugin (the card edits it). */
export const ImageGenSettingsNamespace = settingsNamespaceCompat(IMAGEGEN_SETTINGS_NAMESPACE)

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * Channels own the endpoint + model catalog. The API key of each channel lives
 * in `channelSecrets` (a secret dict keyed by channel id) instead of inside the
 * channel objects — dsh-settings redaction supports dict/array containers, but
 * path ops cannot reach inside arrays, so a whole-array write must never carry
 * secrets it would clobber.
 */
export interface Config {
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
  /** Announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Allow Agents to submit and retrieve image-generation tasks. */
  allowAgentImageGeneration?: boolean
  /** Configured channels (each: name, endpoint, model catalog). */
  channels?: ChannelConfig[]
  /** Per-channel API keys, keyed by channel id. */
  channelSecrets?: Record<string, string>
  /** Channel used when a request does not name one. */
  defaultChannelId?: string
  /** Optional OpenAI-compatible chat endpoint for prompt enhancement. */
  promptApiUrl?: string
  /** Optional secret for the prompt enhancement endpoint. */
  promptApiKey?: string
  /** Chat model used to expand short image prompts. */
  promptModel?: string
  /** Local root for generated/history/gallery/canvas images. Empty keeps the default under DSH_HOME. */
  localStoragePath?: string
  /** Sync saved images to an S3-compatible object store (COS / OSS / Qiniu S3 …). */
  storageEnabled?: boolean
  /** S3-compatible endpoint URL including the bucket (virtual-hosted or path style). */
  storageEndpoint?: string
  /** Provider region for SigV4 scope, e.g. ap-guangzhou / oss-cn-hangzhou. */
  storageRegion?: string
  /** Object key prefix, default 'dsh-imagegen'. */
  storagePrefix?: string
  /** S3 access key id. */
  storageAccessKey?: string
  /** S3 secret access key (stored redacted). */
  storageSecretKey?: string
  /** Upload gallery additions (default on when storage is enabled). */
  storageSyncGallery?: boolean
  /** Also upload history images. */
  storageSyncHistory?: boolean
  /* ------------------------- infinite-canvas skills ------------------------- */
  /** Master switch for canvas skills (menu, runs, produced nodes). */
  skillsEnabled?: boolean
  /** Allow heavy skills, which run a headless DSH agent (slow, token-hungry). */
  allowHeavySkills?: boolean
  /** External-skill allowlist (comma/newline separated; empty = all installed). */
  skillAllowlist?: string
  /** Working directory for heavy skill runs; empty uses `<data>/canvas/runs`. */
  skillOutputDir?: string
  /** Heavy-skill timeout in minutes (0 disables the timeout). */
  skillHeavyTimeoutMinutes?: number
  /** Headless-agent preset used for heavy runs; empty uses the host default. */
  skillAgentPreset?: string
  /* ----- deprecated legacy single-endpoint fields (migrated to channels) ----- */
  /** Legacy base URL; synthesized into the default channel on upgrade. */
  apiUrl?: string
  /** Legacy secret; migrated into channelSecrets on upgrade. */
  apiKey?: string
  /** Legacy allow-list; migrated into the default channel's catalog. */
  imageModels?: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  allowAgentImageGeneration: z.boolean().default(true),
  channels: z.array(z.object({
    id: z.string(),
    preset: z.string().default(''),
    name: z.string().default(''),
    apiUrl: z.string().default(''),
    models: z.array(z.object({
      alias: z.string(),
      id: z.string(),
    })).default([]),
  })).default([]),
  channelSecrets: z.dict(z.string().role('secret')).default({}),
  defaultChannelId: z.string().default(''),
  promptApiUrl: z.string().default(''),
  promptApiKey: z.string().role('secret').default(''),
  promptModel: z.string().default(''),
  localStoragePath: z.string().default(''),
  storageEnabled: z.boolean().default(false),
  storageEndpoint: z.string().default(''),
  storageRegion: z.string().default(''),
  storagePrefix: z.string().default('dsh-imagegen'),
  storageAccessKey: z.string().default(''),
  storageSecretKey: z.string().role('secret').default(''),
  storageSyncGallery: z.boolean().default(true),
  storageSyncHistory: z.boolean().default(false),
  skillsEnabled: z.boolean().default(true),
  allowHeavySkills: z.boolean().default(true),
  skillAllowlist: z.string().default(''),
  skillOutputDir: z.string().default(''),
  skillHeavyTimeoutMinutes: z.number().default(20),
  skillAgentPreset: z.string().default(''),
  apiUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  imageModels: z.array(z.string()).default([]),
})

/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true
const DEFAULT_ALLOW_AGENT_IMAGE_GENERATION = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-imagegen 插件（DSH AI 生图）：侧边栏「AI 生图」入口。能力：通过「渠道」对接 OpenAI 兼容图像生成 API（每个渠道 = 一个 API 端点 + 各自的模型目录），支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送；智谱 `glm-image` 使用官方 `/api/paas/v4/images/generations`，当前仅支持文生图；qwen-image 系列使用阿里云 DashScope 原生接口（api_url 填 https://dashscope.aliyuncs.com/api/v1，不支持 OpenAI 兼容模式，该渠道不可复用于提示词增强，尺寸自动映射为宽*高）。MiniMax `image-01` 使用 MiniMax 原生 `/image_generation` 接口（api_url 填 https://api.minimax.io/v1 或国内站 https://api.minimaxi.com/v1，支持 1:1/16:9/4:3/3:2/2:3/3:4/9:16/21:9 宽高比，一次最多 9 张；图生图为单张 subject_reference 主体参考（保持人物/主体一致，非像素级局部编辑）；其 /models 只列聊天模型，图片模型需用预设目录）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用用户在各渠道配置目录中的模型；检测模型时会过滤聊天、Embedding 等非图片模型，但模型出现在 /models 中仍不等于其网关原生支持生图协议，遇到 Qwen、MiniMax、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：多来源标签页（精选案例库 / 沧河案例库，后续可扩展），打包 awesome-gpt-image-2 的数百条提示词案例，可搜索、筛选、收藏（星标，宿主持久化）与复用；各来源列表独立刷新，宿主每 12 小时后台自动同步一次。Agent 可直接调用 `generate_image` 提交文生图，也可用 `edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外伪造用户消息。用户也可以使用 `/edit_image <修改描述>`，命令会直接读取当前对话最近图片并调用插件图片模型，不经过对话模型的图片能力检查。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库在线刷新与参考图首次加载需要访问对应来源站点（vibeui.top / gpt-image2.canghe.ai）。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。无限画布的图片节点还有四个纯界面能力（标注局部改图：画框后挂一张跟随图片移动的提示词卡片、本地抠图去背景、按视觉模型拆分图层、为节点指定模型），它们由用户在画布上操作，Agent 无需也无法触发。无限画布现在还支持「技能」：任意图片/文本/文件节点（生成配置节点除外）的悬浮工具条或右键菜单都有「技能」入口，内置动作包括文本润色（polish.text，可指定 formal/casual/shorter/expand 或自定义指令）、图片描述（describe.image）、内容抽取（extract.content：文本/代码/OOXML/PDF 抽取为文本节点），以及重任务「图片转可编辑 PPT」（ppt.fromImages）；同时会列出本机 ~/.dsh/skills 下所有可被模型调用的技能（id 形如 skill:<名称>）。轻量技能直接调用「提示词增强」所配置的聊天模型；重任务技能会启动一个无头 DSH Agent 在本机执行真实流水线（读写文件、跑 CLI），可能持续数分钟到数十分钟并消耗较多额度，因此界面会先弹确认框。`image-to-editable-ppt` 需要用户自行安装该技能，并按它的文档配置 OCR Token 与图片后端，未安装时运行会返回可操作的 skill-missing 提示；底部 Dock 的「技能库」面板可以在线安装（粘贴仓库/压缩包/SKILL.md 链接，支持 GitHub、裸 git、raw 与 zip）或上传本地技能压缩包，也可以卸载，装好后宿主会热加载、无需重启。文件节点支持拖拽或菜单上传任意文件（单文件 ≤50MB，脚本/可执行文件被拒绝），图片与 PDF 可内联预览，其他类型以下载方式提供（宿主以 application/octet-stream + attachment 返回）；技能运行只产出节点与连线草稿，由浏览器端写入画布文档。相关设置在「设置 → 插件 → AI 生图 → 无限画布技能」（总开关、是否允许重任务、技能白名单、重任务工作目录、超时分钟数、Agent 预设，并可一键检测技能环境）。'

/** Append the live channel × model table so an Agent can honor user choices. */
function guidanceFor(channels: RuntimeChannel[], defaultChannelId: string): string {
  if (channels.length === 0) {
    return `${IMAGEGEN_GUIDANCE} 尚未配置任何渠道：请先在「设置 → 插件 → AI 生图」添加渠道并填写 API 地址与密钥。`
  }
  const table = channels.map(channel => {
    const aliases = channel.models.map(model => model.alias).join('、')
    const mark = channel.id === defaultChannelId ? '（默认渠道）' : ''
    const key = channel.apiKey === '' ? '（未填密钥）' : ''
    const models = channel.models.length === 0 ? '未配置模型' : `可用模型：${aliases}`
    return `渠道「${channel.name}」${mark}[${channel.apiUrl}] ${models}${key}`
  }).join('；')
  return `${IMAGEGEN_GUIDANCE} 当前渠道与模型：${table}。用户指定模型名时取该模型所属渠道（多渠道同名用默认渠道）；未指定模型时若仅一个可用模型可直接生成，若有多个应先询问用户选择「渠道 + 模型」。`
}

/** Normalize raw channel entries into the wire shape (schema-adjacent guard). */
function normalizeChannels(value: unknown): ChannelConfig[] {
  if (!Array.isArray(value)) return []
  const out: ChannelConfig[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') continue
    const models: ModelMapping[] = []
    if (Array.isArray(raw.models)) {
      for (const entry of raw.models) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Record<string, unknown>
        const alias = typeof record.alias === 'string' ? record.alias.trim() : ''
        const upstream = typeof record.id === 'string' ? record.id.trim() : ''
        if (alias === '') continue
        models.push({ alias, id: upstream === '' ? alias : upstream })
      }
    }
    out.push({
      id,
      preset: typeof raw.preset === 'string' ? raw.preset : '',
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl.trim() : '',
      models,
    })
  }
  return out
}

/** Effective config (schema defaults applied + legacy migration). */
export interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  allowAgentImageGeneration: boolean
  channels: RuntimeChannel[]
  defaultChannelId: string
  promptApiUrl: string
  promptApiKey: string
  promptModel: string
  storage: StorageSyncConfig & { enabled: boolean; syncGallery: boolean; syncHistory: boolean }
  /** Infinite-canvas skill settings. */
  skills: {
    enabled: boolean
    allowHeavy: boolean
    allowlist: string[]
    outputDir: string
    heavyTimeoutMs: number
    agentPreset: string
  }
}

/**
 * Mount the settings section, routes, and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): (() => void) | void {
  // The live source the surfaces read: the settings section once the settings
  // service is attached, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): EffectiveConfig => {
    const value = current() ?? {}
    setImageDataRoot(value.localStoragePath)
    let channels = normalizeChannels(value.channels)
    // Settings scopes are deep-frozen by the host. Legacy migration adds the
    // synthesized default-channel secret, so always work on a detached copy.
    const secrets: Record<string, string> = { ...(value.channelSecrets ?? {}) }
    // Legacy single-endpoint migration: no channels yet → synthesize the
    // default channel from the old flat fields so upgrades never break.
    if (channels.length === 0) {
      const legacyUrl = typeof value.apiUrl === 'string' ? value.apiUrl.trim() : ''
      const legacyModels: ModelMapping[] = Array.isArray(value.imageModels)
        ? value.imageModels
          .filter((model): model is string => typeof model === 'string' && model.trim() !== '')
          .map(model => ({ alias: model.trim(), id: model.trim() }))
        : []
      if (legacyUrl !== '' || legacyModels.length > 0) {
        channels = [{ id: 'default', preset: '', name: '默认渠道', apiUrl: legacyUrl, models: legacyModels }]
        const legacyKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
        if (legacyKey !== '') secrets['default'] = legacyKey
      }
    }
    const named = channels.map(channel => ({
      ...channel,
      name: channel.name === '' ? (presetById(channel.preset)?.name ?? '未命名渠道') : channel.name,
    }))
    const defaultChannelId = typeof value.defaultChannelId === 'string' && named.some(channel => channel.id === value.defaultChannelId)
      ? value.defaultChannelId
      : named[0]?.id ?? ''
    return {
      enabled: value.enabled ?? DEFAULT_ENABLED,
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      allowAgentImageGeneration: value.allowAgentImageGeneration ?? DEFAULT_ALLOW_AGENT_IMAGE_GENERATION,
      channels: named.map(channel => ({
        ...channel,
        apiKey: typeof secrets[channel.id] === 'string' ? secrets[channel.id] : '',
      })),
      defaultChannelId,
      promptApiUrl: typeof value.promptApiUrl === 'string' ? value.promptApiUrl.trim() : '',
      promptApiKey: typeof value.promptApiKey === 'string' ? value.promptApiKey.trim() : '',
      promptModel: typeof value.promptModel === 'string' ? value.promptModel.trim() : '',
      storage: {
        enabled: value.storageEnabled ?? false,
        endpoint: typeof value.storageEndpoint === 'string' ? value.storageEndpoint.trim() : '',
        region: typeof value.storageRegion === 'string' ? value.storageRegion.trim() : '',
        accessKey: typeof value.storageAccessKey === 'string' ? value.storageAccessKey.trim() : '',
        secretKey: typeof value.storageSecretKey === 'string' ? value.storageSecretKey.trim() : '',
        prefix: typeof value.storagePrefix === 'string' && value.storagePrefix.trim() !== '' ? value.storagePrefix.trim() : 'dsh-imagegen',
        syncGallery: value.storageSyncGallery ?? true,
        syncHistory: value.storageSyncHistory ?? false,
      },
      skills: {
        enabled: value.skillsEnabled ?? true,
        allowHeavy: value.allowHeavySkills ?? true,
        allowlist: (value.skillAllowlist ?? '')
          .split(/[\n,]/)
          .map(item => item.trim())
          .filter(item => item !== ''),
        outputDir: typeof value.skillOutputDir === 'string' ? value.skillOutputDir.trim() : '',
        heavyTimeoutMs: Math.max(0, Math.round((value.skillHeavyTimeoutMinutes ?? 20) * 60_000)),
        agentPreset: typeof value.skillAgentPreset === 'string' ? value.skillAgentPreset.trim() : '',
      },
    }
  }

  // Transient helper used by several mount points below: resolve the shared
  // channel view once per access; the runtime then picks per-request creds.
  const channelsView = (): ChannelsView => {
    const value = resolve()
    return { channels: value.channels, defaultChannelId: value.defaultChannelId }
  }

  // Object-storage sync: the image stores announce every file they write; the
  // handler resolves the live settings and uploads when enabled. Fire and
  // forget — a sync failure never blocks the save path.
  setStorageSyncHandler((kind, filePath) => {
    const storage = resolve().storage
    if (!storage.enabled || !storage.endpoint.trim() || storage.secretKey.trim() === '') return
    if (kind === 'gallery' && !storage.syncGallery) return
    if (kind === 'history' && !storage.syncHistory) return
    const key = `${storage.prefix}/${kind === 'gallery' ? 'gallery' : 'images'}/${path.basename(filePath)}`
    const data = readFileSync(filePath)
    void putObject(storage, key, data, mimeOfPath(filePath)).catch(() => {
      // Best-effort sync: surfaced through the settings test, never fatal here.
    })
  })

  // Browser endpoints and Agent tools share the exact same serial queue. This
  // keeps image persistence, cancellation, and retries coherent across both
  // entry points; Agent tools wait for their task result by default and render
  // images in the tool result instead of injecting a synthetic user message.
  const runtime = new ImageGenerationRuntime(channelsView)
  const pendingConversationImages = new Map<string, ImageAttachmentRef>()

  // Host-rendered copy (skill catalog labels, run errors, produced node titles)
  // resolves through the same dictionaries the browser bundle ships, so a run
  // started in Chinese never answers in English.
  setSkillTranslate((key, params, language) => interpolate(key, params, imageGenLanguageOf(language)))

  // The canvas skill runner is assembled lazily: its chat tier needs only the
  // prompt-enhancement endpoint (always available), while the heavy tier needs
  // the host agent runtime. `setSkillRuntime` is called from the soft injection
  // below, and routes read it per request — so a deployment without the agent
  // runtime still gets the built-in light actions.
  let skillRunner: SkillRunner | undefined
  const resolveSkills = (): EffectiveConfig['skills'] => resolve().skills
  skillRunner = new SkillRunner({
    backend: {
      canvas: canvasStore as unknown as SkillCanvasBackend,
      chat: {
        complete: async options => chatComplete(
          (() => {
            const value = resolve()
            const channel = value.channels.find(candidate => candidate.id === value.defaultChannelId) ?? value.channels[0]
            return {
              apiUrl: value.promptApiUrl !== '' ? value.promptApiUrl : (channel?.apiUrl ?? ''),
              apiKey: value.promptApiKey !== '' ? value.promptApiKey : (channel?.apiKey ?? ''),
              model: value.promptModel,
            }
          })(),
          options,
        ),
      },
    },
    enabled: () => resolve().enabled && resolveSkills().enabled,
    heavyEnabled: () => resolveSkills().allowHeavy,
    allowlist: () => resolveSkills().allowlist,
    runRoot: () => resolveSkills().outputDir,
    heavyTimeoutMs: () => resolveSkills().heavyTimeoutMs,
    dataRoot: () => imageDataRoot(),
    pptInstallUrl: knownSkillUrl(EDITABLE_PPT_SKILL),
  })

  // Local skill library (`~/.dsh/skills`): the canvas installs skills the same
  // way a user would by hand, and the filesystem skill provider picks them up
  // through its watcher — no host restart.
  let skillRegistryNames: ReadonlyArray<{ name: string; path?: string }> | undefined
  const snapshotLibrary = async (): Promise<CanvasSkillLibrary> => await listLibrary({
    root: skillsRoot(),
    ...skillRegistryNames === undefined ? {} : { known: skillRegistryNames },
    networkAvailable: true,
  })
  const skillLibrary = {
    list: async (): Promise<CanvasSkillLibrary> => await snapshotLibrary(),
    install: async (request: CanvasSkillInstallRequest): Promise<CanvasSkillInstallResult> => {
      const root = skillsRoot()
      const installed: string[] = []
      const failed: Array<{ source: string; message: string }> = []
      let message: string | undefined
      if (request.asset !== undefined) {
        try {
          const found = await canvasStore.readAssets([request.asset])
          const blob = found.get(request.asset.assetId)
          if (blob === undefined) throw new SkillStoreError('上传的压缩包已失效，请重新上传')
          installed.push(await installFromArchive(blob.data, root, request.name ?? 'skill', request.force === true))
        } catch (error) { message = messageOf(error) }
      }
      for (const source of request.sources ?? []) {
        try {
          installed.push(await installFromUrl(source, root, { force: request.force === true, fallbackName: request.name }))
        } catch (error) {
          failed.push({ source, message: messageOf(error) })
        }
      }
      return {
        ok: installed.length > 0,
        installed,
        failed,
        library: await snapshotLibrary(),
        ...message === undefined ? {} : { message },
      }
    },
    remove: async (name: string): Promise<CanvasSkillRemoveResult> => {
      try {
        const removed = await removeSkill(name, skillsRoot())
        return { ok: true, library: await snapshotLibrary(), message: removed }
      } catch (error) {
        return { ok: false, library: await snapshotLibrary(), message: messageOf(error) }
      }
    },
  }

  // Attach the host skill registry and agent runtime when this deployment has
  // them. Both are optional seams: the plugin must keep working (light tier
  // included) on a host that never mounted them.
  ctx.inject(['skills', 'agents'], sctx => {
    const services = sctx as unknown as CanvasSkillServices
    const unregister = sctx.effect(() => {
      const registry = createSkillRegistryBackend(services.skills)
      // The library panel prefers the registry's own paths for installed skills.
      skillRegistryNames = []
      void services.skills.list().then(
        listed => { skillRegistryNames = listed.map(item => ({ name: item.name, ...item.path === undefined ? {} : { path: item.path } })) },
        () => { skillRegistryNames = [] },
      )
      const agents: SkillAgentBackend = {
        available: () => services.agents !== undefined,
        create: async options => {
          const preset = resolveSkills().agentPreset
          const handle = await services.agents.create({
            sessionId: options.sessionId,
            meta: {
              cwd: options.cwd,
              origin: 'subagent',
              ...preset === '' ? {} : { agentPreset: preset },
            },
            ...options.signal === undefined ? {} : { signal: options.signal },
            setup: (agentCtx: Context) => {
              // The skill body rides the agent's own scoped prompt, so the body
              // never has to be re-embedded in the user turn.
              agentCtx.systemPrompt.section({
                name: 'plugin:dsh-imagegen:canvas-skill',
                order: SECTION_ORDER,
                text: options.systemPrompt,
              })
            },
          })
          const agent = handle.agent
          return {
            session: agent.session,
            followup: text => {
              agent.followup({
                id: `canvas-skill-${Date.now().toString(36)}`,
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: 'dsh-imagegen' },
              })
            },
            whenIdle: () => agent.whenIdle(),
            cancel: cause => agent.cancel(cause ?? 'canvas-skill-cancelled'),
            dispose: () => handle.dispose(),
          }
        },
      }
      skillRunner?.attach({ registry, agents })
      return () => { skillRunner?.attach({}) }
    }, 'dsh-imagegen: canvas skills')
    void unregister
  })

  // The route family mounts once, gated on the settings seam (the bridge
  // serves it; without the seam there is nothing to expose). Route handlers
  // read resolve() per request, so config edits apply live. The settings
  // bridge deliberately keeps serving while the plugin is disabled — it is
  // how the user re-enables the plugin from the settings card.
  ctx.inject(['settings', 'attachments'], (sctx) => {
    const seam = sctx.get('settings') as unknown as SettingsSeam
    sctx.effect(
      () => {
        const routes = makeRoutes({
          settings: seam,
          resolve: () => {
            const value = resolve()
            const channel = value.channels.find(candidate => candidate.id === value.defaultChannelId) ?? value.channels[0]
            return { apiUrl: channel?.apiUrl ?? '', apiKey: channel?.apiKey ?? '' }
          },
          resolveChannels: channelsView,
          resolvePrompt: () => {
            const value = resolve()
            const channel = value.channels.find(candidate => candidate.id === value.defaultChannelId) ?? value.channels[0]
            return {
              apiUrl: value.promptApiUrl !== '' ? value.promptApiUrl : (channel?.apiUrl ?? ''),
              apiKey: value.promptApiKey !== '' ? value.promptApiKey : (channel?.apiKey ?? ''),
              model: value.promptModel,
            }
          },
          resolveImageModels: () => {
            const value = resolve()
            return [...new Set(value.channels.flatMap(channel => channel.models.map(model => model.alias)))]
          },
          attachments: sctx.attachments,
          pendingConversationImages,
          runtime,
          resolveStorage: () => resolve().storage,
          skills: skillRunner,
          skillLibrary,
        })
        const disposers = routes.map(route => ctx.webServer.register(route))
        // Background template sync: the upstream sources update on their own
        // schedule, so pull every one of them shortly after start and then
        // twice a day while the plugin stays enabled. Best-effort: failures
        // keep the last good snapshot (bundled or previously refreshed).
        const TEMPLATE_SYNC_INITIAL_DELAY_MS = 30_000
        const TEMPLATE_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
        let syncTimer: NodeJS.Timeout | undefined
        const runSync = (): void => {
          if (!resolve().enabled) return
          void syncAllTemplates().catch(() => { /* keep the last good snapshot */ })
        }
        const startTimer = setTimeout(runSync, TEMPLATE_SYNC_INITIAL_DELAY_MS)
        syncTimer = setInterval(runSync, TEMPLATE_SYNC_INTERVAL_MS)
        syncTimer.unref?.()
        return () => {
          clearTimeout(startTimer)
          clearInterval(syncTimer)
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-imagegen: routes',
    )
  })

  ctx.inject(['tools', 'attachments', 'commands'], (tctx) => {
    tctx.effect(() => {
      const resolveAgentConfig = () => {
        const value = resolve()
        return {
          enabled: value.enabled,
          allowAgentImageGeneration: value.allowAgentImageGeneration,
          channels: value.channels,
          defaultChannelId: value.defaultChannelId,
        }
      }
      const disposeTools = registerAgentImageTools(tctx, runtime, resolveAgentConfig)
      const disposeCommand = registerEditImageCommand(tctx, runtime, resolveAgentConfig, {
        get: sessionId => pendingConversationImages.get(sessionId),
        consume: (sessionId, ref) => {
          if (pendingConversationImages.get(sessionId)?.attachmentId === ref.attachmentId) pendingConversationImages.delete(sessionId)
        },
      })
      return () => {
        disposeCommand()
        disposeTools()
      }
    }, 'dsh-imagegen: agent image tools and commands')
  })

  // System-prompt announcement (toggled by settings changes).
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-imagegen',
      order: SECTION_ORDER,
      text: guidanceFor(value.channels, value.defaultChannelId),
    })
  }

  installSettingsSectionCompat(ctx, ImageGenSettingsNamespace, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()

  return () => { setStorageSyncHandler(undefined) }
}

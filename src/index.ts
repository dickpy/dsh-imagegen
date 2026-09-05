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
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGEGEN_SETTINGS_NAMESPACE, type ChannelConfig, type ModelMapping } from './protocol.ts'
import { makeRoutes, type SettingsSeam } from './routes.ts'
import { syncAllTemplates } from './templates-store.ts'
import { setStorageSyncHandler, putObject, type StorageSyncConfig } from './storage-sync.ts'

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
import { presetById } from './presets.ts'

/** Stable cordis plugin name. */
export const name = 'imagegen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt', 'commands']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, ImageGenError } from './engine.ts'
export { ImageGenerationRuntime } from './generation-runtime.ts'
export { registerAgentImageTools } from './agent-image-tools.ts'
export { latestSessionImage, registerEditImageCommand } from './edit-image-command.ts'
export { appendGallery, clearGallery, listGallery, readGalleryImage, removeGallery, updateGalleryTags } from './gallery-store.ts'
export { listTemplates, readTemplateImage, refreshTemplates, sampleTemplates, syncAllTemplates, clearTemplateMemo } from './templates-store.ts'
export { addTemplateFavorite, clearTemplateFavoritesMemo, listTemplateFavorites, removeTemplateFavorite } from './template-favorites.ts'
export { putObject, setStorageSyncHandler, testStorage, type StorageSyncConfig } from './storage-sync.ts'
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
  storageEnabled: z.boolean().default(false),
  storageEndpoint: z.string().default(''),
  storageRegion: z.string().default(''),
  storagePrefix: z.string().default('dsh-imagegen'),
  storageAccessKey: z.string().default(''),
  storageSecretKey: z.string().role('secret').default(''),
  storageSyncGallery: z.boolean().default(true),
  storageSyncHistory: z.boolean().default(false),
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
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-imagegen 插件（DSH AI 生图）：侧边栏「AI 生图」入口。能力：通过「渠道」对接 OpenAI 兼容图像生成 API（每个渠道 = 一个 API 端点 + 各自的模型目录），支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送；智谱 `glm-image` 使用官方 `/api/paas/v4/images/generations`，当前仅支持文生图；qwen-image 系列使用阿里云 DashScope 原生接口（api_url 填 https://dashscope.aliyuncs.com/api/v1，不支持 OpenAI 兼容模式，该渠道不可复用于提示词增强，尺寸自动映射为宽*高）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用用户在各渠道配置目录中的模型；检测模型时会过滤聊天、Embedding 等非图片模型，但模型出现在 /models 中仍不等于其网关原生支持生图协议，遇到 Qwen、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：多来源标签页（精选案例库 / 沧河案例库，后续可扩展），打包 awesome-gpt-image-2 的数百条提示词案例，可搜索、筛选、收藏（星标，宿主持久化）与复用；各来源列表独立刷新，宿主每 12 小时后台自动同步一次。Agent 可直接调用 `generate_image` 提交文生图，也可用 `edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外伪造用户消息。用户也可以使用 `/edit_image <修改描述>`，命令会直接读取当前对话最近图片并调用插件图片模型，不经过对话模型的图片能力检查。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库在线刷新与参考图首次加载需要访问对应来源站点（vibeui.top / gpt-image2.canghe.ai）。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。'

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

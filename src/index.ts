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
import { mkdir } from 'node:fs/promises'
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
import { IMAGEGEN_SETTINGS_NAMESPACE, type CanvasSkillConfigApplyRequest, type CanvasSkillConfigApplyResult, type CanvasSkillConfigSaveRequest, type CanvasSkillConfigSaveResult, type CanvasSkillConfigView, type CanvasSkillInstallRequest, type CanvasSkillInstallResult, type CanvasSkillLibrary, type CanvasSkillRemoveResult, type ChannelConfig, type ModelMapping } from './protocol.ts'
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
  /** Durable cancellation cause; `user` is the canvas cancel button. */
  cancel: (cause: { kind: 'user' }) => void
}

/**
 * Resolve one skill's configuration declaration and the view the panel renders.
 *
 * Sidecar first, built-in recipe second, nothing third — the plugin never
 * invents a configuration surface for a skill that declared none. Exported so
 * the smoke suite exercises the real lookup (sidecar parsing, recipe fallback,
 * value resolution) rather than a test double of it.
 * @param options - skill name, its library entry path, the skills root, and the
 *   live value store; `issueText` localizes an ignored declaration.
 */
export async function readCanvasSkillConfig(options: {
  name: string
  entryPath?: string
  root: string
  store: SkillConfigStore
  issueText?: (issue: SkillConfigIssue) => string
}): Promise<{ declaration?: SkillConfigDeclaration; issue?: SkillConfigIssue; view?: CanvasSkillConfigView }> {
  const candidates = [...new Set([bundleDirOf(options.entryPath), path.join(options.root, options.name)])]
    .filter((dir): dir is string => dir !== undefined)
  let declaration: SkillConfigDeclaration | undefined
  let issue: SkillConfigIssue | undefined
  for (const dir of candidates) {
    const found = await readSkillConfigFile(dir).catch(() => undefined)
    if (found === undefined) continue
    if (found.manifest === undefined) issue = found.issue ?? 'unreadable'
    else declaration = { manifest: found.manifest, source: 'skill' }
    break
  }
  if (declaration === undefined && issue === undefined) declaration = recipeFor(options.name)
  const values = declaration === undefined ? new Map<string, string>() : valuesFor(declaration, options.store, options.name)
  const view = configView(
    declaration,
    values,
    issue === undefined ? undefined : (options.issueText === undefined ? issue : options.issueText(issue)),
  )
  return {
    ...declaration === undefined ? {} : { declaration },
    ...issue === undefined ? {} : { issue },
    ...view === undefined ? {} : { view },
  }
}

/** The bundle directory a library entry points at, when it is a bundle. */
function bundleDirOf(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined) return undefined
  return path.basename(entryPath).toLowerCase() === 'skill.md' ? path.dirname(entryPath) : undefined
}

/** Error text for user-facing copy (never a bare `[object Object]`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Structural view of the host services (skills registry, agents, presets). */
interface CanvasSkillServices {
  skills: {
    list: () => Promise<Array<{ name: string; description: string; whenToUse?: string; path?: string; invocation?: { modelInvocable?: boolean }; metadata?: Readonly<Record<string, unknown>> }>>
    get: (name: string) => Promise<{ name: string; content: string; metadata?: Readonly<Record<string, unknown>> } | undefined>
  }
  agents: {
    create: (options: {
      sessionId: string
      meta?: { cwd?: string; origin?: 'subagent'; agentPreset?: string }
      agentOptions?: { provider: string; model: string }
      signal?: AbortSignal
      setup?: (agentCtx: Context) => void | Promise<void>
    }) => Promise<{ agent: CanvasSkillAgent; dispose: () => Promise<void> }>
  }
}

/** The agent-preset roster a heavy skill joins (`ctx.agentPresets`). */
interface CanvasAgentPresets {
  /** Resolve the named preset, or the deployment default when omitted. */
  resolve: (id?: string) => Promise<{ id: string }>
  /** Compose a creating agent under that preset; resolves the composed preset. */
  mount: (agentCtx: Context, id?: string) => Promise<{ id: string }>
}

/** The deployment's default model selection (`ctx.agentDefaultModel`). */
interface CanvasDefaultModel {
  currentSelection: () => { provider?: string; model?: string }
}

/** Everything one canvas heavy run needs to compose its headless agent. */
export interface CanvasSkillAgentOptions {
  agents: CanvasSkillServices['agents']
  /** Absent on hosts that mount no preset roster (the heavy tier then refuses). */
  presets?: CanvasAgentPresets
  /** Absent on hosts that publish no default model (the heavy tier then refuses). */
  defaultModel?: CanvasDefaultModel
  /** Configured preset id; empty asks the roster for the deployment default. */
  agentPreset: string
  sessionId: string
  cwd: string
  systemPrompt: string
  signal?: AbortSignal
  /** Localizes a composition failure's copy key (the runner owns the language). */
  fail?: (key: string) => string
}

/**
 * Compose the headless agent one heavy skill run drives.
 *
 * Creating an agent is not enough to make it *useful*: on the Web surface every
 * model-facing row (tools, prompt sections) lives behind an agent preset, and a
 * model route is not implied by the request. DSH's own entry points therefore
 * always pass both — `dsh-api-session-controller` stamps `agentOptions` from the
 * deployment default and mounts the resolved preset in `setup`, and
 * `dsh-subagent` joins the parent's preset for the same reason ("a child that
 * joins no preset sees an empty tool registry and none of its parent's prompt
 * sections"). A skill pipeline that must run a CLI is exactly that case: without
 * the join the agent dies on its first step, and without the model route it has
 * nothing to think with, so the canvas fails the run up front with copy instead
 * of producing an empty result.
 * @param options - host seams plus the run's identity, workspace and skill body.
 * @returns the live agent handle narrowed to what a skill run drives.
 */
export async function createCanvasSkillAgent(options: CanvasSkillAgentOptions): Promise<SkillAgentHandle> {
  const requested = options.agentPreset.trim()
  const presetId = options.presets === undefined
    ? undefined
    : (await options.presets.resolve(requested === '' ? undefined : requested)).id
  const selection = options.defaultModel?.currentSelection()
  const provider = selection?.provider?.trim() ?? ''
  const model = selection?.model?.trim() ?? ''
  const fail = options.fail ?? (key => key)
  if (provider === '' || model === '') throw new Error(fail('canvas.skills.needModel'))
  const handle = await options.agents.create({
    sessionId: options.sessionId,
    meta: {
      cwd: options.cwd,
      origin: 'subagent',
      ...presetId === undefined ? {} : { agentPreset: presetId },
    },
    agentOptions: { provider, model },
    ...options.signal === undefined ? {} : { signal: options.signal },
    setup: async (agentCtx: Context) => {
      // Join the preset FIRST: its rows must exist before the skill body is
      // registered, so the body never shadows the composition it runs inside.
      if (options.presets !== undefined && presetId !== undefined) await options.presets.mount(agentCtx, presetId)
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
    followup: body => {
      agent.followup({
        id: `canvas-skill-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'plugin', plugin: 'dsh-imagegen' },
      })
    },
    whenIdle: () => agent.whenIdle(),
    // The canvas cancel button is the human asking to stop.
    cancel: () => agent.cancel({ kind: 'user' }),
    dispose: () => handle.dispose(),
  }
}

/**
 * Wrap the host skill registry for the canvas runner: only model-invocable
 * skills are offered (the canvas runs every skill through a model, so a
 * user-only slash-command skill would fail halfway), and the summary is
 * narrowed to the fields the tier heuristic reads.
 *
 * The registry alone is not enough on the Web surface. There, a preset owns
 * local discovery: `skill-filesystem` mounts into the *preset's* layer while
 * this plugin is a host-plane bundle, and an unscoped `ctx.skills.list()` reads
 * the global layer alone (the base host row is disabled — see
 * `dsh-web-app/cordis.patch.yml`). Every skill the user installs into
 * `~/.dsh/skills` would therefore be invisible to the canvas, even though the
 * skill library panel lists it. So the local library is read straight from disk
 * as a second source, and both `list` and `get` consult it — the disk source is
 * also what makes a heavy run's body load without the agent's own scope.
 *
 * The canvas is one host surface shared by every session, so it deliberately
 * offers the union: registry entries win a name collision (a deployment-level
 * provider outranks a user install), and the local scan fills the rest.
 * @param skills - the injected `ctx.skills` service.
 * @param options - `root` resolves the local skill library root; omitted (as in
 *   narrow harnesses) leaves only the registry source.
 * @returns the runner's registry seam.
 */
export function createSkillRegistryBackend(
  skills: CanvasSkillServices['skills'],
  options: { root?: () => string } = {},
): SkillRegistryBackend {
  const localRoot = (): string | undefined => options.root?.()
  const localSkills = async (): Promise<LocalSkill[]> => {
    const root = localRoot()
    if (root === undefined) return []
    return await listLocalSkills(root).catch(() => [])
  }
  return {
    list: async () => {
      const listed = await skills.list()
      const merged = new Map<string, ExternalSkillSummary>()
      for (const skill of await localSkills()) {
        merged.set(skill.name, {
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          path: skill.path,
          source: 'filesystem',
        })
      }
      for (const summary of listed) {
        if (summary.invocation?.modelInvocable === false) continue
        merged.set(summary.name, {
          name: summary.name,
          description: summary.description,
          ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
          ...summary.path === undefined ? {} : { path: summary.path },
          ...summary.metadata === undefined ? {} : { metadata: summary.metadata },
        })
      }
      return [...merged.values()]
    },
    get: async name => {
      const definition = await skills.get(name)
      if (definition !== undefined) {
        return {
          name: definition.name,
          content: definition.content,
          ...definition.metadata === undefined ? {} : { metadata: definition.metadata },
        }
      }
      const root = localRoot()
      const local = root === undefined ? undefined : await readLocalSkill(root, name).catch(() => undefined)
      return local === undefined ? undefined : { name: local.name, content: local.content }
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
import { SkillRunner, setSkillTranslate, canvasSkillCopy, type SkillAgentBackend, type SkillAgentHandle, type SkillCanvasBackend, type SkillChatBackend, type SkillRegistryBackend } from './skill-runner.ts'
import { installFromArchive, installFromUrl, knownSkillUrl, listLibrary, listLocalSkills, readLocalSkill, removeSkill, SkillStoreError, skillsRoot, type LocalSkill, type LocalSkillIssue } from './skill-store.ts'
import { applySkillConfigSteps, asConfigDict, configNote, configView, missingFields, parseSkillConfigManifest, readSkillConfigFile, skillConfigKey, valuesFor, type SkillConfigDeclaration, type SkillConfigIssue, type SkillConfigStore } from './skill-config.ts'
import { recipeFor } from './skill-config-recipes.ts'
import { EDITABLE_PPT_SKILL, type ExternalSkillSummary } from './skills-catalog.ts'
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
export { SkillRunner, setSkillTranslate, setSkillLanguage, canvasSkillCopy } from './skill-runner.ts'
export { builtinCanvasSkills, canvasSkillCatalog, EDITABLE_PPT_SKILL, findCanvasSkill, isEditablePptSkill, mergeExternalSkills, tierOfExternalSkill } from './skills-catalog.ts'
export { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
export { buildFilePreview, MAX_PREVIEW_CHARS, type FilePreviewInput } from './file-preview.ts'
export { classifySource, inspectSkillMarkdown, installableSkillName, installFromArchive, installFromUrl, isDshSkillName, isValidSkillName, KNOWN_SKILL_SOURCES, knownSkillUrl, listLibrary, listLocalSkills, parseSkillFrontmatter, readLocalSkill, removeSkill, SkillStoreError, skillsRoot, MAX_SKILL_ARCHIVE_BYTES, type LocalSkill, type LocalSkillIssue } from './skill-store.ts'
export { applySkillConfigSteps, configNote, configView, missingFields, parseSkillConfigManifest, readSkillConfigFile, resolveConfigTarget, skillConfigKey, valuesFor, type SkillConfigDeclaration, type SkillConfigIssue, type SkillConfigStore } from './skill-config.ts'
export { recipeFor, recipeNames } from './skill-config-recipes.ts'
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
  /* --------------------------- skill configuration -------------------------- */
  /**
   * Per-skill configuration values declared by `skill.config.json`, keyed
   * `<skill>/<field>` (see `docs/skill-config.md`). Non-secret values only; the
   * secret half lives in `skillConfigSecrets`.
   */
  skillConfig?: Record<string, string>
  /** Secret half of the skill configuration, stored redacted. */
  skillConfigSecrets?: Record<string, string>
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
  skillConfig: z.dict(z.string()).default({}),
  skillConfigSecrets: z.dict(z.string().role('secret')).default({}),
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
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-imagegen 插件（DSH AI 生图）：侧边栏「AI 生图」入口。能力：通过「渠道」对接 OpenAI 兼容图像生成 API（每个渠道 = 一个 API 端点 + 各自的模型目录），支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送；智谱 `glm-image` 使用官方 `/api/paas/v4/images/generations`，当前仅支持文生图；qwen-image 系列使用阿里云 DashScope 原生接口（api_url 填 https://dashscope.aliyuncs.com/api/v1，不支持 OpenAI 兼容模式，该渠道不可复用于提示词增强，尺寸自动映射为宽*高）。MiniMax `image-01` 使用 MiniMax 原生 `/image_generation` 接口（api_url 填 https://api.minimax.io/v1 或国内站 https://api.minimaxi.com/v1，支持 1:1/16:9/4:3/3:2/2:3/3:4/9:16/21:9 宽高比，一次最多 9 张；图生图为单张 subject_reference 主体参考（保持人物/主体一致，非像素级局部编辑）；其 /models 只列聊天模型，图片模型需用预设目录）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用用户在各渠道配置目录中的模型；检测模型时会过滤聊天、Embedding 等非图片模型，但模型出现在 /models 中仍不等于其网关原生支持生图协议，遇到 Qwen、MiniMax、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：多来源标签页（精选案例库 / 沧河案例库，后续可扩展），打包 awesome-gpt-image-2 的数百条提示词案例，可搜索、筛选、收藏（星标，宿主持久化）与复用；各来源列表独立刷新，宿主每 12 小时后台自动同步一次。Agent 可直接调用 `generate_image` 提交文生图，也可用 `edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外伪造用户消息。用户也可以使用 `/edit_image <修改描述>`，命令会直接读取当前对话最近图片并调用插件图片模型，不经过对话模型的图片能力检查。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库在线刷新与参考图首次加载需要访问对应来源站点（vibeui.top / gpt-image2.canghe.ai）。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。无限画布的图片节点还有四个纯界面能力（标注局部改图：画框后挂一张跟随图片移动的提示词卡片、本地抠图去背景、按视觉模型拆分图层、为节点指定模型），它们由用户在画布上操作，Agent 无需也无法触发。无限画布现在还支持「技能」：任意图片/文本/文件节点（生成配置节点除外）的悬浮工具条或右键菜单都有「技能」入口，内置动作包括文本润色（polish.text，可指定 formal/casual/shorter/expand 或自定义指令）、图片描述（describe.image）、内容抽取（extract.content：文本/代码/OOXML/PDF 抽取为文本节点），以及重任务「图片转可编辑 PPT」（ppt.fromImages）；同时会列出本机 ~/.dsh/skills 下所有可被模型调用的技能（id 形如 skill:<名称>）。轻量技能直接调用「提示词增强」所配置的聊天模型；重任务技能会启动一个无头 DSH Agent 在本机执行真实流水线（读写文件、跑 CLI），可能持续数分钟到数十分钟并消耗较多额度，因此界面会先弹确认框。`image-to-editable-ppt` 需要用户自行安装该技能，并按它的文档配置 OCR Token 与图片后端，未安装时运行会返回可操作的 skill-missing 提示；底部 Dock 的「技能库」面板可以在线安装（粘贴仓库/压缩包/SKILL.md 链接，支持 GitHub、裸 git、raw 与 zip）或上传本地技能压缩包，也可以卸载，装好后宿主会热加载、无需重启。技能可以在 SKILL.md 旁边放 skill.config.json 声明自己需要的配置（字段 + apply 步骤：command 调技能自带 CLI、或写一份配置文件），技能库面板据此渲染「配置」表单并支持保存 / 保存并应用，密钥走设置脱敏存储、不会进入运行目录或提示词；已知技能（image-to-editable-ppt 的 editppt config）插件内置了配方，所以用户不需要手敲配置命令。文件节点支持拖拽或菜单上传任意文件（单文件 ≤50MB，脚本/可执行文件被拒绝），并在节点内直接预览内容：文本/代码/CSV/TSV/JSON 原文、XLSX 表格、DOCX/PPTX/ODT/ODS 抽取文本、ZIP 目录清单都由宿主解码成有限的预览数据返回，图片、PDF、音频、视频由宿主以 inline 响应（支持 HTTP Range，可拖动播放进度）交给浏览器渲染；双击节点或点悬浮工具条的「放大预览」会在全屏阅读器里显示全文并支持复制与下载，无法内联的二进制类型仍以下载方式提供（宿主以 application/octet-stream + attachment 返回，HTML/SVG 一类的标记永远不会内联渲染）。技能运行只产出节点与连线草稿，由浏览器端写入画布文档。相关设置在「设置 → 插件 → AI 生图 → 无限画布技能」（总开关、是否允许重任务、技能白名单、重任务工作目录、超时分钟数、Agent 预设，并可一键检测技能环境）。'

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
  /** Per-skill configuration values, secrets included (host side only). */
  skillConfig: SkillConfigStore
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
      skillConfig: {
        values: asConfigDict(value.skillConfig),
        secrets: asConfigDict(value.skillConfigSecrets),
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

  // ---------------------------------------------------------- skill config
  //
  // A skill may declare the settings it needs in `skill.config.json` beside its
  // `SKILL.md` (see docs/skill-config.md). The plugin renders that declaration,
  // stores the values in its own settings namespace, and runs the declared
  // `apply` steps on request. Known skills that ship no declaration are covered
  // by a built-in recipe; everything else keeps its own conventions.

  /** Settings write path, installed by the settings injection further down. */
  let mutateSettings: ((ops: Array<Record<string, unknown>>) => Promise<void>) | undefined

  /** Entry paths the last library listing resolved, so lookups agree with it. */
  const entryPathByName = new Map<string, string>()

  /** Localize one ignored-declaration reason for the panel. */
  const configIssueText = (language?: string) => (issue: SkillConfigIssue): string => {
    const t = canvasSkillCopy(language)
    switch (issue) {
      case 'unsupported-version': return t('canvas.skills.configIssueVersion')
      case 'empty': return t('canvas.skills.configIssueEmpty')
      default: return t('canvas.skills.configIssueUnreadable')
    }
  }

  /** Resolve one skill's values from the live settings dictionaries. */
  const skillValues = (name: string, declaration: SkillConfigDeclaration): Map<string, string> =>
    valuesFor(declaration, resolve().skillConfig, name)

  /**
   * The library entry path for one skill: the last listing's answer when it has
   * one, else a direct disk read — so a config lookup and the panel agree.
   */
  const entryPathFor = async (name: string): Promise<string | undefined> => {
    const known = entryPathByName.get(name)
    if (known !== undefined) return known
    return (await readLocalSkill(skillsRoot(), name).catch(() => undefined))?.path
  }

  /** Look up a declaration by skill name, reading its path from disk. */
  const declarationByName = async (name: string): Promise<{ declaration?: SkillConfigDeclaration; issue?: SkillConfigIssue }> => {
    const entryPath = await entryPathFor(name)
    return await readCanvasSkillConfig({
      name,
      ...entryPath === undefined ? {} : { entryPath },
      root: skillsRoot(),
      store: resolve().skillConfig,
    })
  }

  /** The directory a `command` step runs in by default (created on demand). */
  const configRunRoot = (name: string): string => {
    const configured = resolveSkills().outputDir.trim()
    const root = configured === '' ? path.join(imageDataRoot(), 'canvas', 'runs') : configured
    return path.join(root, 'skill-config', name)
  }

  // Local skill library (`~/.dsh/skills`): the canvas installs skills the same
  // way a user would by hand, and both the filesystem skill provider (through
  // its watcher) and the canvas catalog below read the same directory — so an
  // install needs no host restart and never stays invisible to node skills.
  let skillRegistryNames: ReadonlyArray<{ name: string; path?: string }> | undefined
  /** One entry's "why the node menu cannot offer this" line, in caller copy. */
  const issueText = (language?: string) => (issue: LocalSkillIssue, name: string): string => {
    const t = canvasSkillCopy(language)
    switch (issue) {
      case 'no-frontmatter': return t('canvas.skills.libraryIssueFrontmatter')
      case 'bad-name': return t('canvas.skills.libraryIssueName', { name })
      case 'no-description': return t('canvas.skills.libraryIssueDescription')
      case 'bad-invocation': return t('canvas.skills.libraryIssueInvocation')
      default: return t('canvas.skills.libraryIssueUserOnly')
    }
  }
  const snapshotLibrary = async (language?: string): Promise<CanvasSkillLibrary> => {
    const library = await listLibrary({
      root: skillsRoot(),
      ...skillRegistryNames === undefined ? {} : { known: skillRegistryNames },
      networkAvailable: true,
      issueText: issueText(language),
    })
    const store = resolve().skillConfig
    const entries = await Promise.all(library.entries.map(async entry => {
      if (entry.path !== undefined) entryPathByName.set(entry.name, entry.path)
      const found = await readCanvasSkillConfig({
        name: entry.name,
        ...entry.path === undefined ? {} : { entryPath: entry.path },
        root: skillsRoot(),
        store,
        issueText: configIssueText(language),
      })
      return found.view === undefined ? entry : { ...entry, config: found.view }
    }))
    return { ...library, entries }
  }
  /** Merge one save request into both dictionaries and write them back. */
  const saveSkillValues = async (
    name: string,
    declaration: SkillConfigDeclaration,
    edits: ReadonlyArray<{ id: string; value: string }>,
  ): Promise<void> => {
    if (mutateSettings === undefined) throw new SkillStoreError(canvasSkillCopy()('canvas.skills.configUnwritable'))
    const store = resolve().skillConfig
    const next: SkillConfigStore = { values: { ...store.values }, secrets: { ...store.secrets } }
    const byId = new Map(declaration.manifest.fields.map(field => [field.id, field]))
    for (const edit of edits) {
      const field = byId.get(edit.id)
      if (field === undefined) continue
      const key = skillConfigKey(name, field.id)
      const dict = field.type === 'secret' ? next.secrets : next.values
      if (edit.value.trim() === '') delete dict[key]
      else dict[key] = edit.value
    }
    await mutateSettings([
      { op: 'set', path: ['skillConfig'], value: next.values },
      { op: 'set', path: ['skillConfigSecrets'], value: next.secrets },
    ])
  }
  const skillLibrary = {
    list: async (options?: { language?: string }): Promise<CanvasSkillLibrary> => await snapshotLibrary(options?.language),
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
        library: await snapshotLibrary(request.language),
        ...message === undefined ? {} : { message },
      }
    },
    remove: async (name: string, options?: { language?: string }): Promise<CanvasSkillRemoveResult> => {
      try {
        const removed = await removeSkill(name, skillsRoot())
        return { ok: true, library: await snapshotLibrary(options?.language), message: removed }
      } catch (error) {
        return { ok: false, library: await snapshotLibrary(options?.language), message: messageOf(error) }
      }
    },
    configSave: async (request: CanvasSkillConfigSaveRequest): Promise<CanvasSkillConfigSaveResult> => {
      try {
        const found = await declarationByName(request.name)
        if (found.declaration === undefined) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? 'empty'))
        await saveSkillValues(request.name, found.declaration, request.values ?? [])
        return { ok: true, library: await snapshotLibrary(request.language) }
      } catch (error) {
        return { ok: false, library: await snapshotLibrary(request.language), message: messageOf(error) }
      }
    },
    configApply: async (request: CanvasSkillConfigApplyRequest): Promise<CanvasSkillConfigApplyResult> => {
      const library = async (): Promise<CanvasSkillLibrary> => await snapshotLibrary(request.language)
      try {
        const found = await declarationByName(request.name)
        if (found.declaration === undefined) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? 'empty'))
        const values = skillValues(request.name, found.declaration)
        const runRoot = configRunRoot(request.name)
        await mkdir(runRoot, { recursive: true })
        const skillDir = bundleDirOf((await readLocalSkill(skillsRoot(), request.name).catch(() => undefined))?.path)
        const results = await applySkillConfigSteps(found.declaration, values, {
          runRoot,
          ...skillDir === undefined ? {} : { skillDir },
        })
        return {
          ok: results.every(result => result.ok),
          library: await library(),
          steps: results.map(result => ({
            kind: result.step.kind,
            detail: result.detail,
            ok: result.ok,
            ...result.output === undefined ? {} : { output: result.output },
          })),
        }
      } catch (error) {
        return { ok: false, library: await library(), steps: [], message: messageOf(error) }
      }
    },
  }

  // Attach the host skill registry and agent runtime when this deployment has
  // them. Both are optional seams: the plugin must keep working (light tier
  // included) on a host that never mounted them.
  ctx.inject(['skills', 'agents'], sctx => {
    const services = sctx as unknown as CanvasSkillServices
    const unregister = sctx.effect(() => {
      // The canvas catalog unions the host registry with the local library: on
      // the Web surface the registry alone is scope-blind here (see the adapter).
      const registry = createSkillRegistryBackend(services.skills, { root: skillsRoot })
      // The library panel prefers these paths over its own disk guess.
      void registry.list().then(
        listed => { skillRegistryNames = listed.map(item => ({ name: item.name, ...item.path === undefined ? {} : { path: item.path } })) },
        () => { skillRegistryNames = [] },
      )
      // A heavy run needs the preset roster and a model route. Both are optional
      // host services (a minimal host may mount neither), so they are read once
      // here and handed to the composition, which reports a missing model rather
      // than starting a tool-less agent that dies on its first step.
      const presets = sctx.get('agentPresets') as unknown as CanvasAgentPresets | undefined
      const defaultModel = sctx.get('agentDefaultModel') as unknown as CanvasDefaultModel | undefined
      const agents: SkillAgentBackend = {
        available: () => services.agents !== undefined,
        create: async options => await createCanvasSkillAgent({
          agents: services.agents,
          ...presets === undefined ? {} : { presets },
          ...defaultModel === undefined ? {} : { defaultModel },
          agentPreset: resolveSkills().agentPreset,
          sessionId: options.sessionId,
          cwd: options.cwd,
          systemPrompt: options.systemPrompt,
          ...options.signal === undefined ? {} : { signal: options.signal },
          fail: options.fail,
        }),
      }
      skillRunner?.attach({
        registry,
        agents,
        // Skill configuration: the catalog shows which required fields still
        // have no value, and a run carries the exposable values it declared.
        skillConfig: {
          missing: async names => {
            const out = new Map<string, string[]>()
            for (const name of names) {
              const found = await declarationByName(name)
              if (found.declaration === undefined) continue
              const missing = missingFields(found.declaration, skillValues(name, found.declaration))
              if (missing.length > 0) out.set(name, missing)
            }
            return out
          },
          note: async name => {
            const found = await declarationByName(name)
            if (found.declaration === undefined) return undefined
            return configNote(found.declaration, skillValues(name, found.declaration))
          },
        },
      })
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
    // Skill configuration values are written through the same namespace the
    // settings card edits; the panel never crafts settings ops itself.
    mutateSettings = async ops => { await seam.mutate(IMAGEGEN_SETTINGS_NAMESPACE, ops) }
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

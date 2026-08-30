/**
 * The /api/dsh-imagegen route family: a loopback-only settings bridge for the
 * plugin's own namespace (describe/mutate, mirroring the dsh-web-ui family
 * bridge wire) and the generate proxy that forwards to the configured
 * OpenAI-compatible endpoint with the API key held host-side.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SettingsConflictError, settingsNamespace, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type { UpstreamConfig } from './engine.ts'
import { enhancePrompt, listImageModels, listPromptModels, type PromptModelConfig } from './prompt-enhancer.ts'
import { normalizeImageModels } from './image-models.ts'
import { ImageGenerationRuntime, type ChannelsView } from './generation-runtime.ts'
import { appendHistory, clearHistory, listHistory, readHistoryImage, removeHistory } from './history-store.ts'
import { appendGallery, clearGallery, listGallery, readGalleryImage, removeGallery, updateGalleryTags } from './gallery-store.ts'
import { listTemplates, readTemplateImage, refreshTemplates } from './templates-store.ts'
import { checkForUpdate, CURRENT_VERSION, installUpdate } from './updater.ts'
import { IMAGE_PRESETS } from './presets.ts'
import { AGENT_IMAGE_API, CONVERSATION_IMAGE_API, GALLERY_API, GENERATE_API, HISTORY_API, IMAGEGEN_SETTINGS_NAMESPACE, IMAGE_MODEL_API, PRESETS_API, PROMPT_ENHANCE_API, SETTINGS_API, TASK_API, TEMPLATES_API, UPDATE_API, USAGE_API, type GeneratedImage, type GenerateRequest, type HistoryEntry, type HistoryEntryInput, type ModelMapping, type PresetProviderView, type TemplateListResult, type TemplateRefreshResult } from './protocol.ts'

/** Cap on JSON request bodies (settings ops and generate payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024

/** Cap on history append bodies (base64 result images can be much larger). */
const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024

/** Settings seam face the bridge needs (the host settings provider). */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: unknown, ops: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
}

/** Route dependencies. */
export interface ImageGenRoutesDeps {
  /** The settings seam (namespace storage). */
  settings: SettingsSeam
  /** Resolve the current upstream config (legacy single-endpoint path). */
  resolve: () => UpstreamConfig
  /** Resolve the current channel view (the channel-aware path). */
  resolveChannels?: () => ChannelsView
  /** Resolve the optional chat-model configuration for prompt enhancement. */
  resolvePrompt?: () => PromptModelConfig
  /** Models explicitly selected for this image API endpoint (legacy path). */
  resolveImageModels?: () => string[]
  /** Host attachment storage used by Agent tool-result previews. */
  attachments?: {
    readImage: (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
    saveImage?: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>
  }
  /** Latest composer image staged for the direct edit_image command. */
  pendingConversationImages?: {
    set: (sessionId: string, ref: ImageAttachmentRef) => void
  }
  /** Overrideable history backend, primarily for host integration tests. */
  history?: {
    list: () => Promise<HistoryEntry[]>
    append: (entry: HistoryEntryInput) => Promise<HistoryEntry[]>
    remove: (id: string) => Promise<HistoryEntry[]>
    clear: () => Promise<HistoryEntry[]>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
  /** Overrideable gallery backend, primarily for host integration tests. */
  gallery?: {
    list: () => Promise<HistoryEntry[]>
    append: (entry: HistoryEntryInput) => Promise<{ entries: HistoryEntry[]; added: boolean }>
    remove: (id: string) => Promise<HistoryEntry[]>
    clear: () => Promise<HistoryEntry[]>
    updateTags?: (id: string, tags: string[]) => Promise<HistoryEntry[]>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
  /** Overrideable template-library backend, primarily for host integration tests. */
  templates?: {
    list: () => Promise<TemplateListResult>
    refresh: () => Promise<TemplateRefreshResult>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
  /** Shared host queue, used by Agent tools and browser task endpoints. */
  runtime?: ImageGenerationRuntime
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseGenerateRequest(body: Record<string, unknown>): GenerateRequest | undefined {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return undefined
  const comparisonModels = Array.isArray(body.comparisonModels)
    ? [...new Set(body.comparisonModels.filter((model): model is string => typeof model === 'string').map(model => model.trim()).filter(Boolean))]
    : []
  return {
    mode: body.mode === 'edit' ? 'edit' : 'text',
    model: typeof body.model === 'string' ? body.model : '',
    prompt,
    size: typeof body.size === 'string' ? body.size : 'auto',
    quality: typeof body.quality === 'string' ? body.quality : 'auto',
    n: typeof body.n === 'number' ? body.n : 1,
    detail: typeof body.detail === 'string' ? body.detail : '',
    ...typeof body.image === 'string' && body.image !== '' ? { image: body.image } : {},
    ...typeof body.refName === 'string' && body.refName !== '' ? { refName: body.refName } : {},
    ...typeof body.channelId === 'string' && body.channelId !== '' ? { channelId: body.channelId } : {},
    ...typeof body.comparisonId === 'string' && body.comparisonId !== '' ? { comparisonId: body.comparisonId } : {},
    ...comparisonModels.length > 1 ? { comparisonModels } : {},
    ...body.workflow === 'ecommerce' ? { workflow: 'ecommerce' as const } : {},
    ...typeof body.projectId === 'string' && body.projectId !== '' ? { projectId: body.projectId } : {},
    ...typeof body.projectName === 'string' && body.projectName !== '' ? { projectName: body.projectName } : {},
    ...typeof body.slotKey === 'string' && body.slotKey !== '' ? { slotKey: body.slotKey } : {},
    ...typeof body.slotLabel === 'string' && body.slotLabel !== '' ? { slotLabel: body.slotLabel } : {},
  }
}

/** Validate a submitted history entry (images carry base64). */
function parseHistoryEntryInput(body: Record<string, unknown>): HistoryEntryInput | undefined {
  const raw = body.entry
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.createdAt !== 'number') return undefined
  if (entry.mode !== 'text' && entry.mode !== 'edit') return undefined
  if (typeof entry.model !== 'string' || typeof entry.prompt !== 'string') return undefined
  if (typeof entry.size !== 'string' || typeof entry.quality !== 'string' || typeof entry.detail !== 'string') return undefined
  if (typeof entry.n !== 'number') return undefined
  if (!Array.isArray(entry.images)) return undefined
  const images: GeneratedImage[] = []
  for (const item of entry.images) {
    if (item === null || typeof item !== 'object') return undefined
    const image = item as Record<string, unknown>
    if (typeof image.b64 !== 'string' || typeof image.mime !== 'string') return undefined
    images.push({
      b64: image.b64,
      mime: image.mime,
      ...typeof image.revisedPrompt === 'string' ? { revisedPrompt: image.revisedPrompt } : {},
    })
  }
  const comparisonModels = Array.isArray(entry.comparisonModels)
    ? [...new Set(entry.comparisonModels.filter((model): model is string => typeof model === 'string').map(model => model.trim()).filter(Boolean))]
    : []
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    size: entry.size,
    quality: entry.quality,
    detail: entry.detail,
    n: entry.n,
    images,
    ...typeof entry.refName === 'string' ? { refName: entry.refName } : {},
    ...typeof entry.channelId === 'string' ? { channelId: entry.channelId } : {},
    ...typeof entry.channel === 'string' ? { channel: entry.channel } : {},
    ...typeof entry.comparisonId === 'string' ? { comparisonId: entry.comparisonId } : {},
    ...comparisonModels.length > 1 ? { comparisonModels } : {},
    ...entry.workflow === 'ecommerce' ? { workflow: 'ecommerce' as const } : {},
    ...typeof entry.projectId === 'string' ? { projectId: entry.projectId } : {},
    ...typeof entry.projectName === 'string' ? { projectName: entry.projectName } : {},
    ...typeof entry.slotKey === 'string' ? { slotKey: entry.slotKey } : {},
    ...typeof entry.slotLabel === 'string' ? { slotLabel: entry.slotLabel } : {},
  }
}

/** Extract the image file name from a history-image request URL. */
function imageFileFrom(rawUrl: string | undefined, basePath: string): string | undefined {
  if (rawUrl === undefined) return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${basePath}/`)) return undefined
  return decodeURIComponent(pathname.slice(basePath.length + 1))
}

/** Parse the durable image reference carried by an Agent tool-result view. */
function agentImageRefFrom(rawUrl: string | undefined): ImageAttachmentRef | undefined {
  if (rawUrl === undefined) return undefined
  let url: URL
  try {
    url = new URL(rawUrl, 'http://localhost')
  } catch {
    return undefined
  }
  if (url.pathname !== AGENT_IMAGE_API) return undefined
  const attachmentId = url.searchParams.get('attachment_id') ?? ''
  const mediaType = url.searchParams.get('media_type') ?? ''
  const bytes = Number(url.searchParams.get('bytes'))
  const width = Number(url.searchParams.get('width'))
  const height = Number(url.searchParams.get('height'))
  if (attachmentId === '' || !isImageMediaType(mediaType)
    || !Number.isSafeInteger(bytes) || bytes < 1
    || !Number.isSafeInteger(width) || width < 1
    || !Number.isSafeInteger(height) || height < 1) return undefined
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes,
    width,
    height,
  }
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function imageDataUrl(value: string): { mediaType: ImageMediaType; data: Uint8Array } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const data = Buffer.from(match[2], 'base64')
  return data.byteLength === 0 ? undefined : { mediaType: match[1] as ImageMediaType, data }
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor: SettingsDescriptor): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    ...descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })),
    },
    revision: descriptor.revision,
  }
}

/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'settings-rejected', message }
}

/**
 * Build every /api/dsh-imagegen route.
 * @param deps - settings seam + config resolver.
 * @returns the route registrations.
 */
export function makeRoutes(deps: ImageGenRoutesDeps): WebRoute[] {
  const history = deps.history ?? {
    list: listHistory,
    append: appendHistory,
    remove: removeHistory,
    clear: clearHistory,
    readImage: readHistoryImage,
  }
  const gallery: NonNullable<ImageGenRoutesDeps['gallery']> = deps.gallery ?? {
    list: listGallery,
    append: appendGallery,
    remove: removeGallery,
    clear: clearGallery,
    updateTags: updateGalleryTags,
    readImage: readGalleryImage,
  }
  const templates = deps.templates ?? {
    list: listTemplates,
    refresh: refreshTemplates,
    readImage: readTemplateImage,
  }
  const resolvePrompt = deps.resolvePrompt ?? (() => ({ apiUrl: '', apiKey: '', model: '' }))
  const resolveImageModels = deps.resolveImageModels ?? (() => normalizeImageModels(undefined))

  /** The current channel view: the channel-aware resolver, or a synthesized
   *  single default channel from the legacy flat upstream config (tests and
   *  older hosts). */
  const channelViewOf = (): ChannelsView => {
    if (deps.resolveChannels !== undefined) return deps.resolveChannels()
    const upstream = deps.resolve()
    const models: ModelMapping[] = normalizeImageModels(resolveImageModels()).map(id => ({ alias: id, id }))
    if (upstream.apiUrl.trim() === '' && models.length === 0) return { channels: [], defaultChannelId: '' }
    return {
      channels: [{ id: 'default', preset: '', name: '默认渠道', apiUrl: upstream.apiUrl, apiKey: upstream.apiKey, models }],
      defaultChannelId: 'default',
    }
  }
  const runtime = deps.runtime ?? new ImageGenerationRuntime(channelViewOf, history)

  /** Resolve an alias (or the channel fallback) into a concrete generation
   *  request: picks the channel (explicit then default), maps alias → upstream
   *  id, and fills the channel snapshot kept on history entries. */
  const resolveChannelRequest = (request: GenerateRequest): { ok: true; request: GenerateRequest } | { ok: false; code: string; message: string } => {
    const view = channelViewOf()
    if (view.channels.length === 0) {
      return { ok: false, code: 'no-channels', message: '尚未配置任何渠道：请先在「设置 → 插件 → AI 生图」添加渠道并填写 API 地址与密钥' }
    }
    const explicit = view.channels.find(candidate => candidate.id === request.channelId)
    const defaults = view.channels.find(candidate => candidate.id === view.defaultChannelId) ?? view.channels[0]
    const target = explicit ?? defaults
    const asked = request.model.trim()
    if (asked === '') {
      const alias = target?.models[0]?.alias ?? ''
      if (alias === '') {
        return { ok: false, code: 'no-models', message: `渠道「${target?.name ?? ''}」尚未配置模型，请先在设置中添加` }
      }
      const mapping = target!.models.find(model => model.alias === alias)!
      return { ok: true, request: { ...request, model: alias, upstream: mapping.id, channelId: target!.id, channel: target!.name } }
    }
    const hosting = view.channels.filter(channel => channel.models.some(model => model.alias === asked))
    if (hosting.length === 0) {
      const available = [...new Set(view.channels.flatMap(channel => channel.models.map(model => model.alias)))]
      return { ok: false, code: 'image-model-not-configured', message: `模型「${asked}」未在任一渠道配置；可用模型：${available.join('、') || '（无）'}` }
    }
    const picked = target !== undefined && target.models.some(model => model.alias === asked) ? target : hosting[0]!
    const mapping = picked.models.find(model => model.alias === asked)!
    return { ok: true, request: { ...request, model: asked, upstream: mapping.id, channelId: picked.id, channel: picked.name } }
  }
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  return [
    // ---------------------------- composer image for /edit_image (exact)
    ...(deps.attachments?.saveImage === undefined || deps.pendingConversationImages === undefined ? [] : [{
      kind: 'exact' as const,
      path: CONVERSATION_IMAGE_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        const dataUrl = typeof body?.dataUrl === 'string' ? imageDataUrl(body.dataUrl) : undefined
        if (sessionId === '' || dataUrl === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'sessionId and image data are required' })
          return
        }
        try {
          const ref = await deps.attachments!.saveImage!({
            data: dataUrl.data,
            mediaType: dataUrl.mediaType,
            ...typeof body?.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {},
          })
          deps.pendingConversationImages!.set(sessionId, ref)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'image-save-failed', message: messageOf(error) })
        }
      },
    } satisfies WebRoute]),
    // ------------------------------------ Agent tool-result image (prefix)
    ...(deps.attachments === undefined ? [] : [{
      kind: 'prefix' as const,
      path: AGENT_IMAGE_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const ref = agentImageRefFrom(req.url)
        if (ref === undefined) {
          writeJson(res, 400, { error: 'invalid image reference' })
          return
        }
        try {
          const stored = await deps.attachments!.readImage(ref)
          res.writeHead(200, {
            'content-type': stored.ref.mediaType,
            'content-length': stored.data.byteLength,
            'cache-control': 'private, max-age=3600',
          })
          res.end(Buffer.from(stored.data))
        } catch {
          // Do not expose attachment-store details through the browser route.
          writeJson(res, 404, { error: 'image attachment not found' })
        }
      },
    } satisfies WebRoute]),
    // -------------------------------------------- image model discovery
    // Accepts optional temporary per-channel credentials so the settings card
    // can probe the endpoint the user is *typing* without saving first:
    //   { channelId?, apiUrl?, apiKey? } — the channel's stored values are the
    //   fallback, and the body's apiUrl/apiKey override them for this call.
    {
      kind: 'exact',
      path: IMAGE_MODEL_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const view = channelViewOf()
        const stored = view.channels.find(candidate => candidate.id === (typeof body?.channelId === 'string' ? body.channelId : undefined))
          ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
          ?? view.channels[0]
        const upstream: UpstreamConfig = {
          apiUrl: typeof body?.apiUrl === 'string' && body.apiUrl.trim() !== '' ? body.apiUrl.trim() : (stored?.apiUrl ?? ''),
          apiKey: typeof body?.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : (stored?.apiKey ?? ''),
        }
        try {
          writeJson(res, 200, { ok: true, models: await listImageModels(upstream) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'image-models-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------------- presets
    {
      kind: 'exact',
      path: PRESETS_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const presets: PresetProviderView[] = IMAGE_PRESETS.map(preset => ({
          id: preset.id,
          name: preset.name,
          apiUrl: preset.apiUrl,
          hint: preset.hint,
          models: preset.models,
        }))
        writeJson(res, 200, { ok: true, presets })
      },
    },
    // ----------------------------------------------------------- usage
    {
      kind: 'exact',
      path: USAGE_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const entries = [...await history.list(), ...await gallery.list()]
          // byChannel[channelId | 'name:<name>' | ''] → { alias: count }.
          const byChannel: Record<string, Record<string, number>> = {}
          const totals: Record<string, number> = {}
          for (const entry of entries) {
            const channelKey = entry.channelId !== undefined ? entry.channelId : (entry.channel !== undefined ? `name:${entry.channel}` : '')
            const alias = entry.model
            const bucket = byChannel[channelKey] ?? (byChannel[channelKey] = {})
            bucket[alias] = (bucket[alias] ?? 0) + 1
            totals[alias] = (totals[alias] ?? 0) + 1
          }
          writeJson(res, 200, { ok: true, usage: { byChannel, totals } })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'usage-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------- prompt enhancement
    {
      kind: 'exact',
      path: PROMPT_ENHANCE_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, models: await listPromptModels(resolvePrompt()) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'prompt-models-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: PROMPT_ENHANCE_API.enhance,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, prompt: await enhancePrompt(resolvePrompt(), prompt) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'prompt-enhance-failed', message: messageOf(error) })
        }
      },
    },
    // -------------------------------------------------- settings describe
    {
      kind: 'exact',
      path: SETTINGS_API.describe,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === IMAGEGEN_SETTINGS_NAMESPACE)
        writeJson(res, 200, {
          ok: true,
          value: {
            namespaces: descriptor === undefined ? [] : [toView(descriptor)],
            writable: deps.settings.writable !== false,
          },
        })
      },
    },
    // ----------------------------------------------------- settings mutate
    {
      kind: 'exact',
      path: SETTINGS_API.mutate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const ns = typeof body.ns === 'string' ? body.ns : ''
        if (ns !== IMAGEGEN_SETTINGS_NAMESPACE || !Array.isArray(body.ops)) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
          return
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
        try {
          await deps.settings.mutate(settingsNamespace(ns), body.ops, expectedRevision)
        } catch (error) {
          writeJson(res, 200, failureOf(error))
          return
        }
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === ns)
        if (descriptor === undefined) {
          writeJson(res, 200, { ok: false, code: 'internal', message: `settings namespace "${ns}" was disposed after the mutate` })
          return
        }
        writeJson(res, 200, { ok: true, value: toView(descriptor) })
      },
    },
    // ----------------------------------------------------------- generate
    {
      kind: 'exact',
      path: GENERATE_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseGenerateRequest(body)
        if (parsed === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        const resolved = resolveChannelRequest(parsed)
        if (!resolved.ok) {
          writeJson(res, 200, { ok: false, code: resolved.code, message: resolved.message })
          return
        }
        try {
          writeJson(res, 200, { ok: true, ...await runtime.run(resolved.request) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'generate-failed'
          writeJson(res, 200, { ok: false, code, message })
        }
      },
    },
    // ------------------------------------------------ generation task queue
    {
      kind: 'exact', path: TASK_API.submit,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = body === undefined ? undefined : parseGenerateRequest(body)
        if (parsed === undefined) { writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' }); return }
        const resolved = resolveChannelRequest(parsed)
        if (!resolved.ok) {
          writeJson(res, 200, { ok: false, code: resolved.code, message: resolved.message })
          return
        }
        writeJson(res, 200, { ok: true, task: runtime.queue.submit(resolved.request) })
      },
    },
    {
      kind: 'exact', path: TASK_API.list,
      handler: async (req, res) => { if (!guard(req, res, 'POST')) return; writeJson(res, 200, { ok: true, tasks: runtime.queue.list() }) },
    },
    {
      kind: 'exact', path: TASK_API.cancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? runtime.queue.cancel(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact', path: TASK_API.retry,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const task = typeof body?.id === 'string' ? runtime.queue.retry(body.id) : undefined
        if (task === undefined) { writeJson(res, 200, { ok: false, code: 'not-found', message: 'task not found' }); return }
        writeJson(res, 200, { ok: true, task })
      },
    },
    // ----------------------------------------------- update check
    {
      kind: 'exact',
      path: UPDATE_API.check,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, update: await checkForUpdate() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'update-check-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------- update apply
    {
      kind: 'exact',
      path: UPDATE_API.apply,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const version = body !== undefined && typeof body.version === 'string' ? body.version.trim() : ''
        if (version === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'update version is required' })
          return
        }
        try {
          const latest = await checkForUpdate()
          if (!latest.updateAvailable || latest.latestVersion !== version) {
            writeJson(res, 200, { ok: false, code: 'update-not-available', message: `version ${version} is not the latest available release` })
            return
          }
          await installUpdate(version)
          writeJson(res, 200, { ok: true, currentVersion: CURRENT_VERSION, updatedVersion: version, restartRequired: true })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'update-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------------- history list
    {
      kind: 'exact',
      path: HISTORY_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.list() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- history append
    {
      kind: 'exact',
      path: HISTORY_API.append,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const entry = parseHistoryEntryInput(body)
        if (entry === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'malformed history entry' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.append(entry) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- history remove
    {
      kind: 'exact',
      path: HISTORY_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'history id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.remove(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ---------------------------------------------------- history clear
    {
      kind: 'exact',
      path: HISTORY_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.clear() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------ history image (prefix)
    {
      kind: 'prefix',
      path: HISTORY_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, HISTORY_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await history.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(found.data)
      },
    },
    // ----------------------------------------------------- gallery list
    {
      kind: 'exact',
      path: GALLERY_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await gallery.list() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- gallery append
    {
      kind: 'exact',
      path: GALLERY_API.append,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const entry = parseHistoryEntryInput(body)
        if (entry === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'malformed gallery entry' })
          return
        }
        try {
          // The host owns gallery ids: a fresh id per append keeps retries and
          // duplicate submissions from ever reusing a stale filename prefix.
          const result = await gallery.append({ ...entry, id: randomUUID() })
          writeJson(res, 200, { ok: true, entries: result.entries, added: result.added })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- gallery remove
    {
      kind: 'exact',
      path: GALLERY_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'gallery id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await gallery.remove(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ----------------------------------------------------- gallery tags
    {
      kind: 'exact',
      path: GALLERY_API.tags,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const tags = Array.isArray(body?.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
        if (id === '' || tags === undefined || gallery.updateTags === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'gallery id and tags are required' })
          return
        }
        try { writeJson(res, 200, { ok: true, entries: await gallery.updateTags(id, tags) }) } catch (error) { writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) }) }
      },
    },
    // ---------------------------------------------------- gallery clear
    {
      kind: 'exact',
      path: GALLERY_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await gallery.clear() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'gallery-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------ gallery image (prefix)
    {
      kind: 'prefix',
      path: GALLERY_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, GALLERY_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await gallery.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(found.data)
      },
    },
    // --------------------------------------------------- templates list
    {
      kind: 'exact',
      path: TEMPLATES_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const result = await templates.list()
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'templates-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------- templates refresh
    {
      kind: 'exact',
      path: TEMPLATES_API.refresh,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const result = await templates.refresh()
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'templates-refresh-failed', message: messageOf(error) })
        }
      },
    },
    // -------------------------------------- templates image (prefix, proxied)
    {
      kind: 'prefix',
      path: TEMPLATES_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, TEMPLATES_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await templates.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          // Cached on disk by the host; reference images are immutable per name.
          'cache-control': 'private, max-age=86400',
        })
        res.end(found.data)
      },
    },
  ]
}

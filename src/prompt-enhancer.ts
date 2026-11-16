/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */

import { isLikelyImageModelId } from './model-catalog.ts'
import { isChatCompletionsUrl, resolveChannelProtocol, type ChannelProtocolPreference } from './protocol.ts'

export interface PromptModelConfig {
  apiUrl: string
  apiKey: string
  model: string
}

/** Why a channel cannot back a chat request (absent when it can). */
export type PromptChannelIssue = 'missing' | 'subscription' | 'full-url'

/** Where the chat request's credential came from. */
export type PromptKeySource = 'draft' | 'custom' | 'channel' | 'none'

/** The endpoint a chat call would use, plus where it came from. */
export interface PromptEndpoint extends PromptModelConfig {
  /** `custom` = the prompt fields, `channel` = a reused image channel, `none` = unconfigured. */
  origin: 'custom' | 'channel' | 'none'
  /** Reused channel, when origin is `channel`. */
  channelId?: string
  /** Reused channel's display name, when origin is `channel`. */
  channelName?: string
  /** Why the requested channel could not be used (absent when it could). */
  issue?: PromptChannelIssue
  /**
   * Which layer supplied the key. `none` means the request goes out without
   * an Authorization header — never silently filled with another host's key.
   */
  keySource?: PromptKeySource
}

/**
 * Unsaved draft a settings card sends with a detection request, so "fetch
 * models" reflects what the user is looking at instead of the last save.
 * The host honors it for loopback callers only.
 */
export interface PromptEndpointOverride {
  /** Channel id the card currently has selected ('' = automatic). */
  channelId?: string
  /** Custom endpoint URL typed into the card (takes precedence over channelId). */
  apiUrl?: string
  /** Custom endpoint key typed into the card ('' falls back to the stored key). */
  apiKey?: string
}

/**
 * A configuration problem the UI can explain, as opposed to an upstream
 * failure. Routes turn `code` into localized copy instead of echoing an
 * English host string into a Chinese settings page.
 */
export class PromptConfigError extends Error {
  readonly code: 'prompt-url-missing' | 'prompt-channel-unsupported'

  constructor(code: 'prompt-url-missing' | 'prompt-channel-unsupported', message: string) {
    super(message)
    this.name = 'PromptConfigError'
    this.code = code
  }
}

/** Credentials shared by OpenAI-compatible `/models` discovery. */
export interface ModelListConfig {
  apiUrl: string
  apiKey: string
  apiUrlFull?: boolean
  protocol?: ChannelProtocolPreference
  /**
   * Also probe `?kind=image` (image detection only). Gateways such as magpie
   * strip capability metadata from the plain list and answer the filtered one
   * with real image models; OpenAI-compatible gateways ignore the parameter,
   * so it is an additive probe rather than a requirement.
   */
  imageKindFilter?: boolean
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

function headers(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    ...apiKey.trim() === '' ? {} : { authorization: `Bearer ${apiKey.trim()}` },
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body === null || typeof body !== 'object') {
    const message = body !== null && typeof body === 'object' && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as Record<string, unknown>
}

type ModelRecord = Record<string, unknown> & { id: string }

/** Candidate /models URLs for a configured base URL, most specific first. */
function modelListUrls(config: ModelListConfig): string[] {
  const base = config.apiUrl.trim().replace(/\/+$/, '')
  if (base === '') throw new PromptConfigError('prompt-url-missing', 'API URL is required')
  const urls: string[] = []
  if (resolveChannelProtocol(base, config.protocol) === 'chat-completions' && isChatCompletionsUrl(base)) {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/chat\/completions\/?$/, '')}/models`
    url.search = ''
    url.hash = ''
    return kindFilteredUrls([url.toString()], config)
  }
  urls.push(endpoint(base, '/models'))
  try {
    const url = new URL(base)
    const path = url.pathname.replace(/\/+$/, '')
    // Some gateways serve their marketing site at /models and the API only
    // under /v1. Try that conventional suffix when the configured base does
    // not already end in a version segment.
    if (!/\/v\d+(?:[a-z0-9._-]*)?$/i.test(path)) {
      url.pathname = `${path === '' || path === '/' ? '' : path}/v1/models`
      url.search = ''
      url.hash = ''
      urls.push(url.toString())
    }
  } catch {
    // Non-URL bases fall back to the original string concatenation behavior.
  }
  return kindFilteredUrls(urls, config)
}

/**
 * Add `?kind=image` variants of the candidate URLs for image detection.
 *
 * Gateways that expose capabilities only through the filtered list (magpie
 * answers 25 image models there and strips the metadata from the plain list)
 * need this probe; plain OpenAI-compatible gateways ignore the unknown query
 * parameter, so the probe is additive and never replaces the plain list.
 * @param urls - plain candidate URLs, most specific first.
 * @param config - detection config carrying the image flag.
 * @returns plain URLs followed by their kind-filtered variants.
 */
function kindFilteredUrls(urls: string[], config: ModelListConfig): string[] {
  const unique = [...new Set(urls)]
  if (config.imageKindFilter !== true) return unique
  return [...new Set([
    ...unique,
    ...unique.map(url => `${url}${url.includes('?') ? '&' : '?'}kind=image`),
  ])]
}

function errorMessageOf(body: unknown, fallback: string): string {
  if (body === null || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  const error = record.error
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return typeof record.message === 'string' && record.message.trim() !== '' ? record.message : fallback
}

function modelRecordsOf(body: unknown): ModelRecord[] | undefined {
  const candidate = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : body !== null && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : body !== null && typeof body === 'object' && Array.isArray((body as { output?: { models?: unknown } }).output?.models)
          ? (body as { output: { models: unknown[] } }).output.models
          : undefined
  if (candidate === undefined) return undefined
  return candidate.flatMap(item => {
    const id = typeof item === 'string'
      ? item.trim()
      : item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id.trim()
        : item !== null && typeof item === 'object' && typeof (item as { model?: unknown }).model === 'string'
          ? (item as { model: string }).model.trim()
          : ''
    return id === '' ? [] : [{ ...(typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}), id }]
  })
}

interface ModelListAttempt {
  records?: ModelRecord[]
  error?: Error
  retryable: boolean
}

async function fetchModelRecords(url: string, apiKey: string): Promise<ModelListAttempt> {
  const response = await fetch(url, { headers: headers(apiKey) })
  const text = await response.text().catch(() => '')
  let body: unknown
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text) as unknown
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const fallback = `HTTP ${response.status}`
    return {
      error: new Error(errorMessageOf(body, fallback)),
      retryable: response.status === 404 || response.status === 405,
    }
  }
  if (body === undefined) {
    const type = response.headers.get('content-type') ?? 'unknown content-type'
    const sample = text.replace(/\s+/g, ' ').trim().slice(0, 160)
    return {
      error: new Error(`模型接口返回了非 JSON 响应（HTTP ${response.status}, ${type}）${sample === '' ? '' : `：${sample}`}`),
      retryable: true,
    }
  }
  const records = modelRecordsOf(body)
  if (records === undefined) {
    return {
      error: new Error(errorMessageOf(body, '模型接口响应中没有 data/models 列表')),
      retryable: true,
    }
  }
  return { records, retryable: false }
}

/**
 * Merge records gathered from several candidate URLs by id.
 *
 * A gateway can answer the plain list with bare ids and the filtered list with
 * full metadata, so per-id metadata is merged and a record that claims image
 * capability wins over one that does not.
 * @param records - records in arrival order.
 * @returns one record per id.
 */
function mergeModelRecords(records: ModelRecord[]): ModelRecord[] {
  const byId = new Map<string, ModelRecord>()
  for (const record of records) {
    const existing = byId.get(record.id)
    if (existing === undefined) {
      byId.set(record.id, record)
      continue
    }
    const merged = { ...existing, ...record }
    byId.set(record.id, hasImageGenerationCapability(record) === true || hasImageGenerationCapability(merged) !== false ? merged : existing)
  }
  return [...byId.values()]
}

async function listModelRecords(config: ModelListConfig): Promise<ModelRecord[]> {
  const urls = modelListUrls(config)
  let lastError: Error | undefined
  let collected: ModelRecord[] = []
  /** At least one candidate answered with a model list (possibly empty). */
  let answered = false
  for (const url of urls) {
    let attempt: ModelListAttempt
    try {
      attempt = await fetchModelRecords(url, config.apiKey)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      continue
    }
    if (attempt.records !== undefined) {
      answered = true
      collected = mergeModelRecords([...collected, ...attempt.records])
      continue
    }
    lastError = attempt.error
    // A definitive refusal (auth, bad request) will not differ per candidate
    // URL; when earlier candidates already answered, keep what they returned.
    if (!attempt.retryable) {
      if (answered) break
      throw attempt.error
    }
  }
  if (answered) return collected
  throw lastError ?? new Error('模型接口不可用')
}

function textOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function hasImageGenerationCapability(record: ModelRecord): boolean | undefined {
  // Explicit gateway metadata wins over every heuristic below: some gateways
  // (magpie) tag image models with `kind`, an endpoint capability list, or a
  // nested modalities block instead of the OpenAI capability fields.
  if (typeof record.kind === 'string' && record.kind.trim().toLowerCase() === 'image') return true
  const endpointTypes = textOf(record.supported_endpoint_types)
  if (endpointTypes.some(value => /^image-(?:generation|edit)$/i.test(value.trim()))) return true
  const nestedModalities = record.modalities
  if (nestedModalities !== null && typeof nestedModalities === 'object') {
    const output = (nestedModalities as { output?: unknown }).output
    if (textOf(output).some(value => value.trim().toLowerCase() === 'image')) return true
  }

  const capability = record.capabilities
  if (capability !== null && typeof capability === 'object') {
    const values = capability as Record<string, unknown>
    for (const key of ['image_generation', 'imageGeneration', 'text_to_image', 'textToImage', 'image_gen']) {
      if (typeof values[key] === 'boolean') return values[key]
    }
    const serialized = JSON.stringify(values).toLowerCase()
    if (/image[ _-]?generation|text[ _-]?to[ _-]?image/.test(serialized)) return true
  }

  const taskText = [
    ...textOf(record.task),
    ...textOf(record.task_type),
    ...textOf(record.taskType),
    ...textOf(record.type),
    ...textOf(record.model_type),
    ...textOf(record.modelType),
    ...textOf(record.tasks),
    ...textOf(record.description),
  ].join(' ').toLowerCase()
  if (/image[ _-]?generation|text[ _-]?to[ _-]?image|image[ _-]?gen/.test(taskText)) return true
  if (/^image(?:[ _-]?generation)?$/.test(taskText.trim())) return true
  if (/embedding|rerank|moderation|transcri|speech|audio|video|chat[ _-]?completion/.test(taskText)) return false

  for (const key of ['output_modalities', 'outputModalities', 'supported_output_modalities']) {
    const modalities = textOf(record[key]).map(value => value.toLowerCase())
    if (modalities.length > 0) return modalities.includes('image')
  }
  return undefined
}

function isImageModelRecord(record: ModelRecord): boolean {
  return hasImageGenerationCapability(record) ?? isLikelyImageModelId(record.id)
}

/** List candidates exposed by an OpenAI-compatible endpoint. */
export async function listOpenAIModels(config: ModelListConfig): Promise<string[]> {
  return [...new Set((await listModelRecords(config)).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/** List only models that advertise or conventionally represent image generation. */
export async function listImageModels(config: ModelListConfig): Promise<string[]> {
  // Only the image path probes `?kind=image`: the chat model list must stay
  // exactly what the plain endpoint exposes.
  return [...new Set((await listModelRecords({ ...config, imageKindFilter: true })).filter(isImageModelRecord).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/** List chat models exposed by an OpenAI-compatible endpoint. */
export async function listPromptModels(config: PromptModelConfig): Promise<string[]> {
  return listOpenAIModels(config)
}

/** Remove reasoning-model artifacts from a chat model's visible content:
 *  complete `<think>…</think>` blocks first, then anything from a dangling
 *  unclosed `<think>` to the end of the text. Reasoning models served through
 *  OpenAI-compatible endpoints (MiniMax M3, DeepSeek R1, Qwen QVQ, …) inline
 *  these blocks in `message.content`; leaking them into the prompt box both
 *  pollutes the prompt and can push it past image models' length limits. */
export function stripReasoning(text: string): string {
  const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const dangling = /<think>/i.exec(withoutClosed)
  return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim()
}

/** One OpenAI-style multimodal user part (`text` or an `image_url` data URL). */
export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** One chat-completion request over the configured OpenAI-compatible endpoint. */
export interface ChatOptions {
  system: string
  /** Either a plain string or multimodal parts. */
  content: string | ChatPart[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Run one chat completion and return the cleaned visible answer.
 *
 * Shared by prompt enhancement, the canvas light-tier skill runner and the
 * layer analyzer: it owns the endpoint, auth, error shaping (an upstream
 * `error.message` is surfaced verbatim) and the reasoning-strip step, so every
 * caller sees the same behaviour.
 * @param config - endpoint, secret and model.
 * @param options - prompt parts plus optional sampling controls.
 * @returns the model's visible answer, with reasoning artifacts removed.
 */
export async function chatComplete(config: PromptModelConfig, options: ChatOptions): Promise<string> {
  if (config.apiUrl.trim() === '' || config.model.trim() === '') {
    throw new Error('chat model is not configured (left sidebar > Image settings > Prompt enhancement)')
  }
  const response = await fetch(endpoint(config.apiUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(config.apiKey),
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: options.temperature ?? 0.4,
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      messages: [
        { role: 'system', content: options.system },
        {
          role: 'user',
          content: typeof options.content === 'string' ? options.content : options.content,
        },
      ],
    }),
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  const body = await responseJson(response)
  const choices = Array.isArray(body.choices) ? body.choices : []
  const content = choices[0] !== null && typeof choices[0] === 'object'
    ? (choices[0] as { message?: { content?: unknown } }).message?.content
    : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error('chat model returned an empty answer')
  const answer = stripReasoning(content)
  if (answer === '') throw new Error('chat model returned only reasoning content (empty <think> payload)')
  return answer
}

/** Strip a fenced code block and pull the outermost JSON object/array out. */
export function jsonPayload(content: string): unknown {
  const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)
  const start = useArray ? arrayStart : objectStart
  const end = useArray ? arrayEnd : objectEnd
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(cleaned.slice(start, end + 1)) as unknown } catch { return undefined }
}

/** Expand a concise image request into a production-ready image prompt. */
export async function enhancePrompt(config: PromptModelConfig, prompt: string): Promise<string> {
  return chatComplete(config, {
    temperature: 0.7,
    system: 'You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.',
    content: prompt,
  })
}

/** Polish one existing generation prompt without changing its purpose. */
export async function polishPrompt(config: PromptModelConfig, prompt: string): Promise<string> {
  return chatComplete(config, {
    temperature: 0.35,
    system: '你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。',
    content: prompt,
  })
}

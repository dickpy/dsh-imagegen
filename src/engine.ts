/**
 * Upstream proxy engine: forwards a generate request to the configured
 * OpenAI-compatible image endpoint (/images/generations for text-to-image,
 * /images/edits for image-to-image) and normalizes the response to base64
 * images so the browser never fetches the upstream itself.
 *
 * Framework-free (no cordis imports) so the route layer and tests can drive
 * it directly.
 */

import type { GeneratedImage, GenerateRequest, GenerateResult } from './protocol.ts'
import { detectImageMime } from './image-format.ts'
import { modelFamily } from './model-catalog.ts'

/** The upstream credentials the panel's settings card configures. */
export interface UpstreamConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  apiUrl: string
  /** Bearer API key. */
  apiKey: string
}

/** A generation failure with a user-presentable message. */
export class ImageGenError extends Error {
  /** Stable wire code. */
  readonly code: string

  constructor(message: string, code = 'generate-failed') {
    super(message)
    this.name = 'ImageGenError'
    this.code = code
  }
}

/** Total budget for the upstream generation call (image models are slow). */
const UPSTREAM_TIMEOUT_MS = 240_000

/** Budget for downloading one result image URL. */
const IMAGE_FETCH_TIMEOUT_MS = 60_000

/** Cap on the reference image payload (edit mode), in bytes. */
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024

/** Sizes dall-e-3 accepts; anything else falls back to its square default. */
const DALLE3_SIZES = new Set(['1024x1024', '1792x1024', '1024x1792'])

/** The wire model id for a request: `upstream` (host-filled alias mapping)
 *  wins, then the alias, then the family default. */
function wireModel(request: GenerateRequest): string {
  const upstream = request.upstream?.trim()
  if (upstream !== undefined && upstream !== '') return upstream
  const alias = request.model.trim()
  return alias === '' ? 'gpt-image-2' : alias
}

/** Whether the model is an xAI Grok Imagine model (grok-imagine-image,
 *  grok-imagine-image-2.0, …). Grok Imagine speaks JSON on both endpoints
 *  and exposes its own aspect-ratio / response-format knobs instead of the
 *  OpenAI size/quality/detail passthrough. */
function isGrokImagine(model: string): boolean {
  return modelFamily(model) === 'grok'
}

/** Whether the model belongs to the Google Nano Banana family (nanobanana2 /
 *  nanobanana2-lite / nanobanana-pro, plus the official Gemini image IDs the
 *  gateways expose). OpenAI-compatible gateways serve these with their own
 *  aspect_ratio / image_size vocabulary instead of the OpenAI size/quality
 *  passthrough. */
function isNanoBanana(model: string): boolean {
  return modelFamily(model) === 'nanobanana'
}

/** Whether the model belongs to the ByteDance Seedream family (seedream-5.0-pro,
 *  seedream-5.0, seedream-4.x, doubao-seedream-…). OpenAI-compatible gateways
 *  serve Seedream through a unified generate-and-edit architecture:
 *  generation AND editing both go to /images/generations and reference images
 *  are a JSON URL / data-URL array. */
function isSeedream(model: string): boolean {
  return modelFamily(model) === 'seedream'
}

/** Whether the model uses the official Zhipu image-generation contract. */
function isZhipuImage(model: string): boolean {
  return modelFamily(model) === 'zhipu'
}

/** Whether the model is Alibaba Qwen-Image, which speaks the DashScope native
 *  multimodal-generation contract (NOT OpenAI-compatible): a chat-style
 *  messages body, `宽*高` pixel sizes, and image URLs in the reply content. */
function isQwenImage(model: string): boolean {
  return modelFamily(model) === 'qwen'
}

function isGlmImage(model: string): boolean {
  return /^glm-image(?:-|$)/i.test(model.trim())
}

/** Whether this is the official Volcengine Ark model naming convention. */
function isVolcSeedream(model: string): boolean {
  return /^doubao-seedream(?:-|$)/i.test(model.trim())
}

/** Volcengine uses `size` for the output tier, not the panel's aspect ratio. */
function seedreamSize(quality: string): string {
  // Seedream 5.0 Pro currently caps at 2K; keep 4K requests valid by
  // degrading them to the highest supported tier instead of sending 4K.
  if (quality === '1k') return '1K'
  return '2K'
}

/** The panel's aspect ratios mapped to Qwen-Image's `宽*高` pixel sizes.
 *  The classic series (qwen-image / -plus / -max) documents this fixed list;
 *  2.0 / 3.0-series models accept any size within their pixel budget and
 *  recommend the larger set. */
const QWEN_SIZE_CLASSIC: Readonly<Record<string, string>> = {
  '16:9': '1664*928',
  '21:9': '1664*928',
  '4:3': '1472*1104',
  '3:2': '1472*1104',
  '1:1': '1328*1328',
  '3:4': '1104*1472',
  '2:3': '1104*1472',
  '9:16': '928*1664',
}

const QWEN_SIZE_HD: Readonly<Record<string, string>> = {
  '16:9': '2688*1536',
  '21:9': '2688*1536',
  '4:3': '2368*1728',
  '3:2': '2368*1728',
  '1:1': '2048*2048',
  '3:4': '1728*2368',
  '2:3': '1728*2368',
  '9:16': '1536*2688',
}

/** Versioned ids (qwen-image-2.0 / -3.0-pro / …) take the large size set. */
function isVersionedQwenImage(model: string): boolean {
  return /^qwen-image-\d+\.\d/i.test(model.trim())
}

function qwenSize(model: string, ratio: string): string | undefined {
  if (ratio === '' || ratio === 'auto') return undefined
  return (isVersionedQwenImage(model) ? QWEN_SIZE_HD : QWEN_SIZE_CLASSIC)[ratio]
}

/** The panel's aspect ratios mapped to the closest OpenAI pixel size
 *  (gpt-image-2 / generic OpenAI-compatible endpoints). */
const OPENAI_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
  '9:16': '1024x1792',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '16:9': '1792x1024',
  '21:9': '1792x1024',
}

/** Panel ratios that need renaming for a model's vocabulary. Grok documents
 *  20:9 as its ultra-wide ratio, so the panel's 21:9 label is sent as 20:9. */
const GROK_ASPECT_ALIASES: Readonly<Record<string, string>> = {
  '21:9': '20:9',
}

/**
 * One request-scoped timeout that is cleared as soon as its fetch settles.
 * AbortSignal.timeout() cannot be disposed early; using it inside a long-lived
 * task queue leaves an otherwise idle Node process holding every timeout.
 */
function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = () => { controller.abort(source?.reason) }
  if (source?.aborted === true) abortFromSource()
  else source?.addEventListener('abort', abortFromSource, { once: true })
  const timeout = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, timeoutMs)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      source?.removeEventListener('abort', abortFromSource)
    },
  }
}

/** Whether an error was produced by a requestSignal budget timeout. These can
 * surface from the fetch call itself or from reading the response body, so the
 * budget must stay armed until the body has been consumed. */
function isBudgetTimeout(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'TimeoutError'
}

/** Content-type extension hints for URL-fetched images. */function mimeOfExtension(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  if (match === null) return undefined
  switch (match[1]!.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return undefined
  }
}

/** Parse `data:<mime>;base64,<payload>` into its parts; undefined when malformed. */
function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim())
  if (match === null || match[3] === undefined) return undefined
  if (match[2] === undefined) {
    // Plain (non-base64) data URLs are not supported for reference images.
    return undefined
  }
  return { mime: match[1] ?? 'application/octet-stream', base64: match[3] }
}

/** Strip a data: prefix from an upstream b64 payload if a gateway added one. */
function bareBase64(value: string): string {
  const parsed = parseDataUrl(value)
  return parsed !== undefined && parsed.base64 !== undefined ? parsed.base64 : value
}

/** Whether a result URL carries cloud-storage signing credentials. */
function isPresignedUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const params = new Set(Array.from(url.searchParams.keys(), key => key.toLowerCase()))
  if (params.has('x-goog-signature') || params.has('x-goog-credential')) return true
  if (params.has('x-amz-signature') || params.has('x-amz-credential')) return true
  return params.has('signature') && (
    params.has('expires') || params.has('googleaccessid') || params.has('awsaccesskeyid')
  )
}

/** Clamp the requested image count into the API-accepted range. */
function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.round(n)))
}

/** Pick the effective per-model request parameters. Never includes `n`: the
 *  batch parameter is rejected by Responses-API-based gateways (tools[0].n),
 *  so the count is satisfied by parallel single-image requests instead. */
function effectiveParams(request: GenerateRequest): {
  model: string
  size?: string
  quality?: string
  detail?: string
  aspect_ratio?: string
  image_size?: string
  resolution?: string
  response_format?: string
} {
  const model = wireModel(request)
  // dall-e-3 has no quality/detail knobs and only produces one image.
  if (model === 'dall-e-3') {
    const pixel = OPENAI_SIZE_BY_RATIO[request.size]
    const size = (pixel !== undefined && DALLE3_SIZES.has(pixel)) ? pixel : '1024x1024'
    return { model, size }
  }
  // Grok Imagine: the panel's aspect ratios are sent as-is (21:9 aliased to
  // the documented 20:9), the clarity tiers become the resolution parameter
  // (the API documents 1k / 2k only, so 4k falls back to 2k), and base64
  // output keeps the temporary signed result URLs from expiring before the
  // host downloads them.
  if (isGrokImagine(model)) {
    return {
      model,
      ...request.size !== '' && request.size !== 'auto'
        ? { aspect_ratio: GROK_ASPECT_ALIASES[request.size] ?? request.size }
        : {},
      ...request.quality !== '' && request.quality !== 'auto'
        ? { resolution: request.quality === '4k' ? '2k' : request.quality }
        : {},
      response_format: 'b64_json',
    }
  }
  // Google Nano Banana: the panel's aspect ratios are sent as-is (the family
  // documents 1:1 … 21:9 natively), the clarity tiers become image_size
  // (1K / 2K / 4K — Gen 1 and 2-Lite are 1K-only upstream, but which gateway
  // rejects higher tiers is its own call), and base64 output keeps any signed
  // result URLs from expiring before the host downloads them.
  if (isNanoBanana(model)) {
    return {
      model,
      ...request.size !== '' && request.size !== 'auto'
        ? { aspect_ratio: request.size }
        : {},
      ...request.quality !== '' && request.quality !== 'auto'
        ? { image_size: request.quality.toUpperCase() }
        : {},
      response_format: 'b64_json',
    }
  }
  // ByteDance Seedream: the official Volcengine Ark API uses `size` for the
  // resolution tier (1K / 2K), not the panel's aspect-ratio value. It returns
  // temporary URLs, so ask Ark for URL output and let the host download it.
  // Other compatible gateways retain the base64 response fallback.
  if (isSeedream(model)) {
    return {
      model,
      size: seedreamSize(request.quality),
      response_format: isVolcSeedream(model) ? 'url' : 'b64_json',
    }
  }
  // Zhipu's official image API accepts OpenAI-style JSON but uses its own
  // quality vocabulary. GLM-Image currently supports hd only; CogView uses
  // the standard tier. Size remains a valid custom pixel size for both.
  if (isZhipuImage(model)) {
    return {
      model,
      ...request.size !== '' && request.size !== 'auto' && OPENAI_SIZE_BY_RATIO[request.size] !== undefined
        ? { size: OPENAI_SIZE_BY_RATIO[request.size] }
        : {},
      quality: isGlmImage(model) ? 'hd' : 'standard',
    }
  }
  // OpenAI-compatible endpoints: nearest pixel size, clarity tiers mapped to
  // the quality levels (1k→low / 2k→medium / 4k→high), detail passthrough.
  return {
    model,
    ...request.size !== '' && request.size !== 'auto' && OPENAI_SIZE_BY_RATIO[request.size] !== undefined
      ? { size: OPENAI_SIZE_BY_RATIO[request.size] }
      : {},
    ...request.quality === '1k' ? { quality: 'low' } : {},
    ...request.quality === '2k' ? { quality: 'medium' } : {},
    ...request.quality === '4k' ? { quality: 'high' } : {},
    ...request.detail !== '' ? { detail: request.detail } : {},
  }
}

/** How many single-image requests to issue for the requested image count. */
function effectiveCount(request: GenerateRequest): number {
  const model = wireModel(request)
  if (model === 'dall-e-3') return 1
  return clampCount(request.n)
}

/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(
  item: Record<string, unknown>,
  upstream: UpstreamConfig,
  signal?: AbortSignal,
): Promise<{ b64: string; mime: string; revisedPrompt?: string }> {
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
  if (typeof item.b64_json === 'string' && item.b64_json.trim() !== '') {
    const b64 = bareBase64(item.b64_json)
    if (b64.trim() !== '') {
      return { b64, mime: detectImageMime(Buffer.from(b64, 'base64')) ?? 'image/png', revisedPrompt }
    }
  }
  if (typeof item.url !== 'string' || item.url === '') {
    throw new ImageGenError('upstream image item has neither b64_json nor url')
  }
  const url = item.url
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new ImageGenError('upstream returned a malformed data: url')
    return { b64: parsed.base64, mime: detectImageMime(Buffer.from(parsed.base64, 'base64')) ?? parsed.mime, revisedPrompt }
  }
  const budget = requestSignal(signal, IMAGE_FETCH_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        ...isPresignedUrl(url) || upstream.apiKey === ''
          ? {}
          : { headers: { authorization: `Bearer ${upstream.apiKey}` } },
        signal: budget.signal,
      })
    } catch (error) {
      throw new ImageGenError(`failed to fetch the generated image url: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      throw new ImageGenError(`failed to fetch the generated image url: HTTP ${response.status}`)
    }
    // Budget stays armed through the body read so a stalled download cannot hang the task.
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type')
    const mime = detectImageMime(buffer)
      ?? (contentType !== null && contentType !== ''
      ? contentType.split(';')[0]!.trim()
      : mimeOfExtension(url) ?? 'image/png')
    return { b64: buffer.toString('base64'), mime, revisedPrompt }
  } finally {
    budget.dispose()
  }
}

/** Expand a provider image item whose URL may be a string or an array. */
function imageItemsOf(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return []
  const item = value as Record<string, unknown>
  if (Array.isArray(item.url)) {
    return item.url.filter((url): url is string => typeof url === 'string' && url !== '').map(url => ({ ...item, url }))
  }
  return [item]
}

/** Return the data records from the response shapes shared by sync gateways. */
function dataRecordsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const data = Array.isArray(payload.data)
    ? payload.data
    : payload.data !== null && typeof payload.data === 'object'
      ? [payload.data]
      : Array.isArray(payload.images)
        ? payload.images
        : Array.isArray(payload.output)
          ? payload.output
          : undefined
  if (data === undefined) return undefined
  return data.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
}

const ASYNC_PENDING_STATUSES = new Set(['submitted', 'pending', 'processing', 'running', 'in_progress', 'queued'])
const ASYNC_COMPLETED_STATUSES = new Set(['completed', 'succeeded', 'success', 'done'])
const ASYNC_FAILED_STATUSES = new Set(['failed', 'failure', 'cancelled', 'canceled', 'error'])
const ASYNC_POLL_MAX_MS = 240_000
const ASYNC_POLL_REQUEST_TIMEOUT_MS = 30_000

/** Read a provider error message from the common nested locations. */
function asyncErrorMessage(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const candidates: unknown[] = [record.message, record.error]
    const data = record.data
    const entries = Array.isArray(data) ? data : [data]
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      candidates.push(item.message, item.error)
      const nested = item.error
      if (nested !== null && typeof nested === 'object') candidates.push((nested as Record<string, unknown>).message)
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
      if (candidate !== null && typeof candidate === 'object') {
        const message = (candidate as Record<string, unknown>).message
        if (typeof message === 'string' && message.trim() !== '') return message
      }
    }
  }
  return fallback
}

/** Wait between async-provider polls, but wake immediately when cancelled. */
function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const done = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll one apib/apimart-style provider task until it yields image records.
 * The total deadline is shared by every poll and the final image downloads;
 * local task cancellation propagates through every request and sleep.
 */
async function pollAsyncTask(
  baseUrl: string,
  upstream: UpstreamConfig,
  taskId: string,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + ASYNC_POLL_MAX_MS
  let delay = 1000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const budget = requestSignal(signal, Math.min(ASYNC_POLL_REQUEST_TIMEOUT_MS, remaining))
    try {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${upstream.apiKey.trim()}` },
          signal: budget.signal,
        })
      } catch (error) {
        if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
        if (isBudgetTimeout(error)) throw new ImageGenError('上游异步任务轮询超时', 'upstream-timeout')
        throw new ImageGenError(`无法轮询上游异步任务：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        if (isBudgetTimeout(error)) throw new ImageGenError('上游异步任务轮询超时', 'upstream-timeout')
        throw new ImageGenError(`上游任务接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
      }
      if (!response.ok || payload === null || typeof payload !== 'object') {
        throw new ImageGenError(asyncErrorMessage(payload, `上游任务轮询失败（HTTP ${response.status}）`), 'upstream-rejected')
      }
      const record = payload as Record<string, unknown>
      const data = record.data
      const statusRecord = Array.isArray(data) ? data[0] : data !== null && typeof data === 'object' ? data : record
      const statusValue = statusRecord !== null && typeof statusRecord === 'object'
        ? (statusRecord as Record<string, unknown>).status
        : undefined
      const status = typeof statusValue === 'string' ? statusValue.toLowerCase() : ''
      if (ASYNC_FAILED_STATUSES.has(status)) {
        throw new ImageGenError(asyncErrorMessage(payload, `上游异步任务失败（${status || 'unknown'}）`), 'upstream-rejected')
      }
      const nested = statusRecord !== null && typeof statusRecord === 'object' ? statusRecord as Record<string, unknown> : record
      const result = nested.result ?? (nested.output !== null && typeof nested.output === 'object' ? (nested.output as Record<string, unknown>).result : undefined) ?? record.result
      const resultRecord = result !== null && typeof result === 'object' ? result as Record<string, unknown> : undefined
      const images = resultRecord?.images ?? (nested.images ?? record.images)
      if (ASYNC_COMPLETED_STATUSES.has(status) || images !== undefined) {
        const items = Array.isArray(images) ? images.flatMap(imageItemsOf) : imageItemsOf(images)
        if (items.length > 0) return items
        if (ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError('上游异步任务完成但没有图片结果', 'upstream-empty')
      }
      if (status !== '' && !ASYNC_PENDING_STATUSES.has(status) && !ASYNC_COMPLETED_STATUSES.has(status)) {
        throw new ImageGenError(`上游返回了未知异步任务状态：${status}`, 'upstream-invalid')
      }
    } finally {
      budget.dispose()
    }
    await waitForPoll(Math.min(delay, Math.max(1, deadline - Date.now())), signal)
    delay = Math.min(5000, delay * 2)
  }
  throw new ImageGenError('上游异步任务轮询超时（240 秒）', 'upstream-timeout')
}

/**
 * Issue one single-image request (never sends `n`). The response is kept as a
 * list so a gateway that happens to return several images per call still works.
 */
async function requestOneImage(
  baseUrl: string,
  upstream: UpstreamConfig,
  request: GenerateRequest,
  params: ReturnType<typeof effectiveParams>,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstream.apiKey.trim()}`,
  }
  let body: BodyInit
  if (request.mode === 'edit') {
    if (typeof request.image !== 'string' || request.image === '') {
      throw new ImageGenError('图生图需要上传参考图片', 'edit-image-missing')
    }
    const parsed = parseDataUrl(request.image)
    if (parsed === undefined) throw new ImageGenError('参考图片格式无效', 'edit-image-invalid')
    let bytes: Buffer
    try {
      bytes = Buffer.from(parsed.base64, 'base64')
    } catch {
      throw new ImageGenError('参考图片数据无法解码', 'edit-image-invalid')
    }
    if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) {
      throw new ImageGenError('参考图片超过 10MB 上限', 'edit-image-too-large')
    }
    // Grok Imagine /images/edits takes a JSON image_url object (a base64 data
    // URI is accepted) instead of OpenAI's multipart form-data upload.
    if (isGrokImagine(params.model)) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify({
        model: params.model,
        prompt: request.prompt,
        image: { url: request.image, type: 'image_url' },
        ...params.aspect_ratio !== undefined ? { aspect_ratio: params.aspect_ratio } : {},
        response_format: 'b64_json',
      })
    } else if (isNanoBanana(params.model)) {
      // Nano Banana OpenAI-compatible gateways accept the standard multipart
      // edit upload, with the family's own aspect_ratio / image_size knobs.
      const form = new FormData()
      form.append('image', new Blob([bytes], { type: parsed.mime }), `reference.${extensionOf(parsed.mime)}`)
      form.append('prompt', request.prompt)
      form.append('model', params.model)
      if (params.aspect_ratio !== undefined) form.append('aspect_ratio', params.aspect_ratio)
      if (params.image_size !== undefined) form.append('image_size', params.image_size)
      body = form
    } else if (isSeedream(params.model)) {
      // Seedream unifies generation and editing on /images/generations; the
      // reference image is a JSON URL / data-URL array, never multipart.
      headers['content-type'] = 'application/json'
      body = JSON.stringify({
        model: params.model,
        prompt: request.prompt,
        image: [request.image],
        ...params.size !== undefined ? { size: params.size } : {},
        ...params.resolution !== undefined ? { resolution: params.resolution } : {},
        response_format: isVolcSeedream(params.model) ? 'url' : 'b64_json',
      })
    } else {
      const form = new FormData()
      form.append('image', new Blob([bytes], { type: parsed.mime }), `reference.${extensionOf(parsed.mime)}`)
      form.append('prompt', request.prompt)
      form.append('model', params.model)
      if (params.size !== undefined) form.append('size', params.size)
      if (params.quality !== undefined) form.append('quality', params.quality)
      if (params.detail !== undefined) form.append('detail', params.detail)
      body = form
    }
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify({ prompt: request.prompt, ...params } as Record<string, unknown>)
  }

  const budget = requestSignal(signal, UPSTREAM_TIMEOUT_MS)
  try {
    let response: Response
    try {
      // Seedream has no /images/edits endpoint: both modes hit generations.
      const endpoint = request.mode === 'edit' && !isSeedream(params.model)
        ? '/images/edits'
        : '/images/generations'
      response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body,
        signal: budget.signal,
      })
    } catch (error) {
      if (isBudgetTimeout(error)) throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
      if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
      throw new ImageGenError(`无法连接上游接口：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
    }

    let payload: unknown
    try {
      // The budget stays armed through the body read: a gateway that returns
      // headers but never completes the body must not hang the task forever.
      payload = await response.json()
    } catch (error) {
      if (isBudgetTimeout(error)) throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
      if (signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
      throw new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
    }

    const record = payload as Record<string, unknown>
    const data = dataRecordsOf(record)
    if (data === undefined) {
      throw new ImageGenError('上游响应缺少 data 数组', 'upstream-invalid')
    }
    if (data.length === 0) {
      throw new ImageGenError('上游返回了 0 张图片', 'upstream-empty')
    }
    const asyncEntries = data.filter(entry => typeof entry.task_id === 'string' && entry.task_id.trim() !== '')
    if (asyncEntries.length > 0) {
      const asyncRecords = (await Promise.all(asyncEntries.map(entry => pollAsyncTask(baseUrl, upstream, entry.task_id as string, signal)))).flat()
      if (asyncRecords.length === 0) throw new ImageGenError('上游异步任务完成但没有图片结果', 'upstream-empty')
      return Promise.all(asyncRecords.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
    }
    return Promise.all(data.flatMap(imageItemsOf).map(item => normalizeItem(item, upstream, signal)))
  } finally {
    budget.dispose()
  }
}

/**
 * Qwen-Image (DashScope native multimodal-generation): one chat-style request
 * carries the prompt (plus the reference image for edit mode) and answers
 * synchronously with image URLs in the reply content. The versioned series
 * batches natively (n ≤ 6; the panel caps at 4), the classic series is
 * single-image per call.
 */
async function generateQwenImage(
  baseUrl: string,
  upstream: UpstreamConfig,
  request: GenerateRequest,
  options: { signal?: AbortSignal },
): Promise<GenerateResult> {
  const model = wireModel(request)
  const content: Array<Record<string, unknown>> = []
  if (request.mode === 'edit') {
    if (typeof request.image !== 'string' || request.image === '') {
      throw new ImageGenError('图生图需要上传参考图片', 'edit-image-missing')
    }
    // DashScope multimodal messages take the reference image as a content
    // item; a base64 data URI rides in the same field as a remote URL.
    const parsed = parseDataUrl(request.image)
    if (parsed === undefined) throw new ImageGenError('参考图片格式无效', 'edit-image-invalid')
    const bytes = Buffer.from(parsed.base64, 'base64')
    if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) {
      throw new ImageGenError('参考图片超过 10MB 上限', 'edit-image-too-large')
    }
    content.push({ image: request.image })
  }
  content.push({ text: request.prompt })

  const batchable = isVersionedQwenImage(model)
  const count = batchable ? clampCount(request.n) : 1
  const size = qwenSize(model, request.size)
  const body = {
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      ...size !== undefined ? { size } : {},
      ...count > 1 ? { n: count } : {},
    },
  }

  const budget = requestSignal(options.signal, UPSTREAM_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstream.apiKey.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: budget.signal,
      })
    } catch (error) {
      if (isBudgetTimeout(error)) throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
      if (options.signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
      throw new ImageGenError(`无法连接上游接口：${error instanceof Error ? error.message : String(error)}`, 'upstream-unreachable')
    }

    let payload: unknown
    try {
      // Budget stays armed through the body read (same rationale as the OpenAI path).
      payload = await response.json()
    } catch (error) {
      if (isBudgetTimeout(error)) throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
      if (options.signal?.aborted === true) throw new ImageGenError('任务已取消', 'cancelled')
      throw new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
    }
    if (!response.ok || payload === null || typeof payload !== 'object') {
      throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
    }

  // output.choices[].message.content[] mixes text and { image: url } items.
  const record = payload as Record<string, unknown>
  const output = record.output as Record<string, unknown> | undefined
  const choices = output !== undefined && Array.isArray(output.choices) ? output.choices : []
  const urls: string[] = []
  for (const choice of choices) {
    const message = choice !== null && typeof choice === 'object'
      ? (choice as Record<string, unknown>).message
      : undefined
    const items = message !== null && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content)
      ? (message as Record<string, unknown>).content as unknown[]
      : []
    for (const item of items) {
      if (item !== null && typeof item === 'object') {
        const image = (item as Record<string, unknown>).image
        if (typeof image === 'string' && image !== '') urls.push(image)
      }
    }
  }
  if (urls.length === 0) {
    throw new ImageGenError('上游响应缺少图片内容', 'upstream-empty')
  }
  const images = await Promise.all(urls.map(async url => {
    const normalized = await normalizeItem({ url }, upstream)
    return { b64: normalized.b64, mime: normalized.mime }
  }))
  return { images }
  } finally {
    budget.dispose()
  }
}

/**
 * Forward one generate request to the configured endpoint. The requested image
 * count is satisfied with N parallel single-image requests (the `n` batch
 * parameter is never sent, because Responses-API-based gateways reject it as
 * `tools[0].n`), then the results are flattened in order.
 */
export async function generateImage(upstream: UpstreamConfig, request: GenerateRequest, options: { signal?: AbortSignal } = {}): Promise<GenerateResult> {
  const baseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  if (baseUrl === '') throw new ImageGenError('api_url 未配置：请先在「设置 → 插件 → 可配置」中填写', 'config-missing')
  if (upstream.apiKey.trim() === '') throw new ImageGenError('api_key 未配置：请先在「设置 → 插件 → 可配置」中填写', 'config-missing')
  if (isQwenImage(wireModel(request))) return generateQwenImage(baseUrl, upstream, request, options)
  if (request.mode === 'edit' && isZhipuImage(wireModel(request))) {
    throw new ImageGenError('智谱 GLM-Image 当前仅支持文生图，请切换到文生图模式或选择支持图生图的模型', 'edit-unsupported')
  }
  const params = effectiveParams(request)
  const count = effectiveCount(request)
  const batches = await Promise.all(
    Array.from({ length: count }, () => requestOneImage(baseUrl, upstream, request, params, options.signal)),
  )
  return { images: batches.flat() }
}

/** Human-readable failure message from an upstream error payload. */
function upstreamMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message !== '') return message
    }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.error === 'string' && record.error !== '') return record.error
  }
  return `上游接口拒绝请求（HTTP ${status}）`
}

/** File extension for a MIME type (multipart reference image). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/png':
    default: return 'png'
  }
}

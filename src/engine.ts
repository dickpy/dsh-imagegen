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

/** Whether the model is an xAI Grok Imagine model (grok-imagine-image,
 *  grok-imagine-image-2.0, …). Grok Imagine speaks JSON on both endpoints
 *  and exposes its own aspect-ratio / response-format knobs instead of the
 *  OpenAI size/quality/detail passthrough. */
function isGrokImagine(model: string): boolean {
  return /^grok-imagine(?:-|$)/.test(model)
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

/** Content-type extension hints for URL-fetched images. */
function mimeOfExtension(path: string): string | undefined {
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
  resolution?: string
  response_format?: string
} {
  const model = request.model.trim() === '' ? 'gpt-image-2' : request.model.trim()
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
  const model = request.model.trim() === '' ? 'gpt-image-2' : request.model.trim()
  if (model === 'dall-e-3') return 1
  return clampCount(request.n)
}

/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(
  item: Record<string, unknown>,
  upstream: UpstreamConfig,
): Promise<{ b64: string; mime: string; revisedPrompt?: string }> {
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
  if (typeof item.b64_json === 'string') {
    return { b64: bareBase64(item.b64_json), mime: 'image/png', revisedPrompt }
  }
  if (typeof item.url !== 'string' || item.url === '') {
    throw new ImageGenError('upstream image item has neither b64_json nor url')
  }
  const url = item.url
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new ImageGenError('upstream returned a malformed data: url')
    return { b64: parsed.base64, mime: parsed.mime, revisedPrompt }
  }
  const budget = requestSignal(undefined, IMAGE_FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        ...upstream.apiKey === '' ? {} : { authorization: `Bearer ${upstream.apiKey}` },
      },
      signal: budget.signal,
    })
  } catch (error) {
    throw new ImageGenError(`failed to fetch the generated image url: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    budget.dispose()
  }
  if (!response.ok) {
    throw new ImageGenError(`failed to fetch the generated image url: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')
  const mime = contentType !== null && contentType !== ''
    ? contentType.split(';')[0]!.trim()
    : mimeOfExtension(url) ?? 'image/png'
  return { b64: buffer.toString('base64'), mime, revisedPrompt }
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
  let response: Response
  try {
    response = await fetch(`${baseUrl}/images/${request.mode === 'edit' ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers,
      body,
      signal: budget.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/aborter/i.test(message) || /timeout/i.test(message)) {
      throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
    }
    throw new ImageGenError(`无法连接上游接口：${message}`, 'upstream-unreachable')
  } finally {
    budget.dispose()
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
  }
  if (!response.ok || payload === null || typeof payload !== 'object') {
    throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
  }

  const record = payload as Record<string, unknown>
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
      ? record.images
      : Array.isArray(record.output)
        ? record.output
        : undefined
  if (data === undefined) {
    throw new ImageGenError('上游响应缺少 data 数组', 'upstream-invalid')
  }
  if (data.length === 0) {
    throw new ImageGenError('上游返回了 0 张图片', 'upstream-empty')
  }
  return Promise.all(data.map(async (entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new ImageGenError('上游响应包含无效的图片条目', 'upstream-invalid')
    }
    return normalizeItem(entry as Record<string, unknown>, upstream)
  }))
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

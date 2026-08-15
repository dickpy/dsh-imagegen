/**
 * The /api/dsh-imagegen route family: a loopback-only settings bridge for the
 * plugin's own namespace (describe/mutate, mirroring the dsh-web-ui family
 * bridge wire) and the generate proxy that forwards to the configured
 * OpenAI-compatible endpoint with the API key held host-side.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, settingsNamespace, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { generateImage, type UpstreamConfig } from './engine.ts'
import { appendHistory, clearHistory, listHistory, readHistoryImage, removeHistory } from './history-store.ts'
import { GENERATE_API, HISTORY_API, IMAGEGEN_SETTINGS_NAMESPACE, SETTINGS_API, type GeneratedImage, type GenerateRequest, type HistoryEntryInput } from './protocol.ts'

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
  /** Resolve the current upstream config (composition entry + settings). */
  resolve: () => UpstreamConfig
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
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        if (prompt.length > 2000) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt exceeds 2000 characters' })
          return
        }
        const request: GenerateRequest = {
          mode: body.mode === 'edit' ? 'edit' : 'text',
          model: typeof body.model === 'string' ? body.model : 'gpt-image-2',
          prompt,
          size: typeof body.size === 'string' ? body.size : 'auto',
          quality: typeof body.quality === 'string' ? body.quality : 'auto',
          n: typeof body.n === 'number' ? body.n : 1,
          detail: typeof body.detail === 'string' ? body.detail : '',
          ...typeof body.image === 'string' && body.image !== '' ? { image: body.image } : {},
        }
        try {
          const result = await generateImage(deps.resolve(), request)
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'generate-failed'
          writeJson(res, 200, { ok: false, code, message })
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
          writeJson(res, 200, { ok: true, entries: await listHistory() })
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
          writeJson(res, 200, { ok: true, entries: await appendHistory(entry) })
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
          writeJson(res, 200, { ok: true, entries: await removeHistory(id) })
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
          writeJson(res, 200, { ok: true, entries: await clearHistory() })
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
        const found = await readHistoryImage(file)
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
  ]
}

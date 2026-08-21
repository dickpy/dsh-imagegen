/**
 * Browser-side API client for the /api/dsh-imagegen route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */

import { GALLERY_API, GENERATE_API, HISTORY_API, TEMPLATES_API, UPDATE_API, type GenerateRequest, type GenerateResult, type HistoryEntry, type HistoryEntryInput, type TemplateListResult, type TemplateRefreshResult, type UpdateInfo } from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class ImageGenApiError extends Error {
  /** Stable wire code from the host. */
  readonly code: string

  constructor(message: string, code = 'generate-failed') {
    super(message)
    this.name = 'ImageGenApiError'
    this.code = code
  }
}

/** Parse the { ok, ... } envelope or throw an ImageGenApiError. */
async function readEnvelope<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ImageGenApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (body === null || typeof body !== 'object') {
    throw new ImageGenApiError(`HTTP ${response.status}: malformed response`)
  }
  const record = body as { ok?: unknown; message?: unknown; code?: unknown }
  if (record.ok !== true) {
    throw new ImageGenApiError(
      typeof record.message === 'string' ? record.message : `HTTP ${response.status}`,
      typeof record.code === 'string' ? record.code : 'generate-failed',
    )
  }
  return body as T
}

/** The browser half's data entry point. */
export class ImageGenApi {
  /** Ask the host to check the latest stable GitHub Release. */
  async updateCheck(): Promise<UpdateInfo> {
    const response = await fetch(UPDATE_API.check, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; update: UpdateInfo }>(response)
    return body.update
  }

  /** Ask the host to install a previously discovered Release. */
  async updateApply(version: string): Promise<{ updatedVersion: string; restartRequired: boolean }> {
    const response = await fetch(UPDATE_API.apply, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    })
    const body = await readEnvelope<{ ok: true; updatedVersion: string; restartRequired: boolean }>(response)
    return { updatedVersion: body.updatedVersion, restartRequired: body.restartRequired }
  }

  /** Forward one generate request to the host proxy. */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await fetch(GENERATE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = await readEnvelope<{ ok: true; images: GenerateResult['images']; history?: HistoryEntry[]; historyError?: string }>(response)
    return {
      images: body.images,
      ...body.history === undefined ? {} : { history: body.history },
      ...body.historyError === undefined ? {} : { historyError: body.historyError },
    }
  }

  /** List the host-persisted history (newest first). */
  async historyList(): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.list, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Remove one history entry by id. */
  async historyRemove(id: string): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Clear the entire history. */
  async historyClear(): Promise<HistoryEntry[]> {
    const response = await fetch(HISTORY_API.clear, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** List the host-persisted gallery (newest first). */
  async galleryList(): Promise<HistoryEntry[]> {
    const response = await fetch(GALLERY_API.list, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Append one image to the gallery. The host assigns the id and skips the
   *  append when a content-identical image is already in the gallery. */
  async galleryAppend(entry: HistoryEntryInput): Promise<{ entries: HistoryEntry[]; added: boolean }> {
    const response = await fetch(GALLERY_API.append, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[]; added: boolean }>(response)
    return { entries: body.entries, added: body.added }
  }

  /** Remove one gallery entry by id. */
  async galleryRemove(id: string): Promise<HistoryEntry[]> {
    const response = await fetch(GALLERY_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Clear the entire gallery. */
  async galleryClear(): Promise<HistoryEntry[]> {
    const response = await fetch(GALLERY_API.clear, { method: 'POST' })
    const body = await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)
    return body.entries
  }

  /** Fetch the prompt-template library (bundled snapshot or refreshed copy). */
  async templatesList(): Promise<TemplateListResult> {
    const response = await fetch(TEMPLATES_API.list, { method: 'POST' })
    const body = await readEnvelope<TemplateListResult & { ok: true }>(response)
    return {
      cases: body.cases,
      total: body.total,
      origin: body.origin,
      repository: body.repository,
      fetchedAt: body.fetchedAt,
    }
  }

  /** Re-download the template library from the upstream mirror (host-side). */
  async templatesRefresh(): Promise<TemplateRefreshResult> {
    const response = await fetch(TEMPLATES_API.refresh, { method: 'POST' })
    const body = await readEnvelope<TemplateRefreshResult & { ok: true }>(response)
    return { total: body.total, fetchedAt: body.fetchedAt }
  }
}

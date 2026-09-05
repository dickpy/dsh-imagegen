/**
 * Browser-side API client for the /api/dsh-imagegen route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */

import { CANVAS_API, CONVERSATION_IMAGE_API, DATA_FOLDER_API, GALLERY_API, GENERATE_API, HISTORY_API, PROMPT_ENHANCE_API, STORAGE_API, TASK_API, TEMPLATE_FAVORITES_API, TEMPLATES_API, UPDATE_API, type CanvasAssetRef, type CanvasDocument, type CanvasSummary, type GenerateRequest, type GenerateResult, type GenerationTask, type HistoryEntry, type HistoryEntryInput, type TemplateCase, type TemplateFavorite, type TemplateListResult, type TemplateRefreshResult, type TemplateSample, type UpdateInfo } from '../protocol.ts'

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

  /** Ask the configured chat model to expand a concise image prompt. */
  async enhancePrompt(prompt: string): Promise<string> {
    const response = await fetch(PROMPT_ENHANCE_API.enhance, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const body = await readEnvelope<{ ok: true; prompt: string }>(response)
    return body.prompt
  }

  /** Stage a generated image as a durable reference for `/edit_image`. */
  async attachConversationImage(sessionId: string, dataUrl: string, name: string): Promise<void> {
    const response = await fetch(CONVERSATION_IMAGE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, dataUrl, name }),
    })
    await readEnvelope<{ ok: true }>(response)
  }

  async taskSubmit(request: GenerateRequest): Promise<GenerationTask> {
    const response = await fetch(TASK_API.submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  async taskList(): Promise<GenerationTask[]> {
    const response = await fetch(TASK_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; tasks: GenerationTask[] }>(response)).tasks
  }

  async taskCancel(id: string): Promise<GenerationTask> {
    const response = await fetch(TASK_API.cancel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
  }

  async taskRetry(id: string): Promise<GenerationTask> {
    const response = await fetch(TASK_API.retry, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; task: GenerationTask }>(response)).task
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

  async gallerySetTags(id: string, tags: string[]): Promise<HistoryEntry[]> {
    const response = await fetch(GALLERY_API.tags, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, tags }) })
    return (await readEnvelope<{ ok: true; entries: HistoryEntry[] }>(response)).entries
  }

  async canvasList(): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasCreate(title?: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.create, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRead(id: string): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.read, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasSave(document: CanvasDocument, expectedRevision: number): Promise<CanvasDocument> {
    const response = await fetch(CANVAS_API.save, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document, expectedRevision }) })
    return (await readEnvelope<{ ok: true; document: CanvasDocument }>(response)).document
  }

  async canvasRemove(id: string): Promise<CanvasSummary[]> {
    const response = await fetch(CANVAS_API.remove, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    return (await readEnvelope<{ ok: true; projects: CanvasSummary[] }>(response)).projects
  }

  async canvasUpload(dataUrl: string, width: number, height: number, meta: { origin?: string; originId?: string; entryId?: string; imageIndex?: number } = {}): Promise<CanvasAssetRef> {
    const response = await fetch(CANVAS_API.assetUpload, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, width, height, ...meta }) })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  async canvasImport(source: 'history' | 'gallery', entryId: string, imageIndex: number, width: number, height: number): Promise<CanvasAssetRef> {
    const response = await fetch(CANVAS_API.assetImport, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, entryId, imageIndex, width, height }) })
    return (await readEnvelope<{ ok: true; asset: CanvasAssetRef }>(response)).asset
  }

  /** Fetch one template source's list (bundled snapshot or refreshed copy). */
  async templatesList(sourceId: string): Promise<TemplateListResult> {
    const response = await fetch(TEMPLATES_API.list, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceId }) })
    const body = await readEnvelope<TemplateListResult & { ok: true }>(response)
    return {
      sourceId: body.sourceId,
      cases: body.cases,
      total: body.total,
      origin: body.origin,
      repository: body.repository,
      fetchedAt: body.fetchedAt,
    }
  }

  /** Re-download one template source's list from its upstream mirror (host-side). */
  async templatesRefresh(sourceId: string): Promise<TemplateRefreshResult> {
    const response = await fetch(TEMPLATES_API.refresh, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceId }) })
    const body = await readEnvelope<TemplateRefreshResult & { ok: true }>(response)
    return { sourceId: body.sourceId, total: body.total, fetchedAt: body.fetchedAt }
  }

  /** Draw random cases across every source (studio inspiration wall). */
  async templatesSample(count: number): Promise<TemplateSample[]> {
    const response = await fetch(TEMPLATES_API.sample, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }) })
    return (await readEnvelope<{ ok: true; samples: TemplateSample[] }>(response)).samples
  }

  /** List the host-persisted template favorites. */
  async favoritesList(): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.list, { method: 'POST' })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }

  /** Reveal the host data directory (saved images) in the OS file manager. */
  async openDataFolder(): Promise<{ ok: boolean; path?: string; message?: string }> {
    const response = await fetch(DATA_FOLDER_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    return await readEnvelope<{ ok: true; path: string }>(response)
  }

  /** Probe the configured S3-compatible object storage with a small upload. */
  async storageTest(): Promise<{ ok: boolean; ms?: number; key?: string; message?: string }> {
    const response = await fetch(STORAGE_API.test, { method: 'POST' })
    return await readEnvelope<{ ok: true; ms: number; key: string }>(response)
  }

  /** Star one template (the host keeps a full case snapshot). */
  async favoritesAdd(sourceId: string, item: TemplateCase): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.add, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sourceId, case: item }),
    })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }

  /** Unstar one template by its favorites key. */
  async favoritesRemove(key: string): Promise<TemplateFavorite[]> {
    const response = await fetch(TEMPLATE_FAVORITES_API.remove, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    return (await readEnvelope<{ ok: true; favorites: TemplateFavorite[] }>(response)).favorites
  }
}

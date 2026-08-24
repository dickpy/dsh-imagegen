/**
 * Wire contract shared by the host and client halves of dsh-imagegen: the
 * settings namespace, the route paths, and the generate payload/result shapes.
 * Pure types + constants 鈥?safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const IMAGEGEN_SETTINGS_NAMESPACE = 'dsh-imagegen'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '1.2.2'

/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
export const SETTINGS_API = {
  describe: '/api/dsh-imagegen/settings/describe',
  mutate: '/api/dsh-imagegen/settings/mutate',
} as const

/** The image-generation proxy route. */
export const GENERATE_API = '/api/dsh-imagegen/generate'

/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
export const PROMPT_ENHANCE_API = {
  models: '/api/dsh-imagegen/prompt-enhance/models',
  enhance: '/api/dsh-imagegen/prompt-enhance',
} as const

/** Host-mediated candidate discovery for the configured image API. */
export const IMAGE_MODEL_API = {
  models: '/api/dsh-imagegen/image-models',
} as const

/** Host-resident generation queue endpoints. */
export const TASK_API = {
  submit: '/api/dsh-imagegen/tasks/submit',
  list: '/api/dsh-imagegen/tasks/list',
  cancel: '/api/dsh-imagegen/tasks/cancel',
  retry: '/api/dsh-imagegen/tasks/retry',
} as const

/** Host-mediated GitHub Release update routes. */
export const UPDATE_API = {
  check: '/api/dsh-imagegen/update/check',
  apply: '/api/dsh-imagegen/update/apply',
} as const

/**
 * Same-origin route family for the host-persisted generation history. Images
 * live as files under ~/.dsh/dsh-imagegen/images/ and are served back through
 * the `image` prefix route, so list responses carry metadata only (never
 * base64) and the browser loads thumbnails/previews lazily.
 */
export const HISTORY_API = {
  list: '/api/dsh-imagegen/history/list',
  append: '/api/dsh-imagegen/history/append',
  remove: '/api/dsh-imagegen/history/remove',
  clear: '/api/dsh-imagegen/history/clear',
  image: '/api/dsh-imagegen/history/image',
} as const

/**
 * Same-origin route family for the user-curated gallery (favorites). Entries
 * reuse the history wire shape and persist under ~/.dsh/dsh-imagegen/gallery/;
 * unlike history there is no size cap 鈥?the user adds images on purpose.
 */
export const GALLERY_API = {
  list: '/api/dsh-imagegen/gallery/list',
  append: '/api/dsh-imagegen/gallery/append',
  remove: '/api/dsh-imagegen/gallery/remove',
  clear: '/api/dsh-imagegen/gallery/clear',
  tags: '/api/dsh-imagegen/gallery/tags',
  image: '/api/dsh-imagegen/gallery/image',
} as const

/** Maximum number of history entries retained host-side (oldest evicted). */
export const HISTORY_MAX = 50

/**
 * Same-origin route family for the bundled prompt-template library
 * (awesome-gpt-image-2 mirror). The case list ships inside the package and is
 * served by the host; reference images are proxied through the `image` prefix
 * route and cached on disk so repeated views never hit the network again.
 */
export const TEMPLATES_API = {
  list: '/api/dsh-imagegen/templates/list',
  refresh: '/api/dsh-imagegen/templates/refresh',
  image: '/api/dsh-imagegen/templates/image',
} as const

/** One prompt-library case as the browser consumes it. */
export interface TemplateCase {
  /** Upstream case number (stable across refreshes). */
  id: number
  /** Short case title. */
  title: string
  /** Full reusable prompt text. */
  prompt: string
  /** English category name (grouping key). */
  category: string
  /** Chinese category display name. */
  categoryZh: string
  /** Style tags. */
  styles: string[]
  /** Scene tags. */
  scenes: string[]
  /** Original author handle, e.g. @vista8. */
  sourceLabel: string
  /** Original author link. */
  sourceUrl: string
  /** awesome-gpt-image-2 repo anchor link. */
  githubUrl: string
  /** Reference-image file name served through the image route ('' when none). */
  image: string
  /** Whether the source gallery featured the case. */
  featured: boolean
}

/** Template-library list payload. */
export interface TemplateListResult {
  cases: TemplateCase[]
  total: number
  /** Where the served list came from. */
  origin: 'bundled' | 'refreshed'
  /** Upstream repository the library mirrors. */
  repository: string
  /** ISO time of the last successful refresh / bundle snapshot. */
  fetchedAt: string
}

/** Template-library refresh outcome. */
export interface TemplateRefreshResult {
  total: number
  fetchedAt: string
}

/** Generation modes. */
export type GenerateMode = 'text' | 'edit'

/** A client 鈫?host generate request (what the panel collects). */
export interface GenerateRequest {
  /** text-to-image (images/generations) or image-to-image (images/edits). */
  mode: GenerateMode
  /** Upstream model name, e.g. gpt-image-2. */
  model: string
  /** The prompt. Upstream providers may impose their own length limits. */
  prompt: string
  /** Canvas size as an aspect ratio: 'auto' or e.g. '1:1' / '16:9' / '21:9'.
   *  The host maps it onto each model's own vocabulary (aspect_ratio for Grok,
   *  the closest pixel size for OpenAI-compatible endpoints). */
  size: string
  /** Clarity tier: 'auto' | '1k' | '2k' | '4k'. The host maps it onto the
   *  model's own vocabulary (resolution for Grok, quality for OpenAI). */
  quality: string
  /** Number of images, 1-4. */
  n: number
  /**
   * Passthrough detail parameter: '' (omit), 'standard', or 'high'. Some
   * gpt-image-2 gateways expose it; official OpenAI endpoints reject unknown
   * parameters, so the UI defaults to '' (omit).
   */
  detail: string
  /** Reference image as a data URL (edit mode only). */
  image?: string
  /** Original reference-image name, retained in the history entry. */
  refName?: string
}

/** One generated image, normalized host-side to base64 so the browser never
 *  has to fetch the upstream (no CORS, no key exposure). */
export interface GeneratedImage {
  /** Raw base64 payload (no data: prefix). */
  b64: string
  /** MIME type of the payload, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful generate outcome. */
export interface GenerateResult {
  images: GeneratedImage[]
  /** Updated host-persisted history, when returned by the generate route. */
  history?: HistoryEntry[]
  /** Persistence failure after images were successfully generated. */
  historyError?: string
}

export type GenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface GenerationTask {
  id: string
  request: GenerateRequest
  status: GenerationTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: GenerateResult
  error?: string
}

/** GitHub Release update information shown by the client. */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
}

/** One history image reference as the browser consumes it (a served URL). */
export interface HistoryImageRef {
  /** Same-origin URL: `${HISTORY_API.image}/<file>`. */
  url: string
  /** MIME type, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** A saved generation as the browser consumes it (metadata + served images). */
export interface HistoryEntry {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: HistoryImageRef[]
  /** Reference-image filename (edit mode), kept for display only. */
  refName?: string
  /** User-managed gallery labels (unused by history entries). */
  tags?: string[]
}

/** A history entry the client submits for persistence (images still carry base64). */
export interface HistoryEntryInput {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: GeneratedImage[]
  refName?: string
}

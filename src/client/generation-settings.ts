/**
 * The studio's last-used generation settings (#68).
 *
 * These live in browser storage instead of the host settings document: they are
 * per-device UI state (which model, size, quality, count and detail the operator
 * picked last), not shared configuration, and they must survive a reload
 * without touching ~/.dsh. Reopening the studio therefore no longer means
 * re-picking everything before the first run.
 *
 * The module is deliberately pure — no `window`, no React — so the persistence
 * contract can be unit-tested; the panel hands in its own localStorage (or null
 * when the embedded shell blocks storage).
 */

/** Aspect-ratio vocabulary, in display order (auto = let the model decide). */
export const GENERATION_SIZES = ['auto', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9'] as const

/** Output-resolution tiers (auto = let the model decide). */
export const GENERATION_QUALITIES = ['auto', '1k', '2k', '4k'] as const

/** Detail passthrough levels ('' = omit the field). */
export const GENERATION_DETAILS = ['', 'standard', 'high'] as const

/** Images one run may request. */
export const GENERATION_COUNT_MIN = 1
export const GENERATION_COUNT_MAX = 4

/** Comparison selections are `${channelId}\0${model}` so duplicate aliases stay distinct. */
export const COMPARE_KEY_SEPARATOR = '\u0000'

/** Browser-storage key; versioned by name only, the payload is validated on read. */
export const GENERATION_SETTINGS_STORAGE_KEY = 'dsh-imagegen:generation-settings'

/** Legacy pixel sizes saved by older versions, mapped onto the current
 *  aspect-ratio vocabulary so restoring old records still works. */
const LEGACY_SIZE_TO_RATIO: Record<string, string> = {
  '512x512': '1:1',
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
}

/** Legacy quality levels saved by older versions, mapped onto resolution. */
const LEGACY_QUALITY_TO_RES: Record<string, string> = {
  low: '1k',
  medium: '2k',
  high: '4k',
}

/** The persisted selection; every field is optional in storage. */
export interface GenerationSettings {
  size: string
  quality: string
  count: number
  detail: string
  /** Model alias chosen last ('' = never chosen, use the configured default). */
  model: string
  /** Channel owning `model`; '' is the legacy single-channel fallback. */
  channelId: string
  compareEnabled: boolean
  compareModels: string[]
}

/** The selection a first-time visitor starts from. */
export function defaultGenerationSettings(): GenerationSettings {
  return {
    size: 'auto',
    quality: 'auto',
    count: GENERATION_COUNT_MIN,
    detail: '',
    model: '',
    channelId: '',
    compareEnabled: false,
    compareModels: [],
  }
}

/** Normalize a saved size value into a current option. */
export function normalizeSize(value: string): string {
  if ((GENERATION_SIZES as readonly string[]).includes(value)) return value
  return LEGACY_SIZE_TO_RATIO[value] ?? 'auto'
}

/** Normalize a saved quality value into a current option. */
export function normalizeQuality(value: string): string {
  if ((GENERATION_QUALITIES as readonly string[]).includes(value)) return value
  return LEGACY_QUALITY_TO_RES[value] ?? 'auto'
}

/** Normalize a saved detail value into a current option. */
export function normalizeDetail(value: string): string {
  return (GENERATION_DETAILS as readonly string[]).includes(value) ? value : ''
}

/** Normalize a saved image count into the supported range. */
export function normalizeCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return GENERATION_COUNT_MIN
  return Math.min(GENERATION_COUNT_MAX, Math.max(GENERATION_COUNT_MIN, Math.round(numeric)))
}

/** Build one comparison key from a channel + model pair. */
export function compareKey(channelId: string, model: string): string {
  return `${channelId}${COMPARE_KEY_SEPARATOR}${model}`
}

/** Decode a comparison key, rejecting malformed persisted state. */
export function compareChoice(key: string): { channelId: string, model: string } | undefined {
  const separator = key.indexOf(COMPARE_KEY_SEPARATOR)
  if (separator < 0) return undefined
  const model = key.slice(separator + 1)
  return model === '' ? undefined : { channelId: key.slice(0, separator), model }
}

/** The subset of Web Storage this module needs (read side). */
export interface StorageReader { getItem(key: string): string | null }

/** The subset of Web Storage this module needs (write side). */
export interface StorageWriter { setItem(key: string, value: string): void }

/** Validate one raw stored payload into a complete settings object. */
function sanitize(raw: unknown): GenerationSettings {
  const settings = defaultGenerationSettings()
  if (typeof raw !== 'object' || raw === null) return settings
  const record = raw as Record<string, unknown>
  if (typeof record.size === 'string') settings.size = normalizeSize(record.size)
  if (typeof record.quality === 'string') settings.quality = normalizeQuality(record.quality)
  if (record.count !== undefined) settings.count = normalizeCount(record.count)
  if (typeof record.detail === 'string') settings.detail = normalizeDetail(record.detail)
  if (typeof record.model === 'string') settings.model = record.model.trim()
  if (typeof record.channelId === 'string') settings.channelId = record.channelId
  if (typeof record.compareEnabled === 'boolean') settings.compareEnabled = record.compareEnabled
  if (Array.isArray(record.compareModels)) {
    settings.compareModels = [...new Set(record.compareModels
      .filter((key): key is string => typeof key === 'string' && compareChoice(key) !== undefined))]
  }
  // A remembered model without a comparison list keeps the current model
  // selectable when compare is switched on later.
  if (settings.compareModels.length === 0 && settings.model !== '') {
    settings.compareModels = [compareKey(settings.channelId, settings.model)]
  }
  return settings
}

/**
 * Read the last-used settings. Malformed or unavailable storage degrades to the
 * defaults instead of throwing: a broken record must never keep the studio from
 * opening.
 */
export function readGenerationSettings(storage?: StorageReader | null): GenerationSettings {
  if (storage === undefined || storage === null) return defaultGenerationSettings()
  try {
    const text = storage.getItem(GENERATION_SETTINGS_STORAGE_KEY)
    if (text === null || text === '') return defaultGenerationSettings()
    return sanitize(JSON.parse(text) as unknown)
  } catch {
    return defaultGenerationSettings()
  }
}

/** Persist the current selection; storage failures stay silent (quota, private mode). */
export function writeGenerationSettings(storage: StorageWriter | null | undefined, settings: GenerationSettings): void {
  if (storage === undefined || storage === null) return
  try {
    storage.setItem(GENERATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Optional convenience: the in-memory selection still works for this session.
  }
}

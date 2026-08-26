/**
 * Model catalog: protocol-family detection and capability annotation shared by
 * the engine, the settings card, and the panel. Known id patterns map onto the
 * OpenAI-compatible image protocol families this plugin shapes requests for;
 * anything unrecognized falls back to the generic OpenAI protocol (best
 * effort) and is flagged as unknown so the UI can warn without blocking.
 *
 * Framework-free (pure data + regex), safe for the client bundle to inline.
 */

export type ModelFamily = 'gpt-image' | 'dall-e' | 'grok' | 'nanobanana' | 'seedream' | 'unknown'

/** Capability/identity annotation for one model id. */
export interface ModelCatalogEntry {
  /** Family the request is shaped for. */
  family: ModelFamily
  /** Short badge label (en). */
  label: string
  /** Short badge label (zh). */
  labelZh: string
  /** Whether the family is known (false = best-effort OpenAI protocol). */
  known: boolean
  /** Whether the family supports image-to-image edits. */
  supportsEdit: boolean
  /** Whether the family natively takes aspect-ratio dials. */
  supportsAspectRatio: boolean
  /** Quality tiers the family interprets natively. */
  qualityTiers: string[]
}

const ENTRIES: Record<Exclude<ModelFamily, 'unknown'>, Omit<ModelCatalogEntry, 'family'>> = {
  'gpt-image': {
    label: 'gpt-image',
    labelZh: 'GPT 图像',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: false,
    qualityTiers: ['1K', '2K', '4K'],
  },
  'dall-e': {
    label: 'DALL·E',
    labelZh: 'DALL·E',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: false,
    qualityTiers: ['auto'],
  },
  grok: {
    label: 'grok',
    labelZh: 'Grok',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: true,
    qualityTiers: ['1K', '2K'],
  },
  nanobanana: {
    label: 'nanobanana',
    labelZh: 'Nano Banana',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: true,
    qualityTiers: ['1K', '2K', '4K'],
  },
  seedream: {
    label: 'seedream',
    labelZh: 'Seedream',
    known: true,
    supportsEdit: true,
    supportsAspectRatio: true,
    qualityTiers: ['1K', '2K'],
  },
}

/** Official Gemini image ids served by Nano Banana gateways. */
const NANOBANANA_GEMINI_IDS = new Set([
  'gemini-3-pro-image',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image',
  'gemini-2.5-flash-image',
])

/** Classify one upstream model id into its request-shaping family. */
export function describeModel(model: string): ModelCatalogEntry {
  const id = model.trim()
  if (/^gpt-image/i.test(id)) return { family: 'gpt-image', ...ENTRIES['gpt-image'] }
  if (/^dall-e/i.test(id)) return { family: 'dall-e', ...ENTRIES['dall-e'] }
  if (/^grok-imagine(?:-|$)/.test(id)) return { family: 'grok', ...ENTRIES.grok }
  if (/^nanobanana/i.test(id) || NANOBANANA_GEMINI_IDS.has(id)) return { family: 'nanobanana', ...ENTRIES.nanobanana }
  if (/^(?:doubao-)?seedream/i.test(id)) return { family: 'seedream', ...ENTRIES.seedream }
  return { family: 'unknown', label: 'unknown', labelZh: '未知协议', known: false, supportsEdit: true, supportsAspectRatio: false, qualityTiers: [] }
}

/** The family a model id routes its request through. */
export function modelFamily(model: string): ModelFamily {
  return describeModel(model).family
}
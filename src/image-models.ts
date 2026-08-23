/**
 * Image-model configuration shared by the host, panel, and Agent tools.
 * `/models` exposes candidates only: the configured list is the explicit
 * allow-list because OpenAI-compatible gateways rarely advertise modalities.
 */

export const DEFAULT_IMAGE_MODELS = ['gpt-image-2', 'grok-imagine-image'] as const

/** Normalize user-entered model identifiers and retain a usable legacy default. */
export function normalizeImageModels(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : []
  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const model = candidate.trim()
    if (model !== '') unique.add(model)
  }
  return unique.size > 0 ? [...unique] : [...DEFAULT_IMAGE_MODELS]
}

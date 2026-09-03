/**
 * Shared panel helpers: the active-dictionary pick bound to the dsh-imagegen
 * interpolator, the plugin locale that follows the DSH interface language
 * (bridged in client/index.ts from ctx.locale — the plugin ships zh / en / ru
 * and registers itself as a DSH language pack for Русский), plus a small
 * error-message extractor. All copy stays in the locale dictionaries.
 */

import { en, ru, zh, type ImageGenKey } from './locales.ts'

/** Template values accepted by the interpolator. */
export type TranslateValues = Record<string, string | number>

/** Languages with a shipped dictionary. */
export type ImageGenLanguage = 'zh' | 'en' | 'ru'

const DICTIONARIES: Record<ImageGenLanguage, Record<string, string>> = { zh, en, ru }

/** The active DSH locale mapped onto our dictionary (module-level, one value per app). */
let activeLocale: ImageGenLanguage = 'zh'

/** Bumped on every locale change; useSyncExternalStore version. */
let languageVersion = 0

const languageListeners = new Set<() => void>()

/**
 * Adopt the DSH interface language. Unknown ids (future language packs)
 * resolve to English — the same per-key fallback convention the host locale
 * chain uses.
 */
export function applyHostLocale(id: unknown): void {
  const next: ImageGenLanguage = id === 'zh' || id === 'ru' ? id : 'en'
  if (next === activeLocale) return
  activeLocale = next
  languageVersion += 1
  for (const listener of [...languageListeners]) listener()
}

/** Monotonic version of the active locale (external-store snapshot). */
export function getImageGenLanguageVersion(): number {
  return languageVersion
}

/** Observe locale changes; returns the unsubscriber. */
export function subscribeImageGenLanguage(listener: () => void): () => void {
  languageListeners.add(listener)
  return () => { languageListeners.delete(listener) }
}

/** Active dictionary for the current DSH language. */
export function dictionary(): Record<string, string> {
  return DICTIONARIES[activeLocale]
}

/** Translate a key with optional {name} template params (current language). */
export function tt(key: ImageGenKey, values?: TranslateValues): string {
  const text = dictionary()[key] ?? key
  if (values === undefined) return text
  let rendered = text
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${name}}`, String(value))
  }
  return rendered
}

/** Human-readable error text from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

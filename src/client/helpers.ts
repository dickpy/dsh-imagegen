/**
 * Shared panel helpers: the active-dictionary pick (document-language based,
 * dsh-ssh precedent) bound to the dsh-imagegen interpolator, plus a small
 * error-message extractor. All copy stays in the locale dictionaries.
 */

import { en, zh, type ImageGenKey } from './locales.ts'

/** Template values accepted by the interpolator. */
export type TranslateValues = Record<string, string | number>

/** Active dictionary, picked by the document language at call time. */
export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh }
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

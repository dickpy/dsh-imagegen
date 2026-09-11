/**
 * Locale dictionaries and the pure interpolator.
 *
 * This module is the React-free half of the plugin's copy layer: the host half
 * imports the very same dictionaries to render server-produced text (skill
 * catalog labels, error messages, produced node titles) in the language the
 * user picked in the DSH interface. The browser half layers the live locale
 * binding (and its change subscription) on top in `helpers.ts`.
 *
 * Both halves must agree on key names, so the tables live here — not in a file
 * that also holds React state, which the two bundles would instantiate twice.
 */

import { en, ru, zh, type ImageGenKey } from './client/locales.ts'

/** Languages with a shipped dictionary. */
export type ImageGenLanguage = 'zh' | 'en' | 'ru'

/** Template values accepted by the interpolator. */
export type TranslateValues = Record<string, string | number>

/** Every shipped dictionary, keyed by language. */
export const IMAGEGEN_DICTIONARIES: Record<ImageGenLanguage, Record<string, string>> = { zh, en, ru }

/** Normalize any DSH locale id onto a shipped dictionary (unknown → English). */
export function imageGenLanguageOf(value: unknown): ImageGenLanguage {
  const head = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_]/)[0] ?? '' : ''
  return head === 'zh' || head === 'ru' ? head : 'en'
}

/**
 * Translate one key with optional `{name}` template params, falling back to
 * Chinese (the key source) and finally to the key itself.
 * @param key - dictionary key.
 * @param values - optional `{name}` substitutions.
 * @param language - shipped language to resolve against.
 * @returns the rendered copy.
 */
export function interpolate(key: string, values: TranslateValues | undefined, language: ImageGenLanguage): string {
  const text = IMAGEGEN_DICTIONARIES[language][key] ?? zh[key as ImageGenKey] ?? key
  if (values === undefined) return text
  let rendered: string = text
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${name}}`, String(value))
  }
  return rendered
}

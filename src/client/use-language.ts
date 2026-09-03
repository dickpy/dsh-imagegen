/**
 * React binding for the plugin locale, which follows the DSH interface
 * language (bridged from ctx.locale in client/index.ts). Surfaces that render
 * tt() output subscribe to this tick so a DSH language switch re-renders them
 * immediately.
 */

import { useSyncExternalStore } from 'react'
import { getImageGenLanguageVersion, subscribeImageGenLanguage } from './helpers.ts'

/** Re-render the calling component whenever the DSH language changes. */
export function useImageGenLanguageTick(): number {
  return useSyncExternalStore(subscribeImageGenLanguage, getImageGenLanguageVersion)
}

/**
 * Configuration entry surfaces shared by the browser half.
 *
 * The host renders the real settings page from a `settings.section`
 * registration; this module only carries its stable id and the in-app event
 * used by prompts that need to reveal that page.
 */

/** Stable id of the dsh-imagegen entry in the settings navigation. */
export const IMAGE_GEN_SECTION_ID = 'dsh-imagegen'

/** Event dispatched by in-app "configure" prompts. */
export const OPEN_IMAGE_GEN_CONFIG_EVENT = 'dsh-imagegen:open-config'

/** Settings blocks an in-app prompt may reveal. The studio's old PPT block is
 *  gone, so the only remaining deep link lands on the skill settings. */
export type ImageGenConfigSection = 'skills'

/** Ask the host to open Settings and select the dsh-imagegen section. */
let requestedSection: ImageGenConfigSection | undefined
export function takeImageGenConfigSection(): ImageGenConfigSection | undefined {
  const section = requestedSection
  requestedSection = undefined
  return section
}

export function openImageGenConfig(section: ImageGenConfigSection = 'skills'): void {
  requestedSection = section
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(OPEN_IMAGE_GEN_CONFIG_EVENT, { detail: { section } }))
}

/**
 * Plugins page → imagegen tab.
 *
 * The Plugins page renders one tab per registered contribution and mounts each
 * inside its own panel. This entry reuses the exact configuration surface the
 * Settings navigation page renders (`ImageGenSettingsSurface`), laid out as four
 * sub-tabs — channels & models, storage & sync, canvas skills, general — so a
 * field is never declared twice and both entries share the same staged drafts
 * (one `ImageGenSettingsCardController`).
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImageGenSettingsSurface, type ImageGenSettingsCardFace } from './SettingsCard.tsx'

/**
 * The Plugins-page tab seat.
 *
 * DSH renamed this slot (`settings.plugins.tab` in the 0.1.x types this plugin
 * builds against → `plugins.tab` in the 0.2.x desktop builds), and the name is
 * the whole registration key: registering into the name a host does not declare
 * is a silent no-op. Both are declared here so one build serves either host; the
 * registration below injects into both names and whichever exists wins.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.tab': {
      kind: 'list'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

/** Props the tab registration binds: runtime share, locale seat and inject face. */
export type ImageGenPluginsTabProps =
  PropsRuntime<'plugins.tab'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/**
 * Render the imagegen tab on the Plugins page.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the tab page, or nothing while the namespace is still loading.
 */
export function ImageGenPluginsTab(props: ImageGenPluginsTabProps) {
  return <ImageGenSettingsSurface {...props} mode="tabs" />
}

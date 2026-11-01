/**
 * Settings → Plugins → imagegen tab.
 *
 * The Plugins section renders one tab per registered contribution and mounts
 * each inside its own tab panel. This entry reuses the exact configuration
 * surface the Settings navigation page renders (`ImageGenSettingsSurface`),
 * laid out as four sub-tabs — channels & models, storage & sync, canvas
 * skills, general — so a field is never declared twice and both entries share
 * the same staged drafts (one `ImageGenSettingsCardController`).
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImageGenSettingsSurface, type ImageGenSettingsCardFace } from './SettingsCard.tsx'

/**
 * Props the Plugins-tab registration binds: the framework's runtime share for
 * `settings.plugins.tab`, the plugin's locale seat, and the same inject face
 * the Settings page receives.
 */
export type ImageGenPluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/**
 * Render the imagegen tab inside Settings → Plugins.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the tab page, or nothing while the namespace is still loading.
 */
export function ImageGenPluginsTab(props: ImageGenPluginsTabProps) {
  return <ImageGenSettingsSurface {...props} mode="tabs" />
}

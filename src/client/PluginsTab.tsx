/**
 * Plugin detail page → imagegen configuration.
 *
 * DSH renders a bundle's own configuration *inside its detail page* (after the
 * description, before the component rows) through `plugins.bundle.config`, a
 * keyed slot keyed by the npm package name. That is where a user who clicks
 * @dickpy/dsh-imagegen under 已安装 expects to configure it — the same place
 * dsh-claude-style shows its tabbed settings.
 *
 * This entry reuses the exact surface the Settings navigation page renders
 * (`ImageGenSettingsSurface`), laid out as four sub-tabs — channels & models,
 * storage & sync, canvas skills, general — so a field is never declared twice
 * and both entries share the same staged drafts (one controller).
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImageGenSettingsSurface, type ImageGenSettingsCardFace } from './SettingsCard.tsx'

/**
 * The seats this plugin registers into.
 *
 * `plugins.bundle.config` is the detail-page form (keyed by package name, owner
 * props carry `view: 'page' | 'summary'`). The 0.1.x type package this build
 * compiles against does not declare it, so it is declared here; the older
 * `settings.plugins.tab` / `plugins.tab` names are kept only so a host that
 * still uses them does not lose the entry — the registration injects into all
 * three and whichever the host declares wins.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { view?: 'page' | 'summary'; entryKey?: string }
    }
    'plugins.tab': {
      kind: 'list'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

/** Props the detail-page configuration registration binds. */
export type ImageGenPluginsTabProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/**
 * Render the imagegen configuration inside the plugin detail page.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the tabbed configuration surface with its own save bar.
 */
export function ImageGenPluginsTab(props: ImageGenPluginsTabProps) {
  return <ImageGenSettingsSurface {...props} mode="tabs" />
}

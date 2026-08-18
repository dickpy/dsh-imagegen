/**
 * Browser-half entry for the dsh-imagegen plugin — runs inside the dsh web
 * GUI.
 *
 * Registers the dsh-imagegen locale dictionaries, binds the plugin's own
 * settings scope (its bridge routes serve the namespace the official rc.6
 * allowlist would refuse), registers the settings card into the Web UI plugin
 * group slot, and mounts the two DOM surfaces: the sidebar entry row (toggles
 * the panel) and the generation studio in the center column. Failure policy:
 * DOM mounting problems are logged, never thrown — the web shell fails the
 * whole boot when a plugin apply throws, and an external plugin must not take
 * the GUI down.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ImageGenApi } from './api.ts'
import { ImageGenController } from './controller.ts'
import { tt } from './helpers.ts'
import { en, zh, type ImageGenKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { ImageGenSettingsCard, ImageGenSettingsCardController } from './SettingsCard.tsx'
import { bindImageGenScope, type ImageGenScope } from './settings-scope.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-imagegen'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-imagegen surface copy. */
    'dsh-imagegen': ImageGenKey
  }

  interface SlotMap {
    /**
     * The official plugin-configuration slot the Settings → Plugins →
     * Configurable tab declares and renders. This card registers there as its
     * own standalone card — independent of the dsh-web-ui family group — so
     * this plugin never reads as part of that family. Spelled here with the
     * same shape so this package can register without depending on the
     * sibling UI package.
     */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: ImageGenPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface ImageGenPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the studio, its sidebar entry, and the settings card.
 * @param ctx - client root context (services: slots, locale, connection).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-imagegen: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const loopback = connection?.isLoopback === true
  // The bridge routes are loopback-fenced; remote browsers get an unavailable
  // scope (the card explains the gap) instead of failing fetches.
  const scope: ImageGenScope = bindImageGenScope(loopback
    ? (input, init) => fetch(input, init)
    : () => { throw new Error('settings bridge is loopback-only') })

  // Re-read the scope whenever the connection resets (same invalidation the
  // official settings binder wires).
  ctx.effect(() => {
    const disposers = [
      ctx.on('connection/reset', () => { void scope.load() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-imagegen: settings scope invalidation')

  // Plugin configuration card: one staged form over the `dsh-imagegen` scope,
  // registered into the official plugin-configuration slot (Settings →
  // Plugins → Configurable) as a standalone card.
  const settingsCard = new ImageGenSettingsCardController(scope)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-imagegen',
    locale: NS,
    inject: () => settingsCard.inject(),
  }, ImageGenSettingsCard))

  // The sidebar entry and studio mount once the settings scope settles; while
  // the scope is still loading, the composition default is unknown, so nothing
  // mounts yet. Only an unavailable scope falls back to the default (enabled).
  let uiDisposer: (() => void) | undefined
  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    const controller = new ImageGenController()
    const api = new ImageGenApi()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(controller, tt('entry.label'), tt('entry.tooltip')))
      disposers.push(mountPanel(controller, api, scope))
    } catch (error) {
      // DOM failures degrade the studio, never the GUI.
      console.warn('[dsh-imagegen] mount failed:', error)
    }
    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      uiDisposer = undefined
    }
  }
  const syncEnabled = (): void => {
    const snapshot = scope.getSnapshot()
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
    else uiDisposer?.()
  }
  scope.subscribe(syncEnabled)
  syncEnabled()
}

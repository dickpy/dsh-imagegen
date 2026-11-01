/**
 * Browser-half entry for the dsh-imagegen plugin — runs inside the dsh web
 * GUI.
 *
 * Registers the dsh-imagegen locale dictionaries, binds the plugin's own
 * settings scope (its bridge routes serve the namespace the official rc.6
 * allowlist would refuse), registers the configuration page in the Settings
 * dialog's left navigation, and mounts the two DOM surfaces: the studio entry
 * row and the generation studio in the center column. Failure policy: DOM mounting problems are
 * logged, never thrown — the web shell fails the whole boot when a plugin
 * apply throws, and an external plugin must not take the GUI down.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings slot contract (settings.section).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ImageGenApi } from './api.ts'
import { ImageGenController } from './controller.ts'
import { tt, applyHostLocale } from './helpers.ts'
import { en, ru, zh, type ImageGenKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { ImageGenSettingsSection, ImageGenSettingsCardController } from './SettingsCard.tsx'
import { ImageGenPluginsTab } from './PluginsTab.tsx'
import { IMAGE_GEN_SECTION_ID, OPEN_IMAGE_GEN_CONFIG_EVENT } from './config-entry.tsx'
import { bindImageGenScope, type ImageGenScope } from './settings-scope.ts'
import { registerImageToolviews, type ImageToolViewOwnerProps } from './image-toolview.tsx'
import type { ConversationService } from './conversation-sync.ts'
import { CLIENT_BOOT_API, PLUGIN_VERSION } from '../protocol.ts'

/**
 * What this client build managed to register, posted to the host once per boot.
 *
 * A renderer can keep serving a cached client bundle, so "the change did not
 * show" is ambiguous: stale bundle, or a slot that never seated. This report is
 * the difference - the host keeps the last one and support can read it back.
 */
const bootReport = {
  slots: ['settings.section', 'plugins.tab', 'settings.plugins.tab'],
  registered: [] as string[],
  errors: [] as string[],
}

/** Send the boot report; a missing host route is not an error worth surfacing. */
function reportClientBoot(): void {
  try {
    void fetch(CLIENT_BOOT_API.report, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: PLUGIN_VERSION,
        slots: bootReport.slots,
        registered: bootReport.registered,
        errors: bootReport.errors,
        userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      }),
    }).catch(() => { /* diagnostics only */ })
  } catch { /* diagnostics only */ }
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-imagegen'
/** One live client UI tree per document, even if the host re-applies this module. */
const UI_MOUNT_LEASE_KEY = Symbol.for('dsh-imagegen.client-ui-lease')

interface UiMountLease {
  release(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-imagegen surface copy. */
    'dsh-imagegen': ImageGenKey
  }

  interface SlotMap {
    /** Image-generation results render their durable image blocks inline. */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ImageToolViewOwnerProps }
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'connection', 'sessions', 'conversation']

// Internals re-exported for the standalone smoke test (the browser bundle is
// the only place these are reachable from Node); not part of the contract.
export { autoRemoveBackground, compositeAnnotatedResult, containRect, cropRaster, drawAnnotation, rectBetween, rectToPixels, removeBackground, transparencyRatio } from './image-ops.ts'
export { addConversationAttachments, conversationInput, createConversationDrafts, releaseConversationDrafts, removeConversationAttachment } from './conversation-sync.ts'
export { isPosterDocument, wrapPosterText } from '../poster.ts'
export { paintPoster } from './poster-render.ts'
export { imageRefsOf } from './image-toolview.tsx'
export { sidebarEntryTestHooks } from './sidebar-entry.ts'

/**
 * Mount the studio, its sidebar entry, and the configuration page.
 * @param ctx - client root context (services: slots, locale, connection).
 */
export function apply(ctx: ClientContext): void {
  // The host locale service only knows zh/en dictionaries (its type is
  // fixed); ru rides the untyped single-locale registration instead.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-imagegen: dictionaries')
  // Russian ships as a language pack: the dictionary lands in this plugin's
  // namespace, and Russian joins the shared DSH language catalog (Settings →
  // General → Language) with per-key fallback to English for host copy.
  // Registration order/aggregation between register(NS, 'ru', …) and
  // addLanguage differs across host builds and a duplicate throws — these
  // surfaces must degrade silently, never fail the GUI boot.
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, 'ru', ru)
    } catch (error) {
      console.warn('[dsh-imagegen] ru dictionary not registered:', error)
      return () => {}
    }
  }, 'dsh-imagegen: ru dictionary')
  ctx.effect(() => {
    try {
      if (ctx.locale.getLocale().locales.some(locale => locale.id === 'ru')) return () => {}
      return ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })
    } catch (error) {
      console.warn('[dsh-imagegen] ru language not added to the catalog:', error)
      return () => {}
    }
  }, 'dsh-imagegen: ru language pack')
  // Every plugin surface renders through tt(); bridge DSH locale switches
  // into it so the whole plugin follows the interface language.
  ctx.effect(() => {
    const applyLocale = (): void => { applyHostLocale(ctx.locale.getLocale().active) }
    applyLocale()
    return ctx.locale.subscribe(applyLocale)
  }, 'dsh-imagegen: follow host locale')
  registerImageToolviews(ctx)

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const loopback = connection?.isLoopback === true
  // The bridge routes are loopback-fenced; remote browsers get an unavailable
  // scope (the panel explains the gap) instead of failing fetches.
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

  // Plugin configuration: one staged form over the `dsh-imagegen` scope,
  // registered as its own page in the Settings dialog's left navigation.
  const settingsCard = new ImageGenSettingsCardController(scope)
  ctx.slots.inject('settings.section', () => {
    bootReport.registered.push('settings.section')
    return ctx.slots.register({
      name: 'settings.section',
      id: IMAGE_GEN_SECTION_ID,
      order: 16,
      label: () => tt('entry.settings'),
      locale: NS,
      inject: () => settingsCard.inject(),
    }, ImageGenSettingsSection)
  })

  // The same configuration also ships as a tab on the Plugins page, so users who
  // live in the plugin inventory find it without leaving that page. Both entries
  // share one controller, hence one set of staged drafts.
  //
  // DSH renamed this seat: the 0.1.x types this plugin compiles against declare
  // `settings.plugins.tab`, while the 0.2.x desktop builds declare `plugins.tab`.
  // The slot name IS the registration key, and registering into a name the host
  // does not declare is a silent no-op - which is exactly how the tab stayed
  // invisible. Register into both; the one the host declares wins, the other is
  // a no-op, and a host with neither degrades (no tab) instead of failing boot.
  for (const slot of ['plugins.tab', 'settings.plugins.tab'] as const) {
    ctx.effect(() => {
      try {
        return ctx.slots.inject(slot as 'plugins.tab', () => {
          try {
            const dispose = ctx.slots.register({
              name: slot as 'plugins.tab',
              id: 'imagegen',
              order: 20,
              label: () => tt('entry.settings'),
              locale: NS,
              inject: () => settingsCard.inject(),
            }, ImageGenPluginsTab)
            bootReport.registered.push(slot)
            return dispose
          } catch (error) {
            bootReport.errors.push(`${slot}: ${error instanceof Error ? error.message : String(error)}`)
            console.warn(`[dsh-imagegen] plugins tab not registered on ${slot}:`, error)
            return () => {}
          }
        })
      } catch (error) {
        bootReport.errors.push(`${slot} inject: ${error instanceof Error ? error.message : String(error)}`)
        console.warn(`[dsh-imagegen] ${slot} slot unavailable:`, error)
        return () => {}
      }
    }, `dsh-imagegen: plugins tab (${slot})`)
  }

  // In-app "configure" prompts open the Settings dialog and select this page.
  // The host exposes no public openSection API, so use the rendered dialog's
  // stable accessible affordances and degrade with a warning, never a throw.
  ctx.effect(() => {
    const isSettingsTrigger = (button: HTMLButtonElement): boolean => {
      const label = (button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '').trim()
      return label === '设置' || label === 'Settings' || label === 'Настройки'
    }
    const findSectionButton = (): HTMLButtonElement | undefined => {
      const label = tt('entry.settings')
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
        for (const button of dialog.querySelectorAll<HTMLButtonElement>('nav button')) {
          if ((button.textContent ?? '').trim() === label) return button
        }
      }
      return undefined
    }
    const waitForSectionButton = async (timeoutMs: number): Promise<HTMLButtonElement | undefined> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const button = findSectionButton()
        if (button !== undefined) return button
        await new Promise<void>(resolve => { window.setTimeout(resolve, 25) })
      }
      return findSectionButton()
    }
    const openConfig = async (): Promise<void> => {
      try {
        let section = findSectionButton()
        if (section === undefined) {
          const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
            .find(isSettingsTrigger)
          if (trigger === undefined) {
            console.warn('[dsh-imagegen] Settings trigger not found; cannot open Image settings')
            return
          }
          trigger.click()
          section = await waitForSectionButton(2500)
        }
        if (section === undefined) {
          console.warn('[dsh-imagegen] Image settings section not found in the Settings dialog')
          return
        }
        section.click()
      } catch (error) {
        console.warn('[dsh-imagegen] failed to open Image settings:', error)
      }
    }
    const onOpenConfig = (): void => { void openConfig() }
    window.addEventListener(OPEN_IMAGE_GEN_CONFIG_EVENT, onOpenConfig)
    return () => { window.removeEventListener(OPEN_IMAGE_GEN_CONFIG_EVENT, onOpenConfig) }
  }, 'dsh-imagegen: open settings section')

  // The sidebar entry and studio mount once the settings scope settles; while
  // the scope is still loading, the composition default is unknown, so nothing
  // mounts yet. Only an unavailable scope falls back to the default (enabled).
  let uiDisposer: (() => void) | undefined
  let scopeDisposer: (() => void) | undefined
  let uiLeaseReleased = false
  let uiLease: UiMountLease
  uiLease = {
    release: () => {
      if (uiLeaseReleased) return
      uiLeaseReleased = true
      scopeDisposer?.()
      scopeDisposer = undefined
      uiDisposer?.()
      uiDisposer = undefined
      if (Reflect.get(document, UI_MOUNT_LEASE_KEY) === uiLease) {
        Reflect.deleteProperty(document, UI_MOUNT_LEASE_KEY)
      }
    },
  }
  const mountUi = (): void => {
    if (uiLeaseReleased) return
    if (uiDisposer !== undefined) return
    const controller = new ImageGenController()
    const api = new ImageGenApi()
    const sessions = ctx.get('sessions') as ISessions | undefined
    const conversation = ctx.get('conversation') as ConversationService | undefined
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(
        controller,
        tt('entry.session'),
        tt('entry.sessionTooltip'),
        tt('entry.image'),
        tt('entry.tooltip'),
      ))
      disposers.push(mountPanel(controller, api, scope, { sessions, conversation }))
      // The imperative sidebar tabs render their labels once; relabel them on
      // every DSH language switch so the entry follows the interface too.
      disposers.push(ctx.locale.subscribe(() => {
        const root = document.querySelector('[data-dsh-imagegen-sidebar-root]')
        if (root === null) return
        const labels: Array<[string, string, string]> = [
          ['session', tt('entry.session'), tt('entry.sessionTooltip')],
          ['image', tt('entry.image'), tt('entry.tooltip')],
        ]
        for (const [tab, label, tooltip] of labels) {
          const button = root.querySelector<HTMLButtonElement>(`[data-dsh-imagegen-tab="${tab}"]`)
          if (button === null) continue
          button.setAttribute('aria-label', label)
          button.setAttribute('title', tooltip)
          const labelSpan = button.querySelector('span:nth-child(2)')
          if (labelSpan !== null) labelSpan.textContent = label
        }
        const tablist = root.querySelector<HTMLDivElement>('[role="tablist"][data-dsh-imagegen-session-tabs]')
        tablist?.setAttribute('aria-label', tt('entry.tooltip'))
      }))
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
    if (uiLeaseReleased) return
    const snapshot = scope.getSnapshot()
    if (snapshot.status === 'loading') return
    const activeLease = Reflect.get(document, UI_MOUNT_LEASE_KEY) as UiMountLease | undefined
    if (activeLease !== uiLease) {
      activeLease?.release()
      Reflect.set(document, UI_MOUNT_LEASE_KEY, uiLease)
    }
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
    else uiDisposer?.()
  }
  scopeDisposer = scope.subscribe(syncEnabled)
  syncEnabled()
  ctx.effect(() => () => { uiLease.release() }, 'dsh-imagegen: client UI mount')
  // Report the boot twice: the settings page seats synchronously, while a Plugins
  // tab only seats once the host declares its slot - which may happen later. A
  // host without timers (the jsdom test sandbox) still gets the first report.
  reportClientBoot()
  if (typeof setTimeout === 'function') setTimeout(reportClientBoot, 2_000)
}

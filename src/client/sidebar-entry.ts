/**
 * Replace the shell's standalone New Session affordance with a two-tab entry:
 * New Session and Image Generation. When image generation is active, the
 * plugin also uses the shell's region area as a dedicated history surface;
 * the original workspace/session tree remains underneath and is restored when
 * the panel closes.
 */

import type { ImageGenController } from './controller.ts'
import css from './panel.module.css'

/** Stable selector for the injected two-tab host. */
export const ENTRY_SELECTOR = '[data-dsh-imagegen-session-tabs]'
/** Stable selector for the history surface in the shell region area. */
export const HISTORY_HOST_SELECTOR = '[data-dsh-imagegen-history-host]'

/** Inline picture glyph kept deliberately small for the sidebar rail. */
const IMAGE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.6" cy="5.8" r="1"/><path d="M2.5 12.5l3.6-3.4 2.4 2.2 3-3 2 2.4"/></svg>'

/** Inline plus glyph for the new-session tab. */
const NEW_SESSION_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'

/** Find the sidebar shell root, or undefined while it is not mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The shell-owned New Session button across current and legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  return root.querySelector<HTMLButtonElement>(
    'button[data-dsh-part="new-session"], button[class*="newSession"]',
  ) ?? Array.from(root.children).find(
    (child): child is HTMLButtonElement => child instanceof HTMLElement && child.tagName === 'BUTTON',
  )
}

/** Locate the shell region that normally contains workspaces and sessions. */
function regionArea(root: HTMLElement): HTMLElement | undefined {
  return root.querySelector<HTMLElement>('[class*="regionArea"]') ?? undefined
}

function makeTab(
  label: string,
  tooltip: string,
  icon: string,
  onClick: () => void,
): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = css.sessionTab
  tab.setAttribute('aria-label', label)
  tab.setAttribute('title', tooltip)
  tab.innerHTML = `<span class="${css.sessionTabIcon}">${icon}</span><span class="${css.sessionTabLabel}">${label}</span>`
  tab.addEventListener('click', onClick)
  return tab
}

function hideShellButton(button: HTMLButtonElement): void {
  button.dataset.dshImagegenOriginal = ''
  button.setAttribute('aria-hidden', 'true')
  button.tabIndex = -1
  button.style.display = 'none'
}

function restoreShellButton(button: HTMLButtonElement): void {
  button.style.removeProperty('display')
  button.removeAttribute('aria-hidden')
  button.removeAttribute('tabindex')
  delete button.dataset.dshImagegenOriginal
}

/** Mount or repair the two-tab host at the shell's New Session position. */
function placeTabs(
  root: HTMLElement,
  controller: ImageGenController,
  newSessionLabel: string,
  newSessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): HTMLDivElement | undefined {
  const button = newSessionButton(root)
  if (button === undefined) return undefined

  const existing = root.querySelector<HTMLDivElement>(ENTRY_SELECTOR)
  if (existing !== null && existing.parentElement === button.parentElement) {
    hideShellButton(button)
    return existing
  }

  existing?.remove()
  const tabs = document.createElement('div')
  tabs.dataset.dshImagegenSessionTabs = ''
  tabs.className = css.sessionTabs
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', imageTooltip)

  const newSessionTab = makeTab(newSessionLabel, newSessionTooltip, NEW_SESSION_ICON, () => {
    controller.close()
    button.click()
  })
  const imageTab = makeTab(imageLabel, imageTooltip, IMAGE_ICON, () => {
    controller.open()
  })
  newSessionTab.dataset.dshImagegenTab = 'new-session'
  imageTab.dataset.dshImagegenTab = 'image'
  tabs.append(newSessionTab, imageTab)

  button.parentElement?.insertBefore(tabs, button)
  hideShellButton(button)
  return tabs
}

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement): HTMLDivElement | undefined {
  const region = regionArea(root)
  if (region === undefined) return undefined
  const existing = region.querySelector<HTMLDivElement>(HISTORY_HOST_SELECTOR)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.dataset.dshImagegenHistoryHost = ''
  host.className = css.sidebarHistoryHost
  region.append(host)
  return host
}

/**
 * Mount the two tabs and self-heal after React rebuilds the sidebar. The
 * shell-owned button is restored by the disposer so unloading the plugin
 * leaves the host unchanged.
 */
export function mountSidebarEntry(
  controller: ImageGenController,
  newSessionLabel: string,
  newSessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): () => void {
  let root: HTMLElement | undefined
  let tabs: HTMLDivElement | undefined
  let historyHost: HTMLDivElement | undefined
  let originalButton: HTMLButtonElement | undefined

  const syncActive = (): void => {
    if (tabs === undefined) return
    const newTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="new-session"]')
    const imageTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-tab="image"]')
    if (controller.getSnapshot().panelOpen) {
      if (newTab !== null) delete newTab.dataset.active
      if (imageTab !== null) imageTab.dataset.active = ''
    } else {
      if (newTab !== null) newTab.dataset.active = ''
      if (imageTab !== null) delete imageTab.dataset.active
    }
  }

  const ensure = (): void => {
    if (root !== undefined && !root.isConnected) {
      root = undefined
      tabs = undefined
      historyHost = undefined
      originalButton = undefined
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    root.dataset.dshImagegenSidebarRoot = ''
    const button = newSessionButton(root)
    if (button === undefined) return
    originalButton ??= button
    tabs = placeTabs(root, controller, newSessionLabel, newSessionTooltip, imageLabel, imageTooltip)
    historyHost = placeHistoryHost(root)
    syncActive()
  }

  const bodyObserver = new MutationObserver(ensure)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = controller.subscribe(syncActive)
  ensure()

  return () => {
    bodyObserver.disconnect()
    unsubscribe()
    tabs?.remove()
    historyHost?.remove()
    if (originalButton !== undefined && originalButton.isConnected) restoreShellButton(originalButton)
    if (root !== undefined) delete root.dataset.dshImagegenSidebarRoot
  }
}

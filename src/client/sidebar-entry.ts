/**
 * Sidebar DOM surfaces the studio needs from the shipped shell.
 *
 * The launcher itself is NOT here: it is registered as a real global panel
 * (`sidebar.panellist` + a `main` shim, see sidebar-panel.tsx), because every
 * sidebar implementation — the shipped shell, the Islands skin, the next one —
 * builds its navigation from that slot, while an injected row only exists in
 * the implementation it was written against.
 *
 * What remains is the history surface and the two markers that keep the shell's
 * own controls visible while the studio takes over the center column:
 *
 * - the history host, an overlay over the workspace/session region;
 * - `data-dsh-imagegen-sidebar-keep` on the wrapper chain, so the allow-list in
 *   panel.module.css never hides the ancestors that carry that host (0.2.x
 *   added scrollRegion > scrollArea around the region);
 * - `data-dsh-imagegen-new-session` on the shell's New Session button, which
 *   stays a native control throughout.
 */

import css from './panel.module.css'

/** Stable selector for the history surface in the shell region area. */
export const HISTORY_HOST_SELECTOR = '[data-dsh-imagegen-history-host]'

/**
 * Sidebar column markers: the web shell names its grid column `sidebarCol`
 * (AppFrame) or exposes `data-pane="sidebar"`; DSH Desktop renders the upstream
 * sidebar inside a surface of its own instead (#20).
 */
const SIDEBAR_COLUMN_SELECTOR = [
  '[data-pane="sidebar"]',
  '[class*="sidebarCol"]',
  '[class*="dshDesktopSidebarSurface"]',
  '[class*="dshDesktopUpstreamSidebar"]',
].join(', ')

/** Accessible names the shell gives its New Session affordance. */
const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

/** Loose New Session match for shells without a stable class or data hook. */
function looksLikeNewSession(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return NEW_SESSION_LABELS.some((label) => name.includes(label))
}

/** Find the sidebar shell root, or undefined while it is not mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  const logoRow = (column ?? document).querySelector<HTMLElement>('[class*="logoRow"]')
  if (logoRow !== null) {
    // Walk out of the brand row until an ancestor also owns the shell button:
    // desktop shells put a wrapper surface between the two, so the row parent is
    // not always the root the surfaces have to live in (#20).
    for (let candidate = logoRow.parentElement; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (newSessionButton(candidate, false) !== undefined) return candidate
      if (candidate === column) break
      if (column !== null && !column.contains(candidate)) break
    }
    // Legacy shape: with no recognisable shell button anywhere above the brand
    // row its parent stays the mount point (#20).
    return logoRow.parentElement ?? column ?? undefined
  }
  if (column === null) return undefined
  return (column.firstElementChild as HTMLElement | undefined) ?? column
}

/**
 * The shell-owned New Session button across current and legacy shells. The
 * loose fallback stays opt-in so the root search never settles on a wrapper
 * whose first button happens to be a brand or collapse toggle (#20).
 */
function newSessionButton(root: HTMLElement, allowLooseFallback = true): HTMLButtonElement | undefined {
  const hooked = root.querySelector<HTMLButtonElement>(
    'button[data-dsh-part="new-session"], button[class*="newSession"]',
  )
  if (hooked !== null) return hooked
  const labelled = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(looksLikeNewSession)
  if (labelled !== undefined) return labelled
  if (!allowLooseFallback) return undefined
  return Array.from(root.children).find(
    (child): child is HTMLButtonElement => child instanceof HTMLElement && child.tagName === 'BUTTON',
  )
}

/** Marks the sidebar wrapper chain the studio keeps visible. */
export const SIDEBAR_KEEP_ATTR = 'data-dsh-imagegen-sidebar-keep'

/** Locate the shell region that normally contains workspaces and sessions. */
function regionArea(root: HTMLElement): HTMLElement | undefined {
  return root.querySelector<HTMLElement>('[class*="regionArea"]') ?? undefined
}

/**
 * Mark every wrapper between the sidebar root and the workspace region.
 *
 * The studio keeps only a few sidebar children (brand row, the panel list, New
 * Session, the workspace region, the foot); everything else is hidden by an
 * allow-list. A shell is free to wrap that region in extra scroll containers —
 * 0.2.x added scrollRegion > scrollArea around it — and then the allow-list
 * hid the wrapper that carries the image history, blanking the sidebar. Marking
 * the chain keeps the history surface mounted without naming shell classes.
 * @param root - the sidebar root element.
 * @param region - the workspace/session region inside it.
 */
function markKeepChain(root: HTMLElement, region: HTMLElement): void {
  for (let node: HTMLElement | null = region; node !== null && node !== root; node = node.parentElement) {
    if (!node.hasAttribute(SIDEBAR_KEEP_ATTR)) node.setAttribute(SIDEBAR_KEEP_ATTR, '')
  }
}

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement): void {
  const region = regionArea(root)
  if (region === undefined) return
  if (region.querySelector<HTMLElement>(HISTORY_HOST_SELECTOR) !== null) return
  const host = document.createElement('div')
  host.dataset.dshImagegenHistoryHost = ''
  host.className = css.sidebarHistoryHost
  region.append(host)
}

/**
 * Mount the studio's sidebar surfaces and self-heal after React rebuilds the
 * sidebar. The shell keeps owning the New Session button and the panel list.
 * @returns disposer removing every injected surface and marker.
 */
export function mountSidebarSurfaces(): () => void {
  let root: HTMLElement | undefined
  let historyHost: HTMLElement | undefined
  let markedButton: HTMLButtonElement | undefined
  let warnedUnmounted = false

  /**
   * Compact shell fingerprint for the warning below: it never dumps the sidebar
   * markup (which carries session titles), only the markers we look for.
   */
  const describeShell = (): string => {
    const markers = SIDEBAR_COLUMN_SELECTOR.split(', ')
      .map((selector) => `${selector}=${document.querySelectorAll(selector).length}`)
      .join(' ')
    const outline = Array.from(document.body.children)
      .slice(0, 6)
      .map((element) => {
        const name = typeof element.className === 'string' ? element.className.split(/\s+/)[0] : ''
        return `${element.tagName.toLowerCase()}${name === '' ? '' : `.${name}`}`
      })
      .join(' > ')
    return `${markers} body>${outline}`
  }

  // A shell we have never seen must not fail silently: the reporter of #20 had
  // no console output at all to work from.
  const warnUnmounted = (): void => {
    if (warnedUnmounted || historyHost !== undefined) return
    warnedUnmounted = true
    const reason = root === undefined ? 'sidebar root not found' : 'workspace region not found'
    console.warn(`[dsh-imagegen] sidebar surfaces stayed unmounted (${reason}); shell probe: ${describeShell()}`)
  }

  const unmountedTimer = window.setTimeout(warnUnmounted, 5000)

  const ensure = (): void => {
    if (root !== undefined && !root.isConnected) {
      markedButton?.removeAttribute('data-dsh-imagegen-new-session')
      markedButton = undefined
      root = undefined
      historyHost = undefined
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    root.dataset.dshImagegenSidebarRoot = ''
    const button = newSessionButton(root)
    if (button !== undefined) {
      if (markedButton !== button) markedButton?.removeAttribute('data-dsh-imagegen-new-session')
      markedButton = button
      if (!button.hasAttribute('data-dsh-imagegen-new-session')) {
        button.setAttribute('data-dsh-imagegen-new-session', '')
      }
    }
    placeHistoryHost(root)
    const region = regionArea(root)
    if (region !== undefined) {
      markKeepChain(root, region)
      historyHost = region.querySelector<HTMLElement>(HISTORY_HOST_SELECTOR) ?? undefined
    }
  }

  const bodyObserver = new MutationObserver(ensure)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  ensure()

  return () => {
    window.clearTimeout(unmountedTimer)
    bodyObserver.disconnect()
    for (const element of document.querySelectorAll<HTMLElement>(HISTORY_HOST_SELECTOR)) element.remove()
    markedButton?.removeAttribute('data-dsh-imagegen-new-session')
    for (const element of document.querySelectorAll<HTMLElement>(`[${SIDEBAR_KEEP_ATTR}]`)) {
      element.removeAttribute(SIDEBAR_KEEP_ATTR)
    }
    if (root !== undefined) delete root.dataset.dshImagegenSidebarRoot
  }
}

/**
 * Internals re-exported for the standalone smoke test: the browser bundle is
 * the only consumer of these surfaces, so the check has to drive them directly
 * to cover a shell layout the jsdom studio fixture does not render (#20).
 */
export const sidebarEntryTestHooks = {
  findSidebarRoot: sidebarRoot,
  findNewSessionButton: newSessionButton,
  mount: mountSidebarSurfaces,
}

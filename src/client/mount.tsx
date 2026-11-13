/**
 * Panel view mounting.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the panel takes over the center column at
 * the DOM level: a container is appended inside the conversation grid item
 * (an extra trailing child React never manages), and a stylesheet rule hides
 * the conversation content while the panel is active. Toggling is a data
 * attribute on <html> — no React involvement, so the conversation subtree
 * underneath stays mounted and stateful.
 *
 * Shell compatibility: the center column is `[data-pane="conversation"]` on
 * legacy shells and `[class*="centerCol"]` on the rc.6+ AppFrame layout (the
 * same dual selector the dsh-ssh / task-board panels use); both are queried
 * and both get the `position: relative` base in panel.module.css.
 */

import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { createRoot, type Root } from 'react-dom/client'
import type { ImageGenApi } from './api.ts'
import type { ImageGenController } from './controller.ts'
import { ImageGenPanel } from './ImageGenPanel.tsx'
import type { ImageGenScope } from './settings-scope.ts'
import type { ConversationService } from './conversation-sync.ts'
import css from './panel.module.css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const PANEL_VIEW_SELECTOR = '[data-dsh-imagegen-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
/**
 * Marks the center column's DIRECT child that carries the Conversation. The
 * chat track is placed by CSS on that element, and which element that is moved
 * between shell generations: a 'conversation' slot root (legacy), the keyed
 * 'main' anchor (0.1.5+), and the AppFrame's own mainPanel wrapper (0.2.x).
 * Marking whatever wraps the Conversation keeps the takeover working when a
 * shell adds another wrapper, instead of the chat disappearing from the studio.
 */
export const CHAT_COLUMN_ATTR = 'data-dsh-imagegen-chat-column'
const ACTIVE_ATTR = 'data-dsh-imagegen-active'
const RESIZER_SELECTOR = '[data-dsh-imagegen-chat-resizer]'
const CHAT_WIDTH_STORAGE_KEY = 'dsh-imagegen:chat-width'
const CHAT_MIN_WIDTH = 320
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'imagegen'

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * The center column's direct child that owns the Conversation.
 * @param column - the center column element.
 * @returns the carrier, or undefined while the Conversation is not mounted.
 */
function chatCarrier(column: HTMLElement): HTMLElement | undefined {
  const marker = column.querySelector<HTMLElement>(
    '[data-slot="main.conversation"], [data-slot="conversation"], [data-phase]',
  )
  if (marker === null || marker === column) return undefined
  let node: HTMLElement = marker
  while (node.parentElement !== null && node.parentElement !== column) node = node.parentElement
  return node.parentElement === column ? node : undefined
}

function readChatWidth(): number | undefined {
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value >= CHAT_MIN_WIDTH ? value : undefined
  } catch {
    return undefined
  }
}

function writeChatWidth(value: number): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(value)))
  } catch {
    // Private browsing and embedded shells may disable localStorage.
  }
}

function applyChatWidth(column: HTMLElement, clientX: number): void {
  const bounds = column.getBoundingClientRect()
  const max = Math.max(CHAT_MIN_WIDTH, bounds.width * 0.7)
  const width = Math.min(max, Math.max(CHAT_MIN_WIDTH, bounds.right - clientX))
  column.style.setProperty('--dsh-imagegen-chat-width', `${Math.round(width)}px`)
  writeChatWidth(width)
}

/** Create the visible handle that separates the image workspace and chat. */
function createChatResizer(column: HTMLElement): HTMLDivElement {
  const resizer = document.createElement('div')
  resizer.dataset.dshImagegenChatResizer = ''
  resizer.className = css.chatResizer
  resizer.setAttribute('role', 'separator')
  resizer.setAttribute('aria-orientation', 'vertical')
  resizer.setAttribute('aria-label', '调整对话区域宽度')
  resizer.tabIndex = 0

  const saved = readChatWidth()
  if (saved !== undefined) column.style.setProperty('--dsh-imagegen-chat-width', `${saved}px`)

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    resizer.setPointerCapture?.(event.pointerId)
    const onMove = (move: PointerEvent): void => { applyChatWidth(column, move.clientX) }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      resizer.releasePointerCapture?.(event.pointerId)
      document.documentElement.style.removeProperty('cursor')
      document.documentElement.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.documentElement.style.setProperty('cursor', 'col-resize')
    document.documentElement.style.setProperty('user-select', 'none')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const bounds = column.getBoundingClientRect()
    const current = column.style.getPropertyValue('--dsh-imagegen-chat-width')
    const currentWidth = Number.parseFloat(current) || bounds.width * 0.36
    const delta = event.key === 'ArrowLeft' ? -24 : 24
    applyChatWidth(column, bounds.right - currentWidth - delta)
  }
  resizer.addEventListener('pointerdown', onPointerDown)
  resizer.addEventListener('keydown', onKeyDown)
  return resizer
}

/**
 * Mount the panel React tree into the center column and bind its visibility
 * to the controller's panelOpen state.
 * @param controller - the panel controller driving the view.
 * @param api - the image-generation API client the panel operates through.
 * @param scope - the settings scope (config status banner).
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountPanel(
  controller: ImageGenController,
  api: ImageGenApi,
  scope: ImageGenScope,
  services: {
    sessions?: ISessions
    conversation?: ConversationService
  } = {},
): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let resizer: HTMLDivElement | undefined
  let panelActive = false
  let markedCarrier: HTMLElement | undefined

  /**
   * Keep the chat carrier marked. Cheap in the steady state (the marker is
   * already on a connected element); re-marks whenever the shell replaces the
   * wrapper, which is the case a class-name-only selector would miss.
   */
  const syncChatCarrier = (): void => {
    if (markedCarrier !== undefined && markedCarrier.isConnected) return
    markedCarrier?.removeAttribute(CHAT_COLUMN_ATTR)
    markedCarrier = undefined
    const column = conversationColumn()
    if (column === undefined) return
    const carrier = chatCarrier(column)
    if (carrier === undefined) return
    carrier.setAttribute(CHAT_COLUMN_ATTR, '')
    markedCarrier = carrier
  }

  const renderPanel = (): void => {
    root?.render(<ImageGenPanel api={api} scope={scope} active={panelActive} {...services} />)
  }

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      // The conversation pane was replaced; drop the stale tree and remount.
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
      resizer?.remove()
      resizer = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshImagegenView = ''
    container.className = css.view
    column.appendChild(container)
    root = createRoot(container)
    renderPanel()
    resizer = column.querySelector<HTMLDivElement>(RESIZER_SELECTOR) ?? createChatResizer(column)
    if (resizer.parentElement !== column) column.appendChild(resizer)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  // The same pass re-marks the chat carrier when a shell re-render replaces it.
  const waitObserver = new MutationObserver(() => { ensure(); syncChatCarrier() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    panelActive = controller.getSnapshot().panelOpen
    syncChatCarrier()
    if (panelActive) {
      // Single-occupant center column: opening this panel must evict sibling
      // panels (task board / ssh), both their html attributes and their
      // controller states, otherwise the visibility rules fight.
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
    renderPanel()
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if ((detail === 'ssh' || detail === 'taskboard') && controller.getSnapshot().panelOpen) {
      controller.close()
    }
  }
  // Jump out on sidebar context clicks: clicking a session/workspace row
  // hands the center column back to the conversation. Capture phase.
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"], [data-dsh-imagegen-new-session]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    markedCarrier?.removeAttribute(CHAT_COLUMN_ATTR)
    markedCarrier = undefined
    for (const element of document.querySelectorAll<HTMLElement>(`[${CHAT_COLUMN_ATTR}]`)) {
      element.removeAttribute(CHAT_COLUMN_ATTR)
    }
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    resizer?.remove()
    resizer = undefined
  }
}

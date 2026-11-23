/**
 * The sidebar launcher, registered as a real global panel.
 *
 * Why a registered panel and not a row injected into the shipped sidebar: every
 * sidebar implementation builds its navigation from the `sidebar.panellist`
 * slot — the shipped shell, the Islands skin and whatever comes next. A DOM row
 * only exists inside the one implementation it was written against, so a skin
 * that draws its own rail cannot see it.
 *
 * The studio itself is deliberately NOT a `main` panel: it shares the center
 * column with the native Conversation, and a `main` panel replaces that column
 * outright. So this panel id is a launcher shim — selecting it toggles the
 * studio and immediately hands the column back to the Conversation, which is
 * what the studio needs beside it.
 */

import { useEffect, useRef, useState } from 'react'
import { Images } from 'lucide-react'
import type { ImageGenController } from './controller.ts'
import css from './panel.module.css'

/** Main panel id shared by the launcher entry and its shim body. */
export const IMAGEGEN_PANEL_ID = 'imagegen'

/** What the launcher needs from the running client UI. */
export interface SidebarPanelRuntime {
  /** The studio's open/closed owner; absent while the plugin is disabled. */
  controller?: ImageGenController
  /** Select the Conversation as the main panel (null = no global panel). */
  selectConversation: () => void
}

/**
 * Module-scoped runtime: sidebar implementations render the launcher component
 * directly (`h(entry.component, { size, active })`) instead of through the slot
 * renderer, so injected props are not guaranteed to arrive.
 */
let runtime: SidebarPanelRuntime | undefined

/**
 * Bind or clear the launcher's runtime.
 * @param next - the live controller plus the layout bridge, or undefined.
 */
export function setSidebarPanelRuntime(next: SidebarPanelRuntime | undefined): void {
  runtime = next
}

/** Studio open state, read from the controller rather than from slot props. */
function useStudioOpen(): boolean {
  const [open, setOpen] = useState(() => runtime?.controller?.getSnapshot().panelOpen ?? false)
  useEffect(() => {
    const controller = runtime?.controller
    if (controller === undefined) return undefined
    const sync = (): void => { setOpen(controller.getSnapshot().panelOpen) }
    sync()
    return controller.subscribe(sync)
  }, [])
  return open
}

/**
 * Launcher icon: the plugin's sparkle, lit while the studio is open.
 * @param props.size - square edge requested by the owning sidebar row.
 */
export function ImageGenPanelIcon(props: { size?: number }): React.JSX.Element {
  const open = useStudioOpen()
  return (
    <span className={css.panelIcon} data-dsh-imagegen-panel-icon data-active={open ? '' : undefined}>
      <Images size={props.size ?? 16} strokeWidth={1.9} aria-hidden="true" />
    </span>
  )
}

/**
 * Launcher body: renders nothing. Selecting the panel toggles the studio and
 * returns the center column to the Conversation, so the panel is never the
 * column's occupant for more than the frame that starts the handoff.
 */
export function ImageGenPanelEntry(): null {
  const handled = useRef(false)
  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const live = runtime
    if (live === undefined) return
    if (live.controller?.getSnapshot().panelOpen === true) live.controller.close()
    else live.controller?.open()
    live.selectConversation()
  }, [])
  return null
}

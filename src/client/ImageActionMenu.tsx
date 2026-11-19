/**
 * The one menu every generated image opens.
 *
 * Result cards used to grow a row of seven text buttons (and a "fullscreen
 * comparison" toggle nobody could explain). Those actions belong where a
 * desktop user already looks for them: right-click on the image. The same
 * menu is also reachable from the card's "…" button so touch and keyboard
 * users keep parity.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import css from './image-action-menu.module.css'

export interface ImageMenuAction {
  id: string
  label: string
  disabled?: boolean
  /** Closes the menu before running the action unless it returns a promise. */
  onSelect: () => void | Promise<void>
}

export type ImageMenuGroup = ImageMenuAction[]

/**
 * A fixed-position menu clamped to the viewport. Groups are separated by a
 * hairline so destructive-ish items (download) never sit next to preview.
 */
export function ImageActionMenu(props: {
  x: number
  y: number
  groups: ImageMenuGroup[]
  label: string
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: props.x, top: props.y })

  useLayoutEffect(() => {
    const element = menuRef.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8)),
    })
  }, [props.x, props.y])

  const close = useCallback(() => { props.onClose() }, [props.onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [close])

  // Keep the focus ring inside the menu: arrows move between enabled items.
  const move = (direction: 1 | -1): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? 0 : (current + direction + items.length) % items.length
    items[next]!.focus()
  }

  return createPortal(
    <div className={css.overlay} onMouseDown={close} onContextMenu={event => { event.preventDefault(); close() }}>
      <div
        ref={menuRef}
        className={css.menu}
        role="menu"
        aria-label={props.label}
        data-image-action-menu=""
        style={{ left: position.left, top: position.top }}
        onMouseDown={event => { event.stopPropagation() }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
          if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
        }}
      >
        {props.groups.filter(group => group.length > 0).map((group, groupIndex) => (
          <div key={groupIndex} className={css.group} role="group">
            {groupIndex > 0 ? <span className={css.separator} aria-hidden="true" /> : null}
            {group.map((action, index) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className={css.item}
                data-menu-action={action.id}
                disabled={action.disabled}
                autoFocus={groupIndex === 0 && index === 0}
                onClick={() => { close(); void action.onSelect() }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}

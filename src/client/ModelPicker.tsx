/**
 * Two-level image-model picker shared by the studio, e-commerce composer and
 * infinite canvas. The trigger shows the selected channel + model. Opening it
 * lists channels; hovering a channel reveals that channel's model list without
 * resizing or repositioning the popover.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageModelGroup } from './settings-scope.ts'
import css from './model-picker.module.css'

export interface ModelPickerValue {
  channelId: string
  model: string
}

/** Resolve a selection against the current groups, keeping the preferred channel when possible. */
export function resolveModelChoice(
  groups: ImageModelGroup[],
  value: Partial<ModelPickerValue> | undefined,
  preferredChannelId?: string,
): ModelPickerValue {
  const requestedModel = value?.model?.trim() ?? ''
  const group = groups.find(candidate => candidate.id === value?.channelId && candidate.models.includes(requestedModel))
    ?? groups.find(candidate => candidate.id === preferredChannelId && candidate.models.includes(requestedModel))
    ?? groups.find(candidate => candidate.models.includes(requestedModel))
    ?? groups.find(candidate => candidate.id === value?.channelId)
    ?? groups.find(candidate => candidate.id === preferredChannelId)
    ?? groups[0]
  return {
    channelId: group?.id ?? '',
    model: group?.models.includes(requestedModel) === true ? requestedModel : group?.models[0] ?? '',
  }
}

export function ModelPicker(props: {
  groups: ImageModelGroup[]
  value: ModelPickerValue
  channelLabel: string
  modelLabel: string
  emptyLabel: string
  channelPlaceholder: string
  ariaLabel: string
  variant?: 'panel' | 'composer' | 'toolbar'
  disabled?: boolean
  onChange: (value: ModelPickerValue) => void
}): React.JSX.Element {
  const resolved = resolveModelChoice(props.groups, props.value)
  const [open, setOpen] = useState(false)
  const [draftGroupId, setDraftGroupId] = useState(resolved.channelId)
  const [modelPaneOpen, setModelPaneOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const activeGroup = props.groups.find(group => group.id === resolved.channelId) ?? props.groups[0]
  const draftGroup = props.groups.find(group => group.id === draftGroupId) ?? activeGroup

  useEffect(() => {
    if (!open) {
      setDraftGroupId(resolved.channelId)
      setModelPaneOpen(false)
    }
  }, [open, resolved.channelId])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && (triggerRef.current?.contains(target) === true || menuRef.current?.contains(target) === true || flyoutRef.current?.contains(target) === true)) return
      setOpen(false)
    }
    const closeOnViewportChange = (): void => { setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnViewportChange, true)
    }
  }, [open])

  const toggle = (): void => {
    if (open) { setOpen(false); return }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect !== undefined && typeof window !== 'undefined') {
      const width = Math.min(Math.max(rect.width, 190), Math.max(220, window.innerWidth - 16))
      const maxMenuWidth = Math.min(350, Math.max(220, window.innerWidth - 16))
      const above = rect.bottom + 278 > window.innerHeight && rect.top > 278
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - maxMenuWidth - 8)),
        top: above ? rect.top - 6 : rect.bottom + 6,
        width,
        above,
      })
    }
    setDraftGroupId(resolved.channelId)
    setModelPaneOpen(false)
    setOpen(true)
  }

  const channelMenuWidth = position === null
    ? undefined
    : Math.min(Math.max(position.width, 190), Math.max(220, typeof window === 'undefined' ? position.width : window.innerWidth - 16))
  const modelMenuWidth = position === null
    ? 220
    : Math.min(230, Math.max(180, typeof window === 'undefined' ? 220 : window.innerWidth - 16))
  const flyoutLeft = position === null
    ? 0
    : position.left + (channelMenuWidth ?? 0) + 6 + modelMenuWidth <= (typeof window === 'undefined' ? position.left + 500 : window.innerWidth) - 8
      ? position.left + (channelMenuWidth ?? 0) + 6
      : Math.max(8, position.left - modelMenuWidth - 6)

  const menu = open && position !== null && typeof document !== 'undefined'
    ? createPortal(<>
      <div
        ref={menuRef}
        className={css.menu}
        style={{ left: position.left, top: position.top, width: channelMenuWidth, transform: position.above ? 'translateY(-100%)' : undefined }}
        role="menu"
        aria-label={props.ariaLabel}
      >
        <div className={`${css.pane} ${css.channelPane}`}>
          <span className={css.sectionLabel}>{props.channelLabel}</span>
          {props.groups.map(group => <button
            key={group.id || '__default__'}
            type="button"
            role="menuitemradio"
            aria-checked={group.id === draftGroup?.id}
            data-selected={group.id === draftGroup?.id ? '' : undefined}
            className={css.item}
            onPointerEnter={() => { setDraftGroupId(group.id); setModelPaneOpen(true) }}
            onFocus={() => { setDraftGroupId(group.id); setModelPaneOpen(true) }}
            onClick={() => { setDraftGroupId(group.id); setModelPaneOpen(true) }}
          >{group.name || props.channelPlaceholder}</button>)}
        </div>
      </div>
      {modelPaneOpen ? <div
        ref={flyoutRef}
        className={css.modelFlyout}
        style={{
          left: flyoutLeft,
          top: position.top,
          width: modelMenuWidth,
          transform: position.above ? 'translateY(-100%)' : undefined,
        }}
        role="menu"
        aria-label={`${props.ariaLabel}: ${props.modelLabel}`}
      >
        <span className={css.sectionLabel}>{props.modelLabel}</span>
        {(draftGroup?.models ?? []).map(model => <button
          key={model}
          type="button"
          role="menuitemradio"
          aria-checked={draftGroup?.id === resolved.channelId && model === resolved.model}
          data-selected={draftGroup?.id === resolved.channelId && model === resolved.model ? '' : undefined}
          className={css.item}
          onClick={() => {
            props.onChange({ channelId: draftGroup?.id ?? '', model })
            setOpen(false)
          }}
        >{model}</button>)}
        {(draftGroup?.models.length ?? 0) === 0 ? <span className={css.empty}>{props.emptyLabel}</span> : null}
      </div> : null}
    </>, document.body)
    : null

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={css.trigger}
      data-variant={props.variant ?? 'panel'}
      data-open={open ? '' : undefined}
      disabled={props.disabled === true || props.groups.length === 0}
      aria-label={`${props.ariaLabel}: ${activeGroup?.name ?? props.channelPlaceholder} / ${resolved.model || props.emptyLabel}`}
      aria-haspopup="menu"
      aria-expanded={open}
      title={`${activeGroup?.name ?? props.channelPlaceholder} · ${resolved.model || props.emptyLabel}`}
      onClick={toggle}
    >
      <span className={css.value}>
        <span className={css.channel}>{activeGroup?.name || props.channelPlaceholder}</span>
        <span className={css.divider} aria-hidden="true">/</span>
        <span className={css.model}>{resolved.model || props.emptyLabel}</span>
      </span>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5L4 6h8z" /></svg>
    </button>
    {menu}
  </>
}

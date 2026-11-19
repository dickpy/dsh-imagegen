import { useEffect, useState, type MouseEvent } from 'react'
import type { GeneratedImage, GenerateRequest, GenerationTask } from '../protocol.ts'
import type { ImageModelGroup } from './settings-scope.ts'
import type { StudioRun, StudioSlot } from './studio-state.ts'
import { ModelPicker, type ModelPickerValue } from './ModelPicker.tsx'
import { GenerationLoading } from './GenerationLoading.tsx'
import { GenerationDurationBadge } from './GenerationDurationBadge.tsx'
import { ImageActionMenu, type ImageMenuGroup } from './ImageActionMenu.tsx'
import { tt } from './helpers.ts'
import css from './studio-results.module.css'

export function ImageResultMeta({ image, model, channel }: { image: GeneratedImage; model?: string; channel?: string }): React.JSX.Element {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (image.width !== undefined) return
    let disposed = false
    const decoded = new Image()
    decoded.onload = () => { if (!disposed) setSize({ width: decoded.naturalWidth, height: decoded.naturalHeight }) }
    decoded.src = `data:${image.mime};base64,${image.b64}`
    return () => { disposed = true }
  }, [image.b64, image.mime, image.width])
  return <div className={css.meta} data-result-meta="">
    <span title={`${channel ?? image.channel ?? ''} / ${model ?? image.model ?? ''}`}>{[channel ?? image.channel, model ?? image.model].filter(Boolean).join(' / ')}</span>
    <span data-image-dimensions="">{(image.width ?? size?.width) ? `${image.width ?? size?.width} × ${image.height ?? size?.height}` : ''}</span>
  </div>
}

/** One clock for the whole board: pending cards count up without per-card timers. */
function useBoardClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(timer) }
  }, [active])
  return now
}

function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** Download the original bytes (never a re-encoded copy). */
function downloadImage(image: GeneratedImage, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = `data:${image.mime};base64,${image.b64}`
  anchor.download = `${name}.${extensionOf(image.mime)}`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * The generation board.
 *
 * It is deliberately quiet: one image per card, a single metadata line, and
 * the actions behind a right-click (or the "…" button). The previous version
 * printed seven buttons under every card and offered a fullscreen toggle that
 * duplicated the preview lightbox.
 */
export function StudioResults(props: {
  run: StudioRun
  tasks: GenerationTask[]
  groups: ImageModelGroup[]
  busy: boolean
  privacyMode?: boolean
  onRetry: (slot: StudioSlot) => void
  onAppend: (choice: ModelPickerValue) => void
  onPreview: (image: GeneratedImage) => void
  onCopy: (image: GeneratedImage) => void
  onGallery: (image: GeneratedImage, request?: GenerateRequest) => void
  onConversation: (image: GeneratedImage) => void
  onEdit?: (image: GeneratedImage, request?: GenerateRequest) => void
  onReverse: (image: GeneratedImage) => void
}): React.JSX.Element {
  const [appendOpen, setAppendOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; groups: ImageMenuGroup[] } | null>(null)
  const [choice, setChoice] = useState<ModelPickerValue>({ channelId: props.groups[0]?.id ?? '', model: props.groups[0]?.models[0] ?? '' })
  const byId = new Map(props.tasks.map(task => [task.id, task]))
  const pending = props.run.slots.some(slot => {
    const task = byId.get(slot.taskId)
    const status = task?.status ?? slot.status ?? 'queued'
    return status === 'queued' || status === 'running' || (status === 'completed' && task?.result?.images[slot.imageIndex] === undefined)
  })
  const now = useBoardClock(pending)

  const openMenuAt = (x: number, y: number, slot: StudioSlot, image: GeneratedImage, request?: GenerateRequest): void => {
    setMenu({ x, y, groups: menuGroups(props, slot, image, request) })
  }
  const openMenuFromEvent = (event: MouseEvent<HTMLElement>, slot: StudioSlot, image: GeneratedImage, request?: GenerateRequest): void => {
    event.preventDefault()
    event.stopPropagation()
    openMenuAt(event.clientX, event.clientY, slot, image, request)
  }

  return <section className={css.board} aria-label={tt('studio.results')} data-studio-mode={props.run.mode} data-studio-run={props.run.id} data-imagegen-private={props.privacyMode ? 'true' : undefined}>
    <header className={css.toolbar}>
      <div className={css.heading}>
        <strong>{tt('studio.results')}</strong>
        <span className={css.count}>{props.run.slots.length}</span>
      </div>
      <button type="button" className={css.appendToggle} aria-expanded={appendOpen} onClick={() => setAppendOpen(value => !value)}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
        {tt('studio.append')}
      </button>
    </header>
    {appendOpen && <div className={css.append}>
      <ModelPicker groups={props.groups} value={choice} onChange={setChoice} channelLabel={tt('model.channel')} modelLabel={tt('model.label')} emptyLabel={tt('model.noEditModels')} channelPlaceholder={tt('model.channelPlaceholder')} ariaLabel={tt('studio.appendModel')} />
      <button type="button" className={css.appendSubmit} disabled={props.busy || choice.model === ''} onClick={() => props.onAppend(choice)}>{tt('studio.appendGenerate')}</button>
      <span>{tt('studio.appendHint')}</span>
    </div>}
    <div className={css.grid} data-result-preview-grid="">
      {props.run.slots.map(slot => {
        const task = byId.get(slot.taskId)
        const status = task?.status ?? slot.status ?? 'queued'
        const image = task?.result?.images[slot.imageIndex]
        const previous = slot.previous === undefined ? undefined : byId.get(slot.previous.taskId)?.result?.images[slot.previous.imageIndex]
        const display = image ?? previous
        const waiting = status === 'queued' || status === 'running' || (status === 'completed' && image === undefined)
        const failed = !waiting && (status === 'failed' || status === 'cancelled')
        const channel = task?.request.channel ?? image?.channel ?? props.groups.find(group => group.id === slot.channelId)?.name
        const elapsed = task?.startedAt === undefined ? 0 : Math.max(0, Math.floor((now - task.startedAt) / 1000))
        return <figure key={slot.id} className={css.card} data-studio-slot={slot.id} data-comparison-task={slot.taskId} data-task-status={status} data-generation-state={waiting ? status : undefined}>
          <div className={css.media} data-empty={display === undefined ? '' : undefined} data-failed={failed ? '' : undefined}>
            {display !== undefined ? (
              <button
                type="button"
                className={css.imageButton}
                data-result-open=""
                title={tt('result.openHint')}
                onClick={() => props.onPreview(display)}
                onContextMenu={event => openMenuFromEvent(event, slot, display, task?.request)}
              >
                <img src={`data:${display.mime};base64,${display.b64}`} alt={slot.model} draggable={false} />
                <GenerationDurationBadge durationMs={display.durationMs} />
              </button>
            ) : null}
            {display !== undefined ? (
              <button
                type="button"
                className={css.moreButton}
                aria-label={tt('result.more')}
                title={tt('result.more')}
                data-result-menu=""
                onClick={event => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  openMenuAt(rect.right - 6, rect.bottom + 4, slot, display, task?.request)
                }}
              >
                <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3.4" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.6" r="1.3" /></svg>
              </button>
            ) : null}
            {waiting ? (
              <div className={css.pending}>
                <GenerationLoading
                  compact
                  title={tt(status === 'queued' ? 'canvas.queued' : 'canvas.generating')}
                  hint={tt('canvas.elapsed', { seconds: elapsed })}
                />
              </div>
            ) : null}
            {failed ? (
              <div className={css.error} role="status">
                <strong>{tt(`tasks.${status}`)}</strong>
                <span>{task?.error ?? slot.error}</span>
                <button type="button" className={css.retry} disabled={props.busy} onClick={() => props.onRetry(slot)}>{tt('tasks.retry')}</button>
              </div>
            ) : null}
          </div>
          {display !== undefined ? <ImageResultMeta image={display} model={slot.model} channel={channel} /> : <div className={css.meta}><span title={`${channel ?? ''} / ${slot.model}`}>{[channel, slot.model].filter(Boolean).join(' / ')}</span><span /></div>}
          {task?.result?.historyError && <p className={css.errorText} role="status">{task.result.historyError}</p>}
        </figure>
      })}
    </div>
    {menu !== null ? <ImageActionMenu x={menu.x} y={menu.y} groups={menu.groups} label={tt('result.more')} onClose={() => { setMenu(null) }} /> : null}
  </section>
}

/** Actions for one finished card, grouped the way the menu renders them. */
function menuGroups(props: {
  busy: boolean
  onRetry: (slot: StudioSlot) => void
  onPreview: (image: GeneratedImage) => void
  onCopy: (image: GeneratedImage) => void
  onGallery: (image: GeneratedImage, request?: GenerateRequest) => void
  onConversation: (image: GeneratedImage) => void
  onEdit?: (image: GeneratedImage, request?: GenerateRequest) => void
  onReverse: (image: GeneratedImage) => void
}, slot: StudioSlot, image: GeneratedImage, request: GenerateRequest | undefined): ImageMenuGroup[] {
  return [
    [
      { id: 'preview', label: tt('result.viewLarge'), onSelect: () => props.onPreview(image) },
      ...props.onEdit === undefined ? [] : [{ id: 'edit', label: tt('iteration.edit'), disabled: props.busy, onSelect: () => props.onEdit?.(image, request) }],
      { id: 'retry', label: tt('studio.regenerate'), disabled: props.busy, onSelect: () => props.onRetry(slot) },
    ],
    [
      { id: 'copy', label: tt('image.copy'), onSelect: () => props.onCopy(image) },
      { id: 'gallery', label: tt('gallery.add'), onSelect: () => props.onGallery(image, request) },
      { id: 'conversation', label: tt('conversation.add'), onSelect: () => props.onConversation(image) },
      { id: 'reverse', label: tt('prompt.reverse.action'), onSelect: () => props.onReverse(image) },
    ],
    [
      { id: 'download', label: tt('download'), onSelect: () => downloadImage(image, `dsh-image-${slot.id.replace(/:/g, '-')}`) },
    ],
  ]
}

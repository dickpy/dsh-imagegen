import { useEffect, useState, type MouseEvent } from 'react'
import type { GeneratedImage, GenerateRequest, GenerationTask } from '../protocol.ts'
import type { ImageModelGroup } from './settings-scope.ts'
import type { StudioRun, StudioSlot } from './studio-state.ts'
import { ModelPicker, type ModelPickerValue } from './ModelPicker.tsx'
import { StudioActionButton } from './StudioActionButton.tsx'
import { GenerationLoading } from './GenerationLoading.tsx'
import { GenerationDurationBadge } from './GenerationDurationBadge.tsx'
import { ImageActionMenu, type ImageMenuGroup } from './ImageActionMenu.tsx'
import { pictureAspect, planResultLayout } from './result-layout.ts'
import { useResultAspects, useSheetSize } from './result-measure.ts'
import { downloadImage } from './result-board.ts'
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

/**
 * The generation board.
 *
 * It is deliberately quiet: one image per card, a single metadata line, and
 * the actions behind a right-click (or the "…" button) plus a download button
 * in the picture's corner. The sheet itself is planned per board size so mixed
 * pixel shapes fill the panel instead of leaving letterbox bars (#97).
 */
export function StudioResults(props: {
  run: StudioRun
  tasks: GenerationTask[]
  groups: ImageModelGroup[]
  busy: boolean
  privacyMode?: boolean
  onRetry: (slot: StudioSlot) => void
  onAppend: (choice: ModelPickerValue) => void
  /** The whole finished set plus the clicked card, so the lightbox can page. */
  onPreview: (images: GeneratedImage[], index: number) => void
  onCopy: (image: GeneratedImage) => void
  onGallery: (image: GeneratedImage, request?: GenerateRequest) => void
  onConversation: (image: GeneratedImage) => void
  onEdit?: (image: GeneratedImage, request?: GenerateRequest) => void
  onReverse: (image: GeneratedImage) => void
  /** Extra toolbar control (the template library) rendered beside "add model". */
  toolbarAction?: React.ReactNode
}): React.JSX.Element {
  const [appendOpen, setAppendOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; groups: ImageMenuGroup[] } | null>(null)
  const [choice, setChoice] = useState<ModelPickerValue>({ channelId: props.groups[0]?.id ?? '', model: props.groups[0]?.models[0] ?? '' })
  const byId = new Map(props.tasks.map(task => [task.id, task]))
  const pending = props.run.slots.some(slot => {
    const task = byId.get(slot.taskId)
    const status = task?.status ?? slot.status ?? 'queued'
    // The board clock runs while an image can still arrive: active tasks, or a
    // completed task whose result has not been hydrated yet. A completed task
    // with a loaded result but no image at this index lost that parallel
    // request (partial fan-out) — it is rendered as a failed card below.
    return status === 'queued' || status === 'running' || (status === 'completed' && task?.result === undefined)
  })
  const now = useBoardClock(pending)

  const cards = props.run.slots.map(slot => {
    const task = byId.get(slot.taskId)
    const status = task?.status ?? slot.status ?? 'queued'
    const image = task?.result?.images[slot.imageIndex]
    const previous = slot.previous === undefined ? undefined : byId.get(slot.previous.taskId)?.result?.images[slot.previous.imageIndex]
    const display = image ?? previous
    const missing = status === 'completed' && task?.result !== undefined && image === undefined
    const waiting = status === 'queued' || status === 'running'
      || (status === 'completed' && image === undefined && task?.result === undefined)
    const failed = !waiting && (status === 'failed' || status === 'cancelled')
    const channel = task?.request.channel ?? image?.channel ?? props.groups.find(group => group.id === slot.channelId)?.name
    return { slot, task, status, display, waiting, failed, missing, channel }
  })

  /** Only finished pictures reach the lightbox, in board order. */
  const previewImages = cards.flatMap(card => card.display === undefined ? [] : [card.display])
  const previewIndexOf = (cardIndex: number): number => cards.slice(0, cardIndex).filter(card => card.display !== undefined).length

  const [attachSheet, sheetSize] = useSheetSize()
  // The key must name the picture, not just its slot: a retried slot keeps its id
  // but gets a new task, and a cached ratio from the old picture would size the
  // new one wrongly.
  const aspects = useResultAspects(cards.map(card => card.slot.id + ':' + card.slot.taskId), cards.map(card => card.display))
  const layout = planResultLayout({ count: cards.length, aspects, width: sheetSize.width })
  const rows = layout.rows

  const openMenuAt = (x: number, y: number, cardIndex: number): void => {
    const card = cards[cardIndex]
    if (card?.display === undefined) return
    const preview = { images: previewImages, index: previewIndexOf(cardIndex) }
    setMenu({ x, y, groups: menuGroups(props, card.slot, card.display, card.task?.request, preview) })
  }
  const openMenuFromEvent = (event: MouseEvent<HTMLElement>, cardIndex: number): void => {
    event.preventDefault()
    event.stopPropagation()
    openMenuAt(event.clientX, event.clientY, cardIndex)
  }

  const renderCard = (cardIndex: number, boxWidth: number | null): React.JSX.Element => {
    const { slot, task, status, display, waiting, failed, missing, channel } = cards[cardIndex]!
    const elapsed = task?.startedAt === undefined ? 0 : Math.max(0, Math.floor((now - task.startedAt) / 1000))
    // A measured card fixes its width and the picture area takes the payload's
    // own shape, so the row is exactly as tall as its tallest picture and the
    // border (which eats 2 px of the card's width) cannot leave a band under
    // it. The stylesheet keeps 16:9 for a size that has not arrived yet.
    const shape = boxWidth === null ? shapeOf(display) : { flex: 'none' as const, aspectRatio: String(pictureAspect(display) ?? 1) }
    return <figure key={slot.id} className={css.card} style={boxWidth === null ? undefined : { flex: 'none', width: boxWidth }} data-result-card="" data-studio-slot={slot.id} data-comparison-task={slot.taskId} data-task-status={status} data-generation-state={waiting ? status : undefined}>
      <div className={css.media} data-result-media="" style={shape} data-empty={display === undefined ? '' : undefined} data-failed={failed ? '' : undefined}>
        {display !== undefined ? (
          <button
            type="button"
            className={css.imageButton}
            data-result-open=""
            title={tt('result.openHint')}
            onClick={() => props.onPreview(previewImages, previewIndexOf(cardIndex))}
            onContextMenu={event => openMenuFromEvent(event, cardIndex)}
          >
            <img src={`data:${display.mime};base64,${display.b64}`} alt={slot.model} draggable={false} />
          </button>
        ) : null}
        {display !== undefined ? (
          // Download sits left of the duration badge, both in the corner: the
          // badge is metadata, the button is the one action worth a click.
          <div className={css.mediaCorner}>
            <button
              type="button"
              className={css.cardDownload}
              data-result-download=""
              aria-label={tt('download')}
              title={tt('download')}
              onClick={event => {
                event.stopPropagation()
                downloadImage(display, `dsh-image-${slot.id.replace(/:/g, '-')}`)
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v6.5" /><path d="M5.2 7.2 8 10l2.8-2.8" /><path d="M3.4 12.6h9.2" /></svg>
            </button>
            <GenerationDurationBadge durationMs={display.durationMs} />
          </div>
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
              openMenuAt(rect.right - 6, rect.bottom + 4, cardIndex)
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
        {!failed && display === undefined && missing ? (
          // Partial fan-out: the task completed but this slot's parallel
          // request failed. Same treatment as a failed card — the message
          // names what happened, and retry resubmits just this position.
          <div className={css.error} role="status">
            <strong>{tt('tasks.failed')}</strong>
            <span>{task?.result?.partialError ?? tt('result.missingImage')}</span>
            <button type="button" className={css.retry} disabled={props.busy} onClick={() => props.onRetry(slot)}>{tt('tasks.retry')}</button>
          </div>
        ) : null}
      </div>
      {display !== undefined ? <ImageResultMeta image={display} model={slot.model} channel={channel} /> : <div className={css.meta}><span title={`${channel ?? ''} / ${slot.model}`}>{[channel, slot.model].filter(Boolean).join(' / ')}</span><span /></div>}
      {task?.result?.historyError && <p className={css.errorText} role="status">{task.result.historyError}</p>}
    </figure>
  }

  return <section className={css.board} aria-label={tt('studio.results')} data-studio-mode={props.run.mode} data-studio-run={props.run.id} data-imagegen-private={props.privacyMode ? 'true' : undefined}>
    <header className={css.toolbar}>
      <div className={css.heading}>
        <strong>{tt('studio.results')}</strong>
        <span className={css.count}>{props.run.slots.length}</span>
      </div>
      <div className={css.toolbarActions}>
        {props.toolbarAction}
        <StudioActionButton icon={<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>} aria-expanded={appendOpen} onClick={() => setAppendOpen(value => !value)}>
          {tt('studio.append')}
        </StudioActionButton>
      </div>
    </header>
    {appendOpen && <div className={css.append}>
      <ModelPicker groups={props.groups} value={choice} onChange={setChoice} channelLabel={tt('model.channel')} modelLabel={tt('model.label')} emptyLabel={tt('model.noEditModels')} channelPlaceholder={tt('model.channelPlaceholder')} ariaLabel={tt('studio.appendModel')} />
      <button type="button" className={css.appendSubmit} disabled={props.busy || choice.model === ''} onClick={() => props.onAppend(choice)}>{tt('studio.appendGenerate')}</button>
      <span>{tt('studio.appendHint')}</span>
    </div>}
    <div
      ref={attachSheet}
      className={css.grid}
      data-count={cards.length <= 4 ? String(cards.length) : 'many'}
      data-result-preview-grid=""
      data-rows={rows.length}
    >
      {rows.map((row, rowIndex) => (
        <div className={css.row} key={`row-${rowIndex}`} data-result-row={rowIndex}>
          {row.map((cardIndex, columnIndex) => renderCard(cardIndex, layout.boxes[rowIndex]?.[columnIndex] ?? null))}
        </div>
      ))}
    </div>
    {menu !== null ? <ImageActionMenu x={menu.x} y={menu.y} groups={menu.groups} label={tt('result.more')} onClose={() => { setMenu(null) }} /> : null}
  </section>
}

/** Inline aspect ratio for a picture area, when the picture's size is known. */
function shapeOf(image: GeneratedImage | undefined): { aspectRatio: string } | undefined {
  const aspect = pictureAspect(image)
  return aspect === undefined ? undefined : { aspectRatio: String(aspect) }
}

/** Actions for one finished card, grouped the way the menu renders them. */
function menuGroups(props: {
  busy: boolean
  onRetry: (slot: StudioSlot) => void
  onPreview: (images: GeneratedImage[], index: number) => void
  onCopy: (image: GeneratedImage) => void
  onGallery: (image: GeneratedImage, request?: GenerateRequest) => void
  onConversation: (image: GeneratedImage) => void
  onEdit?: (image: GeneratedImage, request?: GenerateRequest) => void
  onReverse: (image: GeneratedImage) => void
}, slot: StudioSlot, image: GeneratedImage, request: GenerateRequest | undefined, preview: { images: GeneratedImage[]; index: number }): ImageMenuGroup[] {
  return [
    [
      { id: 'preview', label: tt('result.viewLarge'), onSelect: () => props.onPreview(preview.images, preview.index) },
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

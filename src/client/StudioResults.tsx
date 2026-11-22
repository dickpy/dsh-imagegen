import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { GeneratedImage, GenerateRequest, GenerationTask } from '../protocol.ts'
import type { ImageModelGroup } from './settings-scope.ts'
import type { StudioRun, StudioSlot } from './studio-state.ts'
import { ModelPicker, type ModelPickerValue } from './ModelPicker.tsx'
import { StudioActionButton } from './StudioActionButton.tsx'
import { GenerationLoading } from './GenerationLoading.tsx'
import { GenerationDurationBadge } from './GenerationDurationBadge.tsx'
import { ImageActionMenu, type ImageMenuGroup } from './ImageActionMenu.tsx'
import { planResultLayout, RESULT_CARD_CHROME, RESULT_LAYOUT_GAP } from './result-layout.ts'
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
 * Board size in CSS pixels. The packing depends on the space the panel actually
 * gives the sheet, so it is measured (and re-measured on resize) rather than
 * assumed. jsdom has no ResizeObserver, hence the guard.
 */
function useBoardSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize(current => current.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref])
  return size
}

/**
 * Aspect ratios for the board, in slot order.
 *
 * History records often arrive without decoded dimensions, and a packing built
 * on guessed squares would jump once the pictures land. Missing sizes are
 * measured once here (the bytes are already in memory) and the board re-plans
 * with the real shapes.
 */
function useResultAspects(keys: string[], images: (GeneratedImage | undefined)[]): number[] {
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const signature = keys.join('|')
  useEffect(() => {
    const missing = images
      .map((image, index) => ({ image, key: keys[index]! }))
      .filter((entry): entry is { image: GeneratedImage; key: string } => entry.image !== undefined
        && (entry.image.width === undefined || entry.image.height === undefined)
        && measured[entry.key] === undefined)
    if (missing.length === 0) return
    let disposed = false
    const found: Record<string, number> = {}
    let pending = missing.length
    const settle = (): void => {
      pending -= 1
      // Nothing measured (a corrupt payload) must not re-trigger this effect
      // forever: without new ratios there is nothing to publish.
      if (pending === 0 && !disposed && Object.keys(found).length > 0) setMeasured(current => ({ ...current, ...found }))
    }
    for (const { image, key } of missing) {
      const probe = new Image()
      probe.onload = () => {
        if (probe.naturalHeight > 0) found[key] = probe.naturalWidth / probe.naturalHeight
        settle()
      }
      probe.onerror = () => { settle() }
      probe.src = `data:${image.mime};base64,${image.b64}`
    }
    return () => { disposed = true }
    // `signature` covers the identities; the arrays themselves are rebuilt every render.
  }, [signature, measured])
  return images.map((image, index) => {
    if (image === undefined) return 1
    if (image.width !== undefined && image.height !== undefined && image.height > 0) return image.width / image.height
    return measured[keys[index]!] ?? 1
  })
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
  const boardRef = useRef<HTMLDivElement>(null)
  const byId = new Map(props.tasks.map(task => [task.id, task]))
  const pending = props.run.slots.some(slot => {
    const task = byId.get(slot.taskId)
    const status = task?.status ?? slot.status ?? 'queued'
    return status === 'queued' || status === 'running' || (status === 'completed' && task?.result?.images[slot.imageIndex] === undefined)
  })
  const now = useBoardClock(pending)

  const cards = props.run.slots.map(slot => {
    const task = byId.get(slot.taskId)
    const status = task?.status ?? slot.status ?? 'queued'
    const image = task?.result?.images[slot.imageIndex]
    const previous = slot.previous === undefined ? undefined : byId.get(slot.previous.taskId)?.result?.images[slot.previous.imageIndex]
    const display = image ?? previous
    const waiting = status === 'queued' || status === 'running' || (status === 'completed' && image === undefined)
    const failed = !waiting && (status === 'failed' || status === 'cancelled')
    const channel = task?.request.channel ?? image?.channel ?? props.groups.find(group => group.id === slot.channelId)?.name
    return { slot, task, status, display, waiting, failed, channel }
  })

  /** Only finished pictures reach the lightbox, in board order. */
  const previewImages = cards.flatMap(card => card.display === undefined ? [] : [card.display])
  const previewIndexOf = (cardIndex: number): number => cards.slice(0, cardIndex).filter(card => card.display !== undefined).length

  const aspectKeys = cards.map((card, index) => card.display === undefined
    ? `empty:${index}`
    : `${card.slot.id}|${card.display.width ?? 0}x${card.display.height ?? 0}|${card.display.b64.length}`)
  const aspects = useResultAspects(aspectKeys, cards.map(card => card.display))
  const boardSize = useBoardSize(boardRef)
  const layout = planResultLayout({ count: cards.length, aspects, width: boardSize.width, height: boardSize.height, gap: RESULT_LAYOUT_GAP, chrome: RESULT_CARD_CHROME })
  // The planner always covers every card; this keeps a stale plan from hiding one.
  const rows = layout.rows.flat().length === cards.length ? layout.rows : cards.map((_, index) => [index])

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

  const renderCard = (cardIndex: number, loneWidth: number | null, rowHeight: number | null): React.JSX.Element => {
    const { slot, task, status, display, waiting, failed, channel } = cards[cardIndex]!
    const elapsed = task?.startedAt === undefined ? 0 : Math.max(0, Math.floor((now - task.startedAt) / 1000))
    // A lone card hugs its picture; an evenly shaped row stops where the
    // pictures stop, so the empty space sits around the row, not inside cards.
    const cardStyle = {
      ...(loneWidth === null ? {} : { flex: '0 0 auto', width: `${loneWidth}px`, maxWidth: '100%' }),
      ...(rowHeight === null ? {} : { height: `${rowHeight}px` }),
    }
    return <figure key={slot.id} className={css.card} style={Object.keys(cardStyle).length === 0 ? undefined : cardStyle} data-studio-slot={slot.id} data-comparison-task={slot.taskId} data-task-status={status} data-generation-state={waiting ? status : undefined}>
      <div className={css.media} data-empty={display === undefined ? '' : undefined} data-failed={failed ? '' : undefined}>
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
      ref={boardRef}
      className={css.grid}
      data-count={cards.length <= 4 ? String(cards.length) : 'many'}
      data-result-preview-grid=""
      data-rows={rows.length}
      data-scroll={layout.scroll ? '' : undefined}
    >
      {rows.map((row, rowIndex) => {
        const loneWidth = layout.widths[rowIndex] ?? null
        const rowHeight = layout.heights[rowIndex] ?? null
        const rowStyle = loneWidth === null && rowHeight === null
          ? undefined
          : { ...(loneWidth === null ? {} : { justifyContent: 'center' }), ...(rowHeight === null ? {} : { alignItems: 'center' }) }
        return (
          <div className={css.row} key={`row-${rowIndex}`} data-result-row={rowIndex} style={rowStyle}>
            {row.map(cardIndex => renderCard(cardIndex, loneWidth, rowHeight))}
          </div>
        )
      })}
    </div>
    {menu !== null ? <ImageActionMenu x={menu.x} y={menu.y} groups={menu.groups} label={tt('result.more')} onClose={() => { setMenu(null) }} /> : null}
  </section>
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

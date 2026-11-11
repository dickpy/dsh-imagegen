import { useEffect, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { GeneratedImage, GenerateRequest, GenerationTask } from '../protocol.ts'
import type { ImageModelGroup } from './settings-scope.ts'
import type { StudioRun, StudioSlot } from './studio-state.ts'
import { ModelPicker, type ModelPickerValue } from './ModelPicker.tsx'
import { GenerationLoading } from './GenerationLoading.tsx'
import { GenerationDurationBadge } from './GenerationDurationBadge.tsx'
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
  onReverse: (image: GeneratedImage) => void
  onContextMenu: (event: MouseEvent<HTMLElement>, image: GeneratedImage) => void
}): React.JSX.Element {
  const [appendOpen, setAppendOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    if (!fullscreen) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [fullscreen])
  const [choice, setChoice] = useState<ModelPickerValue>({ channelId: props.groups[0]?.id ?? '', model: props.groups[0]?.models[0] ?? '' })
  const byId = new Map(props.tasks.map(task => [task.id, task]))
  const content = <section className={css.board} aria-label={tt('studio.results')} data-studio-mode={props.run.mode} data-studio-run={props.run.id} data-imagegen-private={props.privacyMode ? 'true' : undefined}>
    <header className={css.header}>
      <strong>{tt('studio.results')} <small>{props.run.slots.length}</small></strong>
      <div><button type="button" onClick={() => setAppendOpen(value => !value)}>{tt('studio.append')}</button>{fullscreen ? <button type="button" aria-label={tt('preview.close')} onClick={() => setFullscreen(false)}>×</button> : <button type="button" onClick={() => setFullscreen(true)}>{tt('compare.fullscreen')}</button>}</div>
    </header>
    {appendOpen && <div className={css.append}>
      <ModelPicker groups={props.groups} value={choice} onChange={setChoice} channelLabel={tt('model.channel')} modelLabel={tt('model.label')} emptyLabel={tt('model.noEditModels')} channelPlaceholder={tt('model.channelPlaceholder')} ariaLabel={tt('studio.appendModel')} />
      <button type="button" disabled={props.busy || choice.model === ''} onClick={() => props.onAppend(choice)}>{tt('studio.appendGenerate')}</button>
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
        const channel = task?.request.channel ?? image?.channel ?? props.groups.find(group => group.id === slot.channelId)?.name
        return <figure key={slot.id} className={css.card} data-studio-slot={slot.id} data-comparison-task={slot.taskId} data-task-status={status} data-generation-state={waiting ? status : undefined}>
          <div className={css.cardTitle}><span>{channel}</span><strong>{slot.model}</strong></div>
          <div className={css.imageArea}>
            {display && <button type="button" className={css.imageButton} data-result-open="" onClick={() => props.onPreview(display)}><img src={`data:${display.mime};base64,${display.b64}`} alt={slot.model} onContextMenu={event => props.onContextMenu(event, display)} /><GenerationDurationBadge durationMs={display.durationMs} /></button>}
            {waiting && <div className={css.pending}><GenerationLoading compact title={tt(status === 'queued' ? 'canvas.queued' : 'canvas.generating')} hint={task?.startedAt === undefined ? '' : tt('canvas.elapsed', { seconds: Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)) })} /></div>}
            {!waiting && (status === 'failed' || status === 'cancelled') && <div className={css.error} role="status"><strong>{tt(`tasks.${status}`)}</strong><span>{task?.error ?? slot.error}</span></div>}
          </div>
          {display && <ImageResultMeta image={display} model={slot.model} channel={channel} />}
          {task?.result?.historyError && <p className={css.error} role="status">{task.result.historyError}</p>}
          <div className={css.actions}>
            <button type="button" disabled={props.busy || waiting} onClick={() => props.onRetry(slot)}>{tt(status === 'failed' || status === 'cancelled' ? 'tasks.retry' : 'studio.regenerate')}</button>
            {display && <>
              <button type="button" data-copy-image="" onClick={() => props.onCopy(display)}>{tt('image.copy')}</button>
              <button type="button" onClick={() => props.onGallery(display, task?.request)}>{tt('gallery.add')}</button>
              <button type="button" onClick={() => props.onConversation(display)}>{tt('conversation.add')}</button>
              <button type="button" data-reverse-prompt="" onClick={() => props.onReverse(display)}>{tt('prompt.reverse.action')}</button>
              <a href={`data:${display.mime};base64,${display.b64}`} download={`dsh-image-${slot.id.replace(/:/g, '-')}.${display.mime === 'image/jpeg' ? 'jpg' : display.mime.split('/')[1] ?? 'png'}`}>{tt('download')}</a>
            </>}
          </div>
        </figure>
      })}
    </div>
  </section>
  return fullscreen ? createPortal(<div className={css.fullscreen} role="dialog" aria-modal="true" aria-label={tt('compare.title')} data-studio-fullscreen="">{content}</div>, document.body) : content
}

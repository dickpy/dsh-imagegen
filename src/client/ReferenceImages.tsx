/** Compact edit-reference thumbnails; the generation form owns the images. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, ChevronLeft, ChevronRight, ImagePlus, ClipboardPaste, ScanText } from 'lucide-react'
import { StudioActionButton } from './StudioActionButton.tsx'
import { Select } from './Select.tsx'
import { tt } from './helpers.ts'
import { clipboardImageFiles, EDIT_REFERENCE_LIMIT, type EditReference, type ReferencePasteResult } from './reference-images.ts'
import css from './reference-images.module.css'

export function ReferenceImages(props: {
  images: EditReference[]
  reading: boolean
  onAdd: (files: File[]) => void
  onPasteImages: (signal: AbortSignal) => Promise<ReferencePasteResult>
  onRemove: (id: string) => void
  onClear: () => void
  notice?: string | null
  reverse?: { selectedId: string; onSelect: (id: string) => void; onRun: (image: EditReference) => void }
}) {
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasteMessage, setPasteMessage] = useState<string | null>(null)
  const pasteController = useRef<AbortController | null>(null)
  useEffect(() => () => { pasteController.current?.abort() }, [])
  const addFiles = (files: File[]): void => { setPasteMessage(null); props.onAdd(files) }
  const clearReferences = (): void => {
    pasteController.current?.abort()
    setPasting(false)
    setPasteMessage(null)
    props.onClear()
  }
  const pasteImages = async (): Promise<void> => {
    pasteController.current?.abort()
    const controller = new AbortController()
    pasteController.current = controller
    setPasting(true)
    setPasteMessage(null)
    try {
      const result = await props.onPasteImages(controller.signal)
      if (!controller.signal.aborted && result === 'empty') setPasteMessage(tt('edit.pasteEmpty'))
    } catch {
      if (!controller.signal.aborted) setPasteMessage(tt('edit.pasteUnavailable'))
    } finally {
      if (!controller.signal.aborted) setPasting(false)
    }
  }
  const index = props.images.findIndex(image => image.id === previewId)
  const preview = props.images[index]
  const reverseImage = props.images.find(image => image.id === props.reverse?.selectedId) ?? props.images[0]
  const close = (): void => { setPreviewId(null) }
  const move = (delta: number): void => { const next = props.images[(index + delta + props.images.length) % props.images.length]; if (next) setPreviewId(next.id) }

  useEffect(() => {
    if (!preview) return
    dialog.current?.focus()
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (event.key === 'Escape') close()
        else move(event.key === 'ArrowLeft' ? -1 : 1)
      }
      if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => window.removeEventListener('keydown', keyboard, true)
  }, [previewId, props.images])
  const previewOpen = preview !== undefined
  useEffect(() => {
    if (!previewOpen) return
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus() }
  }, [previewOpen])

  return <>
    <section className={css.root} data-edit-references="" aria-label={tt('edit.references')} tabIndex={0}
      onDragEnter={event => { event.preventDefault(); event.stopPropagation() }}
      onDragLeave={event => { event.stopPropagation() }}
      onDragOver={event => { event.preventDefault(); event.stopPropagation() }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation()
        const files = Array.from(event.dataTransfer.files)
        // DSH tracks external file drags on document, but this card owns the
        // drop. Signal its window-level dragend cleanup without bubbling a
        // second drop (which would attach these files to the conversation).
        const view = event.currentTarget.ownerDocument.defaultView
        if (view) view.dispatchEvent(typeof view.DragEvent === 'function' ? new view.DragEvent('dragend') : new view.Event('dragend'))
        addFiles(files)
      }}
      onPaste={event => { const files = clipboardImageFiles(event.clipboardData); if (files.length > 0) { event.preventDefault(); event.stopPropagation(); addFiles(files) } }}>
      <header className={css.header}><strong>{tt('edit.references')}</strong><span className={css.count} aria-live="polite">{tt('edit.addedCount', { count: props.images.length })}</span><button type="button" data-paste-reference="" className={css.paste} disabled={pasting || props.reading || props.images.length >= EDIT_REFERENCE_LIMIT} onClick={() => { void pasteImages() }}><ClipboardPaste size={13} aria-hidden="true" />{tt(pasting ? 'edit.pasting' : 'edit.paste')}</button><button type="button" className={css.clear} disabled={props.images.length === 0 && !props.reading && !pasting} onClick={clearReferences}>{tt('edit.clearAll')}</button></header>
      {props.images.length === 0 ? <button type="button" className={css.empty} onClick={() => input.current?.click()}><ImagePlus size={22} aria-hidden="true" /><span>{tt('edit.uploadMultiple')}</span></button> : <div className={css.grid}>
        {props.images.map((image, index) => <div className={css.item} key={image.id} data-edit-reference="">
          <button type="button" className={css.thumbnail} aria-label={tt('edit.previewReference', { index: index + 1, name: image.name })} title={image.name} onClick={() => { previousFocus.current = document.activeElement as HTMLElement; setPreviewId(image.id) }}><img src={image.dataUrl} alt={image.name} /><span className={css.number}>{index + 1}</span></button>
          <button type="button" className={css.remove} aria-label={tt('edit.removeReference', { index: index + 1, name: image.name })} onClick={() => props.onRemove(image.id)}><X size={12} aria-hidden="true" /></button>
        </div>)}
        {props.images.length < EDIT_REFERENCE_LIMIT ? <button type="button" className={css.add} aria-label={tt('edit.addMore')} onClick={() => input.current?.click()}><Plus size={19} aria-hidden="true" /><span>{tt('edit.add')}</span></button> : null}
      </div>}
      {props.reverse ? <div className={css.tools} role="group" aria-label={tt('edit.reverseTools')}>
        {props.images.length > 1 ? <Select className={css.reverseTarget} value={reverseImage?.id ?? ''} aria-label={tt('edit.reverseTarget')} disabled={props.reading} onChange={props.reverse.onSelect}>
          {props.images.map((image, index) => <option key={image.id} value={image.id}>{index + 1} · {image.name}</option>)}
        </Select> : null}
        <StudioActionButton icon={<ScanText />} data-reference-reverse="" disabled={props.reading || reverseImage === undefined} title={tt(reverseImage === undefined ? 'edit.reverseEmpty' : 'edit.reverseHint')} onClick={() => { if (reverseImage) props.reverse?.onRun(reverseImage) }}>{tt('prompt.reverse.action')}</StudioActionButton>
      </div> : null}
      <p className={css.hint} role={props.reading ? 'status' : undefined}>{props.reading ? tt('edit.reading') : tt('edit.multiHint')}</p>
      <p className={css.limits}>{tt('edit.limits', { count: EDIT_REFERENCE_LIMIT })}</p>
      {props.notice ? <p className={css.notice} role="status">{props.notice}</p> : null}
      {pasteMessage ? <p className={css.notice} role="status">{pasteMessage}</p> : null}
      <input ref={input} className={css.file} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label={tt('edit.uploadMultiple')} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    </section>
    {preview ? createPortal(<div className={css.overlay} data-edit-reference-preview="" onClick={close} onKeyDown={event => event.stopPropagation()}>
      <section ref={dialog} className={css.preview} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tt('edit.referencePreview')} onClick={event => event.stopPropagation()}>
        <header className={css.previewHeader}><span>{index + 1} / {props.images.length} · {preview.name}</span><button type="button" className={css.close} aria-label={tt('preview.close')} onClick={close}><X size={19} /></button></header>
        <img className={css.previewImage} src={preview.dataUrl} alt={preview.name} />
        {props.images.length > 1 ? <footer className={css.previewFooter}><button type="button" className={css.close} aria-label={tt('edit.previousReference')} onClick={() => move(-1)}><ChevronLeft size={20} /></button><span>{index + 1} / {props.images.length}</span><button type="button" className={css.close} aria-label={tt('edit.nextReference')} onClick={() => move(1)}><ChevronRight size={20} /></button></footer> : null}
      </section>
    </div>, document.body) : null}
  </>
}

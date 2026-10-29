import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasAssetRef, CanvasSkillCatalog, CanvasSkillTask } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import { PptProgressCard } from './PptProgressCard.tsx'
import { PptDeckPreview } from './PptDeckPreview.tsx'
import { PptSetup, PPT_SKILL_NAME } from './PptSetup.tsx'
import css from './ppt-workspace.module.css'

export interface PptImport { id: number; file: File }
const running = (task: CanvasSkillTask): boolean => task.status === 'queued' || task.status === 'running'

function PptDialog({ title, close, children, privacyMode }: { title: string; close: () => void; children: ReactNode; privacyMode?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])
        const first = focusable[0], last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    root.current?.addEventListener('keydown', onKey)
    const element = root.current
    return () => { element?.removeEventListener('keydown', onKey); previous?.focus() }
  }, [])
  return createPortal(<div className={css.overlay} data-imagegen-private={privacyMode ? 'true' : undefined} onClick={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={root} className={css.dialog} role="dialog" aria-modal="true" aria-label={title}>
      <header><h3>{title}</h3><button type="button" aria-label={tt('ppt.close')} onClick={close}>×</button></header>
      <div className={css.dialogBody}>{children}</div>
    </div>
  </div>, document.body)
}

export function PptWorkspace({ api, active, importRequest, onImported, privacyMode }: { api: ImageGenApi; active: boolean; importRequest?: PptImport; onImported: () => void; privacyMode?: boolean }) {
  useImageGenLanguageTick()
  const [images, setImages] = useState<CanvasAssetRef[]>([])
  const current = useRef(images)
  const [tasks, setTasks] = useState<CanvasSkillTask[]>([])
  const [catalog, setCatalog] = useState<CanvasSkillCatalog>()
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [offline, setOffline] = useState(true)
  const ocrChosen = useRef(false)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<CanvasAssetRef>()
  const [pptPreview, setPptPreview] = useState<CanvasAssetRef>()
  const [diagnostic, setDiagnostic] = useState<CanvasSkillTask>()
  useEffect(() => { if (!active) { setSettingsOpen(false); setSourcePreview(undefined); setPptPreview(undefined); setDiagnostic(undefined) } }, [active])
  const [selected, setSelected] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadQueue = useRef(Promise.resolve())
  const uploadingCount = useRef(0)
  const mounted = useRef(true)
  const consumed = useRef<number>()
  const [clock, setClock] = useState(Date.now())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const commit = (next: CanvasAssetRef[]): void => { current.current = next; setImages(next) }
  const accept = (files: File[]): void => {
    if (files.length === 0) return
    uploadingCount.current += 1; setUploading(true); setError('')
    uploadQueue.current = uploadQueue.current.then(async () => {
      for (const file of files) {
        if (!mounted.current) return
        if (current.current.length >= 12) { setError(tt('ppt.inputLimit')); break }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 20 * 1024 * 1024) {
          setError(tt('ppt.invalidImage')); continue
        }
        try {
          const asset = await api.canvasFileUpload(file)
          if (mounted.current) commit([...current.current, asset])
        } catch (error) { if (mounted.current) setError(errorMessage(error)) }
      }
    }).finally(() => {
      uploadingCount.current -= 1
      if (mounted.current) setUploading(uploadingCount.current > 0)
    })
  }
  useEffect(() => {
    if (importRequest === undefined || consumed.current === importRequest.id) return
    consumed.current = importRequest.id
    accept([importRequest.file]); onImported()
  }, [importRequest])
  useEffect(() => {
    if (!active) return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [nextTasks, nextCatalog] = await Promise.all([api.pptTasks(), api.canvasSkillsList()])
        if (alive) { setTasks(nextTasks); setCatalog(nextCatalog); setClock(Date.now()) }
      } catch (error) { if (alive) setError(errorMessage(error)) }
    }
    void api.canvasSkillLibrary().then(library => {
      const token = library.entries.find(entry => entry.name === PPT_SKILL_NAME)?.config?.values.find(field => field.id === 'paddle-ocr-token')
      if (alive && !ocrChosen.current && token?.set) setOffline(false)
    }).catch(() => { /* The catalog reports any setup problem. */ })
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [active, api])
  const ready = catalog?.agentAvailable && catalog.installed.includes(PPT_SKILL_NAME)
  const focused = tasks.find(task => task.id === selected) ?? tasks[0]
  const submit = async (source = current.current): Promise<void> => {
    if (busy || uploading || source.length === 0) return
    setBusy(true); setError('')
    try {
      const task = await api.pptRun({ images: source, offlineOcr: offline })
      setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)])
      setSelected(task.id)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  return <div className={css.workspace} hidden={!active} data-ppt-workspace="">
    <header className={css.intro}><div><span className={css.eyebrow}>IMAGE → PPTX</span><h2>{tt('ppt.title')}</h2><p>{tt('ppt.description')}</p></div><button type="button" data-ppt-open-settings="" onClick={() => setSettingsOpen(true)}>{tt('ppt.openSettings')}</button></header>
    <aside className={css.sidebar}>
      <section className={css.sourceSection} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) accept(Array.from(event.dataTransfer.files)) }}>
        <div className={css.sourceHeading}><strong>{tt('ppt.sources')}</strong><span>{images.length}/12</span></div>
        {images.length === 0 ? <button type="button" className={css.upload} data-ppt-upload-empty="" disabled={uploading || busy} onClick={() => fileInput.current?.click()}>
          <span aria-hidden="true">＋</span><strong>{tt(uploading ? 'ppt.uploading' : 'ppt.upload')}</strong><small>{tt('ppt.uploadHint')}</small>
        </button> : <ol className={css.inputs}>
          {images.map((image, index) => <li key={`${image.assetId}-${index}`} data-ppt-input="">
            <button type="button" className={css.thumbnail} title={tt('ppt.previewSource')} onClick={() => setSourcePreview(image)}><img src={image.url} alt={image.name || `Slide ${index + 1}`} /></button>
            <span className={css.slideNumber}>{index + 1}</span><span className={css.inputName} title={image.name}>{image.name}</span>
            <div className={css.inputActions}>
              <button type="button" disabled={busy || uploading || index === 0} aria-label={tt('ppt.moveUp')} onClick={() => { const next = [...current.current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; commit(next) }}>←</button>
              <button type="button" disabled={busy || uploading || index === images.length - 1} aria-label={tt('ppt.moveDown')} onClick={() => { const next = [...current.current]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; commit(next) }}>→</button>
              <button type="button" disabled={busy || uploading} aria-label={tt('edit.remove')} onClick={() => commit(current.current.filter((_, at) => at !== index))}>×</button>
            </div>
          </li>)}
          {images.length < 12 ? <li className={css.addTile}><button type="button" data-ppt-add="" disabled={busy || uploading} aria-label={tt('ppt.addImages')} onClick={() => fileInput.current?.click()}><span>＋</span><small>{tt(uploading ? 'ppt.uploading' : 'ppt.addImages')}</small></button></li> : null}
        </ol>}
        <small className={css.sourceHint}>{tt('ppt.orderHint')}</small>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => { accept(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      </section>
      <section className={css.options}>
      <fieldset className={css.ocr} disabled={busy}>
        <legend>{tt('ppt.ocrTitle')}</legend>
        <label><input type="radio" name="ppt-ocr" checked={!offline} onChange={() => { ocrChosen.current = true; setOffline(false) }} />{tt('ppt.ocrPaddle')}</label>
        <label><input type="radio" name="ppt-ocr" checked={offline} onChange={() => { ocrChosen.current = true; setOffline(true) }} />{tt('ppt.ocrOffline')}</label>
        <small>{tt('ppt.ocrHint')}</small>
      </fieldset>

      {!ready ? <p className={css.note}>{catalog?.reason || tt('ppt.setupRequired')}</p> : null}
      <footer className={css.submitBar}>
        <button type="button" className={css.primary} data-ppt-convert="" disabled={!ready || busy || uploading || images.length === 0} onClick={() => { void submit() }}>{tt(busy ? 'ppt.submitting' : 'ppt.convert')}</button>
        <small>{tt('ppt.processingHint')}</small>
      </footer>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      </section>
    </aside>
    <main className={css.results}>
      <header className={css.resultHeader}><h3>{tt('ppt.results')}</h3><span>{tt('ppt.resultCount', { count: tasks.length })}</span></header>
      {tasks.length === 0 ? <div className={css.empty}><span className={css.fileIcon}>PPTX</span><h3>{tt('ppt.empty')}</h3><p>{tt('ppt.emptyHint')}</p></div> : <>
        <label className={css.taskPicker}><span>{tt('ppt.history')}</span><select aria-label={tt('ppt.history')} value={focused?.id ?? ''} onChange={event => setSelected(event.target.value)}>{tasks.map(task => <option key={task.id} value={task.id}>{new Date(task.startedAt).toLocaleString()} · {tt(`tasks.${task.status}` as never)}</option>)}</select></label>
        {focused ? <section className={css.result} data-ppt-task={focused.id} data-task-status={focused.status}>
          <div className={css.resultHeader} hidden={focused.status === 'completed'}><h3>{tt(`tasks.${focused.status}` as never)}</h3>
            {running(focused) ? <button type="button" onClick={() => { void api.canvasSkillCancel(focused.id).then(async () => setTasks(await api.pptTasks())).catch(error => setError(errorMessage(error))) }}>{tt('ppt.cancel')}</button> : null}
          </div>
          <p hidden={focused.status === 'completed'} className={focused.status === 'failed' ? css.failure : css.progress} role="status">{running(focused) ? `${focused.stage || tt('ppt.working')} · ${tt('canvas.elapsed', { seconds: Math.max(0, Math.floor((clock - focused.startedAt) / 1000)) })}` : focused.error || focused.stage}</p>
          <PptProgressCard key={focused.id} task={focused} clock={clock} onDiagnostic={() => setDiagnostic(focused)} />
          <div className={css.resultActions} data-completed={focused.status === 'completed' || undefined}>
            <button type="button" disabled={busy || uploading} onClick={() => { commit(focused.pptImages ?? []); setError('') }}>{tt('ppt.reuseImages')}</button>
            {focused.status === 'failed' || focused.status === 'cancelled' ? <button type="button" disabled={!ready || busy || uploading || !focused.pptImages?.length} onClick={() => { commit(focused.pptImages ?? []); void submit(focused.pptImages) }}>{tt('ppt.retry')}</button> : null}
            {focused.status === 'failed' ? <><button type="button" onClick={() => setSettingsOpen(true)}>{tt('ppt.checkSetup')}</button></> : null}
          </div>
          {focused.persistenceError ? <p className={css.persistenceWarning} role="status">{tt('ppt.persistenceWarning', { error: focused.persistenceError })}</p> : null}
          {focused.output?.warnings.map((warning, index) => <p key={index} className={css.note}>{warning}</p>)}
          <div className={css.outputs}>{focused.output?.nodes.map(node => {
            const asset = node.metadata?.asset
            if (!asset || !asset.name?.toLowerCase().endsWith('.pptx')) return null
            return <PptDeckPreview key={`${focused.id}-${asset.assetId}`} api={api} asset={asset} onExpand={() => setPptPreview(asset)} />
          })}</div>
        </section> : null}
      </>}
    </main>
    {settingsOpen ? <PptDialog title={tt('ppt.settingsTitle')} privacyMode={privacyMode} close={() => setSettingsOpen(false)}><PptSetup /></PptDialog> : null}
    {diagnostic ? <PptDialog title={tt('ppt.diagnostic')} privacyMode={privacyMode} close={() => setDiagnostic(undefined)}>
      <p className={css.diagnosticHint}>{tt(diagnostic.agentSessionId ? 'ppt.diagnosticHint' : 'ppt.legacyDiagnostic')}</p>
      <textarea className={css.diagnosticText} readOnly rows={14} aria-label={tt('ppt.diagnostic')} onFocus={event => event.currentTarget.select()} value={JSON.stringify({ taskId: diagnostic.id, status: diagnostic.status, startedAt: new Date(diagnostic.startedAt).toISOString(), finishedAt: diagnostic.finishedAt ? new Date(diagnostic.finishedAt).toISOString() : undefined, agentSessionId: diagnostic.agentSessionId, runDirectory: diagnostic.runDirectory, error: diagnostic.error, persistenceError: diagnostic.persistenceError, stage: diagnostic.stage, phase: diagnostic.phase, progress: diagnostic.progress, inputCount: diagnostic.pptImages?.length }, null, 2)} />
    </PptDialog> : null}
    {pptPreview ? <PptDialog title={pptPreview.name || 'PPTX'} privacyMode={privacyMode} close={() => setPptPreview(undefined)}><PptDeckPreview key={pptPreview.assetId} api={api} asset={pptPreview} /></PptDialog> : null}
    {sourcePreview ? <PptDialog title={sourcePreview.name || tt('ppt.previewSource')} privacyMode={privacyMode} close={() => setSourcePreview(undefined)}><img className={css.sourcePreview} src={sourcePreview.url} alt={sourcePreview.name || ''} /></PptDialog> : null}
  </div>
}

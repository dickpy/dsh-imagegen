/**
 * The AI 生图 studio: a three-column layout — left, a card-grouped
 * configuration sidebar (mode tabs, prompt with counter, rounded parameter
 * selectors, model dropdown + generate button); center, the result canvas;
 * right, a persistent generation history column.
 *
 * Controls ride the system UI primitives (@deepseek-ai/dsh-client-ui-primitives,
 * a platform module) so the studio matches the dsh shell look by construction.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import type { GeneratedImage, GenerateMode, GenerateRequest, HistoryEntry, HistoryImageRef, UpdateInfo } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import css from './panel.module.css'

/** The model dropdown offers exactly the plugin's namesake model. */
const MODELS = ['gpt-image-2'] as const

/** All size options for gpt-image-2. */
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '512x512', '1792x1024', '1024x1792'] as const

/** Size option keys in the locale dictionary. */
const SIZE_KEYS: Record<string, 'size.auto' | 'size.square' | 'size.landscape' | 'size.portrait' | 'size.small' | 'size.wide' | 'size.tall'> = {
  auto: 'size.auto',
  '1024x1024': 'size.square',
  '1536x1024': 'size.landscape',
  '1024x1536': 'size.portrait',
  '512x512': 'size.small',
  '1792x1024': 'size.wide',
  '1024x1792': 'size.tall',
}

/** Quality options. */
const QUALITIES = ['auto', 'low', 'medium', 'high'] as const

/** Detail options ('' = omit the passthrough). */
const DETAILS = ['', 'standard', 'high'] as const

const PROMPT_MAX = 2000
const REF_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const PREVIEW_SCALE_MIN = 0.5
const PREVIEW_SCALE_MAX = 3
const PREVIEW_SCALE_STEP = 0.25

function clampPreviewScale(scale: number): number {
  return Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, scale))
}

/** Read the current config from the settings scope snapshot. */
function useConfig(scope: ImageGenScope): ImageGenConfig | undefined {
  const [value, setValue] = useState(scope.getSnapshot().value)
  useEffect(() => scope.subscribe(() => { setValue(scope.getSnapshot().value) }), [scope])
  return value
}

/** Track the redacted api-key presence bit exposed by the settings bridge. */
function useKeySet(scope: ImageGenScope): boolean {
  const [keySet, setKeySet] = useState(scope.getKeySetSnapshot())
  useEffect(() => scope.subscribeKeySet(() => { setKeySet(scope.getKeySetSnapshot()) }), [scope])
  return keySet
}

/** Tick a seconds counter while `running`. */
function useElapsed(running: boolean, startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running || startedAt === null) return
    const timer = window.setInterval(() => {
      setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  return elapsed
}

/** Data URL for a generated image. */
function srcOf(image: GeneratedImage): string {
  return `data:${image.mime};base64,${image.b64}`
}

/** Fetch persisted history image refs and decode them back to in-memory
 *  GeneratedImage[] (base64), so the canvas/preview can reuse the same
 *  rendering path as a fresh generation. */
async function historyImagesToGenerated(refs: HistoryImageRef[]): Promise<GeneratedImage[]> {
  return Promise.all(refs.map(async ref => {
    const response = await fetch(ref.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(new Error('image read failed'))
      reader.readAsDataURL(blob)
    })
    const comma = dataUrl.indexOf(',')
    return {
      b64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
      mime: ref.mime,
      ...ref.revisedPrompt === undefined ? {} : { revisedPrompt: ref.revisedPrompt },
    }
  }))
}

/** Compact, locale-independent timestamp for history entries. */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Render the studio. */
export function ImageGenPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
}) {
  const { api, scope } = props
  const config = useConfig(scope)
  const enabled = config?.enabled ?? true
  const apiUrl = config?.apiUrl ?? ''
  const configured = apiUrl.trim() !== ''
  const keySet = useKeySet(scope)
  const connected = enabled && configured && keySet

  const [mode, setMode] = useState<GenerateMode>('text')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>('auto')
  const [quality, setQuality] = useState<string>('auto')
  const [count, setCount] = useState(1)
  const [detail, setDetail] = useState('')
  const [model, setModel] = useState<string>(MODELS[0])
  const [refImage, setRefImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ images: GeneratedImage[]; index: number } | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [promptCopied, setPromptCopied] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<'success' | 'failed' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const elapsed = useElapsed(generating, startedAt)

  // Load the host-persisted history once on mount (it lives in ~/.dsh on the
  // DSH host, so every browser/device sees the same list).
  useEffect(() => {
    let disposed = false
    api.historyList()
      .then(entries => { if (!disposed) setHistory(entries) })
      .catch(() => { /* history unavailable — leave the list empty */ })
    return () => { disposed = true }
  }, [api])

  // Release checks are host-mediated and intentionally best-effort: a GitHub
  // outage must never make the image-generation studio unavailable.
  useEffect(() => {
    let disposed = false
    api.updateCheck()
      .then(info => {
        if (!disposed && info.updateAvailable) setUpdate(info)
      })
      .catch(() => { /* update discovery is optional */ })
    return () => { disposed = true }
  }, [api])

  const applyUpdate = async (): Promise<void> => {
    if (update === null || updating) return
    setUpdating(true)
    setUpdateMessage(null)
    setUpdateResult(null)
    try {
      const result = await api.updateApply(update.latestVersion)
      setUpdateMessage(tt('update.success', { version: result.updatedVersion }))
      setUpdateResult('success')
    } catch {
      setUpdateMessage(tt('update.failed'))
      setUpdateResult('failed')
    } finally {
      setUpdating(false)
    }
  }

  /** Read an uploaded reference image into a data URL. */
  const acceptFile = (file: File | undefined): void => {
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      setError(tt('edit.uploadHint'))
      return
    }
    if (file.size > REF_IMAGE_MAX_BYTES) {
      setError(tt('edit.uploadHint'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setRefImage({ dataUrl: reader.result, name: file.name })
    }
    reader.onerror = () => { setError(tt('edit.uploadHint')) }
    reader.readAsDataURL(file)
  }

  /** Run one generation. */
  const handleGenerate = async (): Promise<void> => {
    if (generating) return
    const promptText = prompt.trim()
    if (promptText === '') {
      setError(tt('prompt.required'))
      return
    }
    if (mode === 'edit' && refImage === null) {
      setError(tt('edit.required'))
      return
    }
    const request: GenerateRequest = {
      mode,
      model,
      prompt: promptText,
      size,
      quality,
      n: count,
      detail,
      ...mode === 'edit' && refImage !== null ? { image: refImage.dataUrl } : {},
      ...mode === 'edit' && refImage !== null ? { refName: refImage.name } : {},
    }
    setGenerating(true)
    setError(null)
    setImages([])
    setStartedAt(Date.now())
    try {
      const result = await api.generate(request)
      setImages(result.images)
      setViewingHistoryId(null)
      if (result.history !== undefined) setHistory(result.history)
      if (result.historyError !== undefined) setError(result.historyError)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setGenerating(false)
      setStartedAt(null)
    }
  }

  /** Open the full-screen image preview at a given index. */
  const openPreview = (previewImages: GeneratedImage[], index: number): void => {
    setPreview({ images: previewImages, index })
    setPreviewScale(1)
    setPromptCopied(false)
  }

  const closePreview = (): void => {
    setPreview(null)
    setPreviewScale(1)
    setPromptCopied(false)
  }

  /** Step the preview by ±1, wrapping around. */
  const stepPreview = (delta: number): void => {
    setPreviewScale(1)
    setPromptCopied(false)
    setPreview(current => {
      if (current === null) return null
      const total = current.images.length
      return { images: current.images, index: (current.index + delta + total) % total }
    })
  }

  // Keyboard navigation for the preview overlay.
  useEffect(() => {
    if (preview === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
      else if (event.key === 'ArrowLeft') stepPreview(-1)
      else if (event.key === 'ArrowRight') stepPreview(1)
      else if (event.key === '+' || event.key === '=') setPreviewScale(current => clampPreviewScale(current + PREVIEW_SCALE_STEP))
      else if (event.key === '-') setPreviewScale(current => clampPreviewScale(current - PREVIEW_SCALE_STEP))
      else if (event.key === '0') setPreviewScale(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  /** Load a past generation's images into the canvas. */
  const viewHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      setImages(await historyImagesToGenerated(entry.images))
      setError(null)
      setViewingHistoryId(entry.id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Restore a past generation's parameters (and its images) into the form. */
  const restoreHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const restored = await historyImagesToGenerated(entry.images)
      setMode(entry.mode)
      setPrompt(entry.prompt)
      setSize((SIZES as readonly string[]).includes(entry.size) ? entry.size : 'auto')
      setQuality((QUALITIES as readonly string[]).includes(entry.quality) ? entry.quality : 'auto')
      setDetail((DETAILS as readonly string[]).includes(entry.detail) ? entry.detail : '')
      setCount(entry.n >= 1 && entry.n <= 4 ? entry.n : 1)
      setModel((MODELS as readonly string[]).includes(entry.model) ? entry.model : MODELS[0])
      setRefImage(null)
      setImages(restored)
      setError(null)
      setViewingHistoryId(entry.id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove one history entry. */
  const deleteHistoryEntry = async (id: string): Promise<void> => {
    setHistory(history.filter(entry => entry.id !== id))
    if (viewingHistoryId === id) setViewingHistoryId(null)
    try {
      setHistory(await api.historyRemove(id))
    } catch {
      // Keep the optimistic local removal.
    }
  }

  /** Remove all history entries. */
  const clearHistory = async (): Promise<void> => {
    setHistory([])
    setViewingHistoryId(null)
    try {
      setHistory(await api.historyClear())
    } catch {
      // Keep the cleared local state.
    }
  }

  const generateDisabled = generating || !enabled || !configured
  const viewingEntry = viewingHistoryId === null ? null : history.find(entry => entry.id === viewingHistoryId) ?? null
  const previewImage = preview === null ? null : preview.images[preview.index] ?? null

  const copyPreviewPrompt = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('copy failed')
      }
      setPromptCopied(true)
      window.setTimeout(() => { setPromptCopied(false) }, 1800)
    } catch {
      setPromptCopied(false)
    }
  }

  const addPreviewToEdit = (): void => {
    if (previewImage === null || preview === null) return
    setMode('edit')
    setRefImage({
      dataUrl: srcOf(previewImage),
      name: `dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`,
    })
    if (prompt.trim() === '' && previewImage.revisedPrompt !== undefined) setPrompt(previewImage.revisedPrompt)
    setError(null)
    closePreview()
  }

  return (
    <div className={css.panel}>
      <header className={css.panelHeader}>
        <span className={css.panelHeading}>
          <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
          <span className={css.panelSubtitle}>{tt('panel.subtitle')}</span>
        </span>
        <button
          type="button"
          className={css.connectionStatus}
          data-connected={connected ? 'true' : 'false'}
          aria-label={tt(connected ? 'connection.connected' : 'connection.disconnected')}
        >
          <span className={css.connectionDot} aria-hidden="true" />
          {tt(connected ? 'connection.connected' : 'connection.disconnected')}
        </button>
      </header>

      {update !== null ? (
        <div className={css.updateBanner} data-kind={updateResult === 'success' ? 'ok' : 'warn'}>
          <span className={css.updateText}>
            {updateMessage ?? tt('update.available', { version: update.latestVersion })}
          </span>
          <span className={css.updateActions}>
            <a className={css.updateRelease} href={update.releaseUrl} target="_blank" rel="noreferrer">{tt('update.release')}</a>
            <Button variant="primary" size="sm" disabled={updating || updateMessage !== null} onClick={() => { void applyUpdate() }}>
              {updating ? tt('update.installing') : tt('update.install')}
            </Button>
          </span>
        </div>
      ) : null}

      <div className={css.studio}>
        {/* ---------------------------------------------------- config sidebar */}
        <aside className={css.config}>
          <div className={css.configScroll}>
            {/* mode tabs */}
            <section className={css.card}>
              <div className={css.modeRow} role="tablist" aria-label={tt('panel.title')}>
                <Pill
                  active={mode === 'text'}
                  onClick={() => { setMode('text') }}
                  className={css.modePill}
                >
                  {tt('mode.text')}
                </Pill>
                <Pill
                  active={mode === 'edit'}
                  onClick={() => { setMode('edit') }}
                  className={css.modePill}
                >
                  {tt('mode.edit')}
                </Pill>
              </div>
            </section>

            {/* reference image (edit mode) */}
            {mode === 'edit' ? (
              <section className={css.card}>
                {refImage === null
                  ? (
                    <button
                      type="button"
                      className={css.uploadBox}
                      onClick={() => { fileInput.current?.click() }}
                      onDragOver={(event) => { event.preventDefault() }}
                      onDrop={(event) => {
                        event.preventDefault()
                        acceptFile(event.dataTransfer.files?.[0])
                      }}
                    >
                      <span className={css.uploadIcon}>
                        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5V3"/><path d="M5 5.5l3-3 3 3"/><path d="M2.5 9v3.5h11V9"/></svg>
                      </span>
                      <span>{tt('edit.upload')}</span>
                      <span className={css.uploadHint}>{tt('edit.uploadHint')}</span>
                    </button>
                  )
                  : (
                    <div className={css.reference}>
                      <img className={css.referenceImage} src={refImage.dataUrl} alt={refImage.name} />
                      <div className={css.referenceActions}>
                        <Button variant="outline" size="sm" onClick={() => { fileInput.current?.click() }}>
                          {tt('edit.change')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setRefImage(null) }}>
                          {tt('edit.remove')}
                        </Button>
                      </div>
                    </div>
                  )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className={css.hiddenFile}
                  onChange={(event) => {
                    acceptFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </section>
            ) : null}

            {/* prompt */}
            <section className={css.card}>
              <textarea
                className={css.prompt}
                value={prompt}
                maxLength={PROMPT_MAX}
                placeholder={tt('prompt.placeholder')}
                onChange={(event) => { setPrompt(event.target.value) }}
              />
              <div className={css.promptFooter}>
                <span className={css.promptCount}>{tt('prompt.count', { count: prompt.length })}</span>
              </div>
            </section>

            {/* parameters */}
            <section className={css.card}>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.size')}</span>
                <div className={css.optionGrid}>
                  {SIZES.map(option => (
                    <Pill
                      key={option}
                      active={size === option}
                      onClick={() => { setSize(option) }}
                      className={css.optionPill}
                    >
                      {tt(SIZE_KEYS[option] ?? 'size.auto')}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.quality')}</span>
                <div className={css.optionRow}>
                  {QUALITIES.map(option => (
                    <Pill
                      key={option}
                      active={quality === option}
                      onClick={() => { setQuality(option) }}
                      className={css.optionPill}
                    >
                      {tt(`quality.${option}` as const)}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.count')}</span>
                <div className={css.optionRow}>
                  {[1, 2, 3, 4].map(option => (
                    <Pill
                      key={option}
                      active={count === option}
                      onClick={() => { setCount(option) }}
                      className={css.optionPill}
                    >
                      {tt(`count.${option === 1 ? 'one' : option === 2 ? 'two' : option === 3 ? 'three' : 'four'}` as const)}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.detail')}</span>
                <div className={css.optionRow}>
                  {DETAILS.map(option => (
                    <Pill
                      key={option === '' ? 'auto' : option}
                      active={detail === option}
                      onClick={() => { setDetail(option) }}
                      className={css.optionPill}
                    >
                      {tt(option === '' ? 'detail.auto' : option === 'standard' ? 'detail.standard' : 'detail.high')}
                    </Pill>
                  ))}
                </div>
                <span className={css.paramHint}>{tt('detail.hint')}</span>
              </div>
            </section>
          </div>

          {/* footer: model + generate — a fixed sibling of the scroll area, so
              it never overlaps the cards scrolling above it. */}
          <section className={css.footer}>
            <label className={css.modelWrap}>
              <span className={css.modelLabel}>{tt('model.label')}</span>
              <select
                className={css.modelSelect}
                value={model}
                disabled={generating}
                onChange={(event) => { setModel(event.target.value) }}
              >
                {MODELS.map(option => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <Button
              variant="primary"
              size="md"
              className={css.generateButton}
              disabled={generateDisabled}
              onClick={() => { void handleGenerate() }}
            >
              {generating ? (
                <span className={css.generateInner}>
                  <span className={css.spinner} />
                  {tt('generating')}
                </span>
              ) : tt('generate')}
            </Button>
          </section>
        </aside>

        {/* --------------------------------------------------------- canvas */}
        <section className={css.canvas}>
          {generating ? (
            <div className={css.canvasState} role="status">
              <span className={css.bigSpinner} />
              <span className={css.canvasStateTitle}>{tt('canvas.generating')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.elapsed', { seconds: elapsed })}</span>
            </div>
          ) : null}

          {!generating && error !== null ? (
            <div className={css.canvasError} role="alert">{tt('canvas.error', { error })}</div>
          ) : null}

          {!generating && !error && images.length === 0 ? (
            <div className={css.canvasState}>
              <span className={css.canvasEmptyIcon}>
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              </span>
              <span className={css.canvasStateTitle}>{tt('canvas.emptyTitle')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.emptyHint')}</span>
            </div>
          ) : null}

          {!generating && images.length > 0 ? (
            <div className={css.canvasBody}>
              <div className={css.canvasMeta}>
                <span>{tt('canvas.images', { count: images.length })}</span>
                {viewingEntry !== null ? (
                  <span className={css.canvasHistoryTag}>{tt('history.viewing', { time: formatTime(viewingEntry.createdAt) })}</span>
                ) : null}
              </div>
              <div className={css.grid} data-count={images.length}>
                {images.map((image, index) => (
                  <figure
                    key={index}
                    className={css.imageCard}
                    role="button"
                    tabIndex={0}
                    title={tt('preview.open')}
                    onClick={() => { openPreview(images, index) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openPreview(images, index)
                      }
                    }}
                  >
                    <img
                      className={css.image}
                      src={srcOf(image)}
                      alt={image.revisedPrompt ?? `${tt('panel.title')} ${index + 1}`}
                    />
                    {image.revisedPrompt !== undefined ? (
                      <figcaption className={css.imageCaption} title={image.revisedPrompt}>
                        {tt('revisedPrompt', { prompt: image.revisedPrompt })}
                      </figcaption>
                    ) : null}
                    <span className={css.zoomHint}>
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="M13 13l-3.2-3.2"/><path d="M7 5.4v3.2M5.4 7h3.2"/></svg>
                      {tt('preview.open')}
                    </span>
                    <a
                      className={css.download}
                      href={srcOf(image)}
                      download={`dsh-image-${index + 1}.${extensionOf(image.mime)}`}
                      onClick={(event) => { event.stopPropagation() }}
                    >
                      {tt('download')}
                    </a>
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* -------------------------------------------------------- history */}
        <aside className={css.history}>
          <header className={css.historyHeader}>
            <span className={css.historyTitle}>{tt('history.title')}</span>
            {history.length > 0 ? (
              <button type="button" className={css.historyClear} onClick={() => { void clearHistory() }}>
                {tt('history.clear')}
              </button>
            ) : null}
          </header>

          {history.length === 0 ? (
            <div className={css.historyEmpty}>{tt('history.empty')}</div>
          ) : (
            <div className={css.historyList}>
              {history.map(entry => (
                <div
                  key={entry.id}
                  className={css.historyItem}
                  data-active={entry.id === viewingHistoryId ? '' : undefined}
                >
                  <button
                    type="button"
                    className={css.historyMain}
                    onClick={() => { void viewHistoryEntry(entry) }}
                  >
                    {entry.images.length > 0 ? (
                      <img className={css.historyThumb} src={entry.images[0]!.url} alt="" />
                    ) : (
                      <span className={css.historyThumbPlaceholder} />
                    )}
                    <span className={css.historyInfo}>
                      <span className={css.historyPrompt}>{entry.prompt}</span>
                      <span className={css.historyMeta}>
                        {tt(`mode.${entry.mode === 'edit' ? 'edit' : 'text'}` as const)}
                        {' · '}{formatTime(entry.createdAt)}
                        {' · '}{entry.images.length} {tt('history.images')}
                      </span>
                    </span>
                  </button>
                  <span className={css.historyActions}>
                    <button type="button" className={css.historyAction} onClick={() => { void restoreHistoryEntry(entry) }}>
                      {tt('history.restore')}
                    </button>
                    <button type="button" className={css.historyAction} data-danger onClick={() => { void deleteHistoryEntry(entry.id) }}>
                      {tt('history.delete')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* -------------------------------------------------- preview overlay */}
      {preview !== null && previewImage !== null
        ? createPortal(
          <div
            className={css.lightbox}
            role="dialog"
            aria-modal="true"
            aria-label={tt('preview.title')}
            onClick={closePreview}
          >
            <button type="button" className={css.lightboxClose} aria-label={tt('preview.close')} title={tt('preview.close')} onClick={closePreview}>
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
            {preview.images.length > 1 ? (
              <>
                <button type="button" className={css.lightboxNav} data-dir="prev" aria-label={tt('preview.prev')} onClick={(event) => { event.stopPropagation(); stepPreview(-1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3l-5 5 5 5"/></svg>
                </button>
                <button type="button" className={css.lightboxNav} data-dir="next" aria-label={tt('preview.next')} onClick={(event) => { event.stopPropagation(); stepPreview(1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
                </button>
              </>
            ) : null}
            <figure className={css.lightboxFigure} onClick={(event) => { event.stopPropagation() }}>
              <div
                className={css.lightboxStage}
                onWheel={(event) => {
                  event.preventDefault()
                  setPreviewScale(current => clampPreviewScale(current + (event.deltaY < 0 ? PREVIEW_SCALE_STEP : -PREVIEW_SCALE_STEP)))
                }}
              >
                <img
                  className={css.lightboxImage}
                  style={{ transform: `scale(${previewScale})` }}
                  src={srcOf(previewImage)}
                  alt={previewImage.revisedPrompt ?? tt('preview.title')}
                />
              </div>
              <div className={css.lightboxTools} role="group" aria-label={tt('preview.zoomControls')}>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomOut')} title={tt('preview.zoomOut')} onClick={() => { setPreviewScale(current => clampPreviewScale(current - PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
                <button type="button" className={css.lightboxZoomLevel} aria-label={tt('preview.zoomReset')} title={tt('preview.zoomReset')} onClick={() => { setPreviewScale(1) }}>
                  {tt('preview.zoomLevel', { percent: Math.round(previewScale * 100) })}
                </button>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomIn')} title={tt('preview.zoomIn')} onClick={() => { setPreviewScale(current => clampPreviewScale(current + PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M7 4.8v4.4M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
              </div>
              {previewImage.revisedPrompt !== undefined ? (
                <div className={css.lightboxCaptionRow}>
                  <figcaption className={css.lightboxCaption} title={previewImage.revisedPrompt}>
                    {tt('revisedPrompt', { prompt: previewImage.revisedPrompt })}
                  </figcaption>
                  <button type="button" className={css.lightboxCopy} aria-label={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} title={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} onClick={() => { void copyPreviewPrompt(previewImage.revisedPrompt!) }}>
                    {promptCopied ? (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="7" height="8" rx="1"/><path d="M3 10V3.8c0-.44.36-.8.8-.8H9"/></svg>
                    )}
                    <span>{tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')}</span>
                  </button>
                </div>
              ) : null}
              <div className={css.lightboxMeta}>
                <span className={css.lightboxIndex}>{tt('preview.index', { index: preview.index + 1, total: preview.images.length })}</span>
                <span className={css.lightboxActions}>
                  <button type="button" className={css.lightboxEdit} onClick={addPreviewToEdit}>
                    {tt('preview.addToEdit')}
                  </button>
                  <a
                    className={css.lightboxDownload}
                    href={srcOf(previewImage)}
                    download={`dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`}
                  >
                    {tt('download')}
                  </a>
                </span>
              </div>
            </figure>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}

/** File extension for a MIME type (download filenames). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/**
 * Canvas file-node preview surfaces.
 *
 * A file node used to show an icon and a "download it" hint for everything that
 * was not an image. These components render the node's actual content:
 *
 *  - {@link CanvasFileBody} is the in-node preview (small, scrollable);
 *  - {@link CanvasFileOverlay} is the full-screen reader opened by the node's
 *    hover toolbar, the context menu, or a double click on the body.
 *
 * Images, PDFs and media play straight from the asset URL (the host serves
 * those inline and with byte ranges). Everything else asks the host for a
 * bounded, structured preview through `/canvas/file/preview` and reconstructs
 * the original document: Markdown renders as rich text, HTML runs in a
 * script-less sandboxed iframe, SVG shows as a browser image, DOCX lays out
 * its headings / lists / tables, and PPTX becomes one card per slide with its
 * embedded pictures. Text, CSV, XLSX and ZIP listings never need a download.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle, Archive, Check, Copy, Download, ExternalLink, FileText, FileSpreadsheet,
  Film, Image as ImageIcon, Loader2, Music, X,
} from 'lucide-react'
import type {
  CanvasAssetRef, CanvasDocBlock, CanvasDocRun, CanvasFileKind, CanvasFilePreview, CanvasSlidePreview,
} from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import type { ImageGenKey } from './locales.ts'
import { renderMarkdown } from './markdown.tsx'
import css from './canvas-workspace.module.css'

/** Coarse bucket of one file asset (falling back to the MIME/extension). */
export function fileKindOfAsset(asset: CanvasAssetRef): CanvasFileKind {
  const declared = asset.kind === 'file' ? asset.name ?? '' : ''
  const mime = asset.mime.split(';')[0]!.trim().toLowerCase()
  const extension = /\.([a-z0-9]+)$/i.exec(declared)?.[1]?.toLowerCase() ?? ''
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (/openxmlformats|vnd\.ms-|vnd\.oasis/.test(mime) || ['pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'odt', 'odp', 'ods'].includes(extension)) return 'office'
  if (mime === 'application/zip' || ['zip', '7z', 'rar', 'gz', 'tar'].includes(extension)) return 'archive'
  if (mime.startsWith('text/') || mime === 'application/json' || ['md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'xml', 'txt'].includes(extension)) return 'text'
  return 'other'
}

export function fileKindLabel(kind: CanvasFileKind): string {
  return tt(`canvas.skills.fileKind.${kind}` as ImageGenKey)
}

/** Human-readable byte count for file nodes and the file picker. */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return tt('canvas.skills.fileSizeUnknown')
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Media types the browser renders from the asset URL alone. */
export function directMediaOf(mime: string): 'image' | 'pdf' | 'audio' | 'video' | undefined {
  const value = mime.split(';')[0]!.trim().toLowerCase()
  if (/^image\/(png|jpeg|webp|gif|bmp)$/.test(value)) return 'image'
  if (value === 'application/pdf') return 'pdf'
  if (value.startsWith('audio/')) return 'audio'
  if (value.startsWith('video/')) return 'video'
  return undefined
}

/** Asset URL that asks the host for an inline (non-attachment) response. */
export function inlineAssetUrl(asset: CanvasAssetRef): string {
  const separator = asset.url.includes('?') ? '&' : '?'
  return `${asset.url}${separator}inline=1`
}

/** Previews are immutable (content-addressed), so one module cache is safe. */
const previewCache = new Map<string, CanvasFilePreview>()
const previewInflight = new Map<string, Promise<CanvasFilePreview>>()

function loadPreview(api: ImageGenApi, asset: CanvasAssetRef): Promise<CanvasFilePreview> {
  const cached = previewCache.get(asset.assetId)
  if (cached !== undefined) return Promise.resolve(cached)
  const running = previewInflight.get(asset.assetId)
  if (running !== undefined) return running
  const request = api.canvasFilePreview({ assetId: asset.assetId, name: asset.name, mime: asset.mime })
    .then(preview => { previewCache.set(asset.assetId, preview); return preview })
    .finally(() => { previewInflight.delete(asset.assetId) })
  previewInflight.set(asset.assetId, request)
  return request
}

interface PreviewState {
  preview?: CanvasFilePreview
  loading: boolean
  error?: string
}

/** Load one asset's structured preview once, shared by node body and overlay. */
function useFilePreview(api: ImageGenApi, asset: CanvasAssetRef, enabled: boolean): PreviewState & { reload: () => void } {
  const cached = previewCache.get(asset.assetId)
  const [state, setState] = useState<PreviewState>(() => cached === undefined ? { loading: enabled } : { preview: cached, loading: false })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled || asset.assetId === '') return
    if (nonce === 0 && previewCache.has(asset.assetId)) {
      const cached = previewCache.get(asset.assetId)
      setState(previous => previous.preview === undefined ? { preview: cached, loading: false } : previous)
      return
    }
    let cancelled = false
    setState(previous => previous.preview === undefined ? { loading: true } : { ...previous, loading: true })
    void loadPreview(api, asset)
      .then(preview => { if (!cancelled) setState({ preview, loading: false }) })
      .catch(error => { if (!cancelled) setState({ loading: false, error: errorMessage(error) }) })
    return () => { cancelled = true }
  }, [api, asset, enabled, nonce])

  const reload = useCallback((): void => {
    previewCache.delete(asset.assetId)
    setNonce(value => value + 1)
  }, [asset.assetId])

  return { ...state, reload }
}

function formatLabel(preview: CanvasFilePreview | undefined, fileKind: CanvasFileKind): string {
  // Every kind except media and archive carries a format bucket in the UI.
  if (preview !== undefined && preview.kind !== 'media' && preview.kind !== 'archive') {
    return preview.format.toUpperCase()
  }
  return fileKindLabel(fileKind)
}

function DownloadButton({ asset, title, label }: { asset: CanvasAssetRef; title: string; label: string }): React.JSX.Element {
  return <button
    type="button"
    className={css.fileAction}
    title={label}
    aria-label={label}
    onClick={event => {
      event.stopPropagation()
      const anchor = document.createElement('a')
      anchor.href = asset.url
      anchor.download = asset.name ?? title
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }}
  ><Download size={13} strokeWidth={1.6} aria-hidden="true" /></button>
}

/** CSV / TSV / XLSX grid, shared by the node body and the overlay. */
function PreviewTable({ rows, expanded }: { rows: string[][]; expanded: boolean }): React.JSX.Element {
  const [head, ...body] = rows
  if (head === undefined) return <div className={css.filePlaceholder}><span>{tt('canvas.preview.empty')}</span></div>
  return <div className={css.fileTableWrap} data-expanded={expanded ? '' : undefined}>
    <table className={css.fileTable}>
      <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
      <tbody>
        {body.map((row, rowIndex) => <tr key={rowIndex}>
          {head.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>
}

/** ZIP central-directory listing. */
function PreviewArchive({ entries }: { entries: Array<{ name: string; size: number; dir: boolean }> }): React.JSX.Element {
  if (entries.length === 0) return <div className={css.filePlaceholder}><span>{tt('canvas.preview.empty')}</span></div>
  return <ul className={css.fileArchiveList}>
    {entries.map((entry, index) => <li key={`${entry.name}-${index}`} className={css.fileArchiveRow} data-dir={entry.dir ? '' : undefined}>
      <Archive size={12} strokeWidth={1.6} aria-hidden="true" />
      <span className={css.fileArchiveName} title={entry.name}>{entry.name}</span>
      <span className={css.fileArchiveSize}>{entry.dir ? '' : fileSizeLabel(entry.size)}</span>
    </li>)}
  </ul>
}

/** HTML document in a script-less sandboxed iframe (opaque origin, no forms). */
function PreviewHtml({ html, title }: { html: string; title: string }): React.JSX.Element {
  return <iframe className={css.fileFrame} sandbox="" srcDoc={html} title={title} referrerPolicy="no-referrer" />
}

/** SVG source rendered as a browser image; scripts never run in `<img>`. */
function PreviewSvg({ svg }: { svg: string }): React.JSX.Element {
  const url = useMemo(() => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), [svg])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return <div className={css.fileSvg}>
    <img src={url} alt="" draggable={false} onDragStart={event => event.preventDefault()} />
  </div>
}

/** Markdown source rendered through the dependency-free rich-text renderer. */
function PreviewMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  return <div className={css.fileDoc}>{renderMarkdown(markdown)}</div>
}

/** One styled run sequence (bold / italic fragments). */
function docRuns(runs: CanvasDocRun[], keyPrefix: string): ReactNode[] {
  return runs.map((run, index) => {
    let node: ReactNode = run.text
    if (run.bold === true) node = <strong>{node}</strong>
    if (run.italic === true) node = <em>{node}</em>
    return <Fragment key={`${keyPrefix}r${index}`}>{node}</Fragment>
  })
}

/** DOCX layout: headings, paragraphs with runs, pre-grouped lists, tables. */
function PreviewDocument({ blocks }: { blocks: CanvasDocBlock[] }): React.JSX.Element {
  if (blocks.length === 0) return <div className={css.filePlaceholder}><span>{tt('canvas.preview.empty')}</span></div>
  const nodes: ReactNode[] = blocks.map((block, index) => {
    const key = `d${index}`
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(block.level, 3)}` as 'h1' | 'h2' | 'h3'
        return <Tag key={key}>{docRuns(block.runs, key)}</Tag>
      }
      case 'paragraph':
        return <p key={key}>{docRuns(block.runs, key)}</p>
      case 'list': {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{docRuns(item, `${key}-${itemIndex}`)}</li>)
        return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
      }
      case 'table':
        return <table key={key}><tbody>
          {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}
        </tbody></table>
      default:
        return null
    }
  })
  return <div className={css.fileDoc}>{nodes}</div>
}

/** PPTX deck: one card per slide with its number, title, pictures and lines. */
function PreviewSlides({ slides, compact }: { slides: CanvasSlidePreview[]; compact: boolean }): React.JSX.Element {
  return <div className={css.fileSlides} data-compact={compact ? '' : undefined}>
    {slides.map((slide, index) => <div key={index} className={css.fileSlide}>
      <div className={css.fileSlideHeader}>
        <span className={css.fileSlideNum}>{tt('canvas.preview.slideOf', { page: index + 1 })}</span>
        {slide.title !== undefined && slide.title !== '' ? <span className={css.fileSlideTitle} title={slide.title}>{slide.title}</span> : null}
      </div>
      {slide.images.length > 0 ? <div className={css.fileSlideImages}>
        {slide.images.map((image, imageIndex) => <img key={imageIndex} src={image.data} alt="" loading="lazy" draggable={false} />)}
      </div> : null}
      {slide.lines.length > 0 ? <div className={css.fileSlideLines}>
        {slide.lines.slice(0, 24).map((line, lineIndex) => <div key={lineIndex} className={css.fileSlideLine}><span>{line}</span></div>)}
      </div> : null}
    </div>)}
  </div>
}

/** Small rendered/source switch shown above rich previews in the overlay. */
function SourceToggle({ showSource, onToggle }: { showSource: boolean; onToggle: () => void }): React.JSX.Element {
  return <div className={css.fileSourceRow}>
    <button type="button" className={css.fileSourceBtn} data-active={showSource ? undefined : ''} onClick={onToggle}>{tt('canvas.preview.rendered')}</button>
    <button type="button" className={css.fileSourceBtn} data-active={showSource ? '' : undefined} onClick={onToggle}>{tt('canvas.preview.source')}</button>
  </div>
}

function PreviewNotice({ preview }: { preview: CanvasFilePreview }): React.JSX.Element | null {
  let message: string | undefined
  if (preview.kind === 'text') {
    if (!preview.truncated && preview.warning === undefined) return null
    message = preview.truncated
      ? tt('canvas.preview.textTruncated', { chars: preview.text.length })
      : preview.format === 'pdf'
        ? tt('canvas.preview.pdfHeuristic')
        : preview.warning ?? ''
  } else if (preview.kind === 'html' && preview.truncated) {
    message = tt('canvas.preview.textTruncated', { chars: preview.html.length })
  } else if (preview.kind === 'markdown' && preview.truncated) {
    message = tt('canvas.preview.textTruncated', { chars: preview.markdown.length })
  } else if (preview.kind === 'svg' && preview.truncated) {
    message = tt('canvas.preview.textTruncated', { chars: preview.svg.length })
  } else if (preview.kind === 'document' && preview.truncated) {
    message = tt('canvas.preview.docTruncated', { blocks: preview.blocks.length })
  } else if (preview.kind === 'slides' && preview.truncated) {
    message = tt('canvas.preview.slidesTruncated', { count: preview.slides.length })
  } else if (preview.kind === 'table' && preview.truncated) {
    message = tt('canvas.preview.tableTruncated', { rows: preview.rows.length })
  } else if (preview.kind === 'archive' && preview.truncated) {
    message = tt('canvas.preview.archiveTruncated', { count: preview.entries.length })
  }
  if (message === undefined || message === '') return null
  return <div className={css.fileNotice}>
    <AlertTriangle size={11} strokeWidth={1.8} aria-hidden="true" />
    <span title={message}>{message}</span>
  </div>
}

/** Loading / failure placeholder shared by both surfaces. */
function PreviewStateNotice({ state, onRetry, compact }: { state: PreviewState; onRetry: () => void; compact: boolean }): React.JSX.Element {
  if (state.error !== undefined) {
    return <div className={css.filePlaceholder}>
      <AlertTriangle size={compact ? 20 : 26} strokeWidth={1.6} aria-hidden="true" />
      <span>{tt('canvas.preview.failed', { message: state.error })}</span>
      <button type="button" className={css.fileRetry} onClick={event => { event.stopPropagation(); onRetry() }}>{tt('canvas.preview.retry')}</button>
    </div>
  }
  return <div className={css.filePlaceholder}>
    <Loader2 size={compact ? 18 : 24} strokeWidth={1.6} className={css.fileSpinner} aria-hidden="true" />
    <span>{tt('canvas.skills.filePreviewLoading')}</span>
  </div>
}

function UnavailableNotice({ preview, compact }: { preview: Extract<CanvasFilePreview, { kind: 'none' }>; compact: boolean }): React.JSX.Element {
  return <div className={css.filePlaceholder} title={preview.message}>
    <FileText size={compact ? 22 : 30} strokeWidth={1.5} aria-hidden="true" />
    <span>{tt(`canvas.preview.reason.${preview.reason}` as ImageGenKey)}</span>
  </div>
}

/** In-node preview of one file asset. */
export function CanvasFileBody(props: {
  api: ImageGenApi
  asset: CanvasAssetRef
  fileKind: CanvasFileKind
  title: string
  /** Tooltip shown over the body (the canvas passes its "double-click" hint). */
  hint?: string
  onExpand: () => void
}): React.JSX.Element {
  const { api, asset, fileKind, title, hint, onExpand } = props
  const media = directMediaOf(asset.mime)
  const { preview, loading, error, reload } = useFilePreview(api, asset, media === undefined)
  const open = (event: React.MouseEvent): void => { event.stopPropagation(); onExpand() }

  if (media === 'image') {
    return <div className={css.fileBody} title={hint} onDoubleClick={open}>
      <img src={asset.url} alt={title} draggable={false} onDragStart={event => event.preventDefault()} />
    </div>
  }
  if (media === 'pdf') {
    return <div className={css.fileBody} title={hint} onDoubleClick={open}>
      <object className={css.fileFrame} data={inlineAssetUrl(asset)} type="application/pdf" aria-label={title}>
        <div className={css.filePlaceholder}>
          <FileText size={22} strokeWidth={1.5} aria-hidden="true" />
          <span>{tt('canvas.preview.pdfFallback')}</span>
        </div>
      </object>
    </div>
  }
  if (media === 'audio') {
    return <div className={css.fileBody} title={hint} onDoubleClick={open}>
      <div className={css.fileMedia}><Music size={22} strokeWidth={1.5} aria-hidden="true" />
        <audio controls preload="metadata" src={inlineAssetUrl(asset)} />
      </div>
    </div>
  }
  if (media === 'video') {
    return <div className={css.fileBody} title={hint} onDoubleClick={open}>
      <video className={css.fileVideo} controls preload="metadata" src={inlineAssetUrl(asset)} />
    </div>
  }

  if (preview === undefined) {
    // A text file's head already travels with the asset, so the node shows
    // something readable while the full preview is still on the wire.
    if (error === undefined && fileKind === 'text' && asset.textPreview !== undefined && asset.textPreview !== '') {
      return <div className={css.fileBody} title={hint} onDoubleClick={open}>
        <pre className={css.fileText} onPointerDown={event => event.stopPropagation()}>{asset.textPreview}</pre>
      </div>
    }
    return <div className={css.fileBody} title={hint} onDoubleClick={open}>
      <PreviewStateNotice state={{ loading, ...error === undefined ? {} : { error } }} onRetry={reload} compact />
    </div>
  }

  return <div className={css.fileBody} title={hint} onDoubleClick={open}>
    <FilePreviewContent preview={preview} loading={loading} error={error} asset={asset} title={title} compact onRetry={reload} />
    <PreviewNotice preview={preview} />
  </div>
}

/** The preview payload rendered into a body or a full-screen stage. */
function FilePreviewContent(props: {
  preview: CanvasFilePreview | undefined
  loading: boolean
  error?: string
  asset: CanvasAssetRef
  title: string
  compact: boolean
  onRetry: () => void
}): React.JSX.Element {
  const { preview, asset, title } = props
  const [showSource, setShowSource] = useState(false)
  const toggleSource = useCallback((): void => setShowSource(value => !value), [])
  if (preview === undefined) {
    return <PreviewStateNotice state={{ loading: props.loading, ...props.error === undefined ? {} : { error: props.error } }} onRetry={props.onRetry} compact={props.compact} />
  }
  switch (preview.kind) {
    case 'text':
      return preview.text === ''
        ? <div className={css.filePlaceholder}><span>{tt('canvas.preview.empty')}</span></div>
        : <pre className={props.compact ? css.fileText : css.fileOverlayText} onPointerDown={event => { if (props.compact) event.stopPropagation() }}>{preview.text}</pre>
    case 'html':
      // The overlay may flip between the rendered page and its source; the
      // small in-node body always shows the rendered page.
      if (showSource && !props.compact) {
        return <>
          <SourceToggle showSource={showSource} onToggle={toggleSource} />
          <pre className={css.fileOverlayText}>{preview.html}</pre>
        </>
      }
      return <>
        {!props.compact ? <SourceToggle showSource={showSource} onToggle={toggleSource} /> : null}
        <PreviewHtml html={preview.html} title={title} />
      </>
    case 'markdown':
      if (showSource && !props.compact) {
        return <>
          <SourceToggle showSource={showSource} onToggle={toggleSource} />
          <pre className={css.fileOverlayText}>{preview.markdown}</pre>
        </>
      }
      return <>
        {!props.compact ? <SourceToggle showSource={showSource} onToggle={toggleSource} /> : null}
        <PreviewMarkdown markdown={preview.markdown} />
      </>
    case 'svg':
      return <PreviewSvg svg={preview.svg} />
    case 'document':
      return <PreviewDocument blocks={preview.blocks} />
    case 'slides':
      return <PreviewSlides slides={preview.slides} compact={props.compact} />
    case 'table':
      return <PreviewTable rows={preview.rows} expanded={!props.compact} />
    case 'archive':
      return <PreviewArchive entries={preview.entries} />
    case 'media':
      return <MediaStage media={preview.media} url={preview.url} asset={asset} title={title} compact={props.compact} />
    case 'none':
      return <UnavailableNotice preview={preview} compact={props.compact} />
  }
}

function MediaStage({ media, url, asset, title, compact }: {
  media: 'image' | 'pdf' | 'audio' | 'video'
  /** Inline URL from the host preview (direct media passes its own). */
  url: string
  asset: CanvasAssetRef
  title: string
  compact: boolean
}): React.JSX.Element {
  // Images are already served inline by the asset route, so they never need
  // the `inline` opt-in the document and media types use.
  if (media === 'image') return <img src={asset.url} alt={title} draggable={false} onDragStart={event => event.preventDefault()} />
  if (media === 'pdf') return <object className={css.fileFrame} data={url} type="application/pdf" aria-label={title} />
  if (media === 'video') return <video className={css.fileVideo} controls preload="metadata" src={url} />
  return <div className={css.fileMedia}><Music size={compact ? 22 : 34} strokeWidth={1.5} aria-hidden="true" />
    <audio controls preload="metadata" src={url} />
  </div>
}

/** Kind icon used in the preview header. */
function FileKindIcon({ kind }: { kind: CanvasFileKind }): React.JSX.Element {
  const common = { size: 15, strokeWidth: 1.6, 'aria-hidden': true as const }
  switch (kind) {
    case 'image': return <ImageIcon {...common} />
    case 'audio': return <Music {...common} />
    case 'video': return <Film {...common} />
    case 'office': return <FileSpreadsheet {...common} />
    case 'archive': return <Archive {...common} />
    default: return <FileText {...common} />
  }
}

/** Full-screen reader for one file asset. */
export function CanvasFileOverlay(props: {
  api: ImageGenApi
  asset: CanvasAssetRef
  fileKind: CanvasFileKind
  title: string
  onClose: () => void
}): React.JSX.Element {
  const { api, asset, fileKind, title, onClose } = props
  const media = directMediaOf(asset.mime)
  const { preview, loading, error, reload } = useFilePreview(api, asset, media === undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [onClose])

  const copyable = useMemo(() => {
    if (preview?.kind === 'text') return preview.text
    if (preview?.kind === 'html') return preview.html
    if (preview?.kind === 'markdown') return preview.markdown
    if (preview?.kind === 'svg') return preview.svg
    if (preview?.kind === 'table') return preview.rows.map(row => row.join('\t')).join('\n')
    if (preview?.kind === 'document') {
      return preview.blocks.map(block => {
        const runText = (runs: CanvasDocRun[]): string => runs.map(run => run.text).join('')
        switch (block.type) {
          case 'heading': case 'paragraph': return runText(block.runs)
          case 'list': return block.items.map(item => runText(item)).join('\n')
          case 'table': return block.rows.map(row => row.join('\t')).join('\n')
          default: return ''
        }
      }).filter(part => part !== '').join('\n\n')
    }
    if (preview?.kind === 'slides') {
      return preview.slides
        .map((slide, index) => [tt('canvas.preview.slideOf', { page: index + 1 }), slide.title ?? '', ...slide.lines]
          .filter(part => part !== '').join('\n'))
        .join('\n\n')
    }
    return undefined
  }, [preview])

  const copy = useCallback((): void => {
    if (copyable === undefined) return
    void navigator.clipboard?.writeText(copyable).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }, [copyable])

  const effectiveKind = useMemo<CanvasFileKind>(() => {
    if (fileKind !== 'other') return fileKind
    if (preview?.kind === 'table') return 'office'
    return fileKind
  }, [fileKind, preview])

  const meta = [formatLabel(preview, effectiveKind), asset.bytes > 0 ? fileSizeLabel(asset.bytes) : '']
    .filter(part => part !== '')
    .join(' · ')

  return <div className={css.fileOverlay} role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
    <div className={css.fileOverlayPanel} data-media={media ?? 'document'} onClick={event => event.stopPropagation()}>
      <header className={css.fileOverlayHeader}>
        <span className={css.fileOverlayIcon}><FileKindIcon kind={effectiveKind} /></span>
        <span className={css.fileOverlayTitle} title={asset.name ?? title}>{asset.name ?? title}</span>
        <span className={css.fileOverlayMeta}>{meta}</span>
        <div className={css.fileOverlayActions}>
          {copyable !== undefined && copyable !== '' ? <button
            type="button"
            className={css.fileAction}
            title={tt(copied ? 'canvas.preview.copied' : 'canvas.preview.copy')}
            aria-label={tt(copied ? 'canvas.preview.copied' : 'canvas.preview.copy')}
            onClick={copy}
          >{copied ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.6} aria-hidden="true" />}</button> : null}
          {media !== undefined ? <button
            type="button"
            className={css.fileAction}
            title={tt('canvas.preview.openTab')}
            aria-label={tt('canvas.preview.openTab')}
            onClick={() => globalThis.open?.(inlineAssetUrl(asset), '_blank', 'noopener')}
          ><ExternalLink size={13} strokeWidth={1.6} aria-hidden="true" /></button> : null}
          <DownloadButton asset={asset} title={title} label={tt('canvas.skills.fileDownload')} />
          <button
            type="button"
            className={css.fileAction}
            title={tt('canvas.preview.close')}
            aria-label={tt('canvas.preview.close')}
            onClick={onClose}
          ><X size={14} strokeWidth={1.8} aria-hidden="true" /></button>
        </div>
      </header>
      <div className={css.fileOverlayBody} data-media={media ?? 'document'}>
        {/* Direct-media assets never ask the host for a payload: the browser
            renders them from the inline URL (with byte ranges). */}
        {media !== undefined
          ? <MediaStage media={media} url={inlineAssetUrl(asset)} asset={asset} title={title} compact={false} />
          : <FilePreviewContent
              preview={preview}
              loading={loading}
              error={error}
              asset={asset}
              title={title}
              compact={false}
              onRetry={reload}
            />}
        {preview !== undefined ? <PreviewNotice preview={preview} /> : null}
      </div>
    </div>
  </div>
}

/** Inline renderer for image-generation tool-result attachments. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AGENT_IMAGE_API } from '../protocol.ts'
import { CHAT_IMAGE_EVENT } from './conversation-sync.ts'
import { tt } from './helpers.ts'
import css from './image-toolview.module.css'

/** Owner props supplied by the host's keyed tool-call slot. */
export interface ImageToolViewOwnerProps {
  callId: string
  toolName: string
  block: ToolCallBlock
  cwd?: string
  home?: string
  openFile: (path: string) => void
  inspect?: () => void
}

interface LoadedImage {
  ref: ImageAttachmentRef
  src: string
}

interface ImageToolViewProps extends ImageToolViewOwnerProps {
  sessionId: SessionId
}

/** Download filename extension per accepted media type. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Filename for a downloaded result; the attachment name wins when it has one. */
export function imageFileName(ref: ImageAttachmentRef, index: number): string {
  const extension = IMAGE_EXTENSIONS[ref.mediaType] ?? 'png'
  const name = (ref.name ?? '').trim()
  if (name === '') return `dsh-image-${index + 1}.${extension}`
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extension}`
}

function isSettled(block: ToolCallBlock): block is Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return 'kind' in block
}

/** Read persisted UI metadata on modern hosts and content blocks on older hosts. */
export function imageRefsOf(block: ToolCallBlock): ImageAttachmentRef[] {
  if (!isSettled(block) || block.isError) return []
  const refs = new Map<string, ImageAttachmentRef>()
  const append = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const raw = value as Record<string, unknown>
    const attachmentId = raw.attachmentId ?? raw.attachment_id
    const mediaType = raw.mediaType ?? raw.media_type
    if (typeof attachmentId !== 'string' || attachmentId === ''
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(mediaType))
      || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0
      || typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) || raw.width <= 0
      || typeof raw.height !== 'number' || !Number.isSafeInteger(raw.height) || raw.height <= 0) return
    if (!refs.has(attachmentId)) refs.set(attachmentId, {
      attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
      mediaType: mediaType as ImageAttachmentRef['mediaType'],
      bytes: raw.bytes, width: raw.width, height: raw.height,
      ...typeof raw.name === 'string' ? { name: raw.name } : {},
    })
  }
  const fromImages = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const images = (value as { images?: unknown }).images
    if (Array.isArray(images)) images.forEach(append)
  }
  block.content.forEach(content => { if (content.type === 'image') append(content.attachment) })
  // DSH's Web client consumes persisted result.meta, not host presentResult().
  fromImages((block as { meta?: unknown }).meta)
  // Existing sessions also carry the exact references in the textual tool result.
  if (refs.size === 0) { try { fromImages(JSON.parse(textOf(block))) } catch { /* Not a JSON image-tool result. */ } }
  return [...refs.values()]
}

function textOf(block: ToolCallBlock): string {
  if (!isSettled(block)) return ''
  return block.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('\n')
}

function resultInfo(block: ToolCallBlock): { status: string; message: string } {
  if (!isSettled(block)) return { status: 'running', message: '正在生成图片…' }
  const text = textOf(block)
  try {
    const parsed = JSON.parse(text) as { status?: unknown; message?: unknown }
    return {
      status: typeof parsed.status === 'string' ? parsed.status : block.isError ? 'failed' : 'completed',
      message: typeof parsed.message === 'string' ? parsed.message : '',
    }
  } catch {
    return { status: block.isError ? 'failed' : 'completed', message: text }
  }
}

function statusLabel(status: string): string {
  if (status === 'running' || status === 'queued') return '生成中'
  if (status === 'failed') return '生成失败'
  if (status === 'cancelled') return '已取消'
  return '图片结果'
}

function useAttachmentImages(
  sessionId: SessionId,
  refs: ImageAttachmentRef[],
  load: (sessionId: SessionId, ref: ImageAttachmentRef) => Promise<string>,
): { images: LoadedImage[]; error: string | null } {
  const key = useMemo(() => refs.map(ref => String(ref.attachmentId)).join('|'), [refs])
  const [images, setImages] = useState<LoadedImage[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let failed = false
    const urls: string[] = []
    const revoke = (): void => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.length = 0
    }

    setImages([])
    setError(null)
    if (refs.length === 0) return () => { /* no attachments to clean up */ }

    void Promise.all(refs.map(async ref => {
      const src = await load(sessionId, ref)
      if (disposed || failed) URL.revokeObjectURL(src)
      else urls.push(src)
      return { ref, src }
    }))
      .then(next => {
        if (!disposed) setImages(next)
      })
      .catch(errorValue => {
        failed = true
        revoke()
        if (!disposed) setError(errorValue instanceof Error ? errorValue.message : String(errorValue))
      })

    return () => {
      disposed = true
      revoke()
    }
  }, [key, load, refs, sessionId])

  return { images, error }
}

/** Decode any accepted result format into PNG, which the clipboard accepts everywhere. */
function toPngBlob(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const source = new Image()
    source.onerror = () => reject(new Error('Unable to decode image'))
    source.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = source.naturalWidth
      canvas.height = source.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null || canvas.width === 0 || canvas.height === 0) {
        reject(new Error('Image conversion unavailable'))
        return
      }
      context.drawImage(source, 0, 0)
      canvas.toBlob(blob => blob === null ? reject(new Error('Image conversion failed')) : resolve(blob), 'image/png')
    }
    source.src = src
  })
}

/** Copy a rendered result to the system clipboard (PNG-encoded). */
async function copyImageSource(src: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) {
    throw new Error('Image clipboard unavailable')
  }
  const blob = await (await fetch(src)).blob()
  const png = blob.type.split(';')[0]?.trim().toLowerCase() === 'image/png' ? blob : await toPngBlob(src)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/**
 * Full-screen result viewer.
 *
 * The conversation window cannot open a new window for a `blob:` URL: the
 * desktop shell denies every `window.open` / `target="_blank"` that is not
 * http(s), so an anchor around the thumbnail is a silent no-op there. Rendering
 * the viewer in place (portal to body, download through `<a download>`) keeps
 * preview and save working on both the desktop app and `dsh web`.
 */
function ImageLightbox(props: {
  images: LoadedImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}): React.JSX.Element | null {
  const { images, index, onIndex, onClose } = props
  const dialog = useRef<HTMLDivElement | null>(null)
  const [copying, setCopying] = useState(false)
  const [notice, setNotice] = useState<'copied' | 'failed' | null>(null)
  const image = images[index]

  useEffect(() => {
    dialog.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (images.length < 2) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onIndex((index - 1 + images.length) % images.length)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onIndex((index + 1) % images.length)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [images.length, index, onClose, onIndex])

  if (image === undefined) return null

  const copy = async (): Promise<void> => {
    setCopying(true)
    setNotice(null)
    try {
      await copyImageSource(image.src)
      setNotice('copied')
    } catch {
      setNotice('failed')
    } finally {
      setCopying(false)
    }
  }

  const step = (direction: number): void => {
    onIndex((index + direction + images.length) % images.length)
  }

  return createPortal(
    <div className={css.lightbox} data-image-lightbox="" role="presentation" onClick={onClose}>
      <div
        className={css.lightboxDialog}
        role="dialog"
        aria-modal="true"
        aria-label={tt('canvas.preview.expand')}
        ref={dialog}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <header className={css.lightboxHeader}>
          <span className={css.lightboxTitle}>{image.ref.name ?? tt('canvas.preview.expand')}</span>
          {images.length > 1 && <span className={css.lightboxIndex}>{index + 1} / {images.length}</span>}
          <button type="button" className={css.lightboxClose} aria-label={tt('preview.close')} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>
        <div className={css.lightboxStage}>
          {images.length > 1 && <button type="button" className={css.lightboxNav} data-dir="prev" aria-label="previous" onClick={() => step(-1)}>‹</button>}
          <img className={css.lightboxImage} src={image.src} alt={image.ref.name ?? '生成图片'} />
          {images.length > 1 && <button type="button" className={css.lightboxNav} data-dir="next" aria-label="next" onClick={() => step(1)}>›</button>}
        </div>
        <footer className={css.lightboxFooter}>
          <span className={css.lightboxMeta}>{image.ref.width} × {image.ref.height}</span>
          {notice !== null && <span className={css.lightboxNotice} role="status">{tt(notice === 'copied' ? 'image.copied' : 'image.copyFailed')}</span>}
          <span className={css.lightboxActions}>
            <button type="button" className={css.lightboxAction} disabled={copying} onClick={() => { void copy() }}>{tt('image.copy')}</button>
            <a className={css.lightboxDownload} href={image.src} download={imageFileName(image.ref, index)} data-image-download="">{tt('download')}</a>
            <button type="button" className={css.lightboxAction} onClick={onClose}>{tt('preview.close')}</button>
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/** Fetch one result attachment and hand the view a same-origin object URL. */
export async function loadToolImage(_sessionId: SessionId, ref: ImageAttachmentRef): Promise<string> {
  // Tool-result images intentionally do not occur in model-visible session
  // content, so session.readAttachment() rejects them. The plugin route
  // reads the same durable attachment after validating the complete ref.
  const query = new URLSearchParams({
    attachment_id: String(ref.attachmentId),
    media_type: ref.mediaType,
    bytes: String(ref.bytes),
    width: String(ref.width),
    height: String(ref.height),
  })
  const response = await fetch(`${AGENT_IMAGE_API}?${query.toString()}`)
  if (!response.ok) throw new Error(`无法读取图片附件（HTTP ${response.status}）。`)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

/** The inline result view; exported for the preview/e2e fixture. */
export function ImageToolView(props: ImageToolViewProps): React.JSX.Element {
  const refs = useMemo(() => imageRefsOf(props.block), [props.block])
  const { status, message } = resultInfo(props.block)
  const { images, error } = useAttachmentImages(props.sessionId, refs, loadToolImage)
  const [preview, setPreview] = useState<number | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (images.length === 0) return
    document.dispatchEvent(new CustomEvent(CHAT_IMAGE_EVENT, {
      detail: {
        sessionId: props.sessionId,
        refs: images.map(image => image.ref),
      },
    }))
  }, [images, props.sessionId])

  // A shrinking result set (a reload, a reconciled block) must not strand the
  // viewer on an index that no longer exists.
  useEffect(() => {
    if (preview !== null && preview >= images.length) setPreview(images.length === 0 ? null : images.length - 1)
  }, [images.length, preview])

  const openPreview = useCallback((index: number): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPreview(index)
  }, [])

  const closePreview = useCallback((): void => {
    setPreview(null)
    const element = opener.current
    opener.current = null
    element?.focus()
  }, [])

  return <section className={css.root} data-state={status} data-tool={props.toolName}>
    <header className={css.header}>
      <span className={css.icon} aria-hidden="true">▧</span>
      <strong>{props.toolName}</strong>
      <span className={css.status}>{statusLabel(status)}</span>
    </header>
    {message !== '' && <p className={css.message}>{message}</p>}
    {images.length > 0 && <div className={css.images}>
      {images.map((image, index) => <button
        type="button"
        className={css.imageButton}
        key={String(image.ref.attachmentId)}
        title={tt('canvas.preview.expand')}
        aria-label={tt('canvas.preview.expand')}
        data-image-preview-trigger=""
        onClick={() => openPreview(index)}
      >
        <img className={css.image} src={image.src} alt={image.ref.name ?? '生成图片'} />
      </button>)}
    </div>}
    {refs.length > 0 && images.length === 0 && error === null && <p className={css.loading}>正在加载图片…</p>}
    {error !== null && <p className={css.error}>{error}</p>}
    {preview !== null && <ImageLightbox images={images} index={preview} onIndex={setPreview} onClose={closePreview} />}
  </section>
}

/** Register the inline image result view for all image-generation result tools. */
export function registerImageToolviews(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['generate_image', 'edit_image', 'get_image_generation_task']) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key,
        inject: (sessionId: string) => ({ sessionId: sessionId as SessionId }),
      }, ImageToolView)
    }
  })
}

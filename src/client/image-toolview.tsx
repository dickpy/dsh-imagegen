/** Inline renderer for image-generation tool-result attachments. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ClientContext, ISessions, SessionId, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useMemo, useState } from 'react'
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

function isSettled(block: ToolCallBlock): block is Extract<ToolCallBlock, { kind: 'tool-result' }> {
  return 'kind' in block
}

function imageRefsOf(block: ToolCallBlock): ImageAttachmentRef[] {
  if (!isSettled(block)) return []
  return block.content.flatMap(content => content.type === 'image' ? [content.attachment] : [])
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
      urls.push(src)
      return { ref, src }
    }))
      .then(next => {
        if (!disposed) setImages(next)
      })
      .catch(errorValue => {
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

/** Register the inline image result view for all image-generation result tools. */
export function registerImageToolviews(ctx: ClientContext): void {
  // Older client typings still expose the host-side SessionStore on the
  // generic Context property. The runtime service itself provides the newer
  // binding/session face, so resolve it through Cordis and narrow locally.
  const sessions = ctx.get('sessions') as unknown as ISessions | undefined
  const load = async (sessionId: SessionId, ref: ImageAttachmentRef): Promise<string> => {
    const session = sessions?.binding(sessionId)?.session
    if (session === undefined) throw new Error('当前会话不可用，无法读取图片附件。')
    const result = await session.readAttachment(ref.attachmentId)
    if (!result.ok) throw new Error(result.error.message)
    const blob = new Blob([new Uint8Array(result.value.data)], { type: result.value.attachment.mediaType })
    return URL.createObjectURL(blob)
  }

  const ImageToolView = (props: ImageToolViewProps): React.JSX.Element => {
    const refs = useMemo(() => imageRefsOf(props.block), [props.block])
    const { status, message } = resultInfo(props.block)
    const { images, error } = useAttachmentImages(props.sessionId, refs, load)

    return <section className={css.root} data-state={status} data-tool={props.toolName}>
      <header className={css.header}>
        <span className={css.icon} aria-hidden="true">▧</span>
        <strong>{props.toolName}</strong>
        <span className={css.status}>{statusLabel(status)}</span>
      </header>
      {message !== '' && <p className={css.message}>{message}</p>}
      {images.length > 0 && <div className={css.images}>
        {images.map(image => <a
          className={css.imageLink}
          href={image.src}
          key={String(image.ref.attachmentId)}
          rel="noreferrer"
          target="_blank"
          title="打开原图"
        >
          <img className={css.image} src={image.src} alt={image.ref.name ?? '生成图片'} />
        </a>)}
      </div>}
      {refs.length > 0 && images.length === 0 && error === null && <p className={css.loading}>正在加载图片…</p>}
      {error !== null && <p className={css.error}>{error}</p>}
    </section>
  }

  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['generate_image', 'edit_image', 'get_image_generation_task']) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key }, ImageToolView)
    }
  })
}

/** Session-only edit references. Keep the host's primary + four extras contract. */
import { useEffect, useRef, useState } from 'react'
import { describeModel } from '../model-catalog.ts'
import { resolveChannelProtocol, type ChannelConfig } from '../protocol.ts'
import { tt } from './helpers.ts'

export const EDIT_REFERENCE_LIMIT = 5
export const EDIT_REFERENCE_MAX_BYTES = 10 * 1024 * 1024
// The host accepts 24 MiB JSON; 16 MiB of image bytes leaves room for base64
// expansion, prompts and request metadata without changing the host limits.
export const EDIT_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export interface EditReference { id: string; name: string; dataUrl: string; bytes: number }
export type ReferencePasteResult = 'added' | 'empty' | 'cancelled'

/** Current adapter capabilities, not a claim about every vendor's API. */
export function editReferenceLimit(model: string, channel?: Pick<ChannelConfig, 'apiUrl' | 'apiUrlFull' | 'protocol' | 'auth' | 'models'>): number {
  if (channel?.auth === 'subscription') return EDIT_REFERENCE_LIMIT
  if (resolveChannelProtocol(channel?.apiUrl ?? '', channel?.protocol) === 'chat-completions') return EDIT_REFERENCE_LIMIT
  const upstream = channel?.models.find(item => item.alias === model)?.id || model
  const { family } = describeModel(upstream)
  if (family === 'grok' || family === 'nanobanana' || family === 'dall-e') return 1
  if (!channel?.apiUrlFull) {
    let modelScope = false
    try { modelScope = new URL(channel?.apiUrl ?? '').hostname.toLowerCase() === 'api-inference.modelscope.cn' } catch { /* ordinary base URL */ }
    if ((family === 'qwen' && !modelScope) || family === 'minimax') return 1
  }
  return EDIT_REFERENCE_LIMIT
}

export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'))
  if (files.length > 0) return files
  return Array.from(data.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).flatMap(item => {
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

/** Prefer one supported representation per clipboard item to avoid adding a
 *  copied image twice when the browser exposes both PNG and JPEG formats. */
export async function readClipboardImageFiles(clipboard: Pick<Clipboard, 'read'> | undefined): Promise<File[]> {
  if (typeof clipboard?.read !== 'function') throw new Error(tt('edit.pasteUnavailable'))
  const items = await clipboard.read()
  return Promise.all(items.flatMap((item, index) => {
    const type = item.types.find(type => IMAGE_TYPES.has(type))
    if (type === undefined) return []
    const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
    return [item.getType(type).then(blob => new File([blob], `clipboard-${index + 1}.${extension}`, { type }))]
  }))
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('image read failed'))
    reader.onerror = reader.onabort = () => reject(new Error('image read failed'))
    reader.readAsDataURL(file)
  })
}

/** Serial batches preserve selection order even when FileReader finishes out
 * of order. Clear/unmount invalidates in-flight work so old files cannot return. */
export function useEditReferences(onError: (message: string | null) => void) {
  const [images, setImages] = useState<EditReference[]>([])
  const [reading, setReading] = useState(false)
  const current = useRef<EditReference[]>([])
  const queue = useRef(Promise.resolve())
  const epoch = useRef(0)
  const pending = useRef(0)
  const nextId = useRef(0)
  const report = useRef(onError)
  report.current = onError
  useEffect(() => () => { epoch.current += 1 }, [])

  const commit = (next: EditReference[]): void => { current.current = next; setImages(next) }
  const clear = (): void => {
    epoch.current += 1
    pending.current = 0
    queue.current = Promise.resolve()
    commit([])
    setReading(false)
    report.current(null)
  }
  const remove = (id: string): void => { commit(current.current.filter(image => image.id !== id)) }
  const add = (files: Iterable<File> | ArrayLike<File>): void => {
    const incoming = Array.from(files)
    if (incoming.length === 0) return
    const version = epoch.current
    pending.current += 1
    setReading(true)
    report.current(null)
    queue.current = queue.current.then(async () => {
      if (version !== epoch.current) return
      const warnings = new Set<string>()
      const valid = incoming.filter(file => {
        if (!IMAGE_TYPES.has(file.type) || file.size > EDIT_REFERENCE_MAX_BYTES || file.size === 0) {
          warnings.add(tt('edit.invalidFiles'))
          return false
        }
        return true
      })
      const slots = EDIT_REFERENCE_LIMIT - current.current.length
      if (valid.length > slots) warnings.add(tt('edit.limitReached', { count: EDIT_REFERENCE_LIMIT }))
      let bytes = current.current.reduce((sum, image) => sum + image.bytes, 0)
      const candidates = valid.slice(0, slots).filter(file => {
        if (bytes + file.size > EDIT_REFERENCE_TOTAL_BYTES) { warnings.add(tt('edit.totalTooLarge')); return false }
        bytes += file.size
        return true
      })
      const loaded = await Promise.allSettled(candidates.map(readFile))
      if (version !== epoch.current) return
      const additions: EditReference[] = []
      loaded.forEach((result, index) => {
        if (result.status === 'rejected') { warnings.add(tt('edit.readFailed')); return }
        additions.push({ id: `edit-ref-${++nextId.current}`, dataUrl: result.value, name: candidates[index]!.name, bytes: candidates[index]!.size })
      })
      commit([...current.current, ...additions])
      if (warnings.size > 0) report.current([...warnings].join(' '))
    }).catch(() => {
      if (version === epoch.current) report.current(tt('edit.readFailed'))
    }).finally(() => {
      if (version !== epoch.current) return
      pending.current -= 1
      if (pending.current === 0) setReading(false)
    })
  }
  const paste = async (clipboard: Pick<Clipboard, 'read'> | undefined, signal: AbortSignal): Promise<ReferencePasteResult> => {
    const version = epoch.current
    const files = await readClipboardImageFiles(clipboard)
    // The parent can clear references (for example, New creation) while the
    // clipboard permission/read is pending, even if the uploader stays mounted.
    if (signal.aborted || version !== epoch.current) return 'cancelled'
    if (files.length === 0) return 'empty'
    add(files)
    return 'added'
  }
  const replace = (image: Omit<EditReference, 'id'>): void => {
    if (image.bytes > EDIT_REFERENCE_MAX_BYTES) { report.current(tt('edit.invalidFiles')); return }
    clear()
    commit([{ ...image, id: `edit-ref-${++nextId.current}` }])
  }
  return { images, reading, add, paste, remove, clear, replace }
}

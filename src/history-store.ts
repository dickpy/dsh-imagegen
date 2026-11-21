/**
 * Host-persisted generation history: images are stored as individual files
 * under ~/.dsh/dsh-imagegen/images/ and an index.json keeps the metadata +
 * file names. This makes the history survive across browsers/devices that
 * connect to the same DSH host, and keeps list responses small (the browser
 * loads image bytes lazily through the history image route).
 *
 * Framework-free (node:fs only) so the route layer can drive it directly.
 */

import { promises as fs } from 'node:fs'
import { pickImageMetadata } from './image-metadata.ts'
import path from 'node:path'
import type { GenerateMode, HistoryEntry, HistoryEntryInput } from './protocol.ts'
import { notifyImageSaved } from './storage-sync.ts'
import { imageDataRoot } from './image-storage-path.ts'

function imagesDir(root: string): string { return path.join(root, 'images') }
function refsDir(root: string): string { return path.join(root, 'refs') }

// History mutations read and replace one shared index. Serialize them so
// overlapping requests cannot each read an old index and lose the other's row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateHistory<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** One image's on-disk record (file name + mime, never base64). */
interface StoredImage {
  file: string
  mime: string
  revisedPrompt?: string
  durationMs?: number
  width?: number
  height?: number
  model?: string
  channelId?: string
  channel?: string
  upstream?: string
}

/** One entry's on-disk record. */
interface StoredEntry {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: StoredImage[]
  refs?: StoredImage[]
  parentId?: string
  parentImageIndex?: number
  threadId?: string
  refName?: string
  channelId?: string
  channel?: string
  comparisonId?: string
  comparisonModels?: string[]
  workflow?: 'ecommerce'
  projectId?: string
  projectName?: string
  slotKey?: string
  slotLabel?: string
  canvas?: HistoryEntryInput['canvas']
}

/** The index.json shape. */
interface IndexFile {
  entries: StoredEntry[]
}

/** File extension for a MIME type (image file names). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** MIME type for a stored image file name (image route responses). */
function mimeOfFile(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

/** Sanitize an entry id for use as a file-name prefix. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-')
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `entry${cleaned}`
}

/** Treat only a missing index as empty. A failed read must never replace it. */
async function readIndex(root: string): Promise<StoredEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(root, 'index.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const invalidIndex = 'History index is invalid (index.json). Existing history was preserved.'
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) { throw new Error(invalidIndex, { cause: error }) }
  const entries = (parsed as Partial<IndexFile> | null)?.entries
  if (!Array.isArray(entries) || !entries.every(isStoredEntry)) throw new Error(invalidIndex)
  return entries
}

/** Persist the index. */
async function writeIndex(root: string, entries: StoredEntry[]): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  const payload: IndexFile = { entries }
  const index = path.join(root, 'index.json')
  const tmp = `${index}.tmp-${process.pid}`
  try {
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
    await fs.rename(tmp, index)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Structural guard for a stored entry. */
function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && (entry.mode === 'text' || entry.mode === 'edit')
    && (entry.workflow === undefined || entry.workflow === 'ecommerce')
    && (entry.projectId === undefined || typeof entry.projectId === 'string')
    && (entry.projectName === undefined || typeof entry.projectName === 'string')
    && (entry.slotKey === undefined || typeof entry.slotKey === 'string')
    && (entry.slotLabel === undefined || typeof entry.slotLabel === 'string')
    && (entry.refs === undefined || Array.isArray(entry.refs) && entry.refs.every(ref => {
      if (ref === null || typeof ref !== 'object') return false
      const record = ref as Record<string, unknown>
      return typeof record.file === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(record.file)
        && typeof record.mime === 'string'
    }))
    && (entry.parentId === undefined || typeof entry.parentId === 'string')
    && (entry.threadId === undefined || typeof entry.threadId === 'string')
    && (entry.parentImageIndex === undefined || Number.isInteger(entry.parentImageIndex) && Number(entry.parentImageIndex) >= 0)
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.images)
    && entry.images.every(image => {
      if (image === null || typeof image !== 'object') return false
      const record = image as Record<string, unknown>
      return typeof record.file === 'string' && typeof record.mime === 'string'
    })
}

/** Remove one entry's image files (best effort). */
async function removeEntryFiles(root: string, entry: StoredEntry): Promise<void> {
  for (const ref of entry.refs ?? []) {
    if (path.basename(ref.file) === ref.file) await fs.rm(path.join(refsDir(root), ref.file), { force: true }).catch(() => {})
  }
  for (const image of entry.images) {
    if (path.basename(image.file) === image.file) await fs.rm(path.join(imagesDir(root), image.file), { force: true }).catch(() => {})
  }
}

/** Project a stored entry onto the wire shape (image URLs). */
function toWire(entry: StoredEntry): HistoryEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    size: entry.size,
    quality: entry.quality,
    detail: entry.detail,
    n: entry.n,
    images: entry.images.map(image => ({
      url: `/api/dsh-imagegen/history/image/${image.file}`,
      mime: image.mime,
      ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
      ...image.durationMs === undefined ? {} : { durationMs: image.durationMs },
      ...pickImageMetadata(image),
    })),
    refs: (entry.refs ?? []).map(ref => ({ url: `/api/dsh-imagegen/history/image/refs/${ref.file}`, mime: ref.mime })),
    parentId: entry.parentId,
    parentImageIndex: entry.parentImageIndex,
    threadId: entry.threadId,
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
    ...entry.comparisonId === undefined ? {} : { comparisonId: entry.comparisonId },
    ...entry.comparisonModels === undefined ? {} : { comparisonModels: entry.comparisonModels },
    ...entry.workflow === undefined ? {} : { workflow: entry.workflow },
    ...entry.projectId === undefined ? {} : { projectId: entry.projectId },
    ...entry.projectName === undefined ? {} : { projectName: entry.projectName },
    ...entry.slotKey === undefined ? {} : { slotKey: entry.slotKey },
    ...entry.slotLabel === undefined ? {} : { slotLabel: entry.slotLabel },
    ...entry.canvas === undefined ? {} : { canvas: entry.canvas },
  }
}

/** List the persisted history, newest first, as wire entries. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const entries = await readIndex(imageDataRoot())
  return entries.map(toWire)
}

/** Append one generation while retaining all previous records and files. */
export async function appendHistory(input: HistoryEntryInput): Promise<HistoryEntry[]> {
  const root = imageDataRoot()
  return mutateHistory(async () => {
    const previous = await readIndex(root)
    if (previous.some(entry => entry.id === input.id)) return previous.map(toWire)
    await fs.mkdir(imagesDir(root), { recursive: true })
    await fs.mkdir(refsDir(root), { recursive: true })
    const prefix = safeId(input.id)
    const storedImages: StoredImage[] = []
    const storedRefs: StoredImage[] = []
    const writtenFiles: string[] = []
    const writeImage = async (filePath: string, b64: string): Promise<void> => {
      const handle = await fs.open(filePath, 'wx')
      writtenFiles.push(filePath)
      try { await handle.writeFile(Buffer.from(b64, 'base64')) } finally { await handle.close() }
    }
    const parent = input.mode === 'edit' ? previous.find(entry => entry.id === input.parentId) : undefined
    const parentIndex = input.parentImageIndex ?? 0
    const lineage = parent?.images[parentIndex] === undefined ? {} : {
      parentId: parent.id, parentImageIndex: parentIndex, threadId: parent.threadId ?? parent.id,
    }
    const entry: StoredEntry = {
      id: input.id,
      createdAt: input.createdAt,
      mode: input.mode,
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      detail: input.detail,
      n: input.n,
      images: storedImages,
      refs: storedRefs,
      ...lineage,
      ...input.refName === undefined ? {} : { refName: input.refName },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
      ...input.comparisonId === undefined ? {} : { comparisonId: input.comparisonId },
      ...input.comparisonModels === undefined ? {} : { comparisonModels: input.comparisonModels },
      ...input.workflow === undefined ? {} : { workflow: input.workflow },
      ...input.projectId === undefined ? {} : { projectId: input.projectId },
      ...input.projectName === undefined ? {} : { projectName: input.projectName },
      ...input.slotKey === undefined ? {} : { slotKey: input.slotKey },
      ...input.slotLabel === undefined ? {} : { slotLabel: input.slotLabel },
      ...input.canvas === undefined ? {} : { canvas: input.canvas },
    }
    const merged = [entry, ...previous]
    try {
      for (let index = 0; index < input.images.length; index++) {
        const image = input.images[index]!
        const file = `${prefix}-${index}.${extensionOf(image.mime)}`
        await writeImage(path.join(imagesDir(root), file), image.b64)
        storedImages.push({
          file,
          mime: image.mime,
          ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
          ...image.durationMs === undefined ? {} : { durationMs: image.durationMs },
          ...pickImageMetadata(image),
        })
      }
      const refs = input.refs ?? []
      const sizes = refs.map(ref => Buffer.byteLength(ref.b64, 'base64'))
      if (sizes.every(size => size <= 10 * 1024 * 1024) && sizes.reduce((sum, size) => sum + size, 0) <= 16 * 1024 * 1024) {
        for (const [index, ref] of refs.slice(0, 5).entries()) {
          const file = `${prefix}-ref-${index}.${extensionOf(ref.mime)}`
          await writeImage(path.join(refsDir(root), file), ref.b64)
          storedRefs.push({ file, mime: ref.mime })
        }
      }
      await writeIndex(root, merged)
    } catch (error) {
      for (const file of writtenFiles) await fs.rm(file, { force: true }).catch(() => {})
      throw error
    }
    for (const image of storedImages) notifyImageSaved('history', path.join(imagesDir(root), image.file))
    return merged.map(toWire)
  })
}

/** Remove one entry (and its image files). */
export async function removeHistory(id: string): Promise<HistoryEntry[]> {
  const root = imageDataRoot()
  return mutateHistory(async () => {
    const previous = await readIndex(root)
    const targets = previous.filter(entry => entry.id === id)
    if (targets.length === 0) return previous.map(toWire)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(root, kept)
    for (const target of targets) await removeEntryFiles(root, target)
    return kept.map(toWire)
  })
}

/** Remove every entry (and all image files). */
export async function clearHistory(): Promise<HistoryEntry[]> {
  const root = imageDataRoot()
  return mutateHistory(async () => {
    const previous = await readIndex(root)
    await writeIndex(root, [])
    for (const entry of previous) await removeEntryFiles(root, entry)
    return []
  })
}

/** Read one stored image file by its (validated) file name. */
export async function readHistoryImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const reference = file.startsWith('refs/')
  if (reference) file = file.slice('refs/'.length)
  // Only accept <id>-<index>.<png|jpg|jpeg|webp|gif> — the exact names this
  // store writes — so the route can never escape the images directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return undefined
  try {
    const root = imageDataRoot()
    const data = await fs.readFile(path.join(reference ? refsDir(root) : imagesDir(root), file))
    return { data, mime: mimeOfFile(file) }
  } catch {
    return undefined
  }
}

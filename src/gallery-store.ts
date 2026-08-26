/**
 * Host-persisted gallery (user-curated favorites): mirrors the history store
 * (image files + an index.json under ~/.dsh/dsh-imagegen/gallery/) but with no
 * size cap — every entry is an explicit user choice. Appends are deduplicated
 * by image content so adding the same generated image twice is a no-op.
 *
 * Framework-free (node:fs + node:crypto only) so the route layer can drive it
 * directly.
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { GenerateMode, HistoryEntry, HistoryEntryInput } from './protocol.ts'

const HISTORY_DIR = path.join(homedir(), '.dsh', 'dsh-imagegen')
const GALLERY_DIR = path.join(HISTORY_DIR, 'gallery')
const INDEX_PATH = path.join(GALLERY_DIR, 'index.json')
const IMAGES_DIR = path.join(GALLERY_DIR, 'images')

/** One gallery entry carries the same wire shape as a history entry. */
export interface GalleryAppendResult {
  /** The full gallery list after the append (newest first). */
  entries: HistoryEntry[]
  /** Whether a new entry was added (false = a content-identical image was
   *  already in the gallery, so the append was skipped). */
  added: boolean
}

// Gallery mutations read and replace one shared index. Serialize them so
// overlapping requests cannot each read an old index and lose the other's row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateGallery<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** One image's on-disk record (file name + mime, never base64). */
interface StoredImage {
  file: string
  mime: string
  revisedPrompt?: string
}

/** One entry's on-disk record. `hash` fingerprints the first image so the
 *  store can refuse duplicate appends cheaply. */
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
  hash?: string
  refName?: string
  tags?: string[]
  channelId?: string
  channel?: string
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
  return cleaned === '' ? 'entry' : cleaned
}

/** Short content fingerprint of the entry's first image. */
function fingerprint(input: HistoryEntryInput): string | undefined {
  const first = input.images[0]
  if (first === undefined) return undefined
  return createHash('sha1').update(first.b64).digest('hex')
}

/** Ensure the storage directories exist. */
async function ensureDirs(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true })
}

/** Read the index, tolerating a missing/corrupt file. */
async function readIndex(): Promise<StoredEntry[]> {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return []
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return []
    return entries.filter(isStoredEntry)
  } catch {
    return []
  }
}

/** Persist the index. */
async function writeIndex(entries: StoredEntry[]): Promise<void> {
  await ensureDirs()
  const payload: IndexFile = { entries }
  const tmp = `${INDEX_PATH}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
  await fs.rename(tmp, INDEX_PATH)
}

/** Structural guard for a stored entry. */
function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && (entry.mode === 'text' || entry.mode === 'edit')
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.images)
    && entry.images.every(image => {
      if (image === null || typeof image !== 'object') return false
      const record = image as Record<string, unknown>
      return typeof record.file === 'string' && typeof record.mime === 'string'
    })
}

/** Remove one entry's image files (best effort). */
async function removeEntryFiles(entry: StoredEntry): Promise<void> {
  for (const image of entry.images) {
    try { await fs.rm(path.join(IMAGES_DIR, image.file), { force: true }) } catch { /* ignore */ }
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
      url: `/api/dsh-imagegen/gallery/image/${image.file}`,
      mime: image.mime,
      ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
    })),
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.tags === undefined ? {} : { tags: entry.tags },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
  }
}

/** List the persisted gallery, newest first, as wire entries. */
export async function listGallery(): Promise<HistoryEntry[]> {
  const entries = await readIndex()
  return entries.map(toWire)
}

/** Append one image to the gallery. Deduplicates by first-image content —
 *  appending an image already in the gallery returns `added: false` with the
 *  list unchanged. No size cap: every entry is an explicit user choice. */
export async function appendGallery(input: HistoryEntryInput): Promise<GalleryAppendResult> {
  return mutateGallery(async () => {
    await ensureDirs()
    const hash = fingerprint(input)
    if (hash !== undefined) {
      const existing = await readIndex()
      if (existing.some(entry => entry.hash === hash)) {
        return { entries: existing.map(toWire), added: false }
      }
    }
    const prefix = safeId(input.id)
    const storedImages: StoredImage[] = []
    try {
      for (let index = 0; index < input.images.length; index++) {
        const image = input.images[index]!
        const file = `${prefix}-${index}.${extensionOf(image.mime)}`
        await fs.writeFile(path.join(IMAGES_DIR, file), Buffer.from(image.b64, 'base64'))
        storedImages.push({
          file,
          mime: image.mime,
          ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
        })
      }
    } catch (error) {
      await removeEntryFiles({ images: storedImages } as StoredEntry)
      throw error
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
      ...hash === undefined ? {} : { hash },
      ...input.refName === undefined ? {} : { refName: input.refName },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
    }
    const merged = [entry, ...await readIndex()]
    await writeIndex(merged)
    return { entries: merged.map(toWire), added: true }
  })
}

/** Remove one entry (and its image files). */
export async function removeGallery(id: string): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    if (target !== undefined) await removeEntryFiles(target)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Replace the user-managed labels for one gallery entry. */
export async function updateGalleryTags(id: string, tags: string[]): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const normalized = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 20)
    const entries = await readIndex()
    const target = entries.find(entry => entry.id === id)
    if (target !== undefined) target.tags = normalized
    await writeIndex(entries)
    return entries.map(toWire)
  })
}

/** Remove every entry (and all image files). */
export async function clearGallery(): Promise<HistoryEntry[]> {
  return mutateGallery(async () => {
    const previous = await readIndex()
    for (const entry of previous) await removeEntryFiles(entry)
    await writeIndex([])
    return []
  })
}

/** Read one stored image file by its (validated) file name. */
export async function readGalleryImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  // Only accept <id>-<index>.<png|jpg|jpeg|webp|gif> — the exact names this
  // store writes — so the route can never escape the images directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return undefined
  try {
    const data = await fs.readFile(path.join(IMAGES_DIR, file))
    return { data, mime: mimeOfFile(file) }
  } catch {
    return undefined
  }
}

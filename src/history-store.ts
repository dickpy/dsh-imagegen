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
import { homedir } from 'node:os'
import path from 'node:path'
import { HISTORY_MAX, type GenerateMode, type HistoryEntry, type HistoryEntryInput } from './protocol.ts'

const HISTORY_DIR = path.join(homedir(), '.dsh', 'dsh-imagegen')
const INDEX_PATH = path.join(HISTORY_DIR, 'index.json')
const IMAGES_DIR = path.join(HISTORY_DIR, 'images')

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
    && (entry.workflow === undefined || entry.workflow === 'ecommerce')
    && (entry.projectId === undefined || typeof entry.projectId === 'string')
    && (entry.projectName === undefined || typeof entry.projectName === 'string')
    && (entry.slotKey === undefined || typeof entry.slotKey === 'string')
    && (entry.slotLabel === undefined || typeof entry.slotLabel === 'string')
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
      url: `/api/dsh-imagegen/history/image/${image.file}`,
      mime: image.mime,
      ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
    })),
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
  }
}

/** List the persisted history, newest first, as wire entries. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const entries = await readIndex()
  return entries.map(toWire)
}

/** Append one generation, evicting the oldest beyond HISTORY_MAX. */
export async function appendHistory(input: HistoryEntryInput): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    await ensureDirs()
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
    }
    const merged = [entry, ...await readIndex()]
    const kept = merged.slice(0, HISTORY_MAX)
    for (const dropped of merged.slice(HISTORY_MAX)) await removeEntryFiles(dropped)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Remove one entry (and its image files). */
export async function removeHistory(id: string): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    if (target !== undefined) await removeEntryFiles(target)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    return kept.map(toWire)
  })
}

/** Remove every entry (and all image files). */
export async function clearHistory(): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    const previous = await readIndex()
    for (const entry of previous) await removeEntryFiles(entry)
    await writeIndex([])
    return []
  })
}

/** Read one stored image file by its (validated) file name. */
export async function readHistoryImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
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

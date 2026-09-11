/**
 * Dependency-free ZIP reading.
 *
 * Skills arrive as archives (GitHub source zips, hand-made bundles) and OOXML
 * documents are ZIP containers, so both the skill library and the text
 * extractor need to walk a central directory and inflate entries. Doing it with
 * `node:zlib` keeps the plugin free of native dependencies.
 *
 * Only the *reading* path is implemented, and every read is bounded: an entry
 * is skipped when its header lies outside the buffer or when its declared size
 * exceeds the caller's cap, so a hostile archive cannot make the host allocate
 * unbounded memory.
 */

import { inflateRawSync } from 'node:zlib'

/** One entry of a ZIP central directory. */
export interface ZipEntry {
  /** Entry path as stored (forward slashes, may end with `/` for folders). */
  name: string
  /** 0 = stored, 8 = deflate. Everything else is treated as unsupported. */
  method: number
  /** Declared uncompressed size (0 when the archive uses a data descriptor). */
  uncompressedSize: number
  compressedSize: number
  localHeaderOffset: number
  /** Unix mode bits from the external attributes, when the archive carries them. */
  mode: number
}

/** Maximum number of entries inspected in one archive. */
export const MAX_ZIP_ENTRIES = 2_000

/** Read a ZIP central directory. Returns an empty list for a non-ZIP buffer. */
export function readZipDirectory(data: Buffer): ZipEntry[] {
  const maxScan = Math.min(data.length, 66_000)
  let eocd = -1
  for (let offset = data.length - 22; offset >= data.length - maxScan && offset >= 0; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) return []
  const count = Math.min(data.readUInt16LE(eocd + 10), MAX_ZIP_ENTRIES)
  let cursor = data.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count && cursor + 46 <= data.length; index += 1) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) break
    const method = data.readUInt16LE(cursor + 10)
    const compressedSize = data.readUInt32LE(cursor + 20)
    const uncompressedSize = data.readUInt32LE(cursor + 24)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const mode = data.readUInt32LE(cursor + 38) >>> 16
    const localHeaderOffset = data.readUInt32LE(cursor + 42)
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, uncompressedSize, compressedSize, localHeaderOffset, mode })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Inflate one entry.
 * @param data - the whole archive.
 * @param entry - an entry from {@link readZipDirectory}.
 * @param maxBytes - refuse entries larger than this (uncompressed).
 * @returns the entry bytes, or undefined when it cannot be read safely.
 */
export function readZipEntry(data: Buffer, entry: ZipEntry, maxBytes = 8 * 1024 * 1024): Buffer | undefined {
  if (entry.uncompressedSize > maxBytes) return undefined
  const header = entry.localHeaderOffset
  if (header + 30 > data.length || data.readUInt32LE(header) !== 0x04034b50) return undefined
  const nameLength = data.readUInt16LE(header + 26)
  const extraLength = data.readUInt16LE(header + 28)
  const start = header + 30 + nameLength + extraLength
  const end = entry.compressedSize === 0 ? data.length : Math.min(data.length, start + entry.compressedSize)
  if (start > data.length || end < start) return undefined
  const raw = data.subarray(start, end)
  try {
    if (entry.method === 0) {
      if (raw.length > maxBytes) return undefined
      return Buffer.from(raw)
    }
    if (entry.method === 8) {
      const inflated = inflateRawSync(raw, { maxOutputLength: maxBytes })
      return inflated
    }
  } catch { return undefined }
  return undefined
}

/** Whether a directory entry name looks like a folder marker. */
export function isZipDirectory(entry: ZipEntry): boolean {
  // MS-DOS directory bit, or the conventional trailing slash.
  return entry.name.endsWith('/') || (entry.mode & 0o170000) === 0o040000
}

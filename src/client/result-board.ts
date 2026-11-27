/**
 * Shared helper for the two result surfaces.
 *
 * The studio board (StudioResults) and the plain history/gallery grid in the
 * panel show the same pictures with different card chrome; downloads have to
 * behave identically on both, so the original-bytes download lives here.
 *
 * Downloads deliberately go through a Blob URL instead of a `data:` URL. A
 * 7.5 MB PNG becomes a ~10 MB base64 string, and Chromium can leave a 0-byte
 * file behind when that URL meets the "Save as" dialog (#108). Blob URLs keep
 * the bytes in the browser's blob store and let the download start without
 * decoding a giant data URL.
 */

import type { GeneratedImage } from '../protocol.ts'

function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** Decode base64 image bytes without turning the whole payload into a data URL. */
export function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Save one Blob under a readable name. The object URL is revoked later, not
 * immediately: the save dialog reads it asynchronously, and revoking during
 * that window is another way to end up with an empty file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
}

/** Download the original bytes (never a re-encoded copy). */
export function downloadImage(image: GeneratedImage, name: string): void {
  downloadBlob(new Blob([bytesFromBase64(image.b64)], { type: image.mime }), `${name}.${extensionOf(image.mime)}`)
}

/**
 * Download an already-addressable image (gallery route, canvas asset, remote
 * preview). The bytes are fetched first so the browser never has to treat a
 * `data:` URL as a file, and a failed fetch can be surfaced instead of quietly
 * producing an empty download.
 */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  downloadBlob(await response.blob(), filename)
}

/** File extension for a MIME type, for callers that build their own names. */
export function imageExtension(mime: string): string {
  return extensionOf(mime)
}

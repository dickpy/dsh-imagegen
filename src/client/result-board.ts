/**
 * Shared helper for the two result surfaces.
 *
 * The studio board (StudioResults) and the plain history/gallery grid in the
 * panel show the same pictures with different card chrome; downloads have to
 * behave identically on both, so the original-bytes download lives here.
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

/** Download the original bytes (never a re-encoded copy). */
export function downloadImage(image: GeneratedImage, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = `data:${image.mime};base64,${image.b64}`
  anchor.download = `${name}.${extensionOf(image.mime)}`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

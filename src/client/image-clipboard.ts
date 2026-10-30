import type { GeneratedImage } from '../protocol.ts'

/** Clipboard image support is most reliable as PNG, including for JPEG/WebP results. */
function pngBlob(image: GeneratedImage): Promise<Blob> {
  const binary = atob(image.b64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (image.mime.split(';')[0]?.trim().toLowerCase() === 'image/png') {
    return Promise.resolve(new Blob([bytes], { type: 'image/png' }))
  }
  return new Promise((resolve, reject) => {
    const source = new Image()
    source.onerror = () => reject(new Error('Unable to decode image'))
    source.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = source.naturalWidth
      canvas.height = source.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null || canvas.width === 0 || canvas.height === 0) { reject(new Error('Image conversion unavailable')); return }
      context.drawImage(source, 0, 0)
      canvas.toBlob(blob => blob === null ? reject(new Error('Image conversion failed')) : resolve(blob), 'image/png')
    }
    source.src = `data:${image.mime};base64,${image.b64}`
  })
}

/** Start the clipboard write in the click handler, before asynchronous decoding. */
export async function copyGeneratedImage(image: GeneratedImage): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) throw new Error('Image clipboard unavailable')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(image) })])
}

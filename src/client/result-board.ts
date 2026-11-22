/**
 * Shared plumbing for the two result surfaces.
 *
 * The studio board (StudioResults) and the plain history/gallery grid in the
 * panel render the same pictures with different card chrome, so the parts that
 * decide *where* the pictures go — board measurement, aspect probing, packing,
 * downloads — live here instead of being duplicated (and drifting) per surface.
 */

import { useEffect, useState } from 'react'
import type { GeneratedImage } from '../protocol.ts'

/**
 * Board size in CSS pixels. The packing depends on the space the panel actually
 * gives the sheet, so it is measured (and re-measured on resize) rather than
 * assumed. jsdom has no ResizeObserver, hence the guard.
 */
export function useBoardSize(ref: { current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize(current => current.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref])
  return size
}

/**
 * Aspect ratios in display order.
 *
 * History records often arrive without decoded dimensions, and a packing built
 * on guessed squares would jump once the pictures land. Missing sizes are
 * measured once here (the bytes are already in memory) and the board re-plans
 * with the real shapes.
 */
export function useResultAspects(keys: string[], images: (GeneratedImage | undefined)[]): number[] {
  const [measured, setMeasured] = useState<Record<string, number>>({})
  const signature = keys.join('|')
  useEffect(() => {
    const missing = images
      .map((image, index) => ({ image, key: keys[index]! }))
      .filter((entry): entry is { image: GeneratedImage; key: string } => entry.image !== undefined
        && (entry.image.width === undefined || entry.image.height === undefined)
        && measured[entry.key] === undefined)
    if (missing.length === 0) return
    let disposed = false
    const found: Record<string, number> = {}
    let pending = missing.length
    const settle = (): void => {
      pending -= 1
      // Nothing measured (a corrupt payload) must not re-trigger this effect
      // forever: without new ratios there is nothing to publish.
      if (pending === 0 && !disposed && Object.keys(found).length > 0) setMeasured(current => ({ ...current, ...found }))
    }
    for (const { image, key } of missing) {
      const probe = new Image()
      probe.onload = () => {
        if (probe.naturalHeight > 0) found[key] = probe.naturalWidth / probe.naturalHeight
        settle()
      }
      probe.onerror = () => { settle() }
      probe.src = `data:${image.mime};base64,${image.b64}`
    }
    return () => { disposed = true }
    // `signature` covers the identities; the arrays themselves are rebuilt every render.
  }, [signature, measured])
  return images.map((image, index) => {
    if (image === undefined) return 1
    if (image.width !== undefined && image.height !== undefined && image.height > 0) return image.width / image.height
    return measured[keys[index]!] ?? 1
  })
}

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

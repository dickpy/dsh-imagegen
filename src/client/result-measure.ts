/**
 * Measurements the result surfaces need before they can size their cards.
 *
 * Both the studio board and the plain history / gallery grid place pictures
 * inside cards, and a card must fit its picture. Two facts are therefore
 * needed: how big the sheet is, and what shape each picture is.
 */

import { useCallback, useEffect, useState } from 'react'
import type { GeneratedImage } from '../protocol.ts'

/**
 * Sheet size in CSS pixels.
 *
 * A ref object would be the obvious API, but the sheet is mounted well after
 * its owner first renders (the grid only exists once there are pictures), and
 * an effect that reads `ref.current` once would run against `null` and never
 * look again — the whole measurement then silently falls back to "unknown".
 * A callback ref gets a fresh effect every time the node attaches or leaves.
 */
export function useSheetSize(): [(node: HTMLElement | null) => void, { width: number; height: number }] {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const attach = useCallback((next: HTMLElement | null) => { setNode(current => current === next ? current : next) }, [])
  useEffect(() => {
    if (node === null) return
    const measure = (): void => {
      const next = { width: node.clientWidth, height: node.clientHeight }
      setSize(current => current.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // A drag of the panel edge fires many observer callbacks; fold them into one
    // measurement per frame so the board is not re-planned dozens of times.
    let frame = 0
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { measure(); return }
      if (frame !== 0) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [node])
  return [attach, size]
}

/**
 * Aspect ratios for the sheet, in slot order.
 *
 * A history record often arrives without decoded dimensions, and a card sized
 * for a guessed square would letterbox a 16:9 render again. Missing sizes are
 * measured once here (the bytes are already in memory) and the sheet re-plans
 * with the real shapes.
 *
 * `keys` must identify each picture, not just its slot: a retried slot keeps
 * its id but receives a different picture, and a cached ratio from the old one
 * would size the new card wrongly.
 */
export function useResultAspects(keys: string[], images: (GeneratedImage | undefined)[]): (number | undefined)[] {
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
      probe.onerror = () => {
        // A payload that will not decode is reported as 1 so the effect stops
        // re-probing it; the card then falls back to a square cell.
        found[key] = 1
        settle()
      }
      probe.src = `data:${image.mime};base64,${image.b64}`
    }
    return () => { disposed = true }
    // `signature` covers the identities; the arrays themselves are rebuilt every render.
  }, [signature, measured])
  return images.map((image, index) => {
    if (image === undefined) return undefined
    if (image.width !== undefined && image.height !== undefined && image.height > 0) return image.width / image.height
    return measured[keys[index]!]
  })
}

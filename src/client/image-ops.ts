/**
 * Browser-side raster helpers behind the canvas image tools. Everything runs on
 * the 2D canvas: no extra dependency, no upstream call and no API cost.
 *
 *  - `loadRaster`        decode an asset URL into a canvas
 *  - `cropRaster`        cut a normalized rectangle out of a canvas
 *  - `drawAnnotation`    burn the annotation boxes onto a copy of the image (the
 *                        reference the image model receives for an annotation edit)
 *  - `removeBackground`  local matting: flood the border-connected background
 *                        away and write a real alpha channel
 */

import type { CanvasRect } from '../protocol.ts'

/** Decode one image URL (same-origin canvas asset or data URL) into a canvas. */
export async function loadRaster(url: string, maxSide = 2048): Promise<HTMLCanvasElement> {
  const image = await loadImageElement(url)
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1)) : 1
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale))
  const canvas = createCanvas(width, height)
  context2d(canvas).drawImage(image, 0, 0, width, height)
  return canvas
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取图片像素'))
    image.src = url
  })
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('当前浏览器不支持 canvas 2d')
  return ctx
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

/** Letterboxed rect of an `object-fit: contain` image inside its container. */
export function containRect(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number): { left: number; top: number; width: number; height: number } {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(1, containerWidth), height: Math.max(1, containerHeight) }
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Normalized rect spanned by two points inside a client-space image box. */
export function rectBetween(from: { x: number; y: number }, to: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }): CanvasRect {
  const x1 = clamp01((from.x - box.left) / box.width)
  const y1 = clamp01((from.y - box.top) / box.height)
  const x2 = clamp01((to.x - box.left) / box.width)
  const y2 = clamp01((to.y - box.top) / box.height)
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/** Clamp a normalized rect onto [0,1] and return it in pixels. */
export function rectToPixels(rect: CanvasRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(1, rect.x))
  const y = Math.max(0, Math.min(1, rect.y))
  const w = Math.max(0.002, Math.min(1 - x, rect.width))
  const h = Math.max(0.002, Math.min(1 - y, rect.height))
  const px = Math.max(0, Math.min(width - 1, Math.round(x * width)))
  const py = Math.max(0, Math.min(height - 1, Math.round(y * height)))
  return {
    x: px,
    y: py,
    width: Math.max(1, Math.min(width - px, Math.round(w * width))),
    height: Math.max(1, Math.min(height - py, Math.round(h * height))),
  }
}

/** Cut one normalized rectangle out of a canvas. */
export function cropRaster(source: HTMLCanvasElement, rect: CanvasRect): HTMLCanvasElement {
  const box = rectToPixels(rect, source.width, source.height)
  const canvas = createCanvas(box.width, box.height)
  context2d(canvas).drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
  return canvas
}

/** Fraction of pixels that are (mostly) transparent already. */
export function transparencyRatio(source: HTMLCanvasElement, step = 4): number {
  const { width, height } = source
  if (width === 0 || height === 0) return 0
  const data = context2d(source).getImageData(0, 0, width, height).data
  let clear = 0
  let seen = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      seen += 1
      if (data[(y * width + x) * 4 + 3]! < 32) clear += 1
    }
  }
  return seen === 0 ? 0 : clear / seen
}

/**
 * Draw the annotation boxes onto a copy of the source image. The result is the
 * edit reference: the model sees the original picture plus a clearly marked
 * region, so "only change inside the box" is unambiguous.
 */
export function drawAnnotation(
  source: HTMLCanvasElement,
  boxes: Array<{ rect: CanvasRect; index: number }>,
): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height)
  const ctx = context2d(canvas)
  ctx.drawImage(source, 0, 0)
  // Stroke width and label size scale with the image so the mark stays visible
  // on small previews and does not swallow large ones.
  const stroke = Math.max(2, Math.round(Math.min(source.width, source.height) * 0.006))
  const fontSize = Math.max(12, Math.round(stroke * 5))
  for (const box of boxes) {
    const { x, y, width, height } = rectToPixels(box.rect, source.width, source.height)
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#ff2d55'
    ctx.lineWidth = stroke * 2.2
    ctx.strokeRect(x, y, width, height)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = stroke
    ctx.strokeRect(x, y, width, height)
    // Numbered tag so the prompt can address each box by index.
    const label = String(box.index + 1)
    ctx.font = `600 ${fontSize}px sans-serif`
    const padding = Math.round(fontSize * 0.4)
    const tagWidth = Math.max(fontSize * 1.1, ctx.measureText(label).width + padding * 2)
    const tagHeight = Math.round(fontSize * 1.5)
    const tagX = Math.min(x, Math.max(0, source.width - tagWidth))
    const tagY = Math.max(0, y - tagHeight)
    ctx.fillStyle = '#ff2d55'
    ctx.fillRect(tagX, tagY, tagWidth, tagHeight)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(label, tagX + tagWidth / 2, tagY + tagHeight / 2)
    ctx.restore()
  }
  return canvas
}

export interface BackgroundRemovalResult {
  canvas: HTMLCanvasElement
  /** Fraction of pixels turned transparent (0..1). */
  removedRatio: number
  /** Distance threshold actually used. */
  tolerance: number
}

/**
 * Merge an annotated edit back onto the clean original.
 *
 * The reference sent to the image model carries red marker boxes, and models
 * routinely echo those marks into the result. This keeps the generated content
 * only inside the marked boxes (shrunk by `inset` pixels so the marker stroke
 * itself is discarded) and restores the untouched original everywhere else —
 * which is exactly what "only change inside the box" promised.
 */
export function compositeAnnotatedResult(
  result: HTMLCanvasElement,
  original: HTMLCanvasElement,
  boxes: CanvasRect[],
  inset = 0,
): HTMLCanvasElement {
  const width = result.width
  const height = result.height
  const canvas = createCanvas(width, height)
  const ctx = context2d(canvas)
  ctx.drawImage(result, 0, 0)
  // Original copy with the box interiors punched out. Cover-fit keeps its
  // aspect when the model answered with a different frame shape.
  const patch = createCanvas(width, height)
  const patchCtx = context2d(patch)
  const scale = Math.max(width / Math.max(1, original.width), height / Math.max(1, original.height))
  const drawWidth = original.width * scale
  const drawHeight = original.height * scale
  patchCtx.drawImage(original, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
  patchCtx.globalCompositeOperation = 'destination-out'
  patchCtx.fillStyle = '#000000'
  for (const box of boxes) {
    const px = rectToPixels(box, width, height)
    const pad = Math.max(0, Math.min(inset, Math.floor(Math.min(px.width, px.height) / 2) - 1))
    patchCtx.fillRect(px.x + pad, px.y + pad, Math.max(1, px.width - pad * 2), Math.max(1, px.height - pad * 2))
  }
  patchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(patch, 0, 0)
  return canvas
}

/** Perceptual RGB distance, normalized so 0..255 reads like a channel delta. */
function colorDistance(data: Uint8ClampedArray, offset: number, r: number, g: number, b: number): number {
  const dr = data[offset]! - r
  const dg = data[offset + 1]! - g
  const db = data[offset + 2]! - b
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3)
}

interface ReferenceColor { r: number; g: number; b: number }

/**
 * Local background removal. Border pixels are sampled into a small set of
 * reference colors, then a 4-neighbour flood fill from the image border marks
 * every pixel that both matches a reference and is connected to the border —
 * so same-colored details inside the subject survive. A short distance
 * transform turns the hard mask into a 2px alpha ramp, which removes the
 * stair-stepped edge without smearing the subject.
 */
export function removeBackground(source: HTMLCanvasElement, tolerance?: number): BackgroundRemovalResult {
  const { width, height } = source
  // Work on a copy: the caller keeps the untouched original for retries.
  const canvas = createCanvas(width, height)
  const ctx = context2d(canvas)
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  const total = width * height

  // --- 1. border reference colors (2px ring, quantized into 4-bit buckets)
  const ring = Math.max(1, Math.min(3, Math.floor(Math.min(width, height) / 8)))
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  const tally = (x: number, y: number): void => {
    const offset = (y * width + x) * 4
    if (data[offset + 3]! < 8) return
    const r = data[offset]!
    const g = data[offset + 1]!
    const b = data[offset + 2]!
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { count: 1, r, g, b })
    else {
      bucket.count += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < ring; y += 1) { tally(x, y); tally(x, height - 1 - y) }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < ring; x += 1) { tally(x, y); tally(width - 1 - x, y) }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count)
  const sampleTotal = ranked.reduce((sum, bucket) => sum + bucket.count, 0)
  if (sampleTotal === 0 || ranked.length === 0) return { canvas, removedRatio: 0, tolerance: 0 }
  // Keep the dominant border colors (at most four) that together cover 92% of
  // the sampled ring: a plain backdrop is one bucket, a gradient is a few.
  const references: ReferenceColor[] = []
  let covered = 0
  for (const bucket of ranked) {
    references.push({ r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count })
    covered += bucket.count
    if (references.length >= 4 || covered / sampleTotal >= 0.92) break
  }

  // --- 2. per-pixel distance to the nearest reference color (one pass)
  const distanceToReference = new Uint8Array(total)
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    let best = 255
    for (const reference of references) {
      const distance = colorDistance(data, offset, reference.r, reference.g, reference.b)
      if (distance < best) best = distance
    }
    distanceToReference[index] = Math.min(255, Math.round(best))
  }

  // --- 3. tolerance: explicit, or derived from the ring's own spread
  let threshold = tolerance ?? 0
  if (threshold <= 0) {
    const samples: number[] = []
    const step = Math.max(1, Math.floor(Math.min(width, height) / 160))
    for (let x = 0; x < width; x += step) {
      for (let y = 0; y < ring * 2; y += 1) {
        samples.push(distanceToReference[y * width + x]!)
        samples.push(distanceToReference[(height - 1 - y) * width + x]!)
      }
    }
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < ring * 2; x += 1) {
        samples.push(distanceToReference[y * width + x]!)
        samples.push(distanceToReference[y * width + width - 1 - x]!)
      }
    }
    samples.sort((a, b) => a - b)
    const p90 = samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))]!
    threshold = Math.min(96, Math.max(20, p90 * 1.45 + 8))
  }

  // --- 4. flood fill from the border
  const background = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  const push = (index: number): void => {
    if (background[index] === 1) return
    background[index] = 1
    queue[tail++] = index
  }
  const seed = (index: number): void => {
    if (data[index * 4 + 3]! < 8 || distanceToReference[index]! <= threshold) push(index)
  }
  for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x) }
  for (let y = 0; y < height; y += 1) { seed(y * width); seed(y * width + width - 1) }
  while (head < tail) {
    const index = queue[head++]!
    const x = index % width
    const y = (index - x) / width
    if (x > 0) { const next = index - 1; if (background[next] === 0 && distanceToReference[next]! <= threshold) push(next) }
    if (x < width - 1) { const next = index + 1; if (background[next] === 0 && distanceToReference[next]! <= threshold) push(next) }
    if (y > 0) { const next = index - width; if (background[next] === 0 && distanceToReference[next]! <= threshold) push(next) }
    if (y < height - 1) { const next = index + width; if (background[next] === 0 && distanceToReference[next]! <= threshold) push(next) }
  }

  // --- 5. Guard: when the flood reaches almost every pixel the picture has no
  // distinguishable subject (a flat scan, a texture); removing "the background"
  // would delete the image, so report nothing removable instead.
  const removedRatio = total === 0 ? 0 : tail / total
  if (removedRatio > 0.97) return { canvas: source, removedRatio: 0, tolerance: threshold }

  // --- 6. write the alpha channel. A flooded pixel keeps opacity only while
  // its color still sits between the backdrop and the subject, which reads as a
  // 1-2px matte instead of a stair-stepped cut (and costs no extra pass).
  const softFloor = threshold * 0.35
  const softSpan = Math.max(1, threshold - softFloor)
  for (let index = 0; index < total; index += 1) {
    if (background[index] === 0) continue
    const offset = index * 4
    const edge = Math.min(1, Math.max(0, (distanceToReference[index]! - softFloor) / softSpan))
    data[offset + 3] = Math.round(data[offset + 3]! * (edge * 0.5))
  }
  ctx.putImageData(image, 0, 0)
  return { canvas, removedRatio, tolerance: threshold }
}

/**
 * Remove the background with an automatic tolerance, retrying wider once when
 * the first pass barely touched the image (busy or gradient backdrops).
 */
export function autoRemoveBackground(source: HTMLCanvasElement): BackgroundRemovalResult {
  const first = removeBackground(source)
  if (first.removedRatio >= 0.06) return first
  const second = removeBackground(source, Math.min(140, first.tolerance * 2.1))
  return second.removedRatio > first.removedRatio ? second : first
}

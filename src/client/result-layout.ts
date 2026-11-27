/**
 * Row plan for the result surfaces.
 *
 * The board is a photo sheet: it fills the panel, never scrolls while it can
 * help it, and every picture keeps its whole frame (contain, never cover). The
 * default count table is kept for callers that have not measured the pictures
 * yet. Once the sheet has a width and each card has an aspect ratio, the
 * planner picks the widest column count that still leaves every picture
 * readable, so a batch of portrait renders does not leave a half-empty row
 * under a two-over-one arrangement (#106/#107).
 */

/** Gap between rows and between cards, in CSS pixels (matches the stylesheet). */
const RESULT_GAP = 12

/** A column narrower than this reads as a thumbnail strip, not a picture. */
const MIN_COLUMN_WIDTH = 160

/** A picture shorter than this is too flattened to judge. */
const MIN_MEDIA_HEIGHT = 160

/** A single picture taller than this stops owning the whole panel. */
const MAX_MEDIA_HEIGHT = 560

/** A picture at least this wide counts as landscape. */
const WIDE_ASPECT = 1.2

export interface ResultLayoutInput {
  /** Number of cards on the board. */
  count: number
  /**
   * Width / height per card, in slot order. `undefined` marks a card whose
   * shape is not known yet (pending, failed, not decoded); it counts as square.
   */
  aspects?: readonly (number | undefined)[]
  /** Measured sheet width in CSS pixels; 0 before the first measurement. */
  width?: number
  /** Gap override, for tests. */
  gap?: number
}

export interface ResultLayout {
  /** Slot indices per row, top to bottom. Every index appears exactly once. */
  rows: number[][]
  /** True when the board must scroll (too many cards for one screen). */
  scroll: boolean
}

/** Decide the row split for the current count. */
export function planResultLayout(input: ResultLayoutInput): ResultLayout {
  const count = Math.max(0, Math.trunc(input.count))
  if (count === 0) return { rows: [], scroll: false }
  if (count === 1) return { rows: [[0]], scroll: false }

  const aspects = Array.from({ length: count }, (_, index) => normalizeAspect(input.aspects?.[index]))
  const width = Math.max(0, input.width ?? 0)
  const gap = input.gap ?? RESULT_GAP

  // Until the sheet is measured, keep the familiar fixed table. The same table
  // is also the best arrangement for a set made entirely of landscape pictures.
  if (width <= 0) {
    if (count === 2) return { rows: [[0, 1]], scroll: false }
    if (count === 3) return { rows: [[0, 1], [2]], scroll: false }
    if (count === 4) return { rows: [[0, 1], [2, 3]], scroll: false }
    if (count === 5) return { rows: [[0, 1, 2], [3, 4]], scroll: false }
    if (count === 6) return { rows: [[0, 1, 2], [3, 4, 5]], scroll: false }
    return { rows: chunkRows(count, 3), scroll: true }
  }

  // A pair is a comparison: keep both cards in the same row even when one is
  // portrait, so the two versions stay directly comparable. The narrow
  // all-landscape case still stacks via the stylesheet's container query.
  if (count === 2) return { rows: [[0, 1]], scroll: false }

  const allLandscape = aspects.every(aspect => aspect >= WIDE_ASPECT)
  if (allLandscape && count <= 4) {
    if (count === 2) return { rows: [[0, 1]], scroll: false }
    if (count === 3) return { rows: [[0, 1], [2]], scroll: false }
    return { rows: [[0, 1], [2, 3]], scroll: false }
  }

  const columns = chooseColumns(count, aspects, width, gap)
  const rows = chunkRows(count, columns)
  return { rows, scroll: count > 6 || rows.length > 2 }
}

/** The widest column count that keeps every picture readable. */
function chooseColumns(count: number, aspects: readonly number[], width: number, gap: number): number {
  const cap = Math.min(count, 4)
  for (let columns = cap; columns >= 2; columns -= 1) {
    // A trailing row with one lonely card reads as an accident; prefer a
    // slightly narrower row set that balances the last row.
    if (count % columns === 1 && columns > 2) continue
    const columnWidth = (width - gap * (columns - 1)) / columns
    if (columnWidth < MIN_COLUMN_WIDTH) continue
    const readable = aspects.every(aspect => {
      const height = columnWidth / aspect
      return height >= MIN_MEDIA_HEIGHT && height <= MAX_MEDIA_HEIGHT
    })
    if (readable) return columns
  }
  return 1
}

/** Split the slots into rows of `columns` each; the last row keeps the rest. */
function chunkRows(count: number, columns: number): number[][] {
  const size = Math.max(1, columns)
  const rows: number[][] = []
  for (let start = 0; start < count; start += size) {
    rows.push(Array.from({ length: Math.min(size, count - start) }, (_, offset) => start + offset))
  }
  return rows
}

/** Unknown shapes count as square: they must not decide the split alone. */
function normalizeAspect(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}


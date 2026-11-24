/**
 * Row plan and card widths for the result surfaces.
 *
 * The arrangement follows the pictures, not a fixed count table: the panel
 * width decides how many equal columns fit, the picture shapes decide whether
 * that many columns are readable at all, and a lone picture is capped so one
 * render never swallows the whole panel.
 *
 * The rules, in order:
 *  - a set of landscape pictures (16:9 / 3:2 / 4:3) keeps the arrangement people
 *    expect: one picture owns the area, two stack, three sit as a 品 (one over
 *    two), four make a 2×2 grid;
 *  - every other set (portraits, squares, mixed) takes the widest column count
 *    that keeps each picture readable — at least `MIN_COLUMN_WIDTH` wide, and
 *    tall enough (200–560 px) that it does not flatten into a strip;
 *  - a row that ends up with a single picture caps its width at
 *    `MAX_MEDIA_HEIGHT` picture heights, so a lone 9:16 render is a tall
 *    centred picture instead of a full-width wall.
 *
 * A card carries only its width: the picture area then takes the picture's own
 * aspect ratio, so no card is framed by a band of empty space (#97) and the
 * board scrolls instead of squashing the pictures.
 */

/** Gap between rows and between cards, in CSS pixels (matches the stylesheet). */
const RESULT_GAP = 12

/** A column narrower than this reads as a thumbnail strip, not a picture. */
const MIN_COLUMN_WIDTH = 180

/** More columns than this is a contact sheet, not a result board. */
const MAX_COLUMNS = 4

/** A picture shorter than this is too flattened to judge. */
const MIN_MEDIA_HEIGHT = 200

/** A single picture taller than this stops owning the whole panel. */
const MAX_MEDIA_HEIGHT = 560

/** A picture at least this wide counts as landscape. */
const WIDE_ASPECT = 1.2

export interface ResultLayoutInput {
  /** Number of cards on the board. */
  count: number
  /**
   * width / height per card, in slot order. `undefined` marks a card whose
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
  /** Card width per row and slot in CSS pixels, or null before the first measurement. */
  boxes: (number | null)[][]
}

/** width / height of a picture whose payload carries its pixel size. */
export function pictureAspect(size: { width?: number; height?: number } | undefined): number | undefined {
  const width = size?.width
  const height = size?.height
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return undefined
  return width / height
}

/** Plan the sheet: the rows, and the width every card owns inside them. */
export function planResultLayout(input: ResultLayoutInput): ResultLayout {
  const count = Math.max(0, Math.trunc(input.count))
  if (count === 0) return { rows: [], boxes: [] }
  const aspects = Array.from({ length: count }, (_, index) => normalizeAspect(input.aspects?.[index]))
  const width = Math.max(0, input.width ?? 0)
  const gap = input.gap ?? RESULT_GAP
  const rows = planRows(count, aspects, width, gap)
  const measured = width > 0
  const boxes = rows.map(row => row.map(index => {
    if (!measured) return null
    const rowWidth = Math.max(0, width - gap * (row.length - 1))
    const columnWidth = rowWidth / row.length
    // A lone picture is capped so one render never swallows the panel; a full
    // row shares the width evenly.
    return row.length === 1 ? Math.min(columnWidth, aspects[index]! * MAX_MEDIA_HEIGHT) : columnWidth
  }))
  return { rows, boxes }
}

/** The row split for this count and these shapes. */
function planRows(count: number, aspects: readonly number[], width: number, gap: number): number[][] {
  if (count === 1) return [[0]]
  // Only a set made entirely of landscape pictures keeps the count table. A mix
  // of landscape and portrait cards is planned by shape instead, because the
  // shorter card would be stretched to the taller one and leave a band of empty
  // card under it.
  const landscape = aspects.every(aspect => aspect >= WIDE_ASPECT)
  if (landscape && count === 2) return [[0], [1]]
  if (landscape && count === 3) return [[0], [1, 2]]
  if (landscape && count === 4) return [[0, 1], [2, 3]]
  return chunkRows(count, chooseColumns(count, aspects, width, gap))
}

/** The widest column count that keeps every picture readable, and not a wall. */
function chooseColumns(count: number, aspects: readonly number[], width: number, gap: number): number {
  if (width <= 0) return 1
  const cap = Math.min(count, MAX_COLUMNS)
  for (let columns = cap; columns >= 2; columns -= 1) {
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

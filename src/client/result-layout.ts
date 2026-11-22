/**
 * Packing for the studio result board.
 *
 * The board is a photo sheet: it never scrolls while it can help it, the panel
 * fixes its height, and every image keeps its whole frame (contain, never
 * cover). That leaves exactly one decision — how the available pixels are
 * divided, i.e. how much of the panel ends up as letterbox bars. A split that
 * flatters three landscape renders ruins three portrait ones, and the old
 * count-only rule ("one column per image") turned three 16:9 renders into three
 * tall slivers with most of each card empty (#97).
 *
 * So every candidate split is measured instead of assumed: with the board's
 * real size, the gap and the per-card footer, each image's displayed area is
 * computed with the same contain maths the browser applies, and the split that
 * shows the most pixels wins. One, two and three images keep explicit rules,
 * because there the expected answer is a product decision rather than a
 * measurement.
 */

/** Gap between rows and between cards, in CSS pixels (matches the stylesheet). */
export const RESULT_LAYOUT_GAP = 12

/** The footer line (channel / model + dimensions) that every card reserves. */
export const RESULT_CARD_CHROME = 34

/** Below this a cell stops reading as a picture; such splits lose to any other. */
const MIN_MEDIA_HEIGHT = 72
const MIN_CELL_WIDTH = 72

/** Three portraits share one row only while each cell stays this wide. */
const MIN_PORTRAIT_ROW_WIDTH = 150

/** Above this the board scrolls again rather than shrinking every card. */
const MAX_PACKED = 6

export interface ResultLayoutInput {
  /** Number of cards on the board. */
  count: number
  /** width / height per card, in slot order; unknown values fall back to 1. */
  aspects: readonly (number | undefined)[]
  /** Board inner width in CSS pixels (0 before the first measurement). */
  width: number
  /** Board inner height in CSS pixels (0 before the first measurement). */
  height: number
  gap?: number
  chrome?: number
  /** Largest number of images allowed in one row. */
  maxColumns?: number
}

export interface ResultLayout {
  /** Slot indices per row, top to bottom. Every index appears exactly once. */
  rows: number[][]
  /** True when the board must scroll (too many cards for one screen). */
  scroll: boolean
  /**
   * Per row: the width a row's single card should take, in CSS pixels, so the
   * card hugs its picture instead of stretching across the board. `null` means
   * the row divides the width evenly as usual.
   */
  widths: (number | null)[]
  /**
   * Per row: the height every card in the row should take when the pictures are
   * shaped alike, so the card ends where the picture ends instead of framing it
   * with empty space. `null` keeps the row stretched to the board.
   */
  heights: (number | null)[]
}

/**
 * Decide the row split for the current board.
 *
 * Rules: a single image owns the board; two always split left/right (that is
 * the comparison the panel is built around); three become one row when all of
 * them are portrait, otherwise two on top and one underneath. Four and up are
 * measured, because with mixed shapes there is no rule that stays right.
 */
export function planResultLayout(input: ResultLayoutInput): ResultLayout {
  const count = Math.max(0, Math.trunc(input.count))
  if (count === 0) return { rows: [], scroll: false, widths: [], heights: [] }
  const aspects = Array.from({ length: count }, (_, index) => normalizeAspect(input.aspects[index]))
  const width = Math.max(0, input.width)
  const height = Math.max(0, input.height)
  const gap = input.gap ?? RESULT_LAYOUT_GAP
  const chrome = input.chrome ?? RESULT_CARD_CHROME
  const measured = width >= 120 && height >= 120

  /** Add the hugging sizes once the rows are known. */
  const finish = (rows: number[][]): ResultLayout => ({
    rows,
    scroll: false,
    widths: measured ? loneRowWidths(rows, aspects, width, height, gap, chrome) : rows.map(() => null),
    heights: measured ? rowHeights(rows, aspects, width, height, gap, chrome) : rows.map(() => null),
  })

  if (count === 1) return finish([[0]])
  if (count === 2) return finish([[0, 1]])
  if (count === 3) {
    // Three portrait renders fill one row nicely; anything else leaves a dead
    // column, so the third render goes under the first two. On a narrow board
    // three across would shrink every portrait to a thumbnail, so the rule
    // yields to the 2 + 1 sheet there.
    const portraits = aspects.every(aspect => aspect < 1)
    const roomy = width === 0 || (width - 2 * gap) / 3 >= MIN_PORTRAIT_ROW_WIDTH
    return finish(portraits && roomy ? [[0, 1, 2]] : [[0, 1], [2]])
  }

  if (count > MAX_PACKED) return unmeasured(chunkRows(count, 3), true)
  // Before the first measurement (or in a layout-less DOM) fall back to the
  // shape the count implies, then re-plan once the observer reports a size.
  if (!measured) return unmeasured(fallbackRows(count), false)

  const maxColumns = Math.max(1, Math.min(input.maxColumns ?? (count <= 4 ? 4 : 3), count))

  let best: number[] | null = null
  let bestScore = 0
  for (const lengths of rowSplits(count, maxColumns)) {
    if (!rowShapeAllowed(lengths)) continue
    const score = displayedArea(lengths, aspects, width, height, gap, chrome) * loneRowPenalty(lengths)
    // Strictly better only: the enumeration is ordered by row count and
    // balance, so a tie keeps the calmer split.
    if (score > bestScore + 0.5) {
      best = lengths
      bestScore = score
    }
  }
  if (best === null) return unmeasured(fallbackRows(count), false)
  return finish(indexRows(best))
}

/** A plan made without a board measurement: rows only, everything stretches. */
function unmeasured(rows: number[][], scroll: boolean): ResultLayout {
  return { rows, scroll, widths: rows.map(() => null), heights: rows.map(() => null) }
}

/**
 * Card heights for rows whose pictures end up the same shape once contained:
 * the card stops where the picture stops, and the leftover board height becomes
 * one band of breathing room around the row instead of four grey margins inside
 * every card. Mixed shapes keep the stretched row, because cards of different
 * heights in one row read as a mistake.
 */
function rowHeights(rows: readonly number[][], aspects: readonly number[], width: number, height: number, gap: number, chrome: number): (number | null)[] {
  const mediaHeight = (height - gap * (rows.length - 1)) / rows.length - chrome
  return rows.map(row => {
    const cellWidth = (width - gap * (row.length - 1)) / row.length
    const shown = row.map(index => Math.min(mediaHeight, cellWidth / (aspects[index] ?? 1)))
    const spread = Math.max(...shown) - Math.min(...shown)
    // A lone card already hugs its own width; only a shared row needs the cap.
    if (row.length < 2 || spread > 8) return null
    return Math.round(Math.max(...shown) + chrome)
  })
}

/**
 * Widths for rows that hold a single card: a lone card stretched across the
 * board would frame its picture with empty space on both sides, so it hugs the
 * picture's width at the row's height instead (a 16:9 render under a pair of
 * them ends up as a wide band, not a full-width frame with two grey margins).
 */
function loneRowWidths(rows: readonly number[][], aspects: readonly number[], width: number, height: number, gap: number, chrome: number): (number | null)[] {
  const mediaHeight = (height - gap * (rows.length - 1)) / rows.length - chrome
  return rows.map(row => {
    if (row.length !== 1) return null
    const aspect = aspects[row[0]!] ?? 1
    // Never wider than the board, never narrower than a readable card.
    return Math.round(Math.max(120, Math.min(width, mediaHeight * aspect)))
  })
}

/**
 * A single image alone in a row is only acceptable as the final row (the third
 * of three renders, the last of five). Two lone rows — 2 + 1 + 1 — read as a
 * broken sheet even when they technically fill more pixels.
 */
function rowShapeAllowed(lengths: readonly number[]): boolean {
  return lengths.every((length, index) => length > 1 || index === lengths.length - 1)
}

/**
 * A lone last row still gives up some balance, so it has to be clearly better
 * on area before it wins (5 renders pack as 3 + 2, not 2 + 2 + 1).
 */
const LONE_ROW_PENALTY = 0.7

function loneRowPenalty(lengths: readonly number[]): number {
  return lengths.length > 1 && lengths.some(length => length === 1) ? LONE_ROW_PENALTY : 1
}

/** Turn row lengths into the slot indices each row holds, in slot order. */
function indexRows(lengths: readonly number[]): number[][] {
  const rows: number[][] = []
  let index = 0
  for (const length of lengths) {
    rows.push(Array.from({ length }, (_, offset) => index + offset))
    index += length
  }
  return rows
}

/** Total pixels the images would actually occupy under one row split. */
function displayedArea(
  lengths: readonly number[],
  aspects: readonly number[],
  width: number,
  height: number,
  gap: number,
  chrome: number,
): number {
  const rowCount = lengths.length
  const cellHeight = (height - gap * (rowCount - 1)) / rowCount
  const mediaHeight = cellHeight - chrome
  if (mediaHeight < MIN_MEDIA_HEIGHT) return 0

  let total = 0
  let index = 0
  for (const length of lengths) {
    const cellWidth = (width - gap * (length - 1)) / length
    if (cellWidth < MIN_CELL_WIDTH) return 0
    for (let column = 0; column < length; column += 1) {
      const aspect = aspects[index] ?? 1
      index += 1
      // contain: the image fits the cell, so one dimension is the limit.
      const shownWidth = Math.min(cellWidth, mediaHeight * aspect)
      total += shownWidth * (shownWidth / aspect)
    }
  }
  return total
}

/**
 * Every ordered split of `count` into rows of at most `maxColumns`, ordered by
 * row count and then by balance, so equal-area ties prefer the simpler sheet.
 */
function rowSplits(count: number, maxColumns: number): number[][] {
  const splits: number[][] = []
  const walk = (remaining: number, current: number[]): void => {
    if (remaining === 0) {
      splits.push([...current])
      return
    }
    for (let take = Math.min(maxColumns, remaining); take >= 1; take -= 1) {
      current.push(take)
      walk(remaining - take, current)
      current.pop()
    }
  }
  walk(count, [])
  return splits.sort((left, right) => left.length - right.length || spread(left) - spread(right))
}

function spread(lengths: readonly number[]): number {
  return Math.max(...lengths) - Math.min(...lengths)
}

/** The shape a count implies without any measurement: 4 in a square, the rest in threes. */
function fallbackRows(count: number): number[][] {
  if (count === 4) return [[0, 1], [2, 3]]
  return chunkRows(count, 3)
}

function chunkRows(count: number, perRow: number): number[][] {
  const rows: number[][] = []
  for (let start = 0; start < count; start += perRow) {
    rows.push(Array.from({ length: Math.min(perRow, count - start) }, (_, offset) => start + offset))
  }
  return rows
}

function normalizeAspect(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

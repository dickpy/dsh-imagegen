/**
 * Row plan for the result surfaces.
 *
 * The board is a photo sheet: it fills the panel, never scrolls while it can
 * help it, and every picture keeps its whole frame (contain, never cover). The
 * split is deliberately a fixed table rather than a measurement — one picture
 * owns the area, two split it left/right, three sit as two over one, four make
 * a 2×2 — because that is the arrangement users expect from a result grid, and
 * a sheet that re-arranges itself per pixel shape is harder to scan.
 */

export interface ResultLayoutInput {
  /** Number of cards on the board. */
  count: number
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
  if (count === 2) return { rows: [[0, 1]], scroll: false }
  if (count === 3) return { rows: [[0, 1], [2]], scroll: false }
  if (count === 4) return { rows: [[0, 1], [2, 3]], scroll: false }
  if (count === 5) return { rows: [[0, 1, 2], [3, 4]], scroll: false }
  if (count === 6) return { rows: [[0, 1, 2], [3, 4, 5]], scroll: false }
  return { rows: chunkRows(count, 3), scroll: true }
}

/** Three per row, so a long run of results stays readable and scrolls. */
function chunkRows(count: number, perRow: number): number[][] {
  const rows: number[][] = []
  for (let start = 0; start < count; start += perRow) {
    rows.push(Array.from({ length: Math.min(perRow, count - start) }, (_, offset) => start + offset))
  }
  return rows
}

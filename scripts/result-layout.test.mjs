/**
 * Unit tests for the result-board planner (#97).
 *
 * The board used to divide by count alone, which turned three landscape renders
 * into three tall slivers. The planner now measures candidate row splits, so
 * these cases pin the two product rules (two side by side, three portraits in
 * one row) and the measured shapes around them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { planResultLayout, RESULT_CARD_CHROME, RESULT_LAYOUT_GAP } from '../src/client/result-layout.ts'

const LANDSCAPE = 3840 / 2161
const PORTRAIT = 2 / 3
const board = (width, height) => ({ width, height, gap: RESULT_LAYOUT_GAP, chrome: RESULT_CARD_CHROME })

/** Every card appears exactly once, in slot order, and no row is empty. */
function assertCoversAll(layout, count) {
  const flat = layout.rows.flat()
  assert.equal(flat.length, count, 'every card is placed once')
  assert.deepEqual(flat, Array.from({ length: count }, (_, index) => index), 'slot order survives the packing')
  assert.ok(layout.rows.every(row => row.length > 0), 'no empty row')
}

test('a single result owns the board', () => {
  const layout = planResultLayout({ count: 1, aspects: [LANDSCAPE], ...board(630, 620) })
  assert.deepEqual(layout.rows, [[0]])
  assert.equal(layout.scroll, false)
})

test('two results always split left and right, whatever their shape', () => {
  for (const aspects of [[LANDSCAPE, LANDSCAPE], [PORTRAIT, PORTRAIT], [PORTRAIT, LANDSCAPE], [1, LANDSCAPE]]) {
    const layout = planResultLayout({ count: 2, aspects, ...board(630, 620) })
    assert.deepEqual(layout.rows, [[0, 1]], `side by side for ${aspects.join('/')}`)
  }
})

test('three portrait renders share one row', () => {
  const layout = planResultLayout({ count: 3, aspects: [PORTRAIT, PORTRAIT, PORTRAIT], ...board(630, 620) })
  assert.deepEqual(layout.rows, [[0, 1, 2]])
})

test('three renders of any other shape pack as two plus one', () => {
  for (const aspects of [[LANDSCAPE, LANDSCAPE, LANDSCAPE], [PORTRAIT, PORTRAIT, LANDSCAPE], [1, 1, 1]]) {
    const layout = planResultLayout({ count: 3, aspects, ...board(630, 620) })
    assert.deepEqual(layout.rows, [[0, 1], [2]], `two plus one for ${aspects.join('/')}`)
  }
})

test('three portraits drop to two plus one when a third of the board is a sliver', () => {
  const layout = planResultLayout({ count: 3, aspects: [PORTRAIT, PORTRAIT, PORTRAIT], ...board(420, 760) })
  assert.deepEqual(layout.rows, [[0, 1], [2]])
})

test('four results fill the sheet instead of four columns', () => {
  const square = planResultLayout({ count: 4, aspects: [LANDSCAPE, LANDSCAPE, LANDSCAPE, LANDSCAPE], ...board(630, 620) })
  assert.deepEqual(square.rows, [[0, 1], [2, 3]], 'a tall panel splits into a 2x2 sheet')
  const strip = planResultLayout({ count: 4, aspects: [LANDSCAPE, LANDSCAPE, LANDSCAPE, LANDSCAPE], ...board(1600, 300) })
  assert.deepEqual(strip.rows, [[0, 1, 2, 3]], 'a wide strip keeps one row of four')
})

test('five results pack as three plus two, never two plus two plus one', () => {
  const layout = planResultLayout({ count: 5, aspects: Array(5).fill(LANDSCAPE), ...board(630, 620) })
  assert.deepEqual(layout.rows, [[0, 1, 2], [3, 4]])
})

test('six results follow the shapes: wide ones pair up, portraits go three by three', () => {
  const wide = planResultLayout({ count: 6, aspects: Array(6).fill(LANDSCAPE), ...board(630, 620) })
  assert.deepEqual(wide.rows, [[0, 1], [2, 3], [4, 5]])
  const tall = planResultLayout({ count: 6, aspects: Array(6).fill(PORTRAIT), ...board(630, 620) })
  assert.deepEqual(tall.rows, [[0, 1, 2], [3, 4, 5]])
})

test('past six results the board scrolls in rows of three', () => {
  const layout = planResultLayout({ count: 7, aspects: Array(7).fill(LANDSCAPE), ...board(630, 620) })
  assert.deepEqual(layout.rows, [[0, 1, 2], [3, 4, 5], [6]])
  assert.equal(layout.scroll, true)
})

test('an unmeasured board still produces the shape its count implies', () => {
  const layout = planResultLayout({ count: 4, aspects: [LANDSCAPE, LANDSCAPE, LANDSCAPE, LANDSCAPE], ...board(0, 0) })
  assert.deepEqual(layout.rows, [[0, 1], [2, 3]])
  assert.equal(layout.scroll, false)
  assert.deepEqual(layout.widths, [null, null], 'no size, no hugging')
  assert.deepEqual(layout.heights, [null, null])
})

test('a lone card hugs its picture instead of framing it with empty space', () => {
  const layout = planResultLayout({ count: 3, aspects: [LANDSCAPE, LANDSCAPE, LANDSCAPE], ...board(1050, 800) })
  assert.deepEqual(layout.rows, [[0, 1], [2]])
  assert.equal(layout.widths[0], null, 'a two-card row still divides the width')
  // Row height = (800 - 12) / 2 = 394, media 394 - 34 = 360, so 16:9 is 640 wide.
  assert.equal(layout.widths[1], Math.round(360 * LANDSCAPE))
})

test('a row of alike pictures stops where the pictures stop', () => {
  const layout = planResultLayout({ count: 2, aspects: [LANDSCAPE, LANDSCAPE], ...board(1050, 800) })
  // Two halves of 519px show 16:9 at 292px tall, plus the footer.
  assert.equal(layout.heights[0], Math.round(519 / LANDSCAPE) + RESULT_CARD_CHROME)
})

test('mixed shapes keep the stretched row, so cards stay the same height', () => {
  const layout = planResultLayout({ count: 3, aspects: [LANDSCAPE, PORTRAIT, 1], ...board(1050, 800) })
  assert.deepEqual(layout.rows, [[0, 1], [2]])
  assert.equal(layout.heights[0], null, 'one row, two shapes: no shared cap')
})

test('unknown aspect ratios fall back to squares without breaking the packing', () => {
  const layout = planResultLayout({ count: 4, aspects: [undefined, Number.NaN, -2, 0], ...board(630, 620) })
  assertCoversAll(layout, 4)
})

test('every board size and shape keeps a valid, complete packing', () => {
  const shapes = [LANDSCAPE, PORTRAIT, 1, 21 / 9, 3 / 4]
  for (let count = 1; count <= 8; count += 1) {
    for (const aspect of shapes) {
      for (const size of [[320, 900], [630, 620], [900, 420], [1400, 900], [0, 0]]) {
        const layout = planResultLayout({ count, aspects: Array(count).fill(aspect), width: size[0], height: size[1] })
        assertCoversAll(layout, count)
        assert.equal(layout.scroll, count > 6)
      }
    }
  }
})

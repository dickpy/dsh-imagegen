/**
 * Unit tests for the result sheet (#97).
 *
 * The split is a fixed table on purpose: one picture owns the area, two split it
 * left/right, three sit as two over one, four make a 2×2. These cases pin that
 * table so a future "optimization" cannot quietly re-arrange the grid again.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { planResultLayout } from '../src/client/result-layout.ts'

const plan = count => planResultLayout({ count })

/** Every card appears exactly once, in slot order, and no row is empty. */
function assertCoversAll(layout, count) {
  const flat = layout.rows.flat()
  assert.equal(flat.length, count, 'every card is placed once')
  assert.deepEqual(flat, Array.from({ length: count }, (_, index) => index), 'slot order survives the packing')
  assert.ok(layout.rows.every(row => row.length > 0), 'no empty row')
}

test('an empty board has no rows', () => {
  assert.deepEqual(plan(0), { rows: [], scroll: false })
})

test('one picture owns the whole area', () => {
  assert.deepEqual(plan(1), { rows: [[0]], scroll: false })
})

test('two pictures split left and right', () => {
  assert.deepEqual(plan(2), { rows: [[0, 1]], scroll: false })
})

test('three pictures sit as two over one', () => {
  assert.deepEqual(plan(3), { rows: [[0, 1], [2]], scroll: false })
})

test('four pictures make a 2x2 sheet', () => {
  assert.deepEqual(plan(4), { rows: [[0, 1], [2, 3]], scroll: false })
})

test('five and six pictures keep rows of three', () => {
  assert.deepEqual(plan(5), { rows: [[0, 1, 2], [3, 4]], scroll: false })
  assert.deepEqual(plan(6), { rows: [[0, 1, 2], [3, 4, 5]], scroll: false })
})

test('past six pictures the board scrolls in rows of three', () => {
  const seven = plan(7)
  assert.deepEqual(seven.rows, [[0, 1, 2], [3, 4, 5], [6]])
  assert.equal(seven.scroll, true)
  const twelve = plan(12)
  assert.deepEqual(twelve.rows, [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]])
  assert.equal(twelve.scroll, true)
})

test('the split never depends on pixel shapes, only on the count', () => {
  for (let count = 0; count <= 9; count += 1) {
    const layout = plan(count)
    assertCoversAll(layout, count)
    assert.equal(layout.scroll, count > 6)
    assert.ok(layout.rows.length <= 1 || count > 1)
  }
})

test('measured portrait batches use the widest readable columns', () => {
  const portrait = 1199 / 1312
  const three = planResultLayout({ count: 3, aspects: [portrait, portrait, portrait], width: 1000 })
  assert.deepEqual(three.rows, [[0, 1, 2]], 'three portrait cards use one row instead of a half-empty two-over-one sheet')
  assert.equal(three.scroll, false)

  // A landscape set keeps the familiar two-over-one sheet; all three cards are
  // wide enough to read without being squeezed into narrow columns.
  const landscape = planResultLayout({ count: 3, aspects: [16 / 9, 16 / 9, 16 / 9], width: 1000 })
  assert.deepEqual(landscape.rows, [[0, 1], [2]])

  const five = planResultLayout({ count: 5, aspects: [portrait, portrait, portrait, portrait, portrait], width: 1000 })
  assert.deepEqual(five.rows, [[0, 1, 2], [3, 4]], 'five portraits keep a balanced 3+2 last row')
})

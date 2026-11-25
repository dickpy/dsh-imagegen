import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
  MAX_DOWNLOAD_TIMEOUT_SECONDS,
  MIN_DOWNLOAD_TIMEOUT_SECONDS,
  effectiveDownloadTimeoutMs,
} from '../src/download-timeout.ts'

test('an unset or unusable budget falls back to the 60 s default', () => {
  for (const value of [undefined, null, '', '  ', 'slow', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.equal(effectiveDownloadTimeoutMs(value), DEFAULT_DOWNLOAD_TIMEOUT_SECONDS * 1000, `value=${JSON.stringify(value)}`)
  }
})

test('a stored budget is used as seconds and converted to milliseconds', () => {
  assert.equal(effectiveDownloadTimeoutMs(90), 90_000)
  assert.equal(effectiveDownloadTimeoutMs(600), 600_000)
  // A document written before the schema change can carry a numeric string.
  assert.equal(effectiveDownloadTimeoutMs('150'), 150_000)
})

test('the budget is clamped to the range the engine guarantees', () => {
  assert.equal(effectiveDownloadTimeoutMs(1), MIN_DOWNLOAD_TIMEOUT_SECONDS * 1000, 'too small')
  assert.equal(effectiveDownloadTimeoutMs(0), MIN_DOWNLOAD_TIMEOUT_SECONDS * 1000, 'zero')
  assert.equal(effectiveDownloadTimeoutMs(-30), MIN_DOWNLOAD_TIMEOUT_SECONDS * 1000, 'negative')
  assert.equal(effectiveDownloadTimeoutMs(9_999), MAX_DOWNLOAD_TIMEOUT_SECONDS * 1000, 'too large')
})

test('fractional seconds round to whole milliseconds', () => {
  assert.equal(effectiveDownloadTimeoutMs(61.4), 61_000)
  assert.equal(effectiveDownloadTimeoutMs('61.6'), 62_000)
})

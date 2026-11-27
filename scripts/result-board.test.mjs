import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { bytesFromBase64, downloadImage, imageExtension } from '../src/client/result-board.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

test('download bytes decode from base64 without a data URL', () => {
  const bytes = bytesFromBase64(png)
  assert.deepEqual(Buffer.from(bytes), Buffer.from(png, 'base64'))
})

test('download filenames keep the original format extension', () => {
  assert.equal(imageExtension('image/png'), 'png')
  assert.equal(imageExtension('image/jpeg; charset=binary'), 'jpg')
  assert.equal(imageExtension('image/webp'), 'webp')
  assert.equal(imageExtension('image/gif'), 'gif')
})

test('downloadImage hands the browser a blob URL, never a data URL', async () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousCreate = URL.createObjectURL
  const previousRevoke = URL.revokeObjectURL
  const clicked = []
  globalThis.document = dom.window.document
  globalThis.window = dom.window
  URL.createObjectURL = () => 'blob:fixture-download'
  URL.revokeObjectURL = () => {}
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clicked.push({ href: this.href, download: this.download })
  }
  try {
    downloadImage({ b64: png, mime: 'image/png' }, 'fixture')
    assert.equal(clicked.length, 1)
    assert.equal(clicked[0].href, 'blob:fixture-download')
    assert.equal(clicked[0].download, 'fixture.png')
  } finally {
    dom.window.close()
    globalThis.document = previousDocument
    globalThis.window = previousWindow
    URL.createObjectURL = previousCreate
    URL.revokeObjectURL = previousRevoke
  }
})

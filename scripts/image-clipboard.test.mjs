import assert from 'node:assert/strict'
import test from 'node:test'
import { copyGeneratedImage } from '../src/client/image-clipboard.ts'

test('generated images are copied as PNG with original pixels and errors are reported', async () => {
  const previous = new Map(['navigator', 'ClipboardItem', 'Image', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let items = []
  let rejectWrite = false
  let decoded = false
  let writeBeforeDecode = false
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: callback => callback(new Blob(['converted'], { type: 'image/png' })),
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async write(next) {
    if (rejectWrite) throw new Error('permission denied')
    writeBeforeDecode = !decoded
    items = next
    await Promise.all(next.map(item => item.data['image/png']))
  } } } })
  globalThis.ClipboardItem = class { constructor(data) { this.data = data } }
  globalThis.document = { createElement: () => canvas }
  globalThis.Image = class {
    naturalWidth = 1920
    naturalHeight = 1080
    set src(_value) { queueMicrotask(() => { decoded = true; this.onload() }) }
  }
  try {
    const original = Buffer.from('a PNG fixture')
    await copyGeneratedImage({ mime: 'image/png', b64: original.toString('base64') })
    const png = await items[0].data['image/png']
    assert.equal(png.type, 'image/png')
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), original, 'PNG data is not recompressed')

    decoded = false
    await copyGeneratedImage({ mime: 'image/jpeg', b64: Buffer.from('jpeg').toString('base64') })
    assert.equal(writeBeforeDecode, true, 'clipboard write starts while the user gesture is active')
    assert.equal(canvas.width, 1920)
    assert.equal(canvas.height, 1080)
    assert.equal((await items[0].data['image/png']).type, 'image/png')

    rejectWrite = true
    await assert.rejects(copyGeneratedImage({ mime: 'image/png', b64: original.toString('base64') }), /permission denied/)
    delete globalThis.ClipboardItem
    await assert.rejects(copyGeneratedImage({ mime: 'image/png', b64: original.toString('base64') }), /unavailable/)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})

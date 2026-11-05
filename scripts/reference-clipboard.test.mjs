import assert from 'node:assert/strict'
import test from 'node:test'
import { readClipboardImageFiles } from '../src/client/reference-images.ts'

test('clipboard image read reports an unavailable API', async () => {
  await assert.rejects(readClipboardImageFiles(undefined), /Ctrl/)
})

test('clipboard read picks one supported representation per item in order', async () => {
  const requested = []
  const files = await readClipboardImageFiles({ read: async () => [
    { types: ['text/plain', 'image/png', 'image/jpeg'], getType: async type => { requested.push(type); return new Blob(['png'], { type }) } },
    { types: ['image/jpeg'], getType: async type => { requested.push(type); return new Blob(['jpg'], { type }) } },
  ] })
  assert.deepEqual(requested, ['image/png', 'image/jpeg'])
  assert.deepEqual(files.map(f => [f.name, f.type]), [['clipboard-1.png', 'image/png'], ['clipboard-2.jpg', 'image/jpeg']])
  assert.equal(await files[0].text(), 'png')
  assert.equal(await files[1].text(), 'jpg')
})

test('clipboard read skips text and unsupported image formats', async () => {
  let reads = 0
  const files = await readClipboardImageFiles({ read: async () => [
    { types: ['text/plain', 'text/html', 'image/svg+xml'], getType: async () => { reads++; throw new Error('should not read') } },
  ] })
  assert.deepEqual(files, [])
  assert.equal(reads, 0)
  assert.deepEqual(await readClipboardImageFiles({ read: async () => [] }), [])
})

test('clipboard permission and image decoding failures are surfaced to the UI', async () => {
  await assert.rejects(readClipboardImageFiles({ read: async () => { throw new Error('permission denied') } }), /permission denied/)
  await assert.rejects(readClipboardImageFiles({ read: async () => [{ types: ['image/png'], getType: async () => { throw new Error('read failed') } }] }), /read failed/)
})

test('clipboard files keep their real size for existing reference limits', async () => {
  const [file] = await readClipboardImageFiles({ read: async () => [{ types: ['image/webp'], getType: async () => new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/webp' }) }] })
  assert.equal(file.size, 10 * 1024 * 1024 + 1)
  assert.equal(file.name, 'clipboard-1.webp')
})

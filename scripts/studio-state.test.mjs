import assert from 'node:assert/strict'
import test from 'node:test'
import { imageDimensions } from '../src/image-dimensions.ts'
import { compareKey } from '../src/client/generation-settings.ts'
import { newStudioRun, orderedStudioChoices, readStudioRuns, replaceStudioSlot, slotsForTask, studioRetryRequest, studioTaskIds, writeStudioRuns, STUDIO_STORAGE_KEY } from '../src/client/studio-state.ts'
import { generateImage } from '../src/engine.ts'
import { ImageGenerationRuntime, makeRoutes } from '../lib/index.js'
import { Readable } from 'node:stream'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const image = `data:image/png;base64,${png}`
const request = { mode: 'edit', model: 'gpt-image-2', prompt: 'change the background', size: '1:1', quality: '4k', n: 2, detail: '', image, images: [image], mask: image, channelId: 'one' }
const task = { id: 'original', request, status: 'completed', result: { images: [{ b64: png, mime: 'image/png' }, { b64: png, mime: 'image/png' }] }, createdAt: 1 }
const upstream = { apiUrl: 'https://example.test/v1', apiKey: 'test-key' }

test('one-card regeneration preserves both references, mask and settings without resubmitting siblings', () => {
  const next = { id: 'retry', request: studioRetryRequest(request), status: 'queued', createdAt: 2 }
  const run = newStudioRun('group', 'edit', request.prompt, [task])
  const retried = replaceStudioSlot(run, run.slots[1].id, next)
  assert.equal(retried.slots[0].taskId, task.id)
  assert.equal(retried.slots[1].id, run.slots[1].id, 'the card keeps its position and identity')
  assert.equal(retried.slots[1].taskId, 'retry')
  assert.deepEqual(retried.slots[1].previous, { taskId: 'original', imageIndex: 1 })
  assert.deepEqual(next.request, { ...request, n: 1 })
  assert.deepEqual([...studioTaskIds({ text: null, edit: retried })], ['original', 'retry'])
})

test('failed cards and separate text/edit boards survive remount without storing image bytes', () => {
  const storage = { value: '', getItem() { return this.value }, setItem(_key, value) { this.value = value } }
  const failed = { ...task, status: 'failed', error: 'upstream timed out' }
  const runs = { text: newStudioRun('text', 'text', 'cat', [{ ...task, id: 'text', request: { ...request, mode: 'text' } }]), edit: newStudioRun('edit', 'edit', 'dog', [failed]) }
  runs.edit.slots[0].error = failed.error
  writeStudioRuns(storage, runs)
  assert.deepEqual(readStudioRuns(storage), runs)
  assert.ok(!storage.value.includes(png))
  assert.ok(!storage.value.includes('apiKey'))
  assert.equal(readStudioRuns({ getItem: () => '{broken' }).edit, null)
  assert.doesNotThrow(() => writeStudioRuns({ setItem() { throw Error('quota') } }, runs))
})

test('board order follows channel/model catalog, including identical model aliases on different channels', () => {
  const groups = [{ id: 'one', models: ['a', 'b'] }, { id: 'two', models: ['a', 'c'] }]
  assert.deepEqual(orderedStudioChoices(groups, [compareKey('two', 'c'), compareKey('one', 'b'), compareKey('two', 'a'), compareKey('one', 'a')], compareKey), [
    { channelId: 'one', model: 'a' }, { channelId: 'one', model: 'b' }, { channelId: 'two', model: 'a' }, { channelId: 'two', model: 'c' },
  ])
})

test('image headers report actual dimensions across PNG, GIF, JPEG and three WebP formats', () => {
  assert.deepEqual(imageDimensions(Buffer.from(png, 'base64')), { width: 1, height: 1 })
  const gif = Buffer.alloc(10); gif.write('GIF89a'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8)
  assert.deepEqual(imageDimensions(gif), { width: 320, height: 240 })
  const jpeg = Buffer.from([255,216,255,224,0,4,0,0,255,194,0,8,8,1,0,2,0,0,255,217])
  assert.deepEqual(imageDimensions(jpeg), { width: 512, height: 256 })
  for (const format of ['VP8X', 'VP8L', 'VP8 ']) {
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write(format, 12)
    webp.writeUInt32LE(10, 16)
    if (format === 'VP8X') { webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3) }
    if (format === 'VP8L') { webp[20] = 0x2f; webp.writeUInt32LE(639 | (479 << 14), 21) }
    if (format === 'VP8 ') { webp.set([0x9d, 1, 0x2a], 23); webp.writeUInt16LE(640, 26); webp.writeUInt16LE(480, 28) }
    assert.deepEqual(imageDimensions(webp), { width: 640, height: 480 }, format)
  }
  for (let length = 0; length < 24; length++) assert.doesNotThrow(() => imageDimensions(Buffer.alloc(length, 255)))
  assert.equal(imageDimensions(Buffer.from('not an image')), undefined)
})

test('native edit requests send the PNG mask and retain all references', async t => {
  let body
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = init.body; return Response.json({ data: [{ b64_json: png }] }) })
  await generateImage(upstream, request)
  assert.ok(body instanceof FormData)
  assert.equal(body.getAll('image[]').length, 2)
  assert.equal(body.get('mask').type, 'image/png')
  assert.equal(Buffer.from(await body.get('mask').arrayBuffer()).toString('base64'), png)
})

test('unsupported protocols and mismatched/malformed masks fail before provider requests', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not call provider') })
  for (const model of ['grok-imagine-image', 'nanobanana-pro', 'seedream-5.0-pro', 'qwen-image', 'image-01']) {
    await assert.rejects(generateImage(upstream, { ...request, model }), error => error.code === 'mask-unsupported')
  }
  await assert.rejects(generateImage({ ...upstream, protocol: 'chat-completions' }, request), error => error.code === 'mask-unsupported')
  await assert.rejects(generateImage(upstream, { ...request, mode: 'text' }), error => error.code === 'mask-unsupported')
  const wrong = Buffer.from(png, 'base64'); wrong.writeUInt32BE(2, 16)
  await assert.rejects(generateImage(upstream, { ...request, mask: `data:image/png;base64,${wrong.toString('base64')}` }), error => error.code === 'mask-size-mismatch')
  await assert.rejects(generateImage(upstream, { ...request, mask: 'data:image/jpeg;base64,aGVsbG8=' }), error => error.code === 'mask-invalid')
  assert.equal(calls, 0)
})

test('runtime annotates returned pixels and model/channel even when requested 4K differs', async t => {
  let saved
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: png }] }))
  const runtime = new ImageGenerationRuntime(() => ({ defaultChannelId: 'one', channels: [{ ...upstream, id: 'one', name: 'Provider A', models: [] }] }), { append: async entry => { saved = entry; return [] } })
  const result = await runtime.run({ ...request, image: undefined, images: undefined, mask: undefined, mode: 'text', n: 1 })
  assert.equal(result.images[0].width, 1)
  assert.equal(result.images[0].height, 1)
  assert.equal(result.images[0].model, 'gpt-image-2')
  assert.equal(result.images[0].channel, 'Provider A')
  assert.deepEqual(saved.images, result.images)
})

test('route forwards masks to tasks while poll summaries never carry image or mask bytes', async () => {
  const runtime = new ImageGenerationRuntime(() => ({ channels: [], defaultChannelId: '' }), { append: async () => [] })
  const routes = makeRoutes({ resolve: () => upstream, settings: { writable: true, describe: () => [], mutate: async () => {} }, runtime })
  const route = routes.find(route => route.path.endsWith('/tasks/submit'))
  assert.ok(route)
  // The queue may fail for absent channels; it must still retain the original mask for retry.
  const req = Readable.from([Buffer.from(JSON.stringify(request))]); Object.assign(req, { headers: { host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST' })
  let response
  await route.handler(req, { writeHead() {}, end(text) { response = JSON.parse(text) } })
  assert.equal(response.ok, true)
  assert.equal(runtime.queue.get(response.task.id).request.mask, image)
  const summary = runtime.queue.summaries()[0]
  assert.equal(summary.request.mask, undefined)
  assert.equal(summary.request.image, undefined)
})

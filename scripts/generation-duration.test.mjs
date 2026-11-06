import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
// Exercise the same built host runtime shipped to DSH (build before testing).
import { ImageGenerationRuntime, makeRoutes } from '../lib/index.js'
import { appendHistory, listHistory, readHistoryImage } from '../src/history-store.ts'
import { appendGallery, listGallery, readGalleryImage } from '../src/gallery-store.ts'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { applyHostLocale, generationDurationLabel } from '../src/client/helpers.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const request = { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: 'auto', n: 1, detail: '' }
const channel = { id: 'test', preset: '', name: 'Test', apiUrl: 'https://example.test/v1', apiKey: 'test-key', apiUrlFull: false, models: [] }
const resolve = () => ({ channels: [channel], defaultChannelId: channel.id })

test('duration labels use minutes and seconds, including boundaries and missing legacy values', () => {
  applyHostLocale('zh')
  for (const [ms, label] of [[0, '耗时 0分0秒'], [999, '耗时 0分0秒'], [1000, '耗时 0分1秒'], [59999, '耗时 0分59秒'], [60000, '耗时 1分0秒'], [123456, '耗时 2分3秒'], [3601000, '耗时 60分1秒']]) {
    assert.equal(generationDurationLabel(ms), label)
  }
  for (const missing of [undefined, null, -1, NaN, Infinity, '62000']) assert.equal(generationDurationLabel(missing), undefined)
  applyHostLocale('en')
  assert.equal(generationDurationLabel(123456), 'Generated in 2m 3s')
  applyHostLocale('ru')
  assert.equal(generationDurationLabel(123456), 'Генерация: 2 мин 3 с')
  applyHostLocale('zh')
})

test('API generations keep a fixed duration through slow history writes, for text and edit batches', async t => {
  let now = 10000, persisted
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    now = 72345
    return Response.json({ data: [{ b64_json: png, revised_prompt: 'a revised cat' }] })
  })
  const runtime = new ImageGenerationRuntime(resolve, { append: async entry => {
    persisted = entry
    now += 500000 // disk/network storage time is excluded
    return []
  } })
  for (const mode of ['text', 'edit']) {
    now = 10000
    const result = await runtime.run({ ...request, mode, n: 2, ...(mode === 'edit' ? { image: `data:image/png;base64,${png}` } : {}) })
    assert.equal(result.images.length, 2)
    assert.deepEqual(result.images.map(image => image.durationMs), [62345, 62345])
    assert.deepEqual(persisted.images, result.images)
    assert.equal(result.images[0].b64, png, 'timing never changes image bytes')
    assert.equal(result.images[0].revisedPrompt, 'a revised cat')
  }
})

test('subscription generations retain the same timing metadata', async t => {
  let now = 20000
  t.mock.method(performance, 'now', () => now)
  const runtime = new ImageGenerationRuntime(
    () => ({ channels: [{ ...channel, auth: 'subscription', subscription: 'grok-sub' }], defaultChannelId: channel.id }),
    { append: async () => [] },
    { generate: async () => { now = 85000; return [{ b64_json: png }] } },
  )
  assert.equal((await runtime.run(request)).images[0].durationMs, 65000)
})

test('successful images keep their duration when history cannot be saved', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => { now = 45000; return Response.json({ data: [{ b64_json: png }] }) })
  const runtime = new ImageGenerationRuntime(resolve, { append: async () => { throw new Error('disk unavailable') } })
  const result = await runtime.run(request)
  assert.equal(result.images[0].durationMs, 45000)
  assert.equal(result.historyError, 'disk unavailable')
})

test('parallel tasks have independent durations and queued time is excluded', async t => {
  let now = 1000
  const responses = new Map()
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise(resolveResponse => {
    responses.set(JSON.parse(init.body).prompt, () => resolveResponse(Response.json({ data: [{ b64_json: png }] })))
  }))
  const runtime = new ImageGenerationRuntime(resolve, { append: async () => [] })
  const tasks = Array.from({ length: 5 }, (_, index) => runtime.queue.submit({ ...request, prompt: `task-${index}` }))
  assert.equal(runtime.queue.get(tasks[4].id).status, 'queued')
  const waitFor = async fn => {
    for (let attempt = 0; !fn() && attempt < 100; attempt++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(fn())
  }
  await waitFor(() => responses.size === 4)
  now = 120000
  responses.get('task-0')()
  await waitFor(() => responses.has('task-4'))
  now = 125000
  responses.get('task-4')()
  await waitFor(() => runtime.queue.get(tasks[4].id).status === 'completed')
  assert.equal(runtime.queue.get(tasks[0].id).result.images[0].durationMs, 119000)
  assert.equal(runtime.queue.get(tasks[4].id).result.images[0].durationMs, 5000)
  now = 130000
  for (const index of [1, 2, 3]) responses.get(`task-${index}`)()
  await waitFor(() => runtime.queue.list().every(task => task.status === 'completed'))
  assert.equal(runtime.queue.get(tasks[1].id).result.images[0].durationMs, 129000)
  assert.equal(runtime.queue.get(tasks[4].id).result.images[0].durationMs, 5000, 'later tasks do not change finished clocks')
})

test('history and gallery round trips preserve per-image duration and original files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imagegen-duration-'))
  setImageDataRoot(root)
  try {
    const images = [62345, 0, undefined].map(durationMs => ({ b64: png, mime: 'image/png', ...(durationMs === undefined ? {} : { durationMs }) }))
    const input = { ...request, id: 'duration-history', createdAt: 1, images }
    await appendHistory(input)
    const history = await listHistory()
    assert.deepEqual(history[0].images.map(image => image.durationMs), [62345, 0, undefined])
    assert.equal(Object.hasOwn(history[0].images[2], 'durationMs'), false, 'legacy records stay untimed')
    await appendGallery({ ...input, id: 'duration-gallery' })
    const gallery = await listGallery()
    assert.deepEqual(gallery[0].images.map(image => image.durationMs), [62345, 0, undefined])
    const historyFile = await readHistoryImage('duration-history-0.png')
    const galleryFile = await readGalleryImage('duration-gallery-0.png')
    assert.deepEqual(historyFile.data, Buffer.from(png, 'base64'))
    assert.deepEqual(galleryFile.data, historyFile.data)
  } finally {
    setImageDataRoot(undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('history/gallery HTTP appends preserve valid timing and discard invalid metadata', async () => {
  const received = []
  const routes = makeRoutes({
    resolve: () => ({ apiUrl: channel.apiUrl, apiKey: channel.apiKey }),
    history: { append: async entry => { received.push(entry); return [] } },
    gallery: { append: async entry => { received.push(entry); return { entries: [], added: true } } },
  })
  const server = createServer((req, res) => {
    const route = routes.find(route => route.path === req.url)
    route.handler(req, res).catch(error => { res.statusCode = 500; res.end(error.message) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const target of ['history', 'gallery']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dsh-imagegen/${target}/append`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: { ...request, id: 'duration-http', createdAt: 1,
          images: [62345, 0, undefined, -1, '62000', null].map(durationMs => ({ b64: png, mime: 'image/png', durationMs })),
        } }),
      })
      assert.equal((await response.json()).ok, true)
      assert.deepEqual(received.at(-1).images.map(image => image.durationMs), [62345, 0, undefined, undefined, undefined, undefined])
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})

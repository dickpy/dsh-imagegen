import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImage } from '../src/engine.ts'
import { describeModel, isLikelyImageModelId } from '../src/model-catalog.ts'
import { ImageGenerationRuntime } from '../lib/index.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const image = `data:image/png;base64,${png}`
const upstream = { apiUrl: 'https://relay.example/v1', apiKey: 'test-key' }
const request = { mode: 'text', model: 'sensenova-u1.5-lite', prompt: 'a cat', size: '16:9', quality: '2k', detail: '', n: 1 }
function capture(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body) })
    return Response.json({ data: [{ b64_json: png }] })
  })
  return calls
}

test('SenseNova U image ids are discoverable while SenseNova chat models stay out', () => {
  for (const model of ['sensenova-u1.5-lite', 'sensenova-u1.5-fast', 'sensenova-u1-pro', 'sensenova/sensenova-u1.5-lite', ' SENSENOVA-U1.5-LITE ']) {
    const entry = describeModel(model)
    assert.equal(entry.family, 'sensenova', model)
    assert.equal(entry.supportsWatermarkToggle, true)
    assert.equal(entry.supportsPromptExtend, true)
    assert.equal(isLikelyImageModelId(model), true)
  }
  assert.equal(isLikelyImageModelId('sensenova-v6.5-pro'), false)
  assert.equal(describeModel('gpt-image-2').supportsWatermarkToggle, false)
  assert.equal(describeModel('seedream-5.0-pro').supportsWatermarkToggle, true)
})

test('watermark preferences follow the resolved model capability across hosts, modes and exact URLs', async t => {
  const calls = capture(t)
  for (const model of ['seedream-5.0-pro', 'doubao-seedream-5-0-pro-260628', 'sensenova-u1.5-lite']) {
    for (const apiUrl of ['https://relay.example/v1', 'https://token.sensenova.cn/v1']) {
      for (const mode of ['text', 'edit']) {
        await generateImage({ ...upstream, apiUrl, watermark: false }, { ...request, model: 'Friendly alias', upstream: model, mode, ...(mode === 'edit' ? { image } : {}) })
        const sent = calls.at(-1)
        assert.equal(sent.body.model, model)
        assert.equal(sent.body.watermark, false)
        assert.equal(sent.url, `${apiUrl}/images/${mode === 'edit' && model.startsWith('sensenova') ? 'edits' : 'generations'}`)
      }
    }
  }
  await generateImage({ ...upstream, apiUrl: 'https://relay.example/custom/images', apiUrlFull: true, watermark: false }, request)
  assert.equal(calls.at(-1).url, 'https://relay.example/custom/images')
  assert.equal(calls.at(-1).body.watermark, false)
  for (const model of ['gpt-image-2', 'flux-1.1-pro', 'unknown-model']) {
    await generateImage({ ...upstream, watermark: false, promptExtend: false }, { ...request, model })
    assert.equal(calls.at(-1).body.watermark, undefined)
    assert.equal(calls.at(-1).body.prompt_extend, undefined)
  }
})

test('SenseNova JSON edits preserve every reference and optional preferences; defaults stay omitted', async t => {
  const calls = capture(t)
  await generateImage(upstream, request)
  assert.equal(calls.at(-1).body.watermark, undefined)
  assert.equal(calls.at(-1).body.prompt_extend, undefined)
  const result = await generateImage({ ...upstream, watermark: false, promptExtend: false }, { ...request, mode: 'edit', image, images: [image] })
  assert.equal(result.images[0].b64, png)
  assert.equal(calls.at(-1).headers['content-type'], 'application/json')
  assert.deepEqual(calls.at(-1).body, {
    model: request.model, prompt: request.prompt, size: '2560x1440', response_format: 'b64_json',
    watermark: false, prompt_extend: false, images: [{ image_url: image }, { image_url: image }],
  })
  await generateImage({ ...upstream, watermark: true, promptExtend: true }, request)
  assert.equal(calls.at(-1).body.watermark, true)
  assert.equal(calls.at(-1).body.prompt_extend, true)
  await assert.rejects(generateImage(upstream, { ...request, mode: 'edit', image, mask: image }), error => error.code === 'mask-unsupported')
})

test('SenseNova sizes use documented 32-pixel alignment at every clarity and aspect ratio', async t => {
  const calls = capture(t)
  for (const size of ['1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9']) {
    for (const quality of ['1k', '2k', '4k']) {
      await generateImage(upstream, { ...request, size, quality })
      const [width, height] = calls.at(-1).body.size.split('x').map(Number)
      assert.equal(width % 32, 0)
      assert.equal(height % 32, 0)
      assert.ok(Math.min(width, height) >= 512 && Math.max(width, height) <= 4096)
      assert.ok(Math.max(width, height) / Math.min(width, height) <= 3)
      assert.equal(calls.at(-1).body.quality, undefined)
      assert.equal(calls.at(-1).body.detail, undefined)
    }
  }
  await generateImage(upstream, { ...request, size: 'auto' })
  assert.equal(calls.at(-1).body.size, undefined)
})

test('channel preferences reach the runtime and history records generation start time', async t => {
  let sent, now = 1000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent = JSON.parse(init.body)
    now = 5000
    return Response.json({ data: [{ b64_json: png }] })
  })
  let saved
  const runtime = new ImageGenerationRuntime(() => ({
    defaultChannelId: 'one', channels: [{ ...upstream, id: 'one', name: 'SenseNova relay', models: [], watermark: false, promptExtend: false }],
  }), { append: async entry => { saved = entry; return [] } })
  await runtime.run(request)
  assert.equal(sent.watermark, false)
  assert.equal(sent.prompt_extend, false)
  assert.equal(saved.createdAt, 1000, 'history retains the timestamp captured before the provider finishes at 5000')
  assert.equal(saved.mode, 'text')
})

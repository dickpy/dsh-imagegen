import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImage } from '../src/engine.ts'

const upstream = { apiUrl: 'https://api.openai.com/v1', apiKey: 'test-key' }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const request = { mode: 'text', model: 'gpt-image-2.5-sunburst', prompt: 'a cat', size: '16:9', quality: '4k', n: 1, detail: '' }

/** Observe the public engine's outgoing payload, rather than a private helper. */
function captureRequests(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const form = init.body instanceof FormData ? init.body : undefined
    calls.push({ url, form, body: form === undefined ? JSON.parse(init.body) : Object.fromEntries(form) })
    return Response.json({ data: [{ b64_json: png }] })
  })
  return calls
}

// Expected wire sizes include the existing 1K presets, even where the legacy
// preset only approximates the selected ratio. Higher tiers fit the API budget.
const sizes = {
  '1:1': ['1024x1024', '2048x2048', '2880x2880'],
  '3:4': ['1024x1536', '1536x2048', '2448x3264'],
  '4:3': ['1536x1024', '2048x1536', '3264x2448'],
  '9:16': ['1024x1792', '1440x2560', '2160x3840'],
  '2:3': ['1024x1536', '1728x2592', '2304x3456'],
  '3:2': ['1536x1024', '2592x1728', '3456x2304'],
  '16:9': ['1792x1024', '2560x1440', '3840x2160'],
  '21:9': ['1792x1024', '2560x1104', '3840x1648'],
}

for (const [ratio, pixels] of Object.entries(sizes)) {
  test(`GPT Image 2 maps ${ratio} clarity tiers to valid output dimensions`, async t => {
    const calls = captureRequests(t)
    for (const [index, quality] of ['1k', '2k', '4k'].entries()) {
      const result = await generateImage(upstream, { ...request, size: ratio, quality })
      const { url, body } = calls.at(-1)
      assert.equal(url, 'https://api.openai.com/v1/images/generations')
      assert.equal(body.size, pixels[index], `${ratio} / ${quality}`)
      assert.equal(body.quality, ['low', 'medium', 'high'][index])
      assert.equal(body.n, undefined)
      assert.equal(result.images[0].b64, png)
      const [width, height] = body.size.split('x').map(Number)
      assert.equal(width % 16, 0)
      assert.equal(height % 16, 0)
      assert.ok(Math.max(width, height) <= 3840)
      assert.ok(width * height <= 8_294_400)
      assert.ok(width * height >= 655_360)
      assert.ok(Math.max(width, height) / Math.min(width, height) <= 3)
      if (quality !== '1k') {
        const [rw, rh] = ratio.split(':').map(Number)
        // Preserve the intended ratio within half of the 16px alignment step.
        const shortEdge = Math.min(width, height)
        const idealShortEdge = Math.max(width, height) * Math.min(rw, rh) / Math.max(rw, rh)
        assert.ok(Math.abs(shortEdge - idealShortEdge) <= 8)
      }
    }
  })
}

test('GPT Image 2 versions, variants and snapshots use tiered sizes', async t => {
  const calls = captureRequests(t)
  for (const model of ['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-3', ' GPT-IMAGE-2.5-SUNBURST ']) {
    await generateImage(upstream, { ...request, model })
    assert.equal(calls.at(-1).body.size, '3840x2160', model)
  }
})

test('older GPT Image and other OpenAI-compatible models keep legacy sizes', async t => {
  const calls = captureRequests(t)
  for (const model of ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image', 'gpt-image-latest', 'gpt-image-2foo', 'gpt-image-2.5foo', 'flux-1.1-pro']) {
    for (const quality of ['2k', '4k']) {
      await generateImage(upstream, { ...request, model, quality })
      assert.equal(calls.at(-1).body.size, '1792x1024', `${model} / ${quality}`)
    }
  }
  await generateImage(upstream, { ...request, model: 'dall-e-3' })
  assert.equal(calls.at(-1).body.size, '1792x1024')
  assert.equal(calls.at(-1).body.quality, undefined)
})

test('automatic and unrecognized clarity keep the legacy fixed-ratio default', async t => {
  const calls = captureRequests(t)
  for (const quality of ['auto', '', 'medium']) {
    await generateImage(upstream, { ...request, quality })
    assert.equal(calls.at(-1).body.size, '1792x1024')
    assert.equal(calls.at(-1).body.quality, undefined)
  }
})

test('automatic, empty and unrecognized aspect ratios omit size at every tier', async t => {
  const calls = captureRequests(t)
  for (const size of ['auto', '', '5:7']) {
    for (const quality of ['auto', '1k', '2k', '4k']) {
      await generateImage(upstream, { ...request, size, quality })
      assert.equal(calls.at(-1).body.size, undefined, `${size} / ${quality}`)
    }
  }
})

test('size capabilities follow the resolved upstream id, including the default model', async t => {
  const calls = captureRequests(t)
  await generateImage(upstream, { ...request, model: 'my-image-model', upstream: 'gpt-image-2.5-sunburst' })
  assert.equal(calls.at(-1).body.size, '3840x2160')
  assert.equal(calls.at(-1).body.model, 'gpt-image-2.5-sunburst')
  await generateImage(upstream, { ...request, model: 'gpt-image-2', upstream: 'flux-1.1-pro' })
  assert.equal(calls.at(-1).body.size, '1792x1024')
  await generateImage(upstream, { ...request, model: '' })
  assert.equal(calls.at(-1).body.model, 'gpt-image-2')
  assert.equal(calls.at(-1).body.size, '3840x2160')
})

test('multipart edits carry the selected resolution and every reference image', async t => {
  const calls = captureRequests(t)
  const image = `data:image/png;base64,${png}`
  for (const [quality, expectedSize] of [['2k', '2560x1440'], ['4k', '3840x2160']]) {
    for (const images of [[], [image]]) {
      await generateImage(upstream, { ...request, mode: 'edit', quality, image, images })
      const { url, form, body } = calls.at(-1)
      assert.equal(url, 'https://api.openai.com/v1/images/edits')
      assert.ok(form instanceof FormData)
      assert.equal(body.size, expectedSize)
      assert.equal(body.quality, quality === '2k' ? 'medium' : 'high')
      const references = form.getAll(images.length === 0 ? 'image' : 'image[]')
      assert.equal(references.length, 1 + images.length)
      assert.equal(Buffer.from(await references[0].arrayBuffer()).toString('base64'), png)
    }
  }
})

test('full endpoint URLs use the same tiered mapping', async t => {
  const calls = captureRequests(t)
  const apiUrl = 'https://relay.example.test/custom/generate'
  await generateImage({ ...upstream, apiUrl, apiUrlFull: true }, request)
  assert.equal(calls[0].url, apiUrl)
  assert.equal(calls[0].body.size, '3840x2160')
})

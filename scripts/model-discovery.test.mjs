import assert from 'node:assert/strict'
import test from 'node:test'
import { listImageModels, listOpenAIModels } from '../src/prompt-enhancer.ts'
const config = { apiUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'fixture' }
test('DashScope native output.models[].model is discovered without changing the generation URL', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url)
    return Response.json({ success: true, output: { total: 5, models: [{ model: 'qwen3-max' }, { model: 'qwen-image-3.0-pro' }, { model: 'qwen-image-3.0-pro' }, {}, null] } })
  })
  assert.deepEqual(await listImageModels(config), ['qwen-image-3.0-pro'])
  // Image detection probes the plain list and the `?kind=image` variant (#86).
  assert.deepEqual(calls, [
    'https://dashscope.aliyuncs.com/api/v1/models',
    'https://dashscope.aliyuncs.com/api/v1/models?kind=image',
  ])
  assert.equal(config.apiUrl, 'https://dashscope.aliyuncs.com/api/v1')
})
for (const [label, body] of Object.entries({ openai: { data: [{ id: 'gpt-image-2' }] }, models: { models: ['gpt-image-2'] }, array: [{ id: 'gpt-image-2' }], empty: { output: { models: [] } } })) {
  test(`keeps ${label} discovery working`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    assert.deepEqual(await listOpenAIModels(config), label === 'empty' ? [] : ['gpt-image-2'])
  })
}

// #86: a gateway that strips capability metadata from the plain list and only
// tags image models on the filtered one must still be discovered completely.
test('a gateway that tags image models only on ?kind=image lists all of them', async t => {
  const plain = {
    data: [
      { id: '65535/gpt-image-2', object: 'model' },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `loomy/img-${index}`, object: 'model' })),
      { id: 'chat-model-a', object: 'model' },
    ],
  }
  const filtered = {
    data: [
      { id: '65535/gpt-image-2', kind: 'image', modalities: { output: ['image'] } },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `loomy/img-${index}`,
        kind: 'image',
        supported_endpoint_types: ['image-generation'],
      })),
    ],
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url))
    return Response.json(String(url).includes('kind=image') ? filtered : plain)
  })
  const models = await listImageModels({ apiUrl: 'http://gateway.test/v1', apiKey: 'fixture' })
  assert.equal(models.length, 25)
  assert.ok(models.includes('loomy/img-23'))
  assert.ok(!models.includes('chat-model-a'))
  assert.deepEqual(calls, [
    'http://gateway.test/v1/models',
    'http://gateway.test/v1/models?kind=image',
  ])
  // The chat model list must stay exactly what the plain endpoint exposes.
  assert.equal((await listOpenAIModels({ apiUrl: 'http://gateway.test/v1', apiKey: 'fixture' })).length, 26)
})

test('a strict gateway rejecting the kind filter still lists from the plain endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('kind=image')
    ? new Response(JSON.stringify({ error: { message: 'unknown query parameter: kind' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
    : Response.json({ data: [{ id: 'gpt-image-2' }] }))
  assert.deepEqual(await listImageModels({ apiUrl: 'http://gateway.test/v1', apiKey: 'fixture' }), ['gpt-image-2'])
})

test('kind, supported_endpoint_types and nested modalities mark image models', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    data: [
      { id: 'by-kind', kind: 'image' },
      { id: 'by-endpoint', supported_endpoint_types: ['image-edit'] },
      { id: 'by-modality', modalities: { input: ['text'], output: ['image'] } },
      { id: 'by-negative-kind', kind: 'chat', modalities: { output: ['text'] } },
    ],
  }))
  assert.deepEqual(
    await listImageModels({ apiUrl: 'http://gateway.test/v1', apiKey: 'fixture' }),
    ['by-endpoint', 'by-kind', 'by-modality'],
  )
})

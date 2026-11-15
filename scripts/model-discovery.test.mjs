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
  assert.deepEqual(calls, ['https://dashscope.aliyuncs.com/api/v1/models'])
  assert.equal(config.apiUrl, 'https://dashscope.aliyuncs.com/api/v1')
})
for (const [label, body] of Object.entries({ openai: { data: [{ id: 'gpt-image-2' }] }, models: { models: ['gpt-image-2'] }, array: [{ id: 'gpt-image-2' }], empty: { output: { models: [] } } })) {
  test(`keeps ${label} discovery working`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    assert.deepEqual(await listOpenAIModels(config), label === 'empty' ? [] : ['gpt-image-2'])
  })
}

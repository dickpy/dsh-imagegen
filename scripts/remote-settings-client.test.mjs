import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindImageGenScope, imageModelOptions } from '../.test-build/settings-scope.js'

const value = {
  channels: [{ id: 'images', name: 'Images', models: [{ id: 'gpt-image-2', alias: 'GPT Image 2' }] }],
  defaultChannelId: 'images', defaultModel: 'GPT Image 2',
}
function bridge(writable) {
  return async (path, init) => {
    assert.equal(path, '/api/dsh-imagegen/settings/describe')
    assert.equal(init.method, 'POST')
    return Response.json({ ok: true, value: { writable, namespaces: [{ ns: 'dsh-imagegen', value, base: value, user: {}, revision: 1, secrets: [] }] } })
  }
}

test('trusted remote settings load models from the same-origin bridge', async () => {
  const scope = bindImageGenScope(bridge(true))
  await scope.load()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(scope.getSnapshot().writable, true)
  assert.deepEqual(imageModelOptions(scope.getSnapshot().value).models, ['GPT Image 2'])
  await scope.dispose()
})

test('authenticated read-only settings still display models without enabling writes', async () => {
  const scope = bindImageGenScope(bridge(false))
  await scope.load()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(scope.getSnapshot().writable, false)
  assert.deepEqual(imageModelOptions(scope.getSnapshot().value).models, ['GPT Image 2'])
  await scope.dispose()
})

test('denied authentication does not expose settings', async () => {
  const scope = bindImageGenScope(async () => new Response('unauthorized', { status: 401 }))
  await scope.load()
  assert.equal(scope.getSnapshot().status, 'unavailable')
  assert.equal(scope.getSnapshot().writable, false)
  await scope.dispose()
})

test('client bootstrap delegates access to the host rather than loopback/domain heuristics', async () => {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(source, /bindImageGenScope\(\(input, init\) => fetch\(input, init\)\)/)
  assert.doesNotMatch(source, /connection\?\.isLoopback|settings bridge is loopback-only|location\??\.origin\s*===/)
})

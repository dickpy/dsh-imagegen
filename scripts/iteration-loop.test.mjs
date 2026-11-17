import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendHistory, listHistory, readHistoryImage, removeHistory, clearHistory } from '../src/history-store.ts'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { registerEditImageCommand, latestSessionImage } from '../src/edit-image-command.ts'
import { submitAgentImageEdit } from '../src/agent-image-tools.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const image = { b64: png, mime: 'image/png' }
const entry = { id: 'root', createdAt: 1, mode: 'text', model: 'gpt-image-2', prompt: 'one', size: '1:1', quality: '1k', detail: '', n: 1, images: [image, image] }
const ref = id => ({ attachmentId: id, mediaType: 'image/png', bytes: 70, width: 1, height: 1 })
const channel = { id: 'one', name: 'One', apiUrl: 'https://example.test/v1', apiKey: 'test', models: [{ alias: 'text only', id: 'glm-image' }, { alias: 'editable', id: 'gpt-image-2' }] }
const config = () => ({ enabled: true, allowAgentImageGeneration: true, channels: [channel], defaultChannelId: 'one', defaultModel: 'text only' })
function runtime() {
  const requests = []
  let task
  return { requests, queue: {
    submit(request) { requests.push(request); task = { id: 'task', request, status: 'completed', result: { images: [image] } }; return task },
    list: () => [task], subscribe: () => () => {}, cancel() {},
  } }
}

test('history persists lazy references, exact parent image and a shared branch root; deletion cleans references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-iteration-'))
  setImageDataRoot(root)
  try {
    await appendHistory(entry)
    await appendHistory({ ...entry, id: 'second', mode: 'edit', parentId: 'root', parentImageIndex: 1, refs: [image, image] })
    await appendHistory({ ...entry, id: 'third', mode: 'edit', parentId: 'second', refs: [image] })
    await appendHistory({ ...entry, id: 'branch', mode: 'edit', parentId: 'second', refs: [image] })
    const entries = await listHistory()
    assert.equal(entries[0].threadId, 'root')
    assert.equal(entries[1].threadId, 'root')
    assert.equal(entries[2].parentImageIndex, 1)
    assert.equal(entries[2].refs.length, 2)
    assert.ok(!JSON.stringify(entries).includes(png), 'lists carry no bytes')
    const file = entries[2].refs[0].url.split('/history/image/')[1]
    assert.equal((await readHistoryImage(file)).data.toString('base64'), png)
    const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'))
    assert.ok(!JSON.stringify(index).includes(png), 'index stores filenames only')
    assert.equal((await readHistoryImage('../index.json')), undefined)
    await removeHistory('second')
    assert.equal(await readHistoryImage(file), undefined)
    assert.equal((await listHistory())[0].threadId, 'root', 'deleting an ancestor keeps recorded provenance')
    await clearHistory()
    assert.deepEqual(await listHistory(), [])
  } finally { setImageDataRoot(undefined); await rm(root, { recursive: true, force: true }) }
})

test('invalid parent image indices do not create false lineage and legacy records still load', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-iteration-'))
  setImageDataRoot(root)
  try {
    await appendHistory(entry)
    await appendHistory({ ...entry, id: 'bad', mode: 'edit', parentId: 'root', parentImageIndex: 99 })
    assert.equal((await listHistory())[0].parentId, undefined)
    assert.equal((await listHistory())[1].id, 'root')
  } finally { setImageDataRoot(undefined); await rm(root, { recursive: true, force: true }) }
})

test('command edit falls back from a text-only upstream and preserves reference dimensions', async () => {
  const run = runtime()
  await submitAgentImageEdit({ readImage: async source => ({ ref: source, data: Buffer.from(png, 'base64') }) }, run, config, { prompt: 'night', sourceImage: { ...ref('source'), width: 300, height: 400 } })
  assert.equal(run.requests[0].model, 'editable')
  assert.equal(run.requests[0].size, '3:4')
  assert.equal(run.requests[0].quality, '1k')
  await assert.rejects(() => submitAgentImageEdit({}, run, () => ({ ...config(), channels: [{ ...channel, models: channel.models.slice(0, 1) }] }), { prompt: 'night', sourceImage: ref('source') }), { code: 'edit-model-unavailable' })
})

test('two consecutive edit commands use the newly committed result, and explicit invocation images take priority', async () => {
  const run = runtime(), sources = [], messages = [{ content: [{ type: 'image', attachment: ref('original') }] }]
  let handler, serial = 0
  const ctx = {
    commands: { register(definition) { handler = definition.handler; return () => {} } },
    attachments: {
      readImage: async source => { sources.push(source.attachmentId); return { ref: source, data: Buffer.from(png, 'base64') } },
      saveImages: async () => [ref(`result-${++serial}`)],
    },
  }
  registerEditImageCommand(ctx, run, config)
  const invocation = { rawInput: 'night', signal: new AbortController().signal, agent: { id: 'session', session: {
    deriveMessages: () => messages, append(type, message) { assert.equal(type, 'user/message'); messages.push(message) },
  } } }
  assert.equal((await handler(invocation)).kind, 'success')
  assert.equal(latestSessionImage(messages).attachmentId, 'result-1')
  assert.equal((await handler({ ...invocation, rawInput: 'fog' })).kind, 'success')
  assert.deepEqual(sources, ['original', 'result-1'])
  await handler({ ...invocation, attachments: [{ type: 'image', attachment: ref('explicit') }] })
  assert.equal(sources.at(-1), 'explicit')
})

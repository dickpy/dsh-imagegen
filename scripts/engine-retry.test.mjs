import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImage } from '../src/engine.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const upstream = { apiUrl: 'https://relay.example/v1', apiKey: 'test-key' }
const request = { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '1k', detail: '', n: 1 }

const upstreamError = (message, status) => Response.json({ message }, { status })

test('a transient upstream failure is retried and the task succeeds', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    if (attempts === 1) return upstreamError('overloaded', 503)
    return Response.json({ data: [{ b64_json: png }] })
  })
  const result = await generateImage(upstream, request)
  assert.equal(result.images.length, 1)
  assert.equal(attempts, 2)
  assert.equal(result.partialError, undefined)
})

test('a refused connection is retried once the network blip passes', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:443')
    return Response.json({ data: [{ b64_json: png }] })
  })
  const result = await generateImage(upstream, request)
  assert.equal(result.images.length, 1)
  assert.equal(attempts, 2)
})

test('retry attempts stop at the cap and the last failure is thrown with its status', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    return upstreamError('overloaded', 503)
  })
  await assert.rejects(generateImage(upstream, request), error => {
    assert.equal(error.code, 'upstream-rejected')
    assert.equal(error.status, 503)
    return true
  })
  assert.equal(attempts, 3)
})

test('auth and validation rejections are final — no quota is spent on retries', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    return upstreamError('bad key', 401)
  })
  await assert.rejects(generateImage(upstream, request), error => {
    assert.equal(error.code, 'upstream-rejected')
    assert.equal(error.status, 401)
    return true
  })
  assert.equal(attempts, 1)
})

test('one permanently failing member of a parallel batch keeps the successful subset', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    // Three parallel single-image requests hit the same stub; the third call
    // answers 401 (final — no retry), the rest succeed.
    if (attempts === 3) return upstreamError('bad key', 401)
    return Response.json({ data: [{ b64_json: png }] })
  })
  const result = await generateImage(upstream, { ...request, n: 3 })
  assert.equal(result.images.length, 2)
  assert.match(result.partialError ?? '', /^1\/3 张图片生成失败：/)
  assert.equal(attempts, 3)
})

test('a batch where every member fails throws the upstream failure unchanged', async t => {
  t.mock.method(globalThis, 'fetch', async () => upstreamError('model not found', 404))
  await assert.rejects(generateImage(upstream, { ...request, n: 2 }), error => {
    assert.equal(error.code, 'upstream-rejected')
    assert.equal(error.status, 404)
    return true
  })
})

test('unknown async status words keep the poll alive until the task completes', async t => {
  let posts = 0
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posts += 1
      return Response.json({ data: [{ task_id: 'task-1' }] })
    }
    polls += 1
    if (polls === 1) return Response.json({ data: [{ task_status: 'weird_running_state' }] })
    return Response.json({ data: [{ task_status: 'completed', result: { images: [{ b64_json: png }] } }] })
  })
  const result = await generateImage(upstream, request)
  assert.equal(result.images.length, 1)
  assert.equal(posts, 1)
  assert.equal(polls, 2)
})

test('an explicit failure status word still fails the poll immediately', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST') return Response.json({ data: [{ task_id: 'task-1' }] })
    return Response.json({ data: [{ task_status: 'failed', message: 'content policy' }] })
  })
  await assert.rejects(generateImage(upstream, request), error => {
    assert.equal(error.code, 'upstream-rejected')
    assert.match(error.message, /content policy/)
    return true
  })
})

test('a non-JSON 5xx body keeps its status and is retried', async t => {
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    attempts += 1
    if (attempts === 1) return new Response('<html>502 Bad Gateway</html>', { status: 502 })
    return Response.json({ data: [{ b64_json: png }] })
  })
  const result = await generateImage(upstream, request)
  assert.equal(result.images.length, 1)
  assert.equal(attempts, 2)
})

test('a transient poll failure is retried without submitting a second task', async t => {
  let posts = 0
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posts += 1
      return Response.json({ data: [{ task_id: 'task-1' }] })
    }
    polls += 1
    if (polls === 1) return Response.json({ message: 'gateway hiccup' }, { status: 503 })
    return Response.json({ data: [{ task_status: 'completed', result: { images: [{ b64_json: png }] } }] })
  })
  const result = await generateImage(upstream, request)
  assert.equal(result.images.length, 1)
  assert.equal(posts, 1, 'the accepted task is never re-submitted')
  assert.equal(polls, 2)
})

test('a provider that returns fewer images than requested explains the shortfall', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: png }] }))
  const result = await generateImage(upstream, { ...request, model: 'dall-e-3', n: 2 })
  assert.equal(result.images.length, 1)
  assert.match(result.partialError ?? '', /仅返回 1 张图片（请求 2 张）/)
})

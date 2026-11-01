/**
 * Route-level tests for `POST /api/dsh-imagegen/reverse-prompt`.
 *
 * The skill call is stubbed, so this only locks the wire contract the client
 * depends on: body validation, asset-id hygiene, and a clean error envelope.
 *
 * Run: node scripts/reverse-prompt-route.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import url from 'node:url'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const host = await import(url.pathToFileURL(path.join(root, 'lib', 'index.js')).href)

/** Assemble just enough deps for the route table; the skill seam is injected. */
function makeInvoke(skills) {
  const routes = host.makeRoutes({
    settings: { describe: () => [], mutate: async () => {} },
    resolve: () => ({ apiUrl: '', apiKey: '' }),
    ...skills === undefined ? {} : { skills },
  })
  return async (body) => {
    const route = routes.find(candidate => candidate.path.endsWith('/reverse-prompt'))
    assert.ok(route !== undefined, 'reverse-prompt route must be registered')
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      // The loopback guard also looks at the Host header, like the real client.
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    })
    let raw = ''
    await route.handler(req, {
      writeHead() {},
      setHeader() {},
      end(chunk) { raw += chunk === undefined ? '' : String(chunk) },
    })
    return JSON.parse(raw)
  }
}

/** Minimal skills seam: only `reversePrompt` matters here. */
function seam(reversePrompt) {
  return {
    list: async () => ({ skills: [], agentAvailable: false, registryAvailable: false, installed: [] }),
    run: async () => { throw new Error('not used') },
    task: () => undefined,
    tasksOfCanvas: () => [],
    cancel: async () => false,
    ...reversePrompt === undefined ? {} : { reversePrompt },
  }
}

test('a) 合法请求：透传 detail/output/instruction 并回传提示词', async () => {
  const seen = []
  const invoke = makeInvoke(seam(async request => {
    seen.push(request)
    return { prompt: '85mm 定焦，浅景深，浅金色晨光' }
  }))
  const body = await invoke({
    images: [{ assetId: 'abc123.png' }],
    detail: 'brief',
    output: 'en',
    instruction: 'keep the palette',
    language: 'zh',
  })
  assert.deepEqual(body, { ok: true, prompt: '85mm 定焦，浅景深，浅金色晨光' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].detail, 'brief')
  assert.equal(seen[0].output, 'en')
  assert.equal(seen[0].instruction, 'keep the palette')
  assert.equal(seen[0].images[0].assetId, 'abc123.png')
})

test('b) 未识别的枚举值回落到标准/跟随界面', async () => {
  const seen = []
  const invoke = makeInvoke(seam(async request => { seen.push(request); return { prompt: 'x' } }))
  await invoke({ images: [{ assetId: 'a.png' }], detail: 'huge', output: 'fr' })
  assert.equal(seen[0].detail, 'standard')
  assert.equal(seen[0].output, 'follow')
})

test('c) 图片数量与资产 id 校验', async () => {
  const invoke = makeInvoke(seam(async () => ({ prompt: 'x' })))
  assert.deepEqual(await invoke({ images: [] }), { ok: false, code: 'bad-request', message: '请选择 1–6 张图片' })
  assert.deepEqual(await invoke({ images: Array.from({ length: 7 }, () => ({ assetId: 'a.png' })) }), { ok: false, code: 'bad-request', message: '请选择 1–6 张图片' })
  const escape = await invoke({ images: [{ assetId: '../etc/passwd' }] })
  assert.equal(escape.code, 'bad-request')
  assert.equal(escape.message, '图片资产无效')
})

test('d) 宿主没有挂载反推能力 / 技能抛错：返回可读错误', async () => {
  const unavailable = await makeInvoke(seam(undefined))({ images: [{ assetId: 'a.png' }] })
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.message, /unavailable/)
  const failing = await makeInvoke(seam(async () => { throw new Error('模型没有返回提示词') }))({ images: [{ assetId: 'a.png' }] })
  assert.deepEqual(failing, { ok: false, code: 'reverse-failed', message: '模型没有返回提示词' })
})

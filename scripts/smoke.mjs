/**
 * Standalone smoke test for the built @dickpy/dsh-imagegen artifacts:
 *
 *  A. host half loads and exposes the plugin contract
 *  B. generate engine works against a mock OpenAI-compatible upstream
 *     (text mode with b64_json, edit mode with multipart + url result)
 *  C. route handlers (settings bridge + generate) work over real HTTP
 *  D. client bundle registers via window.__ModuleLoader__ and the factory
 *     exposes apply/inject with the right shape
 *
 * Run: node scripts/smoke.mjs   (from the package root)
 */
import { createServer, request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const results = []
/** Run one check; async-aware and sequential so nothing races the servers. */
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** Wait for React/jsdom state to settle without relying on a fixed delay. */
async function waitForSelector(root, selector, timeout = 1200) {
  const deadline = Date.now() + timeout
  while (root.querySelector(selector) === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(root.querySelector(selector) !== null, `selector did not render: ${selector}`)
}

/** Wait for async fixture data to reach the rendered list, not just its host. */
async function waitForSelectorCount(root, selector, count, timeout = 1200) {
  const deadline = Date.now() + timeout
  while (root.querySelectorAll(selector).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(root.querySelectorAll(selector).length >= count, `expected ${count} matches: ${selector}`)
}

// ---------------------------------------------------------------- A. host half
const host = await import(new URL('lib/index.js', root).href)
await check('A1 host exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.name, 'imagegen')
  assert.deepEqual(host.inject, ['webServer', 'systemPrompt'])
  assert.equal(typeof host.Config, 'function')
  assert.equal(typeof host.ImageGenSettingsNamespace, 'string') // branded at runtime as string
  assert.equal(typeof host.makeRoutes, 'function')
  assert.equal(typeof host.generateImage, 'function')
})
await check('A2 Config schema validates + marks apiKey secret', () => {
  const resolved = host.Config({ apiUrl: 'https://x/v1', apiKey: 'sk-1' })
  assert.equal(resolved.apiKey, 'sk-1')
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.allowAgentImageGeneration, true)
  assert.deepEqual(resolved.imageModels, [])
  // Config is the schemastery schema itself: the secret role lives on the
  // schema node, which the settings seam's redactor walks.
  assert.equal(host.Config.dict?.apiKey?.meta?.role, 'secret')
})
await check('A3 updater parses stable Releases and caches checks', async () => {
  assert.equal(host.compareVersions('v1.0.3', '1.0.2') > 0, true)
  assert.equal(host.compareVersions('1.0.2', '1.0.2'), 0)
  assert.equal(host.profileFromProcess(['node', 'dsh', '--profile', 'desktop'], {}), 'desktop')
  host.clearUpdateCache()
  let calls = 0
  const fetchRelease = async () => {
    calls += 1
    return new Response(JSON.stringify({
      tag_name: 'v9.9.9',
      html_url: 'https://github.com/dickpy/dsh-imagegen/releases/tag/v9.9.9',
      published_at: '2026-08-17T00:00:00Z',
      draft: false,
      prerelease: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const first = await host.checkForUpdate(fetchRelease, 1000)
  const second = await host.checkForUpdate(fetchRelease, 1001)
  assert.equal(first.latestVersion, '9.9.9')
  assert.equal(first.updateAvailable, true)
  assert.equal(second, first)
  assert.equal(calls, 1)
  host.clearUpdateCache()
})

// ---------------------------------------------- B. engine vs mock upstream
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
let activeGenerationRequests = 0
let maxGenerationRequests = 0
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'grok-imagine-image' },
      { id: 'gpt-image-2' },
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'glm-image', capabilities: { image_generation: true } },
      { id: 'chat-only-model', capabilities: { image_generation: false } },
      { id: 'gpt-image-legacy', capabilities: { image_generation: false } },
      { id: 'gpt-image-2' },
    ] }))
    return
  }
  if (url.pathname === '/v1/images/generations') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    assert.ok(body.model === 'gpt-image-2' || body.model === 'grok-imagine-image')
    assert.ok(body.prompt === 'a cat' || body.prompt === 'a mismatch cat' || body.prompt === 'a background cat' || body.prompt === 'cancel this' || body.prompt === 'signed urls' || body.prompt === 'parallel one' || body.prompt === 'parallel two')
    if (body.model === 'gpt-image-2') {
      assert.equal(body.size, '1024x1024')
      assert.equal(body.quality, 'high')
    } else {
      assert.equal(body.aspect_ratio, '1:1')
      assert.equal(body.response_format, 'b64_json')
    }
    // The engine never sends `n`: Responses-API gateways reject the batch
    // parameter, so the requested count is satisfied by parallel requests.
    assert.equal(body.n, undefined)
    assert.equal(body.detail, body.model === 'grok-imagine-image' || body.prompt === 'signed urls' ? undefined : 'standard')
    if (body.prompt === 'parallel one' || body.prompt === 'parallel two') {
      activeGenerationRequests += 1
      maxGenerationRequests = Math.max(maxGenerationRequests, activeGenerationRequests)
      await new Promise(resolve => setTimeout(resolve, 50))
      activeGenerationRequests -= 1
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const data = body.prompt === 'signed urls'
      ? [
          { b64_json: '', url: `http://127.0.0.1:${upstream.address().port}/image/gcs-signed.png?X-Goog-Credential=test&X-Goog-Signature=test` },
          { b64_json: '   ', url: `http://127.0.0.1:${upstream.address().port}/image/s3-signed.png?X-Amz-Credential=test&X-Amz-Signature=test` },
        ]
      : [
          { b64_json: pngBytes.toString('base64'), revised_prompt: 'a refined cat' },
          { url: `http://127.0.0.1:${upstream.address().port}/image/${body.prompt === 'a mismatch cat' ? 'mismatch' : 'result'}.png` },
        ]
    res.end(JSON.stringify({ created: 1, data }))
    return
  }
  if (url.pathname === '/v1/images/edits') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    assert.ok(req.headers['content-type'].startsWith('multipart/form-data'), 'multipart expected')
    assert.ok(body.includes('name="prompt"') && body.includes('edit this'), 'prompt part missing')
    assert.ok(body.includes('name="model"') && body.includes('gpt-image-2'), 'model part missing')
    assert.ok(body.includes('name="size"') && body.includes('1536x1024'), 'size part missing')
    assert.ok(!body.includes('name="n"'), 'n must not be sent (batch param rejected)')
    assert.ok(body.includes('name="image"'), 'image part missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/image/result.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/mismatch.png') {
    // Regression fixture: the provider declares JPEG while returning PNG bytes.
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    res.end(pngBytes)
    return
  }
  if (url.pathname === '/image/gcs-signed.png' || url.pathname === '/image/s3-signed.png') {
    assert.equal(req.headers.authorization, undefined, 'presigned URLs must not receive the channel API key')
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

await check('B1 text generation normalizes b64_json + url items', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    // n=1: one request returns two data items (b64_json + url), both normalized.
    { mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[0].mime, 'image/png')
  assert.equal(result.images[0].revisedPrompt, 'a refined cat')
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].mime, 'image/png')
})

await check('B2 signed URLs bypass API-key auth and empty base64 falls back to URL', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'signed urls', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(result.images[1].b64, pngBytes.toString('base64'))
})

await check('B3 edit mode sends multipart and normalizes', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'edit this', size: '3:2', quality: '2k', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B4 config missing errors are user-presentable', async () => {
  await assert.rejects(
    host.generateImage({ apiUrl: '', apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_url 未配置/,
  )
  await assert.rejects(
    host.generateImage({ apiUrl: 'http://x', apiKey: '' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
    /api_key 未配置/,
  )
})

await check('B5 upstream error surfaces its message', async () => {
  const bad = createServer(async (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Unknown parameter: detail' } }))
  })
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
  const port = bad.address().port
  try {
    await assert.rejects(
      host.generateImage({ apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: 'auto', quality: 'auto', n: 1, detail: '' }),
      /Unknown parameter: detail/,
    )
  } finally {
    await new Promise(resolve => bad.close(resolve))
  }
})

await check('B6 dall-e-3 clamps params', async () => {
  const seen = []
  const dalle = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => dalle.listen(0, '127.0.0.1', resolve))
  const port = dalle.address().port
  try {
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      { mode: 'text', model: 'dall-e-3', prompt: 'x', size: '512x512', quality: 'high', n: 4, detail: 'high' },
    )
    // dall-e-3: params clamp to { model, size } and no `n` is ever sent.
    assert.deepEqual(seen[0], { model: 'dall-e-3', size: '1024x1024', prompt: 'x' })
  } finally {
    await new Promise(resolve => dalle.close(resolve))
  }
})

await check('B7 Volcengine Seedream uses Ark size and URL response fields', async () => {
  const seen = []
  const seedream = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push(body)
      assert.equal(body.model, 'doubao-seedream-5-0-pro-260628')
      assert.equal(body.size, '2K')
      assert.equal(body.response_format, 'url')
      assert.equal(body.resolution, undefined)
      assert.equal(body.prompt, 'a volcano')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${seedream.address().port}/seedream.png` }] }))
      return
    }
    if (url.pathname === '/seedream.png') {
      assert.equal(req.headers.authorization, 'Bearer sk-seedream')
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(pngBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => seedream.listen(0, '127.0.0.1', resolve))
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${seedream.address().port}/v1`, apiKey: 'sk-seedream' },
      { mode: 'text', model: 'doubao-seedream-5-0-pro-260628', prompt: 'a volcano', size: '16:9', quality: '4k', n: 1, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(seen.length, 1)
  } finally {
    await new Promise(resolve => seedream.close(resolve))
  }
})

await check('B8 Zhipu GLM-Image uses the official generation contract', async () => {
  const seen = []
  const zhipu = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/paas/v4/images/generations') {
      seen.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => zhipu.listen(0, '127.0.0.1', resolve))
  const port = zhipu.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/api/paas/v4`, apiKey: 'zhipu-key' },
      { mode: 'text', model: 'glm-image', prompt: 'x', size: '1:1', quality: '4k', n: 1, detail: 'high' },
    )
    assert.equal(result.images.length, 1)
    assert.deepEqual(seen[0], {
      path: '/api/paas/v4/images/generations',
      body: { model: 'glm-image', prompt: 'x', size: '1024x1024', quality: 'hd' },
    })
  } finally {
    await new Promise(resolve => zhipu.close(resolve))
  }
})

// ------------------------------------------------- C. routes over real HTTP
const stored = new Map() // namespace -> user section
const seam = {
  writable: true,
  describe({ redactSecrets } = {}) {
    const value = { enabled: true, announceToAgent: true, apiUrl: 'http://upstream/v1', apiKey: 'sk-secret' }
    const user = stored.get('dsh-imagegen')
    const merged = { ...value, ...user }
    const view = {
      ns: 'dsh-imagegen',
      value: redactSecrets ? { ...merged, apiKey: undefined } : merged,
      revision: stored.get('rev') ?? 0,
      ...user !== undefined ? { user: redactSecrets ? { ...user, apiKey: undefined } : user } : {},
      applies: 'live',
      ...redactSecrets ? { secrets: [{ path: ['apiKey'], set: (user?.apiKey ?? '') !== '' }] } : {},
    }
    return [view]
  },
  async mutate(ns, ops, expectedRevision) {
    assert.equal(String(ns), 'dsh-imagegen')
    const current = { ...(stored.get('dsh-imagegen') ?? {}) }
    for (const op of ops) {
      if (op.op === 'set') current[op.path[0]] = op.value
      else if (op.op === 'unset') delete current[op.path[0]]
    }
    stored.set('dsh-imagegen', current)
    stored.set('rev', (stored.get('rev') ?? 0) + 1)
  },
}
const persistedHistory = []
const history = {
  async list() { return persistedHistory },
  async append(entry) {
    const wire = {
      ...entry,
      images: entry.images.map((image, index) => ({
        url: `/api/dsh-imagegen/history/image/${entry.id}-${index}.png`,
        mime: image.mime,
        ...(image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt }),
      })),
    }
    persistedHistory.unshift(wire)
    return persistedHistory
  },
  async remove(id) {
    const index = persistedHistory.findIndex(entry => entry.id === id)
    if (index >= 0) persistedHistory.splice(index, 1)
    return persistedHistory
  },
  async clear() {
    persistedHistory.splice(0)
    return persistedHistory
  },
  async readImage() { return undefined },
}
const templateImage = Buffer.from('template-image')
let templateRefreshes = 0
const templates = {
  async list() {
    return {
      cases: [{
        id: 1,
        title: 'Poster template',
        prompt: 'Create a bright product poster',
        category: 'Posters & Typography',
        categoryZh: '海报与排版',
        styles: [],
        scenes: [],
        sourceLabel: '@author',
        sourceUrl: 'https://example.test/author',
        githubUrl: 'https://example.test/repo#1',
        image: 'case1.png',
        featured: true,
      }],
      total: 1,
      origin: 'bundled',
      repository: 'example/templates',
      fetchedAt: '2026-08-19T00:00:00.000Z',
    }
  },
  async refresh() {
    templateRefreshes += 1
    return { total: 1, fetchedAt: '2026-08-19T00:00:01.000Z' }
  },
  async readImage(file) {
    return file === 'case1.png' ? { data: templateImage, mime: 'image/png' } : undefined
  },
}
const agentPreviewImage = Buffer.from('agent-preview-image')
const agentPreviewRef = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: agentPreviewImage.length,
  width: 1,
  height: 1,
}
const attachments = {
  async readImage(ref) {
    assert.equal(ref.attachmentId, agentPreviewRef.attachmentId)
    assert.equal(ref.mediaType, agentPreviewRef.mediaType)
    assert.equal(ref.bytes, agentPreviewRef.bytes)
    return { ref: agentPreviewRef, data: agentPreviewImage }
  },
}
const routes = host.makeRoutes({
  settings: seam,
  resolve: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' }),
  history,
  templates,
  attachments,
})
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find(r => r.kind === 'exact'
    ? r.path === pathname
    : pathname === r.path || pathname.startsWith(`${r.path}/`))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res).catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const post = async (path, body, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

await check('C1 settings describe serves the redacted namespace', async () => {
  const { status, body } = await post('/api/dsh-imagegen/settings/describe', {})
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.writable, true)
  assert.equal(body.value.namespaces.length, 1)
  const view = body.value.namespaces[0]
  assert.equal(view.ns, 'dsh-imagegen')
  assert.equal(view.value.apiUrl, 'http://upstream/v1')
  assert.equal(view.value.apiKey, undefined)
  assert.deepEqual(view.secrets, [{ path: ['apiKey'], set: false }])
})

await check('C2 settings mutate writes + redacts the key', async () => {
  const { body } = await post('/api/dsh-imagegen/settings/mutate', {
    ns: 'dsh-imagegen',
    ops: [{ op: 'set', path: ['apiKey'], value: 'sk-new' }],
    expectedRevision: 0,
  })
  assert.equal(body.ok, true)
  assert.equal(body.value.secrets.find(s => s.path[0] === 'apiKey').set, true)
  assert.equal(body.value.value.apiKey, undefined)
  assert.equal(stored.get('dsh-imagegen').apiKey, 'sk-new')
})

await check('C3 generate route persists history server-side and enforces loopback fence', async () => {
  const { status, body } = await post('/api/dsh-imagegen/generate', {
    mode: 'text', model: 'gpt-image-2', prompt: 'a cat', size: '1:1', quality: '4k', n: 1, detail: 'standard',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.images.length, 2)
  assert.equal(persistedHistory.length, 1, 'history is written before the response reaches the browser')
  assert.equal(persistedHistory[0].prompt, 'a cat')
  assert.equal(persistedHistory[0].images.length, 2)
  assert.equal(body.history.length, 1)
  const missing = await post('/api/dsh-imagegen/generate', { mode: 'text', model: 'gpt-image-2', prompt: '  ', size: 'auto', quality: 'auto', n: 1, detail: '' })
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.message, /prompt is required/)
  // Non-loopback fence: a raw request carrying a foreign Host header must be
  // refused (undici forbids overriding Host on fetch, so go raw).
  const foreignStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/dsh-imagegen/generate',
      method: 'POST',
      headers: { host: 'evil.example.com', 'content-type': 'application/json' },
    }, res => { resolve(res.statusCode) }, reject)
    request.end('{}')
  })
  assert.equal(foreignStatus, 403)
})

await check('C4 comparison tasks run in parallel and share comparison history metadata', async () => {
  const comparisonId = 'smoke-comparison'
  const request = { mode: 'text', model: 'gpt-image-2', prompt: 'parallel one', size: '1:1', quality: '4k', n: 1, detail: 'standard', comparisonId, comparisonModels: ['gpt-image-2', 'grok-imagine-image'] }
  const first = await post('/api/dsh-imagegen/tasks/submit', request)
  const second = await post('/api/dsh-imagegen/tasks/submit', { ...request, model: 'grok-imagine-image', prompt: 'parallel two' })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await post('/api/dsh-imagegen/tasks/list', {})
    const ids = [first.body.task.id, second.body.task.id]
    if (ids.every(id => listed.body.tasks.find(task => task.id === id)?.status === 'completed')) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(maxGenerationRequests >= 2, 'comparison requests must overlap at the upstream')
  const comparisonEntries = persistedHistory.filter(entry => entry.comparisonId === comparisonId)
  assert.equal(comparisonEntries.length, 2)
  assert.deepEqual(comparisonEntries[0].comparisonModels, ['gpt-image-2', 'grok-imagine-image'])
})

await check('C5 image model discovery and configured-model allow-list work', async () => {
  const discovered = await post('/api/dsh-imagegen/image-models', {})
  assert.equal(discovered.body.ok, true)
  assert.deepEqual(discovered.body.models, ['glm-image', 'gpt-image-2', 'grok-imagine-image'])
  const presets = await post('/api/dsh-imagegen/presets', {})
  assert.equal(presets.body.ok, true)
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'openai-official').models, [{ alias: 'gpt-image-2', id: 'gpt-image-2' }])
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'zhipu-official').models, [{ alias: 'glm-image', id: 'glm-image' }])
  const rejected = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'not-configured', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'image-model-not-configured')
})

await check('C6 template routes serve the bundled gallery, refresh it, and proxy only known images', async () => {
  const { body: list } = await post('/api/dsh-imagegen/templates/list', {})
  assert.equal(list.ok, true)
  assert.equal(list.total, 1)
  assert.equal(list.cases[0].prompt, 'Create a bright product poster')

  const { body: refreshed } = await post('/api/dsh-imagegen/templates/refresh', {})
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.total, 1)
  assert.equal(templateRefreshes, 1)

  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/case1.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), templateImage)
  const unknown = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/not-allowed.png`)
  assert.equal(unknown.status, 404)
})

await check('C7 Agent tool-result image route serves durable attachments without a session-log image reference', async () => {
  const query = new URLSearchParams({
    attachment_id: agentPreviewRef.attachmentId,
    media_type: agentPreviewRef.mediaType,
    bytes: String(agentPreviewRef.bytes),
    width: String(agentPreviewRef.width),
    height: String(agentPreviewRef.height),
  })
  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?${query}`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), agentPreviewImage)
  const invalid = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/agent-image?attachment_id=bad`)
  assert.equal(invalid.status, 400)
})

await check('C8 Agent tools wait for results, keep images in the UI view, edit, and enforce the allow setting', async () => {
  const tools = new Map()
  const saved = new Map()
  let serial = 0
  const attachmentStore = {
    async saveImages(images) {
      return images.map((image) => {
        assert.equal(image.mediaType, 'image/png', 'attachment media type must match the encoded image bytes')
        const attachmentId = `attachment-${++serial}`
        const ref = { attachmentId, mediaType: image.mediaType, bytes: image.data.byteLength, width: 1, height: 1, name: image.name }
        saved.set(attachmentId, { ref, data: image.data })
        return ref
      })
    },
    async readImage(ref) {
      const storedImage = saved.get(ref.attachmentId)
      assert.ok(storedImage, 'the returned source_image must resolve through the attachment store')
      return storedImage
    },
  }
  let enabled = true
  const sent = []
  const agent = { send: (...args) => { sent.push(args) } }
  const runtime = new host.ImageGenerationRuntime(
    () => ({
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'sk-test',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
      defaultChannelId: 'default',
    }),
    { append: async () => [] },
  )
  const dispose = host.registerAgentImageTools({
    tools: { register: definition => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } } },
    attachments: attachmentStore,
  }, runtime, () => ({
    enabled: true,
    allowAgentImageGeneration: enabled,
    defaultChannelId: 'default',
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'configured',
      apiKey: 'configured',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
    }],
  }))
  try {
    const generated = await tools.get('generate_image').execute({ prompt: 'a mismatch cat', size: '1:1', quality: '4k', detail: 'standard' }, { agent })
    assert.equal(generated.status, 'completed', 'the Agent tool waits for the task to finish')
    assert.equal(generated.images.length, 2)
    const generatedRendered = tools.get('generate_image').output.render({ prompt: 'a cat' }, generated)
    assert.equal(generatedRendered.filter(block => block.type === 'image').length, 0, 'generated images stay out of model-facing tool content')
    const generatedArgs = { prompt: 'a cat' }
    const generatedMeta = tools.get('generate_image').output.presentationMeta(generatedArgs, generated)
    const generatedView = tools.get('generate_image').presentResult(generatedArgs, {
      content: generatedRendered,
      isError: false,
      meta: generatedMeta,
    })
    assert.equal(generatedView?.card, 'generic')
    assert.equal(generatedView?.content?.filter(block => block.type === 'image').length, 2, 'completed tool results keep image attachments in the UI view')
    assert.equal(saved.size, 2, 'completed generation stores attachments once')
    assert.equal(sent.length, 0, 'completion does not inject a conversation message')
    const complete = await tools.get('get_image_generation_task').execute({ task_id: generated.task_id }, {})
    assert.equal(complete.status, 'completed')
    assert.equal(complete.images.length, 2)
    assert.equal(saved.size, 2, 'status lookup reuses the completion attachments instead of saving duplicate files')

    const background = await tools.get('generate_image').execute({ prompt: 'a background cat', size: '1:1', quality: '4k', detail: 'standard', wait_for_completion: false }, { agent })
    assert.ok(background.status === 'queued' || background.status === 'running', 'background mode returns before completion')
    assert.equal(sent.length, 0, 'background mode also does not inject a conversation message')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (runtime.queue.list().find(task => task.id === background.task_id)?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(runtime.queue.list().find(task => task.id === background.task_id)?.status, 'completed')
    const backgroundComplete = await tools.get('get_image_generation_task').execute({ task_id: background.task_id }, {})
    assert.equal(backgroundComplete.status, 'completed')
    assert.equal(saved.size, 4)

    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat', model: 'grok-imagine-image' }, {}),
      /not configured/,
    )

    const edited = await tools.get('edit_image').execute({ prompt: 'edit this', source_image: complete.images[0], size: '3:2', quality: '2k' }, { signal: new AbortController().signal })
    assert.equal(edited.status, 'completed', 'image edits also wait for completion')
    assert.equal(edited.images.length, 1)
    assert.equal(saved.size, 5)

    const aborted = new AbortController()
    aborted.abort(new Error('test cancellation'))
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'cancel this' }, { signal: aborted.signal }),
      /test cancellation/,
    )
    assert.equal(runtime.queue.list().find(task => task.request.prompt === 'cancel this')?.status, 'cancelled')

    enabled = false
    await assert.rejects(
      tools.get('generate_image').execute({ prompt: 'a cat' }, {}),
      /disabled in Settings/,
    )
  } finally {
    dispose()
  }
})

await new Promise(resolve => server.close(resolve))

// -------------------------------------------------- D. client bundle shape
await check('D1 client bundle registers via __ModuleLoader__', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { handoff = h } },
    },
  }
  sandbox.window.window = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined, 'load() was called')
  assert.equal(handoff.id, '@dickpy/dsh-imagegen')
  assert.equal(typeof handoff.factory, 'function')
  // Evaluate the factory with stubbed platform modules; only the exports
  // surface is exercised (apply never runs without a real DOM).
  const stubs = {
    'react': {},
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-dom': {},
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-runtime/client': { createSnapshotStore: (initial) => ({
      getSnapshot: () => initial,
      set: () => {},
      update: () => {},
      subscribe: () => () => {},
    }) },
  }
  const required = []
  const exportsOf = handoff.factory((spec) => {
    required.push(spec)
    const stub = stubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })
  assert.equal([...new Set(required)].sort().join(','), Object.keys(stubs).sort().join(','))
  assert.equal(typeof exportsOf.apply, 'function')
  // Cross-realm array (VM context): compare contents, not identity.
  assert.equal([...exportsOf.inject].join(','), 'slots,locale,connection,sessions,conversation')
})

// --------------- E. full client apply in jsdom (mounts the sidebar entry)
await check('E1 client apply mounts the sidebar entry and studio (jsdom)', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head></head><body>'
    + '<div data-pane="sidebar"><div class="logoRow"><button class="newSession">New session</button></div><div class="regionArea"></div></div>'
    + '<div data-pane="conversation"><div data-slot="conversation"><div data-conversation-scroll></div></div></div>'
    + '</body></html>',
    { pretendToBeVisual: true },
  )
  const jsdomWindow = dom.window
  const jsdomDocument = jsdomWindow.document

  // Stateful bridge stub: describe + mutate (same wire shapes as the routes).
  // The redacted view never returns the key; the secrets sidecar tracks it.
  const keyState = { set: false }
  const configState = {
    enabled: true,
    announceToAgent: true,
    channels: [{
      id: 'default',
      preset: '',
      name: 'Default',
      apiUrl: 'https://example.test/v1',
      models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
    }],
    defaultChannelId: 'default',
  }
  const channelSecrets = () => [{ path: ['channelSecrets', 'default'], set: keyState.set }]
  const mutateCalls = []
  const fetchStub = async (input, init) => {
    const path = String(input)
    if (path.endsWith('/settings/describe')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            namespaces: [{
              ns: 'dsh-imagegen',
          value: configState,
          revision: 0,
          secrets: channelSecrets(),
            }],
            writable: true,
          },
        }),
      }
    }
    if (path.endsWith('/settings/mutate')) {
      const payload = JSON.parse(init.body)
      mutateCalls.push(payload)
      for (const op of payload.ops) {
        if (op.path[0] === 'channels' && op.op === 'set') configState.channels = op.value
        if (op.path[0] === 'defaultChannelId' && op.op === 'set') configState.defaultChannelId = op.value
        if (op.path[0] === 'channelSecrets' && op.path[1] === 'default') keyState.set = op.op === 'set'
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            ns: 'dsh-imagegen',
            value: configState,
            revision: 1,
            secrets: channelSecrets(),
          },
        }),
      }
    }
    if (path.endsWith('/history/list')) {
      const comparisonHistory = {
        comparisonId: 'client-comparison',
        comparisonModels: ['gpt-image-2', 'grok-imagine-image'],
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { id: 'history-grok', createdAt: 2, mode: 'text', model: 'grok-imagine-image', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/grok.png', mime: 'image/png' }], ...comparisonHistory },
            { id: 'history-gpt', createdAt: 1, mode: 'text', model: 'gpt-image-2', prompt: 'compare prompt', size: '1:1', quality: '4k', detail: '', n: 1, images: [{ url: '/history/gpt.png', mime: 'image/png' }], ...comparisonHistory },
          ],
        }),
      }
    }
    if (path.startsWith('/history/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.endsWith('/templates/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          cases: [{
            id: 1,
            title: 'Template poster',
            prompt: 'A reusable template prompt',
            category: 'Posters & Typography',
            categoryZh: '海报与排版',
            styles: [],
            scenes: [],
            sourceLabel: '@author',
            sourceUrl: '',
            githubUrl: '',
            image: '',
            featured: false,
          }],
          total: 1,
          origin: 'bundled',
          repository: 'example/templates',
          fetchedAt: '2026-08-19T00:00:00.000Z',
        }),
      }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }

  // Evaluate the bundle in a jsdom-backed sandbox.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let handoff
  const sandbox = {
    window: jsdomWindow,
    document: jsdomDocument,
    MutationObserver: jsdomWindow.MutationObserver,
    CustomEvent: jsdomWindow.CustomEvent,
    HTMLElement: jsdomWindow.HTMLElement,
    fetch: fetchStub,
    console,
  }
  // jsdom's window.window is a getter-only property; only plain-object
  // sandboxes need the self-reference.
  if (!('window' in sandbox.window)) sandbox.window.window = sandbox.window
  sandbox.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(handoff !== undefined)

  const registered = []
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    get(name) { return name === 'connection' ? { isLoopback: true } : undefined },
    locale: { register() {} },
    slots: {
      // The Web UI plugin group slot is already declared.
      inject(key, callback) { callback(); return () => {} },
      register(options) { registered.push(options); return () => {} },
    },
  }
  // react-dom (outer realm) reads the bare `window`/`document` globals at
  // render time (dev-branch event priority, event delegation); expose the
  // jsdom ones for the render.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = jsdomWindow
  globalThis.document = jsdomDocument
  const react = await import('react')
  const moduleStubs = {
    'react': react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    // Minimal functional stubs for the system primitives (the real GUI loads
    // the genuine platform module from the module table).
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: ({ variant, size, className, children, ...rest }) =>
        react.createElement('button', { type: 'button', className, ...rest }, children),
      Pill: ({ active, className, children, onClick, ...rest }) =>
        react.createElement(onClick ? 'button' : 'span', {
          type: 'button',
          className,
          ...(onClick !== undefined ? { onClick } : {}),
          ...rest,
        }, children),
    },
    // The real runtime module touches `window` at import time and cannot load
    // in a bare Node realm; this minimal store mirrors the snapshot-store
    // contract (mutable-draft update, wholesale set, subscriber fan-out) that
    // the plugin's scope lifecycle depends on.
    '@deepseek-ai/dsh-client-runtime/client': {
      createSnapshotStore: (initial) => {
        let snapshot = initial
        const listeners = new Set()
        return {
          getSnapshot: () => snapshot,
          set: (next) => {
            snapshot = next
            for (const fn of [...listeners]) fn()
          },
          update: (mutator) => {
            const draft = { ...snapshot }
            mutator(draft)
            snapshot = draft
            for (const fn of [...listeners]) fn()
          },
          subscribe: (fn) => {
            listeners.add(fn)
            return () => { listeners.delete(fn) }
          },
        }
      },
    },
  }
  const exportsOf = handoff.factory((spec) => {
    const stub = moduleStubs[spec]
    if (stub === undefined) throw new Error(`unexpected require: ${spec}`)
    return stub
  })

  exportsOf.apply(ctx)
  // Wait for the bridge fetch + scope settle + React render.
  await waitForSelectorCount(jsdomDocument, '[data-comparison]', 1)

  try {
    // Regression: the scope must settle (a scope that never loads leaves the
    // UI unmounted forever) and the two session tabs must be inserted.
    const entry = jsdomDocument.querySelector('[data-dsh-imagegen-session-tabs]')
    assert.ok(entry !== null, 'session tabs were mounted')
    assert.equal(entry.querySelectorAll('[data-dsh-imagegen-tab]').length, 2, 'new session and image tabs are present')
    assert.ok(entry.textContent.includes('生图'), 'image tab label localized')
    assert.equal(jsdomDocument.querySelector('[data-dsh-imagegen-entry]'), null, 'standalone image entry was removed')
    const view = jsdomDocument.querySelector('[data-dsh-imagegen-view]')
    assert.ok(view !== null, 'studio view container was mounted')
    assert.ok(view.isConnected, 'view container attached to the center column')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-chat-resizer]') !== null, 'chat resizer was mounted')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history]') !== null, 'history moved into the sidebar region')
    assert.equal(view.querySelector('[data-dsh-imagegen-history]'), null, 'studio no longer owns the history column')
    // The panel header rendered.
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-view] h2') !== null, 'panel header rendered')
    const connectionStatus = jsdomDocument.querySelector('[data-dsh-imagegen-view] [data-connected]')
    assert.equal(connectionStatus?.getAttribute('data-connected'), 'false', 'missing key is shown as disconnected')
    assert.equal(jsdomDocument.querySelectorAll('[data-comparison]').length, 1, 'comparison history rows collapse into one item')
    assert.ok(jsdomDocument.querySelector('[data-comparison]')?.textContent?.includes('gpt-image-2'), 'comparison history shows its models')

    // Gallery keeps the sidebar history visible, and selecting one history
    // group returns the center workspace to text-to-image.
    const modeTabs = [...view.querySelectorAll('[role="tablist"] button')]
    assert.equal(modeTabs.length, 3, 'text, edit, and gallery tabs are present')
    modeTabs[2]?.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history]') !== null, 'history remains visible in gallery mode')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 2, 'gallery mode is active')
    const galleryHistoryMain = jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history-main]')
    assert.ok(galleryHistoryMain !== null, 'gallery mode exposes clickable history')
    galleryHistoryMain.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 0, 'history click returns to text-to-image')
    // The settings card registered into the official plugin-config slot.
    assert.equal(registered.length, 1)
    assert.equal(registered[0].key, 'dsh-imagegen')
    assert.equal(registered[0].name, 'settings.plugin.item')

    // Template-library regression: choose a card, use its prompt, and verify
    // the text editor receives it while the modal closes.
    const templateTrigger = [...jsdomDocument.querySelectorAll('button')]
      .find(button => button.textContent?.includes('模板库'))
    assert.ok(templateTrigger !== undefined, 'template library trigger rendered')
    templateTrigger.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const templateCard = [...jsdomDocument.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Template poster'))
    assert.ok(templateCard !== undefined, 'template card rendered')
    templateCard.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    const useTemplate = [...jsdomDocument.querySelectorAll('button')]
      .find(button => button.textContent?.includes('使用此提示词'))
    assert.ok(useTemplate !== undefined, 'use-template action rendered')
    useTemplate.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(jsdomDocument.querySelector('textarea')?.value, 'A reusable template prompt')
    assert.equal(jsdomDocument.querySelector('[role="dialog"][aria-label="提示词模板库"]'), null, 'template modal closed after use')

    // --- save-flow regression: a secret field's save must report success ---
    // The redacted wire view never returns the key, so the form judges the
    // write by the secrets sidecar; a save that landed must not show failure
    // (this exact bug surfaced as "保存失败" while values were actually stored).
    const face = registered[0].inject()
    face.channels.setChannelKey('default', 'sk-new')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 100))
    const afterSave = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterSave.failed, false, 'save must not report failure for a secret write')
    assert.equal(afterSave.dirty, false, `staged drafts cleared after a landed save: ${JSON.stringify(afterSave)}`)
    assert.equal(keyState.set, true, 'key write reached the bridge')
    assert.ok(
      mutateCalls.some(m => m.ops.some(o => o.path[0] === 'channelSecrets' && o.path[1] === 'default' && o.op === 'set' && o.value === 'sk-new')),
      'channel key write sent with the typed value',
    )
    // The clear path: resetting the key stages an explicit clear and must
    // also report success.
    face.channels.setChannelKey('default', '')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 100))
    const afterClear = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterClear.failed, false, 'clearing a secret must not report failure')
    assert.equal(keyState.set, false, 'key clear reached the bridge')
    assert.equal(face.hooks.imageGenSettingsCard.getSnapshot().channels.keySet.default, false, 'key-set flag follows the clear')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

await new Promise(resolve => upstream.close(resolve))

// ------------------------------------------------------------------ summary
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST OK')
process.exit(process.exitCode === 1 ? 1 : 0)

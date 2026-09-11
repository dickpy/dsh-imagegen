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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const results = []
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
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
const hostLocale = await import(new URL('lib/locale-tables.js', root).href)
// The host half renders skill copy through the same dictionaries the browser
// bundle ships; wire that resolver here so the copy assertions see real text.
host.setSkillTranslate((key, params, language) => hostLocale.interpolate(key, params, hostLocale.imageGenLanguageOf(language)))
host.setSkillLanguage(() => 'zh')

await check('A1 host exports the plugin contract', () => {
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.name, 'imagegen')
  assert.deepEqual(host.inject, ['webServer', 'systemPrompt', 'commands'])
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
  assert.equal(host.CURRENT_VERSION, packageJson.version)
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
// A second listener = a different origin (port) from the API base. It stands in
// for a malicious relay pointing image URLs at an attacker-controlled host.
const foreignAuthHeaders = []
const resultAuthHeaders = []
const foreignHost = createServer((req, res) => {
  foreignAuthHeaders.push(req.headers.authorization)
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(pngBytes)
})
await new Promise(resolve => foreignHost.listen(0, '127.0.0.1', resolve))
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
    assert.ok(body.prompt === 'a cat' || body.prompt === 'a mismatch cat' || body.prompt === 'a background cat' || body.prompt === 'cancel this' || body.prompt === 'signed urls' || body.prompt === 'foreign url' || body.prompt === 'parallel one' || body.prompt === 'parallel two')
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
    assert.equal(body.detail, body.model === 'grok-imagine-image' || body.prompt === 'signed urls' || body.prompt === 'foreign url' ? undefined : 'standard')
    if (body.prompt === 'parallel one' || body.prompt === 'parallel two') {
      activeGenerationRequests += 1
      maxGenerationRequests = Math.max(maxGenerationRequests, activeGenerationRequests)
      await new Promise(resolve => setTimeout(resolve, 50))
      activeGenerationRequests -= 1
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const data = body.prompt === 'foreign url'
      ? [{ url: `http://127.0.0.1:${foreignHost.address().port}/steal.png` }]
      : body.prompt === 'signed urls'
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
    const commandEdit = body.includes('edit via command') || body.includes('edit attached image')
    assert.ok(body.includes('name="prompt"') && (body.includes('edit this') || commandEdit), 'prompt part missing')
    assert.ok(body.includes('name="model"') && body.includes('gpt-image-2'), 'model part missing')
    if (!commandEdit) assert.ok(body.includes('name="size"') && body.includes('1536x1024'), 'size part missing')
    assert.ok(!body.includes('name="n"'), 'n must not be sent (batch param rejected)')
    assert.ok(body.includes('name="image"'), 'image part missing')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
    return
  }
  if (url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(req.headers.authorization, 'Bearer sk-test')
    const asked = body.messages.at(-1).content
    // Vision request (layer decomposition): the canvas route sends a content
    // array; answer with a fenced JSON plan that also exercises normalization
    // (background first, a text layer, and one degenerate box to drop).
    const visionReply = '```json\n'
      + JSON.stringify({
        layers: [
          { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#FFEE00' },
          { kind: 'background', label: '背景' },
          { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.25, width: 0.3, height: 0.6 } },
          { kind: 'object', label: '退化框', rect: { x: 0.2, y: 0.2, width: 0, height: 0.3 } },
        ],
      })
      + '\n```'
    const reply = Array.isArray(asked)
      ? visionReply
      : asked === 'think leak'
        ? '<think>\u9996\u5148\u5206\u6790\u7528\u6237\u9700\u6c42\u2026\uff08\u5927\u6bb5\u63a8\u7406\uff09</think>\nA lighthouse at dusk over a stormy sea.'
        : asked === 'dangling think'
          ? '<think>reasoning that never closes'
          : 'A calm meadow under morning light.'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
    return
  }
  if (url.pathname === '/image/result.png') {
    // Same-origin downloads (B1: API base is this server) keep the key; other
    // suites (Qwen / async providers on their own ports) point here from a
    // foreign origin and must arrive without it.
    resultAuthHeaders.push(req.headers.authorization)
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
  assert.equal(resultAuthHeaders.at(-1), 'Bearer sk-test', 'same-origin result URLs keep the channel API key')
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

await check('B2b result URLs on a foreign origin never receive the channel API key', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'text', model: 'gpt-image-2', prompt: 'foreign url', size: '1:1', quality: '4k', n: 1, detail: '' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
  assert.equal(foreignAuthHeaders.length, 1)
  assert.equal(foreignAuthHeaders[0], undefined, 'a foreign-origin image URL must not carry the Bearer key')
})

await check('B3 edit mode sends multipart and normalizes', async () => {
  const result = await host.generateImage(
    { apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' },
    { mode: 'edit', model: 'gpt-image-2', prompt: 'edit this', size: '3:2', quality: '2k', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].b64, pngBytes.toString('base64'))
})

await check('B3b edit mode forwards every reference image', async () => {
  const seen = { fields: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('latin1')
    seen.fields = [...body.matchAll(/name="([^"]+)"/g)].map(match => match[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' },
      { mode: 'edit', model: 'gpt-image-2', prompt: 'combine both references', size: '1:1', quality: 'auto', n: 1, detail: '', image: dataUrl, images: [dataUrl, dataUrl] },
    )
    assert.deepEqual(seen.fields.filter(name => name.startsWith('image')), ['image[]', 'image[]', 'image[]'])
  } finally {
    server.close()
  }
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

await check('B9 Qwen-Image speaks the DashScope native contract', async () => {
  const seen = []
  const qwen = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
      seen.push({
        auth: req.headers.authorization,
        path: url.pathname,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${upstreamPort}/image/result.png` }] } }] },
        usage: { image_count: 1 },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => qwen.listen(0, '127.0.0.1', resolve))
  const port = qwen.address().port
  const base = `http://127.0.0.1:${port}/api/v1`
  try {
    // Versioned series: wide ratio maps to the HD size set and n batches natively.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-3.0', prompt: 'a cat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.deepEqual(seen[0], {
      auth: 'Bearer qwen-key',
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      body: {
        model: 'qwen-image-3.0',
        input: { messages: [{ role: 'user', content: [{ text: 'a cat' }] }] },
        parameters: { size: '2688*1536', n: 2 },
      },
    })
    // Classic series: single image per call, fixed size list, no n parameter.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'text', model: 'qwen-image-plus', prompt: 'x', size: '9:16', quality: '2k', n: 4, detail: '' },
    )
    assert.deepEqual(seen[0].body.parameters, { size: '928*1664' })
    // Edit mode rides the reference image as a message content item.
    seen.length = 0
    await host.generateImage(
      { apiUrl: base, apiKey: 'qwen-key' },
      { mode: 'edit', model: 'qwen-image-3.0', prompt: 'edit this', size: '1:1', quality: 'auto', n: 1, detail: '', image: `data:image/png;base64,${pngBytes.toString('base64')}` },
    )
    assert.deepEqual(seen[0].body.input.messages[0].content, [
      { image: `data:image/png;base64,${pngBytes.toString('base64')}` },
      { text: 'edit this' },
    ])
    assert.deepEqual(seen[0].body.parameters, { size: '2048*2048' })
  } finally {
    await new Promise(resolve => qwen.close(resolve))
  }
})


await check('B9b MiniMax image-01 speaks the native /image_generation contract', async () => {
  const seen = []
  let reply = () => ({ id: 'req-1', data: { image_base64: [pngBytes.toString('base64')] }, metadata: { failed_count: '0', success_count: '1' }, base_resp: { status_code: 0, status_msg: 'success' } })
  const minimax = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/image_generation') {
      seen.push({ auth: req.headers.authorization, path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      // MiniMax answers HTTP 200 for failures too; base_resp carries the verdict.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply()))
      return
    }
    res.writeHead(404)
    res.end('404 page not found')
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    // Text mode: aspect_ratio passthrough, native n batching, base64 results.
    const result = await host.generateImage(
      { apiUrl: base, apiKey: 'mm-key' },
      { mode: 'text', model: 'image-01', prompt: 'a boat', size: '16:9', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(result.images.length, 1)
    assert.equal(result.images[0].b64, pngBytes.toString('base64'))
    assert.equal(result.images[0].mime, 'image/png')
    assert.deepEqual(seen[0], {
      auth: 'Bearer mm-key',
      path: '/v1/image_generation',
      body: { model: 'image-01', prompt: 'a boat', response_format: 'base64', aspect_ratio: '16:9', n: 2 },
    })
    // auto size omits aspect_ratio; n=1 omits n; n is capped at 9.
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: 'auto', quality: '4k', n: 1, detail: '' })
    assert.deepEqual(seen[0].body, { model: 'image-01', prompt: 'x', response_format: 'base64' })
    seen.length = 0
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 50, detail: '' })
    assert.ok(seen[0].body.n <= 9, `n must be capped at 9, got ${seen[0].body.n}`)
    // Edit mode: one character subject_reference with the data URL.
    seen.length = 0
    const ref = `data:image/png;base64,${pngBytes.toString('base64')}`
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'edit', model: 'image-01', prompt: 'same person, beach', size: '3:4', quality: 'auto', n: 1, detail: '', image: ref })
    assert.deepEqual(seen[0].body.subject_reference, [{ type: 'character', image_file: ref }])
    assert.equal(seen[0].body.aspect_ratio, '3:4')
    // Prompts at MiniMax's 1500-char limit fail fast, before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1600), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 0)
    // Unsupported panel ratio is rejected locally before any upstream call.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '5:7', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'size-unsupported',
    )
    assert.equal(seen.length, 0)
    // HTTP 200 + non-zero base_resp.status_code surfaces as an upstream rejection.
    reply = () => ({ id: 'req-2', data: null, base_resp: { status_code: 2013, status_msg: 'invalid params, unsupported model: image-99' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-rejected' && /2013/.test(error.message) && /image-99/.test(error.message),
    )
    reply = () => ({ id: 'req-3', data: null, base_resp: { status_code: 2049, status_msg: 'invalid api key' } })
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'upstream-unauthorized',
    )
    // The catalog classifies the family so the UI shows the right badge, and a
    // wrong-family model on the same base must NOT hit /image_generation.
    seen.length = 0
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'gpt-image-2', prompt: 'x', size: '1:1', quality: 'auto', n: 1, detail: '' }),
    )
    assert.equal(seen.length, 0, 'non-MiniMax models keep the OpenAI route')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B9c prompt character limits share one source between engine and panel counter', async () => {
  // Only MiniMax documents a limit today; everything else — including
  // unrecognized ids — must report null so the panel hides the counter.
  assert.equal(host.promptCharLimit('image-01'), 1500)
  assert.equal(host.promptCharLimit('minimax-image-01'), 1500)
  assert.equal(host.promptCharLimit('gpt-image-2'), null)
  assert.equal(host.promptCharLimit('doubao-seedream-4.0'), null)
  assert.equal(host.promptCharLimit('totally-unknown'), null)
  // The engine enforces exactly that shared number: 1499 chars pass through
  // to the fake upstream, 1500 fail fast before any network call.
  const seen = []
  const minimax = createServer(async (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'r', data: { image_base64: [pngBytes.toString('base64')] }, base_resp: { status_code: 0, status_msg: 'ok' } }))
  })
  await new Promise(resolve => minimax.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${minimax.address().port}/v1`
  try {
    await host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1499), size: '1:1', quality: 'auto', n: 1, detail: '' })
    assert.equal(seen.length, 1, '1499 chars must reach the upstream')
    await assert.rejects(
      host.generateImage({ apiUrl: base, apiKey: 'mm-key' }, { mode: 'text', model: 'image-01', prompt: 'x'.repeat(1500), size: '1:1', quality: 'auto', n: 1, detail: '' }),
      error => error.code === 'prompt-too-long' && /1500/.test(error.message),
    )
    assert.equal(seen.length, 1, '1500 chars must fail fast without an upstream call')
  } finally {
    await new Promise(resolve => minimax.close(resolve))
  }
})

await check('B10 async two-step providers submit, poll, and flatten URL arrays', async () => {
  const submissions = []
  const polls = new Map()
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (url.pathname === '/v1/images/generations') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const taskId = `task-${submissions.length + 1}`
      submissions.push({ taskId, body, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: taskId }] }))
      return
    }
    if (url.pathname.startsWith('/v1/tasks/')) {
      const taskId = url.pathname.slice('/v1/tasks/'.length)
      const count = (polls.get(taskId) ?? 0) + 1
      polls.set(taskId, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (count === 1) {
        res.end(JSON.stringify({ data: { status: 'processing', task_id: taskId } }))
      } else {
        res.end(JSON.stringify({ data: { status: 'completed', task_id: taskId, result: { images: [{ url: [`http://127.0.0.1:${upstreamPort}/image/result.png`, `data:image/png;base64,${pngBytes.toString('base64')}`] }] } } }))
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    const result = await host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'async image', size: '1:1', quality: 'auto', n: 2, detail: '' },
    )
    assert.equal(submissions.length, 2, 'one upstream task is submitted for each requested image')
    assert.equal(result.images.length, 4, 'each completed task URL array is flattened')
    assert.ok(submissions.every(item => item.authorization === 'Bearer async-key'))
    assert.ok([...polls.values()].every(count => count >= 2), 'submitted tasks are polled until completed')
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B11 async provider failures surface the remote error', async () => {
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'submitted', task_id: 'failed-task' } }))
      return
    }
    if (url.pathname === '/v1/tasks/failed-task') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'failed', error: { message: 'content rejected' } } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  try {
    await assert.rejects(
      host.generateImage(
        { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
        { mode: 'text', model: 'gpt-image-2', prompt: 'bad', size: '1:1', quality: 'auto', n: 1, detail: '' },
      ),
      /content rejected/,
    )
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
  }
})

await check('B12 async provider cancellation aborts polling', async () => {
  let pollCount = 0
  const asyncProvider = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ status: 'submitted', task_id: 'cancel-task' }] }))
      return
    }
    if (url.pathname === '/v1/tasks/cancel-task') {
      pollCount += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'processing', task_id: 'cancel-task' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => asyncProvider.listen(0, '127.0.0.1', resolve))
  const port = asyncProvider.address().port
  const controller = new AbortController()
  try {
    const pending = host.generateImage(
      { apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'async-key' },
      { mode: 'text', model: 'gpt-image-2', prompt: 'cancel', size: '1:1', quality: 'auto', n: 1, detail: '' },
      { signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 80))
    controller.abort()
    await assert.rejects(pending)
    assert.ok(pollCount >= 1)
  } finally {
    await new Promise(resolve => asyncProvider.close(resolve))
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
let persistedFavorites = []
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
const templateSamples = []
const templates = {
  async list(sourceId) {
    return {
      sourceId,
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
  async refresh(sourceId) {
    templateRefreshes += 1
    return { sourceId, total: 1, fetchedAt: '2026-08-19T00:00:01.000Z' }
  },
  async sample(count) {
    templateSamples.push(count)
    return [{ sourceId: 'vibeui', case: { id: 1, title: 'Poster template', prompt: 'Create a bright product poster', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false } }]
  },
  async readImage(sourceId, file) {
    return sourceId === 'vibeui' && file === 'case1.png' ? { data: templateImage, mime: 'image/png' } : undefined
  },
}
const favorites = {
  async list() { return [...persistedFavorites] },
  async add(sourceId, item) {
    const key = `${sourceId}:${item.id}`
    const entry = { key, sourceId, savedAt: '2026-08-19T00:00:02.000Z', case: item }
    persistedFavorites = [entry, ...persistedFavorites.filter(favorite => favorite.key !== key)]
    return [...persistedFavorites]
  },
  async remove(key) {
    persistedFavorites = persistedFavorites.filter(favorite => favorite.key !== key)
    return [...persistedFavorites]
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
  async saveImage(input) {
    return {
      attachmentId: `sha256:${'b'.repeat(64)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}
const pendingConversationImages = new Map()
let storageProbeEndpoint = ''
let heavySkillAllowed = true
const skillRunRoot = join(tmpdir(), `dsh-imagegen-smoke-${process.pid}`)
mkdirSync(skillRunRoot, { recursive: true })
/** ---------------------------------------------------------------- canvas ---
 * In-memory canvas + file store standing in for CanvasStore, plus a scripted
 * chat model and skill registry so the skill runner can run end to end. */
const canvasDocuments = new Map()
const canvasFiles = new Map()
const canvasBlobs = new Map()
let canvasFileSeq = 0
let chatCalls = 0
let chatReply = 'polished text by model'
const skillRegistrySkills = []
const recordCanvasFile = (data, mime, name) => {
  canvasFileSeq += 1
  const assetId = `file${canvasFileSeq.toString().padStart(4, '0')}`
  const extension = name.includes('.') ? name.split('.').pop() : 'bin'
  const fileName = `${assetId}.${extension}`
  canvasFiles.set(assetId, { name, mime })
  canvasBlobs.set(fileName, { data: Buffer.from(data), mime })
  return {
    assetId,
    url: `/api/dsh-imagegen/canvas/asset/${fileName}`,
    mime,
    bytes: data.length,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name,
  }
}
const canvasBackend = {
  async read(id) { return canvasDocuments.get(id) },
  async readAsset(file) { return canvasBlobs.get(file) },
  async readAssets(refs) {
    const found = new Map()
    for (const ref of refs) {
      const extension = (ref.name ?? '').includes('.') ? ref.name.split('.').pop() : 'bin'
      const blob = canvasBlobs.get(`${ref.assetId}.${extension}`)
      if (blob !== undefined) found.set(ref.assetId, blob)
    }
    return found
  },
  async materialize(ref, targetPath) {
    const found = await canvasBackend.readAssets([ref])
    const blob = found.get(ref.assetId)
    if (blob === undefined) throw new Error(`missing asset ${ref.assetId}`)
    writeFileSync(targetPath, blob.data)
  },
  async putFile(input) { return recordCanvasFile(input.data, input.mime, input.name) },
}
let heavyRunsStarted = 0
/** Isolated skill library root for the install/remove cases. */
const skillLibraryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-skills-'))
/** Isolated local skill root the canvas registry adapter falls back to. */
const skillRegistryRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-registry-'))
const canvasSkillRunner = new host.SkillRunner({
  backend: {
    canvas: canvasBackend,
    chat: {
      async complete() {
        chatCalls += 1
        return chatReply
      },
    },
  },
  enabled: () => true,
  heavyEnabled: () => heavySkillAllowed,
  allowlist: () => [],
  runRoot: () => skillRunRoot,
  heavyTimeoutMs: () => 30_000,
  dataRoot: () => skillRunRoot,
})
// The canvas reads the local library beside the host registry: on the Web
// surface a preset owns local discovery, so an unscoped `ctx.skills.list()` sees
// no installed skill at all. The fake above stands in for that empty answer.
canvasSkillRunner.attach({
  registry: host.createSkillRegistryBackend({
    async list() { return skillRegistrySkills },
    async get(name) {
      const found = skillRegistrySkills.find(skill => skill.name === name)
      return found === undefined ? undefined : { name, content: `# ${name}\nDo the thing.` }
    },
  }, { root: () => skillRegistryRoot }),
  agents: {
    available: () => true,
    async create(options) {
      heavyRunsStarted += 1
      return {
        session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'heavy done' }] }] },
        followup() {},
        async whenIdle() {
          // Publish the artifact the way a real skill would: into the run's
          // output directory the runner handed the agent.
          const outputDir = join(options.cwd, 'output')
          mkdirSync(outputDir, { recursive: true })
          writeFileSync(join(outputDir, 'deck.pptx'), Buffer.from('pptx-bytes'))
        },
        cancel() {},
        async dispose() {},
      }
    },
  },
})
/** The skill-library backend the route family sees (kept by name so the config
 *  routes can be exercised with a scripted backend). */
const skillLibraryFake = {
  async list() {
    return await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  },
  async install(request) {
    const installed = []
    const failed = []
    let message
    for (const source of request.sources ?? []) {
      try { installed.push(host.classifySource(source).kind) }
      catch (error) { failed.push({ source, message: String(error.message) }) }
    }
    if (request.asset !== undefined) {
      // The upload route stores into the real canvas store, so read it back
      // the same way the plugin does.
      const found = await host.canvasStore.readAssets([request.asset])
      const blob = found.get(request.asset.assetId)
      if (blob === undefined) message = 'missing upload'
      else {
        try {
          installed.push(await host.installFromArchive(blob.data, skillLibraryRoot, request.name ?? 'skill', request.force === true))
        } catch (error) { message = String(error.message) }
      }
    }
    return {
      ok: installed.length > 0,
      installed,
      failed,
      library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }),
      ...message === undefined ? {} : { message },
    }
  },
  async remove(name) {
    try {
      await host.removeSkill(name, skillLibraryRoot)
      return { ok: true, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }) }
    } catch (error) {
      return { ok: false, library: await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false }), message: String(error.message) }
    }
  },
}
const routes = host.makeRoutes({
  settings: seam,
  resolve: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test' }),
  resolvePrompt: () => ({ apiUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', model: 'chat-test' }),
  history,
  templates,
  favorites,
  resolveStorage: () => ({ endpoint: storageProbeEndpoint, region: 'ap-guangzhou', accessKey: 'AKID-test', secretKey: 'secret-test', prefix: 'dsh-imagegen' }),
  attachments,
  pendingConversationImages,
  skills: canvasSkillRunner,
  skillLibrary: skillLibraryFake,
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
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new Error(`HTTP ${response.status} returned non-JSON body: ${text || '<empty>'}`)
  }
}

await check('C0b prompt enhance strips reasoning-model <think> blocks', async () => {
  // Closed think block: only the visible answer may reach the prompt box.
  const leak = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'think leak' })
  assert.equal(leak.status, 200)
  assert.equal(leak.body.ok, true)
  assert.equal(leak.body.prompt, 'A lighthouse at dusk over a stormy sea.')
  // Dangling unclosed <think>: everything after it is reasoning, so the
  // enhancer must fail loudly instead of returning the raw reasoning text.
  const dangling = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'dangling think' })
  assert.equal(dangling.body.ok, false)
  assert.match(dangling.body.message, /only reasoning content/)
  // Clean content passes through untouched.
  const clean = await post('/api/dsh-imagegen/prompt-enhance', { prompt: 'clean please' })
  assert.equal(clean.body.prompt, 'A calm meadow under morning light.')
})

await check('C0c canvas layer decomposition parses a fenced vision plan and clamps it', async () => {
  // Unit: the normalizer accepts the documented shape, drops degenerate boxes,
  // clamps rectangles into the frame, orders background first and de-dupes it.
  assert.equal(host.normalizeLayerPlan({ layers: [] }), undefined)
  assert.equal(host.normalizeLayerPlan({ nope: 1 }), undefined)
  assert.equal(host.normalizeLayerPlan({ layers: [{ kind: 'object' }] }), undefined, 'an object layer without a rect is dropped')
  const clamped = host.normalizeLayerPlan({
    layers: [
      { kind: 'text', label: '  title  ', rect: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, text: ' hi ' },
      { kind: 'text', label: 'no text', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ],
  })
  assert.deepEqual(clamped.layers, [{ kind: 'text', label: 'title', rect: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, text: 'hi' }])
  const ordered = host.normalizeLayerPlan([
    { kind: 'object', label: 'b', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { kind: 'background', label: 'bg' },
    { kind: 'background', label: 'bg2' },
  ])
  assert.deepEqual(ordered.layers.map(layer => layer.kind), ['background', 'object'])
  assert.equal(ordered.layers[0].rect, undefined, 'the background layer carries no rect')

  // Route: the browser sends one data URL, the host answers with the plan.
  const plan = await post('/api/dsh-imagegen/canvas/layers', { image: `data:image/png;base64,${pngBytes.toString('base64')}` })
  assert.equal(plan.body.ok, true, JSON.stringify(plan.body))
  assert.deepEqual(plan.body.plan.layers.map(layer => layer.kind), ['background', 'object', 'text'])
  assert.equal(plan.body.plan.layers[2].text, '夏日限定')
  assert.equal(plan.body.plan.layers[2].color, '#ffee00', 'hex colors are normalized to lower case')
  assert.deepEqual(plan.body.plan.layers[1].rect, { x: 0.3, y: 0.25, width: 0.3, height: 0.6 })

  const missing = await post('/api/dsh-imagegen/canvas/layers', {})
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'bad-request')
  // A channel without a vision chat model fails with an actionable message.
  await assert.rejects(
    host.analyzeLayers({ apiUrl: '', apiKey: '', model: '' }, `data:image/png;base64,${pngBytes.toString('base64')}`),
    /提示词增强/,
  )
})

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
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'openai-official').models, [{ alias: 'gpt-image-2.5', id: 'gpt-image-2.5' }, { alias: 'gpt-image-2', id: 'gpt-image-2' }])
  assert.deepEqual(presets.body.presets.find(preset => preset.id === 'zhipu-official').models, [{ alias: 'glm-image', id: 'glm-image' }])
  const rejected = await post('/api/dsh-imagegen/tasks/submit', {
    mode: 'text', model: 'not-configured', prompt: 'a cat', size: 'auto', quality: 'auto', n: 1, detail: '',
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.code, 'image-model-not-configured')
})

await check('C6 template routes are source-scoped, refresh per source, and proxy only known images', async () => {
  const { body: list } = await post('/api/dsh-imagegen/templates/list', { source: 'vibeui' })
  assert.equal(list.ok, true)
  assert.equal(list.sourceId, 'vibeui')
  assert.equal(list.total, 1)
  assert.equal(list.cases[0].prompt, 'Create a bright product poster')

  const { body: refreshed } = await post('/api/dsh-imagegen/templates/refresh', { source: 'vibeui' })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.sourceId, 'vibeui')
  assert.equal(refreshed.total, 1)
  assert.equal(templateRefreshes, 1)

  // Unknown sources are rejected before the backend is touched.
  const badSource = await post('/api/dsh-imagegen/templates/list', { source: 'nope' })
  assert.equal(badSource.body.ok, false)
  assert.equal(badSource.body.code, 'templates-source-unknown')
  assert.equal(templateRefreshes, 1)

  const image = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/case1.png`)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), templateImage)
  const unknown = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/vibeui/not-allowed.png`)
  assert.equal(unknown.status, 404)
  // Legacy single-segment image paths are gone: the source id is required.
  const legacy = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/case1.png`)
  assert.equal(legacy.status, 404)
  const badPool = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/templates/image/canghe/case1.png`)
  assert.equal(badPool.status, 404)
})

await check('C6b template favorites persist host-side and round-trip', async () => {
  const empty = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(empty.body.ok, true)
  assert.deepEqual(empty.body.favorites, [])

  const item = {
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
  }
  const added = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'vibeui', case: item })
  assert.equal(added.body.ok, true)
  assert.equal(added.body.favorites.length, 1)
  assert.equal(added.body.favorites[0].key, 'vibeui:1')
  assert.equal(added.body.favorites[0].case.prompt, item.prompt)

  const invalid = await post('/api/dsh-imagegen/templates/favorites/add', { source: 'nope', case: item })
  assert.equal(invalid.body.ok, false)

  const relisted = await post('/api/dsh-imagegen/templates/favorites/list', {})
  assert.equal(relisted.body.favorites.length, 1)

  const removed = await post('/api/dsh-imagegen/templates/favorites/remove', { key: 'vibeui:1' })
  assert.equal(removed.body.ok, true)
  assert.deepEqual(removed.body.favorites, [])
})

await check('C6c template sample route draws random inspiration picks', async () => {
  const { body } = await post('/api/dsh-imagegen/templates/sample', { count: 9 })
  assert.equal(body.ok, true)
  assert.equal(body.samples.length, 1)
  assert.equal(body.samples[0].sourceId, 'vibeui')
  assert.equal(body.samples[0].case.prompt, 'Create a bright product poster')
  assert.deepEqual(templateSamples, [9])
})


await check('C6d data-folder route resolves the host directory (no spawn in tests)', async () => {
  const { body } = await post('/api/dsh-imagegen/data-folder/open', { open: false })
  assert.equal(body.ok, true)
  assert.ok(String(body.path).includes('.dsh'), 'resolved path points at the DSH data dir')
})

await check('C6e storage test route signs and uploads a probe object', async () => {
  const uploads = []
  const probe = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'PUT' && url.pathname === '/dsh-imagegen/ping.txt') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      uploads.push({
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
        amzDate: req.headers['x-amz-date'],
        payloadHash: req.headers['x-amz-content-sha256'],
      })
      res.writeHead(200)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  storageProbeEndpoint = `http://127.0.0.1:${probe.address().port}`
  try {
    const { body } = await post('/api/dsh-imagegen/storage/test', {})
    assert.equal(body.ok, true, `probe upload must succeed: ${JSON.stringify(body)}`)
    assert.equal(typeof body.ms, 'number')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].body, 'dsh-imagegen storage ok')
    assert.ok(String(uploads[0].authorization).startsWith('AWS4-HMAC-SHA256 Credential=AKID-test/'), 'SigV4 credential scope is present')
    assert.ok(uploads[0].amzDate !== undefined && uploads[0].payloadHash !== undefined)
  } finally {
    storageProbeEndpoint = ''
    await new Promise(resolve => probe.close(resolve))
  }
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

await check('C8 composer images can be staged for the direct edit_image command', async () => {
  const staged = await post('/api/dsh-imagegen/conversation-image', {
    sessionId: 'session-staged',
    dataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`,
    name: 'staged.png',
  })
  assert.equal(staged.body.ok, true)
  assert.equal(pendingConversationImages.has('session-staged'), true)
  assert.equal(pendingConversationImages.get('session-staged').mediaType, 'image/png')
})

await check('C9 Agent tools wait for results, keep images in the UI view, edit, and enforce the allow setting', async () => {
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
      lastReadImageAttachmentId = ref.attachmentId
      const storedImage = saved.get(ref.attachmentId)
      assert.ok(storedImage, 'the returned source_image must resolve through the attachment store')
      return storedImage
    },
  }
  let enabled = true
  let lastReadImageAttachmentId
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
    const editedRendered = tools.get('edit_image').output.render({ prompt: 'edit this' }, edited)
    assert.equal(editedRendered.filter(block => block.type === 'image').length, 0, 'edit_image output stays out of model-visible image context')
    assert.equal(saved.size, 5)

    const commands = new Map()
    const pending = new Map()
    const commandDispose = host.registerEditImageCommand({
      commands: { register: definition => { commands.set(definition.name, definition); return () => { commands.delete(definition.name) } } },
      attachments: attachmentStore,
    }, runtime, () => ({
      enabled: true,
      allowAgentImageGeneration: true,
      defaultChannelId: 'default',
      channels: [{
        id: 'default',
        preset: '',
        name: 'Default',
        apiUrl: 'configured',
        apiKey: 'configured',
        models: [{ alias: 'gpt-image-2', id: 'gpt-image-2' }],
      }],
    }), {
      get: sessionId => pending.get(sessionId),
      consume: (sessionId, ref) => { if (pending.get(sessionId)?.attachmentId === ref.attachmentId) pending.delete(sessionId) },
    })
    try {
      assert.ok(commands.has('edit_image'), 'the /edit_image command is registered')
      const command = commands.get('edit_image')
      assert.deepEqual(command.input, { hint: 'Describe how to modify the latest image', images: true }, 'the command accepts composer images')
      const noImageAgent = { session: { deriveMessages: () => [] } }
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: '   ', signal: new AbortController().signal }), {
        kind: 'error',
        text: '请提供图片修改描述，例如：/edit_image 把背景改成夜景',
      })
      assert.deepEqual(await command.handler({ agent: noImageAgent, rawInput: 'edit this', signal: new AbortController().signal }), {
        kind: 'error',
        text: '当前对话没有可用图片，请先上传图片或把画廊图片加入对话。',
      })
      const commandSource = complete.images[0]
      const commandReference = {
        attachmentId: commandSource.attachment_id,
        mediaType: commandSource.media_type,
        bytes: commandSource.bytes,
        width: commandSource.width,
        height: commandSource.height,
        name: commandSource.name,
      }
      const commandAgent = { session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } }
      const commandResult = await command.handler({ agent: commandAgent, rawInput: 'edit via command', signal: new AbortController().signal })
      assert.equal(commandResult.kind, 'success')
      assert.match(commandResult.text, /图片编辑已完成/)
      assert.equal(sent.length, 0, 'slash command does not send a chat-model message')
      const invocationReference = { ...commandReference, attachmentId: `sha256:${'d'.repeat(64)}` }
      saved.set(invocationReference.attachmentId, { ref: invocationReference, data: pngBytes })
      const invocationResult = await command.handler({
        agent: noImageAgent,
        attachments: [{ type: 'image', attachment: invocationReference }],
        rawInput: 'edit attached image',
        signal: new AbortController().signal,
      })
      assert.equal(invocationResult.kind, 'success', 'an image carried by the command reaches the plugin edit path')
      assert.equal(lastReadImageAttachmentId, invocationReference.attachmentId, 'the invocation image is used as the edit source')
      const pendingRef = { ...commandReference, attachmentId: `sha256:${'c'.repeat(64)}` }
      saved.set(pendingRef.attachmentId, { ref: pendingRef, data: pngBytes })
      pending.set('pending-session', pendingRef)
      const pendingResult = await command.handler({
        agent: { id: 'pending-session', session: { deriveMessages: () => [{ content: [{ type: 'image', attachment: commandReference }] }] } },
        rawInput: 'edit via command',
        signal: new AbortController().signal,
      })
      assert.equal(pendingResult.kind, 'success', 'staged composer image is accepted without a chat message')
      assert.equal(lastReadImageAttachmentId, pendingRef.attachmentId, 'the staged image takes precedence over older session history')
      assert.equal(pending.has('pending-session'), false, 'staged image is consumed after a successful edit')
    } finally {
      commandDispose()
    }

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

await check('C10 canvas file upload accepts arbitrary bytes and serves them as an attachment', async () => {
  const bytes = Buffer.from('name,role\nalice,admin\n', 'utf8')
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=people.csv`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: bytes,
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  assert.equal(body.asset.kind, 'file')
  assert.equal(body.asset.name, 'people.csv')
  assert.equal(body.asset.bytes, bytes.length)
  assert.equal(body.asset.mime, 'text/csv')
  assert.match(body.asset.url, /^\/api\/dsh-imagegen\/canvas\/asset\/[a-f0-9]{64}\.csv$/)

  // Non-image assets download rather than render inline.
  const served = await fetch(`http://127.0.0.1:${port}${body.asset.url}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'application/octet-stream')
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.match(served.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(await served.text(), bytes.toString('utf8'))
})

await check('C10b canvas file upload refuses executable extensions with an actionable message', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=payload.exe`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('MZ'),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(String(body.message), /不支持|not supported|\.exe/i)

  // Uploads carry no byte limit inside the raw-body reader other than the cap:
  // a name that sanitizes to nothing still lands under a safe fallback.
  const odd = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent('../..\\evil.txt')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('ok'),
  })
  const oddBody = await odd.json()
  assert.equal(oddBody.ok, true, JSON.stringify(oddBody))
  assert.equal(oddBody.asset.name.includes('/'), false)
  assert.equal(oddBody.asset.name.includes('\\'), false)
})

await check('C10c a file node round-trips through canvas save with its asset intact', async () => {
  const asset = recordCanvasFile(Buffer.from('报告正文\n', 'utf8'), 'text/plain', 'report.txt')
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'files' })
  const document = created.body.document
  const fileNode = {
    id: 'node-file-1',
    type: 'file',
    title: 'report.txt',
    x: 40,
    y: 60,
    width: 300,
    height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  const saved = await post('/api/dsh-imagegen/canvas/save', {
    document: { ...document, nodes: [...document.nodes, fileNode] },
    expectedRevision: document.revision,
  })
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
  const storedNode = saved.body.document.nodes.find(node => node.id === 'node-file-1')
  assert.equal(storedNode.type, 'file')
  assert.equal(storedNode.metadata.asset.assetId, asset.assetId)
  assert.equal(storedNode.metadata.fileKind, 'text')
})

/** Upload one file through the real route, exactly like the browser does. */
const uploadCanvasFile = async (name, mime, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': mime },
    body,
  })
  const parsed = await response.json()
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  return parsed.asset
}

/** Ask the host for one asset's structured preview (node metadata as hints). */
const canvasFilePreview = async asset => {
  const response = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: asset.assetId, name: asset.name, mime: asset.mime })
  assert.equal(response.body.ok, true, JSON.stringify(response.body))
  return response.body.preview
}

await check('C10d a canvas file preview decodes text, tables and office documents', async () => {
  const textPreview = await canvasFilePreview(await uploadCanvasFile('notes.txt', 'text/plain', Buffer.from('line one\nline two\n', 'utf8')))
  assert.equal(textPreview.kind, 'text')
  assert.match(textPreview.text, /line two/)
  assert.ok(textPreview.lines >= 2, 'line count reported')

  const tablePreview = await canvasFilePreview(await uploadCanvasFile('people.csv', 'text/csv', Buffer.from('name,role\nalice,admin\nbob,viewer\n', 'utf8')))
  assert.equal(tablePreview.kind, 'table')
  assert.deepEqual(tablePreview.rows[0], ['name', 'role'])
  assert.deepEqual(tablePreview.rows[2], ['bob', 'viewer'])
  assert.equal(tablePreview.totalRows, 3)
  assert.equal(tablePreview.truncated, false)

  // RFC4180 quoting: separators and newlines inside quotes stay in one cell.
  const quotedPreview = await canvasFilePreview(await uploadCanvasFile('quoted.csv', 'text/csv', Buffer.from('a,b\n"x,1","y\n2"\n', 'utf8')))
  assert.deepEqual(quotedPreview.rows[1], ['x,1', 'y\n2'])

  // DOCX: the OOXML body is inflated and its paragraphs keep their order.
  const docx = buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/document.xml', body: '<w:document><w:body><w:p><w:r><w:t>季度报告</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>' },
  ])
  const docxPreview = await canvasFilePreview(await uploadCanvasFile('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx))
  assert.equal(docxPreview.kind, 'document')
  assert.equal(docxPreview.format, 'docx')
  assert.equal(docxPreview.blocks.length, 2, 'both paragraphs survive as blocks')
  assert.equal(docxPreview.blocks[0].type, 'paragraph')
  assert.match(docxPreview.blocks[0].runs.map(run => run.text).join(''), /季度报告/)
  assert.match(docxPreview.blocks[1].runs.map(run => run.text).join(''), /Second paragraph/)

  // XLSX: shared strings resolve into a grid instead of a wall of XML.
  const xlsx = buildZip([
    { name: 'xl/sharedStrings.xml', body: '<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Ada</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', body: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>97</v></c></row></sheetData></worksheet>' },
  ])
  const sheetPreview = await canvasFilePreview(await uploadCanvasFile('scores.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx))
  assert.equal(sheetPreview.kind, 'table')
  assert.deepEqual(sheetPreview.rows[0], ['Name', 'Score'])
  assert.deepEqual(sheetPreview.rows[1], ['Ada', '97'])

  // Markdown decodes whole so the client can render it as rich text.
  const mdPreview = await canvasFilePreview(await uploadCanvasFile('readme.md', 'text/markdown', Buffer.from('# 计划\n\n**加粗** and `code`\n', 'utf8')))
  assert.equal(mdPreview.kind, 'markdown')
  assert.match(mdPreview.markdown, /# 计划/)
  assert.equal(mdPreview.truncated, false)

  const missing = await post('/api/dsh-imagegen/canvas/file/preview', { assetId: 'nope.csv' })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.code, 'not-found')
})

await check('C10d2 rich previews reconstruct html / svg / docx layouts and pptx slides', () => {
  // The upload gate keeps HTML/SVG out of the store, so these go straight to
  // the preview builder — the same function the route calls with store bytes.
  const preview = (name, mime, data) => host.buildFilePreview({ data, mime, name, url: 'asset-url' })

  // HTML is handed over untouched: the client renders it in a sandboxed iframe.
  const html = preview('page.html', 'text/html', Buffer.from('<!doctype html><html><body><h1>你好</h1><script>alert(1)</script></body></html>', 'utf8'))
  assert.equal(html.kind, 'html')
  assert.match(html.html, /<h1>你好<\/h1>/)
  assert.match(html.html, /<script>/)

  // SVG likewise; the browser renders it through an `<img>` (no script runs).
  const svg = preview('logo.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', 'utf8'))
  assert.equal(svg.kind, 'svg')
  assert.match(svg.svg, /<rect/)

  // DOCX layout: heading level, bold/italic runs, numbered list, table grid.
  const richDocx = preview('plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'word/numbering.xml', body: '<w:numbering><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>' },
    { name: 'word/document.xml', body: '<w:document><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目计划</w:t></w:r></w:p>'
      + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>'
      + '<w:p/>' // Word-style empty spacer paragraph between blocks
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:body></w:document>' },
  ]))
  assert.equal(richDocx.kind, 'document')
  const [heading, paragraph, list, table] = richDocx.blocks
  assert.deepEqual(heading, { type: 'heading', level: 1, runs: [{ text: '项目计划' }] })
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(paragraph.runs, [{ text: '加粗', bold: true }, { text: '斜体', italic: true }])
  assert.deepEqual(list, { type: 'list', ordered: true, items: [[{ text: '第一项' }], [{ text: '第二项' }]] })
  assert.deepEqual(table, { type: 'table', rows: [['A1', 'B1']] })

  // PPTX: one card per slide, title placeholder split from body lines, and
  // embedded raster pictures ride along as data URLs.
  const deck = preview('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>'
      + '<a:p><a:r><a:t>营收增长</a:t></a:r></a:p><a:p><a:r><a:t>成本下降</a:t></a:r></a:p>'
      + '</p:txBody></p:sp>'
      + '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
      + '</p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>' },
    { name: 'ppt/media/image1.png', body: pngBytes },
    { name: 'ppt/slides/slide2.xml', body: '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>结尾页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ]))
  assert.equal(deck.kind, 'slides')
  assert.equal(deck.format, 'pptx')
  assert.equal(deck.slides.length, 2)
  assert.equal(deck.slides[0].title, '季度回顾')
  assert.deepEqual(deck.slides[0].lines, ['营收增长', '成本下降'])
  assert.equal(deck.slides[0].images.length, 1)
  assert.equal(deck.slides[0].images[0].mime, 'image/png')
  assert.equal(deck.slides[0].images[0].data, `data:image/png;base64,${pngBytes.toString('base64')}`)
  assert.deepEqual(deck.slides[1], { lines: ['结尾页'], images: [] })

  // Vector metafiles (EMF) cannot render in an <img>, so they are dropped.
  const emfDeck = preview('legacy.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buildZip([
    { name: '[Content_Types].xml', body: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', body: '<p:sld><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', body: '<Relationships><Relationship Id="rId2" Target="../media/image1.emf"/></Relationships>' },
    { name: 'ppt/media/image1.emf', body: '\u0001\u0002emf' },
  ]))
  assert.equal(emfDeck.kind, 'slides')
  assert.equal(emfDeck.slides[0].images.length, 0)
})

await check('C10e a canvas file preview lists archives and reports opaque binaries', async () => {
  const archive = buildZip([
    { name: 'docs/', body: '' },
    { name: 'docs/a.txt', body: 'hello' },
    { name: 'b.bin', body: 'xxxxx' },
  ])
  const archivePreview = await canvasFilePreview(await uploadCanvasFile('bundle.zip', 'application/zip', archive))
  assert.equal(archivePreview.kind, 'archive')
  assert.equal(archivePreview.totalEntries, 3)
  assert.deepEqual(archivePreview.entries.map(entry => entry.name), ['docs/', 'docs/a.txt', 'b.bin'])
  assert.equal(archivePreview.entries[0].dir, true)
  assert.equal(archivePreview.entries[1].size, 5)
  assert.equal(archivePreview.truncated, false)

  // A PDF and media ask the browser to render the asset itself.
  const pdfPreview = await canvasFilePreview(await uploadCanvasFile('paper.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8')))
  assert.equal(pdfPreview.kind, 'media')
  assert.equal(pdfPreview.media, 'pdf')
  assert.match(pdfPreview.url, /\?inline=1$/)

  const audioPreview = await canvasFilePreview(await uploadCanvasFile('track.mp3', 'audio/mpeg', Buffer.from('ID3fakeaudio')))
  assert.equal(audioPreview.kind, 'media')
  assert.equal(audioPreview.media, 'audio')

  // An opaque binary says so, with a machine-readable reason for the browser.
  const blob = await canvasFilePreview(await uploadCanvasFile('blob.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3])))
  assert.equal(blob.kind, 'none')
  assert.equal(blob.reason, 'unsupported')
  assert.equal(typeof blob.format, 'string')
})

await check('C10f previewable assets serve inline with byte ranges, markup never does', async () => {
  const base = `http://127.0.0.1:${port}`
  const bytes = Buffer.from('%PDF-1.4\nsecond page\n%%EOF\n', 'utf8')
  const pdf = await uploadCanvasFile('inline.pdf', 'application/pdf', bytes)

  // Plain requests keep the attachment contract the upload path promises.
  const download = await fetch(`${base}${pdf.url}`)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment/)

  // ?inline=1 unlocks the browser's own renderer for the documented types.
  const inline = await fetch(`${base}${pdf.url}?inline=1`)
  assert.equal(inline.headers.get('content-type'), 'application/pdf')
  assert.match(inline.headers.get('content-disposition') ?? '', /^inline/)
  assert.equal(inline.headers.get('accept-ranges'), 'bytes')
  assert.equal(await inline.text(), bytes.toString('utf8'))

  // Media seeking needs real range answers.
  const ranged = await fetch(`${base}${pdf.url}?inline=1`, { headers: { range: 'bytes=0-7' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${bytes.length}`)
  assert.equal(await ranged.text(), '%PDF-1.4')

  // Text-shaped assets travel as JSON previews, never as an inline response.
  const csv = await uploadCanvasFile('inline.csv', 'text/csv', Buffer.from('a,b\n', 'utf8'))
  const csvInline = await fetch(`${base}${csv.url}?inline=1`)
  assert.equal(csvInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(csvInline.headers.get('content-disposition') ?? '', /^attachment/)

  // An HTML-shaped payload may sit in the store (a declared type can slip past
  // the name check) but can never render in the app's origin.
  const markup = await uploadCanvasFile('evil.txt', 'text/html', Buffer.from('<html><script>alert(1)</script></html>', 'utf8'))
  const markupInline = await fetch(`${base}${markup.url}?inline=1`)
  assert.equal(markupInline.headers.get('content-type'), 'application/octet-stream')
  assert.match(markupInline.headers.get('content-disposition') ?? '', /^attachment/)
  assert.equal(markupInline.headers.get('x-content-type-options'), 'nosniff')
})

await check('C11 the skill catalog merges built-ins with local skills and tiers external ones', async () => {
  skillRegistrySkills.length = 0
  skillRegistrySkills.push(
    { name: 'image-to-editable-ppt', description: 'Rebuild slides as an editable deck', path: 'C:/skills/ppt/SKILL.md' },
    { name: 'summarize-notes', description: 'Turn notes into a short brief', metadata: { tier: 'light' } },
  )
  const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(listed.body.ok, true, JSON.stringify(listed.body))
  const ids = listed.body.skills.map(skill => skill.id)
  assert.ok(ids.includes('polish.text'), `missing polish.text in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('ppt.fromImages'), `missing ppt.fromImages in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing ppt skill in ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('skill:summarize-notes'), `missing summarize-notes in ${JSON.stringify(ids)}`)
  const ppt = listed.body.skills.find(skill => skill.id === 'skill:image-to-editable-ppt')
  assert.equal(ppt.tier, 'heavy', JSON.stringify(ppt))
  assert.equal(ppt.origin, 'external', JSON.stringify(ppt))
  const notes = listed.body.skills.find(skill => skill.id === 'skill:summarize-notes')
  assert.equal(notes.tier, 'light', JSON.stringify(notes))
  assert.equal(listed.body.agentAvailable, true, JSON.stringify(listed.body))
  assert.equal(listed.body.registryAvailable, true, JSON.stringify(listed.body))
})

await check('C11a the host registry adapter hides user-only skills and narrows summaries', async () => {
  const adapter = host.createSkillRegistryBackend({
    async list() {
      return [
        { name: 'visible', description: 'a model-invocable skill', invocation: { modelInvocable: true, userInvocable: true }, metadata: { tier: 'heavy' }, path: 'C:/s/visible/SKILL.md' },
        { name: 'user-only', description: 'slash command only', invocation: { modelInvocable: false, userInvocable: true } },
        { name: 'undeclared', description: 'provider omitted the policy', extra: 'dropped' },
      ]
    },
    async get(name) {
      return name === 'visible' ? { name, content: '# visible', metadata: { canvasTier: 'light' } } : undefined
    },
  })
  const listed = await adapter.list()
  assert.deepEqual(listed.map(skill => skill.name), ['visible', 'undeclared'])
  assert.equal(listed[0].path, 'C:/s/visible/SKILL.md')
  assert.deepEqual(listed[0].metadata, { tier: 'heavy' })
  assert.equal('extra' in listed[1], false)
  const body = await adapter.get('visible')
  assert.equal(body.content, '# visible')
  assert.deepEqual(body.metadata, { canvasTier: 'light' })
  assert.equal(await adapter.get('user-only'), undefined)
})

await check('C11b a lightweight skill run answers through the chat model and drafts a text node', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'polish' })
  const document = created.body.document
  const textNode = {
    id: 'node-text-1', type: 'text', title: 'draft', x: 0, y: 0, width: 280, height: 150,
    metadata: { text: 'hello world', fontSize: 14 },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [textNode] })
  const before = chatCalls
  chatReply = 'Hello, world.'
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'polish.text',
    nodeIds: ['node-text-1'],
    params: { style: 'formal' },
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  // The run-card rebuild path: tasks carry their input ids and a machine phase.
  assert.deepEqual(run.body.task.nodeIds, ['node-text-1'])
  assert.equal(['queued', 'running'].includes(run.body.task.phase), true, JSON.stringify(run.body.task))
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  // The finished snapshot keeps nodeIds so a reload can still rebuild context.
  assert.deepEqual(snapshot.nodeIds, ['node-text-1'])
  // A canvas-scoped listing only reports unfinished runs.
  const drained = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: document.id })
  assert.equal(drained.body.ok, true)
  assert.deepEqual(drained.body.tasks, [], 'finished runs are not listed as live')
  const unknown = await post('/api/dsh-imagegen/canvas/skills/task', { canvasId: 'canvas-none' })
  assert.deepEqual(unknown.body.tasks, [])
  assert.equal(chatCalls, before + 1)
  const produced = snapshot.output.nodes[0]
  assert.equal(produced.type, 'text')
  assert.equal(produced.metadata.text, 'Hello, world.')
  assert.deepEqual(produced.metadata.skill.sourceNodeIds, ['node-text-1'])
  assert.equal(snapshot.output.connections[0].fromNodeId, 'node-text-1')
  assert.equal(snapshot.output.connections[0].toNodeId, produced.id)
})

await check('C11c extract.content reads an uploaded text file without spending a chat call', async () => {
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'extract' })
  const document = created.body.document
  const asset = recordCanvasFile(Buffer.from('第一行\n第二行\n', 'utf8'), 'text/plain', 'notes.txt')
  const fileNode = {
    id: 'node-file-2', type: 'file', title: 'notes.txt', x: 0, y: 0, width: 300, height: 170,
    metadata: { asset, fileKind: 'text' },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [fileNode] })
  const before = chatCalls
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'extract.content',
    nodeIds: ['node-file-2'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 80 && snapshot.status !== 'completed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(chatCalls, before)
  assert.equal(snapshot.output.nodes[0].type, 'text')
  assert.match(snapshot.output.nodes[0].metadata.text, /第一行/)
})

await check('C11d heavy skills refuse to start without the agent runtime, then produce a file node', async () => {  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'deck' })
  const document = created.body.document
  const imageNode = {
    id: 'node-image-1', type: 'image', title: 'slide-1', x: 0, y: 0, width: 240, height: 240,
    metadata: {
      asset: { assetId: 'img-1', url: '/api/dsh-imagegen/canvas/asset/' + 'a'.repeat(64) + '.png', mime: 'image/png', bytes: pngBytes.length, width: 1, height: 1, origin: 'upload', kind: 'image', name: 'img-1.png' },
      status: 'success',
    },
  }
  canvasDocuments.set(document.id, { ...document, nodes: [imageNode] })

  // The built-in deck conversion disappears from the catalog when the agent
  // runtime is not available, so the run fails instead of silently no-oping.
  heavySkillAllowed = false
  const disabled = await post('/api/dsh-imagegen/canvas/skills/list', {})
  assert.equal(disabled.body.agentAvailable, false)
  heavySkillAllowed = true

  const before = heavyRunsStarted
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at.
  // The run materializes its input images on disk, so the stub store needs the
  // bytes the node's asset points at (`<assetId>.<extension>`).
  canvasBlobs.set('img-1.png', { data: pngBytes, mime: 'image/png' })
  const run = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: document.id,
    skillId: 'ppt.fromImages',
    nodeIds: ['node-image-1'],
  })
  assert.equal(run.body.ok, true, JSON.stringify(run.body))
  const taskId = run.body.task.id
  let snapshot = run.body.task
  for (let attempt = 0; attempt < 200 && snapshot.status !== 'completed' && snapshot.status !== 'failed'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    snapshot = (await post('/api/dsh-imagegen/canvas/skills/task', { taskId })).body.task
  }
  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot))
  assert.equal(heavyRunsStarted, before + 1)
  const produced = snapshot.output.nodes.find(node => node.type === 'file')
  assert.ok(produced !== undefined, 'the deck artifact became a file node')
  assert.match(String(produced.metadata.asset.name), /\.pptx$/)
})

await check('C11e an unknown skill id and a missing canvas fail with copy, not a crash', async () => {
  const unknown = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: 'nope', skillId: 'skill:does-not-exist', nodeIds: [],
  })
  assert.equal(unknown.body.ok, false)
  const created = await post('/api/dsh-imagegen/canvas/create', { title: 'gone' })
  const missing = await post('/api/dsh-imagegen/canvas/skills/run', {
    canvasId: `missing-${created.body.document.id}`, skillId: 'polish.text', nodeIds: ['x'],
  })
  assert.equal(missing.body.ok, false)
  assert.ok(typeof missing.body.message === 'string' && missing.body.message.length > 0)
})

await check('C11f skill routes answer in the caller language and reject unknown hints', async () => {
  const zh = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'zh' })
  const en = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'en' })
  const bogus = await post('/api/dsh-imagegen/canvas/skills/list', { language: 'not-a-locale' })
  const nameOf = (body, id) => body.skills.find(skill => skill.id === id).name
  assert.equal(nameOf(zh.body, 'polish.text'), '文本润色')
  assert.equal(nameOf(en.body, 'polish.text'), 'Polish text')
  // An unknown/absent hint falls back to the host resolver, never a raw key.
  assert.equal(nameOf(bogus.body, 'polish.text'), '文本润色')
  assert.ok(zh.body.reason === undefined || !String(zh.body.reason).includes('canvas.skills.'))
})

await check('C11g a scope-blind host registry still offers the local skill library', async () => {
  // The user's exact situation: the skill is installed under the local root,
  // while the registry the host-plane plugin can query answers nothing (on the
  // Web surface a preset owns local discovery, so the global layer is empty).
  const previous = [...skillRegistrySkills]
  skillRegistrySkills.length = 0
  const bundle = (name, body) => {
    mkdirSync(join(skillRegistryRoot, name), { recursive: true })
    writeFileSync(join(skillRegistryRoot, name, 'SKILL.md'), body)
  }
  const names = ['image-to-editable-ppt', 'local-worker', 'Bad_Name', 'user-only-thing']
  try {
    bundle('image-to-editable-ppt', '---\nname: image-to-editable-ppt\ndescription: Rebuild slides\n---\n\n# Deck\n')
    bundle('local-worker', '---\nname: local-worker\ndescription: Local notes worker\n---\n\n# Local\n\nlocal body marker\n')
    // Entries the host registry would drop: never offered to a node.
    bundle('Bad_Name', '---\nname: Bad_Name\ndescription: Wrong name shape\n---\n\n# Bad\n')
    bundle('user-only-thing', '---\nname: user-only-thing\ndescription: Slash command only\ndisable-model-invocation: true\n---\n\n# Human\n')

    const listed = await post('/api/dsh-imagegen/canvas/skills/list', {})
    const ids = listed.body.skills.map(skill => skill.id)
    assert.ok(ids.includes('skill:image-to-editable-ppt'), `missing the installed deck skill in ${JSON.stringify(ids)}`)
    assert.ok(ids.includes('skill:local-worker'), `missing the local skill in ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:Bad_Name'), false, `a non-kebab name must not be offered: ${JSON.stringify(ids)}`)
    assert.equal(ids.includes('skill:user-only-thing'), false, `a user-only skill must not be offered: ${JSON.stringify(ids)}`)
    // The built-in deck action keys its install hint off this list: the skill IS
    // installed, so the picker must stop telling the user to install it.
    assert.deepEqual([...listed.body.installed].sort(), ['image-to-editable-ppt', 'local-worker'])

    // The body loads from disk too, so a run is not silently instruction-less.
    const adapter = host.createSkillRegistryBackend({ async list() { return [] }, async get() { return undefined } }, { root: () => skillRegistryRoot })
    const definition = await adapter.get('local-worker')
    assert.equal(definition.name, 'local-worker')
    assert.match(definition.content, /local body marker/)
    assert.equal(await adapter.get('Bad_Name'), undefined)
    // A registry entry still wins a name collision (deployment outranks a user install).
    const merged = host.createSkillRegistryBackend({
      async list() { return [{ name: 'local-worker', description: 'registry wins', path: 'C:/repo/local-worker/SKILL.md' }] },
      async get() { return { name: 'local-worker', content: 'registry body' } },
    }, { root: () => skillRegistryRoot })
    assert.equal((await merged.list()).find(skill => skill.name === 'local-worker').description, 'registry wins')
    assert.equal((await merged.get('local-worker')).content, 'registry body')
  } finally {
    for (const name of names) rmSync(join(skillRegistryRoot, name), { recursive: true, force: true })
    skillRegistrySkills.push(...previous)
    // Leave the catalog a later check sees as the registry-only one again.
    const restored = await post('/api/dsh-imagegen/canvas/skills/list', {})
    assert.equal(restored.body.skills.some(skill => skill.id === 'skill:local-worker'), false)
  }
})

await check('C11h a heavy run composes its agent with the preset roster and a model route', async () => {
  // Creating an agent is not enough: on the Web surface every model-facing row
  // lives behind a preset, and the model route is not implied by the request.
  const seen = { sections: [] }
  const created = await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        seen.options = options
        // The real factory runs setup before it publishes the agent.
        await options.setup({
          systemPrompt: { section: input => seen.sections.push(input) },
        })
        return {
          agent: {
            session: { deriveMessages: () => [] },
            followup() { seen.delivered = true },
            async whenIdle() {},
            cancel(cause) { seen.cancelled = cause },
          },
          async dispose() {},
        }
      },
    },
    presets: {
      async resolve(id) { seen.resolvedWith = id; return { id: 'standard' } },
      async mount(_ctx, id) { seen.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'packyapi', model: 'deepseek-flash' }) },
    agentPreset: '',
    sessionId: 'skillagent-smoke',
    cwd: 'C:/runs/smoke',
    systemPrompt: 'SKILL BODY',
    fail: key => `copy:${key}`,
  })
  assert.equal(seen.resolvedWith, undefined, 'an empty setting must ask for the deployment default')
  assert.deepEqual(seen.options.agentOptions, { provider: 'packyapi', model: 'deepseek-flash' })
  assert.equal(seen.options.meta.agentPreset, 'standard')
  assert.equal(seen.options.meta.origin, 'subagent')
  assert.equal(seen.options.meta.cwd, 'C:/runs/smoke')
  assert.equal(seen.mounted, 'standard', 'the agent must join the preset, or it runs tool-less')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].text, 'SKILL BODY')
  assert.equal(seen.sections[0].name, 'plugin:dsh-imagegen:canvas-skill')
  // Driving the handle narrows the DSH agent to what a run needs.
  created.followup('go')
  assert.equal(seen.delivered, true)
  created.cancel()
  assert.deepEqual(seen.cancelled, { kind: 'user' })
  await created.dispose()

  // A configured preset name wins over the deployment default.
  const named = {}
  await host.createCanvasSkillAgent({
    agents: {
      async create(options) {
        await options.setup({ systemPrompt: { section() {} } })
        return { agent: { session: { deriveMessages: () => [] }, followup() {}, async whenIdle() {}, cancel() {} }, async dispose() {} }
      },
    },
    presets: {
      async resolve(id) { named.resolvedWith = id; return { id: id ?? 'standard' } },
      async mount(_ctx, id) { named.mounted = id; return { id } },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPreset: 'deck-runner',
    sessionId: 'x',
    cwd: 'c',
    systemPrompt: 's',
    fail: key => key,
  })
  assert.equal(named.resolvedWith, 'deck-runner')
  assert.equal(named.mounted, 'deck-runner')

  // Without a default model the run fails with copy instead of starting a
  // model-less agent that dies on its first step.
  await assert.rejects(
    () => host.createCanvasSkillAgent({
      agents: { async create() { throw new Error('must not be reached') } },
      defaultModel: { currentSelection: () => ({}) },
      agentPreset: '',
      sessionId: 'x',
      cwd: 'c',
      systemPrompt: 's',
      fail: key => `copy:${key}`,
    }),
    /copy:canvas\.skills\.needModel/,
  )
})

// ------------------------------------------- C12. local skill library

/** Minimal stored-method ZIP writer (the reader validates structure, not CRC). */
function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body, 'utf8')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0, 14) // crc (unused by the reader)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, body)
    const head = Buffer.alloc(46 + name.length)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(0, 10) // stored
    head.writeUInt32LE(0, 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(body.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(offset, 42)
    name.copy(head, 46)
    central.push(head)
    offset += local.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

await check('C12 install sources are classified without touching the network', () => {
  assert.deepEqual({ ...host.classifySource('https://github.com/ningzimu/image-to-editable-ppt-skill') }, {
    kind: 'github', owner: 'ningzimu', repo: 'image-to-editable-ppt-skill', ref: '', subpath: '',
  })
  // A blob/tree URL keeps its ref and subfolder so the bundle (not the file) installs.
  assert.deepEqual({ ...host.classifySource('https://github.com/o/r/tree/main/skills/deck') }, {
    kind: 'github', owner: 'o', repo: 'r', ref: 'main', subpath: 'skills/deck',
  })
  const raw = host.classifySource('https://raw.githubusercontent.com/o/r/main/SKILL.md')
  assert.equal(raw.kind, 'raw')
  assert.equal(raw.name, 'SKILL')
  assert.equal(host.classifySource('https://example.com/bundle.zip').kind, 'archive')
  assert.equal(host.classifySource('https://git.example.com/team/skill.git').kind, 'git')
  // Names are folder names: anything path-like is refused.
  assert.equal(host.isValidSkillName('image-to-editable-ppt'), true)
  assert.equal(host.isValidSkillName('../escape'), false)
  assert.equal(host.isValidSkillName(''), false)
})

await check('C12a the library lists, installs from an archive, replaces and removes', async () => {
  // A flat `<name>.md` skill and a bundle folder both count as installed.
  writeFileSync(join(skillLibraryRoot, 'flat-skill.md'), '---\nname: flat-skill\ndescription: A flat one\n---\n\n# Flat\n')
  mkdirSync(join(skillLibraryRoot, 'bundle-skill'), { recursive: true })
  writeFileSync(join(skillLibraryRoot, 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: A bundled one\n---\n\n# Bundle\n')

  const listed = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.equal(listed.networkAvailable, false)
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['bundle-skill', 'flat-skill'])
  assert.equal(listed.entries.find(entry => entry.name === 'bundle-skill').description, 'A bundled one')
  assert.ok(listed.catalog.some(source => source.name === 'image-to-editable-ppt'))

  // GitHub-shaped archive: one wrapper folder, bundle a level deeper.
  const archive = buildZip([
    { name: 'repo-main/', body: '' },
    { name: 'repo-main/SKILL.md', body: '---\nname: deck-maker\ndescription: Makes decks\n---\n\n# Deck\n' },
    { name: 'repo-main/scripts/run.py', body: 'print(1)\n' },
  ])
  assert.equal(host.readZipDirectory(archive).length, 3)
  const installed = await host.installFromArchive(archive, skillLibraryRoot, 'repo', false)
  assert.equal(installed, 'deck-maker')
  assert.equal(readFileSync(join(skillLibraryRoot, 'deck-maker', 'scripts', 'run.py'), 'utf8'), 'print(1)\n')
  // Without force a second install refuses instead of clobbering.
  await assert.rejects(
    () => host.installFromArchive(archive, skillLibraryRoot, 'repo', false),
    /已经安装/,
  )
  assert.equal(await host.installFromArchive(archive, skillLibraryRoot, 'repo', true), 'deck-maker')

  // An archive with no SKILL.md anywhere is rejected, not half-installed.
  const empty = buildZip([{ name: 'repo-main/README.md', body: 'nothing here\n' }])
  await assert.rejects(() => host.installFromArchive(empty, skillLibraryRoot, 'nope', true), /SKILL\.md/)

  assert.equal(await host.removeSkill('flat-skill', skillLibraryRoot), 'flat-skill')
  await assert.rejects(() => host.removeSkill('flat-skill', skillLibraryRoot), /没有找到/)
  await assert.rejects(() => host.removeSkill('../escape', skillLibraryRoot), /不合法/)
  const after = await host.listLibrary({ root: skillLibraryRoot, networkAvailable: false })
  assert.deepEqual(after.entries.map(entry => entry.name).sort(), ['bundle-skill', 'deck-maker'])
})

await check('C12b the library routes list, install from an upload, and remove', async () => {
  const initial = await post('/api/dsh-imagegen/canvas/skills/library', { language: 'zh' })
  assert.equal(initial.status, 200)
  assert.equal(initial.body.ok, true)
  assert.equal(initial.body.library.root, skillLibraryRoot)

  // The browser uploads the archive first (same route as a file node), then
  // installs it by asset reference.
  const archive = buildZip([{ name: 'bundle/SKILL.md', body: '---\nname: routed-skill\ndescription: From a route\n---\n\n# Routed\n' }])
  const uploaded = await fetch(`http://127.0.0.1:${port}/api/dsh-imagegen/canvas/file/upload?name=routed.zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: archive,
  })
  const upload = await uploaded.json()
  assert.equal(upload.ok, true, JSON.stringify(upload))

  const install = await post('/api/dsh-imagegen/canvas/skills/install', {
    asset: upload.asset, name: 'routed', force: true, language: 'zh',
  })
  assert.equal(install.body.ok, true, JSON.stringify(install.body))
  assert.deepEqual(install.body.installed, ['routed-skill'])
  assert.ok(install.body.library.entries.some(entry => entry.name === 'routed-skill'))

  // An empty install request is a bad request, not a crash.
  const empty = await post('/api/dsh-imagegen/canvas/skills/install', {})
  assert.equal(empty.body.ok, false)
  assert.equal(empty.body.code, 'bad-request')

  const removed = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'routed-skill' })
  assert.equal(removed.body.ok, true, JSON.stringify(removed.body))
  assert.ok(!removed.body.library.entries.some(entry => entry.name === 'routed-skill'))
  const missing = await post('/api/dsh-imagegen/canvas/skills/remove', { name: 'never-installed' })
  assert.equal(missing.body.ok, false)
})

await check('C12c an install the host registry would ignore is refused with copy', async () => {
  // A non-kebab frontmatter name is dropped by the host provider: installing it
  // would look successful and stay unusable in every node.
  const badName = buildZip([{ name: 'b/SKILL.md', body: '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n' }])
  await assert.rejects(() => host.installFromArchive(badName, skillLibraryRoot, 'b', true), /kebab-case/)
  // Same for a bundle with no description at all.
  const noBlurb = buildZip([{ name: 'b/SKILL.md', body: '---\nname: no-blurb\n---\n\n# No blurb\n' }])
  await assert.rejects(() => host.installFromArchive(noBlurb, skillLibraryRoot, 'b', true), /description/)
  // A user-only skill is a legitimate install: the canvas just cannot run it.
  const userOnly = buildZip([{ name: 'b/SKILL.md', body: '---\nname: human-only\ndescription: Slash command\ndisable-model-invocation: true\n---\n\n# Human\n' }])
  assert.equal(await host.installFromArchive(userOnly, skillLibraryRoot, 'b', true), 'human-only')
  assert.equal(await host.removeSkill('human-only', skillLibraryRoot), 'human-only')

  // The panel explains the same verdicts it would otherwise leave silent.
  const issueRoot = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-issue-'))
  try {
    mkdirSync(join(issueRoot, 'bad-name'), { recursive: true })
    writeFileSync(join(issueRoot, 'bad-name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Wrong shape\n---\n\n# Bad\n')
    writeFileSync(join(issueRoot, 'loose.md'), '# No frontmatter at all\n')
    const listed = await host.listLibrary({
      root: issueRoot,
      networkAvailable: false,
      issueText: (issue, name) => `${issue}:${name}`,
    })
    const byName = new Map(listed.entries.map(entry => [entry.name, entry]))
    assert.equal(byName.get('Bad_Name').issue, 'bad-name:Bad_Name')
    assert.equal(byName.get('loose').issue, 'no-frontmatter:loose')
    // The disk scan still offers the loadable ones, and only those.
    assert.deepEqual((await host.listLocalSkills(issueRoot)).map(skill => skill.name), [])
  } finally {
    rmSync(issueRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------- C13. per-skill configuration surface

await check('C13a a skill.config.json is validated, bounded and versioned', () => {
  const parsed = host.parseSkillConfigManifest({
    version: 1,
    note: 'secrets stay local',
    fields: [
      { id: 'api-key', label: 'Key', type: 'secret', required: true, expose: true },
      { id: 'base-url', type: 'string', default: 'https://x/v1', expose: true },
      { id: 'Bad_Id', type: 'string' },
      { id: 'mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b' }] },
    ],
    apply: [
      { kind: 'command', argv: ['tool', '--key', '{api-key}'], cwd: 'skill' },
      { kind: 'file', path: '~/.x/config.json', content: '{"url":"{base-url}"}' },
      { kind: 'nonsense' },
    ],
  })
  assert.equal(parsed.issue, undefined)
  // A bad field id and an unknown step kind are dropped, not fatal.
  assert.deepEqual(parsed.manifest.fields.map(field => field.id), ['api-key', 'base-url', 'mode'])
  // A secret can never be expository, whatever the declaration says.
  assert.equal(parsed.manifest.fields[0].expose, undefined)
  assert.equal(parsed.manifest.fields[1].expose, true)
  assert.equal(parsed.manifest.steps.length, 2)
  assert.equal(parsed.manifest.steps[0].cwd, 'skill')
  assert.equal(parsed.manifest.note, 'secrets stay local')

  assert.equal(host.parseSkillConfigManifest({ version: 2, fields: [{ id: 'a' }] }).issue, 'unsupported-version')
  assert.equal(host.parseSkillConfigManifest({ version: 1 }).issue, 'empty')
  assert.equal(host.parseSkillConfigManifest('nope').issue, 'unreadable')
  // Caps: only the first 32 fields survive.
  const many = host.parseSkillConfigManifest({
    version: 1,
    fields: Array.from({ length: 40 }, (_value, index) => ({ id: `f${index}` })),
  })
  assert.equal(many.manifest.fields.length, 32)

  // File targets: `~` expands, escapes and DSH control files are refused.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  assert.equal(host.resolveConfigTarget('~/.editppt/config.yaml').path, join(homedir(), '.editppt', 'config.yaml'))
  assert.equal(host.resolveConfigTarget('relative/path').issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(`${home}/../outside/config.yaml`).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'settings.yaml')).issue, 'refused-path')
  assert.equal(host.resolveConfigTarget(join(home, 'profiles', 'web', 'package.json')).issue, 'refused-path')
})

await check('C13b apply steps substitute values, honor guards and mask secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-config-'))
  try {
    const parsed = host.parseSkillConfigManifest({
      version: 1,
      fields: [
        { id: 'api-key', label: 'Key', type: 'secret', required: true },
        { id: 'base-url', label: 'URL', type: 'string' },
        { id: 'ocr-token', label: 'OCR', type: 'secret' },
        { id: 'endpoint', label: 'Endpoint', type: 'string', required: true },
      ],
      apply: [
        { kind: 'command', argv: [process.execPath, '-e', 'console.log("echo " + process.argv[1])', '{api-key}'] },
        { kind: 'file', path: join(root, 'out', 'config.json'), content: '{"base":"{base-url}"}' },
        { kind: 'command', argv: [process.execPath, '-e', 'process.exit(9)'], when: { field: 'ocr-token', set: true } },
      ],
    })
    const declaration = { manifest: parsed.manifest, source: 'skill' }
    const values = host.valuesFor(declaration, { values: { 'deck/base-url': 'https://x/v1' }, secrets: { 'deck/api-key': 'sk-super-secret' } }, 'deck')
    assert.equal(values.get('api-key'), 'sk-super-secret')
    assert.deepEqual(host.missingFields(declaration, values), ['Endpoint'])

    const steps = await host.applySkillConfigSteps(declaration, values, { runRoot: root })
    assert.equal(steps.length, 3)
    // The secret is never echoed back to the panel.
    assert.equal(steps[0].ok, true)
    assert.equal(steps[0].detail.includes('sk-super-secret'), false)
    assert.equal(steps[0].output.includes('sk-super-secret'), false)
    assert.match(steps[0].output, /•••/)
    assert.equal(steps[1].ok, true)
    assert.equal(readFileSync(join(root, 'out', 'config.json'), 'utf8'), '{"base":"https://x/v1"}')
    // The guarded step is skipped: its field has no value.
    assert.equal(steps[2].detail, 'skipped')

    // A missing required value stops that step with copy, not a crash.
    const empty = host.valuesFor(declaration, { values: {}, secrets: {} }, 'deck')
    const failed = await host.applySkillConfigSteps(declaration, empty, { runRoot: root })
    assert.equal(failed[0].ok, false)
    assert.match(failed[0].output, /api-key/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13c the built-in recipe covers image-to-editable-ppt and a sidecar wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-imagegen-smoke-recipe-'))
  try {
    const recipe = await host.readCanvasSkillConfig({ name: 'image-to-editable-ppt', root, store: { values: {}, secrets: {} } })
    assert.equal(recipe.declaration.source, 'plugin')
    assert.deepEqual(recipe.declaration.manifest.fields.map(field => field.id), ['image-api-key', 'image-base-url', 'image-model', 'paddle-ocr-token'])
    assert.deepEqual(recipe.view.missing, ['图像 API 密钥'])
    assert.equal(recipe.view.applicable, true)
    // The declared command is exactly what the skill documents.
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('editppt'))
    assert.ok(recipe.declaration.manifest.steps[0].argv.includes('{image-api-key}'))
    assert.deepEqual(recipe.declaration.manifest.steps[1].when, { field: 'paddle-ocr-token', set: true })

    // A skill's own sidecar takes over, and a broken one reports why.
    mkdirSync(join(root, 'image-to-editable-ppt'), { recursive: true })
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), JSON.stringify({
      version: 1,
      fields: [{ id: 'own-field', label: 'Own', type: 'string' }],
      apply: [{ kind: 'file', path: join(root, 'own.txt'), content: '{own-field}' }],
    }))
    const own = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: { 'image-to-editable-ppt/own-field': 'x' }, secrets: {} },
    })
    assert.equal(own.declaration.source, 'skill')
    assert.deepEqual(own.declaration.manifest.fields.map(field => field.id), ['own-field'])
    writeFileSync(join(root, 'image-to-editable-ppt', 'skill.config.json'), '{ not json')
    const broken = await host.readCanvasSkillConfig({
      name: 'image-to-editable-ppt',
      entryPath: join(root, 'image-to-editable-ppt', 'SKILL.md'),
      root,
      store: { values: {}, secrets: {} },
      issueText: issue => `copy:${issue}`,
    })
    assert.equal(broken.declaration, undefined)
    assert.equal(broken.view.issue, 'copy:unreadable')

    // A skill with no declaration and no recipe gets no configuration surface.
    const none = await host.readCanvasSkillConfig({ name: 'whatever-skill', root, store: { values: {}, secrets: {} } })
    assert.equal(none.view, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('C13d the config routes save and apply through the library backend', async () => {
  const seen = {}
  const previous = { save: skillLibraryFake.configSave, apply: skillLibraryFake.configApply }
  skillLibraryFake.configSave = async request => {
    seen.saved = request
    return { ok: true, library: await skillLibraryFake.list() }
  }
  skillLibraryFake.configApply = async request => {
    seen.applied = request
    return { ok: true, library: await skillLibraryFake.list(), steps: [{ kind: 'command', detail: 'editppt config --api-key •••', ok: true }] }
  }
  try {
    const saved = await post('/api/dsh-imagegen/canvas/skills/config/save', {
      name: 'image-to-editable-ppt',
      values: [{ id: 'image-api-key', value: 'sk-1' }, { bad: true }, { id: 'x' }],
      language: 'zh',
    })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    assert.deepEqual(seen.saved, { name: 'image-to-editable-ppt', values: [{ id: 'image-api-key', value: 'sk-1' }], language: 'zh' })

    const applied = await post('/api/dsh-imagegen/canvas/skills/config/apply', { name: 'image-to-editable-ppt', language: 'zh' })
    assert.equal(applied.body.ok, true, JSON.stringify(applied.body))
    assert.equal(applied.body.steps[0].kind, 'command')
    assert.equal(seen.applied.name, 'image-to-editable-ppt')

    const nameless = await post('/api/dsh-imagegen/canvas/skills/config/save', { values: [] })
    assert.equal(nameless.body.ok, false)
    assert.equal(nameless.body.code, 'bad-request')
  } finally {
    skillLibraryFake.configSave = previous.save
    skillLibraryFake.configApply = previous.apply
  }
})

await new Promise(resolve => server.close(resolve))

// -------------------------------------------------- D. client bundle shape
await check('D1 client bundle registers via __ModuleLoader__ and exposes the canvas raster helpers', () => {
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
  // surface is exercised (apply never runs without a real DOM). The react
  // stub needs the top-level APIs the inlined lucide-react icons touch.
  const stubs = {
    'react': {
      Fragment: 'Fragment',
      createContext: (value) => ({ Provider: () => null, Consumer: () => null, _currentValue: value }),
      createElement: () => null,
      forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
      memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn }),
      useContext: () => ({}),
      useMemo: (factory) => factory(),
      useRef: () => ({ current: null }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-dom': {},
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: (initial) => ({
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

  // --- canvas raster helpers (image-ops.ts), reachable only through the bundle
  // Cross-realm values (VM context): spread into local objects before comparing.
  const { containRect, rectBetween, rectToPixels, removeBackground, autoRemoveBackground, transparencyRatio, drawAnnotation, compositeAnnotatedResult } = exportsOf
  // Letterbox: a 200x100 image inside a 100x100 node body.
  assert.deepEqual({ ...containRect(100, 100, 200, 100) }, { left: 0, top: 25, width: 100, height: 50 })
  // Dragging across the letterboxed image yields the full normalized rect.
  assert.deepEqual(
    { ...rectBetween({ x: 0, y: 25 }, { x: 100, y: 75 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 1, height: 1 },
  )
  // Drags that leave the image clamp to [0,1] instead of going negative.
  assert.deepEqual(
    { ...rectBetween({ x: -50, y: -50 }, { x: 10, y: 37.5 }, { left: 0, top: 25, width: 100, height: 50 }) },
    { x: 0, y: 0, width: 0.1, height: 0.25 },
  )
  // Normalized rect -> pixels, kept inside the canvas bounds.
  assert.deepEqual({ ...rectToPixels({ x: 0.5, y: 0.5, width: 0.75, height: 0.75 }, 200, 100) }, { x: 100, y: 50, width: 100, height: 50 })

  // Minimal 2D canvas mock: enough of the API for the matting, annotation and
  // composite helpers (createElement/getImageData/putImageData/drawImage/fillRect
  // plus destination-out erasing) to run headless.
  const makeCanvas = (width = 0, height = 0, fill) => {
    let pixels = null
    const canvas = { width, height }
    const ensure = () => {
      const size = canvas.width * canvas.height * 4
      if (pixels === null || pixels.length !== size) {
        pixels = new Uint8ClampedArray(size)
        if (fill !== undefined) fill(pixels, canvas.width, canvas.height)
      }
      return pixels
    }
    // `_data` mirrors a real canvas: allocated lazily, filled by drawImage.
    Object.defineProperty(canvas, '_data', { get: () => ensure(), set: next => { pixels = next } })
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?._data
      if (src === undefined) return
      const sourceWidth = source.width
      const sourceHeight = source.height
      let sx = 0
      let sy = 0
      let sWidth = sourceWidth
      let sHeight = sourceHeight
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(sourceWidth - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * sourceWidth + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const erase = canvas.__composite === 'destination-out'
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    canvas.getContext = () => ({
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, strokeRect() {}, fillText() {},
      measureText: () => ({ width: 8 }),
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    })
    canvas.toDataURL = () => 'data:image/png;base64,AAAA'
    ensure()
    return canvas
  }
  // White backdrop with a red square in the middle.
  const subjectCanvas = makeCanvas(64, 64, (data, width) => {
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= 20 && x < 44 && y >= 20 && y < 44
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  })
  // image-ops reads globalThis.document inside the VM realm, so the stub has
  // to live on the sandbox global, not on this module's globalThis.
  sandbox.document = { createElement: () => makeCanvas() }
  try {
    const removed = removeBackground(subjectCanvas)
    assert.ok(removed.removedRatio > 0.5 && removed.removedRatio < 0.95, `border backdrop removed, got ${removed.removedRatio}`)
    const output = removed.canvas._data
    assert.equal(output[0 * 4 + 3], 0, 'the corner is fully transparent')
    assert.equal(output[(32 * 64 + 32) * 4 + 3], 255, 'the subject stays opaque')
    assert.equal(output[(32 * 64 + 32) * 4], 220, 'the subject keeps its color')
    assert.equal(output[(0 * 64 + 32) * 4 + 3], 0, 'the top edge is transparent')
    assert.ok(transparencyRatio(removed.canvas) > 0.4, 'the cut-out is detected as transparent')
    // A uniform image has no distinguishable background: nothing is removed.
    const flat = makeCanvas(32, 32, data => data.fill(200))
    assert.equal(autoRemoveBackground(flat).removedRatio, 0, 'a flat image is left untouched')
    // Annotation marks are burned into a copy, not the source.
    const marked = drawAnnotation(subjectCanvas, [{ rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, index: 0 }])
    assert.equal(marked.width, 64)
    assert.equal(marked._data[(0 * 64 + 0) * 4], 255, 'outside the box the pixels are unchanged')
    assert.equal(subjectCanvas._data[(20 * 64 + 20) * 4], 220, 'the source image is not modified')

    // 标注 composite: the model's "result" keeps the marker everywhere, but the
    // final image must show generated pixels only inside the box and the clean
    // original outside it.
    const modelResult = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 7; data[i + 1] = 7; data[i + 2] = 7; data[i + 3] = 255 } })
    const cleanOriginal = makeCanvas(64, 64, data => { for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = 200; data[i + 2] = 200; data[i + 3] = 255 } })
    const composited = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 0)
    const pixels = composited._data
    const at = (x, y) => pixels[(y * 64 + x) * 4]
    assert.equal(at(32, 32), 7, 'inside the box the generated content is kept')
    assert.equal(at(4, 4), 200, 'outside the box the clean original is restored')
    assert.equal(at(60, 60), 200, 'the marker in the result is overwritten outside the box')
    // The inset shaves the marker stroke that sits on the box border.
    const inset = compositeAnnotatedResult(modelResult, cleanOriginal, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 4)._data
    assert.equal(inset[(16 * 64 + 16) * 4], 200, 'the inset restores the pixels right on the box edge')
  } finally {
    delete sandbox.document
  }
})

await check('D2 the client bundle ships the canvas skill + file-node surface', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Copy: the skill picker, the polish menu and the file-node strings all ride
  // the same dictionary as every other panel label.
  for (const needle of [
    'canvas.skills.pickerTitle',
    'canvas.skills.fileNode',
    'canvas.skills.pptDesc',
    'canvas.skills.libraryTitle',
    'canvas.skills.installNow',
    'canvas.polish.formal',
    'settings.skillsEnabled',
    'canvas.preview.expand',
    'canvas.preview.textTruncated',
    'canvas.preview.reason.unreadable',
  ]) {
    assert.ok(source.includes(needle), `client bundle is missing ${needle}`)
  }
  // Endpoints: the browser half must call the exact routes the host registers.
  for (const route of [
    '/api/dsh-imagegen/canvas/file/upload',
    '/api/dsh-imagegen/canvas/file/preview',
    '/api/dsh-imagegen/canvas/skills/list',
    '/api/dsh-imagegen/canvas/skills/run',
    '/api/dsh-imagegen/canvas/skills/task',
    '/api/dsh-imagegen/canvas/skills/cancel',
    '/api/dsh-imagegen/canvas/skills/library',
    '/api/dsh-imagegen/canvas/skills/install',
    '/api/dsh-imagegen/canvas/skills/remove',
  ]) {
    assert.ok(source.includes(route), `client bundle is missing route ${route}`)
  }
  // The heavy-tier confirmation and the batch cap are UI-side gates.
  assert.ok(source.includes('canvas.skills.confirmBody'))
  assert.ok(source.includes('canvas.skills.batchTooMany'))
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
  let confirmationCalls = 0
  jsdomWindow.confirm = () => {
    confirmationCalls += 1
    return false
  }
  // jsdom has no ResizeObserver; the canvas measures its viewport with one.
  jsdomWindow.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Pointer capture is a no-op here; the annotation drag only needs the events.
  jsdomWindow.Element.prototype.setPointerCapture = function setPointerCapture() {}
  jsdomWindow.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  jsdomWindow.Element.prototype.hasPointerCapture = function hasPointerCapture() { return true }
  // Headless 2D canvas: white backdrop with a red square, nearest-neighbour
  // drawImage (source rect aware, like the real API) and a fixed PNG data URL.
  const paintSample = (data, width, height) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const subject = x >= width * 0.3 && x < width * 0.7 && y >= height * 0.3 && y < height * 0.7
        data[offset] = subject ? 220 : 255
        data[offset + 1] = subject ? 40 : 255
        data[offset + 2] = subject ? 60 : 255
        data[offset + 3] = 255
      }
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    // WebGL backgrounds opt out (the real jsdom build has no GL either).
    if (type !== '2d') return null
    const canvas = this
    const ensure = () => {
      const size = Math.max(1, canvas.width * canvas.height * 4)
      if (canvas.__pixels === undefined || canvas.__pixels.length !== size) {
        canvas.__pixels = new Uint8ClampedArray(size)
        if (canvas.__painted === true) paintSample(canvas.__pixels, canvas.width, canvas.height)
      }
      return canvas.__pixels
    }
    const drawImage = (source, ...args) => {
      const dest = ensure()
      const src = source?.__pixels
      if (src === undefined) {
        canvas.__painted = true
        paintSample(dest, canvas.width, canvas.height)
        return
      }
      let sx = 0
      let sy = 0
      let sWidth = source.width
      let sHeight = source.height
      let dx = 0
      let dy = 0
      let dWidth = canvas.width
      let dHeight = canvas.height
      if (args.length === 2) { dx = args[0]; dy = args[1] }
      else if (args.length === 4) { dx = args[0]; dy = args[1]; dWidth = args[2]; dHeight = args[3] }
      else if (args.length === 8) { [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = args }
      for (let y = 0; y < dHeight; y += 1) {
        const sourceY = Math.min(source.height - 1, sy + Math.floor((y * sHeight) / dHeight))
        for (let x = 0; x < dWidth; x += 1) {
          const sourceX = Math.min(source.width - 1, sx + Math.floor((x * sWidth) / dWidth))
          const from = (sourceY * source.width + sourceX) * 4
          const to = ((dy + y) * canvas.width + dx + x) * 4
          if (to < 0 || to + 3 >= dest.length) continue
          // Source-over compositing: fully transparent source pixels leave the
          // destination untouched (the real canvas does the same).
          const alpha = src[from + 3] / 255
          if (alpha === 0) continue
          for (let channel = 0; channel < 3; channel += 1) {
            dest[to + channel] = Math.round(src[from + channel] * alpha + dest[to + channel] * (1 - alpha))
          }
          dest[to + 3] = Math.round((alpha + (dest[to + 3] / 255) * (1 - alpha)) * 255)
        }
      }
    }
    const fillRect = (x, y, w, h) => {
      const dest = ensure()
      const hex = /^#([0-9a-f]{6})$/i.exec(String(canvas.__fillStyle ?? ''))
      const red = hex === null ? 0 : parseInt(hex[1].slice(0, 2), 16)
      const green = hex === null ? 0 : parseInt(hex[1].slice(2, 4), 16)
      const blue = hex === null ? 0 : parseInt(hex[1].slice(4, 6), 16)
      const erase = canvas.__composite === 'destination-out'
      for (let py = Math.max(0, Math.round(y)); py < Math.min(canvas.height, Math.round(y + h)); py += 1) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(canvas.width, Math.round(x + w)); px += 1) {
          const offset = (py * canvas.width + px) * 4
          if (erase) { dest[offset] = 0; dest[offset + 1] = 0; dest[offset + 2] = 0; dest[offset + 3] = 0 }
          else { dest[offset] = red; dest[offset + 1] = green; dest[offset + 2] = blue; dest[offset + 3] = 255 }
        }
      }
    }
    return {
      getImageData: () => ({ data: ensure(), width: canvas.width, height: canvas.height }),
      putImageData: image => { ensure().set(image.data) },
      drawImage,
      fillRect,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
      strokeRect() {}, clearRect() {}, fillText() {}, scale() {},
      measureText: () => ({ width: 8 }),
      strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '', lineCap: '', lineJoin: '',
      get fillStyle() { return canvas.__fillStyle ?? '#000000' },
      set fillStyle(value) { canvas.__fillStyle = value },
      get globalCompositeOperation() { return canvas.__composite ?? 'source-over' },
      set globalCompositeOperation(value) { canvas.__composite = value },
    }
  }
  jsdomWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJD'

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
  const ecommerceSubmissions = []
  /** Canvas generation requests submitted from the workspace composer. */
  const canvasTasks = []
  /** Documents the workspace persisted through /canvas/save. */
  const canvasSaves = []
  const canvasImageAsset = {
    assetId: `${'a'.repeat(64)}.png`,
    url: `/api/dsh-imagegen/canvas/asset/${'a'.repeat(64)}.png`,
    mime: 'image/png',
    bytes: 128,
    width: 64,
    height: 64,
    origin: 'upload',
  }
  let canvasUploads = 0
  /** One stored text file, addressed the way the real content-addressed store is. */
  const canvasFileAsset = {
    assetId: `${'c'.repeat(64)}.txt`,
    url: `/api/dsh-imagegen/canvas/asset/${'c'.repeat(64)}.txt`,
    mime: 'text/plain',
    bytes: 48,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'notes.txt',
    textPreview: '文件预览正文',
  }
  /** One stored PDF, the document type the browser renders itself. */
  const canvasPdfAsset = {
    assetId: `${'d'.repeat(64)}.pdf`,
    url: `/api/dsh-imagegen/canvas/asset/${'d'.repeat(64)}.pdf`,
    mime: 'application/pdf',
    bytes: 1024,
    width: 0,
    height: 0,
    origin: 'upload',
    kind: 'file',
    name: 'paper.pdf',
  }
  /** Preview requests the canvas file nodes issued (assetId + hints). */
  const previewRequests = []
  /** Every fetch path the client issued (debug aid for the canvas tools). */
  const requestPaths = []
  const canvasDocument = {
    version: 2,
    id: 'canvas-smoke',
    title: 'Smoke canvas',
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const fetchStub = async (input, init) => {
    const path = String(input)
    requestPaths.push(path)
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
            { id: 'hist-ecom-1', createdAt: 4, mode: 'text', model: 'gpt-image-2', prompt: 'product main image', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom1.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'main-1', slotLabel: '主图' },
            { id: 'hist-ecom-2', createdAt: 5, mode: 'text', model: 'gpt-image-2', prompt: 'product selling point', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/history/ecom2.png', mime: 'image/png' }], workflow: 'ecommerce', projectId: 'project-hist', projectName: '历史保温杯', slotKey: 'sp-1', slotLabel: '卖点图' },
          ],
        }),
      }
    }
    if (path.endsWith('/gallery/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          entries: [{ id: 'gallery-one', createdAt: 3, mode: 'text', model: 'gpt-image-2', prompt: 'gallery prompt', size: '1:1', quality: '2k', detail: '', n: 1, images: [{ url: '/api/dsh-imagegen/gallery/image/gallery.png', mime: 'image/png' }] }],
        }),
      }
    }
    if (path.endsWith('/canvas/list')) {
      return { ok: true, json: async () => ({ ok: true, projects: [{ id: canvasDocument.id, title: canvasDocument.title, revision: canvasDocument.revision, nodeCount: 0, createdAt: 1, updatedAt: 1 }] }) }
    }
    if (path.endsWith('/canvas/read')) {
      return { ok: true, json: async () => ({ ok: true, document: canvasDocument }) }
    }
    if (path.endsWith('/canvas/save')) {
      const payload = JSON.parse(init.body)
      canvasSaves.push(payload.document)
      return { ok: true, json: async () => ({ ok: true, document: { ...payload.document, revision: payload.document.revision + 1 } }) }
    }
    if (path.endsWith('/canvas/file/preview')) {
      // The real host decodes the asset; the fixture stands in with the decoded
      // shape so the reader can be exercised end to end.
      previewRequests.push(JSON.parse(init.body))
      return {
        ok: true,
        json: async () => ({
          ok: true,
          preview: { kind: 'text', format: 'txt', text: '文件预览正文\nsecond line\nthird line', truncated: false, lines: 3 },
        }),
      }
    }
    if (path.endsWith('/canvas/asset/upload')) {
      canvasUploads += 1
      const payload = JSON.parse(init.body)
      return {
        ok: true,
        json: async () => ({
          ok: true,
          asset: {
            assetId: `${String(canvasUploads).padStart(64, 'b')}.png`,
            url: `/api/dsh-imagegen/canvas/asset/${String(canvasUploads).padStart(64, 'b')}.png`,
            mime: 'image/png',
            bytes: 64,
            width: payload.width,
            height: payload.height,
            origin: payload.origin ?? 'upload',
          },
        }),
      }
    }
    if (path.endsWith('/canvas/layers')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          plan: {
            layers: [
              { kind: 'background', label: '背景' },
              { kind: 'object', label: '人物', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } },
              { kind: 'text', label: '标题', rect: { x: 0.1, y: 0.08, width: 0.6, height: 0.12 }, text: '夏日限定', color: '#ffee00' },
            ],
          },
        }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/canvas/asset/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/history/')) {
      return {
        ok: true,
        blob: async () => new jsdomWindow.Blob([pngBytes], { type: 'image/png' }),
      }
    }
    if (path.startsWith('/api/dsh-imagegen/gallery/image/')) {
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
          sourceId: 'vibeui',
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
    if (path.endsWith('/templates/favorites/list')) {
      return { ok: true, json: async () => ({ ok: true, favorites: [] }) }
    }
    if (path.endsWith('/templates/sample')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          samples: [{
            sourceId: 'vibeui',
            case: { id: 1, title: 'Template poster', prompt: 'A reusable template prompt', category: 'Posters & Typography', categoryZh: '海报与排版', styles: [], scenes: [], sourceLabel: '@author', sourceUrl: '', githubUrl: '', image: '', featured: false },
          }],
        }),
      }
    }
    if (path.endsWith('/tasks/submit')) {
      const payload = JSON.parse(init.body)
      ecommerceSubmissions.push(payload)
      if (payload.canvas !== undefined) canvasTasks.push(payload)
      // Freeze the id eagerly: the json() closure runs after all concurrent
      // submits pushed, so a lazy template literal would hand every response
      // the same id.
      const task = { id: `ecommerce-task-${ecommerceSubmissions.length}`, request: payload, status: 'queued', createdAt: 1 }
      return { ok: true, json: async () => ({ ok: true, task }) }
    }
    if (path.endsWith('/tasks/list')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: ecommerceSubmissions.map((payload, index) => ({
            id: `ecommerce-task-${index + 1}`,
            request: payload,
            status: index === 0 ? 'completed' : 'queued',
            createdAt: 1,
            ...index === 0 ? { result: { images: [{ b64: 'cG5nLWRhdGE=', mime: 'image/png' }] } } : {},
          })),
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
    ResizeObserver: jsdomWindow.ResizeObserver,
    CustomEvent: jsdomWindow.CustomEvent,
    HTMLElement: jsdomWindow.HTMLElement,
    FileReader: jsdomWindow.FileReader,
    // image-ops decodes asset URLs through `new Image()`; jsdom never loads
    // resources, so the stub resolves onload on the next tick.
    Image: class SmokeImage {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0 }
      set src(value) {
        this._src = value
        setTimeout(() => {
          this.naturalWidth = 64
          this.naturalHeight = 64
          this.onload?.()
        }, 0)
      }
      get src() { return this._src }
    },
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
  // Locale runtime stub: register/addLanguage/subscribe + a snapshot, mirroring
  // the dsh-client-locale face the plugin bridges into.
  const localeListeners = new Set()
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    get(name) { return name === 'connection' ? { isLoopback: true } : undefined },
    locale: {
      register() {},
      addLanguage() { return () => {} },
      getLocale() { return { active: 'zh', locales: [], revision: 0 } },
      subscribe(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn) },
    },
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
    '@deepseek-ai/dsh-client-store': {
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
    assert.ok(jsdomDocument.querySelector('[data-history-new]') !== null, 'new creation button rendered beside history clear')
    assert.ok(jsdomDocument.querySelector('[data-history-clear]') !== null, 'history clear button rendered')
    jsdomDocument.querySelector('[data-history-clear]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(confirmationCalls, 1, 'history clear asks for confirmation')
    // The panel header rendered.
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-view] h2') !== null, 'panel header rendered')
    const connectionStatus = jsdomDocument.querySelector('[data-dsh-imagegen-view] [data-connected]')
    assert.equal(connectionStatus?.getAttribute('data-connected'), 'false', 'missing key is shown as disconnected')
    assert.equal(jsdomDocument.querySelectorAll('[data-comparison]').length, 1, 'comparison history rows collapse into one item')
    assert.ok(jsdomDocument.querySelector('[data-comparison]')?.textContent?.includes('gpt-image-2'), 'comparison history shows its models')

    // Gallery keeps the sidebar history visible, and selecting one history
    // group returns the center workspace to text-to-image.
    const tablistButtons = [...view.querySelectorAll('[role="tablist"] button')]
    assert.equal(tablistButtons.length, 6, 'top nav has four entries and the normal workspace shows two generation modes')
    const ecommerceSwitch = tablistButtons.find(button => button.textContent?.includes('电商模式'))
    assert.ok(ecommerceSwitch !== undefined, 'ecommerce top-nav entry is present')
    const normalSwitch = tablistButtons.find(button => button.textContent?.includes('普通生图'))
    assert.ok(normalSwitch !== undefined, 'normal top-nav entry is present')
    const canvasSwitch = tablistButtons.find(button => button.textContent?.includes('无限画布'))
    assert.ok(canvasSwitch !== undefined, 'infinite canvas top-nav entry is present')
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(view.querySelector('[data-ecommerce-workspace]') !== null, 'ecommerce workspace is rendered')
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 4, 'generation sub-modes hide in the ecommerce workspace')
    assert.equal([...view.querySelectorAll('textarea')].some(textarea => (textarea.getAttribute('placeholder') ?? '').includes('描述你想要的画面')), false, 'normal prompt card is hidden in ecommerce workspace')
    const ecommerceName = view.querySelector('input[placeholder="商品名称（必填）"]')
    assert.ok(ecommerceName !== null, 'ecommerce product form is rendered')
    // Fill the product name through the native value setter (React 18 +
    // jsdom), then open the local plan preview: this must not call the host.
    const nativeInputSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLInputElement.prototype, 'value').set
    const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(jsdomWindow.HTMLTextAreaElement.prototype, 'value').set
    nativeInputSetter.call(ecommerceName, '测试保温杯')
    ecommerceName.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(view.querySelectorAll('input[placeholder="项目名称（可选）"]').length, 0, 'project name input was removed')
    const ecommerceLanguage = view.querySelector('select[aria-label="文案语言"]')
    assert.ok(ecommerceLanguage !== null, 'ecommerce copy language selector is rendered')
    ecommerceLanguage.value = 'custom'
    ecommerceLanguage.dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const customLanguage = view.querySelector('input[placeholder*="语言名称"]')
    assert.ok(customLanguage !== null, 'custom language input is rendered')
    nativeInputSetter.call(customLanguage, 'Русский')
    customLanguage.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    // Upload one product asset through the multi-file input and mark the
    // scene slot as reference-free: the confirm flow must resolve each slot's
    // reference role into an edit or text request accordingly.
    const ecommerceUploadInput = view.querySelector('input[type="file"][multiple]')
    assert.ok(ecommerceUploadInput !== null, 'ecommerce multi-upload input is rendered')
    const assetFile = new jsdomWindow.File(['cup'], 'cup.png', { type: 'image/png' })
    Object.defineProperty(ecommerceUploadInput, 'files', { value: { 0: assetFile, length: 1 }, configurable: true })
    ecommerceUploadInput.dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(view.querySelector('[data-ecommerce-asset]') !== null, 'uploaded product asset renders as a chip')
    const refToggle = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('参考图设置'))
    assert.ok(refToggle !== undefined, 'reference-role settings toggle is rendered')
    refToggle.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    const refSelects = [...view.querySelectorAll('select[data-ecommerce-ref-select]')]
    assert.equal(refSelects.length, 4, 'every enabled slot exposes a reference-role selector')
    refSelects[2].value = 'none'
    refSelects[2].dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const previewSet = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('生成套图预览'))
    assert.ok(previewSet !== undefined, 'ecommerce preview action is rendered')
    previewSet.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(view.textContent?.includes('预计生成'), 'ecommerce plan preview is shown')
    assert.equal(ecommerceSubmissions.length, 0, 'plan preview must not submit generation tasks')
    // Back to the normal workspace via the top nav: gallery works as before.
    normalSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(view.querySelectorAll('[role="tablist"] button').length, 6, 'generation sub-modes return in the normal workspace')
    const galleryPill = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('素材库'))
    assert.ok(galleryPill !== undefined, '素材库入口存在')
    galleryPill.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    await waitForSelector(view, '[data-gallery-add-conversation]')
    assert.equal(view.querySelector('textarea[placeholder*="描述你想要的画面"]'), null, 'gallery hides normal generation prompt')
    assert.equal(view.querySelector('button[class*="generateButton"]'), null, 'gallery hides normal generation button')
    assert.equal(view.textContent?.includes('灵感案例'), false, 'gallery hides inspiration examples')
    assert.ok(view.querySelector('[data-gallery="true"]') !== null, 'gallery workspace is isolated')
    assert.ok(jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history]') !== null, 'history remains visible in gallery mode')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 2, 'gallery mode is active')
    assert.ok(view.querySelector('[data-gallery="true"] [data-gallery-add-conversation]') !== null, 'gallery entries expose add-to-conversation action')
    const galleryHistoryMain = jsdomDocument.querySelector('[data-dsh-imagegen-history-host] [data-dsh-imagegen-history-main]')
    assert.ok(galleryHistoryMain !== null, 'gallery mode exposes clickable history')
    galleryHistoryMain.click()
    await waitForSelector(view, '[data-count]')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 0, 'history click returns to text-to-image')
    assert.ok(view.querySelector('textarea[placeholder*="描述你想要的画面"]') !== null, 'normal prompt returns after gallery')
    assert.ok(view.querySelector('[class*="generateButton"]') !== null, 'normal generate button returns after gallery')
    assert.ok(view.querySelectorAll('[data-count]').length > 0, 'history result is visible before starting a new creation')
    jsdomDocument.querySelector('[data-history-new]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(view.querySelectorAll('[data-count]').length, 0, 'new creation clears the image preview')
    assert.equal(view.querySelectorAll('[data-gallery="true"]').length, 0, 'new creation returns to text-to-image')

    const galleryTab = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('素材库'))
    assert.ok(galleryTab !== undefined, '素材库入口仍存在')
    galleryTab.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(view.querySelector('[data-gallery-clear]') !== null, 'gallery clear button rendered')
    view.querySelector('[data-gallery-clear]')?.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(confirmationCalls, 2, 'gallery clear asks for confirmation')
    // The settings card registered into the official plugin-config slot.
    assert.equal(registered.length, 1)
    assert.equal(registered[0].key, 'dsh-imagegen')
    assert.equal(registered[0].name, 'settings.plugin.item')

    // The asset library must not inherit the normal generation inspiration wall.
    assert.equal(jsdomDocument.querySelector('[aria-label="灵感案例"]'), null, 'asset library hides inspiration wall')
    normalSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    // Inspiration wall belongs to the empty normal-generation canvas only.
    const inspirationWall = jsdomDocument.querySelector('[aria-label="灵感案例"]')
    assert.ok(inspirationWall !== null, 'inspiration wall rendered on the empty canvas')
    const shuffleButton = [...inspirationWall.querySelectorAll('button')]
      .find(button => button.textContent?.includes('随机'))
    assert.ok(shuffleButton !== undefined, 'inspiration shuffle action rendered')
    const inspirationTile = [...inspirationWall.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Template poster'))
    assert.ok(inspirationTile !== undefined, 'inspiration tile rendered')
    inspirationTile.click()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(jsdomDocument.querySelector('textarea')?.value, 'A reusable template prompt', 'inspiration tile filled the prompt')

    // Template-library regression: choose a card, use its prompt, and verify
    // the text editor receives it while the modal closes.
    const templateTrigger = [...jsdomDocument.querySelectorAll('button')]
      .find(button => button.textContent?.includes('模板库'))
    assert.ok(templateTrigger !== undefined, 'template library trigger rendered')
    templateTrigger.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const libraryModal = jsdomDocument.querySelector('[role="dialog"][aria-label="提示词模板库"]')
    assert.ok(libraryModal !== null, 'template modal rendered')
    const templateCard = [...libraryModal.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Template poster'))
    assert.ok(templateCard !== undefined, 'template card rendered')
    templateCard.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    const useTemplate = [...libraryModal.querySelectorAll('button')]
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

    // Ecommerce submission flow: with the channel key set, confirming the plan
    // fans out one queued task per planned image carrying the set metadata.
    const ecommerceTabAgain = [...view.querySelectorAll('[role="tablist"] button')].find(button => button.textContent?.includes('电商模式'))
    assert.ok(ecommerceTabAgain !== undefined, 'ecommerce switch still present for submission flow')
    ecommerceTabAgain.click()
    await new Promise(resolve => setTimeout(resolve, 50))
    const confirmSet = [...view.querySelectorAll('button')].find(button => button.textContent?.includes('确认生成整套图片'))
    assert.ok(confirmSet !== undefined, 'ecommerce confirm action is rendered')
    confirmSet.click()
    await new Promise(resolve => setTimeout(resolve, 3500))
    assert.equal(ecommerceSubmissions.length, 6, 'anchor chain submits the main image first, then the remaining slots')
    assert.ok(ecommerceSubmissions.every(payload => payload.workflow === 'ecommerce' && typeof payload.projectId === 'string' && payload.projectId !== ''), 'submissions carry the ecommerce workflow and project id')
    assert.ok(ecommerceSubmissions.every(payload => typeof payload.slotLabel === 'string' && payload.slotLabel !== '' && typeof payload.slotKey === 'string' && payload.slotKey !== ''), 'submissions carry slot metadata')
    const mainPayload = ecommerceSubmissions.find(payload => payload.slotKey === 'main-1')
    assert.ok(mainPayload !== undefined && mainPayload.mode === 'edit' && mainPayload.refName === 'cup.png', 'main image uses the uploaded product asset')
    const anchored = ecommerceSubmissions.filter(payload => payload.slotKey !== 'main-1')
    assert.equal(anchored.length, 5, 'remaining slots are anchored after the main image')
    assert.ok(anchored.every(payload => payload.mode === 'edit' && payload.refName === 'set-main-anchor' && typeof payload.image === 'string' && payload.image.startsWith('data:')), 'anchored slots reference the generated main image')
    assert.ok(anchored.every(payload => payload.prompt.startsWith('商品套图一致性约束')), 'anchored prompts carry the consistency constraint')
    assert.ok(ecommerceSubmissions.every(payload => payload.projectName === '测试保温杯'), 'submissions carry the product name snapshot')
    const ecommerceResults = view.querySelector('[data-ecommerce-results]')
    assert.ok(ecommerceResults !== null, 'product set results section is rendered')
    assert.ok(ecommerceResults.textContent?.includes('1/6'), 'results header reports task progress')
    const mainGroup = ecommerceResults.querySelector('[data-ecommerce-group="主图"]')
    assert.ok(mainGroup !== null, 'results are grouped by slot label')
    assert.ok(mainGroup.querySelector('img') !== null, 'completed slot renders its image')
    let draftSnapshot = null
    try { draftSnapshot = jsdomWindow.localStorage.getItem('dsh-imagegen-ecommerce-draft') } catch { /* opaque origin: draft persistence is optional */ }
    if (draftSnapshot !== null) {
      assert.ok(draftSnapshot.includes('测试保温杯'), 'ecommerce draft persists to local storage')
    }

    // Restore one persisted product set from history: the sidebar collapses
    // its rows into one project entry, and clicking it rebuilds the grouped
    // results canvas from the stored entries.
    const ecommerceHistoryRow = [...jsdomDocument.querySelectorAll('[data-dsh-imagegen-history-main]')]
      .find(button => button.textContent?.includes('历史保温杯'))
    assert.ok(ecommerceHistoryRow !== undefined, 'ecommerce history rows collapse into one project entry')
    ecommerceHistoryRow.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const restoredResults = view.querySelector('[data-ecommerce-results]')
    assert.ok(restoredResults !== null, 'restored project keeps the ecommerce canvas')
    assert.ok(restoredResults.textContent?.includes('2/2'), 'restored results report history progress')
    assert.ok(restoredResults.querySelector('[data-ecommerce-group="卖点图"] img') !== null, 'restored groups render stored images')

    // The clear path: resetting the key stages an explicit clear and must
    // also report success.
    face.channels.setChannelKey('default', '')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 100))
    const afterClear = face.hooks.imageGenSettingsCard.getSnapshot()
    assert.equal(afterClear.failed, false, 'clearing a secret must not report failure')
    assert.equal(keyState.set, false, 'key clear reached the bridge')
    assert.equal(face.hooks.imageGenSettingsCard.getSnapshot().channels.keySet.default, false, 'key-set flag follows the clear')
    canvasSwitch.click()
    await waitForSelector(view, '[data-canvas-workspace]')
    assert.ok(view.querySelector('[data-canvas-workspace]') !== null, 'infinite canvas workspace is mounted')

    // --- canvas image tools: 标注 / 移除背景 / 图层拆分 / 模型选择 ---
    // The fixture below seeds an image -> config pair, so the whole pipeline can
    // run headless: draw a box, get a prompt card, generate a boxed edit, cut
    // out the background, and decompose the picture into layer nodes.
    canvasDocument.nodes = [
      { id: 'node-image', type: 'image', title: '图片节点', x: 0, y: 0, width: 240, height: 240, metadata: { asset: canvasImageAsset, status: 'success' } },
      { id: 'node-config', type: 'config', title: '生成配置', x: 640, y: 0, width: 320, height: 190, metadata: { status: 'idle' } },
    ]
    canvasDocument.connections = [{ id: 'edge-fixture', fromNodeId: 'node-image', toNodeId: 'node-config' }]
    // Leave and re-enter the workspace so it reads the seeded document.
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-image"]')
    assert.ok(view.querySelector('[data-node-id="node-image"]') !== null, 'image node rendered from the fixture')

    const waitUntil = async (predicate, timeout = 2500) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      return predicate()
    }
    const nodeTool = (nodeId, label) => view.querySelector(`[data-node-id="${nodeId}"] [title^="${label}"]`)
    assert.ok(nodeTool('node-image', '标注') !== null, '标注 button rendered')
    assert.ok(nodeTool('node-image', '移除背景') !== null, '移除背景 button rendered')
    assert.ok(nodeTool('node-image', '图层拆分') !== null, '图层拆分 button rendered')
    assert.ok(view.querySelector('[data-node-id="node-image"] button[aria-label^="本节点使用的模型"]') !== null, 'node model selector rendered')

    // Enter annotation mode: the image body gains a drawing overlay.
    nodeTool('node-image', '标注').click()
    await waitForSelector(view, '[data-node-id="node-image"][data-annotating]')
    const overlay = view.querySelector('[data-node-id="node-image"] [title^="在图片上拖拽画框"]')
    assert.ok(overlay !== null, 'annotation overlay mounted')
    // The 64x64 image letterboxes into a 100x100 overlay: a drag from 10% to
    // 60% must land as a normalized 0.5 box.
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const pointer = (type, x, y) => overlay.dispatchEvent(new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
    pointer('pointerdown', 10, 10)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer('pointermove', 60, 60)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer('pointerup', 60, 60)
    await waitForSelector(view, 'textarea[placeholder^="描述这个框里要改成什么"]')
    const cardArea = view.querySelector('textarea[placeholder^="描述这个框里要改成什么"]')
    assert.ok(cardArea !== null, 'releasing the box created a prompt card')
    assert.ok(view.querySelector('[data-node-id="node-image"][data-annotating]') !== null, 'annotation mode stays active for more boxes')
    // Delete inside an empty card removes the card itself (the key would look
    // broken otherwise, since a fresh card has nothing to erase).
    const firstCardId = cardArea.closest('[data-node-id]').getAttribute('data-node-id')
    // Make sure the card is on the canvas (a save carrying it landed) before
    // deleting it, so the assertion below cannot pass on a stale snapshot.
    assert.ok(await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === firstCardId)), 'the prompt card reached the document')
    cardArea.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    assert.ok(
      await waitUntil(() => view.querySelector(`[data-node-id="${firstCardId}"]`) === null),
      'Delete removes an empty text card',
    )
    // Draw the box that carries the real prompt.
    const overlay2 = view.querySelector('[data-node-id="node-image"] [title^="在图片上拖拽画框"]')
    overlay2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const pointer2 = (type, x, y) => overlay2.dispatchEvent(new jsdomWindow.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
    pointer2('pointerdown', 10, 10)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer2('pointermove', 60, 60)
    await new Promise(resolve => setTimeout(resolve, 20))
    pointer2('pointerup', 60, 60)
    await waitForSelector(view, 'textarea[placeholder^="描述这个框里要改成什么"]')
    const cardArea2 = view.querySelector('textarea[placeholder^="描述这个框里要改成什么"]')
    assert.ok(cardArea2 !== null, 'a second box produced a new prompt card')
    // Type the box prompt; the debounced save carries it into the document.
    nativeTextAreaSetter.call(cardArea2, '把这里换成一只橘猫')
    cardArea2.dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }))
    await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.text === '把这里换成一只橘猫'))
    const savedAfterAnnotation = canvasSaves.at(-1)
    assert.ok(savedAfterAnnotation !== undefined, 'annotation edit was persisted')
    const annotationImage = savedAfterAnnotation.nodes.find(node => node.id === 'node-image')
    assert.equal(annotationImage.metadata.annotations.length, 1, `the box is recorded on the image node: ${JSON.stringify(annotationImage.metadata.annotations)}`)
    const recordedBox = annotationImage.metadata.annotations[0]
    assert.deepEqual(
      { x: recordedBox.x, y: recordedBox.y, width: recordedBox.width, height: recordedBox.height },
      { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    )
    const cardNode = savedAfterAnnotation.nodes.find(node => node.id === recordedBox.nodeId)
    assert.ok(cardNode !== undefined, 'the box links to its prompt card')
    assert.equal(cardNode.metadata.text, '把这里换成一只橘猫')
    assert.deepEqual(
      savedAfterAnnotation.connections.map(connection => `${connection.fromNodeId}->${connection.toNodeId}`),
      ['node-image->node-config'],
      'annotation cards are attached, not wired into the graph',
    )
    const linkLayer = view.querySelector('[data-annotation-links]')
    assert.ok(linkLayer !== null, 'annotation leader lines render in their own layer')
    assert.ok(linkLayer.querySelector('[data-annotation-link]') !== null, 'the box has a leader line')
    assert.ok(linkLayer.querySelector('circle') !== null, 'the leader line starts with an anchor dot on the box')
    // The layer must paint above the nodes, otherwise the line hides under the
    // picture it points at.
    const imageElementForOrder = view.querySelector('[data-node-id="node-image"]')
    assert.equal(
      linkLayer.compareDocumentPosition(imageElementForOrder) & jsdomWindow.Node.DOCUMENT_POSITION_PRECEDING,
      jsdomWindow.Node.DOCUMENT_POSITION_PRECEDING,
      'the leader-line layer comes after the nodes in document order',
    )

    // Generate from the config node: the request must carry the boxed reference.
    // The earlier settings flow cleared the channel key, so restore it first —
    // the composer refuses to submit while the plugin reads as disconnected.
    face.channels.setChannelKey('default', 'sk-new')
    await face.channels.commit()
    await new Promise(resolve => setTimeout(resolve, 120))
    view.querySelector('[data-node-id="node-config"]').dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0 }))
    await waitForSelector(view, '[aria-label="生成图片"]')
    const sendButton = view.querySelector('[aria-label="生成图片"]')
    // React refuses to invoke click handlers on a disabled control (mirroring
    // the browser), so wait for the composer to leave the disconnected state.
    assert.ok(await waitUntil(() => view.querySelector('[aria-label="生成图片"]')?.disabled === false), 'composer enabled after the key is restored')
    sendButton.dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    if (!await waitUntil(() => canvasTasks.length > 0)) {
      const toast = [...view.querySelectorAll('[role="status"]')].map(element => element.textContent).join(' | ')
      throw new Error(`no task submitted; toast: ${toast}; requests: ${requestPaths.slice(-6).join(',')}`)
    }
    const boxed = canvasTasks[0]
    assert.equal(boxed.mode, 'edit', 'an annotated generation runs in edit mode')
    assert.equal(boxed.model, 'gpt-image-2', 'the configured model is used')
    assert.ok(String(boxed.image).startsWith('data:image/png;base64,'), 'the marked reference is uploaded as a data URL')
    assert.equal(boxed.refName, 'canvas-annotated.png')
    assert.ok(boxed.prompt.includes('【局部修改约束】'), 'the box constraint reaches the prompt')
    assert.ok(boxed.prompt.includes('把这里换成一只橘猫'), 'the card prompt reaches the prompt')
    assert.ok(boxed.prompt.includes('框 1（左 10%，上 10%，右 60%，下 60%）'), `box coordinates are described: ${boxed.prompt}`)
    assert.equal(boxed.canvas.sourceNodeId, 'node-image', 'the generation is anchored on the annotated image')
    assert.equal(boxed.canvas.parentNodeId, 'node-config')
    // The placeholder remembers the boxes so the finished image can be
    // composited back onto the clean original (the marker must not survive).
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.annotationEdit !== undefined)),
      'the generated placeholder records the annotated boxes for compositing',
    )

    // 移除背景: local matting uploads a transparent PNG and adds a result node.
    nodeTool('node-image', '移除背景').click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.metadata?.transparent === true)),
      'a transparent cut-out node was created',
    )
    const savedAfterMatte = canvasSaves.at(-1)
    const matteNode = savedAfterMatte.nodes.find(node => node.metadata.transparent === true)
    assert.ok(
      savedAfterMatte.connections.some(connection => connection.fromNodeId === 'node-image' && connection.toNodeId === matteNode.id),
      'the cut-out is connected to its source',
    )

    // 图层拆分: the host plan becomes background / object / text nodes.
    nodeTool('node-image', '图层拆分').click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).filter(node => node.metadata?.layer !== undefined).length >= 3),
      'the planned layers became nodes',
    )
    const savedAfterLayers = canvasSaves.at(-1)
    const layerNodes = savedAfterLayers.nodes.filter(node => node.metadata.layer !== undefined)
    assert.deepEqual(layerNodes.map(node => node.metadata.layer.kind).sort(), ['background', 'object', 'text'], 'every planned layer became a node')
    const layerText = layerNodes.find(node => node.metadata.layer.kind === 'text')
    assert.equal(layerText.metadata.text, '夏日限定', 'the recognized text lands in an editable text node')
    assert.equal(layerText.metadata.color, '#ffee00')
    assert.ok(layerText.metadata.fontSize > 0, 'the text layer keeps an editable font size')
    const layerObject = layerNodes.find(node => node.metadata.layer.kind === 'object')
    assert.ok(String(layerObject.metadata.asset.url).startsWith('/api/dsh-imagegen/canvas/asset/'), 'the object layer was uploaded as its own asset')
    assert.ok(
      layerNodes.every(node => savedAfterLayers.connections.some(connection => connection.fromNodeId === 'node-image' && connection.toNodeId === node.id)),
      'every layer node is wired to the source image',
    )

    // Text cards expose font size, weight and color controls.
    const textNodeId = layerText.id
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="放大字号"]`) !== null, 'font size controls rendered')
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="加粗"]`) !== null, 'bold control rendered')
    assert.ok(view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="文字颜色"]`) !== null, 'color control rendered')
    view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="放大字号"]`).click()
    view.querySelector(`[data-node-id="${textNodeId}"] [aria-label="文字颜色"]`).click()
    await waitForSelector(view, `[data-node-id="${textNodeId}"] [title="#e03131"]`)
    view.querySelector(`[data-node-id="${textNodeId}"] [title="#e03131"]`).click()
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).some(node => node.id === textNodeId && node.metadata?.color === '#e03131')),
      'the palette writes the text color',
    )
    const savedText = canvasSaves.at(-1).nodes.find(node => node.id === textNodeId)
    assert.ok(savedText.metadata.fontSize > layerText.metadata.fontSize, 'the font size stepper writes metadata')

    // --- layout + interaction regressions ---
    // Image node chrome no longer covers the picture: no info chips inside the
    // body, a footer strip instead, and the toolbar hangs below the frame.
    const imageNode = view.querySelector('[data-node-id="node-image"]')
    assert.ok(imageNode.querySelector('[data-image-footer]') !== null, 'image node renders an info footer')
    assert.equal(imageNode.querySelector('[data-toolbar]').getAttribute('data-toolbar'), 'bottom', 'image node toolbar sits below the frame')
    assert.ok(imageNode.querySelector('[data-image-footer]').textContent.includes('64×64'), 'footer carries the asset size')
    // Layer nodes are laid out as a column, not stacked on one another.
    const layerBoxes = layerNodes.map(node => ({ y: node.y, height: node.height })).sort((a, b) => a.y - b.y)
    for (let index = 1; index < layerBoxes.length; index += 1) {
      assert.ok(layerBoxes[index].y >= layerBoxes[index - 1].y + layerBoxes[index - 1].height, `layer nodes overlap at index ${index}`)
    }
    // The composer survives the image-node tools (the config node stays selected).
    assert.ok(view.querySelector('[aria-label="生成图片"]') !== null, 'composer still visible after the image-node tools')
    // Ctrl-clicking another node keeps the config node in the selection, so the
    // generation bar does not vanish.
    imageNode.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0, ctrlKey: true }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(view.querySelector('[aria-label="生成图片"]') !== null, 'composer survives a multi-selection containing the config node')

    // The hover toolbar acts on the node under the pointer, not on the
    // selection: deleting an unselected layer node removes exactly that node.
    view.querySelector(`[data-node-id="${layerObject.id}"] [title="删除"]`).dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(
      await waitUntil(() => (canvasSaves.at(-1)?.nodes ?? []).every(node => node.id !== layerObject.id)),
      'the hovered node was deleted',
    )
    const afterDelete = canvasSaves.at(-1)
    assert.ok(afterDelete.nodes.some(node => node.id === 'node-image'), 'other nodes survive a targeted delete')
    assert.ok(afterDelete.nodes.some(node => node.id === 'node-config'), 'the config node survives a targeted delete')
    assert.equal(
      afterDelete.connections.some(connection => connection.fromNodeId === layerObject.id || connection.toNodeId === layerObject.id),
      false,
      'its connections are cleaned up',
    )

    // --- image node ergonomics: attached cards follow, four corner grips ---
    const beforeDrag = canvasSaves.at(-1)
    const imageBefore = beforeDrag.nodes.find(node => node.id === 'node-image')
    const cardBefore = beforeDrag.nodes.find(node => node.id === cardNode.id)
    const imageElement = view.querySelector('[data-node-id="node-image"]')
    imageElement.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 110, clientY: 60, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 40))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 60, button: 0 }))
    assert.ok(
      await waitUntil(() => {
        const moved = (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === 'node-image')
        return moved !== undefined && moved.x === imageBefore.x + 100 && moved.y === imageBefore.y + 50
      }),
      'the image node moved with the pointer',
    )
    const afterDrag = canvasSaves.at(-1)
    const cardAfter = afterDrag.nodes.find(node => node.id === cardNode.id)
    assert.equal(cardAfter.x, cardBefore.x + 100, 'the attached prompt card follows its image node horizontally')
    assert.equal(cardAfter.y, cardBefore.y + 50, 'the attached prompt card follows its image node vertically')

    // Four corner grips, and dragging one resizes (images keep their ratio).
    const grips = [...view.querySelectorAll('[data-node-id="node-image"] [data-corner]')].map(element => element.getAttribute('data-corner')).sort()
    assert.deepEqual(grips, ['ne', 'nw', 'se', 'sw'], 'all four resize corners are rendered')
    const grip = view.querySelector('[data-node-id="node-image"] [data-corner="se"]')
    grip.dispatchEvent(new jsdomWindow.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 40, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 40))
    jsdomWindow.dispatchEvent(new jsdomWindow.MouseEvent('pointerup', { bubbles: true, clientX: 90, clientY: 40, button: 0 }))
    assert.ok(
      await waitUntil(() => {
        const resized = (canvasSaves.at(-1)?.nodes ?? []).find(node => node.id === 'node-image')
        return resized !== undefined && resized.width > imageBefore.width + 40
      }),
      'dragging a corner grip grows the node',
    )
    const resizedImage = canvasSaves.at(-1).nodes.find(node => node.id === 'node-image')
    assert.equal(resizedImage.height, Math.round(resizedImage.width), 'the image keeps its aspect ratio while resizing')
    assert.equal(resizedImage.x, imageBefore.x + 100, 'the anchored corner stays put')

    // --- file nodes read their content instead of showing a download hint ---
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-file', type: 'file', title: 'notes.txt', x: 0, y: 640, width: 300, height: 170, metadata: { asset: canvasFileAsset, fileKind: 'text', status: 'success' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-file"]')
    assert.ok(await waitUntil(() => previewRequests.some(request => request.assetId === canvasFileAsset.assetId)), 'the node asked the host to decode the file')
    assert.ok(
      await waitUntil(() => (view.querySelector('[data-node-id="node-file"] pre')?.textContent ?? '').includes('文件预览正文')),
      'the node body renders the decoded text',
    )
    // The reader opens from the node toolbar and shows the same content larger.
    const fileNode = view.querySelector('[data-node-id="node-file"]')
    assert.ok(fileNode.querySelector('[data-file-footer]').textContent.includes('notes.txt'), 'the file footer carries the name')
    fileNode.querySelector('[title="放大预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await waitForSelector(view, '[role="dialog"]')
    const reader = view.querySelector('[role="dialog"]')
    assert.ok(reader.textContent.includes('notes.txt'), 'the reader header carries the file name')
    assert.ok(reader.querySelector('pre').textContent.includes('second line'), 'the reader shows the full decoded text')
    jsdomWindow.dispatchEvent(new jsdomWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[role="dialog"]') === null), 'Escape closes the reader')

    // A PDF needs no host payload: the browser renders it from the inline URL,
    // in the node body and in the reader alike.
    canvasDocument.nodes = [
      ...canvasDocument.nodes,
      { id: 'node-pdf', type: 'file', title: 'paper.pdf', x: 0, y: 900, width: 300, height: 170, metadata: { asset: canvasPdfAsset, fileKind: 'pdf', status: 'success' } },
    ]
    ecommerceSwitch.click()
    await new Promise(resolve => setTimeout(resolve, 60))
    canvasSwitch.click()
    await waitForSelector(view, '[data-node-id="node-pdf"] object[type="application/pdf"]')
    const pdfBody = view.querySelector('[data-node-id="node-pdf"] object[type="application/pdf"]')
    assert.match(pdfBody.getAttribute('data'), /\?inline=1$/, 'the node embeds the inline URL')
    view.querySelector('[data-node-id="node-pdf"] [title="放大预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    await waitForSelector(view, '[role="dialog"] object[type="application/pdf"]')
    assert.ok(view.querySelector('[role="dialog"]').textContent.includes('paper.pdf'), 'the reader names the PDF')
    view.querySelector('[role="dialog"] [title="关闭预览"]').dispatchEvent(new jsdomWindow.MouseEvent('click', { bubbles: true }))
    assert.ok(await waitUntil(() => view.querySelector('[role="dialog"]') === null), 'the close button dismisses the reader')
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

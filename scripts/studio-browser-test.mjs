/** Exercise the actual studio + API client in Chromium; only provider responses are fixtures. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.studio-test.cjs`) : require
const { chromium } = runtime('playwright')

function png(width, height) {
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) } return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, b.length - 4)), b.length - 4); return b }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = y * (width * 4 + 1) + 1 + x * 4; pixels[p] = 60 + Math.round(x / width * 140); pixels[p + 1] = 80 + Math.round(y / height * 100); pixels[p + 2] = 120; pixels[p + 3] = 255 }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const bytes = png(640, 480), b64 = bytes.toString('base64'), tasks = [], requests = [], assets = new Map([['source.png', bytes]])
let terminalCap = 100
let canvas = { version: 2, id: 'canvas-one', title: 'Mask test', revision: 1, viewport: { x: 0, y: 0, k: 1 }, background: 'blank', nodes: [{ id: 'source', type: 'image', title: 'Source', x: 80, y: 70, width: 240, height: 180, metadata: { status: 'success', asset: { assetId: 'source.png', url: '/asset/source.png', mime: 'image/png', width: 640, height: 480, bytes: bytes.length, origin: 'upload' } } }], connections: [] }
const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fcfcfd;--dsw-alias-bg-layer-2:#f1f2f6;--dsw-alias-border-l1:#e2e3ea;--dsw-alias-label-primary:#25262a;--dsw-alias-label-secondary:#575b65;--dsw-alias-label-tertiary:#858b98}*{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui,sans-serif}.fixture-controls{height:36px;display:flex;align-items:center;gap:10px;padding:4px 14px;background:#eceef3}.fixture-controls button{font-size:12px}button{font-family:inherit}input,textarea{font:inherit}`
const server = createServer(async (req, res) => {
  if (req.url === '/preview.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(new URL('../.studio-preview/preview.js', import.meta.url))) }
  if (req.url?.startsWith('/asset/')) { res.setHeader('content-type', 'image/png'); return res.end(assets.get(req.url.slice(7)) ?? bytes) }
  if (!req.url?.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/preview.js"></script></html>`) }
  let raw = ''; for await (const part of req) raw += part
  const body = raw ? JSON.parse(raw) : {}, path = req.url
  if (path.endsWith('/tasks/submit')) {
    requests.push(structuredClone(body))
    const task = { id: `task-${tasks.length + 1}`, request: { ...body, channel: body.channelId === 'two' ? 'Provider B' : 'Provider A' }, status: 'running', createdAt: Date.now(), startedAt: Date.now() }
    tasks.unshift(task)
    setTimeout(() => {
      const fail = body.prompt === 'text run' && body.channelId === 'one' && body.model === 'gpt-image-2' && requests.filter(r => r.prompt === body.prompt && r.channelId === body.channelId && r.model === body.model).length === 1
      task.status = fail ? 'failed' : 'completed'; task.error = fail ? 'fixture upstream timeout' : undefined
      if (!fail) task.result = { images: Array.from({ length: body.n }, () => ({ b64, mime: 'image/png', width: 640, height: 480, model: body.model, channel: task.request.channel, durationMs: 1234 })) }
    }, body.mode === 'edit' ? 1900 : 100)
    return json(res, { ok: true, task })
  }
  if (path.endsWith('/tasks/list')) return json(res, { ok: true, tasks: tasks.slice(0, terminalCap).map(({ result, ...task }) => ({ ...task, request: { ...task.request, image: undefined, images: undefined, mask: undefined }, resultAvailable: !!result })) })
  if (path.endsWith('/tasks/get')) { const task = tasks.find(t => t.id === body.id); return json(res, task ? { ok: true, task } : { ok: false, code: 'not-found', message: 'Task no longer exists' }) }
  if (path.endsWith('/history/list') || path.endsWith('/gallery/list')) return json(res, { ok: true, entries: [] })
  if (path.endsWith('/templates/sample')) return json(res, { ok: true, samples: [] })
  if (path.endsWith('/update/check')) return json(res, { ok: true, update: { currentVersion: '1.17.0', latestVersion: '1.17.0', updateAvailable: false } })
  if (path.endsWith('/canvas/list')) return json(res, { ok: true, projects: [{ id: canvas.id, title: canvas.title, revision: canvas.revision, updatedAt: Date.now(), nodeCount: canvas.nodes.length }] })
  if (path.endsWith('/canvas/read')) return json(res, { ok: true, document: canvas })
  if (path.endsWith('/canvas/save')) { canvas = { ...body.document, revision: canvas.revision + 1 }; return json(res, { ok: true, document: canvas }) }
  if (path.endsWith('/canvas/asset/upload')) {
    const data = Buffer.from(body.dataUrl.split(',')[1], 'base64'), assetId = `upload-${assets.size}.png`; assets.set(assetId, data)
    return json(res, { ok: true, asset: { assetId, url: `/asset/${assetId}`, mime: 'image/png', width: body.width, height: body.height, bytes: data.length, origin: body.origin ?? 'upload' } })
  }
  return json(res, { ok: true, entries: [], samples: [], tasks: [], canvases: [], skills: [], available: false, categories: [] })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
if (process.argv.includes('--serve')) { console.log(base); await new Promise(() => {}) }
let browser, lastPage, passed = false
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GENERATION_CHROMIUM_PATH ? { executablePath: process.env.GENERATION_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  lastPage = page
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR:', error.message) })
  page.setDefaultTimeout(15000)
  await page.goto(base)
  const board = () => page.locator('[data-studio-run]'), slots = () => board().locator('[data-studio-slot]')
  const prompt = () => page.locator('textarea').first()
  const waitFor = async (fn, message) => { for (let i = 0; i < 120; i++) { if (await fn()) return; await page.waitForTimeout(100) } assert.fail(message) }
  await prompt().fill('text run')
  await page.getByText('多模型对比', { exact: true }).click()
  const check = (channel, model) => page.locator(`[data-compare-channel="${channel}"] [data-compare-model="${model}"] input`)
  await check('one', 'gpt-image-2').uncheck()
  await check('two', 'gpt-image-2').check()
  await check('one', 'gpt-image-2.5-flare').check()
  await check('one', 'gpt-image-2').check()
  await page.getByRole('button', { name: '开始生成', exact: true }).click()
  await waitFor(async () => await slots().count() === 3 && await slots().locator('[data-result-meta]').count() === 2, 'initial comparison settles with one failed card')
  assert.deepEqual(requests.slice(0, 3).map(r => `${r.channelId}/${r.model}`), ['one/gpt-image-2', 'one/gpt-image-2.5-flare', 'two/gpt-image-2'])
  const ids = await slots().evaluateAll(elements => elements.map(el => el.dataset.studioSlot))
  assert.equal(await slots().first().getAttribute('data-task-status'), 'failed')
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  assert.deepEqual(await slots().evaluateAll(elements => elements.map(el => el.dataset.studioSlot)), ids)
  await page.getByRole('button', { name: 'Remount studio', exact: true }).click()
  await waitFor(async () => await slots().locator('[data-result-meta]').count() === 2, 'completed results rehydrate after remount')
  assert.equal(await slots().first().getAttribute('data-task-status'), 'failed')
  assert.ok((await slots().first().innerText()).includes('fixture upstream timeout'))
  await slots().first().getByRole('button', { name: '重试', exact: true }).click()
  await waitFor(async () => await slots().first().getAttribute('data-task-status') === 'completed', 'retry completes in place')
  assert.deepEqual(await slots().evaluateAll(elements => elements.map(el => el.dataset.studioSlot)), ids)
  assert.equal(requests[3].n, 1)
  assert.deepEqual(await board().locator('[data-image-dimensions]').allTextContents(), ['640 × 480', '640 × 480', '640 × 480'])
  await prompt().fill('do not use this changed prompt')
  await board().getByRole('button', { name: '追加模型', exact: true }).click()
  await board().getByRole('button', { name: '追加生成', exact: true }).click()
  await waitFor(async () => await slots().count() === 4 && await slots().last().getAttribute('data-task-status') === 'completed', 'new model appended')
  assert.deepEqual((await slots().evaluateAll(elements => elements.map(el => el.dataset.studioSlot))).slice(0, 3), ids)
  assert.equal(requests[4].prompt, 'text run')
  terminalCap = 2
  await page.getByRole('button', { name: 'Remount studio', exact: true }).click()
  await waitFor(async () => await board().locator('[data-result-meta]').count() === 4, 'current cards outside the bounded feed recover by task id')
  await page.getByRole('button', { name: '图生图', exact: true }).click()
  assert.equal(await board().count(), 0, 'text results never appear in image editing')
  assert.equal(await page.locator('[data-generation-animation]').count(), 0)
  await page.locator('input[type=file]').first().setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: bytes })
  await page.getByRole('button', { name: '遮罩编辑', exact: true }).click()
  const paint = async () => {
    const area = page.locator('[data-mask-editor] canvas'); await area.waitFor()
    await waitFor(async () => await area.getAttribute('width') === '640', 'mask loads original pixels')
    const rect = await area.boundingBox()
    await page.mouse.move(rect.x + rect.width * .2, rect.y + rect.height * .25); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .4, rect.y + rect.height * .45, { steps: 8 }); await page.mouse.up()
    await page.getByRole('button', { name: '使用遮罩', exact: true }).click()
  }
  await paint()
  await prompt().fill('edit run')
  await page.getByRole('button', { name: '开始生成', exact: true }).click()
  await waitFor(() => requests.some(r => r.mode === 'edit'), 'edit task submitted')
  const editRequest = requests.find(r => r.mode === 'edit')
  assert.ok(editRequest.mask.startsWith('data:image/png;base64,'))
  assert.equal(editRequest.image, `data:image/png;base64,${b64}`)
  await page.getByRole('button', { name: '文生图', exact: true }).click()
  assert.equal(await slots().count(), 4)
  await page.waitForTimeout(3500)
  assert.equal(await slots().count(), 4, 'background edit completion does not replace text board')
  await page.getByRole('button', { name: '图生图', exact: true }).click()
  await waitFor(async () => await slots().first().getAttribute('data-task-status') === 'completed', 'edit completes on its own board')
  await slots().first().getByRole('button', { name: '重新生成', exact: true }).click()
  await waitFor(() => requests.filter(r => r.mode === 'edit').length >= 2, 'masked edit can regenerate')
  assert.equal(requests.at(-1).mask, editRequest.mask)
  assert.equal(requests.at(-1).image, editRequest.image)
  assert.equal(requests.at(-1).n, 1)

  // Fullscreen retains the result actions and opens previews above itself.
  await page.getByRole('button', { name: '全屏对比', exact: true }).click()
  await page.locator('[data-studio-fullscreen] [data-result-open]').first().click()
  const preview = page.getByRole('dialog', { name: '图片预览', exact: true }); await preview.waitFor()
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-studio-fullscreen]').getByRole('button', { name: '关闭', exact: true }).click()

  // Pixel preservation is checked on the real browser canvas, outside the mask.
  const preserved = await page.evaluate(async () => {
    const { compositeMaskedResult } = window.studioRaster
    const make = color => { const c = document.createElement('canvas'); c.width = c.height = 20; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 20, 20); return c }
    const original = make('red'), generated = make('blue'), mask = make('white')
    mask.getContext('2d').clearRect(5, 5, 10, 10)
    const ctx = compositeMaskedResult(generated, original, mask).getContext('2d')
    return { outside: Array.from(ctx.getImageData(0, 0, 1, 1).data), inside: Array.from(ctx.getImageData(10, 10, 1, 1).data) }
  })
  assert.deepEqual(preserved, { outside: [255, 0, 0, 255], inside: [0, 0, 255, 255] })
  await page.getByRole('tab', { name: '无限画布', exact: true }).click()
  const source = page.locator('[data-node-id="source"]'); await source.waitFor()
  await source.hover()
  await source.getByRole('button', { name: '遮罩编辑', exact: true }).click()
  await paint()
  await waitFor(() => !!canvas.nodes.find(node => node.id === 'source')?.metadata?.editMask, 'canvas saves the brush mask')
  await source.click({ position: { x: 100, y: 80 } })
  const canvasPrompt = page.locator('textarea').last(); await canvasPrompt.fill('canvas masked edit'); await canvasPrompt.press('Enter')
  await waitFor(() => requests.some(r => r.prompt === 'canvas masked edit'), 'canvas submits masked edit')
  assert.ok(requests.find(r => r.prompt === 'canvas masked edit').mask)
  await waitFor(() => canvas.nodes.some(node => node.metadata?.maskEdit && node.metadata.status === 'success'), 'canvas composites and saves masked result')
  await page.getByRole('tab', { name: '普通生图', exact: true }).click()
  mkdirSync('/tmp/dsh-117-qa', { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(800); await page.screenshot({ path: '/tmp/dsh-117-qa/studio-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 }); await board().scrollIntoViewIfNeeded(); assert.ok((await board().boundingBox()).width <= 390); await page.screenshot({ path: '/tmp/dsh-117-qa/studio-mobile.png' })
  assert.deepEqual(errors, [])
  await page.evaluate(() => { const runs = JSON.parse(sessionStorage.getItem('dsh-imagegen:studio-runs:v1')); runs.text.slots[0].taskId = 'lost-task'; runs.text.slots[0].status = 'running'; runs.text.sourceTaskId = 'lost-task'; sessionStorage.setItem('dsh-imagegen:studio-runs:v1', JSON.stringify(runs)) })
  await page.getByRole('button', { name: 'Remount studio', exact: true }).click()
  await waitFor(async () => await slots().first().getAttribute('data-task-status') === 'failed', 'host-lost tasks leave a failed card rather than spinning forever')
  assert.equal(await slots().first().locator('[data-generation-animation]').count(), 0)
  passed = true
  console.log('PASS actual studio: channel ordering, failed-card retention across hide/remount, in-place retry, append using original parameters, actual pixels, text/edit isolation during background completion, native mask upload/retry, canvas mask persistence and exact outside-pixel preservation; desktop/mobile')
} finally { if (!passed && lastPage) { mkdirSync('/tmp/dsh-117-qa', { recursive: true }); await lastPage.screenshot({ path: '/tmp/dsh-117-qa/failure.png' }).catch(() => {}); console.error((await lastPage.locator('body').innerText()).slice(0, 3500)) }; await browser?.close(); await new Promise(resolve => server.close(resolve)) }

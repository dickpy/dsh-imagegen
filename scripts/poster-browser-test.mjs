/** Run after: pnpm exec tsdown --config scripts/poster-preview.config.ts
 * Uses Playwright from the primary runtime (or normal module resolution).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runtimeRequire = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.poster-test.cjs`) : require
const { chromium } = runtimeRequire('playwright')
const sharp = runtimeRequire('sharp')
const sourceId = `${'a'.repeat(64)}.png`
const source = await sharp({ create: { width: 1000, height: 700, channels: 4, background: '#17365d' } }).png().toBuffer()
const logo = await sharp({ create: { width: 120, height: 60, channels: 4, background: '#ff0000' } }).png().toBuffer()
// The poster editor is themed through the host's dsh tokens; this fixture page
// stands in for the host, so it has to declare the same minimum set the other
// browser fixtures use (see references-browser-test.mjs).
const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fbfbfd;--dsw-alias-bg-layer-2:#f2f2f6;--dsw-alias-border-l1:#e4e4e7;--dsw-alias-border-l2:#d9d9df;--dsw-alias-label-primary:#25262a;--dsw-alias-label-secondary:#5e6069;--dsw-alias-label-tertiary:#8a8c96;--dsw-alias-brand-primary:#26262b;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-interactive-bg-hover:#f0f0f2;--dsw-alias-state-error-primary:#b33535}*{box-sizing:border-box}html,body,#root{margin:0;height:100%;font:14px system-ui,sans-serif}`
const assets = new Map([[sourceId, source]])
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/preview.js"></script></body></html>`)
    return
  }
  if (req.url === '/preview.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(new URL('../.poster-preview/preview.js', import.meta.url))); return }
  if (req.url === '/upload') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const data = Buffer.from(payload.dataUrl.split(',')[1], 'base64')
    const assetId = `${createHash('sha256').update(data).digest('hex')}.png`
    assets.set(assetId, data)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ assetId, url: `/api/dsh-imagegen/canvas/asset/${assetId}`, mime: 'image/png', bytes: data.length, width: payload.width, height: payload.height, origin: 'upload' })); return
  }
  const data = assets.get(req.url?.split('/').pop())
  if (data) { res.setHeader('content-type', 'image/png'); res.end(data); return }
  res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  let options = { headless: true, ...(process.env.POSTER_CHROMIUM_PATH ? { executablePath: process.env.POSTER_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {}) }
  if (process.env.POSTER_CHROMIUM_MODULE) {
    const module = require(process.env.POSTER_CHROMIUM_MODULE)
    const bundled = module.default ?? module
    options = { ...options, executablePath: await bundled.executablePath(), args: bundled.args }
  }
  browser = await chromium.launch(options)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER ERROR', error.message) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const dialog = page.getByRole('dialog', { name: '海报编辑：文字 / Logo' })
  await page.getByRole('button', { name: '保存到画布', exact: true }).waitFor()
  await page.getByRole('button', { name: '添加文字', exact: true }).click()
  await page.getByLabel('文字内容', { exact: true }).fill('Summer Sale ¥169\n新品上市')
  await page.getByLabel('文字颜色', { exact: true }).fill('#ffffff')
  await page.getByLabel('字号（像素）', { exact: true }).fill('64')
  await page.getByRole('button', { name: '上传 Logo', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo })
  await page.getByLabel('X', { exact: true }).fill('700')
  await page.getByLabel('Y', { exact: true }).fill('500')
  const logoHandle = page.getByRole('button', { name: 'Logo 图层', exact: true }).first()
  const box = await logoHandle.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 - 20, { steps: 5 }); await page.mouse.up()
  const movedX = Number(await page.getByLabel('X', { exact: true }).inputValue())
  assert.ok(movedX < 700, 'pointer dragging changes output-pixel coordinates')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await page.getByLabel('X', { exact: true }).inputValue(), '700', 'undo restores a whole drag, not one pointer step')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.equal(Number(await page.getByLabel('X', { exact: true }).inputValue()), movedX)
  const previewData = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click()
  const download = await downloadPromise
  const output = readFileSync(await download.path())
  assert.deepEqual(output, Buffer.from(previewData.split(',')[1], 'base64'), 'PNG export exactly matches the actual preview canvas')
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 1000); assert.equal(info.height, 700)
  assert.deepEqual([...data.subarray(0, 4)], [23, 54, 93, 255], 'untouched original corner pixels survive')
  await page.getByRole('button', { name: '保存到画布', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const saved = JSON.parse(await page.locator('[data-saved]').textContent())
  assert.equal(saved.layers.length, 2); assert.equal(saved.layers[0].text, 'Summer Sale ¥169\n新品上市'); assert.equal(saved.layers[1].x, movedX)
  await page.reload()
  await page.getByRole('button', { name: 'Summer Sale ¥169 新品上市', exact: true }).last().click()
  assert.equal(await page.getByLabel('文字内容', { exact: true }).inputValue(), 'Summer Sale ¥169\n新品上市', 'saved recipe reopens after full reload')
  await page.getByLabel('文字内容', { exact: true }).fill('Different title')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await page.getByLabel('文字内容', { exact: true }).inputValue(), 'Different title')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await page.getByRole('button', { name: 'Reopen', exact: true }).click()
  await page.getByRole('button', { name: 'Summer Sale ¥169 新品上市', exact: true }).last().click()
  assert.equal(await page.getByLabel('文字内容', { exact: true }).inputValue(), 'Summer Sale ¥169\n新品上市')
  mkdirSync(new URL('../.poster-preview', import.meta.url), { recursive: true })
  await page.screenshot({ path: new URL('../.poster-preview/desktop.png', import.meta.url).pathname })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: new URL('../.poster-preview/mobile.png', import.meta.url).pathname })
  assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().width <= 390), 'mobile dialog stays in viewport')
  assert.deepEqual(errors, [], 'no browser exceptions')
  console.log('PASS real Chromium: editable text, logo upload, pointer drag, undo/redo, exact PNG pixels, source preservation, save/reload, discard, mobile layout')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

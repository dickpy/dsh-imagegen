/** Real Chromium layout checks for the shared duration badge and studio CSS. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.duration-test.cjs`) : require
const { chromium } = runtime('playwright')
const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fcfcfd;--dsw-alias-bg-layer-2:#f3f3f6;--dsw-alias-border-l1:#e9e9ee;--dsw-alias-label-primary:#25262a;--dsw-alias-label-secondary:#575b65;--dsw-alias-label-tertiary:#858b98}.fixture[data-dark=true]{--dsw-alias-bg-base:#17191f;--dsw-alias-bg-layer-1:#1b1e26;--dsw-alias-bg-layer-2:#252932;--dsw-alias-border-l1:#343844;--dsw-alias-label-primary:#e8ebf2;--dsw-alias-label-secondary:#d0d5e2;--dsw-alias-label-tertiary:#a0a9bc}*{box-sizing:border-box}html,body,#root{margin:0;height:100%;font-family:system-ui,sans-serif}.fixture{height:100%;display:flex;flex-direction:column;gap:14px;padding:18px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px}select{max-width:110px;padding:4px}main{flex:1;min-height:0}label{display:flex;align-items:center}`
const server = createServer((req, res) => {
  if (req.url === '/generation.js' || req.url === '/result.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(readFileSync(new URL(req.url === '/generation.js' ? '../.generation-preview/preview.js' : '../.result-preview/preview.js', import.meta.url)))
  } else if (req.url.startsWith('/sample/')) {
    res.setHeader('content-type', 'image/svg+xml')
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"><rect width="100%" height="100%" fill="#d6dfd0"/><circle cx="300" cy="350" r="160" fill="#73836a"/></svg>')
  } else {
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/${req.url === '/result' ? 'result' : 'generation'}.js"></script></html>`)
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
if (process.argv.includes('--serve')) {
  console.log(`Duration preview: http://127.0.0.1:${server.address().port}`)
  await new Promise(() => {})
}
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GENERATION_CHROMIUM_PATH ? {
    executablePath: process.env.GENERATION_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  } : {}) })
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  const badges = () => page.locator('[data-generation-duration]')
  const checkLayout = async () => {
    assert.equal(await badges().evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect()
      const style = getComputedStyle(element)
      return box.width > 20 && box.height > 10 && box.left >= parent.left && box.right <= parent.right
        && Math.abs(parent.right - box.right - 8) <= 2 && Math.abs(parent.bottom - box.bottom - 8) <= 2
        && style.opacity === '1' && style.pointerEvents === 'none'
    })), true, 'badges stay visible in the bottom-right corner and allow image clicks')
  }
  await page.goto(base)
  await page.getByLabel('对比模型数', { exact: true }).selectOption('4')
  for (const mode of ['文生图', '图生图']) {
    await page.getByLabel('模式', { exact: true }).selectOption(mode)
    for (const viewport of [{ width: 1000, height: 820 }, { width: 390, height: 780 }, { width: 800, height: 360 }]) {
      await page.setViewportSize(viewport)
      for (const state of ['running', 'failed', 'cancelled']) {
        await page.getByLabel('状态', { exact: true }).selectOption(state)
        assert.equal(await badges().count(), 0, `${state}: no invented completion time`)
      }
      await page.getByLabel('状态', { exact: true }).selectOption('mixed')
      assert.deepEqual(await badges().allTextContents(), ['耗时 1分2秒'])
      await checkLayout()
      await page.getByLabel('状态', { exact: true }).selectOption('completed')
      assert.deepEqual(await badges().allTextContents(), ['耗时 1分2秒', '耗时 2分5秒', '耗时 0分0秒'])
      assert.equal(await page.locator('[data-comparison-task="model-3"] [data-generation-duration]').count(), 0, 'old records have no badge')
      await checkLayout()
      await page.getByLabel('深色', { exact: true }).check()
      await checkLayout()
      await page.getByLabel('深色', { exact: true }).uncheck()
    }
  }
  await page.setViewportSize({ width: 640, height: 820 })
  if (process.env.DURATION_SCREENSHOT) await page.screenshot({ path: process.env.DURATION_SCREENSHOT })

  await page.goto(`${base}/result`)
  await page.getByLabel('图片数量', { exact: true }).selectOption('4')
  for (const mode of ['文生图', '图生图']) {
    await page.getByLabel('模式', { exact: true }).selectOption(mode)
    for (const viewport of [{ width: 1000, height: 820 }, { width: 390, height: 780 }]) {
      await page.setViewportSize(viewport)
      for (const direction of ['0', '1', '2']) {
        await page.getByLabel('图片方向', { exact: true }).selectOption(direction)
        assert.deepEqual(await badges().allTextContents(), ['耗时 1分2秒', '耗时 2分5秒', '耗时 0分0秒'])
        await checkLayout()
      }
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS generation durations: fixed independent clocks, missing/zero timing, text/edit, comparison/result cards, desktop/mobile/short layouts and dark mode')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

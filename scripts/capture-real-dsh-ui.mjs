/** Capture the published plugin inside the real, unmodified DSH Web host. */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.real-dsh-ui.cjs`)
const { chromium } = require('playwright')
const output = '.test-artifacts/real-dsh-ui'
mkdirSync(output, { recursive: true })
let host, browser, page, log = ''
const errors = []
try {
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const timer = setTimeout(() => readyReject(new Error('Real DSH did not become ready')), 90000)
  host = spawn(process.env.DSH_UI_BINARY, ['web', '--no-open', '--port', '3067'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const read = chunk => {
    log += chunk.toString()
    const match = /dsh web: (https?:\/\/\S+)/.exec(log)
    if (match) readyResolve(match[1])
  }
  host.stdout.on('data', read); host.stderr.on('data', read)
  host.on('exit', code => readyReject(new Error(`DSH exited: ${code}`)))
  host.on('error', readyReject)
  let url
  try { url = await ready } finally { clearTimeout(timer) }
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', colorScheme: 'light', deviceScaleFactor: 1 })
  page = await context.newPage()
  page.setDefaultTimeout(45000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-dsh-imagegen-tab="image"]').waitFor({ state: 'attached', timeout: 90000 })
  // The official first-run preview notice is a presentation surface, not a dialog.
  const previewNotice = page.getByText('预览版说明', { exact: true })
  await previewNotice.waitFor({ state: 'visible', timeout: 15000 })
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await previewNotice.waitFor({ state: 'hidden' })
  for (const label of ['我知道了', '关闭', 'Got it', 'Close', 'Dismiss']) {
    const dismiss = page.getByRole('dialog').getByRole('button', { name: label, exact: true })
    if (await dismiss.count() === 1 && await dismiss.isVisible()) await dismiss.click()
  }
  await page.screenshot({ path: `${output}/00-real-dsh-shell.png`, fullPage: true })
  await page.locator('[data-dsh-imagegen-tab="image"]').click()
  await page.locator('[data-studio-actions]').waitFor()
  await page.getByRole('button', { name: /^(图生图|Image to Image)$/ }).click()
  await page.locator('[data-edit-references] input[type="file"]').setInputFiles([process.env.DSH_UI_FOREST_IMAGE, process.env.DSH_UI_LAKE_IMAGE])
  await page.waitForFunction(() => document.querySelectorAll('[data-edit-reference]').length === 2 && !document.querySelector('[data-reference-reverse]')?.disabled)
  await page.locator('[data-edit-references]').scrollIntoViewIfNeeded()
  await page.mouse.move(1400, 70)
  await page.screenshot({ path: `${output}/01-real-dsh-references.png`, fullPage: true })

  // The gallery accepts local photos without a generation provider or model key.
  // Its native preview opens the existing configurable reverse-prompt dialog.
  await page.locator('[data-studio-gallery]').click()
  await page.locator('[class*="galleryToolbarActions"] input[type="file"]').setInputFiles(process.env.DSH_UI_FOREST_IMAGE)
  const photo = page.locator('[class*="galleryImageButton"]').first()
  await photo.waitFor()
  await photo.click()
  await page.locator('[class*="lightbox"] [data-reverse-prompt]').click()
  await page.locator('[data-reverse-dialog]').waitFor()
  await page.mouse.move(1400, 70)
  await page.screenshot({ path: `${output}/02-real-dsh-reverse-dialog.png`, fullPage: true })
  writeFileSync(`${output}/capture.json`, JSON.stringify({ host: '@deepseek-ai/dsh@0.2.2-rc.1', plugin: '@dickpy/dsh-imagegen@1.17.2', screenshotType: 'Actual installed DSH Web; no replaced components, page styles, DOM text or API responses', providerCalls: 0, errors }, null, 2))
  console.log('Captured real DSH Web with the published v1.17.2 plugin, actual photographs, native host controls and reverse prompt dialog; no fixture responses or model calls.')
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${output}/capture-failed.png`, fullPage: true }).catch(() => {})
    writeFileSync(`${output}/capture-failed.txt`, await page.locator('body').innerText().catch(() => 'No page text'))
  }
  throw error
} finally {
  writeFileSync(`${output}/dsh-startup.log`, log.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'))
  await browser?.close()
  host?.kill('SIGTERM')
}

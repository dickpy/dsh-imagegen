/** #76 through actual Chromium, including CSS geometry and existing result reverse. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startReverseFixture, referencePng } from './reference-reverse-fixture.mjs'
const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.reference-reverse-test.cjs`) : require
const { chromium } = runtime('playwright')
const fixture = await startReverseFixture(), evidence = '.test-artifacts/reference-reverse'
mkdirSync(evidence, { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GENERATION_CHROMIUM_PATH ? { executablePath: process.env.GENERATION_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], geometry = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(10000)
  const waitFor = async (predicate, label) => { for (let i = 0; i < 80; i++) { if (await predicate()) return; await page.waitForTimeout(50) } assert.fail(label) }
  const prompt = () => page.locator('textarea').first()
  const references = () => page.locator('[data-edit-reference]')
  const reverse = () => page.locator('[data-reference-reverse]')
  const toolbar = () => page.locator('[data-studio-actions]')
  await page.goto(`${fixture.base}/?reverse`)
  await page.locator('[data-studio-reverse]').click()
  await page.locator('[data-edit-references]').waitFor()
  assert.equal(await reverse().isDisabled(), true)
  await page.locator('[data-edit-references] input[type=file]').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: referencePng })
  await waitFor(async () => await references().count() === 1 && await reverse().isEnabled(), 'reference upload is ready')
  await reverse().click()
  await waitFor(async () => await prompt().inputValue() === 'Reusable prompt from first.png', 'one click auto-fills the prompt')
  assert.equal(await page.locator('[data-reverse-dialog]').count(), 0)
  assert.equal(fixture.reversals.length, 1)
  assert.deepEqual(fixture.uploads[0].bytes, referencePng)
  assert.equal(fixture.generations.length, 0)

  // Keyboard paste uses the same uploader and keeps the selected target explicit.
  await page.locator('[data-edit-references]').evaluate((element, b64) => {
    const transfer = new DataTransfer(), bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0))
    transfer.items.add(new File([bytes], 'second.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, referencePng.toString('base64'))
  await waitFor(async () => await references().count() === 2 && await reverse().isEnabled(), 'pasted reference is ready')
  await page.getByRole('button', { name: '选择要反推的参考图', exact: true }).click()
  await page.getByRole('option', { name: '2 · second.png', exact: true }).click()
  await page.locator('[data-studio-reverse]').click()
  await waitFor(async () => await prompt().inputValue() === 'Reusable prompt from second.png', 'toolbar reverses the selected reference')
  assert.equal(fixture.reversals.at(-1).images[0].name, 'second.png')

  const measure = async label => {
    await toolbar().scrollIntoViewIfNeeded()
    const result = await toolbar().evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, buttons: [...element.querySelectorAll('button')].map(button => {
        const b = button.getBoundingClientRect(), style = getComputedStyle(button), icon = button.querySelector('svg')?.getBoundingClientRect()
        return { text: button.textContent, height: b.height, radius: style.borderRadius, font: style.fontSize, background: style.backgroundColor, icon: icon?.width, fits: b.left >= rect.left - 1 && b.right <= rect.right + 1 && button.scrollWidth <= button.clientWidth + 1 }
      }) }
    })
    assert.equal(result.buttons.length, 3)
    for (const button of result.buttons) { assert.equal(button.fits, true, `${label}: ${JSON.stringify(button)}`); assert.equal(button.icon, 14); assert.ok(button.height >= 32) }
    assert.equal(new Set(result.buttons.map(button => button.radius)).size, 1)
    assert.equal(new Set(result.buttons.map(button => button.font)).size, 1)
    assert.equal(new Set(result.buttons.map(button => button.background)).size, 1)
    geometry.push({ label, ...result })
  }
  await measure('desktop')
  const before = await toolbar().boundingBox()
  await page.locator('[class*=configScroll]').evaluate(element => { element.scrollTop = element.scrollHeight })
  const after = await toolbar().boundingBox()
  assert.ok(Math.abs(before.y - after.y) < 1, 'toolbar stays fixed while the parameter cards scroll')
  await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true })
  await page.locator('[data-template-library-trigger]').click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-studio-gallery]').click()
  await waitFor(async () => await page.locator('[data-studio-gallery]').getAttribute('aria-pressed') === 'true', 'asset library shortcut opens gallery')
  await page.locator('[data-studio-reverse]').click()
  await waitFor(async () => await prompt().inputValue() === 'Reusable prompt from second.png' && await page.locator('[data-reverse-dialog]').count() === 0, 'gallery shortcut reverses retained reference and returns to edit')

  await prompt().fill('Keep my edits')
  fixture.control.fail = true
  await reverse().click()
  await page.locator('[data-reverse-dialog] [role=alert]').waitFor()
  assert.equal(await prompt().inputValue(), 'Keep my edits')
  assert.equal(await references().count(), 2)
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true })
  fixture.control.fail = false
  await page.locator('[data-reverse-run]').click()
  await waitFor(async () => await page.locator('[data-reverse-dialog]').count() === 0, 'retry fills and closes')
  fixture.control.delay = 250
  await prompt().fill('Keep after Escape')
  const previous = fixture.reversals.length
  await reverse().click()
  await waitFor(() => fixture.reversals.length === previous + 1, 'vision is pending')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
  assert.equal(await prompt().inputValue(), 'Keep after Escape')
  assert.equal(await page.locator('[data-reverse-dialog]').count(), 0)
  fixture.control.delay = 0
  assert.equal(fixture.generations.length, 0)

  // The resizable minimum column and a narrow viewport must keep every action usable.
  await page.evaluate(() => localStorage.setItem('dsh-imagegen:config-width', '260'))
  await page.reload()
  await measure('260px-column')
  await page.setViewportSize({ width: 390, height: 844 })
  await measure('390px-mobile')
  await page.screenshot({ path: `${evidence}/mobile.png`, fullPage: true })
  await page.close()

  // Existing generated-image reverse remains configurable and requires explicit Use.
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    sessionStorage.setItem('dsh-imagegen:studio-runs:v1', JSON.stringify({ text: { id: 'source-run', mode: 'text', prompt: 'Existing result', sourceTaskId: 'source', slots: [{ id: 'source:0', taskId: 'source', imageIndex: 0, model: 'gpt-image-2', channelId: 'one', status: 'completed' }] }, edit: null }))
  })
  await page.goto(`${fixture.base}/?reverse`)
  await page.locator('[data-studio-slot] [data-reverse-prompt]').click()
  await page.locator('[data-reverse-dialog]').waitFor()
  const calls = fixture.reversals.length
  await page.waitForTimeout(150)
  assert.equal(fixture.reversals.length, calls, 'generated-image entry does not auto-run')
  await page.locator('#dsh-imagegen-reverse-detail').selectOption('detailed')
  await page.locator('#dsh-imagegen-reverse-output').selectOption('en')
  await page.locator('[data-reverse-run]').click()
  await waitFor(async () => (await page.locator('[data-reverse-result]').inputValue()).startsWith('Reusable prompt from '), 'manual reverse returns a prompt')
  assert.equal(fixture.reversals.at(-1).detail, 'detailed')
  assert.equal(fixture.reversals.at(-1).output, 'en')
  await page.getByRole('dialog').getByRole('button', { name: '填入提示词', exact: true }).click()
  await waitFor(async () => await page.locator('[data-reverse-dialog]').count() === 0, 'explicit Use closes the existing result flow')
  assert.ok((await prompt().inputValue()).startsWith('Reusable prompt from '))
  assert.deepEqual(errors, [])
  writeFileSync(`${evidence}/geometry.json`, JSON.stringify(geometry, null, 2))
  console.log('PASS #76 Chromium: upload/paste, selected-reference auto-fill, no generation, failure/retry/Escape, template/gallery shortcuts, fixed toolbar, minimum column/mobile geometry, and existing configurable result reverse')
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `${evidence}/failed.png`, fullPage: true }).catch(() => {})
  throw error
} finally { await browser?.close(); await new Promise(resolve => fixture.server.close(resolve)) }

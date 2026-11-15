/** Browser regression: inline workspace, manual run/apply, themes and responsive layout. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startReverseFixture, referencePng } from './reference-reverse-fixture.mjs'
const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.reverse-test.cjs`) : require
const { chromium } = runtime('playwright')
const fixture = await startReverseFixture(), evidence = '.test-artifacts/reference-reverse'
mkdirSync(evidence, { recursive: true })
if (process.argv.includes('--serve')) { console.log(fixture.base); await new Promise(() => {}) }
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GENERATION_CHROMIUM_PATH ? { executablePath: process.env.GENERATION_CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${fixture.base}/?reverse`)
  await page.getByRole('button', { name: '反推提示词', exact: true }).click()
  await page.locator('[data-reverse-upload]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: referencePng })
  await page.locator('[data-reverse-source]').waitFor()
  assert.equal(fixture.reversals.length, 0)
  await page.locator('[data-reverse-detail]').selectOption('detailed')
  await page.locator('[data-reverse-output]').selectOption('en')
  await page.locator('[data-reverse-extra]').fill('Focus on composition and lighting')
  await page.locator('[data-reverse-run]').click()
  await page.waitForFunction(() => document.querySelector('[data-reverse-result]').value.includes('reference.png'))
  assert.equal(fixture.reversals[0].detail, 'detailed'); assert.equal(fixture.reversals[0].output, 'en')
  assert.equal(fixture.reversals[0].instruction, 'Focus on composition and lighting')
  assert.equal(await page.locator('[data-reverse-dialog]').count(), 0)
  await page.locator('[data-reverse-result]').fill('Reviewed prompt')
  await page.screenshot({ path: `${evidence}/light.png`, fullPage: true })
  await page.addStyleTag({ content: ':root{color-scheme:dark;--dsw-alias-bg-base:#141414;--dsw-alias-bg-layer-1:#1c1c1f;--dsw-alias-bg-layer-2:#28282b;--dsw-alias-bg-layer-3:#323235;--dsw-alias-border-l1:#37373c;--dsw-alias-border-l2:#4b4b53;--dsw-alias-label-primary:#f4f4f5;--dsw-alias-label-secondary:#b4b4bd;--dsw-alias-label-tertiary:#9696a0;--dsw-alias-brand-primary:#f8fafc}body{background:#141414}' })
  const contrast = async selector => {
    const colors = await page.locator(selector).evaluate(element => { const s = getComputedStyle(element); return [s.color, s.backgroundColor] })
    const luminance = color => { const c = color.match(/[\d.]+/g).slice(0,3).map(Number).map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4 }); return c[0]*.2126+c[1]*.7152+c[2]*.0722 }
    const [a,b] = colors.map(luminance); assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5, JSON.stringify(colors))
  }
  await contrast('[data-reverse-run]'); await contrast('[data-reverse-use]')
  await page.screenshot({ path: `${evidence}/dark.png`, fullPage: true })
  await page.locator('[data-reverse-use]').click()
  await page.waitForFunction(() => document.querySelector('[data-workspace=normal]'))
  assert.equal(await page.locator('textarea').first().inputValue(), 'Reviewed prompt')
  await contrast('[class*=generateButton]')
  await page.screenshot({ path: `${evidence}/dark-generation.png`, fullPage: true })
  await page.getByRole('button', { name: '反推提示词', exact: true }).click()
  assert.equal(await page.locator('[data-reverse-result]').inputValue(), 'Reviewed prompt')
  fixture.control.delay = 250
  await page.locator('[data-reverse-run]').click()
  await page.waitForFunction(() => document.querySelector('[data-reverse-run]').disabled)
  await page.locator('[data-reverse-upload]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: referencePng })
  await page.waitForTimeout(350)
  assert.equal(await page.locator('[data-reverse-result]').inputValue(), '', 'old response cannot replace the newly selected source')
  await page.setViewportSize({ width: 760, height: 900 })
  await page.screenshot({ path: `${evidence}/narrow.png`, fullPage: true })
  assert.ok(await page.locator('[data-reverse-workspace]').evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  assert.equal(fixture.generations.length, 0); assert.deepEqual(errors, [])
  console.log('PASS browser: manual run/apply, parameters, editable retained result, stale response isolation, light/dark contrast >=4.5, and narrow layout')
} finally { await browser?.close(); await new Promise(resolve => fixture.server.close(resolve)) }

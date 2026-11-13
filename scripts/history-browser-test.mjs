/** Actual React panel, history API client and sidebar mount in Chromium. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startHistoryFixture } from './history-fixture.mjs'
const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.history-test.cjs`) : require
const { chromium } = runtime('playwright')

const { server, base, assets, entries, task, delays, settingsMutations } = await startHistoryFixture()
if (process.argv.includes('--serve')) {
  delays.set('text-a', 700)
  console.log(base)
  await new Promise(() => {})
}
let browser, page
try {
  browser = await chromium.launch({ headless: true, ...(process.env.GENERATION_CHROMIUM_PATH ? { executablePath: process.env.GENERATION_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fixture-seeded')) return
    sessionStorage.setItem('fixture-seeded', 'true')
    sessionStorage.setItem('dsh-imagegen:studio-runs:v1', JSON.stringify({ text: { id: 'live-run', mode: 'text', prompt: 'Latest live task', sourceTaskId: 'live', slots: [{ id: 'live:0', taskId: 'live', imageIndex: 0, model: 'gpt-image-2', channelId: 'one', status: 'completed' }] }, edit: null }))
  })
  await page.goto(base)
  const row = id => page.locator('[data-dsh-imagegen-history-main]').filter({ hasText: `History ${id}` })
  const resultImages = () => page.locator('[data-result-preview-grid] img')
  const expectImage = async id => {
    await page.waitForFunction(b64 => [...document.querySelectorAll('[data-result-preview-grid] img')].some(image => image.src.endsWith(b64)), assets[id].toString('base64'))
    assert.equal(await resultImages().count(), 1)
  }
  await expectImage('live')

  // #75: use real flex and container-query geometry, not DOM shape alone.
  for (const width of [260, 220]) {
    await page.locator('.host_sidebarCol').evaluate((element, value) => { element.style.width = `${value}px` }, width)
    const geometry = await page.evaluate(() => {
      const tabs = document.querySelector('[data-dsh-imagegen-session-tabs]'), row = document.querySelector('.host_newSessionRow'), button = document.querySelector('.host_newSession')
      return { directChild: tabs.parentElement.classList.contains('host_root'), above: tabs.getBoundingClientRect().bottom <= row.getBoundingClientRect().top, width: button.getBoundingClientRect().width, contentWidth: button.firstElementChild.getBoundingClientRect().width }
    })
    assert.equal(geometry.directChild, true)
    assert.equal(geometry.above, true)
    assert.ok(geometry.width >= width - 60, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.width - geometry.contentWidth) < 6)
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).click()
  assert.equal(await page.evaluate(() => window.nativeSessions), 1)
  await page.evaluate(() => {
    const row = document.querySelector('.host_newSessionRow'), wrapper = document.createElement('section')
    row.before(wrapper); wrapper.append(row)
  })
  await page.waitForFunction(() => document.querySelector('[data-dsh-imagegen-session-tabs]').nextElementSibling?.tagName === 'SECTION')
  await page.waitForTimeout(50)
  assert.equal(await page.locator('[data-dsh-imagegen-session-tabs]').count(), 1, 'observer repair stays idempotent')
  await page.locator('.host_sidebarCol').evaluate(element => { element.style.width = '260px' })

  // #72: clear a live board before hydrating a selected history record.
  delays.set('text-a', 550)
  await row('text-a').click()
  await page.locator('[data-history-loading]').waitFor()
  assert.equal(await page.locator('[data-studio-run]').count(), 0)
  assert.equal(await resultImages().count(), 0, 'old task images never wear the new selection highlight')
  await expectImage('text-a')
  const time = await row('text-a').locator('[data-history-started-at]').getAttribute('datetime')
  assert.equal(time, new Date(entries[0].createdAt).toISOString())
  assert.match(await row('text-a').innerText(), /2026-11-13/)

  // An older request completing last must not replace the latest selection.
  await row('text-a').click()
  await page.locator('[data-history-loading]').waitFor()
  await row('text-b').click()
  await expectImage('text-b')
  await page.waitForTimeout(650)
  await expectImage('text-b')
  assert.equal(await row('text-b').getAttribute('aria-current'), 'true')

  // Text/edit selection and images stay independent, including after restart.
  await row('edit').click()
  await expectImage('edit')
  await page.getByRole('button', { name: '文生图', exact: true }).click()
  await expectImage('text-b')
  assert.equal(await row('text-b').getAttribute('aria-current'), 'true')
  await page.getByRole('button', { name: '图生图', exact: true }).click()
  await expectImage('edit')
  await page.evaluate(() => {
    sessionStorage.removeItem('dsh-imagegen:studio-runs:v1')
  })
  await page.reload()
  await expectImage('edit')
  assert.equal(await row('edit').getAttribute('aria-current'), 'true')
  await page.getByRole('button', { name: '文生图', exact: true }).click()
  await expectImage('text-b')
  const saved = await page.evaluate(() => localStorage.getItem('dsh-imagegen:history-selection:v1'))
  assert.deepEqual(JSON.parse(saved).ids, { text: 'text-b', edit: 'edit' })
  assert.ok(!saved.includes('base64') && !saved.includes('History '))

  // Superseding a pending load in another mode remains recoverable.
  await row('text-a').click()
  await page.locator('[data-history-loading]').waitFor()
  await row('edit').click()
  await expectImage('edit')
  await page.getByRole('button', { name: '文生图', exact: true }).click()
  await expectImage('text-a')

  await row('missing').click()
  await page.getByRole('alert').waitFor()
  assert.equal(await resultImages().count(), 0, 'a failed history read never falls back to another task image')
  await row('text-a').click()
  await page.locator('[data-history-loading]').waitFor()
  await page.locator('[data-history-new]').click()
  await page.waitForTimeout(650)
  assert.equal(await resultImages().count(), 0, 'new creation invalidates the pending history load')
  assert.equal(await page.locator('[data-dsh-imagegen-history-main][aria-current=true]').count(), 0)
  assert.deepEqual(errors, [])
  mkdirSync(new URL('../.test-artifacts', import.meta.url), { recursive: true })
  await row('text-b').click()
  await expectImage('text-b')
  await page.screenshot({ path: new URL('../.test-artifacts/history-sidebar.png', import.meta.url).pathname })
  console.log('PASS history/sidebar Chromium: independent mode results, exact selection, async races, restart, load failure, reset, timestamps, DSH 0.2.2 flex geometry and wrapper repair')

  // #73: exercise the actual settings controller, staging and HTTP save path.
  await page.goto(`${base}/?settings`)
  await page.getByRole('button', { name: /SenseNova relay/ }).click()
  let dialog = page.getByRole('dialog', { name: '渠道 · SenseNova relay', exact: true })
  await dialog.waitFor()
  const hint = await dialog.locator('[data-watermark-hint]').innerText()
  assert.ok(hint.includes('SenseNova image') && !hint.includes('GPT fallback'))
  await dialog.getByLabel('图片添加「AI 生成」水印', { exact: true }).uncheck()
  await dialog.getByLabel('上游自动优化提示词', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const save = page.waitForResponse(response => response.url().endsWith('/settings/mutate'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await save
  const written = settingsMutations.flatMap(batch => batch.ops ?? []).find(op => op.path[0] === 'channels')?.value
  assert.equal(written.find(channel => channel.id === 'sense').watermark, false)
  assert.equal(written.find(channel => channel.id === 'sense').promptExtend, false)
  await page.reload()
  await page.getByRole('button', { name: /SenseNova relay/ }).click()
  dialog = page.getByRole('dialog', { name: '渠道 · SenseNova relay', exact: true })
  assert.equal(await dialog.getByLabel('图片添加「AI 生成」水印', { exact: true }).isChecked(), false)
  assert.equal(await dialog.getByLabel('上游自动优化提示词', { exact: true }).isChecked(), false)
  await page.screenshot({ path: new URL('../.test-artifacts/sensenova-settings.png', import.meta.url).pathname })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /OpenAI channel/ }).click()
  dialog = page.getByRole('dialog', { name: '渠道 · OpenAI channel', exact: true })
  assert.equal(await dialog.locator('[data-watermark-hint]').count(), 0, 'unrelated models do not advertise unsupported switches')
  assert.deepEqual(errors, [])
  console.log('PASS channel settings Chromium: capability-aware hints, SenseNova switches, saved HTTP payload, reload persistence and unrelated model isolation')
} catch (error) {
  if (page) { mkdirSync(new URL('../.test-artifacts', import.meta.url), { recursive: true }); await page.screenshot({ path: new URL('../.test-artifacts/history-failure.png', import.meta.url).pathname }) }
  throw error
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

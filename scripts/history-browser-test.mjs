/** Actual React panel, history API client and sidebar mount in Chromium. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { addPaginatedHistory, startHistoryFixture } from './history-fixture.mjs'
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

  // #79: the native tree can have a small intrinsic/max height and an outer
  // wheel interceptor. History must fill the sidebar and own scroll gestures.
  await page.setViewportSize({ width: 1440, height: 720 })
  await page.locator('.host_regionArea').evaluate(element => {
    element.style.maxHeight = '220px'; element.style.flex = '0 0 auto'
    window.fixtureWheelBlocker = event => event.preventDefault()
    element.parentElement.addEventListener('wheel', window.fixtureWheelBlocker)
  })
  const historyList = page.locator('[data-history-list]')
  assert.ok((await historyList.boundingBox()).height > 250, 'history uses the remaining sidebar height')
  await historyList.hover()
  await page.mouse.wheel(0, 500)
  await page.waitForFunction(() => document.querySelector('[data-history-list]').scrollTop > 0)
  await page.locator('.host_regionArea').evaluate(element => {
    element.style.maxHeight = ''; element.style.flex = ''
    element.parentElement.removeEventListener('wheel', window.fixtureWheelBlocker)
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await historyList.evaluate(element => { element.scrollTop = 0 })

  // #75: use real flex and container-query geometry, not DOM shape alone.
  for (const width of [260, 220]) {
    await page.locator('.host_sidebarCol').evaluate((element, value) => { element.style.width = `${value}px` }, width)
    const geometry = await page.evaluate(() => {
      const tabs = document.querySelector('[data-dsh-imagegen-session-tabs]'), row = document.querySelector('.host_newSessionRow'), button = document.querySelector('.host_newSession')
      const style = getComputedStyle(button), rect = button.getBoundingClientRect(), label = button.firstElementChild.lastElementChild.getBoundingClientRect()
      const horizontalChrome = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((total, name) => total + parseFloat(style[name]), 0)
      return { directChild: tabs.parentElement.classList.contains('host_root'), above: tabs.getBoundingClientRect().bottom <= row.getBoundingClientRect().top, width: rect.width, innerWidth: rect.width - horizontalChrome, contentWidth: button.firstElementChild.getBoundingClientRect().width, labelFits: label.left >= rect.left && label.right <= rect.right }
    })
    console.log('Sidebar geometry:', JSON.stringify({ sidebarWidth: width, ...geometry }))
    assert.equal(geometry.directChild, true)
    assert.equal(geometry.above, true)
    assert.ok(geometry.width >= width - 60, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.innerWidth - geometry.contentWidth) < 1, 'container-query content fills the button content box')
    assert.equal(geometry.labelFits, true, 'the full native action label stays inside the button')
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

  await page.locator('[data-dsh-imagegen-history-main]').filter({ hasText: 'Saved live task' }).click()
  await expectImage('live')
  await page.locator('[data-studio-run] [data-result-open]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '继续编辑', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  // Constrain the flyout so a real wheel gesture is required even with two models.
  const picker = page.getByRole('button', { name: /^模型:/ })
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'Provider A', exact: true }).click()
  const flyout = page.getByRole('menu', { name: /^模型:/ })
  await flyout.evaluate(element => { element.style.maxHeight = '55px' })
  await flyout.hover()
  await page.mouse.wheel(0, 300)
  await page.waitForFunction(() => document.querySelector('[role="menu"][aria-label^="模型:"]')?.scrollTop > 0)
  await flyout.getByRole('menuitemradio', { name: 'gpt-image-2.5-flare', exact: true }).click()
  assert.match(await picker.getAttribute('aria-label'), /gpt-image-2\.5-flare/)

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

  addPaginatedHistory(entries)
  await page.setViewportSize({ width: 1440, height: 720 })
  await page.reload()
  await page.locator('.host_sidebarCol').evaluate(element => { element.style.width = '220px' })
  const pager = page.getByRole('navigation', { name: '历史记录分页' })
  const pageNumber = pager.getByRole('spinbutton', { name: '页码' })
  const nextPage = pager.getByRole('button', { name: '下一页' })
  const historyRows = page.locator('[data-dsh-imagegen-history-main]')
  await pager.waitFor()
  assert.equal(await historyRows.count(), 10)
  await historyList.evaluate(element => { element.scrollTop = 120 })
  const [listRect, pagerRect] = await Promise.all([historyList.boundingBox(), pager.boundingBox()])
  assert.ok(pagerRect.y >= listRect.y + listRect.height && pagerRect.y + pagerRect.height <= 720, 'pager stays visible below the scrolling list')
  await nextPage.click()
  assert.equal(await pageNumber.inputValue(), '2')
  assert.equal(await historyList.evaluate(element => element.scrollTop), 0)
  await pageNumber.fill('3')
  await pageNumber.press('Enter')
  const archivedRow = historyRows.filter({ hasText: 'Archive record 16' })
  await archivedRow.waitFor()
  assert.equal(await historyRows.count(), 1)
  assert.equal(await nextPage.isDisabled(), true)
  await page.screenshot({ path: new URL('../.test-artifacts/history-pagination.png', import.meta.url).pathname })

  const query = page.getByRole('textbox', { name: '搜索提示词或模型…' })
  await query.fill('Archive record 16')
  await pager.waitFor({ state: 'hidden' })
  assert.equal(await archivedRow.count(), 1, 'search reaches records from any page')
  await query.clear()
  await pager.waitFor()
  assert.equal(await pageNumber.inputValue(), '1')
  assert.equal(await archivedRow.count(), 0)
  await nextPage.click()
  await page.getByRole('button', { name: '比例筛选' }).click()
  await page.getByRole('option', { name: '3:2', exact: true }).click()
  await pager.waitFor({ state: 'hidden' })
  assert.equal(await archivedRow.count(), 1, 'ratio filtering applies before pagination')
  assert.deepEqual(errors, [])
  console.log('PASS history pagination Chromium: fixed footer, wheel position reset, direct jump, global search and ratio filter')

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

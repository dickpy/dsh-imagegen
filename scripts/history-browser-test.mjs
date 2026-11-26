/** Actual React panel, history API client and sidebar mount in Chromium. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

  // #75: the launcher is a registered panel row, so the studio never competes
  // with the native New Session action for its track; the history surface is an
  // overlay inside the workspace region.
  for (const width of [260, 220]) {
    await page.locator('.host_sidebarCol').evaluate((element, value) => { element.style.width = `${value}px` }, width)
    const geometry = await page.evaluate(() => {
      const region = document.querySelector('.host_regionArea'), button = document.querySelector('.host_newSession')
      const style = getComputedStyle(button), rect = button.getBoundingClientRect(), label = button.firstElementChild.lastElementChild.getBoundingClientRect()
      const horizontalChrome = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((total, name) => total + parseFloat(style[name]), 0)
      return { historyHostInRegion: document.querySelector('[data-dsh-imagegen-history-host]')?.parentElement === region, width: rect.width, innerWidth: rect.width - horizontalChrome, contentWidth: button.firstElementChild.getBoundingClientRect().width, labelFits: label.left >= rect.left && label.right <= rect.right }
    })
    console.log('Sidebar geometry:', JSON.stringify({ sidebarWidth: width, ...geometry }))
    assert.equal(geometry.historyHostInRegion, true, 'the history surface lives in the workspace region')
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
  await page.waitForTimeout(80)
  assert.equal(await page.locator('[data-dsh-imagegen-history-host]').count(), 1, 'observer repair stays idempotent')
  assert.equal(await page.evaluate(() => document.querySelector('[data-dsh-imagegen-history-host]').parentElement.classList.contains('host_regionArea')), true, 'a rewrapped native action never moves the history surface')
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
  await page.screenshot({ path: fileURLToPath(new URL('../.test-artifacts/history-sidebar.png', import.meta.url)) })
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
  await page.screenshot({ path: fileURLToPath(new URL('../.test-artifacts/history-pagination.png', import.meta.url)) })

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
  await page.screenshot({ path: fileURLToPath(new URL('../.test-artifacts/sensenova-settings.png', import.meta.url)) })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /OpenAI channel/ }).click()
  dialog = page.getByRole('dialog', { name: '渠道 · OpenAI channel', exact: true })
  assert.equal(await dialog.locator('[data-watermark-hint]').count(), 0, 'unrelated models do not advertise unsupported switches')
  assert.deepEqual(errors, [])
  console.log('PASS channel settings Chromium: capability-aware hints, SenseNova switches, saved HTTP payload, reload persistence and unrelated model isolation')
  // The expanded DSH sidebar uses a grid scrollport for the launcher list and
  // sessions. Its gutters must survive when the studio keeps that list visible.
  await page.goto(`${base}/?host`)
  await page.locator('[data-dsh-imagegen-history-host]').waitFor()
  await page.addStyleTag({ content: `
    :root { --dsw-alias-interactive-bg-hover: rgb(225, 229, 235); }
    .host_scrollArea[data-sidebar-scrollport] {
      display: grid;
      grid-template-columns: 4px minmax(0, 1fr);
      grid-template-rows: 8px max-content 2px max-content;
      margin-left: -4px;
    }
    .host_panelList { grid-area: 2 / 2; }
    .host_regionArea { grid-area: 4 / 2; }
  ` })
  const sidebar = await page.evaluate(() => {
    const root = document.documentElement
    const scrollport = document.querySelector('.host_scrollArea')
    const icon = document.querySelector('[data-dsh-imagegen-panel-icon]')
    const row = icon.closest('button')
    scrollport.setAttribute('data-sidebar-scrollport', '')
    row.classList.add('host_panelEntry')
    const position = () => { const { x, y } = row.getBoundingClientRect(); return [x, y] }

    root.removeAttribute('data-dsh-imagegen-active')
    const before = position()
    const idle = getComputedStyle(row).backgroundColor
    root.setAttribute('data-dsh-imagegen-active', '')
    icon.setAttribute('data-active', '')
    const open = position()
    const selected = getComputedStyle(row).backgroundColor
    const historyHeight = document.querySelector('[data-dsh-imagegen-history-host]').getBoundingClientRect().height
    root.setAttribute('data-dsh-imagegen-sidebar-takeover', '')
    const takeover = {
      list: getComputedStyle(document.querySelector('.host_panelList')).display,
      scrollport: getComputedStyle(scrollport).display,
    }
    return { before, idle, open, selected, historyHeight, takeover }
  })
  assert.deepEqual(sidebar.open, sidebar.before, 'opening the studio keeps the launcher under the pointer')
  assert.equal(sidebar.idle, 'rgba(0, 0, 0, 0)')
  assert.equal(sidebar.selected, 'rgb(225, 229, 235)', 'the launcher takes the native active color')
  assert.ok(sidebar.historyHeight > 250, 'the history fills the remaining grid track')
  assert.deepEqual(sidebar.takeover, { list: 'none', scrollport: 'flex' }, 'takeover keeps the full flex scrollport for history')
  console.log('PASS native scrollport: steady launcher, selected color, and history in both sidebar modes')

  const legacyImage = (id, width, height) => {
    assets[id] = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/></svg>`)
    return { url: `/history/image/${id}.png`, mime: 'image/svg+xml', revisedPrompt: 'Fixture prompt' }
  }
  const first = legacyImage('first-wide', 640, 360)
  const second = legacyImage('second-wide', 480, 320)
  const portrait = legacyImage('portrait', 360, 640)
  entries.unshift(
    { ...entries[0], id: 'layout-wide', prompt: 'Legacy wide pair', createdAt: Date.now(), n: 2, images: [first, second] },
    { ...entries[0], id: 'layout-mixed', prompt: 'Legacy mixed pair', createdAt: Date.now() - 1, n: 2, images: [first, portrait] },
  )
  await page.setViewportSize({ width: 1440, height: 840 })
  await page.goto(base)
  await page.getByRole('button', { name: /Legacy wide pair/ }).click()
  const grid = page.locator('[data-result-preview-grid]')
  const media = grid.locator('[data-result-media]')
  const dimensions = grid.locator('[data-image-dimensions]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-image-dimensions]')].every(el => el.textContent.includes(' × ')))
  assert.deepEqual(await dimensions.allTextContents(), ['640 × 360', '480 × 320'])
  const geometry = () => media.evaluateAll(elements => elements.map(el => {
    const { width, height, y } = el.getBoundingClientRect()
    return { width, height, y }
  }))
  await grid.evaluate(element => { element.style.width = '480px' })
  const wide = await geometry()
  assert.equal(wide[0].y, wide[1].y, 'landscapes remain side by side with space to compare')
  await grid.evaluate(element => { element.style.width = '400px' })
  const narrow = await geometry()
  assert.ok(narrow[1].y > narrow[0].y + narrow[0].height, 'two landscapes stack in a narrow result sheet')
  assert.ok(narrow[0].width > wide[0].width, 'stacking widens the first preview')
  assert.ok(Math.abs(narrow[0].width - narrow[0].height * 16 / 9) < 2, 'the caption and metadata fit outside the picture')
  await page.getByRole('button', { name: /Legacy mixed pair/ }).click()
  await dimensions.last().getByText('360 × 640', { exact: true }).waitFor()
  await grid.evaluate(element => { element.style.width = '400px' })
  const mixed = await geometry()
  assert.equal(mixed[0].y, mixed[1].y, 'mixed images use the original order and stay side by side')
  assert.ok(Math.abs(mixed[1].width - mixed[1].height * 9 / 16) < 2, 'the legacy portrait keeps its decoded ratio')
  console.log('PASS result sheet: legacy dimensions, image fit and width-aware landscape pairs')
} catch (error) {
  if (page) { mkdirSync(new URL('../.test-artifacts', import.meta.url), { recursive: true }); await page.screenshot({ path: fileURLToPath(new URL('../.test-artifacts/history-failure.png', import.meta.url)) }) }
  throw error
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

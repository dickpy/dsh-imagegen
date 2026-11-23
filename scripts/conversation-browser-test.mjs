import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.conversation-test.cjs`)
  : require
const { chromium } = runtime('playwright')

const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fafafd;--dsw-alias-bg-layer-2:#f2f2f6;--dsw-alias-border-l1:#dddde4;--dsw-alias-border-l2:#c8c8d2;--dsw-alias-label-primary:#25252a;--dsw-alias-label-secondary:#60606b;--dsw-alias-label-tertiary:#85858f;--dsw-alias-brand-primary:#6241cf}*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font:14px system-ui,sans-serif}.conversationE2e{display:flex;height:100%;flex-direction:column;gap:12px;padding:16px}.conversationE2e button{width:max-content;padding:7px 12px}.conversationE2e pre{white-space:pre-wrap}[data-layout-tests]{display:flex;gap:20px}[data-layout-tests]>div{width:180px}[data-host-sidebar]{display:flex;height:240px;flex-direction:column;border:1px solid #aaa}[data-host-top-strip]{flex:none;display:flex;align-items:center;padding-left:16px;background:#eee}[data-host-logo]{height:40px;flex:none;display:flex;align-items:center;padding-left:12px}[class*=panelList],[class*=regionArea],[class*=footArea],[data-host-hidden]{min-height:32px;flex:none;padding:4px;border-bottom:1px solid #ddd}`

const server = createServer((req, res) => {
  if (req.url === '/preview.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(readFileSync(new URL('../.conversation-preview/preview.js', import.meta.url)))
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><html data-dsh-imagegen-active><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/preview.js"></script></html>`)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CONVERSATION_CHROMIUM_PATH ? { executablePath: process.env.CONVERSATION_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  await page.goto(baseUrl)
  const picker = page.locator('[data-dsh-imagegen-session-picker]')
  await page.getByRole('button', { name: 'Add image to chat' }).click()
  await picker.waitFor()
  const confirm = page.getByRole('button', { name: 'Add to selected conversation' })
  const search = picker.getByLabel('Search titles or paths')
  assert.equal(await picker.locator('[data-session-id]').count(), 2, 'every listed conversation is a row')
  assert.equal(await picker.locator('[data-active]').count(), 0, 'no target is selected automatically')
  assert.equal(await confirm.isDisabled(), true)
  const latestRow = await picker.locator('[data-session-id="session-latest"]').innerText()
  assert.match(latestRow, /Running/, 'a busy conversation says so')
  assert.match(latestRow, /latest-project/, 'the workspace is a trailing hint')
  await search.fill('older')
  assert.equal(await picker.locator('[data-session-id]').count(), 1, 'search narrows the list')
  assert.equal(await picker.locator('[data-session-id]').first().getAttribute('data-session-id'), 'session-older')
  await search.fill('nothing matches this')
  assert.equal(await picker.locator('[data-session-id]').count(), 0)
  assert.equal(await picker.getByText('No matching conversations').count(), 1, 'an empty search says so')
  await search.fill('')
  assert.equal(await picker.locator('[data-session-id]').count(), 2)
  assert.equal(await page.locator('[data-attachment-events]').textContent(), '', 'opening the picker does not touch any session')
  await page.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await picker.count(), 0, 'cancel leaves the image unattached')
  assert.equal(await page.locator('[data-attachment-events]').textContent(), '')

  await page.getByRole('button', { name: 'Add image to chat' }).click()
  await picker.locator('[data-session-id="session-older"]').click()
  assert.equal(await confirm.isDisabled(), false, 'a picked row enables the confirm button')
  await confirm.click()
  await page.getByRole('status').filter({ hasText: 'Image added' }).waitFor()
  assert.equal(await picker.count(), 0)
  assert.deepEqual((await page.locator('[data-attachment-events]').textContent()).trim().split('\n'), [
    'prepare:0',
    'createDrafts:session-older:dsh-image-1.png',
    'input.for:session-older',
    'addAttachments:session-older:draft-session-older',
    'attachConversationImage:session-older:dsh-image-1.png:data:image/png;base64,',
    'setDraft:session-older:sample generated image prompt',
    'open:session-older',
  ], 'explicitly selected session completes the full draft/composer/durable chain and opens that conversation')

  await page.goto(`${baseUrl}?current=session-latest`)
  await page.getByRole('button', { name: 'Add image to chat' }).click()
  assert.equal(await page.locator('[data-dsh-imagegen-session-picker]').count(), 0, 'the real current session skips manual selection')
  await page.getByRole('status').filter({ hasText: 'Image added' }).waitFor()
  assert.ok((await page.locator('[data-attachment-events]').textContent()).includes('createDrafts:session-latest:'), 'the exact current session is the destination')

  const layouts = await page.evaluate(() => {
    document.documentElement.dataset.dshImagegenActive = ''
    return [...document.querySelectorAll('[data-layout]')].map(layout => {
      const strip = layout.querySelector('[data-host-top-strip]')
      const logo = layout.querySelector('[data-host-logo]')
      const list = layout.querySelector('.host_panelList')
      const otherPanel = layout.querySelector('[data-host-panel]')
      const region = layout.querySelector('[class*=regionArea]')
      const footer = layout.querySelector('[class*=footArea]')
      const hidden = layout.querySelector('[data-host-hidden]')
      return {
        platform: layout.getAttribute('data-layout'),
        stripDisplay: strip === null ? null : getComputedStyle(strip).display,
        stripHeight: strip === null ? null : strip.getBoundingClientRect().height,
        logoDisplay: getComputedStyle(logo).display,
        logoTop: logo.getBoundingClientRect().top,
        stripBottom: strip?.getBoundingClientRect().bottom ?? 0,
        listDisplay: getComputedStyle(list).display,
        otherPanelDisplay: getComputedStyle(otherPanel).display,
        regionDisplay: getComputedStyle(region).display,
        footerDisplay: getComputedStyle(footer).display,
        unrelatedDisplay: getComputedStyle(hidden).display,
      }
    })
  })
  assert.deepEqual(layouts.map(item => item.platform), ['web', 'windows', 'macos'])
  for (const layout of layouts) {
    assert.notEqual(layout.logoDisplay, 'none', `${layout.platform}: logo remains visible`)
    assert.notEqual(layout.listDisplay, 'none', `${layout.platform}: the panel list stays visible in the studio`)
    assert.notEqual(layout.otherPanelDisplay, 'none', `${layout.platform}: the launcher's sibling panel rows stay reachable`)
    assert.notEqual(layout.regionDisplay, 'none', `${layout.platform}: workspace region remains visible`)
    assert.notEqual(layout.footerDisplay, 'none', `${layout.platform}: footer remains visible`)
    assert.equal(layout.unrelatedDisplay, 'none', `${layout.platform}: unrelated sidebar entry remains hidden`)
    if (layout.platform === 'macos') {
      assert.equal(layout.stripDisplay, 'flex', 'macOS topStrip stays rendered')
      assert.equal(layout.stripHeight, 52, 'macOS titlebar spacer keeps its 52px height')
      assert.ok(layout.logoTop >= layout.stripBottom, 'macOS logo starts below the titlebar spacer')
    }
    if (layout.platform === 'windows') assert.notEqual(layout.stripDisplay, 'none', 'a Windows title strip, if present, remains rendered')
  }
  assert.deepEqual(errors, [])
  console.log('PASS conversation regression: no implicit target; current and explicit target attach correctly; Web/Windows/macOS sidebar CSS preserves topStrip, the panel list and the workspace region')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}

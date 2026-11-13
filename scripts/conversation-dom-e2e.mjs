import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const server = createServer((req, res) => {
  if (req.url === '/preview.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(readFileSync(new URL('../.conversation-preview/preview.js', import.meta.url)))
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><html data-dsh-imagegen-active><meta charset="utf-8"><div id="root"></div><script src="/preview.js"></script></html>')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

async function openPage(url) {
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error.message))
  const dom = await JSDOM.fromURL(url, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  })
  const { window } = dom
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 2000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), `timed out waiting for ${label}`)
  }
  const click = selector => {
    const target = window.document.querySelector(selector)
    assert.ok(target, `missing ${selector}`)
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  }
  const clickText = text => {
    const target = [...window.document.querySelectorAll('button')].find(button => button.textContent === text)
    assert.ok(target, `missing button ${text}`)
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  }
  return { dom, window, errors, waitFor, click, clickText }
}

try {
  const page = await openPage(baseUrl)
  const { window, waitFor, click, clickText } = page
  await waitFor(() => window.document.querySelector('[data-add-image-to-conversation]') !== null, 'the real React action button')
  click('[data-add-image-to-conversation]')
  await waitFor(() => window.document.querySelector('[data-dsh-imagegen-session-picker]') !== null, 'explicit target picker')
  const selector = window.document.querySelector('select[aria-label="Target conversation"]')
  const confirm = [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Add to selected conversation')
  assert.equal(selector.value, '', 'the first listed or most recent session is not preselected')
  assert.equal(confirm.disabled, true, 'confirm stays disabled until the user chooses a target')
  assert.equal(window.document.querySelector('[data-attachment-events]').textContent, '', 'opening the picker does not alter a conversation')
  clickText('Cancel')
  await waitFor(() => window.document.querySelector('[data-dsh-imagegen-session-picker]') === null, 'cancelled picker close')
  assert.equal(window.document.querySelector('[data-attachment-events]').textContent, '')

  click('[data-add-image-to-conversation]')
  await waitFor(() => window.document.querySelector('[data-dsh-imagegen-session-picker]') !== null, 'picker reopen')
  const targetSelect = window.document.querySelector('select[aria-label="Target conversation"]')
  targetSelect.value = 'session-older'
  targetSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  await waitFor(() => ![...window.document.querySelectorAll('button')].find(button => button.textContent === 'Add to selected conversation').disabled, 'explicit target selection')
  clickText('Add to selected conversation')
  await waitFor(() => window.document.querySelector('[data-attachment-message]')?.textContent === 'Image added', 'attachment completion')
  assert.deepEqual(window.document.querySelector('[data-attachment-events]').textContent.trim().split('\n'), [
    'prepare:0',
    'createDrafts:session-older:dsh-image-1.png',
    'input.for:session-older',
    'addAttachments:session-older:draft-session-older',
    'attachConversationImage:session-older:dsh-image-1.png:data:image/png;base64,',
    'setDraft:session-older:sample generated image prompt',
  ])
  const runtimeCss = [...window.document.querySelectorAll('style')].map(style => style.textContent).join('\n')
  // The minifier is free to merge rules that share a declaration block, so the
  // guard on the host's topStrip row is matched as a selector, not as a whole rule.
  assert.match(runtimeCss, /:not\(\[class\*=topStrip\]\)[,{]/, 'the sidebar hiding rule explicitly preserves host topStrip rows')
  assert.match(runtimeCss, /:not\(\[class\*=topStrip\]\)[^{}]*\{display:none!important\}/, 'the sidebar hiding rule still hides everything else')
  assert.ok(runtimeCss.includes(':not([data-dsh-imagegen-sidebar-keep])'), 'the sidebar keep-chain marker is part of the allow-list')
  assert.ok(runtimeCss.includes('data-shell-leading'), 'the collapsed sidebar opener is raised above the studio')
  assert.ok(runtimeCss.includes('[class*=mainPanel]'), 'the 0.2.x main panel wrapper is recognised')
  assert.ok(runtimeCss.includes('[data-dsh-imagegen-chat-column]'), 'the chat carrier rule is emitted')
  assert.deepEqual(page.errors, [])
  page.dom.window.close()

  const currentPage = await openPage(`${baseUrl}?current=session-latest`)
  await currentPage.waitFor(() => currentPage.window.document.querySelector('[data-add-image-to-conversation]') !== null, 'current-session action button')
  currentPage.click('[data-add-image-to-conversation]')
  await currentPage.waitFor(() => currentPage.window.document.querySelector('[data-attachment-message]')?.textContent === 'Image added', 'current-session attachment')
  assert.equal(currentPage.window.document.querySelector('[data-dsh-imagegen-session-picker]'), null, 'a known current session does not ask the user to choose')
  assert.match(currentPage.window.document.querySelector('[data-attachment-events]').textContent, /createDrafts:session-latest:/, 'the exact current selection receives the attachment')
  assert.deepEqual(currentPage.errors, [])
  currentPage.dom.window.close()
  console.log('PASS conversation DOM E2E: explicit choice, cancel, exact current session and full attachment chain')
} finally {
  await new Promise(resolve => server.close(resolve))
}

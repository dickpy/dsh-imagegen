import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const server = createServer((req, res) => {
  if (req.url === '/preview.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(readFileSync(new URL('../.toolview-preview/preview.js', import.meta.url)))
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><html data-dsh-imagegen-active><meta charset="utf-8"><div id="root"></div><script src="/preview.js"></script></html>')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const errors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', error => errors.push(error.message))
const dom = await JSDOM.fromURL(baseUrl, {
  resources: 'usable',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
})
const { window } = dom
const document = window.document

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), `timed out waiting for ${label}`)
}
const click = selector => {
  const target = document.querySelector(selector)
  assert.ok(target, `missing ${selector}`)
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}
const press = name => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))

try {
  // Issue #62: the desktop shell denies window.open for blob: URLs, so the
  // thumbnail must preview in place instead of being a target="_blank" anchor.
  await waitFor(() => document.querySelector('[data-image-preview-trigger]') !== null, 'result thumbnail')
  assert.equal(document.querySelector('a[target="_blank"]'), null, 'no new-window anchor around a blob: image')
  assert.equal(document.querySelector('[data-image-lightbox]'), null, 'the viewer stays closed until clicked')

  const trigger = document.querySelector('[data-image-preview-trigger]')
  assert.equal(trigger.tagName, 'BUTTON', 'the thumbnail is a real button')
  trigger.focus()
  click('[data-image-preview-trigger]')

  await waitFor(() => document.querySelector('[data-image-lightbox]') !== null, 'viewer opening')
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog, 'viewer is a dialog')
  assert.equal(dialog.getAttribute('aria-modal'), 'true', 'viewer is modal')
  assert.equal(
    document.querySelector('[data-image-lightbox] img').getAttribute('src'),
    'blob:mock/result',
    'viewer shows the same object URL as the thumbnail',
  )

  const download = document.querySelector('[data-image-download]')
  assert.ok(download, 'viewer offers a download action')
  assert.equal(download.tagName, 'A')
  assert.equal(download.getAttribute('href'), 'blob:mock/result')
  assert.equal(download.getAttribute('download'), 'result.png', 'download keeps a file extension')

  assert.match(dialog.textContent ?? '', /1 \/ 2/, 'multi-image results show a counter')
  press('ArrowRight')
  await waitFor(() => /2 \/ 2/.test(document.querySelector('[role="dialog"]').textContent ?? ''), 'arrow-key paging')

  press('Escape')
  await waitFor(() => document.querySelector('[data-image-lightbox]') === null, 'escape closes the viewer')
  assert.equal(document.activeElement, trigger, 'focus returns to the thumbnail')

  click('[data-image-preview-trigger]')
  await waitFor(() => document.querySelector('[data-image-lightbox]') !== null, 'viewer reopening')
  click('[data-image-lightbox]')
  await waitFor(() => document.querySelector('[data-image-lightbox]') === null, 'backdrop click closes the viewer')

  assert.deepEqual(errors, [], 'no jsdom errors')
  console.log('TOOLVIEW E2E OK')
} finally {
  server.close()
  dom.window.close()
}

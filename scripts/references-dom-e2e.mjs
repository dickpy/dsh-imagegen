/** Exercise the real uploader with DSH's document-level drag lifecycle. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const server = createServer((req, res) => {
  if (req.url === '/preview.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(readFileSync(new URL('../.references-preview/preview.js', import.meta.url)))
  } else {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/preview.js"></script></html>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let dom
try {
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error.message))
  dom = await JSDOM.fromURL(`http://127.0.0.1:${server.address().port}`, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  })
  const { window } = dom, doc = window.document
  const waitFor = async (fn, label) => {
    const deadline = Date.now() + 2500
    while (!fn() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fn(), label)
  }
  await waitFor(() => doc.querySelector('[data-edit-references]'), 'uploader mounted')
  const card = doc.querySelector('[data-edit-references]')
  const image = new window.File(['image'], 'reference.png', { type: 'image/png' })
  const transfer = { files: [image], types: ['Files'], items: [] }
  const fire = (target, type, data = transfer, property = 'dataTransfer') => {
    const event = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, property, { value: data })
    target.dispatchEvent(event)
    return event
  }
  const count = () => doc.querySelectorAll('[data-edit-reference]').length
  const clear = () => [...card.querySelectorAll('button')].find(b => b.textContent === '清空').click()

  for (let attempt = 0; attempt < 2; attempt++) {
    // External drag enters the document before crossing into the reference
    // card and its child. No native dragend is delivered for an external drop.
    fire(doc.body, 'dragenter')
    assert.equal(window.hostDrop.active, true)
    fire(card, 'dragenter'); fire(card.querySelector('button'), 'dragenter')
    fire(card, 'dragover')
    assert.equal(fire(card, 'drop').defaultPrevented, true)
    await waitFor(() => count() === attempt + 1, 'dropped reference appended exactly once')
    assert.equal(window.hostDrop.active, false, 'external drop clears the host overlay immediately')
    assert.equal(window.hostDrop.depth, 0, 'nested drag counter resets')
    assert.equal(window.hostDrop.attachments.length, 0, 'reference never reaches the chat composer')
    assert.equal(doc.querySelector('[data-host-drop-overlay]').hidden, true)
  }
  // Invalid and empty drops still release the host; cancellation remains native.
  for (const files of [[], [new window.File(['pdf'], 'invalid.pdf', { type: 'application/pdf' })]]) {
    fire(doc.body, 'dragenter')
    fire(card, 'drop', { ...transfer, files })
    assert.equal(window.hostDrop.active, false)
  }
  fire(doc.body, 'dragenter'); fire(window, 'dragend')
  assert.equal(window.hostDrop.active, false)
  fire(doc.body, 'dragenter'); fire(doc.body, 'drop')
  assert.equal(window.hostDrop.attachments.length, 1, 'native chat drops outside the card still work')
  await waitFor(() => !card.textContent.includes('正在读取'), 'file validation settled')
  clear(); await waitFor(() => count() === 0, 'reference clear')

  // Keyboard paste from either target appends one image without stealing text.
  fire(card, 'paste', transfer, 'clipboardData')
  await waitFor(() => count() === 1, 'keyboard image paste on the reference card')
  fire(doc.querySelector('textarea'), 'paste', transfer, 'clipboardData')
  await waitFor(() => count() === 2, 'keyboard image paste on the prompt')
  assert.equal(fire(doc.querySelector('textarea'), 'paste', { files: [], items: [], types: ['text/plain'] }, 'clipboardData').defaultPrevented, false)

  const paste = card.querySelector('[data-paste-reference]')
  assert.ok(paste, 'explicit paste image button is available')
  const png = new window.Blob(['clipboard'], { type: 'image/png' })
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
    read: async () => [{ types: ['image/png'], getType: async () => png }],
  } })
  paste.click(); await waitFor(() => count() === 3, 'paste button reads one clipboard image')
  assert.equal([...doc.querySelectorAll('[data-edit-reference] img')].at(-1).alt, 'clipboard-1.png')
  window.navigator.clipboard.read = async () => { throw new Error('denied') }
  paste.click(); await waitFor(() => card.textContent.includes('Ctrl'), 'denied clipboard access offers keyboard fallback')
  assert.equal(count(), 3, 'clipboard failure preserves the references')
  window.navigator.clipboard.read = async () => []
  paste.click(); await waitFor(() => card.textContent.includes('没有可用的图片'), 'empty clipboard is explained')
  let resolveClipboard
  window.navigator.clipboard.read = () => new Promise(resolve => { resolveClipboard = resolve })
  paste.click(); await waitFor(() => paste.disabled, 'clipboard read is pending')
  clear(); await waitFor(() => count() === 0, 'clear during clipboard read')
  resolveClipboard([{ types: ['image/png'], getType: async () => png }])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(count(), 0, 'cleared pending clipboard image cannot reappear')
  paste.click(); await waitFor(() => paste.disabled, 'second clipboard read is pending')
  ;[...doc.querySelectorAll('button')].find(b => b.textContent === '新建创作').click()
  resolveClipboard([{ types: ['image/png'], getType: async () => png }])
  await waitFor(() => !paste.disabled, 'parent reset releases the pending paste action')
  assert.equal(count(), 0, 'New creation also cancels a pending paste at the state owner')
  assert.deepEqual(errors, [])
  console.log('PASS reference DOM E2E: external/nested/repeated drops release host overlay, chat isolation, invalid/cancelled/native drops, keyboard/button paste and clipboard failures/cancellation')
} finally {
  dom?.window.close()
  await new Promise(resolve => server.close(resolve))
}

import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startReverseFixture, referencePng } from './reference-reverse-fixture.mjs'

const fixture = await startReverseFixture()
let dom
async function openPage(configured = true) {
  const errors = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error.message))
  dom = await JSDOM.fromURL(`${fixture.base}/${configured ? '?reverse' : ''}`, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      window.HTMLElement.prototype.scrollIntoView = function () {}
      window.fetch = async (url, init = {}) => {
        if (init.body instanceof window.Blob) {
          const bytes = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(Buffer.from(reader.result)); reader.onerror = reject; reader.readAsArrayBuffer(init.body) })
          init = { ...init, body: bytes }
        }
        return fetch(new URL(url, fixture.base), init)
      }
    },
  })
  const { window } = dom, doc = window.document
  const waitFor = async (fn, label) => {
    const until = Date.now() + 4000
    while (!fn() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fn(), `${label}; errors=${JSON.stringify(errors)}; visible=${doc.body.textContent.slice(-1000)}`)
  }
  const click = element => { assert.ok(element); element.click() }
  const button = label => [...doc.querySelectorAll('button')].find(element => element.textContent === label)
  const prompt = () => doc.querySelector('textarea')
  const change = (element, text) => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(element, text); element.dispatchEvent(new window.Event('input', { bubbles: true })) }
  const add = async (name, paste = false) => {
    const file = new window.File([referencePng], name, { type: 'image/png' }), card = doc.querySelector('[data-edit-references]')
    const event = new window.Event(paste ? 'paste' : 'change', { bubbles: true, cancelable: true })
    if (paste) { Object.defineProperty(event, 'clipboardData', { value: { files: [file], items: [], types: ['Files'] } }); card.dispatchEvent(event) }
    else { const input = card.querySelector('input[type=file]'); Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(event) }
    await waitFor(() => [...doc.querySelectorAll('[data-edit-reference] img')].some(image => image.alt === name), `read ${name}`)
    await waitFor(() => !doc.querySelector('[data-reference-reverse]').disabled, 'reference read settled')
  }
  await waitFor(() => doc.querySelector('[data-studio-actions]'), 'fixed actions mount')
  return { window, doc, waitFor, click, button, prompt, change, add, errors }
}
try {
  let page = await openPage()
  page.click(page.doc.querySelector('[data-studio-reverse]'))
  await page.waitFor(() => page.doc.querySelector('[data-edit-references]'), 'empty shortcut opens edit uploader')
  assert.equal(page.doc.querySelector('[data-reference-reverse]').disabled, true)
  await page.add('first.png')
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => page.prompt().value === 'Reusable prompt from first.png', 'one click reverses and fills prompt')
  assert.equal(page.doc.querySelector('[data-reverse-dialog]'), null)
  assert.deepEqual(fixture.uploads[0].bytes, referencePng)
  assert.equal(fixture.uploads[0].mime, 'image/png')
  assert.equal(fixture.reversals.length, 1)
  assert.equal(fixture.generations.length, 0, 'reverse never submits generation')
  await page.add('second.png', true)
  page.click(page.doc.querySelector('[aria-label="选择要反推的参考图"]'))
  await page.waitFor(() => page.doc.querySelector('[role=option]'), 'reference selector opens')
  page.click([...page.doc.querySelectorAll('[role=option]')].find(element => element.textContent.includes('second.png')))
  await page.waitFor(() => !page.doc.querySelector('[role=listbox]'), 'reference choice is committed')
  page.click(page.doc.querySelector('[data-studio-reverse]'))
  await page.waitFor(() => page.prompt().value === 'Reusable prompt from second.png', 'fixed shortcut uses the explicitly selected reference')
  assert.equal(fixture.reversals.at(-1).images[0].name, 'second.png')
  assert.equal(page.doc.querySelectorAll('[data-edit-reference]').length, 2)

  page.change(page.prompt(), 'Keep my edited prompt')
  fixture.control.fail = true
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => page.doc.querySelector('[data-reverse-dialog] [role=alert]'), 'vision failure is visible')
  assert.equal(page.prompt().value, 'Keep my edited prompt')
  assert.equal(page.doc.querySelectorAll('[data-edit-reference]').length, 2)
  fixture.control.fail = false
  page.click(page.doc.querySelector('[data-reverse-run]'))
  await page.waitFor(() => !page.doc.querySelector('[data-reverse-dialog]'), 'failed request can be retried')

  page.change(page.prompt(), 'Keep after cancellation')
  fixture.control.delay = 200
  const previous = fixture.reversals.length
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => fixture.reversals.length === previous + 1, 'vision request pending')
  page.click([...page.doc.querySelectorAll('[data-reverse-dialog] button')].find(element => element.textContent === '关闭'))
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(page.prompt().value, 'Keep after cancellation', 'late response never fills after cancellation')
  fixture.control.delay = 0
  fixture.control.uploadDelay = 200
  const beforeUpload = fixture.uploads.length, beforeReverse = fixture.reversals.length
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => fixture.uploads.length === beforeUpload + 1, 'upload is pending')
  page.click([...page.doc.querySelectorAll('[data-reverse-dialog] button')].find(element => element.textContent === '关闭'))
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(fixture.reversals.length, beforeReverse, 'closing during upload prevents the vision call')
  assert.equal(fixture.generations.length, 0)
  assert.deepEqual(page.errors, [])
  dom.window.close()

  page = await openPage(false)
  page.click(page.doc.querySelector('[data-studio-reverse]'))
  await page.waitFor(() => page.doc.querySelector('[data-edit-references]'), 'unconfigured model can still accept references')
  await page.add('without-model.png')
  const calls = fixture.reversals.length
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => page.doc.body.textContent.includes('提示词增强') && page.doc.querySelector('[role=dialog]'), 'missing vision model opens configuration guidance')
  assert.equal(fixture.reversals.length, calls)
  assert.equal(page.doc.querySelectorAll('[data-edit-reference]').length, 1)
  assert.deepEqual(page.errors, [])
  console.log('PASS #76 DOM E2E: upload/paste, exact reference selection, one-click auto-fill, no generation, failure/retry, cancellation during upload/vision, and missing-model guidance')
} catch (error) { console.error(error); throw error }
finally { dom?.window.close(); await new Promise(resolve => fixture.server.close(resolve)) }

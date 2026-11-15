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
  await waitFor(() => doc.querySelector('[data-dsh-imagegen-panel]'), 'studio mounts')
  return { window, doc, waitFor, click, button, prompt, change, add, errors }
}
try {
  let page = await openPage()
  page.click(page.button('图生图'))
  await page.waitFor(() => page.doc.querySelector('[data-edit-references]'), 'reference uploader')
  await page.add('first.png')
  const composer = page.prompt()
  page.change(composer, 'Keep my prompt')
  page.click(page.doc.querySelector('[data-reference-reverse]'))
  await page.waitFor(() => page.doc.querySelector('[data-workspace=reverse]'), 'reference opens independent workspace')
  assert.equal(page.doc.querySelector('[data-reverse-dialog]'), null)
  assert.equal(fixture.reversals.length, 0, 'opening must not request')
  const detail = page.doc.querySelector('[data-reverse-detail]')
  assert.equal(detail.disabled, false)
  detail.value = 'detailed'; detail.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  page.click(page.doc.querySelector('[data-reverse-run]'))
  await page.waitFor(() => page.doc.querySelector('[data-reverse-result]').value.includes('first.png'), 'visible result')
  assert.equal(composer.value, 'Keep my prompt', 'no automatic replacement')
  assert.equal(fixture.reversals[0].detail, 'detailed')
  assert.deepEqual(fixture.uploads[0].bytes, referencePng)
  page.change(page.doc.querySelector('[data-reverse-result]'), 'Reviewed prompt')
  page.click(page.doc.querySelector('[data-reverse-use]'))
  await page.waitFor(() => page.prompt().value === 'Reviewed prompt' && page.doc.querySelector('[data-workspace=normal]'), 'explicit apply returns to composer')
  assert.equal(page.doc.querySelectorAll('[data-edit-reference]').length, 1)
  page.click(page.button('反推提示词'))
  assert.equal(page.doc.querySelector('[data-reverse-result]').value, 'Reviewed prompt', 'tab retains draft')
  fixture.control.fail = true
  page.click(page.doc.querySelector('[data-reverse-run]'))
  await page.waitFor(() => page.doc.querySelector('[data-reverse-workspace] [role=alert]'), 'failure is visible')
  assert.equal(page.doc.querySelector('[data-reverse-result]').value, 'Reviewed prompt')
  fixture.control.fail = false
  page.click(page.doc.querySelector('[data-reverse-run]'))
  await page.waitFor(() => page.doc.querySelector('[data-reverse-result]').value.includes('first.png'), 'retry works')
  assert.equal(fixture.generations.length, 0)
  assert.deepEqual(page.errors, [])
  dom.window.close()
  page = await openPage(false)
  page.click(page.button('反推提示词'))
  await page.waitFor(() => page.doc.querySelector('[data-workspace=reverse]'), 'standalone empty workspace')
  assert.equal(page.doc.querySelector('[data-reverse-run]').disabled, true)
  assert.ok(page.button('配置视觉模型'))
  assert.deepEqual(page.errors, [])
  console.log('PASS #81: manual execution, editable parameters/result, explicit apply, draft retention, errors/retry, and unconfigured empty state')
} finally { dom?.window.close(); await new Promise(resolve => fixture.server.close(resolve)) }

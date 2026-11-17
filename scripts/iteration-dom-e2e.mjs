import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startHistoryFixture } from './history-fixture.mjs'

const { server, base, assets, entries, delays, settingsMutations, requests } = await startHistoryFixture()
let page
async function openPage(savedSelection, seedLive = false, settings = false) {
  const errors = [], console = new VirtualConsole()
  console.on('jsdomError', error => errors.push(error.message))
  const dom = await JSDOM.fromURL(settings ? `${base}/?settings` : base, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      window.fetch = async (url, init) => {
        const response = await fetch(new URL(url, base), init)
        response.blob = async () => new window.Blob([await response.arrayBuffer()], { type: response.headers.get('content-type') ?? '' })
        return response
      }
      if (savedSelection) window.localStorage.setItem('dsh-imagegen:history-selection:v1', savedSelection)
      if (seedLive) window.sessionStorage.setItem('dsh-imagegen:studio-runs:v1', JSON.stringify({
        text: { id: 'live-run', mode: 'text', prompt: 'Latest live task', sourceTaskId: 'live', slots: [{ id: 'live:0', taskId: 'live', imageIndex: 0, model: 'gpt-image-2', channelId: 'one', status: 'completed' }] }, edit: null,
      }))
    },
  })
  const { window } = dom, document = window.document
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 4000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), `${label}; errors=${JSON.stringify(errors)}; visible=${document.body.textContent?.slice(-1800)}`)
  }
  const click = element => { assert.ok(element, 'target exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text)
  const history = id => [...document.querySelectorAll('[data-dsh-imagegen-history-main]')].find(element => element.textContent.includes(`History ${id}`))
  const images = () => [...document.querySelectorAll('[data-result-preview-grid] img')]
  const expectImage = async id => {
    await waitFor(() => images().some(image => image.src.endsWith(assets[id].toString('base64'))), `selected ${id} pixels are shown`)
    assert.equal(images().length, 1)
  }
  return { dom, window, document, waitFor, click, button, history, images, expectImage, errors }
}

try {
  const child = entries.find(entry => entry.id === 'edit')
  child.parentId = 'text-a'; child.parentImageIndex = 0; child.threadId = 'text-a'
  child.refs = [{ url: '/history/image/text-a.png', mime: 'image/png' }]
  child.model = 'gpt-image-2'; child.channelId = 'two'
  page = await openPage(JSON.stringify({ mode: 'edit', ids: { text: null, edit: 'edit' } }))
  await page.expectImage('edit')
  await page.waitFor(() => page.document.querySelector('[data-edit-reference] img'), 'reload restores reference pixels')
  assert.ok(page.document.querySelector('[data-edit-reference] img').src.endsWith(assets['text-a'].toString('base64')))
  assert.equal(page.document.querySelector('textarea').value, child.prompt)
  assert.ok(page.document.querySelector('[data-iteration-versions]'), 'history groups a thread')
  const continueButton = page.document.querySelector('[data-result-preview-grid] [data-continue-edit]')
  page.click(continueButton)
  await page.waitFor(() => page.document.querySelector('[data-edit-reference] img').src.endsWith(assets.edit.toString('base64')), 'continue editing uses the output, not its input')
  const textarea = page.document.querySelector('textarea')
  assert.equal(textarea.value, '', 'new edit instruction is independent of the original prompt')
  const setter = Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, 'add fog')
  textarea.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  page.click(page.button('开始生成'))
  await page.waitFor(() => requests.length > 0, 'next round submits')
  assert.equal(requests[0].mode, 'edit')
  assert.equal(requests[0].parentId, 'edit')
  assert.equal(requests[0].parentImageIndex, 0)
  assert.equal(requests[0].model, 'gpt-image-2')
  assert.equal(requests[0].channelId, 'two')
  assert.equal(requests[0].quality, '2k')
  assert.equal(requests[0].size, '16:9')
  assert.ok(requests[0].image.endsWith(assets.edit.toString('base64')))
  assert.equal(requests[0].mask, undefined)
  assert.deepEqual(page.errors, [])
  page.dom.window.close()
  page = await openPage()
  await page.waitFor(() => page.document.querySelector('[data-iteration-version="text-a"]'), 'root version remains selectable')
  page.click(page.document.querySelector('[data-iteration-version="text-a"]'))
  await page.expectImage('text-a')
  page.click(page.document.querySelector('[data-result-preview-grid] [data-continue-edit]'))
  await page.waitFor(() => page.document.querySelector('[data-edit-reference] img'), 'branch reference loaded')
  assert.ok(page.document.querySelector('[data-edit-reference] img').src.endsWith(assets['text-a'].toString('base64')))
  assert.deepEqual(page.errors, [])
  console.log('PASS iteration DOM E2E: reload inputs, thread grouping, per-version branch, continue output, inherited parameters and exact parent submission')
} finally { page?.dom.window.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

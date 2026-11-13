import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startHistoryFixture } from './history-fixture.mjs'

const { server, base, assets, entries, delays, settingsMutations } = await startHistoryFixture()
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
  page = await openPage(undefined, true)
  await page.expectImage('live')
  await page.waitFor(() => JSON.parse(page.window.localStorage.getItem('dsh-imagegen:history-selection:v1'))?.ids?.text === 'live-history', 'completed live board remembers its durable history identity')
  const liveRestart = await openPage(page.window.localStorage.getItem('dsh-imagegen:history-selection:v1'))
  await liveRestart.expectImage('live')
  assert.equal(liveRestart.document.querySelector('[data-studio-run]'), null, 'a full restart recovers outputs from durable history without a session board')
  assert.deepEqual(liveRestart.errors, [])
  liveRestart.dom.window.close()
  await page.waitFor(() => page.history('text-a'), 'history portal mounts in the native sidebar')
  const tabs = page.document.querySelector('[data-dsh-imagegen-session-tabs]')
  const row = page.document.querySelector('.host_newSessionRow')
  assert.equal(tabs.parentElement, row.parentElement, '#75 tabs and the full action row are siblings')
  assert.equal(tabs.nextElementSibling, row)
  assert.equal(row.querySelector('[data-dsh-imagegen-session-tabs]'), null)
  const nativeButton = row.querySelector('.host_newSession')
  page.click(nativeButton)
  assert.equal(page.window.nativeSessions, 1, 'the native action retains its own click behavior')
  const wrapper = page.document.createElement('section')
  row.before(wrapper); wrapper.append(row)
  await page.waitFor(() => tabs.nextElementSibling === wrapper, 'observer repairs a replaced action carrier')
  assert.equal(page.document.querySelectorAll('[data-dsh-imagegen-session-tabs]').length, 1)

  delays.set('text-a', 250)
  page.click(page.history('text-a'))
  await page.waitFor(() => page.document.querySelector('[data-history-loading]'), 'history loads explicitly')
  assert.equal(page.images().length, 0, 'the old board is cleared before hydration')
  assert.equal(page.document.querySelector('[data-studio-run]'), null)
  await page.expectImage('text-a')
  assert.equal(page.history('text-a').querySelector('time').dateTime, new Date(entries[0].createdAt).toISOString())

  page.click(page.history('text-a'))
  await page.waitFor(() => page.document.querySelector('[data-history-loading]'), 'slow first selection is pending')
  page.click(page.history('text-b'))
  await page.expectImage('text-b')
  await new Promise(resolve => setTimeout(resolve, 300))
  await page.expectImage('text-b')
  assert.equal(page.history('text-b').getAttribute('aria-current'), 'true', 'a stale response cannot replace the new selection')

  page.click(page.history('edit'))
  await page.expectImage('edit')
  page.click(page.button('文生图'))
  await page.expectImage('text-b')
  assert.equal(page.history('text-b').getAttribute('aria-current'), 'true')
  page.click(page.button('图生图'))
  await page.expectImage('edit')
  await new Promise(resolve => setTimeout(resolve, 20))
  const saved = page.window.localStorage.getItem('dsh-imagegen:history-selection:v1')
  assert.deepEqual(JSON.parse(saved), { mode: 'edit', ids: { text: 'text-b', edit: 'edit' } })
  assert.ok(!saved.includes('base64') && !saved.includes('History '))
  assert.deepEqual(page.errors, [])
  page.dom.window.close()

  // A fresh document has no live queue board or image bytes in session storage.
  page = await openPage(saved)
  await page.expectImage('edit')
  assert.equal(page.history('edit').getAttribute('aria-current'), 'true')
  page.click(page.button('文生图'))
  await page.expectImage('text-b')
  page.click(page.history('text-a'))
  await page.waitFor(() => page.document.querySelector('[data-history-loading]'), 'text is pending while switching modes')
  page.click(page.history('edit'))
  await page.expectImage('edit')
  page.click(page.button('文生图'))
  await page.expectImage('text-a')

  page.click(page.history('missing'))
  await page.waitFor(() => page.document.querySelector('[role=alert]'), 'a failed history read is reported')
  assert.equal(page.images().length, 0, 'failed hydration cannot show a different task image')
  page.click(page.history('text-a'))
  await page.waitFor(() => page.document.querySelector('[data-history-loading]'), 'history is pending before reset')
  page.click(page.document.querySelector('[data-history-new]'))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(page.images().length, 0, 'new creation cancels the old hydration')
  assert.equal(page.document.querySelector('[data-dsh-imagegen-history-main][aria-current=true]'), null)
  assert.deepEqual(page.errors, [])
  console.log('PASS history DOM E2E: exact record pixels, independent mode selection, async races, fresh-document recovery, failures, reset, timestamps and native sidebar wrapper repair')
  page.dom.window.close()
  page = await openPage(undefined, false, true)
  const senseButton = () => [...page.document.querySelectorAll('button')].find(button => button.textContent.includes('SenseNova relay'))
  await page.waitFor(senseButton, 'real settings card loads through the settings bridge')
  page.click(senseButton())
  await page.waitFor(() => page.document.querySelector('[data-watermark-hint]'), 'SenseNova capability controls appear')
  assert.match(page.document.querySelector('[data-watermark-hint]').textContent, /SenseNova image/)
  const checkbox = text => [...page.document.querySelectorAll('label')].find(label => label.textContent === text)?.querySelector('input')
  page.click(checkbox('图片添加「AI 生成」水印'))
  page.click(checkbox('上游自动优化提示词'))
  page.click(page.document.querySelector('[role=dialog] button[aria-label="关闭"]'))
  page.click(page.button('保存'))
  await page.waitFor(() => settingsMutations.some(batch => batch.ops.some(op => op.path[0] === 'channels' && op.value[0].watermark === false && op.value[0].promptExtend === false)), 'channel preferences persist through the actual controller and HTTP bridge')
  assert.deepEqual(page.errors, [])
  console.log('PASS channel settings DOM E2E: SenseNova capability controls and both preferences persist through the settings bridge')
} finally { page?.dom.window.close(); await new Promise(resolve => server.close(resolve)) }

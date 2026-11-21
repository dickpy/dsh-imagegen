/** The shared image-model picker must survive scrolling its own lists (#92). */
import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startHistoryFixture } from './history-fixture.mjs'

const { server, base } = await startHistoryFixture()
let dom
try {
  const errors = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error.message))
  dom = await JSDOM.fromURL(base, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      window.fetch = async (url, init) => {
        const response = await fetch(new URL(url, base), init)
        response.blob = async () => new window.Blob([await response.arrayBuffer()], { type: response.headers.get('content-type') ?? '' })
        return response
      }
    },
  })
  const { window } = dom, document = window.document
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 4000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), `${label}; errors=${JSON.stringify(errors)}; visible=${document.body.textContent?.slice(-1200)}`)
  }
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)) }
  const click = element => { assert.ok(element, 'target exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
  const menus = () => document.querySelectorAll('[role="menu"]')
  const trigger = () => document.querySelector('button[aria-haspopup="menu"][aria-label^="模型:"]')
  const openPicker = async () => {
    click(trigger())
    await waitFor(() => menus().length === 1, 'the model menu opens')
    click(document.querySelector('[role="menu"] [role="menuitemradio"]'))
    await waitFor(() => menus().length === 2, 'the channel model flyout opens')
  }
  await waitFor(trigger, 'the model picker mounts in the studio')

  await openPicker()
  const flyout = () => [...menus()][1]
  // A list scroll is a capture-phase window event too; the popover has to
  // ignore the ones that come from inside its own panes (#92).
  flyout().dispatchEvent(new window.Event('scroll'))
  document.querySelector('[role="menu"] > div').dispatchEvent(new window.Event('scroll'))
  await settle()
  assert.equal(menus().length, 2, 'scrolling the model list keeps the popover open')
  flyout().dispatchEvent(new window.Event('scroll'))
  await settle()
  assert.equal(menus().length, 2, 'a second scroll at the end of the list still keeps it open')

  // Anything outside still dismisses the popover, as before.
  document.querySelector('[data-history-list]').dispatchEvent(new window.Event('scroll'))
  await settle()
  assert.equal(menus().length, 0, 'an outside scroll closes the popover')
  await openPicker()
  window.dispatchEvent(new window.Event('scroll'))
  await settle()
  assert.equal(menus().length, 0, 'a page scroll closes the popover')

  // Choosing one of the far models still works after the list scrolled.
  await openPicker()
  flyout().dispatchEvent(new window.Event('scroll'))
  const model = [...flyout().querySelectorAll('[role="menuitemradio"]')].find(button => button.textContent === 'gpt-image-2.5-flare')
  click(model)
  await waitFor(() => menus().length === 0, 'choosing a model closes the picker')
  assert.match(trigger().getAttribute('title') ?? '', /gpt-image-2\.5-flare/, 'the chosen model is shown on the trigger')
  assert.deepEqual(errors, [])
  console.log('PASS model picker DOM E2E: inner scrolling keeps the menu mounted, outside scrolling dismisses it, and a scrolled-to model still applies')
} finally {
  dom?.window.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

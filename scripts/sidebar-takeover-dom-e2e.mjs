/**
 * Left-column takeover DOM E2E.
 *
 * Two shell shapes are exercised against the real stylesheet from the built
 * bundle:
 *  - the shipped shell, where the collapse control is a sibling of the brand
 *    inside the logo row: the takeover hides the panel list and the New Session
 *    row but keeps the band and the brand, so the history never starts under the
 *    window buttons and the control keeps its home in that row;
 *  - the dsh-islands-ui grid, whose leading band and brand row must survive the
 *    takeover for the same reason.
 *
 * jsdom computes cascade but not layout, and its matcher cannot evaluate the
 * plugin's `:has()` allow-list, so visibility is asserted from the rules this
 * change owns (markers / display / position / grid-template-rows) while the
 * pixel proof (brand row above the history, control in place) lives in the
 * Chromium harness.
 */

import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startHistoryFixture } from './history-fixture.mjs'

const { server, base } = await startHistoryFixture()

/** Markers the takeover writes. */
const PANEL_LIST_ATTR = 'data-dsh-imagegen-panel-list'
const CHROME_ATTR = 'data-dsh-imagegen-sidebar-chrome'
const TAKEOVER_ATTR = 'data-dsh-imagegen-sidebar-takeover'

async function openPage(query) {
  const errors = []
  const console = new VirtualConsole()
  console.on('jsdomError', (error) => { errors.push(error.message) })
  const dom = await JSDOM.fromURL(`${base}/${query}`, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      window.fetch = async (url, init) => {
        const response = await fetch(new URL(url, base), init)
        response.blob = async () => new window.Blob([await response.arrayBuffer()], { type: response.headers.get('content-type') ?? '' })
        return response
      }
    },
  })
  const { window } = dom
  const document = window.document
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 5000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), `${label}; errors=${JSON.stringify(errors)}; visible=${document.body.textContent?.slice(0, 400)}`)
  }
  return { dom, window, document, waitFor, errors }
}

try {
  /* ---------------------------------------------------------- shipped shell */
  const takeover = await openPage('?takeover')
  await takeover.waitFor(() => takeover.document.querySelector('[data-sidebar-back]') !== null, 'the takeover header renders into the shell history host')
  const doc = takeover.document
  const window = takeover.window
  const style = (element) => window.getComputedStyle(element)

  assert.equal(doc.documentElement.getAttribute(TAKEOVER_ATTR), '', 'the takeover attribute drives the stylesheet')

  // Markers are resolved from our own launcher icon, so a skin that names
  // nothing still gets them; the fixture names its list `host_panelList`.
  const panelList = doc.querySelector('.host_panelList')
  const logo = doc.querySelector('.host_logoRow')
  const brand = doc.querySelector('.host_brand')
  const toggle = doc.querySelector('[data-sidebar-toggle]')
  assert.equal(panelList.getAttribute(PANEL_LIST_ATTR), '', 'the panel list is marked from the launcher row')
  const newSessionRow = doc.querySelector('.host_newSessionRow')
  assert.equal(newSessionRow.getAttribute(CHROME_ATTR), '', 'the New Session row is chrome')
  assert.equal(style(panelList).display, 'none', 'the panel list steps aside')
  assert.equal(style(newSessionRow).display, 'none', 'the New Session row steps aside')

  // The top chrome stays put: hiding it (v1.22.0) put the takeover header under
  // the macOS traffic lights and dropped the DSH logo. jsdom cannot evaluate the
  // plugin's :has() allow-list, so the proof here is that no rule hides the band
  // or the brand any more and the control keeps its home in the brand row.
  const cssText = [...doc.querySelectorAll('style')].map(sheet => sheet.textContent).join('\n')
  assert.ok(!cssText.includes('data-dsh-imagegen-sidebar-brand'), 'no rule hides the brand identity any more')
  assert.ok(!cssText.includes('data-dsh-imagegen-toggle-host'), 'the collapse control is no longer floated out of its row')
  assert.equal(logo.hasAttribute(CHROME_ATTR), false, 'the brand row is not hidden by the takeover')
  assert.notEqual(style(logo).position, 'absolute', 'the brand row stays in the flow')
  assert.equal(toggle.parentElement, logo, 'the collapse control stays in the brand row')
  toggle.click()
  assert.equal(window.toggleClicks, 1, 'the host control is still wired to the host action')

  const title = doc.querySelector('[data-dsh-imagegen-history] header span')
  assert.match(title?.textContent ?? '', /生图历史|Image history|История изображений/, 'the column title names image history while it owns the column')

  // The exit is the plugin's own action: the studio closes through onExit.
  doc.querySelector('[data-sidebar-back]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(window.studioExits, 1, '回到对话 asks the host to close the studio')
  assert.deepEqual(takeover.errors, [])
  takeover.dom.window.close()

  /* -------------------------------------------------- shipped shell, no takeover */
  const host = await openPage('?host')
  await host.waitFor(() => host.document.querySelector('[data-dsh-imagegen-history]') !== null, 'history renders beside the shell navigation')
  assert.equal(host.document.querySelector('[data-sidebar-back]'), null, 'no takeover header when the setting is off')
  assert.equal(host.document.documentElement.getAttribute(TAKEOVER_ATTR), null, 'no takeover attribute when the setting is off')
  // The markers are written either way; only the attribute decides whether they
  // change anything. The row keeps its own place.
  assert.equal(host.window.getComputedStyle(host.document.querySelector('.host_logoRow')).position, 'relative', 'the logo row keeps its own box when the takeover is off')
  assert.equal(host.document.querySelector('.host_panelList').getAttribute(PANEL_LIST_ATTR), '', 'markers exist but are inert without the attribute')
  assert.deepEqual(host.errors, [])
  host.dom.window.close()

  /* ------------------------------------------------------------ islands skin */
  const islands = await openPage('?islands&takeover')
  await islands.waitFor(() => islands.document.querySelector('[data-sidebar-back]') !== null, 'the takeover header renders in the islands shell')
  const islandsDoc = islands.document
  const islandsRoot = islandsDoc.querySelector('[data-islands-part~="sidebar-root"]')
  const rows = islands.window.getComputedStyle(islandsRoot).gridTemplateRows.trim().split(/\s+/).slice(0, 2)
  assert.deepEqual(rows, ['8px', '36px'], `the skin keeps its leading band and brand row, so the history never starts under the window buttons (got ${rows.join(' ')})`)
  assert.notEqual(islands.window.getComputedStyle(islandsDoc.querySelector('.host_logoRow')).position, 'absolute', 'the skin brand row keeps its place instead of being floated')
  assert.deepEqual(islands.errors, [])
  islands.dom.window.close()

  console.log('PASS sidebar takeover DOM E2E: markers, panel list and New Session hidden, brand row and collapse control kept, islands band preserved, exit wired')
} finally {
  await new Promise(resolve => server.close(resolve))
}

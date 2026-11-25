/**
 * Left-column takeover DOM E2E.
 *
 * Two shell shapes are exercised against the real stylesheet from the built
 * bundle:
 *  - the shipped shell, where the collapse control is a sibling of the brand
 *    inside the logo row (hiding the row would take the control with it — the
 *    "collapse button disappeared" regression);
 *  - the dsh-islands-ui grid, where the hidden chrome leaves its leading rows
 *    reserving height (the empty band reported against the skin).
 *
 * jsdom computes cascade but not layout, and its matcher cannot evaluate the
 * plugin's `:has()` allow-list, so visibility is asserted from the rules this
 * change owns (position / display / grid-template-rows) while the pixel proof
 * (control at the top-right, no band above the history) lives in the Chromium
 * harness.
 */

import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { startHistoryFixture } from './history-fixture.mjs'

const { server, base } = await startHistoryFixture()

/** Markers the takeover writes. */
const PANEL_LIST_ATTR = 'data-dsh-imagegen-panel-list'
const CHROME_ATTR = 'data-dsh-imagegen-sidebar-chrome'
const BRAND_ATTR = 'data-dsh-imagegen-sidebar-brand'
const TOGGLE_ATTR = 'data-dsh-imagegen-toggle'
const TOGGLE_HOST_ATTR = 'data-dsh-imagegen-toggle-host'
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
  assert.equal(brand.getAttribute(BRAND_ATTR), '', 'the brand identity is marked separately from its row')
  assert.equal(toggle.getAttribute(TOGGLE_ATTR), '', 'the collapse control is marked')
  assert.equal(logo.getAttribute(TOGGLE_HOST_ATTR), '', 'the row that carries the collapse control is marked')
  assert.equal(doc.querySelector('.host_newSessionRow').getAttribute(CHROME_ATTR), '', 'the New Session row is chrome')

  // Hiding the brand (not the row) is what keeps the control alive; the row is
  // floated to the column's top-right corner instead of reserving its height.
  assert.equal(style(logo).position, 'absolute', 'the row that carries the collapse control is floated out of the flow')
  assert.equal(style(logo).top, '8px', 'the control sits at the top of the column')
  assert.equal(style(logo).right, '8px', 'the control sits at the right of the column')
  assert.equal(style(logo).display, 'flex', 'the row keeps a box so the control is rendered')
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
  assert.deepEqual(rows.map(row => row.replace(/px$/, '')), ['0', '0'], `the skin's leading rows collapse instead of reserving an empty band (got ${rows.join(' ')})`)
  assert.equal(islands.window.getComputedStyle(islandsDoc.querySelector('.host_logoRow')).position, 'absolute', 'the skin collapse control is floated by the same rule')
  assert.deepEqual(islands.errors, [])
  islands.dom.window.close()

  console.log('PASS sidebar takeover DOM E2E: markers, brand-only hiding, collapse control kept and floated, islands rows collapsed, exit wired')
} finally {
  await new Promise(resolve => server.close(resolve))
}

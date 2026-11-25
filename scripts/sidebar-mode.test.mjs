import assert from 'node:assert/strict'
import test from 'node:test'
import { SIDEBAR_TAKEOVER_ATTR, applySidebarMode, sidebarModeOf } from '../src/client/sidebar-mode.ts'

/** Minimal document stand-in: the module only touches the document element. */
function stubDocument() {
  const attributes = new Map()
  globalThis.document = {
    documentElement: {
      setAttribute: (name, value) => { attributes.set(name, value) },
      removeAttribute: (name) => { attributes.delete(name) },
      getAttribute: (name) => attributes.get(name) ?? null,
    },
  }
  return attributes
}

test('the shipped default is the takeover; only an explicit false keeps the shell navigation', () => {
  assert.equal(sidebarModeOf(undefined), 'studio')
  assert.equal(sidebarModeOf({}), 'studio')
  assert.equal(sidebarModeOf({ sidebarTakeover: true }), 'studio')
  assert.equal(sidebarModeOf({ sidebarTakeover: false }), 'host')
})

test('the attribute is published only while an open studio owns the column', () => {
  const attributes = stubDocument()

  applySidebarMode('studio', true)
  assert.equal(attributes.get(SIDEBAR_TAKEOVER_ATTR), '', 'open studio with the takeover on')

  applySidebarMode('studio', false)
  assert.equal(attributes.has(SIDEBAR_TAKEOVER_ATTR), false, 'closing the studio restores the shell navigation')

  applySidebarMode('host', true)
  assert.equal(attributes.has(SIDEBAR_TAKEOVER_ATTR), false, 'the setting off never hides shell rows')

  applySidebarMode('studio', true)
  applySidebarMode('host', true)
  assert.equal(attributes.has(SIDEBAR_TAKEOVER_ATTR), false, 'flipping the setting live removes the attribute')
})

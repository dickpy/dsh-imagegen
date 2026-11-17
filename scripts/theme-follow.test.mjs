/** Unit tests for the shared surface helpers added with the dark-mode pass:
 *  the commit bar's docking bleed and the live theme watcher. Both modules are
 *  DOM-facing left-to-right, so the suite installs a jsdom window first. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/** A jsdom window with `getComputedStyle`, `document` and `window` installed as
 *  the globals the client modules read. */
function installDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  const { window } = dom
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.document = window.document
  globalThis.window = window
  // Node has no MutationObserver of its own; the watcher reads the browser global.
  globalThis.MutationObserver = window.MutationObserver
  return { window, document: window.document }
}

/** The bar's dock bleed, as the stylesheet consumes it. */
function bleedOf(bar) {
  return bar.style.getPropertyValue('--dsh-imagegen-commit-bleed')
}

test('the commit bar bleeds into the scroll container bottom padding', async () => {
  installDom('<div id="scroller" style="overflow-y:auto;padding-bottom:24px"><div id="card"><div id="bar"></div></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '24px', 'the host padding becomes the sticky bottom bleed')
  dispose()
})

test('a card that does not scroll keeps a zero bleed', async () => {
  installDom('<div id="card" style="padding-bottom:40px"><div id="bar"></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '0px', 'no scrolling ancestor means no docking offset')
  dispose()
})

test('the surface watcher re-applies polarity after a live theme flip', async () => {
  installDom('<div id="surface"></div>')
  const { watchSurfaceTheme } = await import('../src/client/surface-theme.ts')
  const surface = document.getElementById('surface')
  surface.style.background = 'rgb(255, 255, 255)'
  const seen = []
  const stop = watchSurfaceTheme(surface, light => { seen.push(light) })
  assert.deepEqual(seen, [true], 'the initial sample reports a light surface')

  // DSH flips dark mode by toggling this attribute and the surfaces repaint.
  document.body.setAttribute('data-ds-dark-theme', '')
  surface.style.background = 'rgb(21, 21, 23)'
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(seen, [true, false], 'the watcher reports the dark surface')

  surface.style.background = 'rgb(255, 255, 255)'
  document.body.removeAttribute('data-ds-dark-theme')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(seen, [true, false, true], 'flipping back reports light again')
  stop()
})

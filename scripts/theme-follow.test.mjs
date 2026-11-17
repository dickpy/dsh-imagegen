/** Unit tests for the shared surface helpers added with the dark-mode pass:
 *  the commit bar's docking bleed and the live theme watcher. Both modules are
 *  DOM-facing at call time, so each case installs a jsdom window as the globals
 *  they read and closes it when done. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/** A jsdom window with `getComputedStyle`, `document` and `window` installed as
 *  the globals the client modules read, plus a disposer that closes it. */
function installDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  const { window } = dom
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.document = window.document
  globalThis.window = window
  // Node has no MutationObserver of its own; the watcher reads the browser global.
  globalThis.MutationObserver = window.MutationObserver
  return { window, document: window.document, close: () => { dom.window.close() } }
}

/** Let jsdom deliver the MutationObserver records (they run as a microtask). */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 20))
}

/** The bar's dock bleed, as the stylesheet consumes it. */
function bleedOf(bar) {
  return bar.style.getPropertyValue('--dsh-imagegen-commit-bleed')
}

test('the commit bar bleeds into the scroll container bottom padding', async () => {
  const dom = installDom('<div id="scroller" style="overflow-y:auto;padding-bottom:24px"><div id="card"><div id="bar"></div></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '24px', 'the host padding becomes the sticky bottom bleed')
  dispose()
  dom.close()
})

test('a card that does not scroll keeps a zero bleed', async () => {
  const dom = installDom('<div id="card" style="padding-bottom:40px"><div id="bar"></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '0px', 'no scrolling ancestor means no docking offset')
  dispose()
  dom.close()
})

test('a hidden-overflow wrapper is the sticky reference, not an outer scroller', async () => {
  const dom = installDom('<div id="scroller" style="overflow-y:auto;padding-bottom:24px"><div id="clip" style="overflow-y:hidden"><div id="bar"></div></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '0px', 'the non-scrolling clip wrapper is what sticky resolves against')
  dispose()
  dom.close()
})

test('docking re-measures on resize and stops after dispose', async () => {
  const dom = installDom('<div id="scroller" style="overflow-y:auto;padding-bottom:24px"><div id="bar"></div></div>')
  const { dockCommitBar } = await import('../src/client/commit-bar.ts')
  const bar = document.getElementById('bar')
  const scroller = document.getElementById('scroller')
  const dispose = dockCommitBar(bar)
  assert.equal(bleedOf(bar), '24px')

  scroller.style.paddingBottom = '8px'
  dom.window.dispatchEvent(new dom.window.Event('resize'))
  assert.equal(bleedOf(bar), '8px', 'a host padding change is picked up by the resize handler')

  dispose()
  scroller.style.paddingBottom = '16px'
  dom.window.dispatchEvent(new dom.window.Event('resize'))
  assert.equal(bleedOf(bar), '8px', 'the resize listener is removed with the bar')
  dom.close()
})

test('the surface watcher re-applies polarity after a live theme flip', async () => {
  const dom = installDom('<div id="surface"></div>')
  const { watchSurfaceTheme } = await import('../src/client/surface-theme.ts')
  const surface = document.getElementById('surface')
  surface.style.background = 'rgb(255, 255, 255)'
  const seen = []
  const stop = watchSurfaceTheme(surface, light => { seen.push(light) })
  assert.deepEqual(seen, [true], 'the initial sample reports a light surface')

  // DSH flips dark mode by toggling this attribute and the surfaces repaint.
  document.body.setAttribute('data-ds-dark-theme', '')
  surface.style.background = 'rgb(21, 21, 23)'
  await settle()
  assert.deepEqual(seen, [true, false], 'the watcher reports the dark surface')

  surface.style.background = 'rgb(255, 255, 255)'
  document.body.removeAttribute('data-ds-dark-theme')
  await settle()
  assert.deepEqual(seen, [true, false, true], 'flipping back reports light again')
  stop()
  dom.close()
})

test('mutations inside one frame coalesce into a single detection', async () => {
  const dom = installDom('<div id="surface"></div>')
  const frames = []
  const cancelled = []
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  globalThis.cancelAnimationFrame = id => { cancelled.push(id) }
  const { watchSurfaceTheme } = await import('../src/client/surface-theme.ts')
  const surface = document.getElementById('surface')
  surface.style.background = 'rgb(255, 255, 255)'
  const seen = []
  const stop = watchSurfaceTheme(surface, light => { seen.push(light) })
  assert.deepEqual(seen, [true], 'the first sample is synchronous')

  document.body.setAttribute('data-ds-dark-theme', '')
  surface.style.background = 'rgb(21, 21, 23)'
  await settle()
  assert.equal(frames.length, 1, 'two observed mutations in one tick schedule one frame')
  assert.deepEqual(seen, [true], 'nothing applies before the frame runs')
  frames.shift()()
  assert.deepEqual(seen, [true, false], 'the coalesced frame applies once')

  document.body.removeAttribute('data-ds-dark-theme')
  surface.style.background = 'rgb(255, 255, 255)'
  await settle()
  assert.equal(frames.length, 1, 'a later mutation schedules the next frame')
  stop()
  assert.deepEqual(cancelled, [1], 'dispose cancels the pending frame')
  assert.deepEqual(seen, [true, false], 'no polarity is applied after dispose')
  delete globalThis.requestAnimationFrame
  delete globalThis.cancelAnimationFrame
  dom.close()
})

/**
 * Docking for the sticky commit bar the settings card renders at the end of
 * its body.
 *
 * The host scrolls the settings content inside a padded column (DSH's
 * `.options` keeps `padding-bottom: 24px`). A `position: sticky; bottom: 0`
 * bar stops *above* that padding, so while the card is longer than the panel
 * the bar floats mid-card with page content showing in the strip below it —
 * it reads as "the save row is not at the bottom" rather than as a docked
 * footer.
 *
 * `bottom: calc(-1 * padding-bottom)` puts the bar's bottom edge on the
 * panel's padding-box floor. The padding belongs to the host, so it is
 * measured at mount instead of hard-coded; the stylesheet keeps the settings
 * panel's 24px as the fallback for renderers without layout (jsdom).
 */

/** The element `position: sticky` resolves against: the nearest ancestor that
 *  establishes a scrollport. `visible` never does, and `clip` clips without
 *  becoming scrollable, so both are skipped; `hidden` does establish one (it
 *  simply cannot scroll), which is why it counts here too. */
function stickyReference(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement
  while (node !== null) {
    // jsdom reports '' for an undeclared overflow; browsers say 'visible'.
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== 'visible' && overflow !== 'clip' && overflow !== '') return node
    node = node.parentElement
  }
  return null
}

/**
 * Measure the scroll container's bottom padding into `--dsh-imagegen-commit-bleed`
 * on the bar, and keep it current across window resizes.
 * @param bar - the `position: sticky` commit bar element.
 * @returns a disposer that removes the resize listener.
 */
export function dockCommitBar(bar: HTMLElement): () => void {
  const measure = (): void => {
    const scroller = stickyReference(bar)
    const padding = scroller === null ? Number.NaN : Number.parseFloat(getComputedStyle(scroller).paddingBottom)
    // Sub-pixel used values are kept: rounding would leave a hairline gap.
    const bleed = Number.isFinite(padding) ? Math.max(0, padding) : 0
    bar.style.setProperty('--dsh-imagegen-commit-bleed', `${bleed}px`)
  }
  measure()
  window.addEventListener('resize', measure)
  return () => { window.removeEventListener('resize', measure) }
}

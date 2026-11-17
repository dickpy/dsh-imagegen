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

/** The nearest ancestor that scrolls the card (the host's options column). */
function scrollParent(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement
  while (node !== null && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node
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
    const scroller = scrollParent(bar)
    const padding = scroller === null ? Number.NaN : Number.parseFloat(getComputedStyle(scroller).paddingBottom)
    const bleed = Number.isFinite(padding) ? Math.max(0, Math.round(padding)) : 0
    bar.style.setProperty('--dsh-imagegen-commit-bleed', `${bleed}px`)
  }
  measure()
  window.addEventListener('resize', measure)
  return () => { window.removeEventListener('resize', measure) }
}

/** Walk up from an element to the first opaque surface and decide
 *  light vs dark, so ported reactbits visuals can pick their ink. Non-browser
 *  environments (jsdom smoke) have no computed styles and default to dark. */
export function detectLightSurface(element: HTMLElement): boolean {
  if (typeof globalThis.getComputedStyle !== 'function') return false
  let node: HTMLElement | null = element
  while (node !== null) {
    const color = getComputedStyle(node).backgroundColor
    const match = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,]+([\d.]+))?\s*\)/)
    if (match !== null) {
      const alpha = match[4] !== undefined ? Number(match[4]) : 1
      if (alpha >= 0.5) {
        const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
        return luminance > 0.55
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * Re-detect a surface's light/dark polarity whenever the host theme changes
 * (DSH flips `body[data-ds-dark-theme]`; the OS preference is a fallback), so a
 * ported visual that sampled its surface once does not keep the old ink after a
 * live theme switch. Detection walks the computed-style chain, so scheduled
 * runs are coalesced into one animation frame instead of one per mutation.
 * @param element - the surface whose polarity is sampled.
 * @param apply - receives the polarity on the first call and on every change.
 * @returns a disposer that stops watching.
 */
export function watchSurfaceTheme(element: HTMLElement, apply: (light: boolean) => void): () => void {
  let last: boolean | null = null
  let scheduled = 0
  const run = (): void => {
    const light = detectLightSurface(element)
    if (light === last) return
    last = light
    apply(light)
  }
  run()
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {}
  const schedule = (): void => {
    if (scheduled !== 0) return
    if (typeof requestAnimationFrame !== 'function') {
      run()
      return
    }
    scheduled = requestAnimationFrame(() => {
      scheduled = 0
      run()
    })
  }
  const observer = new MutationObserver(schedule)
  const options: MutationObserverInit = { attributes: true, attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme', 'style'] }
  observer.observe(document.documentElement, options)
  if (document.body !== null) observer.observe(document.body, options)
  const media = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener?.('change', schedule)
  return () => {
    observer.disconnect()
    if (scheduled !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled)
    scheduled = 0
    media?.removeEventListener?.('change', schedule)
  }
}

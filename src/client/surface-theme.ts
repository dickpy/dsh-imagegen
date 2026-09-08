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

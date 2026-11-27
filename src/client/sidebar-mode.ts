/**
 * Who owns the left column while the studio is open.
 *
 * The launcher is a real global panel row, not an injected DOM row, so every
 * sidebar implementation (shipped shell, Islands skin, the next one) can draw
 * it. The cost of that decision is height: every registered panel — 插件,
 * 生图, 自动化任务, 终端, … — takes a row from the same column the image
 * history lives in, so the history gets shorter with every plugin installed
 * (issue #101).
 *
 * The studio therefore has a mode:
 *  - `studio`: the left column belongs to image history. The shell's New
 *    Session button and panel list step aside, and the history surface puts
 *    `回到对话` at its own top. Height no longer depends on how many panels are
 *    installed, while the band the shell reserves for the window buttons and
 *    the brand row stay put — the history must not start under the traffic
 *    lights, and the logo is how the column still reads as DSH.
 *  - `host`: leave the shell's navigation in place and just overlay the region
 *    the shell already gives the history, which is the pre-v1.21.x behaviour.
 *
 * The attribute is on <html> so a stylesheet can claim the column without
 * React owning any shell element; the two markers it hides are set by
 * `sidebar-entry.ts` from our own launcher icon, never from a class name.
 */

/** Marks <html> while the studio owns the left column. */
export const SIDEBAR_TAKEOVER_ATTR = 'data-dsh-imagegen-sidebar-takeover'

/** Left-column presentations the studio supports. */
export type SidebarMode = 'studio' | 'host'

/**
 * Resolve the mode from a config section.
 *
 * Absent means the shipped default (takeover). Only an explicit `false` — what
 * the settings card writes, and what an older document never contains — keeps
 * the shell's navigation.
 * @param value - the plugin config section, or undefined before it loads.
 * @returns the mode to render.
 */
export function sidebarModeOf(value: { sidebarTakeover?: boolean } | undefined): SidebarMode {
  return value?.sidebarTakeover === false ? 'host' : 'studio'
}

/**
 * Publish the mode on the document element.
 *
 * A closed studio always clears the attribute: the takeover is a property of
 * the open studio, and leaving it behind would hide the host navigation with
 * nothing on screen to explain it.
 * @param mode - the resolved mode.
 * @param active - whether the studio is open.
 */
export function applySidebarMode(mode: SidebarMode, active: boolean): void {
  const root = document.documentElement
  if (active && mode === 'studio') root.setAttribute(SIDEBAR_TAKEOVER_ATTR, '')
  else root.removeAttribute(SIDEBAR_TAKEOVER_ATTR)
}

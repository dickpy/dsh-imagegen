/** Browser-local browsing preferences; templates and favorites remain host-backed. */
import { TEMPLATE_SOURCES, type TemplateCase } from '../protocol.ts'

export type TemplateApplyMode = 'replace' | 'append'
export interface TemplateEntry { sourceId: string; item: TemplateCase }
export const RECENT_TEMPLATES_KEY = 'dsh-imagegen-template-recents-v1'
export const DRAWER_WIDTH_KEY = 'dsh-imagegen-template-drawer-width'
const MAX_RECENTS = 24

export function readRecentTemplates(): TemplateEntry[] {
  try {
    const values: unknown = JSON.parse(window.localStorage.getItem(RECENT_TEMPLATES_KEY) ?? '[]')
    if (!Array.isArray(values)) return []
    return values.filter((entry): entry is TemplateEntry => {
      if (entry === null || typeof entry !== 'object' || !TEMPLATE_SOURCES.some(source => source.id === entry.sourceId)) return false
      const item = entry.item
      return item !== null && typeof item === 'object'
        && (typeof item.id === 'string' || (typeof item.id === 'number' && Number.isFinite(item.id)))
        && ['title', 'prompt', 'category', 'categoryZh', 'image', 'sourceLabel', 'sourceUrl', 'githubUrl'].every(key => typeof item[key] === 'string')
    }).map(entry => ({ ...entry, item: { ...entry.item, id: String(entry.item.id) } })).slice(0, MAX_RECENTS)
  } catch { return [] }
}

export function rememberTemplate(entry: TemplateEntry, previous: TemplateEntry[]): TemplateEntry[] {
  const next = [entry, ...previous.filter(item => item.sourceId !== entry.sourceId || String(item.item.id) !== String(entry.item.id))].slice(0, MAX_RECENTS)
  try { window.localStorage.setItem(RECENT_TEMPLATES_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
  return next
}

export function readDrawerWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY))
    return Number.isFinite(value) && value >= 0.55 && value <= 1 ? value : 0.75
  } catch { return 0.75 }
}

export function mergeTemplatePrompt(current: string, prompt: string, mode: TemplateApplyMode = 'replace'): string {
  return mode === 'append' && current.trim() !== '' ? `${current.trimEnd()}\n\n${prompt}` : prompt
}

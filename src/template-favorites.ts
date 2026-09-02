/**
 * Favorites store for the prompt-template library.
 *
 * The user's starred templates persist host-side as full case snapshots under
 * ~/.dsh/dsh-imagegen/templates/favorites.json, keyed by
 * `${sourceId}:${caseId}` — the snapshot means a favorite stays usable even
 * after the upstream list drops or renumbers the case. Framework-free
 * (node:fs only) so the route layer and tests can drive it directly.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isTemplateSourceId, type TemplateCase, type TemplateFavorite } from './protocol.ts'

const DATA_DIR = path.join(homedir(), '.dsh', 'dsh-imagegen')
const FAVORITES_PATH = path.join(DATA_DIR, 'templates', 'favorites.json')

/** Refuse to grow the file without bound; the user curates this list. */
const MAX_FAVORITES = 1000

/** In-memory memo of the persisted list. */
let memo: TemplateFavorite[] | undefined

/** Build the stable key of one case within a source. */
export function templateFavoriteKey(sourceId: string, caseId: number): string {
  return `${sourceId}:${caseId}`
}

/** Validate + normalize one raw stored favorite; undefined when unusable. */
function normalizeFavorite(raw: unknown): TemplateFavorite | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.key !== 'string' || typeof record.savedAt !== 'string') return undefined
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId : ''
  if (!isTemplateSourceId(sourceId)) return undefined
  if (record.key !== templateFavoriteKey(sourceId, Number(record.case && (record.case as TemplateCase).id))) return undefined
  const rawCase = record.case
  if (rawCase === null || typeof rawCase !== 'object') return undefined
  const item = rawCase as Record<string, unknown>
  const id = Number(item.id)
  const title = typeof item.title === 'string' ? item.title : ''
  const prompt = typeof item.prompt === 'string' ? item.prompt : ''
  if (!Number.isInteger(id) || title === '' || prompt === '') return undefined
  // Keep only the wire fields so hand-edited files cannot smuggle extras.
  const snapshot: TemplateCase = {
    id,
    title,
    prompt,
    category: typeof item.category === 'string' ? item.category : '',
    categoryZh: typeof item.categoryZh === 'string' ? item.categoryZh : '',
    styles: Array.isArray(item.styles) ? item.styles.map(String) : [],
    scenes: Array.isArray(item.scenes) ? item.scenes.map(String) : [],
    sourceLabel: typeof item.sourceLabel === 'string' ? item.sourceLabel : '',
    sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : '',
    githubUrl: typeof item.githubUrl === 'string' ? item.githubUrl : '',
    image: typeof item.image === 'string' ? item.image : '',
    featured: item.featured === true,
  }
  return { key: record.key, sourceId, savedAt: record.savedAt, case: snapshot }
}

/** Read + parse the favorites file (memoized). */
export async function listTemplateFavorites(): Promise<TemplateFavorite[]> {
  if (memo !== undefined) return memo
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(FAVORITES_PATH, 'utf8'))
    memo = Array.isArray(parsed)
      ? parsed.map(normalizeFavorite).filter((entry): entry is TemplateFavorite => entry !== undefined)
      : []
  } catch {
    memo = []
  }
  return memo
}

/** Persist the list atomically and update the memo. */
async function writeFavorites(entries: TemplateFavorite[]): Promise<void> {
  memo = entries
  await fs.mkdir(path.dirname(FAVORITES_PATH), { recursive: true })
  const tmp = `${FAVORITES_PATH}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(tmp, FAVORITES_PATH)
}

/** Star one template. Re-starring refreshes the snapshot and is idempotent. */
export async function addTemplateFavorite(sourceId: string, item: TemplateCase): Promise<TemplateFavorite[]> {
  if (!isTemplateSourceId(sourceId)) throw new Error(`未知的模板库来源：${sourceId}`)
  const key = templateFavoriteKey(sourceId, item.id)
  const rest = (await listTemplateFavorites()).filter(entry => entry.key !== key)
  const entry: TemplateFavorite = { key, sourceId, savedAt: new Date().toISOString(), case: item }
  const next = [entry, ...rest].slice(0, MAX_FAVORITES)
  await writeFavorites(next)
  return next
}

/** Unstar one template by key; unknown keys are a no-op. */
export async function removeTemplateFavorite(key: string): Promise<TemplateFavorite[]> {
  const next = (await listTemplateFavorites()).filter(entry => entry.key !== key)
  if (next.length === memo?.length) return next
  await writeFavorites(next)
  return next
}

/** Drop the in-memory memo (tests). */
export function clearTemplateFavoritesMemo(): void {
  memo = undefined
}

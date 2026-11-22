/**
 * Favorites store for the prompt-template library.
 *
 * The user's starred templates persist host-side as full case snapshots under
 * `<data root>/templates/favorites.json`, keyed by `${sourceId}:${caseId}` —
 * the snapshot means a favorite stays usable even after the upstream list
 * drops or renumbers the case. Framework-free (node:fs only) so the route
 * layer and tests can drive it directly.
 */

import { constants as fsConstants, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isTemplateSourceId, type TemplateCase, type TemplateFavorite } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'

/** The favorites file lives beside the other stores under the data root, so a
 *  DSH_HOME / localStoragePath override (and the tests) see the same root as
 *  history/gallery. */
function favoritesPath(): string {
  return path.join(imageDataRoot(), 'templates', 'favorites.json')
}

/** Test hook for the one-time legacy import; production uses the old layout
 *  under the real home directory. */
let legacyPathOverride: string | undefined

export function setLegacyFavoritesPathForTests(value: string | undefined): void {
  legacyPathOverride = value
}

function legacyFavoritesPath(): string {
  return legacyPathOverride ?? path.join(homedir(), '.dsh', 'dsh-imagegen', 'templates', 'favorites.json')
}

/** Refuse to grow the file without bound; the user curates this list. */
const MAX_FAVORITES = 1000

/** In-memory memo of the persisted list, keyed by the file it came from: the
 *  data root can change at runtime, and serving (or writing) the old root's
 *  list into the new one would overwrite that root's favorites. */
interface FavoritesMemo { path: string; entries: TemplateFavorite[] }
let memo: FavoritesMemo | undefined

/** Build the stable key of one case within a source. */
export function templateFavoriteKey(sourceId: string, caseId: string): string {
  return `${sourceId}:${caseId}`
}

/** Validate + normalize one raw stored favorite; undefined when unusable. */
function normalizeFavorite(raw: unknown): TemplateFavorite | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.key !== 'string' || typeof record.savedAt !== 'string') return undefined
  const sourceId = typeof record.sourceId === 'string' ? record.sourceId : ''
  if (!isTemplateSourceId(sourceId)) return undefined
  const rawId = record.case && (record.case as TemplateCase).id
  const id = typeof rawId === 'number' && Number.isFinite(rawId)
    ? String(rawId)
    : typeof rawId === 'string'
      ? rawId.trim()
      : ''
  if (record.key !== templateFavoriteKey(sourceId, id)) return undefined
  const rawCase = record.case
  if (rawCase === null || typeof rawCase !== 'object') return undefined
  const item = rawCase as Record<string, unknown>
  const title = typeof item.title === 'string' ? item.title : ''
  const prompt = typeof item.prompt === 'string' ? item.prompt : ''
  if (id === '' || title === '' || prompt === '') return undefined
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

/** Keep the newest backups only, so repeated corruption cannot grow unbounded. */
async function trimQuarantine(dir: string, prefix: string, keep: number): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter(name => name.startsWith(prefix)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await fs.rm(path.join(dir, name), { force: true })
    }
  } catch {
    // Best effort: pruning old backups must not block the read path.
  }
}

/**
 * Copy a corrupt favorites file aside (`.bad-<timestamp>`) before the next
 * write can overwrite it, so the starred list stays recoverable by hand. Each
 * distinct corruption episode gets its own backup (detected by file
 * size+mtime), re-reads of the same corrupt file do not, and only the newest
 * three backups are kept.
 */
let quarantineSignature = ''

async function quarantineFavorites(): Promise<void> {
  try {
    const file = favoritesPath()
    const stat = await fs.stat(file)
    const signature = `${file}:${stat.size}:${stat.mtimeMs}`
    if (signature === quarantineSignature) return
    const dir = path.dirname(file)
    const prefix = `${path.basename(file)}.bad-`
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.copyFile(file, path.join(dir, `${prefix}${stamp}`))
    quarantineSignature = signature
    await trimQuarantine(dir, prefix, 3)
  } catch {
    // Best effort: a failing backup must not block the read path.
  }
}

/** Read the favorites file; a missing file is not an error, a failed read is. */
async function readFavoritesFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** One-time import of the pre-data-root favorites file after the move. */
async function migrateLegacyFavorites(target: string): Promise<void> {
  const legacy = legacyFavoritesPath()
  if (legacy === target) return
  try {
    await fs.stat(legacy)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(legacy, target, fsConstants.COPYFILE_EXCL)
  } catch {
    // Best effort: no legacy file (or a lost race) just means nothing to import.
  }
}

/** Read + parse the favorites file (memoized per path). A corrupt file is
 *  backed up (see quarantineFavorites) instead of being silently overwritten
 *  by the next star/unstar. */
export async function listTemplateFavorites(): Promise<TemplateFavorite[]> {
  const file = favoritesPath()
  if (memo !== undefined && memo.path === file) return memo.entries
  let raw = await readFavoritesFile(file)
  if (raw === undefined) {
    await migrateLegacyFavorites(file)
    raw = await readFavoritesFile(file)
  }
  if (raw === undefined) {
    memo = { path: file, entries: [] }
    return memo.entries
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await quarantineFavorites()
    memo = { path: file, entries: [] }
    return memo.entries
  }
  if (!Array.isArray(parsed)) {
    await quarantineFavorites()
    memo = { path: file, entries: [] }
    return memo.entries
  }
  const valid = parsed.map(normalizeFavorite).filter((entry): entry is TemplateFavorite => entry !== undefined)
  if (valid.length !== parsed.length) await quarantineFavorites()
  memo = { path: file, entries: valid }
  return memo.entries
}

/** Persist the list atomically and update the memo. */
async function writeFavorites(entries: TemplateFavorite[]): Promise<void> {
  const file = favoritesPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  memo = { path: file, entries }
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
  const current = await listTemplateFavorites()
  const next = current.filter(entry => entry.key !== key)
  if (next.length === current.length) return next
  await writeFavorites(next)
  return next
}

/** Drop the in-memory memo (tests). */
export function clearTemplateFavoritesMemo(): void {
  memo = undefined
}

/**
 * Prompt-template library store (awesome-gpt-image-2 mirror).
 *
 * The case list ships as a bundled snapshot (src/templates/cases.json, inside
 * the npm package) so the library works offline out of the box; a successful
 * manual refresh writes a runtime copy under ~/.dsh/dsh-imagegen/templates/
 * which then takes precedence. Reference images are not bundled (441 files,
 * ≈100 MB) — they are fetched from the vibeui.top mirror on demand, cached on
 * disk under ~/.dsh/dsh-imagegen/template-images/, and served from there on
 * every later view.
 *
 * Framework-free (node:fs only) so the route layer and tests can drive it
 * directly.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateCase, TemplateListResult, TemplateRefreshResult } from './protocol.ts'

/** Upstream mirror the library refreshes from (vibeui.top static mirror). */
const SOURCE_URL = 'https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json'

/** Remote image directory (file names come from the case list). */
const IMAGE_BASE_URL = 'https://vibeui.top/extra/awesome-gpt-image-2/data/images/'

/** Category label map mirrored from vibeui.top's site.js (zh display names). */
const CATEGORY_ZH: Record<string, string> = {
  'Architecture & Spaces': '建筑与空间',
  'Brand & Logos': '品牌与标志',
  'Characters & People': '人物与角色',
  'Charts & Infographics': '图表与信息可视化',
  'Documents & Publishing': '文档与出版物',
  'History & Classical Themes': '历史与古风题材',
  'Illustration & Art': '插画与艺术',
  'Other Use Cases': '其他应用场景',
  'Photography & Realism': '摄影与写实',
  'Posters & Typography': '海报与排版',
  'Products & E-commerce': '商品与电商',
  'Scenes & Storytelling': '场景与叙事',
  'UI & Interfaces': 'UI 与界面',
  'Portraits & Fashion': '人像与时尚',
  'Celebrities & Sports': '名人与运动',
  'Characters & IP': '角色与 IP',
  'Food & Beverage': '美食与饮品',
  'Brand & Icons': '品牌与图标',
  'Social Media & Stickers': '社媒与表情包',
  'Infographics & Diagrams': '信息图与图解',
  'UI & App Screens': 'UI 与应用界面',
  'Architecture & Interiors': '建筑与室内',
  'Cinematic & Storytelling': '影视与叙事',
  'Illustration & Comics': '插画与漫画',
  'Historical & Fantasy': '历史与幻想',
  'Animals & Nature': '动物与自然',
  'Other Creative Uses': '其他创意用途',
}

const DATA_DIR = path.join(homedir(), '.dsh', 'dsh-imagegen')
const REFRESHED_CASES_PATH = path.join(DATA_DIR, 'templates', 'cases.json')
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'template-images')

/**
 * Bundled snapshot path. The host bundle emits to lib/index.js while this
 * source file lives at src/templates-store.ts — both exactly one level below
 * the package root — so `../src/templates/cases.json` resolves to the shipped
 * snapshot in development and in the installed package alike.
 */
const BUNDLED_CASES_PATH = fileURLToPath(new URL('../src/templates/cases.json', import.meta.url))

/** Budget for one upstream fetch (list refresh or one image). */
const FETCH_TIMEOUT_MS = 60_000

/** Refuse to cache implausibly large "images". */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Strict reference-image file names this store writes and serves. */
const IMAGE_FILE_PATTERN = /^case\d+\.(jpg|jpeg|png|webp|gif)$/i

/** The on-disk / wire shape of the case-list snapshot. */
interface CasesSnapshot {
  repository?: unknown
  fetchedAt?: unknown
  cases?: unknown
}

/** In-memory memo of the active list (avoid re-parsing on every request). */
let memo: TemplateListResult | undefined

/** Per-file in-flight downloads, so a gallery scroll never double-fetches. */
const inflightImages = new Map<string, Promise<{ data: Buffer; mime: string } | undefined>>()

/** Validate + normalize one raw upstream case; undefined when unusable. */
function normalizeCase(raw: unknown): TemplateCase | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = Number(record.id)
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  if (!Number.isInteger(id) || title === '' || prompt === '') return undefined
  const category = typeof record.category === 'string' ? record.category : ''
  const rawImage = typeof record.image === 'string' ? record.image : ''
  const image = imageFileOf(rawImage)
  return {
    id,
    title,
    prompt,
    category,
    categoryZh: CATEGORY_ZH[category] ?? category,
    styles: Array.isArray(record.styles) ? record.styles.map(String) : [],
    scenes: Array.isArray(record.scenes) ? record.scenes.map(String) : [],
    sourceLabel: typeof record.sourceLabel === 'string' ? record.sourceLabel : '',
    sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : '',
    githubUrl: typeof record.githubUrl === 'string' ? record.githubUrl : '',
    image,
    featured: record.featured === true,
  }
}

/** Extract the bare file name from an upstream image path. */
function imageFileOf(value: string): string {
  const name = value.replace(/^\/+/, '').split('/').pop() ?? ''
  return IMAGE_FILE_PATTERN.test(name) ? name : ''
}

/** Parse a snapshot payload (bundled, refreshed cache, or fresh download). */
function parseSnapshot(payload: unknown): { cases: TemplateCase[]; repository: string; fetchedAt: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const snapshot = payload as CasesSnapshot
  if (!Array.isArray(snapshot.cases)) return undefined
  const cases: TemplateCase[] = []
  for (const raw of snapshot.cases) {
    const normalized = normalizeCase(raw)
    if (normalized !== undefined) cases.push(normalized)
  }
  if (cases.length === 0) return undefined
  cases.sort((a, b) => b.id - a.id)
  return {
    cases,
    repository: typeof snapshot.repository === 'string' && snapshot.repository !== '' ? snapshot.repository : 'freestylefly/awesome-gpt-image-2',
    fetchedAt: typeof snapshot.fetchedAt === 'string' && snapshot.fetchedAt !== '' ? snapshot.fetchedAt : '',
  }
}

/** Read + parse a snapshot file; undefined when missing/corrupt. */
async function readSnapshotFile(file: string): Promise<ReturnType<typeof parseSnapshot>> {
  try {
    return parseSnapshot(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * The active template list: the refreshed runtime copy wins, the bundled
 * snapshot is the always-available fallback. Memoized; a successful refresh
 * replaces the memo.
 */
export async function listTemplates(): Promise<TemplateListResult> {
  if (memo !== undefined) return memo
  const refreshed = await readSnapshotFile(REFRESHED_CASES_PATH)
  if (refreshed !== undefined) {
    memo = { ...refreshed, total: refreshed.cases.length, origin: 'refreshed' }
    return memo
  }
  const bundled = await readSnapshotFile(BUNDLED_CASES_PATH)
  if (bundled !== undefined) {
    memo = { ...bundled, total: bundled.cases.length, origin: 'bundled' }
    return memo
  }
  memo = { cases: [], total: 0, origin: 'bundled', repository: 'freestylefly/awesome-gpt-image-2', fetchedAt: '' }
  return memo
}

/**
 * Re-download the case list from the upstream mirror and persist it as the
 * runtime copy. Throws with a user-presentable message on failure; the
 * previous list (refreshed or bundled) stays active.
 */
export async function refreshTemplates(): Promise<TemplateRefreshResult> {
  let response: Response
  try {
    response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`无法连接模板库源站：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`模板库源站拒绝请求（HTTP ${response.status}）`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('模板库源站返回了非 JSON 响应')
  }
  const parsed = parseSnapshot(payload)
  if (parsed === undefined) throw new Error('模板库源站数据格式无效')
  const fetchedAt = new Date().toISOString()
  const snapshot = {
    repository: parsed.repository,
    sourceUrl: SOURCE_URL,
    fetchedAt,
    totalCases: parsed.cases.length,
    cases: parsed.cases,
  }
  await fs.mkdir(path.dirname(REFRESHED_CASES_PATH), { recursive: true })
  const tmp = `${REFRESHED_CASES_PATH}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
  await fs.rename(tmp, REFRESHED_CASES_PATH)
  memo = { cases: parsed.cases, total: parsed.cases.length, origin: 'refreshed', repository: parsed.repository, fetchedAt }
  return { total: parsed.cases.length, fetchedAt }
}

/** MIME type for a cached reference-image file name. */
function mimeOfFile(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

/** Download one reference image into the disk cache; undefined on failure. */
async function fetchTemplateImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  let response: Response
  try {
    response = await fetch(`${IMAGE_BASE_URL}${encodeURIComponent(file)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_BYTES) return undefined
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) return undefined
  const mime = mimeOfFile(file)
  try {
    await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true })
    const tmp = path.join(IMAGE_CACHE_DIR, `${file}.tmp-${process.pid}`)
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, path.join(IMAGE_CACHE_DIR, file))
  } catch {
    // A cache-write failure must not lose the already-fetched bytes.
  }
  return { data, mime }
}

/**
 * Read one reference image for the template library. Cache hit → disk; miss →
 * fetch from the upstream mirror, cache, and serve. Only file names present in
 * the active case list are served, so the route can never act as an open
 * proxy. Undefined when the name is unknown or the fetch failed.
 */
export async function readTemplateImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  if (!IMAGE_FILE_PATTERN.test(file) || file.includes('..')) return undefined
  const list = await listTemplates()
  if (!list.cases.some(entry => entry.image === file)) return undefined
  const cached = path.join(IMAGE_CACHE_DIR, file)
  try {
    return { data: await fs.readFile(cached), mime: mimeOfFile(file) }
  } catch { /* fall through to download */ }
  const inflight = inflightImages.get(file)
  if (inflight !== undefined) return inflight
  const pending = fetchTemplateImage(file)
  inflightImages.set(file, pending)
  try {
    return await pending
  } finally {
    inflightImages.delete(file)
  }
}

/** Drop the in-memory list memo (tests). */
export function clearTemplateMemo(): void {
  memo = undefined
}

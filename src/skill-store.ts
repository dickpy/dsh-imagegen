/**
 * Local skill library (`~/.dsh/skills`).
 *
 * The canvas offers every model-invocable host skill, but the interesting
 * long-running ones (deck/document pipelines) are user-installed. This module
 * is the host side of that story: it inspects the library, installs skills from
 * a git URL / archive URL / raw `SKILL.md` URL, installs an archive the user
 * uploaded through the canvas, and removes an installed skill.
 *
 * Install safety rules:
 *
 *  - everything lands under the resolved skills root; every destination path is
 *    re-checked with `path.relative` before it is written or deleted;
 *  - an archive is extracted into a staging directory first and only promoted
 *    when it actually contains a `SKILL.md` with a frontmatter `name`;
 *  - archives are read through the same bounded ZIP reader as OOXML extraction,
 *    and the expanded size is capped;
 *  - `git` runs with a timeout in a non-interactive mode on a fixed executable
 *    name (no shell), and its failure is reported as actionable copy.
 *
 * The filesystem skill provider watches `~/.dsh/skills`, so an install becomes
 * visible to `ctx.skills` without restarting the host.
 */

import { spawn } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type {
  CanvasSkillLibrary,
  CanvasSkillLibraryEntry,
} from './protocol.ts'
import { readZipDirectory, readZipEntry, isZipDirectory } from './zip.ts'

/** Hard cap on one downloaded archive / unpacked skill folder. */
export const MAX_SKILL_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Cap on a single `SKILL.md` fetched from a raw URL. */
export const MAX_SKILL_MARKDOWN_BYTES = 2 * 1024 * 1024
/** Wall-clock cap for one install source. */
const INSTALL_TIMEOUT_MS = 180_000

/** Canonical install sources this plugin knows by name (one-click affordances). */
export const KNOWN_SKILL_SOURCES: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'image-to-editable-ppt', url: 'https://github.com/ningzimu/image-to-editable-ppt-skill' },
]

/** The upstream home of a known skill, when we know it. */
export function knownSkillUrl(name: string): string | undefined {
  return KNOWN_SKILL_SOURCES.find(entry => entry.name === name)?.url
}

/** Resolve the skills root: `DSH_HOME/skills` when known, else `~/.dsh/skills`. */
export function skillsRoot(dshHome?: string): string {
  const home = (dshHome ?? process.env.DSH_HOME ?? '').trim()
  const base = home === '' ? path.join(homedir(), '.dsh') : home
  return path.join(base, 'skills')
}

/** A user-facing failure carrying actionable copy. */
export class SkillStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillStoreError'
  }
}

/** Whether a name is a safe folder name for one skill. */
export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '.' && name !== '..'
}

/** Directory size in bytes (bounded walk), or 0 when it cannot be read. */
async function directorySize(root: string, depth = 0): Promise<number> {
  if (depth > 6) return 0
  let total = 0
  let entries: Dirent[]
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) { total += await directorySize(full, depth + 1); continue }
    if (!entry.isFile()) continue
    const info = await stat(full).catch(() => undefined)
    if (info !== undefined) total += info.size
  }
  return total
}

/** Parsed frontmatter of one `SKILL.md` (only the fields the library needs). */
interface SkillFrontmatter {
  name?: string
  description?: string
}

/**
 * Read a skill bundle's frontmatter. The DSH skill format uses a YAML head
 * between `---` fences; a bundle without frontmatter still installs (the folder
 * name becomes the skill name) but is reported as anonymous.
 * @param markdown - the `SKILL.md` contents.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (match === null) return {}
  const head = match[1]!
  const read = (key: string): string | undefined => {
    const line = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(head)
    if (line === null) return undefined
    return line[1]!.trim().replace(/^["']|["']$/g, '').trim() || undefined
  }
  return {
    ...read('name') === undefined ? {} : { name: read('name') },
    ...read('description') === undefined ? {} : { description: read('description') },
  }
}

/** First meaningful line of a skill body, used when frontmatter has no blurb. */
function firstHeading(markdown: string): string {
  const withoutHead = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  for (const raw of withoutHead.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    return line.replace(/^#+\s*/, '').slice(0, 240)
  }
  return ''
}

/** One installed skill folder as the library reports it. */
async function entryOf(root: string, name: string): Promise<CanvasSkillLibraryEntry | undefined> {
  const dir = path.join(root, name)
  const markdown = path.join(dir, 'SKILL.md')
  const known = knownSkillUrl(name)
  if (!existsSync(markdown)) {
    // A flat `<name>.md` skill is also valid in the DSH layout.
    const flat = path.join(root, `${name}.md`)
    if (!existsSync(flat)) return undefined
    const text = await readFile(flat, 'utf8').catch(() => '')
    const front = parseSkillFrontmatter(text)
    const info = await stat(flat).catch(() => undefined)
    return {
      name: front.name ?? name,
      description: front.description ?? firstHeading(text),
      sizeBytes: info?.size ?? text.length,
      updatedAt: info?.mtimeMs ?? Date.now(),
      ...known === undefined ? {} : { installUrl: known },
    }
  }
  const text = await readFile(markdown, 'utf8').catch(() => '')
  const front = parseSkillFrontmatter(text)
  const info = await stat(markdown).catch(() => undefined)
  return {
    name: front.name ?? name,
    description: front.description ?? firstHeading(text),
    path: markdown,
    sizeBytes: await directorySize(dir),
    updatedAt: info?.mtimeMs ?? Date.now(),
    ...known === undefined ? {} : { installUrl: known },
  }
}

/**
 * Inspect the library.
 * @param options - skills root plus an optional authoritative name/path list
 *   from the host registry (`ctx.skills`), which is preferred for `path`.
 * @param options.root - resolved skills root.
 * @param options.known - registry summaries, when the registry answered.
 * @param options.networkAvailable - whether installs can be attempted at all.
 */
export async function listLibrary(options: {
  root: string
  known?: ReadonlyArray<{ name: string; path?: string }>
  networkAvailable: boolean
}): Promise<CanvasSkillLibrary> {
  const { root } = options
  const names = new Set<string>()
  let children: Dirent[] = []
  try { children = await readdir(root, { withFileTypes: true }) } catch { children = [] }
  for (const child of children) {
    if (child.isDirectory() && isValidSkillName(child.name)) names.add(child.name)
    else if (child.isFile() && child.name.toLowerCase().endsWith('.md')) names.add(child.name.slice(0, -3))
  }
  const entries: CanvasSkillLibraryEntry[] = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const entry = await entryOf(root, name)
    if (entry === undefined) continue
    const registryPath = options.known?.find(item => item.name === entry.name || item.name === name)?.path
    entries.push(registryPath === undefined ? entry : { ...entry, path: registryPath })
  }
  return {
    root,
    entries,
    catalog: KNOWN_SKILL_SOURCES.map(source => ({ ...source })),
    networkAvailable: options.networkAvailable,
  }
}

/** Strip a source URL down to something printable in an error message. */
function shortSource(source: string): string {
  try {
    const url = new URL(source)
    return `${url.host}${url.pathname}`.slice(0, 120)
  } catch { return source.slice(0, 120) }
}

/** What a source URL means for the installer. */
export type SourceKind =
  | { kind: 'github'; owner: string; repo: string; ref: string; subpath: string }
  | { kind: 'raw'; url: string; name: string }
  | { kind: 'archive'; url: string }
  | { kind: 'git'; url: string; name: string }

/**
 * Classify one install source.
 * @param source - user-supplied URL (git URL, archive URL, or SKILL.md URL).
 */
export function classifySource(source: string): SourceKind {
  const trimmed = source.trim()
  const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^\s#?]*)?))?\/?$/i.exec(trimmed)
  if (github !== null) {
    const subpath = (github[4] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
    // A `blob` URL points at one file, but the surrounding folder is the bundle.
    return { kind: 'github', owner: github[1]!, repo: github[2]!, ref: github[3] ?? '', subpath }
  }
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(.+)$/i.exec(trimmed)
  if (raw !== null) {
    const file = raw[4]!
    const base = file.split('/').filter(part => part !== '').pop() ?? 'SKILL.md'
    return { kind: 'raw', url: trimmed, name: base.replace(/\.md$/i, '') }
  }
  if (/\.zip(?:[?#].*)?$/i.test(trimmed)) return { kind: 'archive', url: trimmed }
  const guessed = trimmed.split(/[?#]/)[0]!.replace(/\/+$/, '').split('/').pop() ?? ''
  return { kind: 'git', url: trimmed, name: guessed.replace(/\.git$/i, '') }
}

/** Download one URL into memory with a byte cap. */
async function download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'user-agent': 'dsh-imagegen-skill-installer', accept: '*/*' },
    })
  } catch (error) {
    throw new SkillStoreError(`下载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new SkillStoreError(`下载失败：HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > maxBytes) throw new SkillStoreError('文件超过大小上限')
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > maxBytes) throw new SkillStoreError('文件超过大小上限')
  return data
}

/** Run a command without a shell and collect its output (bounded by a timer). */
function run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    })
    let output = ''
    const collect = (chunk: Buffer): void => { if (output.length < 8_000) output += chunk.toString('utf8') }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: -1, output: `${output}\n安装超时` })
    }, options.timeoutMs)
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, output: String(error.message) })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

/** Expand a ZIP archive into `target`, refusing paths that escape it. */
async function extractArchive(data: Buffer, target: string): Promise<number> {
  const entries = readZipDirectory(data)
  if (entries.length === 0) throw new SkillStoreError('压缩包无法解析（不是有效的 ZIP）')
  let written = 0
  let expanded = 0
  for (const entry of entries) {
    const relative = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (relative === '' || relative.includes('..')) continue
    const destination = path.resolve(target, relative)
    if (path.relative(target, destination).startsWith('..')) continue
    if (isZipDirectory(entry)) {
      await mkdir(destination, { recursive: true })
      continue
    }
    const bytes = readZipEntry(data, entry, MAX_SKILL_ARCHIVE_BYTES)
    if (bytes === undefined) continue
    expanded += bytes.length
    if (expanded > MAX_SKILL_ARCHIVE_BYTES) throw new SkillStoreError('压缩包解压后超过大小上限')
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    written += 1
  }
  if (written === 0) throw new SkillStoreError('压缩包内没有可安装的文件')
  return written
}

/** Find the folder that actually holds `SKILL.md` inside an extracted tree. */
async function findSkillRoot(root: string): Promise<string | undefined> {
  if (existsSync(path.join(root, 'SKILL.md'))) return root
  let children: Dirent[]
  try { children = await readdir(root, { withFileTypes: true }) } catch { return undefined }
  const dirs = children.filter(child => child.isDirectory())
  for (const dir of dirs) {
    const candidate = path.join(root, dir.name)
    if (existsSync(path.join(candidate, 'SKILL.md'))) return candidate
  }
  // One wrapper folder (GitHub archives) with the bundle a level deeper.
  if (dirs.length === 1) return await findSkillRoot(path.join(root, dirs[0]!.name))
  return undefined
}

/** `fs.rename` can fail across volumes; fall back to a recursive copy. */
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Move a staged skill bundle into the library under a safe name. */
async function promote(staged: string, root: string, fallbackName: string, force: boolean): Promise<string> {
  const skillRoot = await findSkillRoot(staged)
  if (skillRoot === undefined) throw new SkillStoreError('该来源里没有找到 SKILL.md')
  const markdown = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8').catch(() => '')
  if (markdown.trim() === '') throw new SkillStoreError('SKILL.md 是空文件')
  const front = parseSkillFrontmatter(markdown)
  const rawName = (front.name ?? fallbackName).trim().replace(/\.git$/i, '')
  const name = isValidSkillName(rawName) ? rawName : isValidSkillName(fallbackName) ? fallbackName : ''
  if (name === '') throw new SkillStoreError('无法确定技能名：SKILL.md 的 frontmatter 缺少合法的 name')
  const destination = path.resolve(root, name)
  if (path.relative(root, destination).startsWith('..')) throw new SkillStoreError('技能名不合法')
  if (existsSync(destination) && !force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`)
  await rm(destination, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await moveInto(skillRoot, destination)
  return name
}

/**
 * Install one skill from an uploaded archive, or from a folder of files.
 * @param data - archive bytes.
 * @param root - skills root.
 * @param fallbackName - folder name to use when the bundle has no frontmatter.
 * @param force - replace an existing skill of the same name.
 */
export async function installFromArchive(data: Buffer, root: string, fallbackName: string, force: boolean): Promise<string> {
  const staging = await mkdtemp(path.join(tmpdir(), 'dsh-imagegen-skill-'))
  try {
    await extractArchive(data, staging)
    return await promote(staging, root, fallbackName, force)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Install one skill from a URL: a GitHub folder, a raw `SKILL.md`, an archive,
 * or any other git remote.
 * @param source - the URL the user supplied.
 * @param root - skills root.
 * @param options - `force` replaces an existing install; `signal` aborts.
 */
export async function installFromUrl(
  source: string,
  root: string,
  options: { force: boolean; signal?: AbortSignal; fallbackName?: string },
): Promise<string> {
  const kind = classifySource(source)
  if (kind.kind === 'raw') {
    const data = await download(kind.url, MAX_SKILL_MARKDOWN_BYTES, options.signal)
    const front = parseSkillFrontmatter(data.toString('utf8'))
    const name = (front.name ?? options.fallbackName ?? kind.name).trim()
    if (!isValidSkillName(name)) throw new SkillStoreError('无法从该链接确定技能名，请改用仓库地址')
    const destination = path.resolve(root, name)
    if (path.relative(root, destination).startsWith('..')) throw new SkillStoreError('技能名不合法')
    if (existsSync(destination) && !options.force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'SKILL.md'), data)
    return name
  }

  if (kind.kind === 'github') {
    // GitHub source archives are one cheap download and avoid a git dependency.
    const ref = kind.ref === '' ? 'HEAD' : kind.ref
    const url = `https://codeload.github.com/${kind.owner}/${kind.repo}/zip/${encodeURIComponent(ref)}`
    const data = await download(url, MAX_SKILL_ARCHIVE_BYTES, options.signal)
    const staging = await mkdtemp(path.join(tmpdir(), 'dsh-imagegen-skill-'))
    try {
      await extractArchive(data, staging)
      const wanted = kind.subpath === '' ? staging : path.resolve(staging, kind.subpath)
      const scoped = existsSync(wanted) ? wanted : staging
      return await promote(scoped, root, options.fallbackName ?? kind.repo, options.force)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ })
    }
  }

  if (kind.kind === 'archive') {
    const data = await download(kind.url, MAX_SKILL_ARCHIVE_BYTES, options.signal)
    const tail = shortSource(kind.url).split('/').pop() ?? 'skill'
    return await installFromArchive(data, root, options.fallbackName ?? tail.replace(/\.zip$/i, ''), options.force)
  }

  // Generic git remote: shallow clone into staging, then promote the bundle.
  const staging = await mkdtemp(path.join(tmpdir(), 'dsh-imagegen-skill-'))
  try {
    const result = await run('git', ['clone', '--depth', '1', '--quiet', kind.url, path.join(staging, 'repo')], {
      cwd: staging,
      timeoutMs: INSTALL_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      const detail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 300)
      throw new SkillStoreError(`git clone 失败：${detail}`)
    }
    await rm(path.join(staging, 'repo', '.git'), { recursive: true, force: true })
    return await promote(path.join(staging, 'repo'), root, options.fallbackName ?? kind.name, options.force)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Remove one installed skill.
 * @param name - the skill's folder name inside the library.
 * @param root - skills root.
 */
export async function removeSkill(name: string, root: string): Promise<string> {
  const trimmed = name.trim()
  if (!isValidSkillName(trimmed)) throw new SkillStoreError('技能名不合法')
  const dir = path.resolve(root, trimmed)
  if (path.relative(root, dir).startsWith('..')) throw new SkillStoreError('技能名不合法')
  const flat = path.resolve(root, `${trimmed}.md`)
  const hasDir = existsSync(dir)
  const hasFlat = existsSync(flat)
  if (!hasDir && !hasFlat) throw new SkillStoreError(`没有找到技能「${trimmed}」`)
  if (hasDir) await rm(dir, { recursive: true, force: true })
  if (hasFlat) await rm(flat, { force: true })
  return trimmed
}

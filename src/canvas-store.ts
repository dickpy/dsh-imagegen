/** Host-persisted infinite canvas documents and content-addressed assets. */

import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CanvasAssetRef, CanvasDocument, CanvasFileKind, CanvasNode, CanvasSummary } from './protocol.ts'
import { imageDataRoot } from './image-storage-path.ts'

/** Cap on one canvas file asset (arbitrary types travel as raw bytes). */
export const MAX_CANVAS_FILE_BYTES = 50 * 1024 * 1024

/** Text previews kept inline on the asset ref so the node can render without a fetch. */
export const MAX_FILE_TEXT_PREVIEW = 8 * 1024

/** Extensions that must never round-trip through the canvas asset store: they
 *  are the classic self-executing downloads. The client blocks them too; this
 *  is the host-side half of the same rule. */
const BLOCKED_FILE_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'dll', 'sys', 'bat', 'cmd',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'apk', 'app', 'sh', 'bash', 'command', 'reg', 'lnk', 'url', 'html', 'htm', 'xhtml', 'svg',
])

/** MIME types accepted for arbitrary files (images keep their own strict path). */
const FILE_MIME_ALLOW = /^(application\/(pdf|json|zip|x-zip-compressed|vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+|vnd\.ms-(excel|powerpoint|word)\.[a-z0-9.+-]+|vnd\.oasis\.opendocument\.[a-z0-9.+-]+|rtf|xml|javascript|typescript|x-yaml|yaml|x-sh|x-httpd-php|epub\+zip|gzip|x-7z-compressed|x-rar-compressed|x-tar|octet-stream)|text\/[a-z0-9.+-]+|image\/(png|jpeg|webp|gif|bmp|tiff)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i

/** Extension used for each accepted MIME type; unknown types become `.bin`. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/rtf': 'rtf',
  'application/xml': 'xml',
  'application/x-yaml': 'yaml',
  'application/yaml': 'yaml',
  'application/javascript': 'js',
  'application/typescript': 'ts',
  'application/epub+zip': 'epub',
  'application/gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/x-tar': 'tar',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.ms-word': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'ppsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
  'text/x-python': 'py',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  json: 'application/json',
  zip: 'application/zip',
  rtf: 'application/rtf',
  xml: 'application/xml',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  doc: 'application/vnd.ms-word',
  xls: 'application/vnd.ms-excel',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** Content-addressed names may carry any short, safe extension (see putFile). */
const ASSET_FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/

function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim().toLowerCase()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

/** Whether a MIME type carries readable text (used for inline previews). */
export function isTextMime(mime: string): boolean {
  const value = baseMime(mime)
  return value.startsWith('text/')
    || value === 'application/json'
    || value === 'application/xml'
    || value === 'application/x-yaml'
    || value === 'application/yaml'
    || value === 'application/javascript'
    || value === 'application/typescript'
}

/** MIME type inferred from a file name, used when the browser reports none. */
export function mimeFromFileName(name: string): string {
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? ''
}

/** Whether one file name may enter the canvas store at all. */
export function isBlockedFileName(name: string): boolean {
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  return extension !== '' && BLOCKED_FILE_EXTENSIONS.has(extension)
}

/** Strip directories, control characters and pathological lengths. */
export function safeFileName(value: string): string {
  const stripped = value.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = stripped.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file'
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}

/** Coarse bucket driving the file node's icon and preview branch. */
export function fileKindOf(mime: string, name = ''): CanvasFileKind {
  const value = baseMime(mime)
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  if (value === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('audio/')) return 'audio'
  if (value.startsWith('video/')) return 'video'
  if (value === 'application/zip' || value === 'application/x-zip-compressed' || value.startsWith('application/x-7z')
    || value.startsWith('application/x-rar') || value === 'application/gzip' || value === 'application/x-tar'
    || ['zip', '7z', 'rar', 'gz', 'tar'].includes(extension)) return 'archive'
  if (value.includes('openxmlformats') || value.startsWith('application/vnd.ms-') || value.startsWith('application/vnd.oasis')
    || ['pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'odt', 'odp', 'ods'].includes(extension)) return 'office'
  if (isTextMime(value) || ['md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'xml', 'txt'].includes(extension)) return 'text'
  return 'other'
}

/** Decoded head of a text file, bounded and safe against a split multi-byte
 *  character at the cut point (TextDecoder drops a trailing partial sequence). */
function textHead(data: Uint8Array): string | undefined {
  const slice = data.byteLength > MAX_FILE_TEXT_PREVIEW ? data.subarray(0, MAX_FILE_TEXT_PREVIEW) : data
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    return text.includes('\u0000') ? undefined : text
  } catch { return undefined }
}



export interface CanvasImageInput {
  data: Uint8Array
  mime: string
  width: number
  height: number
  origin: CanvasAssetRef['origin']
  originId?: string
  entryId?: string
  imageIndex?: number
  name?: string
}

/** One arbitrary file entering the canvas store through the file node. */
export interface CanvasFileInput {
  data: Uint8Array
  /** Browser-reported MIME type; the file name fills in when it is missing. */
  mime: string
  name: string
  origin: CanvasAssetRef['origin']
  originId?: string
}

export class CanvasConflictError extends Error {
  readonly code = 'canvas-conflict'
  constructor(message = '画布已在其他窗口更新，请重新加载后再保存。') {
    super(message)
    this.name = 'CanvasConflictError'
  }
}

interface IndexFile {
  projects: CanvasSummary[]
}

/** MIME type of one stored asset, derived from its content-addressed name. */
function mimeOf(file: string): string {
  const extension = path.extname(file).replace(/^\./, '').toLowerCase()
  if (MIME_BY_EXTENSION[extension] !== undefined) return MIME_BY_EXTENSION[extension]!
  switch (extension) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'js': return 'application/javascript'
    case 'ts': return 'application/typescript'
    case 'bin': return 'application/octet-stream'
    default: return 'application/octet-stream'
  }
}

function safeId(value: string): string {
  const id = value.replace(/[^a-zA-Z0-9_-]/g, '-')
  return id === '' ? randomUUID() : id
}

function pagePath(id: string): string {
  return path.join(path.join(imageDataRoot(), 'canvas', 'pages'), `${safeId(id)}.json`)
}

function assetFilePath(id: string): string | undefined {
  if (!ASSET_FILE_NAME.test(id)) return undefined
  const root = path.join(imageDataRoot(), 'canvas', 'assets')
  const file = path.join(root, id)
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return file
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(path.join(imageDataRoot(), 'canvas', 'pages'), { recursive: true })
  await fs.mkdir(path.join(imageDataRoot(), 'canvas', 'assets'), { recursive: true })
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
  await fs.rename(temp, file)
}

async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as unknown } catch { return undefined }
}

function defaultDocument(id: string, title: string): CanvasDocument {
  const now = Date.now()
  return {
    version: 2,
    id,
    title,
    revision: 1,
    viewport: { x: 0, y: 0, k: 1 },
    background: 'liquid',
    nodes: [],
    connections: [],
    createdAt: now,
    updatedAt: now,
  }
}

function isAssetRef(value: unknown): value is CanvasAssetRef {
  if (value === null || typeof value !== 'object') return false
  const asset = value as Record<string, unknown>
  if (typeof asset.assetId !== 'string' || typeof asset.url !== 'string' || typeof asset.mime !== 'string') return false
  // File assets record 0x0 (nothing to preview); image assets carry real sizes.
  const file = asset.kind === 'file'
  if (typeof asset.width !== 'number' || typeof asset.height !== 'number') return false
  if (!file && (asset.width < 1 || asset.height < 1)) return false
  if (asset.kind !== undefined && asset.kind !== 'image' && asset.kind !== 'file') return false
  if (asset.name !== undefined && typeof asset.name !== 'string') return false
  if (asset.textPreview !== undefined && typeof asset.textPreview !== 'string') return false
  return true
}

function isNode(value: unknown): value is CanvasNode {
  if (value === null || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (typeof node.id !== 'string' || typeof node.title !== 'string' || typeof node.x !== 'number'
    || typeof node.y !== 'number' || typeof node.width !== 'number' || typeof node.height !== 'number') return false
  if (node.type !== 'image' && node.type !== 'text' && node.type !== 'file' && node.type !== 'config') return false
  const metadata = node.metadata
  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object')) return false
  const state = (metadata ?? {}) as Record<string, unknown>
  if (node.type === 'image') {
    if (state.asset !== undefined && !isAssetRef(state.asset)) return false
    return state.status === undefined || state.status === 'idle' || state.status === 'generating' || state.status === 'success' || state.status === 'error'
  }
  if (node.type === 'file') {
    // A file node without an asset is the empty "click to upload" placeholder.
    return state.asset === undefined || isAssetRef(state.asset)
  }
  if (node.type === 'config') {
    return state.prompt === undefined || typeof state.prompt === 'string'
  }
  return state.text === undefined || typeof state.text === 'string'
}

function isDocument(value: unknown): value is CanvasDocument {
  if (value === null || typeof value !== 'object') return false
  const document = value as Record<string, unknown>
  return document.version === 2 && typeof document.id === 'string' && typeof document.title === 'string'
    && typeof document.revision === 'number' && document.viewport !== null && typeof document.viewport === 'object'
    && typeof (document.viewport as { x?: unknown }).x === 'number'
    && typeof (document.viewport as { y?: unknown }).y === 'number'
    && typeof (document.viewport as { k?: unknown }).k === 'number'
    && (document.background === 'dots' || document.background === 'lines' || document.background === 'blank'
      || document.background === 'image' || document.background === 'flow' || document.background === 'liquid'
      || document.background === 'floatingLines' || document.background === 'galaxy'
      || document.background === 'silk' || document.background === 'waves'
      || document.background === 'faultyTerminal' || document.background === 'dotField'
      || document.background === 'dotGrid' || document.background === 'shapeGrid')
    && (document.backgroundImage === undefined || typeof document.backgroundImage === 'string')
    && Array.isArray(document.nodes) && document.nodes.every(isNode)
    && Array.isArray(document.connections)
}

/** Upgrade a v1 (image/text/annotation + edges) document to the v2 node-graph model.
 * Images and text notes keep their geometry; annotation prompt cards become plain
 * text notes carrying the prompt, and old edges survive only between surviving nodes. */
function migrateLegacyDocument(input: Record<string, unknown>): CanvasDocument {
  const now = Date.now()
  const legacyNodes = Array.isArray(input.nodes) ? input.nodes : []
  const nodes: CanvasNode[] = []
  const annotationIds = new Set<string>()
  for (const raw of legacyNodes) {
    if (raw === null || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    if (typeof node.id !== 'string' || typeof node.x !== 'number' || typeof node.y !== 'number') continue
    const base = {
      id: node.id,
      title: typeof node.title === 'string' ? node.title : '未命名节点',
      x: node.x,
      y: node.y,
      width: typeof node.width === 'number' ? node.width : 300,
      height: typeof node.height === 'number' ? node.height : 220,
    }
    if (node.type === 'image' && isAssetRef(node.asset)) {
      const generation = (node.generation ?? {}) as Record<string, unknown>
      nodes.push({
        ...base,
        type: 'image',
        metadata: {
          asset: node.asset,
          status: (typeof node.status === 'string' && ['idle', 'generating', 'success', 'error'].includes(node.status)
            ? node.status
            : 'success') as 'idle' | 'generating' | 'success' | 'error',
          ...(typeof node.error === 'string' ? { error: node.error } : {}),
          ...(typeof generation.prompt === 'string' ? { prompt: generation.prompt } : {}),
          ...(typeof generation.model === 'string' ? { model: generation.model } : {}),
          ...(typeof generation.taskId === 'string' ? { taskId: generation.taskId } : {}),
          ...(typeof generation.sourceNodeId === 'string' ? { sourceNodeId: generation.sourceNodeId } : {}),
        },
      })
    } else if (node.type === 'text') {
      nodes.push({ ...base, type: 'text', metadata: { text: typeof node.text === 'string' ? node.text : '', ...(typeof node.fontSize === 'number' ? { fontSize: node.fontSize } : {}) } })
    } else if (node.type === 'annotation') {
      annotationIds.add(node.id)
      const prompt = typeof node.prompt === 'string' && node.prompt.trim() !== '' ? node.prompt : '（旧版标注，提示词见此）'
      nodes.push({ ...base, type: 'text', title: '旧版标注', metadata: { text: prompt } })
    }
  }
  nodes.sort((a, b) => {
    const za = (legacyNodes.find(item => (item as Record<string, unknown>)?.id === a.id) as Record<string, unknown> | undefined)?.zIndex
    const zb = (legacyNodes.find(item => (item as Record<string, unknown>)?.id === b.id) as Record<string, unknown> | undefined)?.zIndex
    return (typeof za === 'number' ? za : 0) - (typeof zb === 'number' ? zb : 0)
  })
  const validIds = new Set(nodes.map(node => node.id))
  const seen = new Set<string>()
  const connections = (Array.isArray(input.edges) ? input.edges : []).flatMap(raw => {
    if (raw === null || typeof raw !== 'object') return []
    const edge = raw as Record<string, unknown>
    if (typeof edge.fromNodeId !== 'string' || typeof edge.toNodeId !== 'string') return []
    if (annotationIds.has(edge.fromNodeId) || annotationIds.has(edge.toNodeId)) return []
    if (!validIds.has(edge.fromNodeId) || !validIds.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) return []
    const key = `${edge.fromNodeId}->${edge.toNodeId}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ id: typeof edge.id === 'string' ? edge.id : `edge-${randomUUID()}`, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }]
  })
  const legacyViewport = (input.viewport ?? {}) as Record<string, unknown>
  const background = input.background === 'grid' ? 'lines' : input.background === 'blank' ? 'blank' : 'dots'
  return {
    version: 2,
    id: typeof input.id === 'string' ? input.id : randomUUID(),
    title: typeof input.title === 'string' ? input.title : '未命名画布',
    revision: typeof input.revision === 'number' ? input.revision : 1,
    viewport: {
      x: typeof legacyViewport.x === 'number' ? legacyViewport.x : 0,
      y: typeof legacyViewport.y === 'number' ? legacyViewport.y : 0,
      k: typeof legacyViewport.scale === 'number' && legacyViewport.scale > 0 ? legacyViewport.scale : 1,
    },
    background,
    nodes,
    connections,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
  }
}

/** Background modes removed from the picker still show up in older saved
 *  documents; map them to their nearest surviving replacement. */
const REMOVED_BACKGROUND_FALLBACK: Record<string, CanvasDocument['background']> = {
  diagonal: 'lines',
  checker: 'dots',
  aurora: 'liquid',
}

/** Accept either the v2 document or a legacy v1 payload and return v2. */
function coerceDocument(value: unknown): CanvasDocument | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const document = value as Record<string, unknown>
  if (document.version === 1) {
    const migrated = migrateLegacyDocument(document)
    return isDocument(migrated) ? migrated : undefined
  }
  const fallback = REMOVED_BACKGROUND_FALLBACK[String(document.background)]
  if (fallback !== undefined) return isDocument({ ...document, background: fallback }) ? { ...document, background: fallback } as CanvasDocument : undefined
  return isDocument(value) ? value : undefined
}

let mutation: Promise<void> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutation.then(operation, operation)
  mutation = next.then(() => undefined, () => undefined)
  return next
}

export class CanvasStore {
  constructor(private readonly root?: string) {}

  private pagesDir(): string { return path.join(this.root ?? path.join(imageDataRoot(), 'canvas'), 'pages') }
  private assetsDir(): string { return path.join(this.root ?? path.join(imageDataRoot(), 'canvas'), 'assets') }
  private indexPath(): string { return path.join(this.root ?? path.join(imageDataRoot(), 'canvas'), 'index.json') }

  private async ensure(): Promise<void> {
    await fs.mkdir(this.pagesDir(), { recursive: true })
    await fs.mkdir(this.assetsDir(), { recursive: true })
  }

  private pagePath(id: string): string { return path.join(this.pagesDir(), `${safeId(id)}.json`) }
  private assetPath(id: string): string | undefined {
    if (!ASSET_FILE_NAME.test(id)) return undefined
    const target = path.join(this.assetsDir(), id)
    const relative = path.relative(this.assetsDir(), target)
    return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : target
  }

  private async readIndex(): Promise<CanvasSummary[]> {
    const value = await readJson(this.indexPath())
    if (value === undefined || typeof value !== 'object' || !Array.isArray((value as { projects?: unknown }).projects)) return []
    return (value as { projects: unknown[] }).projects.filter(item => {
      if (item === null || typeof item !== 'object') return false
      const project = item as Record<string, unknown>
      return typeof project.id === 'string' && typeof project.title === 'string' && typeof project.revision === 'number'
        && typeof project.nodeCount === 'number' && typeof project.createdAt === 'number' && typeof project.updatedAt === 'number'
    }) as CanvasSummary[]
  }

  private async writeIndex(projects: CanvasSummary[]): Promise<void> {
    await this.ensure()
    await writeJsonAtomic(this.indexPath(), { projects })
  }

  async list(): Promise<CanvasSummary[]> {
    return this.readIndex()
  }

  async create(title = '未命名画布'): Promise<CanvasDocument> {
    return serialize(async () => {
      await this.ensure()
      const id = randomUUID()
      const document = defaultDocument(id, title.trim() || '未命名画布')
      await writeJsonAtomic(this.pagePath(id), document)
      const projects = await this.readIndex()
      await this.writeIndex([this.summaryOf(document), ...projects])
      return document
    })
  }

  async read(id: string): Promise<CanvasDocument | undefined> {
    return coerceDocument(await readJson(this.pagePath(id)))
  }

  async save(document: CanvasDocument, expectedRevision?: number): Promise<CanvasDocument> {
    return serialize(async () => {
      const incoming = coerceDocument(document)
      if (incoming === undefined) throw new Error('malformed canvas document')
      const current = await this.read(incoming.id)
      if (current !== undefined && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new CanvasConflictError()
      }
      const next: CanvasDocument = {
        ...incoming,
        revision: Math.max(current?.revision ?? 0, incoming.revision) + 1,
        updatedAt: Date.now(),
      }
      await this.ensure()
      await writeJsonAtomic(this.pagePath(next.id), next)
      const projects = (await this.readIndex()).filter(item => item.id !== next.id)
      await this.writeIndex([this.summaryOf(next), ...projects])
      return next
    })
  }

  async remove(id: string): Promise<CanvasSummary[]> {
    return serialize(async () => {
      try { await fs.rm(this.pagePath(id), { force: true }) } catch { /* best effort */ }
      const projects = (await this.readIndex()).filter(item => item.id !== id)
      await this.writeIndex(projects)
      return projects
    })
  }

  /** Store raw bytes under their content hash and return the node-facing ref. */
  private async putAsset(input: {
    data: Uint8Array
    mime: string
    extension: string
    ref: Omit<CanvasAssetRef, 'assetId' | 'url' | 'mime' | 'bytes'>
  }): Promise<CanvasAssetRef> {
    await this.ensure()
    const hash = createHash('sha256').update(input.data).digest('hex')
    const file = `${hash}.${input.extension}`
    const target = path.join(this.assetsDir(), file)
    try { await fs.access(target) } catch { await fs.writeFile(target, input.data) }
    return {
      assetId: file,
      url: `/api/dsh-imagegen/canvas/asset/${file}`,
      mime: input.mime,
      bytes: input.data.byteLength,
      ...input.ref,
    }
  }

  async putImage(input: CanvasImageInput): Promise<CanvasAssetRef> {
    if (!input.data.byteLength) throw new Error('image data is empty')
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.mime)) throw new Error('unsupported image type')
    if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) {
      throw new Error('image dimensions are invalid')
    }
    return this.putAsset({
      data: input.data,
      mime: input.mime,
      extension: extensionOf(input.mime),
      ref: {
        width: input.width,
        height: input.height,
        kind: 'image',
        origin: input.origin,
        ...input.name === undefined ? {} : { name: safeFileName(input.name) },
        ...input.originId === undefined ? {} : { originId: input.originId },
        ...input.entryId === undefined ? {} : { entryId: input.entryId },
        ...input.imageIndex === undefined ? {} : { imageIndex: input.imageIndex },
      },
    })
  }

  /**
   * Store one arbitrary file (the canvas file node's upload path). Executable
   * and script-shaped extensions are refused here as well as in the browser:
   * the asset route serves non-image types as attachments, and this keeps a
   * hand-crafted request from parking one on disk in the first place.
   */
  async putFile(input: CanvasFileInput): Promise<CanvasAssetRef> {
    if (!input.data.byteLength) throw new Error('file data is empty')
    if (input.data.byteLength > MAX_CANVAS_FILE_BYTES) {
      throw new Error(`文件超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限`)
    }
    const name = safeFileName(input.name)
    if (isBlockedFileName(name)) throw new Error(`出于安全考虑，不支持上传 ${path.extname(name)} 文件`)
    const declared = baseMime(input.mime)
    const inferred = mimeFromFileName(name)
    const mime = declared !== '' && declared !== 'application/octet-stream'
      ? declared
      : (inferred !== '' ? inferred : 'application/octet-stream')
    if (!FILE_MIME_ALLOW.test(mime)) throw new Error(`不支持的文件类型：${mime}`)
    const extension = EXTENSION_BY_MIME[mime] ?? (path.extname(name).replace(/^\./, '').toLowerCase() || 'bin')
    const textPreview = isTextMime(mime) ? textHead(input.data) : undefined
    return this.putAsset({
      data: input.data,
      mime,
      extension,
      ref: {
        width: 0,
        height: 0,
        kind: 'file',
        name,
        origin: input.origin,
        ...input.originId === undefined ? {} : { originId: input.originId },
        ...textPreview === undefined ? {} : { textPreview },
      },
    })
  }

  async readAsset(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
    const target = this.assetPath(file)
    if (target === undefined) return undefined
    try { return { data: await fs.readFile(target), mime: mimeOf(file) } } catch { return undefined }
  }

  /** Read several assets at once, keyed by asset id (missing entries omitted). */
  async readAssets(refs: readonly CanvasAssetRef[]): Promise<Map<string, { data: Buffer; mime: string }>> {
    const out = new Map<string, { data: Buffer; mime: string }>()
    for (const ref of refs) {
      if (ref.assetId === '' || out.has(ref.assetId)) continue
      const found = await this.readAsset(ref.assetId)
      if (found !== undefined) out.set(ref.assetId, found)
    }
    return out
  }

  /** Copy one asset out of the content-addressed store into a real file path,
   *  so a skill run (or a headless agent) can read it as an ordinary file. */
  async materialize(ref: CanvasAssetRef, targetPath: string): Promise<void> {
    const found = await this.readAsset(ref.assetId)
    if (found === undefined) throw new Error(`画布资产不存在：${ref.assetId}`)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, found.data)
  }

  private summaryOf(document: CanvasDocument): CanvasSummary {
    return {
      id: document.id,
      title: document.title,
      revision: document.revision,
      nodeCount: document.nodes.length,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }
  }
}

export const canvasStore = new CanvasStore()

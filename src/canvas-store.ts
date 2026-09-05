/** Host-persisted infinite canvas documents and content-addressed assets. */

import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CanvasAssetRef, CanvasDocument, CanvasNode, CanvasSummary } from './protocol.ts'

const DATA_ROOT = (process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'))
const CANVAS_ROOT = path.join(DATA_ROOT, 'dsh-imagegen', 'canvas')
const PAGES_DIR = path.join(CANVAS_ROOT, 'pages')
const ASSETS_DIR = path.join(CANVAS_ROOT, 'assets')
const INDEX_PATH = path.join(CANVAS_ROOT, 'index.json')

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

function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim().toLowerCase()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

function mimeOf(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

function safeId(value: string): string {
  const id = value.replace(/[^a-zA-Z0-9_-]/g, '-')
  return id === '' ? randomUUID() : id
}

function pagePath(id: string): string {
  return path.join(PAGES_DIR, `${safeId(id)}.json`)
}

function assetFilePath(id: string): string | undefined {
  if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(id)) return undefined
  const file = path.join(ASSETS_DIR, id)
  const relative = path.relative(ASSETS_DIR, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return file
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(PAGES_DIR, { recursive: true })
  await fs.mkdir(ASSETS_DIR, { recursive: true })
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
    background: 'dots',
    nodes: [],
    connections: [],
    createdAt: now,
    updatedAt: now,
  }
}

function isAssetRef(value: unknown): value is CanvasAssetRef {
  if (value === null || typeof value !== 'object') return false
  const asset = value as Record<string, unknown>
  return typeof asset.assetId === 'string' && typeof asset.url === 'string' && typeof asset.mime === 'string'
    && typeof asset.width === 'number' && typeof asset.height === 'number'
}

function isNode(value: unknown): value is CanvasNode {
  if (value === null || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (typeof node.id !== 'string' || typeof node.title !== 'string' || typeof node.x !== 'number'
    || typeof node.y !== 'number' || typeof node.width !== 'number' || typeof node.height !== 'number') return false
  if (node.type !== 'image' && node.type !== 'text' && node.type !== 'config') return false
  const metadata = node.metadata
  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object')) return false
  const state = (metadata ?? {}) as Record<string, unknown>
  if (node.type === 'image') {
    if (state.asset !== undefined && !isAssetRef(state.asset)) return false
    return state.status === undefined || state.status === 'idle' || state.status === 'generating' || state.status === 'success' || state.status === 'error'
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
    && (document.background === 'dots' || document.background === 'lines' || document.background === 'blank')
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

/** Accept either the v2 document or a legacy v1 payload and return v2. */
function coerceDocument(value: unknown): CanvasDocument | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const document = value as Record<string, unknown>
  if (document.version === 1) {
    const migrated = migrateLegacyDocument(document)
    return isDocument(migrated) ? migrated : undefined
  }
  return isDocument(value) ? value : undefined
}

let mutation: Promise<void> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutation.then(operation, operation)
  mutation = next.then(() => undefined, () => undefined)
  return next
}

export class CanvasStore {
  constructor(private readonly root = CANVAS_ROOT) {}

  private pagesDir(): string { return path.join(this.root, 'pages') }
  private assetsDir(): string { return path.join(this.root, 'assets') }
  private indexPath(): string { return path.join(this.root, 'index.json') }

  private async ensure(): Promise<void> {
    await fs.mkdir(this.pagesDir(), { recursive: true })
    await fs.mkdir(this.assetsDir(), { recursive: true })
  }

  private pagePath(id: string): string { return path.join(this.pagesDir(), `${safeId(id)}.json`) }
  private assetPath(id: string): string | undefined {
    if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(id)) return undefined
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

  async putImage(input: CanvasImageInput): Promise<CanvasAssetRef> {
    if (!input.data.byteLength) throw new Error('image data is empty')
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.mime)) throw new Error('unsupported image type')
    if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) {
      throw new Error('image dimensions are invalid')
    }
    await this.ensure()
    const hash = createHash('sha256').update(input.data).digest('hex')
    const file = `${hash}.${extensionOf(input.mime)}`
    const target = path.join(this.assetsDir(), file)
    try { await fs.access(target) } catch { await fs.writeFile(target, input.data) }
    return {
      assetId: file,
      url: `/api/dsh-imagegen/canvas/asset/${file}`,
      mime: input.mime,
      bytes: input.data.byteLength,
      width: input.width,
      height: input.height,
      origin: input.origin,
      ...input.originId === undefined ? {} : { originId: input.originId },
      ...input.entryId === undefined ? {} : { entryId: input.entryId },
      ...input.imageIndex === undefined ? {} : { imageIndex: input.imageIndex },
    }
  }

  async readAsset(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
    const target = this.assetPath(file)
    if (target === undefined) return undefined
    try { return { data: await fs.readFile(target), mime: mimeOf(file) } } catch { return undefined }
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

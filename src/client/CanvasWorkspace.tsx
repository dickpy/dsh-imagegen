/** Infinite canvas workspace, rebuilt after the node-graph model of
 * basketikun/infinite-canvas: free nodes (image/text), drag-to-connect edges,
 * marquee + multi selection, context menus, minimap, undo/redo and a floating
 * generation composer. Selecting a node pops the composer: the prompt is typed
 * there (or supplied by connected text nodes), every upstream image node joins
 * as a reference, and results land as new image nodes on the right. */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Bold, BookOpen, ChevronDown, Copy, Download, Eraser, FileText as FileTextIcon, FolderX, Hand, Image as ImageIcon,
  Layers, Map as MapIcon, Maximize, MousePointer2, Palette, Pencil, Plus, Redo2, Scissors, SendHorizonal, Sparkles,
  SquareDashedMousePointer, Trash2, Type, Undo2, Upload, Wand2, Wallpaper, X,
} from 'lucide-react'
import type { CanvasAnnotation, CanvasAssetRef, CanvasConnection, CanvasDocument, CanvasFileKind, CanvasLayerInfo, CanvasLayerPlanItem, CanvasNode, CanvasRect, CanvasSkillDescriptor, CanvasSkillLibrary, CanvasSkillRunRequest, CanvasSkillTask, CanvasSketchStroke, GenerateRequest, GenerationTask, HistoryEntry } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { autoRemoveBackground, canvasToDataUrl, compositeAnnotatedResult, containRect, cropRaster, drawAnnotation, loadRaster, rectBetween, transparencyRatio } from './image-ops.ts'
import { TemplateLibrary } from './TemplateLibrary.tsx'
import { DotFieldBackground, DotGridBackground, FaultyTerminalBackground, FloatingLinesBackground, FlowBackground, GalaxyBackground, LiquidEtherBackground, ShapeGridBackground, SilkBackground, WavesBackground } from './CanvasBackgrounds.tsx'
import css from './canvas-workspace.module.css'

type CanvasTool = 'select' | 'pan'
type BackgroundMode = CanvasDocument['background']

const MIN_SCALE = 0.05
const MAX_SCALE = 5
const GRID_SIZE = 48
const IMAGE_NODE_SIZE = { width: 240, height: 240 }
const TEXT_NODE_SIZE = { width: 280, height: 150 }
/** File nodes mirror the host runner's footprint so produced files land in a
 *  column that matches hand-made ones. */
const FILE_NODE_SIZE = { width: 300, height: 170 }
const CONFIG_NODE_SIZE = { width: 320, height: 190 }
const LEGACY_CONFIG_NODE_SIZE = { width: 240, height: 96 }
/** Sketch boards keep a fixed frame (header + square-ish board + two tool rows)
 *  so the normalized strokes always map onto the same rect. */
const SKETCH_NODE_SIZE = { width: 300, height: 396 }
const SKETCH_EXPORT_WIDTH = 1024
const SKETCH_COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5', '#0ca678', '#f06595']
const SKETCH_WIDTHS = [3, 6, 12]
const SKETCH_WIDTH_DOTS = [5, 8, 12]
const SKETCH_ERASER_RADIUS = 16
const HISTORY_LIMIT = 60
const WORLD_PAD = 12000
/** Footprint of the prompt card the 标注 tool drops next to a boxed image. */
const ANNOTATION_TEXT_SIZE = { width: 268, height: 132 }
/** Horizontal gap used when new nodes are laid out beside their source. */
const NODE_GAP = 90
/** Smallest normalized box the annotation tool accepts (area fraction). */
const MIN_ANNOTATION_AREA = 0.0004
/** Text colors offered by the text-node palette (first entry = theme default). */
const TEXT_COLORS = ['', '#1f2328', '#ffffff', '#e03131', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5']
/** Layer-split output column: node width and vertical gap (the gap also keeps
 *  a hover toolbar, which hangs below each image node, off its neighbour). */
const LAYER_COLUMN_WIDTH = 280
const LAYER_COLUMN_GAP = 48
/** Smallest footprint a node can be resized to. */
const MIN_NODE_WIDTH = 96
const MIN_NODE_HEIGHT = 64
/** Upper bound on the nodes one menu action may cover (mirrors the host cap). */
const MAX_BATCH_SKILL_NODES = 12

interface CanvasWorkspaceProps {
  api: ImageGenApi
  imageModels: string[]
  defaultChannelId?: string
  connected: boolean
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  tasks: GenerationTask[]
  importRequest?: { source: 'history' | 'gallery'; entryId: string; imageIndex: number }
  onImportRequestHandled?: () => void
  onOpenSettings?: () => void
}

type Point = { x: number; y: number }

interface NodeDragState {
  pointerId: number
  startX: number
  startY: number
  moved: boolean
  snapshot: string | null
  origins: Map<string, Point>
}

interface PanState {
  startX: number
  startY: number
  viewportX: number
  viewportY: number
  hasMoved: boolean
  startedOnBackground: boolean
}

interface MarqueeState {
  start: Point
  current: Point
  additive: boolean
  initialIds: string[]
}

interface ConnectState {
  nodeId: string
  handleType: 'source' | 'target'
  mouse: Point
  targetId: string | null
  /** False for a plain click on the handle (opens the add-node menu), true
   *  once the pointer travels far enough that this is a drag-to-connect. */
  moved: boolean
  startClient: Point
}

/** Which corner the pointer grabbed. */
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

interface ResizeState {
  nodeId: string
  corner: ResizeCorner
  startX: number
  startY: number
  width: number
  height: number
  x: number
  y: number
  ratio: number | null
}

type ContextMenuState =
  | { type: 'canvas'; screen: Point; world: Point }
  | { type: 'node'; screen: Point; nodeId: string }
  | { type: 'connection'; screen: Point; connectionId: string }

type ProjectSummary = Awaited<ReturnType<ImageGenApi['canvasList']>>[number]

function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function imageDataUrl(image: { b64: string; mime: string }): string {
  return `data:${image.mime};base64,${image.b64}`
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 })
    image.onerror = () => reject(new Error('无法读取图片尺寸'))
    image.src = src
  })
}

async function assetToDataUrl(asset: CanvasAssetRef): Promise<string> {
  if (asset.url.startsWith('data:')) return asset.url
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error('读取画布图片失败')
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取画布图片失败'))
    reader.readAsDataURL(blob)
  })
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function sizeForAsset(asset: CanvasAssetRef): { width: number; height: number } {
  const ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1
  if (ratio >= 1) return { width: IMAGE_NODE_SIZE.width, height: Math.max(160, Math.round(IMAGE_NODE_SIZE.width / ratio)) }
  return { width: Math.max(200, Math.round(IMAGE_NODE_SIZE.height * ratio)), height: IMAGE_NODE_SIZE.height }
}

/** Node footprint for a generation size ratio such as '1:1' or '16:9'. */
function nodeSizeFromRatio(size: string | undefined, spec: { width: number; height: number }): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/.exec(size ?? '')
  if (match === null) return { ...spec }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { ...spec }
  const ratio = width / height
  return ratio >= 1
    ? { width: spec.width, height: Math.max(160, Math.round(spec.width / ratio)) }
    : { width: Math.max(200, Math.round(spec.height * ratio)), height: spec.height }
}

function nodesBounds(nodes: CanvasNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return nodes.reduce((acc, node) => ({
    minX: Math.min(acc.minX, node.x),
    minY: Math.min(acc.minY, node.y),
    maxX: Math.max(acc.maxX, node.x + node.width),
    maxY: Math.max(acc.maxY, node.y + node.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

/** Enlarge config nodes still stored at the pre-expansion default so the
 * roomier layout applies to existing canvases too. */
function normalizeConfigNodeSizes(document: CanvasDocument): CanvasDocument {
  const nodes = document.nodes.map(node => node.type === 'config'
    && node.width === LEGACY_CONFIG_NODE_SIZE.width && node.height === LEGACY_CONFIG_NODE_SIZE.height
    ? { ...node, width: CONFIG_NODE_SIZE.width, height: CONFIG_NODE_SIZE.height }
    : node)
  return nodes === document.nodes ? document : { ...document, nodes }
}

function summaryOf(document: CanvasDocument): ProjectSummary {
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    nodeCount: document.nodes.length,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function nodeMetadata(node: CanvasNode): NonNullable<CanvasNode['metadata']> {
  return node.metadata ?? {}
}

/** The single asset carried by an image or file node. */
function assetOf(node: CanvasNode): CanvasAssetRef | undefined {
  if (node.type === 'image') return nodeMetadata(node).asset
  return node.type === 'file' ? nodeMetadata(node).asset : undefined
}

function usableAsset(node: CanvasNode): CanvasAssetRef | undefined {
  const asset = assetOf(node)
  return asset !== undefined && asset.url !== '' ? asset : undefined
}

function bezierPath(from: Point, to: Point): string {
  const distance = Math.abs(to.x - from.x)
  const bend = Math.max(distance * 0.5, 50)
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`
}

function nodeAnchor(node: CanvasNode, side: 'left' | 'right'): Point {
  return { x: side === 'right' ? node.x + node.width : node.x, y: node.y + node.height / 2 }
}

function isSketchNode(node: CanvasNode): boolean {
  return node.type === 'image' && nodeMetadata(node).sketch !== undefined
}

/** Letterboxed rect of an `object-fit: contain` image inside its container. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Annotation boxes whose prompt card still exists. */
function liveAnnotations(node: CanvasNode, nodes: CanvasNode[]): CanvasAnnotation[] {
  const annotations = nodeMetadata(node).annotations ?? []
  return annotations.filter(annotation => annotation.nodeId === undefined || nodes.some(item => item.id === annotation.nodeId))
}

/** Drop annotation boxes whose prompt card was deleted, so image nodes do not
 *  accumulate invisible orphan boxes. */
function pruneAnnotations(nodes: CanvasNode[], removed: Set<string>): CanvasNode[] {
  if (removed.size === 0) return nodes
  return nodes.map(node => {
    const annotations = nodeMetadata(node).annotations
    if (annotations === undefined || annotations.length === 0) return node
    const kept = annotations.filter(annotation => annotation.nodeId === undefined || !removed.has(annotation.nodeId))
    return kept.length === annotations.length ? node : { ...node, metadata: { ...nodeMetadata(node), annotations: kept } }
  })
}

/** Expand a deletion to the prompt cards attached to the deleted image nodes,
 *  then remove everything and prune the surviving annotation lists. */
function removeNodesAndCards(nodes: CanvasNode[], requested: Set<string>): { nodes: CanvasNode[]; removed: Set<string> } {
  const removed = new Set(requested)
  for (const node of nodes) {
    if (node.type !== 'image' || !removed.has(node.id)) continue
    for (const annotation of nodeMetadata(node).annotations ?? []) {
      if (annotation.nodeId !== undefined) removed.add(annotation.nodeId)
    }
  }
  return { nodes: pruneAnnotations(nodes.filter(node => !removed.has(node.id)), removed), removed }
}

/** Prompt cards attached to an image node's annotation boxes, in box order. */
function attachedCards(image: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  if (image.type !== 'image') return []
  return liveAnnotations(image, nodes).flatMap(annotation => {
    if (annotation.nodeId === undefined) return []
    const card = nodes.find(node => node.id === annotation.nodeId)
    return card === undefined ? [] : [card]
  })
}

/** Is this node one of the prompt cards the 标注 tool hangs off an image? */
function isAnnotationCard(node: CanvasNode): boolean {
  return node.type === 'text' && nodeMetadata(node).annotation !== undefined
}

/** World-space anchor of an annotation box (its right edge, vertically centred). */
function annotationAnchor(image: CanvasNode, rect: CanvasRect): Point {
  return {
    x: image.x + (rect.x + rect.width) * image.width,
    y: image.y + (rect.y + rect.height / 2) * image.height,
  }
}

/** Clone a set of nodes plus the prompt cards attached to any cloned image
 *  node, remapping every attachment link to the copies. */
function cloneNodesWithCards(source: CanvasNode[], allNodes: CanvasNode[], dx: number, dy: number): { clones: CanvasNode[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  const clones: CanvasNode[] = []
  const push = (node: CanvasNode, metadata: CanvasNode['metadata']): void => {
    const id = newId('node')
    idMap.set(node.id, id)
    clones.push({ ...node, id, x: Math.round(node.x + dx), y: Math.round(node.y + dy), metadata: metadata ?? { ...nodeMetadata(node) } })
  }
  for (const node of source) push(node, undefined)
  for (const node of source) {
    if (node.type !== 'image') continue
    for (const card of attachedCards(node, allNodes)) {
      if (idMap.has(card.id)) continue
      const metadata = nodeMetadata(card)
      const annotation = metadata.annotation
      push(card, {
        ...metadata,
        ...annotation === undefined ? {} : { annotation: { ...annotation, sourceNodeId: idMap.get(annotation.sourceNodeId) ?? annotation.sourceNodeId } },
      })
    }
  }
  for (const clone of clones) {
    const annotations = clone.type === 'image' ? nodeMetadata(clone).annotations : undefined
    if (annotations === undefined) continue
    clone.metadata = {
      ...nodeMetadata(clone),
      annotations: annotations.map(annotation => annotation.nodeId !== undefined && idMap.has(annotation.nodeId)
        ? { ...annotation, nodeId: idMap.get(annotation.nodeId) }
        : annotation),
    }
  }
  return { clones, idMap }
}

/** New geometry for a corner drag, keeping the opposite corner pinned. */
function resizedRect(resize: ResizeState, clientDx: number, clientDy: number, scale: number): { x: number; y: number; width: number; height: number } {
  const dx = clientDx / scale
  const dy = clientDy / scale
  const east = resize.corner === 'ne' || resize.corner === 'se'
  const south = resize.corner === 'sw' || resize.corner === 'se'
  let width = Math.max(MIN_NODE_WIDTH, resize.width + (east ? dx : -dx))
  let height = Math.max(MIN_NODE_HEIGHT, resize.height + (south ? dy : -dy))
  if (resize.ratio !== null) {
    // Aspect-locked (images): follow whichever axis the pointer moved further,
    // so dragging sideways or downwards both scale the picture.
    const fromWidth = width
    const fromHeight = height / resize.ratio
    width = Math.abs(fromWidth - resize.width) >= Math.abs(fromHeight - resize.width) ? fromWidth : fromHeight
    width = Math.max(MIN_NODE_WIDTH, width)
    height = Math.max(MIN_NODE_HEIGHT, width * resize.ratio)
  }
  return {
    x: Math.round(east ? resize.x : resize.x + (resize.width - width)),
    y: Math.round(south ? resize.y : resize.y + (resize.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** Localized layer-kind badge label. */
function layerKindLabel(kind: CanvasLayerInfo['kind']): string {
  return kind === 'background' ? tt('canvas.layerKindBackground') : kind === 'object' ? tt('canvas.layerKindObject') : tt('canvas.layerKindText')
}

/** Left edge of a free vertical band beside `source`, so a freshly created
 *  column of nodes never lands on top of existing ones. */
function freeColumnX(source: CanvasNode, nodes: CanvasNode[], columnHeight: number, columnWidth: number): number {
  let x = source.x + source.width + NODE_GAP
  for (let guard = 0; guard < 24; guard += 1) {
    const clash = nodes.filter(node => node.id !== source.id
      && x < node.x + node.width + 24 && x + columnWidth > node.x - 24
      && source.y < node.y + node.height + 24 && source.y + columnHeight > node.y - 24)
    if (clash.length === 0) break
    x = Math.max(...clash.map(node => node.x + node.width)) + 48
  }
  return Math.round(x)
}

/** Inline style for a text node's content, honoring size/color/weight. */
function textStyleOf(node: CanvasNode): { fontSize: number; color?: string; fontWeight?: number } {
  const metadata = nodeMetadata(node)
  const fontSize = typeof metadata.fontSize === 'number' && metadata.fontSize > 0 ? metadata.fontSize : 13
  return {
    fontSize: Math.min(96, Math.max(8, fontSize)),
    ...metadata.color === undefined || metadata.color === '' ? {} : { color: metadata.color },
    ...metadata.bold === true ? { fontWeight: 700 } : {},
  }
}

/** Draw one normalized stroke onto a 2d context already sized to the board. */
function drawSketchStroke(ctx: CanvasRenderingContext2D, stroke: CanvasSketchStroke, boardWidth: number, boardHeight: number): void {
  ctx.strokeStyle = stroke.color
  ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const points = stroke.points
  if (points.length === 0) return
  if (points.length === 1) {
    const only = points[0]!
    ctx.beginPath()
    ctx.arc(only.x * boardWidth, only.y * boardHeight, stroke.width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  points.forEach((point, index) => {
    const x = point.x * boardWidth
    const y = point.y * boardHeight
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

/** Flatten strokes onto an opaque white PNG sized for gpt-image edits (the
 *  models treat the sketch as a plain reference image). */
function rasterizeSketch(strokes: CanvasSketchStroke[], boardWidth: number, boardHeight: number): { dataUrl: string; width: number; height: number } {
  const scale = SKETCH_EXPORT_WIDTH / Math.max(1, boardWidth)
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(boardWidth * scale))
  canvas.height = Math.max(1, Math.round(boardHeight * scale))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('canvas 2d context unavailable')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  for (const stroke of strokes) drawSketchStroke(ctx, stroke, boardWidth, boardHeight)
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

type ToolbarIconName = 'new' | 'select' | 'pan' | 'image' | 'text' | 'file' | 'sketch' | 'eraser' | 'trash' | 'undo' | 'redo' | 'fit' | 'minimap' | 'background' | 'template' | 'download' | 'duplicate' | 'sparkle' | 'send' | 'close' | 'deleteProject' | 'annotate' | 'removeBg' | 'layers' | 'bold' | 'color' | 'skill' | 'upload'

/** Lucide icons (stroke matches the DSH line style); one shared component so
 *  every dock/toolbar icon comes from the same well-drawn set. */
function ToolbarIcon({ name, size = 16 }: { name: ToolbarIconName; size?: number }): React.JSX.Element {
  const common = { size, strokeWidth: 1.6, 'aria-hidden': true as const }
  switch (name) {
    case 'new': return <Plus {...common} />
    case 'select': return <MousePointer2 {...common} />
    case 'pan': return <Hand {...common} />
    case 'image': return <ImageIcon {...common} />
    case 'text': return <Type {...common} />
    case 'file': return <FileTextIcon {...common} />
    case 'sketch': return <Pencil {...common} />
    case 'eraser': return <Eraser {...common} />
    case 'trash': return <Trash2 {...common} />
    case 'undo': return <Undo2 {...common} />
    case 'redo': return <Redo2 {...common} />
    case 'fit': return <Maximize {...common} />
    case 'minimap': return <MapIcon {...common} />
    case 'background': return <Wallpaper {...common} />
    case 'template': return <BookOpen {...common} />
    case 'download': return <Download {...common} />
    case 'duplicate': return <Copy {...common} />
    case 'sparkle': return <Sparkles {...common} />
    case 'send': return <SendHorizonal {...common} />
    case 'close': return <X {...common} />
    case 'deleteProject': return <FolderX {...common} />
    case 'annotate': return <SquareDashedMousePointer {...common} />
    case 'removeBg': return <Scissors {...common} />
    case 'layers': return <Layers {...common} />
    case 'bold': return <Bold {...common} />
    case 'color': return <Palette {...common} />
    case 'skill': return <Wand2 {...common} />
    case 'upload': return <Upload {...common} />
  }
}

/** Human-readable byte count for file nodes and the file picker. */
function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return tt('canvas.skills.fileSizeUnknown')
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Coarse bucket of one file asset (falling back to the MIME/extension). */
function fileKindOfAsset(asset: CanvasAssetRef): CanvasFileKind {
  const declared = asset.kind === 'file' ? asset.name ?? '' : ''
  const mime = asset.mime.split(';')[0]!.trim().toLowerCase()
  const extension = /\.([a-z0-9]+)$/i.exec(declared)?.[1]?.toLowerCase() ?? ''
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (/openxmlformats|vnd\.ms-|vnd\.oasis/.test(mime) || ['pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls', 'odt', 'odp', 'ods'].includes(extension)) return 'office'
  if (mime === 'application/zip' || ['zip', '7z', 'rar', 'gz', 'tar'].includes(extension)) return 'archive'
  if (mime.startsWith('text/') || mime === 'application/json' || ['md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'xml', 'txt'].includes(extension)) return 'text'
  return 'other'
}

function fileKindLabel(kind: CanvasFileKind): string {
  return tt(`canvas.skills.fileKind.${kind}` as Parameters<typeof tt>[0])
}

/** Extensions the file picker refuses before a byte leaves the browser; the
 *  host refuses them again, so this is only a fast, friendly guard. */
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'dll', 'sys', 'bat', 'cmd',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'apk', 'app', 'sh', 'bash', 'command', 'reg', 'lnk', 'url', 'html', 'htm', 'xhtml', 'svg',
])

/** Cap mirroring MAX_CANVAS_FILE_BYTES on the host. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Modal picker for the canvas skill catalog. Built-in actions come first, then
 * every host skill; incompatible entries stay visible but disabled so the menu
 * explains itself instead of hiding.
 */
function SkillPicker(props: {
  anchor: Point
  nodeType: CanvasNode['type']
  catalog: { skills: CanvasSkillDescriptor[]; reason?: string } | null
  loading: boolean
  /** Number of nodes the run will cover (1 = the acting node). */
  batchCount: number
  /** Host-skill names the registry exposes; undefined = registry unavailable. */
  installed?: ReadonlySet<string>
  onPick: (skill: CanvasSkillDescriptor) => void
  /** Open the library installer prefilled with one entry's upstream. */
  onInstall: (skill: CanvasSkillDescriptor) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const skills = (props.catalog?.skills ?? []).filter(skill => term === ''
    || skill.name.toLowerCase().includes(term)
    || skill.description.toLowerCase().includes(term))
  const builtin = skills.filter(skill => skill.origin === 'builtin')
  const external = skills.filter(skill => skill.origin === 'external')
  const compatible = (skill: CanvasSkillDescriptor): boolean => props.nodeType === 'config'
    ? false
    : skill.accepts.includes(props.nodeType)
  const missing = (skill: CanvasSkillDescriptor): boolean => props.installed !== undefined
    && skill.skillName !== undefined
    && !props.installed.has(skill.skillName)
  const row = (skill: CanvasSkillDescriptor): React.JSX.Element => {
    const needsInstall = missing(skill)
    const title = needsInstall
      ? tt('canvas.skills.missingHint', { name: skill.skillName ?? skill.name })
      : compatible(skill) ? skill.description : tt('canvas.skills.incompatible')
    return <div key={skill.id} className={css.skillRow} data-disabled={compatible(skill) ? undefined : ''}>
      <span className={css.skillRowIcon}><ToolbarIcon name={skill.tier === 'heavy' ? 'sparkle' : 'skill'} size={15} /></span>
      <button
        type="button"
        role="menuitem"
        className={css.skillRowText}
        data-plain=""
        disabled={!compatible(skill) || needsInstall}
        title={title}
        onClick={() => props.onPick(skill)}
      >
        <strong>{skill.name}</strong>
        <small>{needsInstall ? tt('canvas.skills.missingHint', { name: skill.skillName ?? skill.name }) : skill.description}</small>
      </button>
      {needsInstall
        ? <button type="button" className={css.skillInstall} onClick={() => props.onInstall(skill)}>{tt('canvas.skills.installNow')}</button>
        : <span className={css.skillTier} data-tier={skill.tier}>
            {skill.tier === 'heavy' ? tt('canvas.skills.tierHeavy') : tt('canvas.skills.tierLight')}
          </span>}
    </div>
  }
  const style: CSSProperties = {
    left: Math.max(8, Math.min(props.anchor.x, (globalThis.innerWidth || 1024) - 380)),
    top: Math.max(8, Math.min(props.anchor.y, (globalThis.innerHeight || 768) - 420)),
  }
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={css.skillMenu} style={style} role="menu" aria-label={tt('canvas.skills.pickerTitle')}>
      <header className={css.skillMenuHeader}>
        <span>{tt('canvas.skills.menuTitle')}</span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      <input
        className={css.skillSearch}
        value={query}
        autoFocus
        placeholder={tt('canvas.skills.searchPlaceholder')}
        onChange={event => setQuery(event.target.value)}
      />
      {props.batchCount > 1 ? <p className={css.skillBatch}>{tt('canvas.skills.batchNote', { count: props.batchCount })}</p> : null}
      <div className={css.skillList}>
        {props.loading && props.catalog === null ? <p className={css.skillHint}>{tt('canvas.skills.loading')}</p> : null}
        {!props.loading && skills.length === 0 ? <p className={css.skillHint}>{tt('canvas.skills.empty')}</p> : null}
        {builtin.length > 0 ? <p className={css.skillGroup}>{tt('canvas.skills.groupBuiltin')}</p> : null}
        {builtin.map(row)}
        {external.length > 0
          ? <p className={css.skillGroup}>{tt('canvas.skills.groupExternal')}</p>
          : props.catalog !== null && builtin.length > 0 ? <p className={css.skillHint}>{tt('canvas.skills.emptyExternal')}</p> : null}
        {external.map(row)}
      </div>
      {props.catalog?.reason !== undefined ? <p className={css.skillHint}>{props.catalog.reason}</p> : null}
    </div>
  </>, globalThis.document.body)
}

/**
 * Skill library manager (dock entry 「技能库」). One dialog covers the whole
 * lifecycle: what is installed, install from URLs, install from an uploaded
 * archive, and uninstall. Installs are obviously consequential (they write into
 * the user's `~/.dsh/skills`), so every action reports its own result instead of
 * acting silently.
 */
function SkillLibraryDialog(props: {
  library: CanvasSkillLibrary | null
  loading: boolean
  busy: boolean
  /** Prefill for the URL field, e.g. the upstream of a skill just clicked. */
  presetUrl: string
  onReload: () => void
  onInstallUrls: (urls: string[], force: boolean) => void
  onInstallArchive: (file: File, force: boolean) => void
  onRemove: (name: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [urls, setUrls] = useState(props.presetUrl)
  const [force, setForce] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const archiveRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (props.presetUrl !== '') setUrls(props.presetUrl) }, [props.presetUrl])
  const sourceList = urls.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const entries = props.library?.entries ?? []
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={`${css.skillDialog} ${css.libraryDialog}`} role="dialog" aria-label={tt('canvas.skills.libraryTitle')}>
      <header className={css.skillMenuHeader}>
        <span>{tt('canvas.skills.libraryTitle')}</span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      <div className={css.libraryBody}>
        <section className={css.librarySection}>
          <span className={css.librarySectionTitle}>{tt('canvas.skills.libraryInstalled', { count: entries.length })}</span>
          {props.library?.root !== undefined && props.library.root !== ''
            ? <p className={css.skillHint}>{tt('canvas.skills.libraryRoot', { root: props.library.root })}</p>
            : null}
          {props.loading && props.library === null ? <p className={css.skillHint}>{tt('canvas.skills.loading')}</p> : null}
          {!props.loading && entries.length === 0 ? <p className={css.skillHint}>{tt('canvas.skills.libraryEmpty')}</p> : null}
          {entries.length > 0 ? <div className={css.libraryList}>
            {entries.map(entry => <div key={entry.name} className={css.libraryEntry}>
              <span className={css.skillRowIcon}><ToolbarIcon name="skill" size={15} /></span>
              <span className={css.libraryEntryText}>
                <strong>{entry.name}</strong>
                <small title={entry.description}>{entry.description === '' ? entry.name : entry.description}</small>
              </span>
              <span className={css.libraryEntryMeta}>{entry.sizeBytes > 0 ? fileSizeLabel(entry.sizeBytes) : ''}</span>
              <button
                type="button"
                className={css.libraryRemove}
                disabled={props.busy || removing !== null}
                onClick={() => {
                  if (!globalThis.confirm(tt('canvas.skills.libraryRemoveConfirm', { name: entry.name }))) return
                  setRemoving(entry.name)
                  props.onRemove(entry.name)
                  window.setTimeout(() => setRemoving(null), 4_000)
                }}
              >{removing === entry.name ? tt('canvas.skills.libraryRemoving') : tt('canvas.skills.libraryRemove')}</button>
            </div>)}
          </div> : null}
        </section>
        <section className={css.librarySection}>
          <span className={css.librarySectionTitle}>{tt('canvas.skills.libraryInstall')}</span>
          <p className={css.skillHint}>{tt('canvas.skills.libraryInstallHint')}</p>
          <textarea
            className={css.skillDialogInput}
            rows={3}
            value={urls}
            placeholder={tt('canvas.skills.libraryUrlPlaceholder')}
            onChange={event => setUrls(event.target.value)}
          />
          <div className={css.libraryRow}>
            <label className={css.libraryCheck}>
              <input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
              {tt('canvas.skills.libraryForce')}
            </label>
            <span style={{ flex: 1 }} />
            <button type="button" className={css.skillGhost} disabled={props.busy} onClick={props.onReload}>{tt('canvas.skills.libraryReload')}</button>
            <button
              type="button"
              className={css.skillPrimary}
              disabled={props.busy || sourceList.length === 0}
              onClick={() => props.onInstallUrls(sourceList, force)}
            >{props.busy ? tt('canvas.skills.libraryInstalling') : tt('canvas.skills.libraryInstallAction')}</button>
          </div>
        </section>
        <section className={css.librarySection}>
          <span className={css.librarySectionTitle}>{tt('canvas.skills.libraryUpload')}</span>
          <p className={css.skillHint}>{tt('canvas.skills.libraryUploadHint')}</p>
          <div className={css.libraryRow}>
            <span style={{ flex: 1 }} />
            <button type="button" className={css.skillGhost} disabled={props.busy} onClick={() => archiveRef.current?.click()}>
              {tt('canvas.skills.libraryUpload')}
            </button>
          </div>
          <input
            ref={archiveRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) props.onInstallArchive(file, force)
            }}
          />
        </section>
      </div>
      <div className={css.skillDialogActions}>
        <button type="button" className={css.skillGhost} onClick={props.onClose}>{tt('canvas.close')}</button>
      </div>
    </div>
  </>, globalThis.document.body)
}

/**
 * Style menu behind the text node's ✨ button. One click applies the rewrite to
 * the node itself (Ctrl+Z restores the previous text), so the fastest path
 * needs no dialog; the custom row accepts an ad-hoc instruction.
 */
function PolishMenu(props: {
  anchor: Point
  batchCount: number
  busy: boolean
  onPick: (style: string, instruction?: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const styles = (['formal', 'casual', 'shorter', 'expand'] as const).map(style => ({
    style,
    label: style === 'formal' ? tt('canvas.polish.formal') : style === 'casual' ? tt('canvas.polish.casual') : style === 'shorter' ? tt('canvas.polish.shorter') : tt('canvas.polish.expand'),
  }))
  const style: CSSProperties = {
    left: Math.max(8, Math.min(props.anchor.x, (globalThis.innerWidth || 1024) - 320)),
    top: Math.max(8, Math.min(props.anchor.y, (globalThis.innerHeight || 768) - 300)),
  }
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={css.skillMenu} style={style} role="menu" aria-label={tt('canvas.polish.title')}>
      <header className={css.skillMenuHeader}>
        <span>{tt('canvas.polish.title')}</span>
        <button type="button" className={css.skillMenuClose} aria-label={tt('canvas.close')} onClick={props.onClose}><ToolbarIcon name="close" size={14} /></button>
      </header>
      {props.batchCount > 1 ? <p className={css.skillBatch}>{tt('canvas.skills.batchNote', { count: props.batchCount })}</p> : null}
      <div className={css.skillList}>
        {styles.map(item => <button
          key={item.style}
          type="button"
          role="menuitem"
          className={css.skillRow}
          disabled={props.busy}
          onClick={() => props.onPick(item.style)}
        >
          <span className={css.skillRowIcon}><ToolbarIcon name="sparkle" size={15} /></span>
          <span className={css.skillRowText}><strong>{item.label}</strong></span>
        </button>)}
      </div>
      <div className={css.polishCustom}>
        <textarea
          className={css.skillDialogInput}
          value={custom}
          placeholder={tt('canvas.polish.customPlaceholder')}
          onChange={event => setCustom(event.target.value)}
          onPointerDown={event => event.stopPropagation()}
        />
        <button
          type="button"
          className={css.skillPrimary}
          disabled={props.busy || custom.trim() === ''}
          onClick={() => props.onPick('custom', custom)}
        >{tt('canvas.polish.run')}</button>
      </div>
    </div>
  </>, globalThis.document.body)
}

/** Confirmation shown before a heavy (headless-agent) skill run. */function SkillConfirmDialog(props: {
  skill: CanvasSkillDescriptor
  onConfirm: (instruction: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [instruction, setInstruction] = useState('')
  const requires = props.skill.requires ?? []
  return createPortal(<>
    <div className={css.skillScrim} onPointerDown={props.onClose} />
    <div className={css.skillDialog} role="dialog" aria-modal="true" aria-label={tt('canvas.skills.confirmTitle')}>
      <h3>{tt('canvas.skills.confirmTitle')}</h3>
      <p className={css.skillDialogBody}>{tt('canvas.skills.confirmBody', { name: props.skill.name })}</p>
      {props.skill.costHint !== undefined ? <p className={css.skillDialogNote}>{tt('canvas.skills.confirmCost', { hint: props.skill.costHint })}</p> : null}
      {requires.length > 0 ? <p className={css.skillDialogNote}>{tt('canvas.skills.confirmRequires', { list: requires.join('；') })}</p> : null}
      <textarea
        className={css.skillDialogInput}
        value={instruction}
        placeholder={tt('canvas.skills.extraInstruction')}
        onChange={event => setInstruction(event.target.value)}
      />
      <div className={css.skillDialogActions}>
        <button type="button" className={css.skillGhost} onClick={props.onClose}>{tt('canvas.skills.confirmCancel')}</button>
        <button type="button" className={css.skillPrimary} onClick={() => props.onConfirm(instruction)}>{tt('canvas.skills.confirmRun')}</button>
      </div>
    </div>
  </>, globalThis.document.body)
}


function IconButton(props: {
  name: ToolbarIconName
  label: string
  active?: boolean
  disabled?: boolean
  size?: number
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseLeave?: () => void
}): React.JSX.Element {
  return <button
    type="button"
    className={css.iconButton}
    data-active={props.active ? '' : undefined}
    aria-label={props.label}
    title={props.label}
    disabled={props.disabled}
    onClick={props.onClick}
    onMouseEnter={props.onMouseEnter}
    onMouseLeave={props.onMouseLeave}
  ><ToolbarIcon name={props.name} size={props.size} /></button>
}

/** Styled dropdown standing in for a native <select> so the composer and the
 *  picker match the canvas visual language instead of the OS popup. The menu
 *  portals to <body>: ancestors styled with backdrop-filter (the composer's
 *  glass panel) become containing blocks for position:fixed, which used to
 *  push the menu off-screen by re-anchoring its viewport coordinates. */
function ComposerSelect(props: {
  value: string
  options: Array<{ value: string; label: string }>
  ariaLabel: string
  /** 'toolbar' renders the compact variant used by node hover toolbars. */
  variant?: 'composer' | 'toolbar'
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; minWidth: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Element && (buttonRef.current?.contains(event.target) === true || event.target.closest(`.${css.composerSelectMenu}`) !== null)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  const selected = props.options.find(option => option.value === props.value) ?? props.options[0]
  const className = props.variant === 'toolbar' ? css.toolbarSelect : css.composerSelect
  return <>
    <button
      type="button"
      ref={buttonRef}
      className={className}
      data-open={open ? '' : undefined}
      aria-label={props.ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={props.ariaLabel}
      onPointerDown={event => event.stopPropagation()}
      onClick={() => {
        if (open) { setOpen(false); return }
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect !== undefined) setPosition({ left: rect.left, top: rect.bottom + 6, minWidth: rect.width })
        setOpen(true)
      }}
    >
      <span className={css.composerSelectValue}>{selected?.label ?? ''}</span>
      <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
    </button>
    {open && position !== null ? createPortal(<div className={css.composerSelectMenu} style={{ left: position.left, top: position.top, minWidth: position.minWidth }} role="listbox" aria-label={props.ariaLabel}>
      {props.options.map(option => <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={option.value === props.value}
        data-selected={option.value === props.value ? '' : undefined}
        onClick={() => { props.onChange(option.value); setOpen(false) }}
      >{option.label}</button>)}
    </div>, document.body) : null}
  </>
}

export function CanvasWorkspace(props: CanvasWorkspaceProps): React.JSX.Element {
  const { api, imageModels, defaultChannelId, connected, history, gallery, tasks, importRequest, onImportRequestHandled, onOpenSettings } = props
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [document, setDocument] = useState<CanvasDocument | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [spacePressed, setSpacePressed] = useState(false)
  const [ctrlPressed, setCtrlPressed] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [connecting, setConnecting] = useState<ConnectState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [createMenu, setCreateMenu] = useState<{ screen: Point; world: Point } | null>(null)
  const [nodeAddMenu, setNodeAddMenu] = useState<{ nodeId: string; nodeType: CanvasNode['type']; screen: Point } | null>(null)
  const [minimapOpen, setMinimapOpen] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [backgroundMenu, setBackgroundMenu] = useState<Point | null>(null)
  const [imageMenu, setImageMenu] = useState<Point | null>(null)
  const menuCloseTimer = useRef<number | null>(null)
  const clearMenuCloseTimer = (): void => {
    if (menuCloseTimer.current !== null) { window.clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null }
  }
  const scheduleMenuClose = useCallback((): void => {
    clearMenuCloseTimer()
    menuCloseTimer.current = window.setTimeout(() => { setBackgroundMenu(null); setImageMenu(null) }, 280)
  }, [])
  /** Open one dock menu anchored to its button (root-relative) and close the
   *  other: the two menus are mutually exclusive. */
  const openDockMenu = useCallback((kind: 'image' | 'background', button: HTMLElement): void => {
    clearMenuCloseTimer()
    const bounds = button.getBoundingClientRect()
    const rootRect = rootRef.current?.getBoundingClientRect()
    const screen: Point = { x: bounds.left + bounds.width / 2 - (rootRect?.left ?? 0), y: bounds.top - (rootRect?.top ?? 0) }
    if (kind === 'image') { setImageMenu(screen); setBackgroundMenu(null) }
    else { setBackgroundMenu(screen); setImageMenu(null) }
  }, [])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [pickerTab, setPickerTab] = useState<'upload' | 'history' | 'gallery' | 'generate'>('upload')
  /** Canvas file nodes: the hidden file input plus the skill catalog overlay. */
  const fileUploadRef = useRef<HTMLInputElement>(null)
  const [fileTargetNodeId, setFileTargetNodeId] = useState<string | null>(null)
  const [skillMenu, setSkillMenu] = useState<{ screen: Point; nodeId: string } | null>(null)
  const [skillCatalog, setSkillCatalog] = useState<{ skills: CanvasSkillDescriptor[]; installed: string[]; reason?: string } | null>(null)
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false)
  /** Skill library manager (dock entry): contents, in-flight work, prefill. */
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false)
  const [skillLibrary, setSkillLibrary] = useState<CanvasSkillLibrary | null>(null)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryPresetUrl, setLibraryPresetUrl] = useState('')
  /** Toast action for a specific message: a missing skill the user can install. */
  const [errorAction, setErrorAction] = useState<{ label: string; run: () => void; forError: string } | null>(null)
  const [pendingSkill, setPendingSkill] = useState<{ skill: CanvasSkillDescriptor; nodeIds: string[]; instruction: string } | null>(null)
  /** Live skill runs: task id -> the target node's toolbar label/id. */
  const [skillRuns, setSkillRuns] = useState<Record<string, { nodeId: string; ids: string[]; label: string; stage: string }>>({})
  const [polishBusy, setPolishBusy] = useState<string | null>(null)
  const [polishNode, setPolishNode] = useState<{ screen: Point; nodeId: string } | null>(null)
  const skillRunsRef = useRef<Record<string, { nodeId: string; ids: string[]; label: string; stage: string }>>({})
  const backgroundFileRef = useRef<HTMLInputElement>(null)

  /** reactbits.dev "Dock" port: each tile spring-scales by its distance to the
   *  pointer (width/height, so neighbours part like the macOS dock) and the
   *  panel breathes taller while hovered to make room for the labels. */
  const dockOuterRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const outer = dockOuterRef.current
    const dock = dockRef.current
    if (outer === null || dock === null) return
    if (typeof window.requestAnimationFrame !== 'function') return
    const clockNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const BASE = 34
    const MAGNIFIED = 50
    const DISTANCE = 150
    const REST_HEIGHT = 42
    const HOVER_HEIGHT = MAGNIFIED + MAGNIFIED / 2 + 4
    const STIFFNESS = 170
    const DAMPING = 16
    const MASS = 0.5
    const tiles = [...dock.querySelectorAll<HTMLElement>('[data-dock-item]')].map(el => ({ el, size: BASE, velocity: 0 }))
    let outerSize = REST_HEIGHT
    let outerVelocity = 0
    let mouseX = Number.POSITIVE_INFINITY
    let hovered = false
    let raf = 0
    let running = false
    let last = clockNow()
    const step = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      let settled = true
      for (const tile of tiles) {
        let target = BASE
        if (hovered) {
          const rect = tile.el.getBoundingClientRect()
          const distance = Math.abs(mouseX - (rect.left + rect.width / 2))
          target = BASE + (MAGNIFIED - BASE) * Math.max(0, 1 - distance / DISTANCE)
        }
        tile.velocity += ((STIFFNESS * (target - tile.size) - DAMPING * tile.velocity) / MASS) * dt
        tile.size += tile.velocity * dt
        if (Math.abs(target - tile.size) > 0.15 || Math.abs(tile.velocity) > 2) settled = false
        else {
          tile.size = target
          tile.velocity = 0
        }
        tile.el.style.width = `${tile.size.toFixed(2)}px`
        tile.el.style.height = `${tile.size.toFixed(2)}px`
      }
      const outerTarget = hovered ? HOVER_HEIGHT : REST_HEIGHT
      outerVelocity += ((STIFFNESS * (outerTarget - outerSize) - DAMPING * outerVelocity) / MASS) * dt
      outerSize += outerVelocity * dt
      if (Math.abs(outerTarget - outerSize) > 0.25 || Math.abs(outerVelocity) > 3) settled = false
      else {
        outerSize = outerTarget
        outerVelocity = 0
      }
      outer.style.height = `${outerSize.toFixed(2)}px`
      if (settled) {
        running = false
        return
      }
      raf = window.requestAnimationFrame(step)
    }
    const wake = (): void => {
      if (running) return
      running = true
      last = clockNow()
      raf = window.requestAnimationFrame(step)
    }
    const onPointerMove = (event: PointerEvent): void => {
      mouseX = event.clientX
      hovered = true
      wake()
    }
    const onPointerLeave = (): void => {
      hovered = false
      mouseX = Number.POSITIVE_INFINITY
      wake()
    }
    dock.addEventListener('pointermove', onPointerMove)
    dock.addEventListener('pointerleave', onPointerLeave)
    wake()
    return () => {
      window.cancelAnimationFrame(raf)
      dock.removeEventListener('pointermove', onPointerMove)
      dock.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])
  const imageFileRef = useRef<HTMLInputElement>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false)
  const [saveState, setSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  // Image-node tools: 标注 (box -> prompt card), 移除背景 (local matting) and
  // 图层拆分 (vision layer plan -> editable nodes).
  const [annotateNodeId, setAnnotateNodeId] = useState<string | null>(null)
  const [annotationDraft, setAnnotationDraft] = useState<{ nodeId: string; rect: CanvasRect } | null>(null)
  const [busyNodes, setBusyNodes] = useState<Record<string, string>>({})
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [colorPickerNodeId, setColorPickerNodeId] = useState<string | null>(null)
  const annotationDragRef = useRef<{ nodeId: string; pointerId: number; start: Point; box: { left: number; top: number; width: number; height: number } } | null>(null)

  // Floating generation composer state.
  const [composerPrompt, setComposerPrompt] = useState('')
  const [composerModel, setComposerModel] = useState(imageModels[0] ?? '')
  const [composerSize, setComposerSize] = useState('auto')
  const [composerQuality, setComposerQuality] = useState('auto')
  const [composerCount, setComposerCount] = useState(1)
  const [composerBusy, setComposerBusy] = useState(false)

  const rootRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<CanvasDocument | null>(null)
  const selectedIdsRef = useRef<Set<string>>(selectedIds)
  const dragRef = useRef<NodeDragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const connectRef = useRef<ConnectState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)
  const panFrameRef = useRef<number | null>(null)
  const syncedRef = useRef('')
  const processedTasks = useRef(new Set<string>())
  const processedImport = useRef('')
  const localTaskIds = useRef(new Set<string>())
  const mountedAtRef = useRef(Date.now())
  const internalClipboard = useRef<{ nodes: CanvasNode[]; connections: Array<{ fromNodeId: string; toNodeId: string }> } | null>(null)
  const pastRef = useRef<string[]>([])
  const futureRef = useRef<string[]>([])
  const composerTargetRef = useRef<string | null>(null)

  documentRef.current = document
  selectedIdsRef.current = selectedIds

  // ------------------------------------------------------------ utilities

  const screenToWorld = useCallback((clientX: number, clientY: number): Point => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    const current = documentRef.current
    if (bounds === undefined || current === null) return { x: clientX, y: clientY }
    return {
      x: (clientX - bounds.left - current.viewport.x) / current.viewport.k,
      y: (clientY - bounds.top - current.viewport.y) / current.viewport.k,
    }
  }, [])

  const canvasCenter = useCallback((): Point => {
    const bounds = viewportRef.current?.getBoundingClientRect()
    const current = documentRef.current
    if (bounds === undefined || current === null) return { x: 0, y: 0 }
    return screenToWorld(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
  }, [screenToWorld])

  const beginHistory = useCallback((): string | null => {
    const current = documentRef.current
    if (current === null) return null
    const snapshot = JSON.stringify(current)
    if (pastRef.current[pastRef.current.length - 1] === snapshot) return snapshot
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), snapshot]
    futureRef.current = []
    setHistoryVersion(version => version + 1)
    return snapshot
  }, [])

  const commitSnapshot = useCallback((snapshot: string | null): void => {
    if (snapshot === null) return
    const current = documentRef.current
    if (current === null || JSON.stringify(current) === snapshot) return
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), snapshot]
    futureRef.current = []
    setHistoryVersion(version => version + 1)
  }, [])

  const updateDocument = useCallback((updater: (previous: CanvasDocument) => CanvasDocument): void => {
    setDocument(previous => previous === null ? previous : updater(previous))
  }, [])

  const mutate = useCallback((updater: (previous: CanvasDocument) => CanvasDocument): void => {
    beginHistory()
    updateDocument(updater)
  }, [beginHistory, updateDocument])

  const undo = useCallback((): void => {
    const snapshot = pastRef.current[pastRef.current.length - 1]
    const current = documentRef.current
    if (snapshot === undefined || current === null) return
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = [...futureRef.current, JSON.stringify(current)]
    setDocument(JSON.parse(snapshot) as CanvasDocument)
    setHistoryVersion(version => version + 1)
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [])

  const redo = useCallback((): void => {
    const snapshot = futureRef.current[futureRef.current.length - 1]
    const current = documentRef.current
    if (snapshot === undefined || current === null) return
    futureRef.current = futureRef.current.slice(0, -1)
    pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT), JSON.stringify(current)]
    setDocument(JSON.parse(snapshot) as CanvasDocument)
    setHistoryVersion(version => version + 1)
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [])

  const setViewport = useCallback((viewport: CanvasDocument['viewport']): void => {
    updateDocument(previous => ({ ...previous, viewport }))
  }, [updateDocument])

  // ------------------------------------------------------- node operations

  const placeNewNode = useCallback((node: CanvasNode): void => {
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, node] }))
    setSelectedIds(new Set([node.id])); setSelectedConnectionId(null)
  }, [mutate])

  const createImageNode = useCallback((asset: CanvasAssetRef, position?: Point): CanvasNode => {
    const size = sizeForAsset(asset)
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'image', title: asset.origin === 'gallery' ? tt('canvas.fromGallery') : asset.origin === 'history' ? tt('canvas.fromHistory') : tt('canvas.imageNode'),
      x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2),
      width: size.width, height: size.height,
      metadata: { asset, status: 'success' },
    }
  }, [canvasCenter])

  /** A file node with no bytes yet — clicking it opens the picker. */
  const createEmptyFileNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'file', title: tt('canvas.skills.fileNode'),
      x: Math.round(center.x - FILE_NODE_SIZE.width / 2), y: Math.round(center.y - FILE_NODE_SIZE.height / 2),
      width: FILE_NODE_SIZE.width, height: FILE_NODE_SIZE.height,
      metadata: {
        asset: { assetId: '', url: '', mime: 'application/octet-stream', bytes: 0, width: 1, height: 1, origin: 'upload', kind: 'file', name: '' },
        fileKind: 'other',
        status: 'idle',
      },
    }
  }, [canvasCenter])

  const createTextNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'text', title: tt('canvas.textNode'),
      x: Math.round(center.x - TEXT_NODE_SIZE.width / 2), y: Math.round(center.y - TEXT_NODE_SIZE.height / 2),
      width: TEXT_NODE_SIZE.width, height: TEXT_NODE_SIZE.height,
      metadata: { text: '', fontSize: 14 },
    }
  }, [canvasCenter])

  const createConfigNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'config', title: tt('canvas.configNode'),
      x: Math.round(center.x - CONFIG_NODE_SIZE.width / 2), y: Math.round(center.y - CONFIG_NODE_SIZE.height / 2),
      width: CONFIG_NODE_SIZE.width, height: CONFIG_NODE_SIZE.height,
      metadata: { status: 'idle' },
    }
  }, [canvasCenter])

  /** Sketch boards are image nodes carrying live stroke data; the rasterized
   *  PNG lands in `metadata.asset` (see SketchBoard) so they join generation
   *  as ordinary reference images. */
  const createSketchNode = useCallback((position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'), type: 'image', title: tt('canvas.sketchNode'),
      x: Math.round(center.x - SKETCH_NODE_SIZE.width / 2), y: Math.round(center.y - SKETCH_NODE_SIZE.height / 2),
      width: SKETCH_NODE_SIZE.width, height: SKETCH_NODE_SIZE.height,
      metadata: { sketch: { strokes: [] }, status: 'idle' },
    }
  }, [canvasCenter])

  /** A brand-new canvas starts with one text node wired into one config node,
   *  laid out around the visible viewport center so the workflow is obvious. */
  const seedDocument = useCallback((created: CanvasDocument): CanvasDocument => {
    if (created.nodes.length > 0) return created
    const bounds = viewportRef.current?.getBoundingClientRect()
    const viewport = created.viewport
    const center = bounds !== undefined && bounds.width > 0 && bounds.height > 0
      ? { x: (bounds.width / 2 - viewport.x) / viewport.k, y: (bounds.height / 2 - viewport.y) / viewport.k }
      : { x: 480, y: 320 }
    const config = createConfigNode(center)
    const text: CanvasNode = {
      ...createTextNode(),
      x: Math.round(config.x - TEXT_NODE_SIZE.width - 80),
      y: Math.round(config.y + (CONFIG_NODE_SIZE.height - TEXT_NODE_SIZE.height) / 2),
    }
    return {
      ...created,
      nodes: [text, config],
      connections: [{ id: newId('edge'), fromNodeId: text.id, toNodeId: config.id }],
    }
  }, [createConfigNode, createTextNode])

  const updateNodes = useCallback((updater: (nodes: CanvasNode[]) => CanvasNode[]): void => {
    updateDocument(previous => ({ ...previous, nodes: updater(previous.nodes) }))
  }, [updateDocument])

  const patchNode = useCallback((nodeId: string, patch: Partial<NonNullable<CanvasNode['metadata']>> & Partial<Pick<CanvasNode, 'title' | 'width' | 'height' | 'x' | 'y'>>): void => {
    updateNodes(nodes => nodes.map(node => node.id === nodeId
      ? { ...node, ...('title' in patch ? { title: patch.title ?? node.title } : {}), ...('x' in patch || 'y' in patch || 'width' in patch || 'height' in patch ? { x: patch.x ?? node.x, y: patch.y ?? node.y, width: patch.width ?? node.width, height: patch.height ?? node.height } : {}), metadata: { ...nodeMetadata(node), ...patch } }
      : node))
  }, [updateNodes])

  /** Sketch board write-backs. Stroke edits bypass history (the board has its
   *  own stroke-level undo); asset sync happens inside SketchBoard. */
  const patchSketchStrokes = useCallback((nodeId: string, strokes: CanvasSketchStroke[]): void => {
    patchNode(nodeId, { sketch: { strokes } })
  }, [patchNode])

  const patchSketchAsset = useCallback((nodeId: string, asset: CanvasAssetRef | undefined): void => {
    patchNode(nodeId, { asset, status: asset === undefined ? 'idle' : 'success' })
  }, [patchNode])

  const deleteSelection = useCallback((): void => {
    const ids = selectedIdsRef.current
    const connectionId = selectedConnectionId
    if (ids.size === 0 && connectionId === null) return
    const current = documentRef.current
    if (current === null) return
    const { removed } = removeNodesAndCards(current.nodes, ids)
    mutate(previous => {
      const result = removeNodesAndCards(previous.nodes, removed)
      return {
        ...previous,
        nodes: result.nodes,
        connections: previous.connections.filter(connection => !result.removed.has(connection.fromNodeId) && !result.removed.has(connection.toNodeId) && connection.id !== connectionId),
      }
    })
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [mutate, selectedConnectionId])

  /** Delete one specific node. The hover toolbar acts on the node under the
   *  pointer, never on whatever happens to be selected — clicking a button on a
   *  node that was not selected used to delete the wrong node (or nothing). */
  const deleteNode = useCallback((nodeId: string): void => {
    const current = documentRef.current
    if (current === null || !current.nodes.some(node => node.id === nodeId)) return
    const { removed } = removeNodesAndCards(current.nodes, new Set([nodeId]))
    mutate(previous => {
      const result = removeNodesAndCards(previous.nodes, removed)
      return {
        ...previous,
        nodes: result.nodes,
        connections: previous.connections.filter(connection => !result.removed.has(connection.fromNodeId) && !result.removed.has(connection.toNodeId)),
      }
    })
    setSelectedIds(previous => {
      if (!previous.has(nodeId)) return previous
      const next = new Set(previous)
      next.delete(nodeId)
      return next
    })
  }, [mutate])

  /** Duplicate one specific node (same rule as {@link deleteNode}). */
  const duplicateNode = useCallback((nodeId: string): void => {
    const current = documentRef.current
    if (current === null) return
    const source = current.nodes.find(node => node.id === nodeId)
    if (source === undefined) return
    const { clones } = cloneNodesWithCards([source], current.nodes, 40, 40)
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [mutate])

  const duplicateSelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    const source = current.nodes.filter(node => selectedIdsRef.current.has(node.id))
    const { clones, idMap } = cloneNodesWithCards(source, current.nodes, 40, 40)
    if (clones.length === 0) return
    const connections = current.connections
      .filter(connection => idMap.has(connection.fromNodeId) && idMap.has(connection.toNodeId))
      .map(connection => ({ id: newId('edge'), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)! }))
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones], connections: [...previous.connections, ...connections] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [mutate])

  const copySelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    const selected = current.nodes.filter(node => selectedIdsRef.current.has(node.id))
    // Attached 标注 cards travel with the copied image nodes.
    const cards = selected.flatMap(node => node.type === 'image' ? attachedCards(node, current.nodes) : [])
    const nodes = [...selected, ...cards.filter(card => !selectedIdsRef.current.has(card.id))]
    internalClipboard.current = {
      nodes: nodes.map(node => ({ ...node, metadata: { ...nodeMetadata(node) } })),
      connections: current.connections.filter(connection => selectedIdsRef.current.has(connection.fromNodeId) && selectedIdsRef.current.has(connection.toNodeId)).map(connection => ({ fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
    }
  }, [])

  const pasteClipboard = useCallback((position?: Point): void => {
    const clipboard = internalClipboard.current
    if (clipboard === null || clipboard.nodes.length === 0) return
    const bounds = nodesBounds(clipboard.nodes)
    const target = position ?? canvasCenter()
    const dx = target.x - (bounds.minX + (bounds.maxX - bounds.minX) / 2)
    const dy = target.y - (bounds.minY + (bounds.maxY - bounds.minY) / 2)
    const { clones, idMap } = cloneNodesWithCards(clipboard.nodes, clipboard.nodes, dx, dy)
    const connections = clipboard.connections.map(connection => ({ id: newId('edge'), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)! }))
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones], connections: [...previous.connections, ...connections] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [canvasCenter, mutate])

  const connectNodes = useCallback((fromNodeId: string, toNodeId: string): void => {
    if (fromNodeId === toNodeId) return
    const current = documentRef.current
    if (current === null) return
    if (current.connections.some(connection => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)) return
    mutate(previous => ({ ...previous, connections: [...previous.connections, { id: newId('edge'), fromNodeId, toNodeId }] }))
  }, [mutate])

  /** Dify-style quick add: create a node to the right of `sourceId`, vertically
   *  centered against it, and wire source -> new node in one history step. The
   *  target spot walks right past any node already occupying it, and the
   *  viewport pans just enough to keep the new node visible. */
  const addConnectedNode = useCallback((sourceId: string, factory: (position: Point) => CanvasNode): void => {
    const current = documentRef.current
    if (current === null) return
    const source = current.nodes.find(item => item.id === sourceId)
    if (source === undefined) return
    const draft = factory({ x: 0, y: 0 })
    const y = Math.round(source.y + (source.height - draft.height) / 2)
    let x = source.x + source.width + 90
    for (let guard = 0; guard < 24; guard += 1) {
      const clash = current.nodes.find(node =>
        Math.abs((y + draft.height / 2) - (node.y + node.height / 2)) < (draft.height + node.height) / 2 + 20
        && x < node.x + node.width + 48
        && x + draft.width > node.x - 48)
      if (clash === undefined) break
      x = clash.x + clash.width + 88
    }
    const node: CanvasNode = { ...draft, x, y }
    mutate(previous => ({
      ...previous,
      nodes: [...previous.nodes, node],
      connections: [...previous.connections, { id: newId('edge'), fromNodeId: sourceId, toNodeId: node.id }],
    }))
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const viewport = current.viewport
    const k = viewport.k
    const left = viewport.x + x * k
    const right = viewport.x + (x + draft.width) * k
    const top = viewport.y + y * k
    const bottom = viewport.y + (y + draft.height) * k
    let dx = 0
    let dy = 0
    if (right > bounds.width - 24) dx = right - (bounds.width - 24)
    if (bottom > bounds.height - 24) dy = bottom - (bounds.height - 24)
    if (dx !== 0 || dy !== 0) setViewport({ x: viewport.x - dx, y: viewport.y - dy, k })
  }, [mutate, setViewport])

  /** Anchor the add-node menu at the source handle's on-screen position. The
   *  menu opens on hover (no click needed) and lingers briefly on leave. */
  const nodeAddMenuTimer = useRef<number | null>(null)
  const clearNodeAddMenuTimer = useCallback((): void => {
    if (nodeAddMenuTimer.current !== null) { window.clearTimeout(nodeAddMenuTimer.current); nodeAddMenuTimer.current = null }
  }, [])
  const scheduleNodeAddMenuClose = useCallback((): void => {
    clearNodeAddMenuTimer()
    nodeAddMenuTimer.current = window.setTimeout(() => setNodeAddMenu(null), 260)
  }, [clearNodeAddMenuTimer])
  const openNodeAddMenu = useCallback((node: CanvasNode): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    clearNodeAddMenuTimer()
    const viewport = current.viewport
    setNodeAddMenu({
      nodeId: node.id,
      nodeType: node.type,
      screen: {
        x: bounds.left + viewport.x + (node.x + node.width) * viewport.k,
        y: bounds.top + viewport.y + (node.y + node.height / 2) * viewport.k,
      },
    })
  }, [clearNodeAddMenuTimer])

  const downloadNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.url === '') return
    const link = globalThis.document.createElement('a')
    link.href = asset.url
    link.download = `${node.title || 'canvas-image'}.${asset.assetId.split('.').pop() ?? 'png'}`
    link.target = '_blank'
    link.rel = 'noopener'
    link.click()
  }, [])

  const upstreamNodes = useCallback((canvasDocument: CanvasDocument, nodeId: string): CanvasNode[] => {
    const byId = new Map(canvasDocument.nodes.map(node => [node.id, node]))
    return canvasDocument.connections
      .filter(connection => connection.toNodeId === nodeId)
      .map(connection => byId.get(connection.fromNodeId))
      .filter((node): node is CanvasNode => node !== undefined)
  }, [])

  // --------------------------------------------------------- skills / files

  /** Create a file node for an uploaded or produced asset. */
  const createFileNode = useCallback((asset: CanvasAssetRef, position?: Point): CanvasNode => {
    const center = position ?? canvasCenter()
    return {
      id: newId('node'),
      type: 'file',
      title: asset.name ?? tt('canvas.skills.fileNode'),
      x: Math.round(center.x - FILE_NODE_SIZE.width / 2),
      y: Math.round(center.y - FILE_NODE_SIZE.height / 2),
      width: FILE_NODE_SIZE.width,
      height: FILE_NODE_SIZE.height,
      metadata: { asset, fileKind: fileKindOfAsset(asset), status: 'success' },
    }
  }, [canvasCenter])

  /** Upload one file and place it as a node (or fill the empty placeholder). */
  const uploadCanvasFile = useCallback(async (file: File, targetNodeId?: string | null, position?: Point): Promise<void> => {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
    if (BLOCKED_UPLOAD_EXTENSIONS.has(extension)) {
      setError(tt('canvas.skills.fileTypeBlocked', { ext: `.${extension}` }))
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(tt('canvas.skills.fileTooLarge', { size: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) }))
      return
    }
    try {
      const asset = await api.canvasFileUpload(file)
      const nodeId = targetNodeId ?? null
      if (nodeId !== null) {
        // An empty file node adopts the asset instead of growing a sibling.
        patchNode(nodeId, { asset, fileKind: fileKindOfAsset(asset), status: 'success' })
        mutate(previous => ({
          ...previous,
          nodes: previous.nodes.map(node => node.id === nodeId ? { ...node, title: asset.name ?? node.title } : node),
        }))
        return
      }
      placeNewNode(createFileNode(asset, position))
    } catch (caught) {
      setError(tt('canvas.skills.fileUploadFailed', { message: errorMessage(caught) }))
    }
  }, [api, createFileNode, mutate, patchNode, placeNewNode])

  /** Lazy skill catalog; failures land in the picker's reason line. */
  const loadSkillCatalog = useCallback(async (): Promise<void> => {
    if (skillCatalogLoading) return
    setSkillCatalogLoading(true)
    try {
      const catalog = await api.canvasSkillsList()
      setSkillCatalog({
        skills: catalog.skills,
        installed: catalog.installed ?? [],
        ...catalog.reason === undefined ? {} : { reason: catalog.reason },
      })
    } catch (caught) {
      setSkillCatalog({ skills: [], installed: [], reason: errorMessage(caught) })
    } finally {
      setSkillCatalogLoading(false)
    }
  }, [api, skillCatalogLoading])

  /** Reload the skill library listing (dock dialog and post-install refresh). */
  const loadSkillLibrary = useCallback(async (): Promise<void> => {
    setLibraryLoading(true)
    try {
      setSkillLibrary(await api.canvasSkillLibrary())
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryLoading(false)
    }
  }, [api])

  /** Open the library manager, optionally prefilled with one upstream. */
  const openSkillLibrary = useCallback((presetUrl = ''): void => {
    setLibraryPresetUrl(presetUrl)
    setSkillLibraryOpen(true)
    void loadSkillLibrary()
  }, [loadSkillLibrary])

  /** Install one archive the user picked in the library dialog. */
  const installSkillArchive = useCallback(async (file: File, force: boolean): Promise<void> => {
    setLibraryBusy(true)
    try {
      const asset = await api.canvasFileUpload(file)
      const result = await api.canvasSkillInstall({ asset, force, name: file.name.replace(/\.zip$/i, '') })
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.installed.length > 0) setNotice(tt('canvas.skills.libraryInstalledToast', { names: result.installed.join('、') }))
      else setError(tt('canvas.skills.installArchiveFailed', { message: result.message ?? '' }))
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  /** Install skills from one or more URLs. */
  const installSkillUrls = useCallback(async (sources: string[], force: boolean): Promise<void> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillInstall({ sources, force })
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.installed.length > 0) {
        setNotice(tt('canvas.skills.libraryInstalledToast', { names: result.installed.join('、') }))
        setLibraryPresetUrl('')
      }
      const failure = result.failed[0]
      if (failure !== undefined) setError(tt('canvas.skills.libraryFailedToast', { message: failure.message }))
      else if (result.installed.length === 0 && result.message !== undefined) setError(result.message)
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  /** Uninstall one skill. */
  const removeSkillEntry = useCallback(async (name: string): Promise<void> => {
    setLibraryBusy(true)
    try {
      const result = await api.canvasSkillRemove(name)
      if (result.library !== undefined) setSkillLibrary(result.library)
      if (result.ok) setNotice(tt('canvas.skills.libraryRemovedToast', { name }))
      else setError(result.message ?? '')
      await loadSkillCatalog()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLibraryBusy(false)
    }
  }, [api, loadSkillCatalog])

  const openSkillMenu = useCallback((node: CanvasNode, anchor: { x: number; y: number }): void => {
    if (!selectedIdsRef.current.has(node.id)) setSelectedIds(new Set([node.id]))
    setContextMenu(null); setCreateMenu(null); setImageMenu(null); setBackgroundMenu(null); setNodeAddMenu(null)
    setSkillMenu({ screen: anchor, nodeId: node.id })
    void loadSkillCatalog()
  }, [loadSkillCatalog])

  /** Queue one skill run through the host and track its task. */
  const startSkillRun = useCallback(async (
    skill: CanvasSkillDescriptor,
    nodeIds: string[],
    instruction?: string,
  ): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    const focus = nodeIds.find(id => current.nodes.some(node => node.id === id)) ?? nodeIds[0]
    if (focus === undefined) return
    const request: CanvasSkillRunRequest = {
      canvasId: current.id,
      skillId: skill.id,
      nodeIds,
      ...instruction === undefined || instruction.trim() === '' ? {} : { instruction: instruction.trim() },
      ...skill.id === 'polish.text' ? { params: { style: (instruction ?? '').trim() === '' ? 'formal' : 'custom' } } : {},
    }
    try {
      const task = await api.canvasSkillRun(request)
      setBusyNodes(previous => ({ ...previous, [focus]: `${skill.name} · ${task.stage ?? ''}` }))
      setSkillRuns(previous => ({ ...previous, [task.id]: { nodeId: focus, ids: [...nodeIds], label: skill.name, stage: task.stage ?? '' } }))
      setNotice(tt('canvas.skills.runStarted', { name: skill.name }))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [api])

  /** Node set one skill run should cover: the acting node plus the compatible
   *  siblings when several nodes are selected (batch mode). */
  const skillTargets = useCallback((skill: CanvasSkillDescriptor, node: CanvasNode): string[] => {
    const current = documentRef.current
    if (current === null) return [node.id]
    const selected = current.nodes.filter(candidate => selectedIdsRef.current.has(candidate.id))
    if (selected.length <= 1) return [node.id]
    const compatible = selected.filter(candidate => candidate.type !== 'config' && skill.accepts.includes(candidate.type))
    if (compatible.length <= 1) return [node.id]
    return compatible.slice(0, MAX_BATCH_SKILL_NODES).map(candidate => candidate.id)
  }, [])

  /** How many selected nodes a run would cover, for the picker's note line. */
  const skillBatchCount = useCallback((nodeId: string): number => {
    const current = documentRef.current
    if (current === null) return 1
    const selected = current.nodes.filter(node => selectedIdsRef.current.has(node.id) && node.type !== 'config')
    return Math.max(1, Math.min(selected.length, MAX_BATCH_SKILL_NODES, current.nodes.length))
  }, [])

  /** Menu pick: light skills run at once, heavy ones ask first. */
  const pickSkill = useCallback((skill: CanvasSkillDescriptor, node: CanvasNode): void => {
    setSkillMenu(null)
    const nodeIds = skillTargets(skill, node)
    if (skill.tier === 'heavy') {
      setPendingSkill({ skill, nodeIds, instruction: '' })
      return
    }
    if (nodeIds.length > MAX_BATCH_SKILL_NODES) {
      setError(tt('canvas.skills.batchTooMany', { count: MAX_BATCH_SKILL_NODES }))
      return
    }
    void startSkillRun(skill, nodeIds)
  }, [skillTargets, startSkillRun])

  /** Cancel one running skill (the host aborts a heavy agent run). */
  const cancelSkillRun = useCallback(async (taskId: string): Promise<void> => {
    try {
      await api.canvasSkillCancel(taskId)
      setSkillRuns(previous => {
        const next = { ...previous }
        delete next[taskId]
        return next
      })
      setNotice(tt('canvas.skills.runCancelled'))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [api])

  /** Download one file node's asset through the browser. */
  const downloadFileNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.assetId === '') return
    const anchor = globalThis.document.createElement('a')
    anchor.href = asset.url
    anchor.download = asset.name ?? node.title
    anchor.rel = 'noopener'
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }, [])

  /** Open a file asset with whatever the OS/browser registered for its type. */
  const openFileNode = useCallback((node: CanvasNode): void => {
    const asset = assetOf(node)
    if (asset === undefined || asset.assetId === '') return
    globalThis.open?.(asset.url, '_blank', 'noopener')
  }, [])

  /** One-click AI polish for a text node (light tier, replaces the text). */
  const polishTextNode = useCallback(async (node: CanvasNode, style: string, instruction?: string): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    setPolishBusy(node.id)
    setBusyNodes(previous => ({ ...previous, [node.id]: tt('canvas.skills.polish') }))
    try {
      const task = await api.canvasSkillRun({
        canvasId: current.id,
        skillId: 'polish.text',
        nodeIds: [node.id],
        ...style === 'custom' ? { instruction: instruction ?? '', params: { style: 'custom' } } : { params: { style } },
      })
      const snapshot = await new Promise<CanvasSkillTask>((resolve, reject) => {
        const started = Date.now()
        const tick = (): void => {
          void api.canvasSkillTask(task.id).then(current => {
            if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') { resolve(current); return }
            if (Date.now() - started > 300_000) { reject(new Error(tt('canvas.skills.runFailed', { message: 'timeout' }))); return }
            window.setTimeout(tick, 1200)
          }, reject)
        }
        tick()
      })
      if (snapshot.status !== 'completed') throw new Error(snapshot.error ?? tt('canvas.skills.runCancelled'))
      const produced = (snapshot.output?.nodes ?? []).find(candidate => candidate.type === 'text')
      const text = produced?.metadata?.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error(tt('canvas.skills.runFailed', { message: 'empty' }))
      // Write the result into the node itself: one click, undoable with Ctrl+Z.
      patchNode(node.id, { text })
      setNotice(tt('canvas.polish.applied'))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPolishBusy(null)
      setBusyNodes(previous => {
        const next = { ...previous }
        delete next[node.id]
        return next
      })
    }
  }, [api, patchNode])

  /** Apply one polish style to the acting node (or every selected text node). */
  const runPolish = useCallback((nodeId: string, style: string, instruction?: string): void => {
    const current = documentRef.current
    setPolishNode(null)
    if (current === null) return
    const selected = current.nodes.filter(node => node.type === 'text' && selectedIdsRef.current.has(node.id))
    const targets = selected.length > 1 && selected.some(node => node.id === nodeId)
      ? selected.slice(0, MAX_BATCH_SKILL_NODES)
      : [current.nodes.find(node => node.id === nodeId)].filter((node): node is CanvasNode => node !== undefined)
    // Sequential: the host serializes runs anyway, and each pass reads the
    // previous text only from its own node.
    void targets.reduce<Promise<void>>(
      (chain, node) => chain.then(() => polishTextNode(node, style, instruction)),
      Promise.resolve(),
    )
  }, [polishTextNode])

  /** Mutation applier for one finished skill run: the produced nodes and edges
   *  land in the current document, and the source nodes keep a provenance tag. */
  const applySkillOutput = useCallback((task: CanvasSkillTask, sourceNodeIds: string[]): number => {
    const output = task.output
    if (output === undefined) return 0
    const nodes = output.nodes ?? []
    const connections = output.connections ?? []
    if (nodes.length === 0) return 0
    const ids = new Set(nodes.map(node => node.id))
    mutate(previous => ({
      ...previous,
      nodes: [
        ...previous.nodes.map(node => sourceNodeIds.includes(node.id)
          ? {
              ...node,
              metadata: {
                ...node.metadata,
                skill: {
                  id: task.skillId,
                  label: task.label ?? task.skillId,
                  sourceNodeIds: [...sourceNodeIds],
                  createdAt: Date.now(),
                },
              },
            }
          : node),
        ...nodes,
      ],
      connections: [
        ...previous.connections,
        ...connections.filter(connection => ids.has(connection.toNodeId)
          && !previous.connections.some(existing => existing.fromNodeId === connection.fromNodeId && existing.toNodeId === connection.toNodeId)),
      ],
    }))
    setSelectedIds(new Set(nodes.map(node => node.id)))
    return nodes.length
  }, [mutate])

  /** Poll the host while runs are alive; runs are serialized host-side, so a
   *  single interval keeps every tool card honest without a request storm. The
   *  live map is read through a ref, so only the count drives the effect. */
  const activeSkillRunCount = Object.keys(skillRuns).length
  useEffect(() => {
    skillRunsRef.current = skillRuns
  }, [skillRuns])
  useEffect(() => {
    if (activeSkillRunCount === 0) return undefined
    let disposed = false
    const tick = async (): Promise<void> => {
      const ids = Object.keys(skillRunsRef.current)
      for (const taskId of ids) {
        const entry = skillRunsRef.current[taskId]
        if (entry === undefined || disposed) continue
        let snapshot: CanvasSkillTask
        try {
          snapshot = await api.canvasSkillTask(taskId)
        } catch {
          // A dropped task (host restart) must not spin forever.
          setSkillRuns(previous => {
            const next = { ...previous }
            delete next[taskId]
            return next
          })
          continue
        }
        if (disposed) return
        if (snapshot.status === 'completed') {
          const added = applySkillOutput(snapshot, entry.ids)
          setNotice(tt('canvas.skills.runDone', { count: added }))
          setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
          setBusyNodes(previous => { const next = { ...previous }; delete next[entry.nodeId]; return next })
          continue
        }
        if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
          if (snapshot.status === 'failed') {
            const failed = skillCatalog?.skills.find(skill => skill.id === snapshot.skillId)
            const missing = failed?.skillName !== undefined
              && skillCatalog !== null
              && !skillCatalog.installed.includes(failed.skillName)
            const text = snapshot.error ?? tt('canvas.skills.runFailed', { message: '' })
            setError(text)
            // A missing skill is the one failure the canvas can fix itself:
            // offer the install right in the toast instead of a dead-end error.
            // The action is bound to this exact message so a later, unrelated
            // error never inherits a stale button.
            setErrorAction(missing && failed !== undefined
              ? { label: tt('canvas.skills.installNow'), run: () => openSkillLibrary(failed.installUrl ?? ''), forError: text }
              : null)
          } else setNotice(tt('canvas.skills.runCancelled'))
          setSkillRuns(previous => { const next = { ...previous }; delete next[taskId]; return next })
          setBusyNodes(previous => { const next = { ...previous }; delete next[entry.nodeId]; return next })
          continue
        }
        const stage = snapshot.stage ?? ''
        if (stage !== entry.stage) {
          setSkillRuns(previous => previous[taskId] === undefined ? previous : { ...previous, [taskId]: { ...previous[taskId]!, stage } })
          setBusyNodes(previous => ({ ...previous, [entry.nodeId]: `${entry.label} · ${stage}` }))
        }
      }
    }
    const timer = window.setInterval(() => { void tick() }, 1500)
    void tick()
    return () => { disposed = true; window.clearInterval(timer) }
  }, [activeSkillRunCount, api, applySkillOutput])

  // --------------------------------------------------------- node tools

  /** Run one long node-local operation while its toolbar shows a spinner. */
  const withNodeBusy = useCallback(async (nodeId: string, label: string, task: () => Promise<void>): Promise<void> => {
    setBusyNodes(previous => ({ ...previous, [nodeId]: label }))
    try {
      await task()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyNodes(previous => {
        const next = { ...previous }
        delete next[nodeId]
        return next
      })
    }
  }, [])

  /** Compose the 标注 edit reference: the source image plus numbered boxes,
   *  together with the constraint text that pins the edit to those boxes. */
  const annotatedReference = useCallback(async (
    source: CanvasNode,
    boxes: Array<{ rect: CanvasRect; text: string }>,
  ): Promise<{ image: string; prompt: string } | undefined> => {
    const asset = usableAsset(source)
    if (asset === undefined || boxes.length === 0) return undefined
    const raster = await loadRaster(asset.url)
    const composite = drawAnnotation(raster, boxes.map((box, index) => ({ rect: box.rect, index })))
    const percent = (value: number): string => `${Math.round(clamp01(value) * 100)}%`
    const lines = boxes.map((box, index) => {
      const rect = box.rect
      return `- 框 ${index + 1}（左 ${percent(rect.x)}，上 ${percent(rect.y)}，右 ${percent(rect.x + rect.width)}，下 ${percent(rect.y + rect.height)}）：${box.text}`
    })
    return {
      image: canvasToDataUrl(composite),
      prompt: [
        '【局部修改约束】只修改参考图中红色方框标记的区域，方框之外的内容必须与原图完全一致（构图、人物、文字、颜色与光影都不要变化）。',
        '红色方框和编号只是给你定位用的标记：结果图片里绝对不能出现方框、边框、编号或任何标注痕迹。',
        '标记区域说明：',
        ...lines,
      ].join('\n'),
    }
  }, [])

  /** Annotation plan for one generation: read the boxes (and their attached
   *  prompt cards) straight off the image nodes feeding the config node. The
   *  cards are never wired into the graph, so the canvas stays readable. */
  const annotationPlanOf = useCallback(async (
    canvasDocument: CanvasDocument,
    inputs: CanvasNode[],
  ): Promise<{ image: string; prompt: string; sourceNodeId: string; texts: string[]; boxes: CanvasRect[] } | undefined> => {
    for (const image of inputs) {
      if (image.type !== 'image' || usableAsset(image) === undefined) continue
      const boxes = liveAnnotations(image, canvasDocument.nodes).flatMap(annotation => {
        const card = annotation.nodeId === undefined ? undefined : canvasDocument.nodes.find(node => node.id === annotation.nodeId)
        const text = (card === undefined ? '' : nodeMetadata(card).text ?? '').trim()
        return text === '' ? [] : [{ rect: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }, text }]
      })
      if (boxes.length === 0) continue
      try {
        const reference = await annotatedReference(image, boxes)
        if (reference !== undefined) return { ...reference, sourceNodeId: image.id, texts: boxes.map(box => box.text), boxes: boxes.map(box => box.rect) }
      } catch { /* unreadable source: fall back to the plain reference path */ }
    }
    return undefined
  }, [annotatedReference])

  /** 标注: hang a prompt card off one drawn box. The card is attached to the
   *  image (recorded in `metadata.annotations`), not wired into the graph — the
   *  generation step reads the boxes from the image node itself, so the canvas
   *  stays free of annotation edges. */
  const addAnnotationPrompt = useCallback((source: CanvasNode, rect: CanvasRect): void => {
    const current = documentRef.current
    if (current === null) return
    const existing = liveAnnotations(source, current.nodes)
    const draft: CanvasNode = {
      id: newId('node'), type: 'text', title: tt('canvas.annotationNode'),
      x: 0, y: 0, width: ANNOTATION_TEXT_SIZE.width, height: ANNOTATION_TEXT_SIZE.height,
      metadata: { text: '', fontSize: 13, annotation: { sourceNodeId: source.id, rect } },
    }
    const y = Math.round(source.y + existing.length * (ANNOTATION_TEXT_SIZE.height + 24))
    let x = source.x + source.width + NODE_GAP
    for (let guard = 0; guard < 24; guard += 1) {
      const clash = current.nodes.find(node => x < node.x + node.width + 24 && x + draft.width > node.x - 24
        && y < node.y + node.height + 24 && y + draft.height > node.y - 24)
      if (clash === undefined) break
      x = clash.x + clash.width + 40
    }
    const node: CanvasNode = { ...draft, x: Math.round(x), y }
    const annotation: CanvasAnnotation = { id: newId('ann'), ...rect, nodeId: node.id }
    mutate(previous => ({
      ...previous,
      nodes: [
        ...previous.nodes.map(item => item.id === source.id
          ? { ...item, metadata: { ...nodeMetadata(item), annotations: [...(nodeMetadata(item).annotations ?? []), annotation] } }
          : item),
        node,
      ],
    }))
    setSelectedIds(new Set([node.id]))
    setSelectedConnectionId(null)
    setFocusNodeId(node.id)
    setError(null)
  }, [mutate])

  const toggleAnnotate = useCallback((node: CanvasNode): void => {
    setAnnotateNodeId(previous => previous === node.id ? null : node.id)
    setAnnotationDraft(null)
    setColorPickerNodeId(null)
    setSelectedConnectionId(null)
  }, [])

  /** Pointer handlers of the annotation overlay (client coords -> image space). */
  const beginAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const asset = assetOf(node)
    const bounds = event.currentTarget.getBoundingClientRect()
    const box = containRect(bounds.width, bounds.height, asset?.width ?? 1, asset?.height ?? 1)
    annotationDragRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      start: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      box,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setAnnotationDraft({ nodeId: node.id, rect: { x: 0, y: 0, width: 0, height: 0 } })
  }, [])

  const moveAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = annotationDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    setAnnotationDraft({ nodeId: drag.nodeId, rect: rectBetween(drag.start, current, drag.box) })
  }, [])

  const endAnnotationDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode): void => {
    const drag = annotationDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    annotationDragRef.current = null
    setAnnotationDraft(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const bounds = event.currentTarget.getBoundingClientRect()
    const rect = rectBetween(drag.start, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, drag.box)
    if (rect.width * rect.height < MIN_ANNOTATION_AREA) return
    addAnnotationPrompt(node, rect)
  }, [addAnnotationPrompt])

  /** 移除背景: local alpha matting, no upstream call and no API cost. */
  const removeNodeBackground = useCallback(async (node: CanvasNode): Promise<void> => {
    const asset = usableAsset(node)
    if (asset === undefined) return
    setError(null)
    await withNodeBusy(node.id, tt('canvas.removingBackground'), async () => {
      const raster = await loadRaster(asset.url)
      if (transparencyRatio(raster) > 0.05) {
        setNotice(tt('canvas.alreadyTransparent'))
        return
      }
      const result = autoRemoveBackground(raster)
      if (result.removedRatio < 0.015) throw new Error(tt('canvas.removeBgFailed'))
      const uploaded = await api.canvasUpload(canvasToDataUrl(result.canvas), result.canvas.width, result.canvas.height, { origin: 'upload', originId: `matte-${node.id}` })
      const size = sizeForAsset(uploaded)
      addConnectedNode(node.id, () => ({
        id: newId('node'), type: 'image', title: tt('canvas.noBackgroundNode'),
        x: 0, y: 0, width: size.width, height: size.height,
        metadata: { asset: uploaded, status: 'success', transparent: true, sourceNodeId: node.id, model: nodeMetadata(node).model },
      }))
      setNotice(tt('canvas.removeBgDone', { percent: Math.round(result.removedRatio * 100) }))
    })
  }, [addConnectedNode, api, withNodeBusy])

  /** 图层拆分: ask the host chat model for a layer plan, then materialize it as
   *  editable canvas nodes (text cards, matted object stickers, background). */
  const splitLayers = useCallback(async (node: CanvasNode): Promise<void> => {
    const asset = usableAsset(node)
    if (asset === undefined) return
    if (!connected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    setError(null)
    await withNodeBusy(node.id, tt('canvas.splittingLayers'), async () => {
      const dataUrl = await assetToDataUrl(asset)
      const plan = await api.canvasLayers(dataUrl)
      const layers: CanvasLayerPlanItem[] = plan.layers
      if (layers.length === 0) throw new Error(tt('canvas.layerSplitEmpty'))
      const sourceRaster = await loadRaster(asset.url)
      const created: CanvasNode[] = []
      const connections: CanvasConnection[] = []
      const connect = (id: string): void => { connections.push({ id: newId('edge'), fromNodeId: node.id, toNodeId: id }) }
      const layerInfo = (layer: CanvasLayerPlanItem): CanvasLayerInfo => ({ kind: layer.kind, label: layer.label, sourceNodeId: node.id })
      const sourceAspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1
      // Layers land in a tidy column beside the source: mirroring the original
      // geometry stacked every layer on top of its neighbours inside one small
      // footprint, which made them impossible to grab or delete one by one.
      const planned = layers.map(layer => {
        if (layer.kind === 'background') {
          return { layer, width: LAYER_COLUMN_WIDTH, height: Math.max(120, Math.round(LAYER_COLUMN_WIDTH / sourceAspect)) }
        }
        const rect = layer.rect
        if (rect === undefined) return { layer, width: 0, height: 0 }
        const boxAspect = sourceAspect * (rect.width / Math.max(rect.height, 0.001))
        if (layer.kind === 'text') {
          const width = Math.max(180, Math.min(LAYER_COLUMN_WIDTH, Math.round(LAYER_COLUMN_WIDTH * rect.width)))
          return { layer, width, height: Math.max(64, Math.round(Math.min(160, (width / Math.max(boxAspect, 0.05)) * 1.6))) }
        }
        const width = Math.max(96, Math.min(LAYER_COLUMN_WIDTH, Math.round(LAYER_COLUMN_WIDTH * Math.max(rect.width, 0.14))))
        return { layer, width, height: Math.max(72, Math.round(width / Math.max(boxAspect, 0.05))) }
      }).filter(item => item.width > 0)
      const columnHeight = planned.reduce((sum, item) => sum + item.height + LAYER_COLUMN_GAP, 0)
      const originX = freeColumnX(node, documentRef.current?.nodes ?? [], columnHeight, LAYER_COLUMN_WIDTH)
      let cursorY = node.y
      for (const item of planned) {
        const layer = item.layer
        const id = newId('node')
        if (layer.kind === 'background') {
          created.push({
            id, type: 'image', title: tt('canvas.layerBackground', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: { asset, status: 'success', layer: layerInfo(layer), model: nodeMetadata(node).model },
          })
          connect(id)
        } else if (layer.kind === 'text') {
          const fontSize = Math.max(10, Math.min(72, Math.round(item.height * 0.5)))
          created.push({
            id, type: 'text', title: tt('canvas.layerText', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: {
              text: layer.text ?? '', fontSize, layer: layerInfo(layer),
              ...layer.color === undefined ? {} : { color: layer.color },
            },
          })
          connect(id)
        } else {
          const crop = cropRaster(sourceRaster, layer.rect!)
          const matted = autoRemoveBackground(crop)
          const cut = matted.removedRatio >= 0.06 ? matted.canvas : crop
          const uploaded = await api.canvasUpload(canvasToDataUrl(cut), cut.width, cut.height, { origin: 'upload', originId: `layer-${node.id}` })
          created.push({
            id, type: 'image', title: tt('canvas.layerObject', { label: layer.label }),
            x: originX, y: cursorY, width: item.width, height: item.height,
            metadata: { asset: uploaded, status: 'success', layer: layerInfo(layer), transparent: matted.removedRatio >= 0.06, model: nodeMetadata(node).model },
          })
          connect(id)
        }
        cursorY += item.height + LAYER_COLUMN_GAP
      }
      mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...created], connections: [...previous.connections, ...connections] }))
      setNotice(tt('canvas.layerSplitDone', { count: created.length }))
    })
  }, [api, connected, mutate, onOpenSettings, withNodeBusy])


  // ----------------------------------------------------------- generation

  const submitComposer = useCallback(async (target: CanvasNode | null): Promise<void> => {
    const current = documentRef.current
    if (current === null || composerBusy) return
    if (!connected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const inputs = target === null ? [] : upstreamNodes(current, target.id)
    const referenceImages = inputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined)
    const upstreamText = inputs
      .filter(node => node.type === 'text' && nodeMetadata(node).annotation === undefined && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerBusy(true)
    try {
      // Attached 标注 cards supply both the boxed reference and, when the
      // composer box is empty, the prompt itself.
      const annotationPlan = await annotationPlanOf(current, inputs).catch(() => undefined)
      const prompt = composerPrompt.trim() !== ''
        ? composerPrompt.trim()
        : (upstreamText.length > 0 ? upstreamText.join('\n') : (annotationPlan?.texts ?? []).join('\n'))
      if (prompt === '') { setError(tt('canvas.needPrompt')); setComposerBusy(false); return }
      const model = imageModels.includes(composerModel) ? composerModel : imageModels[0] ?? ''
      if (model === '') { setError(tt('canvas.needModel')); setComposerBusy(false); return }
      const count = Math.min(4, Math.max(1, Math.round(composerCount)))
      const baseAsset = referenceImages[0] !== undefined ? usableAsset(referenceImages[0]!) : undefined
      const finalPrompt = annotationPlan === undefined ? prompt : `${prompt}\n\n${annotationPlan.prompt}`
      let image: string | undefined
      let images: string[] | undefined
      let refName: string | undefined
      if (annotationPlan !== undefined) {
        image = annotationPlan.image
        refName = 'canvas-annotated.png'
      } else if (baseAsset !== undefined) {
        image = await assetToDataUrl(baseAsset)
        refName = 'canvas-reference.png'
        const extras: string[] = []
        for (const reference of referenceImages.slice(1, 4)) {
          const asset = usableAsset(reference)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) images = extras
      }
      const footprint = nodeSizeFromRatio(composerSize, IMAGE_NODE_SIZE)
      const request: GenerateRequest = {
        mode: image === undefined ? 'text' : 'edit', model, prompt: finalPrompt, size: composerSize, quality: composerQuality, n: count, detail: '',
        ...(defaultChannelId === undefined ? {} : { channelId: defaultChannelId }),
        ...(image === undefined ? {} : { image, refName }),
        ...(images === undefined ? {} : { images }),
        canvas: {
          canvasId: current.id,
          ...(target === null ? {} : {
            sourceNodeId: annotationPlan?.sourceNodeId ?? referenceImages[0]?.id ?? target.id,
            parentNodeId: target.id,
            placement: 'right' as const,
          }),
        },
      }
      const task = await api.taskSubmit(request)
      localTaskIds.current.add(task.id)
      mutate(previous => {
        const nodes = [...previous.nodes]
        const connections = [...previous.connections]
        const anchor = target !== null ? previous.nodes.find(node => node.id === target.id) : undefined
        const originX = anchor !== undefined ? anchor.x + anchor.width + 80 : Math.round(canvasCenter().x - footprint.width / 2)
        const originY = anchor !== undefined ? anchor.y : Math.round(canvasCenter().y - footprint.height / 2)
        for (let index = 0; index < count; index += 1) {
          const id = newId('node')
          nodes.push({
            id, type: 'image', title: tt('canvas.imageNode'),
            x: Math.round(originX), y: Math.round(originY + index * (footprint.height + 48)),
            width: footprint.width, height: footprint.height,
            metadata: {
              status: 'generating', taskId: task.id,
              ...(anchor !== undefined ? { sourceNodeId: anchor.id } : {}),
              ...(annotationPlan === undefined ? {} : { annotationEdit: { sourceNodeId: annotationPlan.sourceNodeId, boxes: annotationPlan.boxes } }),
              prompt: finalPrompt, model,
            },
          })
          if (anchor !== undefined) connections.push({ id: newId('edge'), fromNodeId: anchor.id, toNodeId: id })
        }
        return { ...previous, nodes, connections }
      })
      setComposerPrompt('')
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setComposerBusy(false)
    }
  }, [annotationPlanOf, api, canvasCenter, composerBusy, composerCount, composerModel, composerPrompt, composerQuality, composerSize, connected, defaultChannelId, imageModels, mutate, onOpenSettings, upstreamNodes])

  // ---------------------------------------------------------- task intake

  /** Re-run a failed image node's generation from its recorded prompt/model,
   * re-deriving the edit base from the connected source config node. */
  const retryGeneration = useCallback(async (node: CanvasNode): Promise<void> => {
    const current = documentRef.current
    if (current === null || !connected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const metadata = nodeMetadata(node)
    const prompt = (metadata.prompt ?? '').trim()
    if (prompt === '') { setError(tt('canvas.needPrompt')); return }
    const model = imageModels.includes(metadata.model ?? '') ? metadata.model! : imageModels[0] ?? ''
    if (model === '') { setError(tt('canvas.needModel')); return }
    const sourceId = metadata.sourceNodeId
    const sourceNode = sourceId === undefined ? undefined : current.nodes.find(item => item.id === sourceId)
    const directAsset = sourceNode !== undefined && sourceNode.type === 'image' ? usableAsset(sourceNode) : undefined
    const references = sourceId === undefined ? [] : upstreamNodes(current, sourceId).filter(item => item.type === 'image' && usableAsset(item) !== undefined)
    const baseAsset = directAsset ?? (references[0] !== undefined ? usableAsset(references[0]!) : undefined)
    try {
      let image: string | undefined
      let images: string[] | undefined
      let refName: string | undefined
      // A 标注 edit rebuilds its marked reference so the retry stays boxed.
      const boxes = sourceNode === undefined || sourceNode.type !== 'image' ? [] : liveAnnotations(sourceNode, current.nodes).flatMap(annotation => {
        const textNode = current.nodes.find(item => item.id === annotation.nodeId)
        const text = (textNode === undefined ? '' : nodeMetadata(textNode).text ?? '').trim()
        return text === '' ? [] : [{ rect: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }, text }]
      })
      const annotated = sourceNode !== undefined && baseAsset !== undefined && boxes.length > 0
        ? await annotatedReference(sourceNode, boxes).catch(() => undefined)
        : undefined
      if (annotated !== undefined) {
        image = annotated.image
        refName = 'canvas-annotated.png'
      } else if (baseAsset !== undefined) {
        image = await assetToDataUrl(baseAsset)
        refName = 'canvas-reference.png'
        const extras: string[] = []
        for (const reference of references.slice(1, 4)) {
          const asset = usableAsset(reference)
          if (asset === undefined) continue
          try { extras.push(await assetToDataUrl(asset)) } catch { /* skip unreadable reference */ }
        }
        if (extras.length > 0) images = extras
      }
      const request: GenerateRequest = {
        mode: image === undefined ? 'text' : 'edit', model, prompt, size: metadata.size ?? 'auto', quality: metadata.quality ?? 'auto', n: 1, detail: '',
        ...(defaultChannelId === undefined ? {} : { channelId: defaultChannelId }),
        ...(image === undefined ? {} : { image, refName }),
        ...(images === undefined ? {} : { images }),
        canvas: { canvasId: current.id, sourceNodeId: sourceId ?? references[0]?.id, parentNodeId: node.id, placement: 'right' as const },
      }
      const task = await api.taskSubmit(request)
      localTaskIds.current.add(task.id)
      patchNode(node.id, {
        status: 'generating', error: undefined, taskId: task.id,
        // Remember the boxes so the finished image can be composited back onto
        // the clean original (the marker must not survive into the result).
        ...(annotated !== undefined && sourceNode !== undefined
          ? { annotationEdit: { sourceNodeId: sourceNode.id, boxes: boxes.map(box => box.rect) } }
          : {}),
      })
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [annotatedReference, api, connected, defaultChannelId, imageModels, onOpenSettings, patchNode, upstreamNodes])

  // Orphan reconciliation: a generating placeholder whose task no longer exists
  // in the host feed (e.g. the host restarted) can never complete on its own.
  useEffect(() => {
    if (document === null) return
    const feedFresh = tasks.length > 0 || Date.now() - mountedAtRef.current > 8000
    if (!feedFresh) return
    const feedIds = new Set(tasks.map(task => task.id))
    const orphans = document.nodes.filter(node => {
      if (node.type !== 'image' || nodeMetadata(node).status !== 'generating') return false
      const taskId = nodeMetadata(node).taskId
      return taskId !== undefined && !feedIds.has(taskId) && !localTaskIds.current.has(taskId)
    })
    if (orphans.length === 0) return
    updateNodes(nodes => nodes.map(node => {
      const taskId = node.type === 'image' ? nodeMetadata(node).taskId : undefined
      if (node.type !== 'image' || nodeMetadata(node).status !== 'generating' || taskId === undefined
        || feedIds.has(taskId) || localTaskIds.current.has(taskId)) return node
      return { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: tt('canvas.taskLost') } }
    }))
  }, [document, tasks, updateNodes])

  useEffect(() => {
    if (document === null) return
    const canvasTasks = tasks.filter(task => task.request.canvas?.canvasId === document.id)
    for (const task of canvasTasks) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') continue
      if (processedTasks.current.has(task.id)) continue
      const targets = document.nodes.filter(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating')
      if (targets.length === 0) continue
      processedTasks.current.add(task.id)
      const sourceId = nodeMetadata(targets[0]!).sourceNodeId
      const fail = (message: string): void => {
        updateNodes(nodes => nodes.map(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating'
          ? { ...node, metadata: { ...nodeMetadata(node), status: 'error', error: message } }
          : node))
      }
      if (task.status !== 'completed' || task.result === undefined || task.result.images.length === 0) {
        fail(task.error ?? tt('canvas.generateFailed'))
        continue
      }
      void (async () => {
        const assets: CanvasAssetRef[] = []
        const annotationEdit = nodeMetadata(targets[0]!).annotationEdit
        const originalAsset = annotationEdit === undefined
          ? undefined
          : usableAsset(document.nodes.find(node => node.id === annotationEdit.sourceNodeId) ?? targets[0]!)
        for (const image of task.result!.images) {
          let dataUrl = imageDataUrl(image)
          // A 标注 edit: keep the generated pixels only inside the boxes and
          // restore the clean original everywhere else, so the red marker the
          // model may have echoed never reaches the finished image.
          if (annotationEdit !== undefined && originalAsset !== undefined) {
            try {
              const result = await loadRaster(dataUrl, 4096)
              const original = await loadRaster(originalAsset.url, 4096)
              const inset = Math.max(2, Math.round(Math.min(result.width, result.height) * 0.01))
              dataUrl = canvasToDataUrl(compositeAnnotatedResult(result, original, annotationEdit.boxes, inset))
            } catch { /* keep the raw result if the composite cannot be built */ }
          }
          const dimensions = await readImageSize(dataUrl)
          assets.push(await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'generated', originId: task.id }))
        }
        updateDocument(previous => {
          const ordered = previous.nodes.filter(node => node.type === 'image' && nodeMetadata(node).taskId === task.id && nodeMetadata(node).status === 'generating')
          if (ordered.length === 0) return previous
          const last = ordered[ordered.length - 1]!
          const nodes = previous.nodes.map(node => {
            const index = ordered.indexOf(node)
            if (index < 0) return node
            const asset = assets[index]
            return asset === undefined
              ? { ...node, metadata: { ...nodeMetadata(node), status: 'error' as const, error: tt('canvas.generateFailed') } }
              : { ...node, metadata: { ...nodeMetadata(node), asset, status: 'success' as const, error: undefined } }
          })
          // More results than placeholders: append sibling nodes below the last one.
          const siblings: CanvasNode[] = []
          const connections: CanvasConnection[] = []
          assets.slice(ordered.length).forEach((asset, offset) => {
            const id = newId('node')
            siblings.push({
              id, type: 'image', title: tt('canvas.imageNode'),
              x: Math.round(last.x), y: Math.round(last.y + (ordered.length + offset) * (last.height + 48)),
              width: last.width, height: last.height,
              metadata: { status: 'success', asset, taskId: task.id, ...(sourceId === undefined ? {} : { sourceNodeId: sourceId }) },
            })
            if (sourceId !== undefined) connections.push({ id: newId('edge'), fromNodeId: sourceId, toNodeId: id })
          })
          return { ...previous, nodes: [...nodes, ...siblings], connections: [...previous.connections, ...connections] }
        })
      })().catch(caught => fail(caught instanceof Error ? caught.message : String(caught)))
    }
  }, [api, document, tasks, updateDocument, updateNodes])

  // ------------------------------------------------------- import intake

  const addAssets = useCallback((assets: CanvasAssetRef[], position?: Point): void => {
    if (assets.length === 0) return
    const center = position ?? canvasCenter()
    mutate(previous => {
      const nodes = assets.map((asset, index) => {
        const node = createImageNode(asset)
        return { ...node, x: node.x + (index % 3) * (IMAGE_NODE_SIZE.width + 40), y: node.y + Math.floor(index / 3) * (IMAGE_NODE_SIZE.height + 40) }
      })
      return { ...previous, nodes: [...previous.nodes, ...nodes] }
    })
    setSelectedIds(new Set())
  }, [canvasCenter, createImageNode, mutate])

  useEffect(() => {
    if (importRequest === undefined) {
      processedImport.current = ''
      return
    }
    if (document === null) return
    const requestKey = `${importRequest.source}:${importRequest.entryId}:${importRequest.imageIndex}`
    if (processedImport.current === requestKey) return
    const sourceEntries = importRequest.source === 'history' ? history : gallery
    const entry = sourceEntries.find(item => item.id === importRequest.entryId)
    const image = entry?.images[importRequest.imageIndex]
    if (entry === undefined || image === undefined) {
      processedImport.current = requestKey
      onImportRequestHandled?.()
      return
    }
    processedImport.current = requestKey
    void (async () => {
      const dimensions = await readImageSize(image.url)
      const asset = await api.canvasImport(importRequest.source, importRequest.entryId, importRequest.imageIndex, dimensions.width, dimensions.height)
      addAssets([asset])
      onImportRequestHandled?.()
    })().catch(caught => {
      setError(caught instanceof Error ? caught.message : String(caught))
      onImportRequestHandled?.()
    })
  }, [addAssets, api, document, gallery, history, importRequest, onImportRequestHandled])

  // -------------------------------------------------------------- loading

  useEffect(() => {
    let disposed = false
    void api.canvasList().then(async list => {
      if (disposed) return
      const created = list[0] === undefined ? await api.canvasCreate(tt('canvas.untitled')) : null
      const first = created === null ? await api.canvasRead(list[0]!.id) : seedDocument(created)
      if (disposed) return
      setProjects(created === null ? list : [summaryOf(first)])
      setDocument(normalizeConfigNodeSizes(first))
      syncedRef.current = JSON.stringify(created ?? first)
      setSaveState('saved')
    }).catch(caught => { if (!disposed) { setError(caught instanceof Error ? caught.message : String(caught)); setSaveState('error') } })
    return () => { disposed = true }
  }, [api, seedDocument])

  useEffect(() => {
    if (document === null || saveState === 'loading') return
    const key = JSON.stringify(document)
    if (key === syncedRef.current) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      const saveWithRetry = async (): Promise<CanvasDocument> => {
        try {
          return await api.canvasSave(document, document.revision)
        } catch (caught) {
          // Another window saved the same canvas meanwhile: rebase on the
          // server revision and retry once so concurrent editing self-heals.
          const message = caught instanceof Error ? caught.message : String(caught)
          if (!message.includes('其他窗口')) throw caught
          const server = await api.canvasRead(document.id)
          return await api.canvasSave(document, server.revision)
        }
      }
      void saveWithRetry().then(next => {
        syncedRef.current = JSON.stringify(next)
        setDocument(next)
        setProjects(previous => [summaryOf(next), ...previous.filter(item => item.id !== next.id)])
        setSaveState('saved')
      }).catch(caught => { setError(caught instanceof Error ? caught.message : String(caught)); setSaveState('error') })
    }, 650)
    return () => window.clearTimeout(timer)
  }, [api, document, saveState])

  // ---------------------------------------------------------- composer sync

  const singleSelectedId = selectedIds.size === 1 ? [...selectedIds][0]! : null
  const singleSelected = useMemo(() => document?.nodes.find(node => node.id === singleSelectedId) ?? null, [document, singleSelectedId])
  // The composer follows the selected config node — including when other nodes
  // are selected alongside it, so using an image node's tools no longer makes
  // the generation bar vanish.
  const composerTarget = useMemo(() => {
    const selected = (document?.nodes ?? []).filter(node => selectedIds.has(node.id))
    const configs = selected.filter(node => node.type === 'config')
    return configs.length === 1 ? configs[0]! : null
  }, [document, selectedIds])
  const composerInputs = useMemo(
    () => composerTarget === null || document === null ? [] : upstreamNodes(document, composerTarget.id),
    [composerTarget, document, upstreamNodes],
  )
  const composerReferenceCount = composerInputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined).length
  const composerTextCount = composerInputs.filter(node => node.type === 'text' && (nodeMetadata(node).text ?? '').trim() !== '').length
  // Prompt cards hanging off the upstream images count as prompt input too, so
  // the send button is live once a box carries a prompt (no graph edge needed).
  const composerAnnotationTexts = useMemo(() => composerTarget === null || document === null
    ? []
    : composerInputs
      .filter(node => node.type === 'image')
      .flatMap(image => attachedCards(image, document.nodes))
      .map(card => (nodeMetadata(card).text ?? '').trim())
      .filter(text => text !== ''), [composerInputs, composerTarget, document])
  const composerVisible = composerTarget !== null

  // Prefill the prompt from connected text nodes whenever the target changes.
  useEffect(() => {
    const targetId = composerTarget?.id ?? null
    if (targetId === composerTargetRef.current) return
    composerTargetRef.current = targetId
    if (composerTarget === null) return
    const upstream = (document?.connections ?? [])
      .filter(connection => connection.toNodeId === composerTarget.id)
      .map(connection => document?.nodes.find(node => node.id === connection.fromNodeId))
      .filter((node): node is CanvasNode => node !== undefined)
    const texts = upstream
      .filter(node => node.type === 'text' && nodeMetadata(node).annotation === undefined && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerPrompt(texts.join('\n'))
    // Adopt the model chosen on a connected image node, so the node-level model
    // selector drives the generation it feeds.
    const upstreamModel = upstream
      .filter(node => node.type === 'image')
      .map(node => nodeMetadata(node).model ?? '')
      .find(model => imageModels.includes(model))
    if (upstreamModel !== undefined) setComposerModel(upstreamModel)
  }, [composerTarget, document, imageModels])

  // Transient success notices (background removal / layer split).
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  // The 标注 tool hands the keyboard to the prompt card it just created.
  useEffect(() => {
    if (focusNodeId === null) return
    const element = rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-node-id="${focusNodeId}"] textarea`)
    element?.focus()
    setFocusNodeId(null)
  }, [focusNodeId])

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    // Duck-typed (no `instanceof Element`): the same code must run inside the
    // jsdom smoke sandbox, which has no DOM constructors on its global.
    const matchesSelector = (target: EventTarget | null, selector: string): boolean => {
      const element = target as { matches?: unknown } | null
      if (element === null || typeof element !== 'object' || typeof element.matches !== 'function') return false
      return (element.matches as (value: string) => boolean)(selector)
    }
    const isEditingTarget = (target: EventTarget | null): boolean => matchesSelector(target, 'input, textarea, select, [contenteditable="true"]')

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Control') setCtrlPressed(true)
      if (event.code === 'Space' && !isEditingTarget(event.target)) {
        event.preventDefault()
        setSpacePressed(true)
      }
      if (documentRef.current === null) return
      const mod = event.ctrlKey || event.metaKey
      if (event.key === 'Escape') {
        setContextMenu(null); setCreateMenu(null); setBackgroundMenu(null); setImageMenu(null); setNodeAddMenu(null)
        setColorPickerNodeId(null)
        // Esc leaves the 标注 tool first, then clears the selection.
        if (annotateNodeId !== null) { setAnnotateNodeId(null); setAnnotationDraft(null); return }
        if (!isEditingTarget(event.target)) { setSelectedIds(new Set()); setSelectedConnectionId(null) }
        return
      }
      if (isEditingTarget(event.target)) {
        // An empty text card has nothing to erase, so Delete/Backspace means
        // "remove this node" there — otherwise the key looks broken while the
        // caret sits in a freshly created (empty) card.
        const target = event.target as { tagName?: unknown; value?: unknown; closest?: unknown } | null
        const editing = target !== null && typeof target === 'object' && target.tagName === 'TEXTAREA' ? target : null
        const host = editing === null || typeof editing.closest !== 'function'
          ? null
          : (editing.closest as (selector: string) => { getAttribute(name: string): string | null } | null)('[data-node-id]')
        const hostId = host === null ? null : host.getAttribute('data-node-id')
        if (editing !== null && editing.value === '' && hostId !== null && selectedIdsRef.current.has(hostId)
          && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault()
          deleteNode(hostId)
        }
        return
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo(); else undo()
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault(); redo()
      } else if (mod && event.key.toLowerCase() === 'c') {
        copySelection()
      } else if (mod && event.key.toLowerCase() === 'v') {
        pasteClipboard()
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault(); duplicateSelection()
      } else if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        const nodes = documentRef.current?.nodes ?? []
        setSelectedIds(new Set(nodes.map(node => node.id)))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); deleteSelection()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpacePressed(false)
      if (event.key === 'Control') setCtrlPressed(false)
    }
    const onBlur = (): void => { setSpacePressed(false); setCtrlPressed(false) }
    const onPaste = (event: ClipboardEvent): void => {
      if (isEditingTarget(event.target)) return
      const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
      if (files.length > 0) {
        event.preventDefault()
        void Promise.all(files.map(async file => {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
          const dimensions = await readImageSize(dataUrl)
          return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
        })).then(assets => addAssets(assets, canvasCenter())).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
        return
      }
      pasteClipboard()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('paste', onPaste)
    }
  }, [addAssets, annotateNodeId, api, canvasCenter, copySelection, deleteNode, deleteSelection, duplicateSelection, pasteClipboard, redo, undo])

  // ------------------------------------------------------ viewport events

  useEffect(() => {
    const container = viewportRef.current
    if (container === null) return
    const measure = (): void => setViewportSize({ width: container.clientWidth, height: container.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    const preventWheel = (event: WheelEvent): void => {
      if (event.target instanceof Element && event.target.closest(`[data-canvas-no-zoom]`)) return
      event.preventDefault()
    }
    container.addEventListener('wheel', preventWheel, { passive: false })
    return () => { observer.disconnect(); container.removeEventListener('wheel', preventWheel) }
  }, [])

  const temporaryPanTool = spacePressed || ctrlPressed

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null
    setContextMenu(null); setCreateMenu(null); setNodeAddMenu(null)
    if (!target?.closest('[data-canvas-no-zoom]')) { setBackgroundMenu(null); setImageMenu(null) }
    const isBackground = target?.closest('[data-node-id],[data-connection-hit]') === null
    const shouldPan = event.button === 1 || (event.button === 0 && (tool === 'pan' || temporaryPanTool) && isBackground)
    if (shouldPan) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const current = documentRef.current
      if (current !== null) {
        panRef.current = { startX: event.clientX, startY: event.clientY, viewportX: current.viewport.x, viewportY: current.viewport.y, hasMoved: false, startedOnBackground: isBackground }
      }
      return
    }
    if (event.button === 0 && isBackground && tool === 'select') {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const world = screenToWorld(event.clientX, event.clientY)
      const next: MarqueeState = { start: world, current: world, additive: event.shiftKey, initialIds: event.shiftKey ? [...selectedIdsRef.current] : [] }
      marqueeRef.current = next
      setMarquee(next)
      if (!event.shiftKey) { setSelectedIds(new Set()); setSelectedConnectionId(null) }
    }
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const current = documentRef.current
    if (current === null) return
    if (event.target instanceof Element && event.target.closest('[data-canvas-no-zoom]')) return
    event.preventDefault()
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    const mouseX = event.clientX - bounds.left
    const mouseY = event.clientY - bounds.top
    const scale = clampScale(current.viewport.k * Math.pow(1.1, -event.deltaY / 100))
    const worldX = (mouseX - current.viewport.x) / current.viewport.k
    const worldY = (mouseY - current.viewport.y) / current.viewport.k
    setViewport({ x: mouseX - worldX * scale, y: mouseY - worldY * scale, k: scale })
  }

  const setZoomAtCenter = useCallback((scale: number): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    const next = clampScale(scale)
    const centerX = bounds.width / 2
    const centerY = bounds.height / 2
    const worldX = (centerX - current.viewport.x) / current.viewport.k
    const worldY = (centerY - current.viewport.y) / current.viewport.k
    setViewport({ x: centerX - worldX * next, y: centerY - worldY * next, k: next })
  }, [setViewport])

  const fitView = useCallback((): void => {
    const current = documentRef.current
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (current === null || bounds === undefined) return
    if (current.nodes.length === 0) {
      setViewport({ x: 0, y: 0, k: 1 })
      return
    }
    const content = nodesBounds(current.nodes)
    const padding = 80
    const contentWidth = Math.max(1, content.maxX - content.minX)
    const contentHeight = Math.max(1, content.maxY - content.minY)
    const scale = clampScale(Math.min((bounds.width - padding * 2) / contentWidth, (bounds.height - padding * 2) / contentHeight))
    setViewport({
      k: scale,
      x: (bounds.width - contentWidth * scale) / 2 - content.minX * scale,
      y: (bounds.height - contentHeight * scale) / 2 - content.minY * scale,
    })
  }, [setViewport])

  // -------------------------------------------------- global move / up

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag !== null) {
        const scale = documentRef.current?.viewport.k ?? 1
        const dx = (event.clientX - drag.startX) / scale
        const dy = (event.clientY - drag.startY) / scale
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
          drag.moved = true
          commitSnapshot(drag.snapshot)
        }
        if (drag.moved) {
          updateNodes(nodes => nodes.map(node => {
            const origin = drag.origins.get(node.id)
            return origin === undefined ? node : { ...node, x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }
          }))
        }
        return
      }
      const connect = connectRef.current
      if (connect !== null) {
        const world = screenToWorld(event.clientX, event.clientY)
        if (!connect.moved && Math.hypot(event.clientX - connect.startClient.x, event.clientY - connect.startClient.y) > 4) {
          connect.moved = true
          setNodeAddMenu(null)
        }
        const nodes = documentRef.current?.nodes ?? []
        let targetId: string | null = null
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index]!
          if (node.id === connect.nodeId) continue
          if (world.x >= node.x && world.x <= node.x + node.width && world.y >= node.y && world.y <= node.y + node.height) {
            targetId = node.id
            break
          }
        }
        const next = { ...connect, mouse: world, targetId }
        connectRef.current = next
        setConnecting(next)
        return
      }
      const resize = resizeRef.current
      if (resize !== null) {
        const scale = documentRef.current?.viewport.k ?? 1
        const next = resizedRect(resize, event.clientX - resize.startX, event.clientY - resize.startY, scale)
        updateNodes(nodes => nodes.map(node => node.id === resize.nodeId ? { ...node, ...next } : node))
        return
      }
      const activeMarquee = marqueeRef.current
      if (activeMarquee !== null) {
        const next = { ...activeMarquee, current: screenToWorld(event.clientX, event.clientY) }
        marqueeRef.current = next
        setMarquee(next)
        return
      }
      const pan = panRef.current
      if (pan !== null) {
        const dx = event.clientX - pan.startX
        const dy = event.clientY - pan.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.hasMoved = true
        const next = { x: pan.viewportX + dx, y: pan.viewportY + dy }
        if (panFrameRef.current !== null) return
        panFrameRef.current = requestAnimationFrame(() => {
          panFrameRef.current = null
          updateDocument(previous => ({ ...previous, viewport: { ...previous.viewport, x: next.x, y: next.y } }))
        })
      }
    }

    const up = (): void => {
      const drag = dragRef.current
      if (drag !== null) {
        dragRef.current = null
        return
      }
      const connect = connectRef.current
      if (connect !== null) {
        connectRef.current = null
        setConnecting(null)
        if (connect.targetId !== null) {
          if (connect.handleType === 'source') connectNodes(connect.nodeId, connect.targetId)
          else connectNodes(connect.targetId, connect.nodeId)
        }
        return
      }
      const resize = resizeRef.current
      if (resize !== null) {
        resizeRef.current = null
        return
      }
      const activeMarquee = marqueeRef.current
      if (activeMarquee !== null) {
        marqueeRef.current = null
        setMarquee(null)
        const minX = Math.min(activeMarquee.start.x, activeMarquee.current.x)
        const minY = Math.min(activeMarquee.start.y, activeMarquee.current.y)
        const maxX = Math.max(activeMarquee.start.x, activeMarquee.current.x)
        const maxY = Math.max(activeMarquee.start.y, activeMarquee.current.y)
        const nodes = documentRef.current?.nodes ?? []
        const hits = nodes.filter(node => node.x < maxX && node.x + node.width > minX && node.y < maxY && node.y + node.height > minY).map(node => node.id)
        if (Math.abs(activeMarquee.current.x - activeMarquee.start.x) < 4 && Math.abs(activeMarquee.current.y - activeMarquee.start.y) < 4) {
          setSelectedConnectionId(null)
          return
        }
        const next = activeMarquee.additive
          ? new Set([...activeMarquee.initialIds, ...hits])
          : new Set(hits)
        setSelectedIds(next)
        setSelectedConnectionId(null)
        return
      }
      const pan = panRef.current
      if (pan !== null) {
        panRef.current = null
        if (!pan.hasMoved && pan.startedOnBackground) {
          setSelectedIds(new Set()); setSelectedConnectionId(null)
        }
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [commitSnapshot, connectNodes, screenToWorld, updateDocument, updateNodes])

  // --------------------------------------------------------- node events

  const handleNodePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string): void => {
    if (event.button !== 0 || tool === 'pan' || temporaryPanTool) return
    const current = documentRef.current
    if (current === null) return
    const node = current.nodes.find(item => item.id === nodeId)
    if (node === undefined) return
    event.stopPropagation()
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    setNodeAddMenu(null)
    let nextSelection = selectedIdsRef.current
    if (additive) {
      nextSelection = new Set(selectedIdsRef.current)
      if (nextSelection.has(nodeId)) nextSelection.delete(nodeId)
      else nextSelection.add(nodeId)
    } else if (!nextSelection.has(nodeId)) {
      nextSelection = new Set([nodeId])
    }
    setSelectedIds(nextSelection)
    setSelectedConnectionId(null)
    const origins = new Map<string, Point>()
    for (const id of nextSelection) {
      const item = current.nodes.find(candidate => candidate.id === id)
      if (item !== undefined) origins.set(id, { x: item.x, y: item.y })
    }
    // Annotation prompt cards are attached to their image node: they ride along
    // with it without joining the selection (which would hide the composer).
    for (const id of nextSelection) {
      const item = current.nodes.find(candidate => candidate.id === id)
      if (item === undefined || item.type !== 'image') continue
      for (const card of attachedCards(item, current.nodes)) origins.set(card.id, { x: card.x, y: card.y })
    }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, snapshot: JSON.stringify(current), origins }
  }, [temporaryPanTool, tool])

  const handleConnectStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string, handleType: 'source' | 'target'): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    clearNodeAddMenuTimer(); setNodeAddMenu(null)
    const world = screenToWorld(event.clientX, event.clientY)
    const next: ConnectState = { nodeId, handleType, mouse: world, targetId: null, moved: false, startClient: { x: event.clientX, y: event.clientY } }
    connectRef.current = next
    setConnecting(next)
    setSelectedConnectionId(null)
  }, [clearNodeAddMenuTimer, screenToWorld])

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: ResizeCorner): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const asset = assetOf(node)
    const ratio = node.type === 'image' && asset !== undefined && asset.width > 0 && asset.height > 0 ? asset.height / asset.width : null
    resizeRef.current = { nodeId: node.id, corner, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, x: node.x, y: node.y, ratio }
    beginHistory()
  }, [beginHistory])

  const handleConnectionSelect = useCallback((connectionId: string): void => {
    setSelectedConnectionId(connectionId)
    setSelectedIds(new Set())
  }, [])

  // -------------------------------------------------------- file dropping

  /** Dropped files: images keep the fast data-URL path (they can also become
   *  generation references), everything else uploads as a file node at the
   *  pointer, one node per file. */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const dropped = [...(event.dataTransfer.files ?? [])]
    if (dropped.length === 0) return
    const world = screenToWorld(event.clientX, event.clientY)
    const images = dropped.filter(file => file.type.startsWith('image/'))
    const others = dropped.filter(file => !file.type.startsWith('image/'))
    if (images.length > 0) {
      void Promise.all(images.map(async file => {
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
        const dimensions = await readImageSize(dataUrl)
        return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
      })).then(assets => addAssets(assets, world)).catch(caught => setError(errorMessage(caught)))
    }
    let cascade = 0
    for (const file of others) {
      const point = { x: world.x + cascade * 26, y: world.y + cascade * 26 }
      cascade += 1
      void uploadCanvasFile(file, null, point).then(() => undefined)
    }
  }, [addAssets, api, screenToWorld, uploadCanvasFile])

  // ------------------------------------------------------------ projects

  const newCanvas = useCallback(async (): Promise<void> => {
    try {
      const created = await api.canvasCreate(tt('canvas.untitled'))
      const next = seedDocument(created)
      setProjects(previous => [summaryOf(next), ...previous])
      setDocument(next); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(created); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, seedDocument])

  const selectProject = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await api.canvasRead(id)
      setDocument(normalizeConfigNodeSizes(next)); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(next); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api])

  const removeCurrentProject = useCallback(async (): Promise<void> => {
    const current = documentRef.current
    if (current === null) return
    try {
      const remaining = await api.canvasRemove(current.id)
      setConfirmDeleteProject(false)
      const nextId = remaining[0]?.id
      if (nextId === undefined) {
        const created = await api.canvasCreate(tt('canvas.untitled'))
        const created2 = seedDocument(created)
        setProjects([summaryOf(created2)]); setDocument(created2)
        syncedRef.current = JSON.stringify(created); setSaveState('saved')
      } else {
        setProjects(remaining)
        await selectProject(nextId)
      }
      setSelectedIds(new Set()); setSelectedConnectionId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, selectProject, seedDocument])

  // -------------------------------------------------------------- derived

  const nodeById = useMemo(() => new Map((document?.nodes ?? []).map(node => [node.id, node])), [document])
  const relatedIds = useMemo(() => {
    const related = new Set<string>()
    if (document === null) return related
    for (const connection of document.connections) {
      if (selectedIds.has(connection.fromNodeId)) related.add(connection.toNodeId)
      if (selectedIds.has(connection.toNodeId)) related.add(connection.fromNodeId)
    }
    return related
  }, [document, selectedIds])

  const isSpaceOrCtrl = temporaryPanTool
  const cursorClass = tool === 'pan' || isSpaceOrCtrl ? css.panCursor : css.selectCursor

  const backgroundMode = document?.background ?? 'liquid'
  const setBackgroundMode = useCallback((mode: BackgroundMode): void => {
    mutate(previous => ({
      ...previous,
      background: mode,
      ...(mode === 'image' ? {} : { backgroundImage: undefined }),
    }))
    setBackgroundMenu(null)
  }, [mutate])

  const uploadBackgroundImage = useCallback(async (file: File): Promise<void> => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      const dimensions = await readImageSize(dataUrl)
      const asset = await api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: 'canvas-background' })
      mutate(previous => ({ ...previous, background: 'image', backgroundImage: asset.url }))
      setBackgroundMenu(null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [api, mutate])

  const removeBackgroundImage = useCallback((): void => {
    mutate(previous => ({ ...previous, background: 'dots', backgroundImage: undefined }))
    setBackgroundMenu(null)
  }, [mutate])

  const applyTemplate = useCallback((prompt: string): void => {
    const center = canvasCenter()
    const config = createConfigNode(center)
    const text = createTextNode()
    const placed: CanvasNode = {
      ...text,
      x: Math.round(config.x - TEXT_NODE_SIZE.width - 80),
      y: Math.round(config.y + (config.height - TEXT_NODE_SIZE.height) / 2),
      metadata: { text: prompt, fontSize: 14 },
    }
    mutate(previous => ({
      ...previous,
      nodes: [...previous.nodes, placed, config],
      connections: [...previous.connections, { id: newId('edge'), fromNodeId: placed.id, toNodeId: config.id }],
    }))
    setSelectedIds(new Set([config.id])); setSelectedConnectionId(null)
    setSkillLibraryOpen(false)
  }, [canvasCenter, createConfigNode, createTextNode, mutate])

  const gridSize = GRID_SIZE * (document?.viewport.k ?? 1)
  const gridOffsetX = (document?.viewport.x ?? 0) % gridSize
  const gridOffsetY = (document?.viewport.y ?? 0) % gridSize

  // ------------------------------------------------------------- render

  const renderNode = (node: CanvasNode): React.JSX.Element => {
    const metadata = nodeMetadata(node)
    const isSelected = selectedIds.has(node.id)
    const isRelated = relatedIds.has(node.id)
    const asset = assetOf(node)
    const isGenerating = node.type === 'image' && metadata.status === 'generating'
    const isError = node.type === 'image' && metadata.status === 'error'
    const isConnectTarget = connecting?.targetId === node.id
    const hasImage = asset !== undefined && asset.url !== ''
    const isConfig = node.type === 'config'
    const isFile = node.type === 'file'
    const isSketch = isSketchNode(node)
    const fileKind = isFile ? (metadata.fileKind ?? fileKindOfAsset(asset ?? { assetId: '', url: '', mime: 'application/octet-stream', bytes: 0, width: 0, height: 0, origin: 'upload' })) : 'other'
    const hasFile = isFile && asset !== undefined && asset.url !== ''
    /** Only config nodes are excluded: every content node can feed a skill. */
    const skillable = !isConfig
    const skillRun = Object.entries(skillRuns).find(([, entry]) => entry.nodeId === node.id)
    const isTextual = node.type === 'text' || isConfig
    const isTextNode = node.type === 'text'
    const annotating = annotateNodeId === node.id && hasImage && !isSketch
    const busyLabel = busyNodes[node.id]
    const annotations = node.type === 'image' ? liveAnnotations(node, document?.nodes ?? []) : []
    const draftRect = annotationDraft !== null && annotationDraft.nodeId === node.id ? annotationDraft.rect : null
    const boxStyle = (rect: CanvasRect): CSSProperties => ({
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    })
    return <div
      key={node.id}
      data-node-id={node.id}
      data-annotating={annotating ? '' : undefined}
      className={`${css.node} ${isSketch ? css.sketchNode : isConfig ? css.configNode : isTextual ? css.textNode : css.imageNode} ${isSelected ? css.nodeSelected : ''} ${isRelated ? css.nodeRelated : ''} ${isConnectTarget ? css.nodeConnectTarget : ''}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onPointerDown={event => handleNodePointerDown(event, node.id)}
      onContextMenu={event => {
        if ((event.target as Element).closest('textarea, input, select')) return
        event.preventDefault(); event.stopPropagation()
        if (!selectedIds.has(node.id)) setSelectedIds(new Set([node.id]))
        setContextMenu({ type: 'node', screen: { x: event.clientX, y: event.clientY }, nodeId: node.id })
      }}
    >
      <div className={css.nodeGlow} aria-hidden="true" />
      {isTextual || isSketch ? <header className={css.nodeHeader}>
        <span className={css.nodeTitle}>{node.title}</span>
        {metadata.annotation !== undefined ? <span className={css.nodeTag}>{tt('canvas.annotationTag')}</span> : null}
        {metadata.layer !== undefined ? <span className={css.nodeTag}>{layerKindLabel(metadata.layer.kind)}</span> : null}
        {isTextNode && !isAnnotationCard(node) ? <div className={css.textTools} onPointerDown={event => event.stopPropagation()}>
          <button
            type="button"
            className={css.textTool}
            aria-label={tt('canvas.fontSmaller')}
            title={tt('canvas.fontSmaller')}
            onClick={() => patchNode(node.id, { fontSize: Math.max(8, (metadata.fontSize ?? 13) - 2) })}
          >A-</button>
          <span className={css.textToolValue}>{Math.round(metadata.fontSize ?? 13)}</span>
          <button
            type="button"
            className={css.textTool}
            aria-label={tt('canvas.fontLarger')}
            title={tt('canvas.fontLarger')}
            onClick={() => patchNode(node.id, { fontSize: Math.min(96, (metadata.fontSize ?? 13) + 2) })}
          >A+</button>
          <button
            type="button"
            className={css.textTool}
            data-active={(metadata.bold ?? false) ? '' : undefined}
            aria-label={tt('canvas.bold')}
            title={tt('canvas.bold')}
            onClick={() => patchNode(node.id, { bold: metadata.bold !== true })}
          ><ToolbarIcon name="bold" size={13} /></button>
          <button
            type="button"
            className={css.textTool}
            data-active={colorPickerNodeId === node.id ? '' : undefined}
            aria-label={tt('canvas.textColor')}
            title={tt('canvas.textColor')}
            onClick={() => setColorPickerNodeId(colorPickerNodeId === node.id ? null : node.id)}
          ><span className={css.colorDot} style={{ background: metadata.color ?? 'currentColor' }} /></button>
        </div> : null}
      </header> : null}
      {isTextNode && !isAnnotationCard(node) && colorPickerNodeId === node.id ? <div className={css.colorRow} onPointerDown={event => event.stopPropagation()}>
        {TEXT_COLORS.map(color => <button
          key={color === '' ? 'default' : color}
          type="button"
          className={css.colorSwatch}
          data-active={(metadata.color ?? '') === color ? '' : undefined}
          style={color === '' ? undefined : { background: color }}
          title={color === '' ? tt('canvas.colorDefault') : color}
          aria-label={color === '' ? tt('canvas.colorDefault') : color}
          onClick={() => { patchNode(node.id, { color: color === '' ? undefined : color }); setColorPickerNodeId(null) }}
        >{color === '' ? <X size={11} strokeWidth={2.4} aria-hidden="true" /> : null}</button>)}
      </div> : null}
      {isConfig ? <div className={css.configLinks} data-config-links={node.id}>
        <span className={css.composerChip}>{tt('canvas.composerLinked', { count: (document?.connections ?? []).filter(connection => connection.toNodeId === node.id).length })}</span>
      </div> : null}
      {isConfig
        ? <p className={css.configHint}>{tt('canvas.configHint')}</p>
        : isTextual
        ? <textarea
            className={css.textArea}
            style={textStyleOf(node)}
            value={metadata.text ?? ''}
            placeholder={metadata.annotation !== undefined ? tt('canvas.annotationPlaceholder') : tt('canvas.textPlaceholder')}
            onPointerDown={event => event.stopPropagation()}
            onChange={event => patchNode(node.id, { text: event.target.value })}
          />
        : isSketch
        ? <SketchBoard
            api={api}
            node={node}
            zoom={document?.viewport.k ?? 1}
            strokes={metadata.sketch?.strokes ?? []}
            onStrokesChange={strokes => patchSketchStrokes(node.id, strokes)}
            onAssetChange={asset => patchSketchAsset(node.id, asset)}
          />
        : isFile
        ? <div className={css.fileBody}>
            {hasFile
              ? fileKind === 'image'
                ? <img src={asset.url} alt={node.title} draggable={false} onDragStart={event => event.preventDefault()} />
                : fileKind === 'pdf'
                  ? <object className={css.fileFrame} data={asset.url} type="application/pdf" aria-label={node.title} />
                  : fileKind === 'text' && asset.textPreview !== undefined && asset.textPreview !== ''
                    ? <pre className={css.fileText} onPointerDown={event => event.stopPropagation()}>{asset.textPreview}</pre>
                    : <div className={css.filePlaceholder}><ToolbarIcon name="file" size={26} /><span>{tt('canvas.skills.filePreviewUnavailable')}</span></div>
              : <button
                  type="button"
                  className={css.nodeEmpty}
                  onClick={() => { setFileTargetNodeId(node.id); fileUploadRef.current?.click() }}
                ><ToolbarIcon name="upload" /><span>{tt('canvas.skills.emptyFileNode')}</span></button>}
          </div>
        : <div className={css.nodeBody}>
            {isGenerating
              ? <div className={css.nodeState}><span className={css.nodeSpinner} aria-hidden="true" /><span>{tt('canvas.generatingNode')}</span></div>
              : isError
                ? <div className={css.nodeStateError}>{metadata.error ?? tt('canvas.generateFailed')}<button type="button" onClick={() => { void retryGeneration(node) }}>{tt('canvas.retry')}</button></div>
                : hasImage
                  ? <img src={asset.url} alt={node.title} draggable={false} onDragStart={event => event.preventDefault()} />
                  : <button type="button" className={css.nodeEmpty} onClick={() => imageFileRef.current?.click()}><ToolbarIcon name="image" /><span>{tt('canvas.emptyImageNode')}</span></button>}
            {hasImage && annotations.length > 0 ? <div className={css.annotationLayer} aria-hidden="true">
              {annotations.map((annotation, index) => <div key={annotation.id} className={css.annotationBox} style={boxStyle(annotation)}>
                <span className={css.annotationBadge}>{index + 1}</span>
              </div>)}
            </div> : null}
            {annotating ? <div
              className={css.annotationLayer}
              data-active=""
              title={tt('canvas.annotationDrawHint')}
              onPointerDown={event => beginAnnotationDrag(event, node)}
              onPointerMove={moveAnnotationDrag}
              onPointerUp={event => endAnnotationDrag(event, node)}
              onPointerCancel={() => { annotationDragRef.current = null; setAnnotationDraft(null) }}
            >
              {annotations.map((annotation, index) => <div key={annotation.id} className={css.annotationBox} style={boxStyle(annotation)}>
                <span className={css.annotationBadge}>{index + 1}</span>
              </div>)}
              {draftRect !== null ? <div className={`${css.annotationBox} ${css.annotationDraft}`} style={boxStyle(draftRect)} /> : null}
            </div> : null}
            {busyLabel !== undefined ? <div className={css.nodeBusy}><span className={css.nodeSpinner} aria-hidden="true" /><span>{busyLabel}</span></div> : null}
          </div>}
      {node.type === 'image' && !isSketch && hasImage ? <div className={css.imageFooter} data-image-footer="">
        <span className={css.imageFooterLabel}>
          {metadata.layer !== undefined
            ? `${layerKindLabel(metadata.layer.kind)} · ${metadata.layer.label}`
            : metadata.model !== undefined && metadata.model !== ''
              ? metadata.model
              : asset.origin === 'gallery' || asset.origin === 'history'
                ? (asset.origin === 'gallery' ? tt('canvas.fromGallery') : tt('canvas.fromHistory'))
                : ''}
        </span>
        {asset.width > 1 ? <span className={css.imageFooterSize}>{asset.width}×{asset.height}</span> : null}
      </div> : null}
      {isFile ? <div className={css.imageFooter} data-file-footer="">
        <span className={css.imageFooterLabel}>
          {hasFile
            ? `${asset.name !== undefined && asset.name !== '' ? asset.name : fileKindLabel(fileKind)}${metadata.skill !== undefined ? ` · ${tt('canvas.skills.sourceBadge')}` : ''}`
            : fileKindLabel(fileKind)}
        </span>
        {hasFile && asset.bytes > 0 ? <span className={css.imageFooterSize}>{fileSizeLabel(asset.bytes)}</span> : null}
      </div> : null}
      {isSelected && !isSketch
        ? (['nw', 'ne', 'sw', 'se'] as const).map(corner => <div
            key={corner}
            className={css.resizeHandle}
            data-corner={corner}
            onPointerDown={event => handleResizeStart(event, node, corner)}
            title={tt('canvas.resizeHint')}
          />)
        : null}
      {isAnnotationCard(node)
        ? null
        : <>
            <div className={`${css.handle} ${css.handleLeft}`} title={tt('canvas.connectHint')} onPointerDown={event => handleConnectStart(event, node.id, 'target')} />
            <div
              className={`${css.handle} ${css.handleRight}`}
              title={tt('canvas.connectAddHint')}
              onPointerDown={event => handleConnectStart(event, node.id, 'source')}
              onMouseEnter={() => { window.setTimeout(() => { if (connectRef.current === null) openNodeAddMenu(node) }, 120) }}
              onMouseLeave={scheduleNodeAddMenuClose}
            />
          </>}      <div className={`${css.hoverToolbar} ${node.type === 'image' && hasImage ? css.hoverToolbarBottom : ''}`} data-toolbar={node.type === 'image' && hasImage ? 'bottom' : 'top'} onPointerDown={event => event.stopPropagation()}>
        {node.type === 'image' && hasImage ? <>
          <IconButton name="annotate" label={tt('canvas.annotate')} active={annotating} onClick={() => toggleAnnotate(node)} />
          <IconButton name="removeBg" label={tt('canvas.removeBackground')} disabled={busyLabel !== undefined} onClick={() => { void removeNodeBackground(node) }} />
          <IconButton name="layers" label={tt('canvas.splitLayers')} disabled={busyLabel !== undefined} onClick={() => { void splitLayers(node) }} />
          <span className={css.toolbarDivider} aria-hidden="true" />
          <ComposerSelect
            variant="toolbar"
            ariaLabel={tt('canvas.nodeModel')}
            value={metadata.model ?? ''}
            options={[{ value: '', label: tt('canvas.modelDefault') }, ...imageModels.map(item => ({ value: item, label: item }))]}
            onChange={value => patchNode(node.id, { model: value === '' ? undefined : value })}
          />
          <span className={css.toolbarDivider} aria-hidden="true" />
          <IconButton name="download" label={tt('canvas.download')} onClick={() => downloadNode(node)} />
        </> : null}
        {skillable ? <>
          <IconButton
            name="skill"
            label={tt('canvas.skills.button')}
            active={skillRun !== undefined}
            onClick={event => openSkillMenu(node, { x: event.clientX, y: event.clientY + 10 })}
          />
          {isTextNode && !isAnnotationCard(node) ? <IconButton
            name="sparkle"
            label={tt('canvas.polish.button')}
            disabled={polishBusy === node.id}
            onClick={event => {
              event.stopPropagation()
              setPolishNode({ screen: { x: event.clientX, y: event.clientY + 10 }, nodeId: node.id })
            }}
          /> : null}
          <span className={css.toolbarDivider} aria-hidden="true" />
        </> : null}
        {isFile && hasFile ? <>
          <IconButton name="download" label={tt('canvas.skills.fileDownload')} onClick={() => downloadFileNode(node)} />
          <IconButton name="file" label={tt('canvas.skills.fileOpen')} onClick={() => openFileNode(node)} />
          <span className={css.toolbarDivider} aria-hidden="true" />
        </> : null}
        {isAnnotationCard(node) ? null : <IconButton name="duplicate" label={tt('canvas.duplicate')} onClick={() => duplicateNode(node.id)} />}
        <IconButton name="trash" label={tt('canvas.delete')} onClick={() => deleteNode(node.id)} />
      </div>
    </div>
  }

  const renderConnections = (): React.JSX.Element => {
    // Legacy canvases wired annotation cards into the graph; those edges are
    // implicit now (the card is attached to its image), so they are not drawn.
    const visible = (document?.connections ?? []).filter(connection => {
      const from = nodeById.get(connection.fromNodeId)
      const to = nodeById.get(connection.toNodeId)
      if (from === undefined || to === undefined) return false
      return !isAnnotationCard(from) && !isAnnotationCard(to)
    })
    const gradientOf = (connection: CanvasConnection): React.JSX.Element => {
      const from = nodeById.get(connection.fromNodeId)!
      const to = nodeById.get(connection.toNodeId)!
      const start = nodeAnchor(from, 'right')
      const end = nodeAnchor(to, 'left')
      return <linearGradient
        key={connection.id}
        id={`conn-g-${connection.id}`}
        gradientUnits="userSpaceOnUse"
        x1={start.x} y1={start.y} x2={end.x} y2={end.y}
      >
        <stop offset="0" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.08" />
        <stop offset="0.7" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.4" />
        <stop offset="1" stopColor="var(--dsw-alias-brand-primary)" stopOpacity="0.85" />
      </linearGradient>
    }
    return <svg
      className={css.connectionLayer}
      width={WORLD_PAD * 2}
      height={WORLD_PAD * 2}
      style={{ left: -WORLD_PAD, top: -WORLD_PAD }}
      aria-hidden="true"
    >
      <defs>
        <marker id="conn-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <path d="M 0 1.6 L 8.4 5 L 0 8.4 Z" fill="color-mix(in srgb, var(--dsw-alias-brand-primary) 62%, transparent)" />
        </marker>
        <marker id="conn-arrow-active" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
          <path d="M 0 1.6 L 8.4 5 L 0 8.4 Z" fill="var(--dsw-alias-brand-primary)" />
        </marker>
        {visible.map(gradientOf)}
      </defs>
      <g transform={`translate(${WORLD_PAD},${WORLD_PAD})`}>
        {visible.map(connection => {
          const from = nodeById.get(connection.fromNodeId)!
          const to = nodeById.get(connection.toNodeId)!
          const path = bezierPath(nodeAnchor(from, 'right'), nodeAnchor(to, 'left'))
          const active = connection.id === selectedConnectionId
          return <g key={connection.id}>
            <path
              data-connection-hit={connection.id}
              d={path}
              stroke="transparent"
              strokeWidth={16}
              fill="none"
              style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
              onPointerDown={event => { event.stopPropagation(); handleConnectionSelect(connection.id) }}
              onContextMenu={event => {
                event.preventDefault(); event.stopPropagation()
                handleConnectionSelect(connection.id)
                setContextMenu({ type: 'connection', screen: { x: event.clientX, y: event.clientY }, connectionId: connection.id })
              }}
            />
            <path
              d={path}
              stroke={`url(#conn-g-${connection.id})`}
              className={css.connectionPath}
              markerEnd={active ? 'url(#conn-arrow-active)' : 'url(#conn-arrow)'}
            />
            {/* A soft light band glides along the path (source -> target). */}
            <path d={path} className={`${css.connectionFlow} ${active ? css.connectionFlowActive : ''}`} />
          </g>
        })}
        {connecting !== null ? (() => {
          const node = nodeById.get(connecting.nodeId)
          if (node === undefined) return null
          const mouse = connecting.targetId !== undefined && connecting.targetId !== null && nodeById.has(connecting.targetId)
            ? nodeAnchor(nodeById.get(connecting.targetId)!, connecting.handleType === 'source' ? 'left' : 'right')
            : connecting.mouse
          const path = connecting.handleType === 'source'
            ? bezierPath(nodeAnchor(node, 'right'), mouse)
            : bezierPath(mouse, nodeAnchor(node, 'left'))
          return <path d={path} className={css.connectionPreview} />
        })() : null}
      </g>
    </svg>
  }

  /** Leader lines from each annotation box to the prompt card hanging off it.
   *  Rendered in its own layer above the nodes so the line is visible where it
   *  leaves the box, instead of disappearing under the picture. */
  const renderAnnotationLinks = (): React.JSX.Element | null => {
    if (document === null) return null
    const links = document.nodes.flatMap(image => image.type !== 'image' ? [] : liveAnnotations(image, document.nodes).flatMap(annotation => {
      const card = annotation.nodeId === undefined ? undefined : nodeById.get(annotation.nodeId)
      return card === undefined ? [] : [{ id: annotation.id, from: annotationAnchor(image, annotation), to: nodeAnchor(card, 'left') }]
    }))
    if (links.length === 0) return null
    return <svg
      className={css.annotationLinkLayer}
      data-annotation-links=""
      width={WORLD_PAD * 2}
      height={WORLD_PAD * 2}
      style={{ left: -WORLD_PAD, top: -WORLD_PAD }}
      aria-hidden="true"
    >
      <g transform={`translate(${WORLD_PAD},${WORLD_PAD})`}>
        {links.map(link => <g key={link.id}>
          <path data-annotation-link={link.id} d={bezierPath(link.from, link.to)} className={css.annotationLink} />
          <circle cx={link.from.x} cy={link.from.y} r={4} className={css.annotationLinkDot} />
        </g>)}
      </g>
    </svg>
  }

  const renderComposer = (): ReactNode => {
    if (!composerVisible || document === null || composerTarget === null) return null
    const linkedCount = composerReferenceCount + composerTextCount
    const k = document.viewport.k
    const topOffset = viewportRef.current?.offsetTop ?? 0
    const centerX = topOffset * 0 + document.viewport.x + (composerTarget.x + composerTarget.width / 2) * k
    const clampedX = Math.min(Math.max(centerX, 292), Math.max(292, viewportSize.width - 292))
    const belowY = topOffset + document.viewport.y + (composerTarget.y + composerTarget.height) * k + 14
    const top = belowY > viewportSize.height + topOffset - 170
      ? Math.max(64, topOffset + document.viewport.y + composerTarget.y * k - 158)
      : belowY
    return <div className={css.composer} data-canvas-no-zoom="" style={{ left: clampedX - 280, top }}>
      <textarea
        className={css.composerPrompt}
        value={composerPrompt}
        placeholder={tt('canvas.composerPlaceholder')}
        rows={1}
        onPointerDown={event => event.stopPropagation()}
        onChange={event => setComposerPrompt(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submitComposer(composerTarget)
          }
        }}
      />
      {linkedCount > 0 ? <div className={css.composerMeta}>
        <span className={css.composerChip}>{tt('canvas.composerLinked', { count: linkedCount })}</span>
      </div> : null}
      <div className={css.composerControls}>
        <ComposerSelect
          ariaLabel={tt('canvas.model')}
          value={composerModel}
          options={[{ value: '', label: tt('canvas.modelPlaceholder') }, ...imageModels.map(item => ({ value: item, label: item }))]}
          onChange={setComposerModel}
        />
        <ComposerSelect
          ariaLabel={tt('canvas.size')}
          value={composerSize}
          options={[
            { value: 'auto', label: tt('canvas.sizeAuto') },
            { value: '1:1', label: '1:1' },
            { value: '3:4', label: '3:4' },
            { value: '16:9', label: '16:9' },
            { value: '9:16', label: '9:16' },
          ]}
          onChange={setComposerSize}
        />
        <ComposerSelect
          ariaLabel={tt('canvas.quality')}
          value={composerQuality}
          options={[
            { value: 'auto', label: tt('canvas.qualityAuto') },
            { value: '1k', label: '1K' },
            { value: '2k', label: '2K' },
            { value: '4k', label: '4K' },
          ]}
          onChange={setComposerQuality}
        />
        <ComposerSelect
          ariaLabel={tt('canvas.count')}
          value={String(composerCount)}
          options={[1, 2, 3, 4].map(item => ({ value: String(item), label: tt('canvas.countUnit', { count: item }) }))}
          onChange={value => setComposerCount(Number(value))}
        />
        <button
          type="button"
          className={css.composerSend}
          aria-label={tt('canvas.generate')}
          title={tt('canvas.generate')}
          disabled={!connected || composerBusy || (composerPrompt.trim() === '' && composerTextCount === 0 && composerAnnotationTexts.length === 0)}
          onClick={() => { void submitComposer(composerTarget) }}
        >{composerBusy ? <span className={css.nodeSpinner} aria-hidden="true" /> : <ToolbarIcon name="send" />}</button>
      </div>
    </div>
  }

  const renderMinimap = (): React.JSX.Element | null => {
    if (document === null || viewportSize.width === 0) return null
    const width = 220
    const height = 150
    const nodes = document.nodes
    let worldBounds = { x: -600, y: -600, w: 1200, h: 1200 }
    let scale = Math.min(width / worldBounds.w, height / worldBounds.h)
    let offset = { x: (width - worldBounds.w * scale) / 2, y: (height - worldBounds.h * scale) / 2 }
    if (nodes.length > 0) {
      const content = nodesBounds(nodes)
      worldBounds = { x: content.minX - 500, y: content.minY - 500, w: content.maxX - content.minX + 1000, h: content.maxY - content.minY + 1000 }
      scale = Math.min(width / worldBounds.w, height / worldBounds.h)
      offset = { x: (width - worldBounds.w * scale) / 2, y: (height - worldBounds.h * scale) / 2 }
    }
    const toMap = (worldX: number, worldY: number): Point => ({ x: (worldX - worldBounds.x) * scale + offset.x, y: (worldY - worldBounds.y) * scale + offset.y })
    const toWorld = (mapX: number, mapY: number): Point => ({ x: (mapX - offset.x) / scale + worldBounds.x, y: (mapY - offset.y) / scale + worldBounds.y })
    const viewportRect = (() => {
      const vx = -document.viewport.x / document.viewport.k
      const vy = -document.viewport.y / document.viewport.k
      const p1 = toMap(vx, vy)
      const p2 = toMap(vx + viewportSize.width / document.viewport.k, vy + viewportSize.height / document.viewport.k)
      return { x: p1.x, y: p1.y, w: Math.max(p2.x - p1.x, 4), h: Math.max(p2.y - p1.y, 4) }
    })()
    const jump = (event: ReactPointerEvent<HTMLDivElement>): void => {
      const bounds = event.currentTarget.getBoundingClientRect()
      const world = toWorld(event.clientX - bounds.left, event.clientY - bounds.top)
      setViewport({ k: document.viewport.k, x: viewportSize.width / 2 - world.x * document.viewport.k, y: viewportSize.height / 2 - world.y * document.viewport.k })
    }
    return <aside className={css.minimap} data-canvas-no-zoom="" aria-label={tt('canvas.minimap')}>
      <div className={css.minimapCanvas} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); jump(event) }}
        onPointerMove={event => { if (event.buttons === 1) jump(event) }}>
        {nodes.map(node => {
          const position = toMap(node.x, node.y)
          return <div key={node.id} className={`${css.minimapNode} ${node.type === 'image' ? css.minimapImage : css.minimapText} ${selectedIds.has(node.id) ? css.minimapSelected : ''}`}
            style={{ left: position.x, top: position.y, width: Math.max(node.width * scale, 2), height: Math.max(node.height * scale, 2) }} />
        })}
        <div className={css.minimapViewport} style={{ left: viewportRect.x, top: viewportRect.y, width: viewportRect.w, height: viewportRect.h }} />
      </div>
    </aside>
  }

  const renderContextMenu = (): ReactNode => {
    if (contextMenu !== null) {
      const close = (): void => setContextMenu(null)
      const items: Array<{ label: string; action: () => void; danger?: boolean; icon: ToolbarIconName }> = []
      if (contextMenu.type === 'node') {
        const node = nodeById.get(contextMenu.nodeId)
        if (node !== undefined && node.type === 'image' && (assetOf(node)?.url.length ?? 0) > 0) items.push({ label: tt('canvas.download'), icon: 'download', action: () => downloadNode(node) })
        if (node !== undefined && node.type === 'file' && (assetOf(node)?.url.length ?? 0) > 0) {
          items.push({ label: tt('canvas.skills.fileDownload'), icon: 'download', action: () => downloadFileNode(node) })
          items.push({ label: tt('canvas.skills.fileOpen'), icon: 'file', action: () => openFileNode(node) })
        }
        if (node !== undefined && node.type !== 'config') {
          items.push({ label: tt('canvas.skills.button'), icon: 'skill', action: () => openSkillMenu(node, { x: contextMenu.screen.x, y: contextMenu.screen.y }) })
        }
        if (node !== undefined && node.type === 'text' && !isAnnotationCard(node)) {
          items.push({ label: tt('canvas.polish.button'), icon: 'sparkle', action: () => setPolishNode({ screen: { x: contextMenu.screen.x, y: contextMenu.screen.y }, nodeId: node.id }) })
        }
        if (node === undefined || !isAnnotationCard(node)) items.push({ label: tt('canvas.duplicate'), icon: 'duplicate', action: () => duplicateNode(contextMenu.nodeId) })
        items.push({ label: tt('canvas.delete'), icon: 'trash', action: () => deleteNode(contextMenu.nodeId), danger: true })
      } else if (contextMenu.type === 'connection') {
        items.push({
          label: tt('canvas.deleteConnection'), icon: 'close', danger: true,
          action: () => {
            mutate(previous => ({ ...previous, connections: previous.connections.filter(connection => connection.id !== contextMenu.connectionId) }))
            setSelectedConnectionId(null)
          },
        })
      } else {
        items.push({ label: tt('canvas.addImage'), icon: 'image', action: () => setPickerOpen(true) })
        items.push({ label: tt('canvas.addTextNode'), icon: 'text', action: () => placeNewNode(createTextNode(contextMenu.world)) })
        items.push({ label: tt('canvas.addSketchNode'), icon: 'sketch', action: () => placeNewNode(createSketchNode(contextMenu.world)) })
        items.push({ label: tt('canvas.paste'), icon: 'duplicate', action: () => pasteClipboard(contextMenu.world) })
        items.push({ label: tt('canvas.fitView'), icon: 'fit', action: fitView })
      }
      return <div className={css.contextMenu} style={{ left: contextMenu.screen.x, top: contextMenu.screen.y }} data-canvas-no-zoom="" role="menu">
        {items.map(item => <button key={item.label} type="button" role="menuitem" data-danger={item.danger ? '' : undefined} onClick={() => { item.action(); close() }}><ToolbarIcon name={item.icon} />{item.label}</button>)}
      </div>
    }
    if (createMenu !== null) {
      return <div className={css.contextMenu} style={{ left: createMenu.screen.x, top: createMenu.screen.y }} data-canvas-no-zoom="" role="menu">
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createTextNode(createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="text" size={16} />{tt('canvas.addTextNode')}</button>
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createSketchNode(createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="sketch" size={16} />{tt('canvas.addSketchNode')}</button>
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }, createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="image" size={16} />{tt('canvas.addImageNode')}</button>
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createEmptyFileNode(createMenu.world)); setFileTargetNodeId(null); setCreateMenu(null) }}><ToolbarIcon name="file" size={16} />{tt('canvas.skills.addFileNode')}</button>
        <button type="button" role="menuitem" onClick={() => { setFileTargetNodeId(null); fileUploadRef.current?.click(); setCreateMenu(null) }}><ToolbarIcon name="upload" size={16} />{tt('canvas.skills.fileMenuUpload')}</button>
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createConfigNode(createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button>
      </div>
    }
    return null
  }

  const emptyState = document !== null && document.nodes.length === 0
    ? <div className={css.emptyHint} data-canvas-no-zoom="">
        <strong>{tt('canvas.emptyTitle')}</strong>
        <span>{tt('canvas.emptyHint')}</span>
      </div>
    : null

  const marqueeRect = marquee === null ? null : (() => {
    const x1 = (Math.min(marquee.start.x, marquee.current.x) * (document?.viewport.k ?? 1)) + (document?.viewport.x ?? 0)
    const y1 = (Math.min(marquee.start.y, marquee.current.y) * (document?.viewport.k ?? 1)) + (document?.viewport.y ?? 0)
    const x2 = (Math.max(marquee.start.x, marquee.current.x) * (document?.viewport.k ?? 1)) + (document?.viewport.x ?? 0)
    const y2 = (Math.max(marquee.start.y, marquee.current.y) * (document?.viewport.k ?? 1)) + (document?.viewport.y ?? 0)
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
  })()

  return <section ref={rootRef} className={css.root} data-canvas-workspace="">
    <header className={css.topBar} data-canvas-no-zoom="">
      <select className={css.projectSelect} value={document?.id ?? ''} onChange={event => { void selectProject(event.target.value) }} aria-label={tt('canvas.project')}>
        {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <IconButton name="new" label={tt('canvas.newCanvas')} onClick={() => { void newCanvas() }} />
      <IconButton name="deleteProject" label={confirmDeleteProject ? tt('canvas.deleteCanvasConfirm') : tt('canvas.deleteCanvas')} active={confirmDeleteProject} disabled={document === null} onClick={() => {
        if (confirmDeleteProject) { void removeCurrentProject() } else { setConfirmDeleteProject(true); window.setTimeout(() => setConfirmDeleteProject(false), 3000) }
      }} />
      {renamingTitle && document !== null
        ? <input
            className={css.titleInput}
            value={document.title}
            autoFocus
            aria-label={tt('canvas.rename')}
            onChange={event => updateDocument(previous => ({ ...previous, title: event.target.value }))}
            onBlur={() => setRenamingTitle(false)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') setRenamingTitle(false) }}
          />
        : <button type="button" className={css.titleButton} onDoubleClick={() => setRenamingTitle(true)} title={tt('canvas.renameHint')}>{document?.title ?? ''}</button>}
      <span className={css.topBarSpacer} />
      <span className={css.saveState} data-state={saveState}>{saveState === 'saving' ? tt('canvas.saving') : saveState === 'saved' ? tt('canvas.saved') : saveState === 'error' ? tt('canvas.saveFailed') : tt('canvas.loading')}</span>
    </header>

    <div
      ref={viewportRef}
      className={`${css.viewport} ${cursorClass}`}
      onPointerDown={onViewportPointerDown}
      onWheel={onWheel}
      onDoubleClick={event => {
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest('[data-node-id],[data-canvas-no-zoom]')) return
        setCreateMenu({ screen: { x: event.clientX, y: event.clientY }, world: screenToWorld(event.clientX, event.clientY) })
      }}
      onContextMenu={event => {
        const target = event.target instanceof Element ? event.target : null
        if (target?.closest('[data-node-id],[data-connection-hit],[data-canvas-no-zoom]')) return
        event.preventDefault()
        setContextMenu({ type: 'canvas', screen: { x: event.clientX, y: event.clientY }, world: screenToWorld(event.clientX, event.clientY) })
      }}
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      <div
        className={css.grid}
        style={backgroundMode === 'image' && document?.backgroundImage
          ? { backgroundImage: `url(${document.backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : backgroundMode === 'liquid' || backgroundMode === 'floatingLines' || backgroundMode === 'galaxy' || backgroundMode === 'silk' || backgroundMode === 'waves' || backgroundMode === 'faultyTerminal' || backgroundMode === 'dotField' || backgroundMode === 'dotGrid' || backgroundMode === 'shapeGrid'
            ? undefined
            : { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px` }}
        data-mode={backgroundMode}
        aria-hidden="true"
      >
        {backgroundMode === 'image' ? <div className={css.gridScrim} /> : null}
        {backgroundMode === 'flow' ? <FlowBackground /> : null}
        {backgroundMode === 'liquid' ? <LiquidEtherBackground /> : null}
        {backgroundMode === 'floatingLines' ? <FloatingLinesBackground /> : null}
        {backgroundMode === 'galaxy' ? <GalaxyBackground /> : null}
        {backgroundMode === 'silk' ? <SilkBackground /> : null}
        {backgroundMode === 'waves' ? <WavesBackground /> : null}
        {backgroundMode === 'faultyTerminal' ? <FaultyTerminalBackground /> : null}
        {backgroundMode === 'dotField' ? <DotFieldBackground /> : null}
        {backgroundMode === 'dotGrid' ? <DotGridBackground /> : null}
        {backgroundMode === 'shapeGrid' ? <ShapeGridBackground /> : null}
      </div>
      <div className={css.world} style={{ transform: `translate(${document?.viewport.x ?? 0}px, ${document?.viewport.y ?? 0}px) scale(${document?.viewport.k ?? 1})` }}>
        {renderConnections()}
        {document?.nodes.map(renderNode)}
        {renderAnnotationLinks()}
      </div>
      {marqueeRect !== null ? <div className={css.marquee} style={marqueeRect} aria-hidden="true" /> : null}
      {emptyState}
    </div>

    <div className={css.dockOuter} data-canvas-no-zoom="" ref={dockOuterRef}>
      <div className={`${css.dock} ${cursorClass}`} ref={dockRef} data-canvas-no-zoom="" role="toolbar">
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.toolSelect')}>
          <IconButton name="select" size={18} label={tt('canvas.toolSelect')} active={tool === 'select'} onClick={() => setTool('select')} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.toolPan')}>
          <IconButton name="pan" size={18} label={tt('canvas.toolPan')} active={tool === 'pan'} onClick={() => setTool('pan')} />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addImage')}>
          <IconButton
            name="image"
            size={18}
            label={tt('canvas.addImage')}
            active={imageMenu !== null}
            onClick={event => openDockMenu('image', event.currentTarget)}
            onMouseEnter={event => openDockMenu('image', event.currentTarget)}
            onMouseLeave={scheduleMenuClose}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addText')}>
          <IconButton name="text" size={18} label={tt('canvas.addText')} onClick={() => placeNewNode(createTextNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addSketch')}>
          <IconButton name="sketch" size={18} label={tt('canvas.addSketch')} onClick={() => placeNewNode(createSketchNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.skills.addFileNode')}>
          <IconButton
            name="file"
            size={18}
            label={tt('canvas.skills.addFileNode')}
            onClick={() => { setFileTargetNodeId(null); fileUploadRef.current?.click() }}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.addConfigNode')}>
          <IconButton name="sparkle" size={18} label={tt('canvas.addConfigNode')} onClick={() => placeNewNode(createConfigNode())} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.templateLibrary')}>
          <IconButton name="template" size={18} label={tt('canvas.templateLibrary')} active={libraryOpen} onClick={() => setLibraryOpen(previous => !previous)} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.skills.libraryButton')}>
          <IconButton
            name="skill"
            size={18}
            label={tt('canvas.skills.libraryButton')}
            active={skillLibraryOpen}
            onClick={() => { if (skillLibraryOpen) setSkillLibraryOpen(false); else openSkillLibrary() }}
          />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.background')}>
          <IconButton
            name="background"
            size={18}
            label={tt('canvas.background')}
            active={backgroundMenu !== null}
            onClick={event => openDockMenu('background', event.currentTarget)}
            onMouseEnter={event => openDockMenu('background', event.currentTarget)}
            onMouseLeave={scheduleMenuClose}
          />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.undo')}>
          <IconButton name="undo" size={18} label={tt('canvas.undo')} disabled={pastRef.current.length === 0} onClick={undo} />
        </div>
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.redo')}>
          <IconButton name="redo" size={18} label={tt('canvas.redo')} disabled={futureRef.current.length === 0} onClick={redo} />
        </div>
        <span className={css.dockDivider} aria-hidden="true" />
        <div className={css.dockItem} data-dock-item="" data-label={tt('canvas.delete')}>
          <IconButton name="trash" size={18} label={tt('canvas.delete')} disabled={selectedIds.size === 0 && selectedConnectionId === null} onClick={deleteSelection} />
        </div>
      </div>
    </div>

    {imageMenu !== null ? <div
      className={css.backgroundMenu}
      style={{ left: imageMenu.x, top: imageMenu.y - 10 }}
      data-canvas-no-zoom=""
      role="menu"
      onMouseEnter={clearMenuCloseTimer}
      onMouseLeave={scheduleMenuClose}
    >
      <button type="button" role="menuitem" onClick={() => { imageFileRef.current?.click(); setImageMenu(null) }}>{tt('canvas.imageMenuUpload')}</button>
      <button type="button" role="menuitem" onClick={() => { setPickerTab('gallery'); setPickerOpen(true); setImageMenu(null) }}>{tt('canvas.imageMenuAssets')}</button>
      <button type="button" role="menuitem" onClick={() => { setPickerTab('history'); setPickerOpen(true); setImageMenu(null) }}>{tt('canvas.imageMenuHistory')}</button>
      <button type="button" role="menuitem" onClick={() => { setPickerTab('generate'); setPickerOpen(true); setImageMenu(null) }}>{tt('canvas.imageMenuGenerate')}</button>
    </div> : null}
    <input
      ref={imageFileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      hidden
      onChange={event => {
        const files = [...(event.target.files ?? [])].filter(file => file.type.startsWith('image/'))
        event.target.value = ''
        if (files.length === 0) return
        const world = canvasCenter()
        void Promise.all(files.map(async file => {
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
          const dimensions = await readImageSize(dataUrl)
          return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
        })).then(assets => {
          const current = documentRef.current
          const selectedId = selectedIdsRef.current.size === 1 ? [...selectedIdsRef.current][0] : undefined
          const selectedNode = current?.nodes.find(node => node.id === selectedId)
          if (selectedNode?.type === 'image' && usableAsset(selectedNode) === undefined && assets[0] !== undefined) {
            mutate(previous => ({ ...previous, nodes: previous.nodes.map(node => node.id === selectedNode.id ? { ...node, width: sizeForAsset(assets[0]!).width, height: sizeForAsset(assets[0]!).height, metadata: { ...nodeMetadata(node), asset: assets[0], status: 'success' as const, error: undefined } } : node) }))
            if (assets.length > 1) addAssets(assets.slice(1), world)
          } else addAssets(assets, world)
        }).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
      }}
    />
    <input
      ref={fileUploadRef}
      type="file"
      hidden
      onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file !== undefined) void uploadCanvasFile(file, fileTargetNodeId)
        setFileTargetNodeId(null)
      }}
    />
    {skillMenu !== null ? (() => {
      const target = nodeById.get(skillMenu.nodeId)
      return target === undefined ? null : <SkillPicker
        anchor={skillMenu.screen}
        nodeType={target.type}
        catalog={skillCatalog}
        loading={skillCatalogLoading}
        batchCount={skillBatchCount(target.id)}
        installed={skillCatalog === null ? undefined : new Set(skillCatalog.installed)}
        onPick={skill => pickSkill(skill, target)}
        onInstall={skill => {
          setSkillMenu(null)
          openSkillLibrary(skill.installUrl ?? '')
        }}
        onClose={() => setSkillMenu(null)}
      />
    })() : null}
    {pendingSkill !== null ? <SkillConfirmDialog
      skill={pendingSkill.skill}
      onConfirm={instruction => {
        const pending = pendingSkill
        setPendingSkill(null)
        void startSkillRun(pending.skill, pending.nodeIds, instruction)
      }}
      onClose={() => setPendingSkill(null)}
    /> : null}
    {polishNode !== null ? <PolishMenu
      anchor={polishNode.screen}
      batchCount={(document?.nodes ?? []).filter(node => node.type === 'text' && selectedIds.has(node.id)).length || 1}
      busy={polishBusy !== null}
      onPick={(style, instruction) => runPolish(polishNode.nodeId, style, instruction)}
      onClose={() => setPolishNode(null)}
    /> : null}
    {backgroundMenu !== null ? <div
      className={css.backgroundMenu}
      style={{ left: backgroundMenu.x, top: backgroundMenu.y - 10 }}
      data-canvas-no-zoom=""
      role="menu"
      onMouseEnter={clearMenuCloseTimer}
      onMouseLeave={scheduleMenuClose}
    >
      {([
        ['dots', tt('canvas.backgroundDots')],
        ['lines', tt('canvas.backgroundLines')],
        ['waves', tt('canvas.backgroundWaves')],
        ['shapeGrid', tt('canvas.backgroundShapeGrid')],
        ['dotField', tt('canvas.backgroundDotField')],
        ['dotGrid', tt('canvas.backgroundDotGrid')],
        ['floatingLines', tt('canvas.backgroundFloatingLines')],
        ['flow', tt('canvas.backgroundFlow')],
        ['liquid', tt('canvas.backgroundLiquid')],
        ['faultyTerminal', tt('canvas.backgroundFaultyTerminal')],
        ['silk', tt('canvas.backgroundSilk')],
        ['galaxy', tt('canvas.backgroundGalaxy')],
        ['blank', tt('canvas.backgroundBlank')],
      ] as const).map(([mode, label]) => <button key={mode} type="button" role="menuitem" data-active={backgroundMode === mode ? '' : undefined} onClick={() => setBackgroundMode(mode)}>{label}</button>)}
      <span className={css.backgroundMenuDivider} />
      <button type="button" role="menuitem" data-active={backgroundMode === 'image' ? '' : undefined} onClick={() => backgroundFileRef.current?.click()}>{tt('canvas.backgroundUpload')}</button>
      {backgroundMode === 'image' && document?.backgroundImage ? <button type="button" role="menuitem" onClick={removeBackgroundImage}>{tt('canvas.backgroundRemove')}</button> : null}
      <input
        ref={backgroundFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={event => {
          const file = event.target.files?.[0]
          if (file !== undefined) void uploadBackgroundImage(file)
          event.target.value = ''
        }}
      />
    </div> : null}

    {nodeAddMenu !== null ? <div
      className={css.contextMenu}
      style={{ left: nodeAddMenu.screen.x + 12, top: nodeAddMenu.screen.y, transform: 'translateY(-50%)' }}
      data-canvas-no-zoom=""
      role="menu"
      onMouseEnter={clearNodeAddMenuTimer}
      onMouseLeave={scheduleNodeAddMenuClose}
    >
      <button type="button" role="menuitem" onClick={() => { addConnectedNode(nodeAddMenu.nodeId, position => createTextNode(position)); setNodeAddMenu(null) }}><ToolbarIcon name="text" size={16} />{tt('canvas.addTextNode')}</button>
      <button type="button" role="menuitem" onClick={() => { addConnectedNode(nodeAddMenu.nodeId, position => createSketchNode(position)); setNodeAddMenu(null) }}><ToolbarIcon name="sketch" size={16} />{tt('canvas.addSketchNode')}</button>
      <button type="button" role="menuitem" onClick={() => { addConnectedNode(nodeAddMenu.nodeId, position => createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }, position)); setNodeAddMenu(null) }}><ToolbarIcon name="image" size={16} />{tt('canvas.addImageNode')}</button>
      {nodeAddMenu.nodeType !== 'config' ? <button type="button" role="menuitem" onClick={() => { addConnectedNode(nodeAddMenu.nodeId, position => createConfigNode(position)); setNodeAddMenu(null) }}><ToolbarIcon name="sparkle" size={16} />{tt('canvas.addConfigNode')}</button> : null}
    </div> : null}

    <div className={css.zoomDock} data-canvas-no-zoom="">
      <IconButton name="minimap" label={minimapOpen ? tt('canvas.minimapClose') : tt('canvas.minimapOpen')} active={minimapOpen} onClick={() => setMinimapOpen(previous => !previous)} />
      <IconButton name="fit" label={tt('canvas.fitView')} onClick={fitView} />
      <input
        type="range"
        min={5}
        max={500}
        step={1}
        value={Math.round((document?.viewport.k ?? 1) * 100)}
        onChange={event => setZoomAtCenter(Number(event.target.value) / 100)}
        aria-label={tt('canvas.zoom')}
      />
      <span className={css.zoomValue}>{Math.round((document?.viewport.k ?? 1) * 100)}%</span>
    </div>

    {minimapOpen ? renderMinimap() : null}
    {renderComposer()}
    {renderContextMenu()}
    {libraryOpen ? <TemplateLibrary api={api} onClose={() => setLibraryOpen(false)} onUse={applyTemplate} /> : null}
    {skillLibraryOpen ? <SkillLibraryDialog
      library={skillLibrary}
      loading={libraryLoading}
      busy={libraryBusy}
      presetUrl={libraryPresetUrl}
      onReload={() => { void loadSkillLibrary() }}
      onInstallUrls={(sources, force) => { void installSkillUrls(sources, force) }}
      onInstallArchive={(file, force) => { void installSkillArchive(file, force) }}
      onRemove={name => { void removeSkillEntry(name) }}
      onClose={() => setSkillLibraryOpen(false)}
    /> : null}

    {error !== null ? <div className={css.errorToast} role="status" data-canvas-no-zoom="">
      <span>{error}</span>
      {errorAction !== null && errorAction.forError === error ? <button type="button" className={css.errorToastAction} onClick={() => { errorAction.run(); setErrorAction(null); setError(null) }}>{errorAction.label}</button> : null}
      <button type="button" aria-label={tt('canvas.dismiss')} onClick={() => { setError(null); setErrorAction(null) }}><ToolbarIcon name="close" /></button>
    </div> : null}
    {notice !== null ? <div className={css.errorToast} data-variant="notice" role="status" data-canvas-no-zoom=""><span>{notice}</span><button type="button" aria-label={tt('canvas.dismiss')} onClick={() => setNotice(null)}><ToolbarIcon name="close" /></button></div> : null}

    {pickerOpen ? <ImagePicker
      api={api}
      history={history}
      gallery={gallery}
      imageModels={imageModels}
      defaultChannelId={defaultChannelId}
      canvasId={document?.id ?? ''}
      connected={connected}
      initialTab={pickerTab}
      onClose={() => setPickerOpen(false)}
      onAssets={assets => { addAssets(assets); setPickerOpen(false) }}
      onTask={task => {
        if (document === null) return
        const center = canvasCenter()
        const size = nodeSizeFromRatio(task.request.size, IMAGE_NODE_SIZE)
        const node: CanvasNode = {
          id: newId('node'), type: 'image', title: tt('canvas.imageNode'),
          x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2),
          width: size.width, height: size.height,
          metadata: { status: 'generating', prompt: task.request.prompt, model: task.request.model, size: task.request.size, quality: task.request.quality, taskId: task.id, sourceNodeId: task.request.canvas?.sourceNodeId },
        }
        placeNewNode(node)
        setPickerOpen(false)
      }}
    /> : null}
  </section>
}

/** Free-hand drawing surface for sketch nodes. Strokes live in node metadata
 *  (normalized 0..1 board space, so the frame is fixed-size and never rescaled);
 *  after a short idle the board rasterizes to a white-background PNG and stores
 *  it as the node asset, which makes the sketch usable as a generation
 *  reference exactly like any uploaded image node. */
function SketchBoard(props: {
  api: ImageGenApi
  node: CanvasNode
  /** Current viewport zoom; only used to keep the backing store crisp. */
  zoom: number
  strokes: CanvasSketchStroke[]
  onStrokesChange: (strokes: CanvasSketchStroke[]) => void
  onAssetChange: (asset: CanvasAssetRef | undefined) => void
}): React.JSX.Element {
  const { node, strokes } = props
  const [color, setColor] = useState(SKETCH_COLORS[0]!)
  const [widthIndex, setWidthIndex] = useState(1)
  const [erasing, setErasing] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const zoomRef = useRef(props.zoom)
  zoomRef.current = props.zoom
  const liveStrokeRef = useRef<CanvasSketchStroke | null>(null)
  const eraserDragRef = useRef(false)
  const apiRef = useRef(props.api)
  apiRef.current = props.api
  const callbacksRef = useRef({ onStrokesChange: props.onStrokesChange, onAssetChange: props.onAssetChange })
  callbacksRef.current = { onStrokesChange: props.onStrokesChange, onAssetChange: props.onAssetChange }

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width < 2 || height < 2) return
    const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)
      * Math.min(3, Math.max(1, zoomRef.current))
    const backingWidth = Math.round(width * dpr)
    const backingHeight = Math.round(height * dpr)
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth
      canvas.height = backingHeight
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(backingWidth / width, 0, 0, backingHeight / height, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    for (const stroke of strokesRef.current) drawSketchStroke(ctx, stroke, width, height)
    const live = liveStrokeRef.current
    if (live !== null) drawSketchStroke(ctx, live, width, height)
  }, [])

  // Debounced raster sync: every committed stroke state lands as the node's
  // PNG asset (or clears it when the board is emptied). Token-guarded against
  // burst edits; a synced-strokes key dedupes re-runs that only happen because
  // a canvas save round-trip handed React a fresh (but identical) strokes
  // array — without it every save would trigger a redundant re-upload.
  const syncTokenRef = useRef(0)
  const syncedStrokesRef = useRef<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const token = ++syncTokenRef.current
    const strokesKey = JSON.stringify(strokes)
    if (syncedStrokesRef.current === strokesKey) return
    const timer = window.setTimeout(() => {
      if (syncTokenRef.current !== token) return
      if (strokes.length === 0) {
        syncedStrokesRef.current = strokesKey
        callbacksRef.current.onAssetChange(undefined)
        return
      }
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width < 2 || height < 2) return
      let raster: { dataUrl: string; width: number; height: number }
      try {
        raster = rasterizeSketch(strokes, width, height)
      } catch { return }
      void apiRef.current.canvasUpload(raster.dataUrl, raster.width, raster.height, { origin: 'upload', originId: `sketch-${node.id}` })
        .then(asset => {
          if (syncTokenRef.current !== token) return
          syncedStrokesRef.current = strokesKey
          callbacksRef.current.onAssetChange(asset)
        })
        .catch(() => { /* board stays usable without the synced reference */ })
    }, strokes.length === 0 ? 150 : 600)
    return () => window.clearTimeout(timer)
  }, [node.id, strokes])

  useEffect(() => { redraw() }, [redraw, strokes, drawing, Math.round(props.zoom * 50)])

  const boardPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current
    if (canvas === null) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const eraseAt = (point: Point): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    const radiusX = SKETCH_ERASER_RADIUS / rect.width
    const radiusY = SKETCH_ERASER_RADIUS / rect.height
    const kept = strokesRef.current.filter(stroke => !stroke.points.some(candidate =>
      Math.abs(candidate.x - point.x) < radiusX && Math.abs(candidate.y - point.y) < radiusY))
    if (kept.length !== strokesRef.current.length) callbacksRef.current.onStrokesChange(kept)
  }

  const onBoardPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    // Keep the stroke off the node-drag / marquee gesture stack.
    event.stopPropagation()
    event.preventDefault()
    const point = boardPoint(event)
    if (point === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (erasing) {
      eraserDragRef.current = true
      eraseAt(point)
      return
    }
    liveStrokeRef.current = { color, width: SKETCH_WIDTHS[widthIndex]!, points: [point] }
    setDrawing(true)
    redraw()
  }

  const onBoardPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (eraserDragRef.current) {
      const point = boardPoint(event)
      if (point !== null) eraseAt(point)
      return
    }
    const live = liveStrokeRef.current
    if (live === null) return
    const point = boardPoint(event)
    if (point === null) return
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const last = live.points[live.points.length - 1]!
    if (rect !== undefined && Math.hypot((point.x - last.x) * rect.width, (point.y - last.y) * rect.height) < 1.5) return
    live.points.push({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 })
    redraw()
  }

  const onBoardPointerUp = (): void => {
    if (eraserDragRef.current) {
      eraserDragRef.current = false
      return
    }
    const live = liveStrokeRef.current
    if (live === null) return
    liveStrokeRef.current = null
    setDrawing(false)
    callbacksRef.current.onStrokesChange([...strokesRef.current, live])
  }

  return <div className={css.sketch} data-canvas-no-zoom="">
    <div className={css.sketchBoardWrap}>
      <canvas
        ref={canvasRef}
        className={css.sketchBoard}
        data-erasing={erasing ? '' : undefined}
        onPointerDown={onBoardPointerDown}
        onPointerMove={onBoardPointerMove}
        onPointerUp={onBoardPointerUp}
        onPointerCancel={onBoardPointerUp}
      />
      {strokes.length === 0 && !drawing ? <span className={css.sketchPlaceholder}>{tt('canvas.sketchPlaceholder')}</span> : null}
    </div>
    <div className={css.sketchToolbar} onPointerDown={event => event.stopPropagation()}>
      <div className={css.sketchColors} role="radiogroup" aria-label={tt('canvas.sketchBrush')}>
        {SKETCH_COLORS.map(item => <button
          key={item}
          type="button"
          role="radio"
          aria-checked={item === color && !erasing}
          data-active={item === color && !erasing ? '' : undefined}
          className={css.sketchSwatch}
          style={{ background: item }}
          title={tt('canvas.sketchBrush')}
          onClick={() => { setColor(item); setErasing(false) }}
        />)}
      </div>
      <div className={css.sketchTools}>
        {SKETCH_WIDTHS.map((item, index) => <button
          key={item}
          type="button"
          className={css.sketchWidth}
          data-active={!erasing && index === widthIndex ? '' : undefined}
          title={tt('canvas.sketchWidth')}
          aria-label={`${tt('canvas.sketchWidth')} ${index + 1}`}
          onClick={() => { setWidthIndex(index); setErasing(false) }}
        ><span style={{ width: SKETCH_WIDTH_DOTS[index], height: SKETCH_WIDTH_DOTS[index] }} /></button>)}
        <span className={css.sketchToolDivider} aria-hidden="true" />
        <button
          type="button"
          className={css.sketchToolBtn}
          data-active={erasing ? '' : undefined}
          title={tt('canvas.sketchEraser')}
          aria-label={tt('canvas.sketchEraser')}
          onClick={() => setErasing(previous => !previous)}
        ><ToolbarIcon name="eraser" size={14} /></button>
        <button
          type="button"
          className={css.sketchToolBtn}
          title={tt('canvas.sketchUndo')}
          aria-label={tt('canvas.sketchUndo')}
          disabled={strokes.length === 0}
          onClick={() => callbacksRef.current.onStrokesChange(strokes.slice(0, -1))}
        ><ToolbarIcon name="undo" size={14} /></button>
        <button
          type="button"
          className={css.sketchToolBtn}
          title={tt('canvas.sketchClear')}
          aria-label={tt('canvas.sketchClear')}
          disabled={strokes.length === 0}
          onClick={() => callbacksRef.current.onStrokesChange([])}
        ><ToolbarIcon name="trash" size={14} /></button>
      </div>
    </div>
  </div>
}

function ImagePicker(props: {
  api: ImageGenApi
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  imageModels: string[]
  defaultChannelId?: string
  canvasId: string
  connected: boolean
  initialTab?: 'upload' | 'history' | 'gallery' | 'generate'
  onClose: () => void
  onAssets: (assets: CanvasAssetRef[]) => void
  onTask: (task: GenerationTask) => void
}): React.JSX.Element {
  const { api, history, gallery, imageModels, defaultChannelId, canvasId, connected, onClose, onAssets } = props
  const [tab, setTab] = useState<'upload' | 'history' | 'gallery' | 'generate'>(props.initialTab ?? 'upload')
  const [selected, setSelected] = useState<string[]>([])
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({})
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(imageModels[0] ?? '')
  const [size, setSize] = useState('auto')
  const [quality, setQuality] = useState('auto')
  const [busy, setBusy] = useState(false)
  const toggle = (key: string): void => setSelected(previous => previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key])
  const items = (tab === 'history' ? history : gallery).flatMap(entry => entry.images.map((image, index) => ({ key: `${entry.id}:${index}`, entry, image, index })))
  const uploadFiles = (files: File[]): void => {
    setBusy(true)
    void Promise.all(files.map(async file => {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      const sizeOf = await readImageSize(dataUrl)
      return api.canvasUpload(dataUrl, sizeOf.width, sizeOf.height, { origin: 'upload', originId: file.name })
    })).then(assets => { onAssets(assets) }).catch(() => {}).finally(() => setBusy(false))
  }
  const addSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      const assets: CanvasAssetRef[] = []
      for (const key of selected) {
        const [entryId, indexText] = key.split(':'); const index = Number(indexText); const item = items.find(candidate => candidate.key === key)
        if (entryId === undefined || item === undefined) continue
        const sizeOf = dimensions[key] ?? await readImageSize(item.image.url).catch(() => ({ width: 1024, height: 1024 }))
        assets.push(await api.canvasImport(tab === 'history' ? 'history' : 'gallery', entryId, index, sizeOf.width, sizeOf.height))
      }
      if (assets.length > 0) onAssets(assets)
    } finally { setBusy(false) }
  }
  const generate = async (): Promise<void> => {
    if (!connected || prompt.trim() === '') return
    setBusy(true)
    try {
      const task = await api.taskSubmit({ mode: 'text', model, prompt: prompt.trim(), size, quality, n: 1, detail: '', ...(defaultChannelId === undefined ? {} : { channelId: defaultChannelId }), canvas: { canvasId } })
      props.onTask(task)
    } finally { setBusy(false) }
  }
  return <div className={css.modalBackdrop} role="dialog" aria-modal="true" data-canvas-no-zoom=""><section className={css.picker}>
    <header className={css.pickerHeader}><strong>{tt('canvas.addImage')}</strong><button type="button" aria-label={tt('canvas.close')} title={tt('canvas.close')} onClick={onClose}>×</button></header>
    <nav className={css.pickerTabs} role="tablist">{(['upload', 'history', 'gallery', 'generate'] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} data-active={tab === item ? '' : undefined} onClick={() => { setTab(item); setSelected([]) }}>{item === 'upload' ? tt('canvas.tabUpload') : item === 'history' ? tt('canvas.tabHistory') : item === 'gallery' ? tt('canvas.tabGallery') : tt('canvas.tabGenerate')}</button>)}</nav>
    <div className={css.pickerBody}>
      {tab === 'upload' ? <label className={css.uploadBox} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const files = [...(event.dataTransfer.files ?? [])].filter(file => file.type.startsWith('image/')); if (files.length === 0) return; uploadFiles(files) }}><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={busy} onChange={event => { const files = [...(event.target.files ?? [])]; if (files.length > 0) uploadFiles(files) }} /><span className={css.uploadIcon}><ToolbarIcon name="image" /></span><strong>{tt('canvas.dropHint')}</strong><small>{tt('canvas.dropSub')}</small></label> : null}
      {(tab === 'history' || tab === 'gallery') ? <><div className={css.pickerGrid}>{items.map(item => <button key={item.key} type="button" role="option" aria-selected={selected.includes(item.key)} className={css.pickerCard} data-selected={selected.includes(item.key) ? '' : undefined} onClick={() => toggle(item.key)}><img draggable={false} src={item.image.url} alt={item.entry.prompt} onLoad={event => { const image = event.currentTarget; setDimensions(previous => ({ ...previous, [item.key]: { width: image.naturalWidth || 1, height: image.naturalHeight || 1 } })) }} /><span className={css.pickerCardPrompt}>{item.entry.prompt || tt('canvas.untitledWork')}</span><small>{item.entry.model} · {item.index + 1}/{item.entry.images.length}</small></button>)}</div><footer className={css.pickerFooter}><span>{tt('canvas.picked', { count: selected.length })}</span><button type="button" disabled={busy || selected.length === 0} onClick={() => { void addSelected() }}>{tt('canvas.addToCanvas')}</button></footer></> : null}
      {tab === 'generate' ? <div className={css.generateForm}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('canvas.composerPlaceholder')} /><ComposerSelect value={model} options={imageModels.map(item => ({ value: item, label: item }))} ariaLabel={tt('canvas.model')} onChange={setModel} /><div className={css.inspectorRow}><ComposerSelect value={size} options={[{ value: 'auto', label: tt('canvas.sizeAuto') }, { value: '1:1', label: '1:1' }, { value: '3:4', label: '3:4' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }]} ariaLabel={tt('canvas.size')} onChange={setSize} /><ComposerSelect value={quality} options={[{ value: 'auto', label: tt('canvas.qualityAuto') }, { value: '1k', label: '1K' }, { value: '2k', label: '2K' }, { value: '4k', label: '4K' }]} ariaLabel={tt('canvas.quality')} onChange={setQuality} /></div><button type="button" disabled={!connected || busy || prompt.trim() === ''} onClick={() => { void generate() }}><ToolbarIcon name="sparkle" />{tt('canvas.generateAndAdd')}</button>{!connected ? <small>{tt('canvas.needApi')}</small> : null}</div> : null}
    </div>
  </section></div>
}

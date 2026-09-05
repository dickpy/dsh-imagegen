/** Infinite canvas workspace, rebuilt after the node-graph model of
 * basketikun/infinite-canvas: free nodes (image/text), drag-to-connect edges,
 * marquee + multi selection, context menus, minimap, undo/redo and a floating
 * generation composer. Selecting a node pops the composer: the prompt is typed
 * there (or supplied by connected text nodes), every upstream image node joins
 * as a reference, and results land as new image nodes on the right. */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { CanvasAssetRef, CanvasConnection, CanvasDocument, CanvasNode, GenerateRequest, GenerationTask, HistoryEntry } from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import css from './canvas-workspace.module.css'

type CanvasTool = 'select' | 'pan'

const MIN_SCALE = 0.05
const MAX_SCALE = 5
const GRID_SIZE = 48
const IMAGE_NODE_SIZE = { width: 320, height: 320 }
const TEXT_NODE_SIZE = { width: 280, height: 150 }
const CONFIG_NODE_SIZE = { width: 240, height: 96 }
const HISTORY_LIMIT = 60
const WORLD_PAD = 12000

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
}

interface ResizeState {
  nodeId: string
  corner: 'bottom-right' | 'bottom-left'
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

function assetOf(node: CanvasNode): CanvasAssetRef | undefined {
  return node.type === 'image' ? nodeMetadata(node).asset : undefined
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

type ToolbarIconName = 'new' | 'select' | 'pan' | 'image' | 'text' | 'trash' | 'undo' | 'redo' | 'fit' | 'minimap' | 'background' | 'download' | 'duplicate' | 'sparkle' | 'send' | 'close' | 'deleteProject'

function ToolbarIcon({ name }: { name: ToolbarIconName }): React.JSX.Element {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (name === 'new') return <svg {...common}><path d="M8 3v10M3 8h10" /></svg>
  if (name === 'select') return <svg {...common}><path d="M3 2.5l9.3 6.2-4 1.1-1.5 3.7L3 2.5z" /></svg>
  if (name === 'pan') return <svg {...common}><path d="M8 2v12M2 8h12M5 5l3-3 3 3M5 11l3 3 3-3" /></svg>
  if (name === 'image') return <svg {...common}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="5.5" cy="5.8" r="1" /><path d="M2.5 12.5l3.3-3.2 2.4 2.2 2.8-2.8 2.5 2.7M12 2v4M10 4h4" /></svg>
  if (name === 'text') return <svg {...common}><path d="M3 3h10M8 3v10M5.5 13h5" /></svg>
  if (name === 'trash') return <svg {...common}><path d="M3.5 4.5h9M6 2.5h4M5 4.5l.6 9h4.8l.6-9M6.5 6.5v4.5M9.5 6.5v4.5" /></svg>
  if (name === 'undo') return <svg {...common}><path d="M3 7a5 5 0 1 1 1.5 4M3 3v4h4" /></svg>
  if (name === 'redo') return <svg {...common}><path d="M13 7a5 5 0 1 0-1.5 4M13 3v4h-4" /></svg>
  if (name === 'fit') return <svg {...common}><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
  if (name === 'minimap') return <svg {...common}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 6h3v4H5zM10 8h2v3h-2" /></svg>
  if (name === 'background') return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11M2.5 8h11M4 4.3c2.4 1.9 5.6 1.9 8 0M4 11.7c2.4-1.9 5.6-1.9 8 0" /></svg>
  if (name === 'download') return <svg {...common}><path d="M8 2.5v8M5 7.5l3 3 3-3M3 13.5h10" /></svg>
  if (name === 'duplicate') return <svg {...common}><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 3h-7a.5.5 0 0 0-.5.5v7" /></svg>
  if (name === 'send') return <svg {...common}><path d="M14 2L7 9M14 2L9.5 14l-2.5-5L2 6.5 14 2z" /></svg>
  if (name === 'close') return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  if (name === 'deleteProject') return <svg {...common}><path d="M2.5 5h11M6.5 5V3h3v2M4 5l.8 8.5h6.4L12 5M6.7 7.5v3.5M9.3 7.5v3.5" /></svg>
  return <svg {...common}><path d="M8 2l1.2 4.2L13.5 8l-4.3 1.8L8 14l-1.2-4.2L2.5 8l4.3-1.8L8 2z" /></svg>
}

function IconButton(props: { name: ToolbarIconName; label: string; active?: boolean; disabled?: boolean; onClick?: () => void }): React.JSX.Element {
  return <button type="button" className={css.iconButton} data-active={props.active ? '' : undefined} aria-label={props.label} title={props.label} disabled={props.disabled} onClick={props.onClick}><ToolbarIcon name={props.name} /></button>
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
  const [minimapOpen, setMinimapOpen] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false)
  const [saveState, setSaveState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  // Floating generation composer state.
  const [composerPrompt, setComposerPrompt] = useState('')
  const [composerModel, setComposerModel] = useState(imageModels[0] ?? '')
  const [composerSize, setComposerSize] = useState('auto')
  const [composerQuality, setComposerQuality] = useState('auto')
  const [composerCount, setComposerCount] = useState(1)
  const [composerBusy, setComposerBusy] = useState(false)

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

  const updateNodes = useCallback((updater: (nodes: CanvasNode[]) => CanvasNode[]): void => {
    updateDocument(previous => ({ ...previous, nodes: updater(previous.nodes) }))
  }, [updateDocument])

  const patchNode = useCallback((nodeId: string, patch: Partial<NonNullable<CanvasNode['metadata']>> & Partial<Pick<CanvasNode, 'title' | 'width' | 'height' | 'x' | 'y'>>): void => {
    updateNodes(nodes => nodes.map(node => node.id === nodeId
      ? { ...node, ...('title' in patch ? { title: patch.title ?? node.title } : {}), ...('x' in patch || 'y' in patch || 'width' in patch || 'height' in patch ? { x: patch.x ?? node.x, y: patch.y ?? node.y, width: patch.width ?? node.width, height: patch.height ?? node.height } : {}), metadata: { ...nodeMetadata(node), ...patch } }
      : node))
  }, [updateNodes])

  const deleteSelection = useCallback((): void => {
    const ids = selectedIdsRef.current
    const connectionId = selectedConnectionId
    if (ids.size === 0 && connectionId === null) return
    mutate(previous => ({
      ...previous,
      nodes: previous.nodes.filter(node => !ids.has(node.id)),
      connections: previous.connections.filter(connection => !ids.has(connection.fromNodeId) && !ids.has(connection.toNodeId) && connection.id !== connectionId),
    }))
    setSelectedIds(new Set()); setSelectedConnectionId(null)
  }, [mutate, selectedConnectionId])

  const duplicateSelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    const clones = current.nodes.filter(node => selectedIdsRef.current.has(node.id)).map(node => ({ ...node, id: newId('node'), x: node.x + 40, y: node.y + 40, metadata: { ...nodeMetadata(node) } }))
    if (clones.length === 0) return
    const idMap = new Map(current.nodes.filter(node => selectedIdsRef.current.has(node.id)).map((node, index) => [node.id, clones[index]!.id]))
    const connections = current.connections
      .filter(connection => idMap.has(connection.fromNodeId) && idMap.has(connection.toNodeId))
      .map(connection => ({ id: newId('edge'), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)! }))
    mutate(previous => ({ ...previous, nodes: [...previous.nodes, ...clones], connections: [...previous.connections, ...connections] }))
    setSelectedIds(new Set(clones.map(node => node.id)))
  }, [mutate])

  const copySelection = useCallback((): void => {
    const current = documentRef.current
    if (current === null || selectedIdsRef.current.size === 0) return
    internalClipboard.current = {
      nodes: current.nodes.filter(node => selectedIdsRef.current.has(node.id)).map(node => ({ ...node, metadata: { ...nodeMetadata(node) } })),
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
    const idMap = new Map<string, string>()
    const clones = clipboard.nodes.map(node => {
      const id = newId('node'); idMap.set(node.id, id)
      return { ...node, id, x: Math.round(node.x + dx), y: Math.round(node.y + dy), metadata: { ...nodeMetadata(node) } }
    })
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

  // ----------------------------------------------------------- generation

  const submitComposer = useCallback(async (target: CanvasNode | null): Promise<void> => {
    const current = documentRef.current
    if (current === null || composerBusy) return
    if (!connected) { setError(tt('canvas.needApi')); onOpenSettings?.(); return }
    const inputs = target === null ? [] : upstreamNodes(current, target.id)
    const referenceImages = inputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined)
    const upstreamText = inputs.filter(node => node.type === 'text' && (nodeMetadata(node).text ?? '').trim() !== '').map(node => nodeMetadata(node).text!.trim())
    const prompt = (composerPrompt.trim() !== '' ? composerPrompt.trim() : upstreamText.join('\n').trim())
    if (prompt === '') { setError(tt('canvas.needPrompt')); return }
    const model = imageModels.includes(composerModel) ? composerModel : imageModels[0] ?? ''
    if (model === '') { setError(tt('canvas.needModel')); return }
    const count = Math.min(4, Math.max(1, Math.round(composerCount)))
    const baseAsset = referenceImages[0] !== undefined ? usableAsset(referenceImages[0]!) : undefined
    setComposerBusy(true)
    try {
      let image: string | undefined
      let refName: string | undefined
      if (baseAsset !== undefined) {
        image = await assetToDataUrl(baseAsset)
        refName = 'canvas-reference.png'
      }
      const footprint = nodeSizeFromRatio(composerSize, IMAGE_NODE_SIZE)
      const request: GenerateRequest = {
        mode: image === undefined ? 'text' : 'edit', model, prompt, size: composerSize, quality: composerQuality, n: count, detail: '',
        ...(defaultChannelId === undefined ? {} : { channelId: defaultChannelId }),
        ...(image === undefined ? {} : { image, refName }),
        canvas: {
          canvasId: current.id,
          ...(target === null ? {} : { sourceNodeId: referenceImages[0]?.id ?? target.id, parentNodeId: target.id, placement: 'right' as const }),
        },
      }
      const task = await api.taskSubmit(request)
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
            metadata: { status: 'generating', taskId: task.id, ...(anchor !== undefined ? { sourceNodeId: anchor.id } : {}), prompt, model },
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
  }, [api, canvasCenter, composerBusy, composerCount, composerModel, composerPrompt, composerQuality, composerSize, connected, defaultChannelId, imageModels, mutate, onOpenSettings, upstreamNodes])

  // ---------------------------------------------------------- task intake

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
        for (const image of task.result!.images) {
          const dataUrl = imageDataUrl(image)
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
      const first = list[0] === undefined ? await api.canvasCreate(tt('canvas.untitled')) : await api.canvasRead(list[0].id)
      if (disposed) return
      setProjects(list[0] === undefined ? [summaryOf(first)] : list)
      setDocument(first)
      syncedRef.current = JSON.stringify(first)
      setSaveState('saved')
    }).catch(caught => { if (!disposed) { setError(caught instanceof Error ? caught.message : String(caught)); setSaveState('error') } })
    return () => { disposed = true }
  }, [api])

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
  const composerTarget = singleSelected !== null && singleSelected.type === 'config' ? singleSelected : null
  const composerInputs = useMemo(
    () => composerTarget === null || document === null ? [] : upstreamNodes(document, composerTarget.id),
    [composerTarget, document, upstreamNodes],
  )
  const composerReferenceCount = composerInputs.filter(node => node.type === 'image' && usableAsset(node) !== undefined).length
  const composerTextCount = composerInputs.filter(node => node.type === 'text' && (nodeMetadata(node).text ?? '').trim() !== '').length
  const composerVisible = composerTarget !== null

  // Prefill the prompt from connected text nodes whenever the target changes.
  useEffect(() => {
    const targetId = composerTarget?.id ?? null
    if (targetId === composerTargetRef.current) return
    composerTargetRef.current = targetId
    if (composerTarget === null) return
    const texts = (document?.connections ?? [])
      .filter(connection => connection.toNodeId === composerTarget.id)
      .map(connection => document?.nodes.find(node => node.id === connection.fromNodeId))
      .filter((node): node is CanvasNode => node !== undefined && node.type === 'text' && (nodeMetadata(node).text ?? '').trim() !== '')
      .map(node => nodeMetadata(node).text!.trim())
    setComposerPrompt(texts.join('\n'))
  }, [composerTarget, document])

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const isEditingTarget = (target: EventTarget | null): boolean => target instanceof Element
      && (target.matches('input, textarea, select, [contenteditable="true"]'))

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Control') setCtrlPressed(true)
      if (event.code === 'Space' && !isEditingTarget(event.target)) {
        event.preventDefault()
        setSpacePressed(true)
      }
      if (documentRef.current === null) return
      const mod = event.ctrlKey || event.metaKey
      if (event.key === 'Escape') {
        setContextMenu(null); setCreateMenu(null)
        if (!isEditingTarget(event.target)) { setSelectedIds(new Set()); setSelectedConnectionId(null) }
        return
      }
      if (isEditingTarget(event.target)) return
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
  }, [addAssets, api, canvasCenter, copySelection, deleteSelection, duplicateSelection, pasteClipboard, redo, undo])

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
    setContextMenu(null); setCreateMenu(null)
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
        const dx = (event.clientX - resize.startX) / scale
        const dy = (event.clientY - resize.startY) / scale
        const minWidth = 140
        const minHeight = 100
        let width = Math.max(minWidth, resize.width + (resize.corner === 'bottom-right' ? dx : -dx))
        let height = Math.max(minHeight, resize.height + dy)
        if (resize.ratio !== null) height = Math.max(minHeight, Math.round(width * resize.ratio))
        updateNodes(nodes => nodes.map(node => node.id === resize.nodeId
          ? { ...node, x: Math.round(resize.corner === 'bottom-right' ? resize.x : resize.x + (resize.width - width)), y: Math.round(resize.y), width: Math.round(width), height: Math.round(height) }
          : node))
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
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, snapshot: JSON.stringify(current), origins }
  }, [temporaryPanTool, tool])

  const handleConnectStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, nodeId: string, handleType: 'source' | 'target'): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const world = screenToWorld(event.clientX, event.clientY)
    const next: ConnectState = { nodeId, handleType, mouse: world, targetId: null }
    connectRef.current = next
    setConnecting(next)
    setSelectedConnectionId(null)
  }, [screenToWorld])

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: 'bottom-right' | 'bottom-left'): void => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const asset = assetOf(node)
    const ratio = node.type === 'image' && asset !== undefined && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : null
    resizeRef.current = { nodeId: node.id, corner, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, x: node.x, y: node.y, ratio }
    beginHistory()
  }, [beginHistory])

  const handleConnectionSelect = useCallback((connectionId: string): void => {
    setSelectedConnectionId(connectionId)
    setSelectedIds(new Set())
  }, [])

  // -------------------------------------------------------- file dropping

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const files = [...(event.dataTransfer.files ?? [])].filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    const world = screenToWorld(event.clientX, event.clientY)
    void Promise.all(files.map(async file => {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      const dimensions = await readImageSize(dataUrl)
      return api.canvasUpload(dataUrl, dimensions.width, dimensions.height, { origin: 'upload', originId: file.name })
    })).then(assets => addAssets(assets, world)).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [addAssets, api, screenToWorld])

  // ------------------------------------------------------------ projects

  const newCanvas = useCallback(async (): Promise<void> => {
    try {
      const next = await api.canvasCreate(tt('canvas.untitled'))
      setProjects(previous => [summaryOf(next), ...previous])
      setDocument(next); setSelectedIds(new Set()); setSelectedConnectionId(null)
      syncedRef.current = JSON.stringify(next); setSaveState('saved')
      pastRef.current = []; futureRef.current = []; setHistoryVersion(version => version + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api])

  const selectProject = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await api.canvasRead(id)
      setDocument(next); setSelectedIds(new Set()); setSelectedConnectionId(null)
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
        setProjects([summaryOf(created)]); setDocument(created)
        syncedRef.current = JSON.stringify(created); setSaveState('saved')
      } else {
        setProjects(remaining)
        await selectProject(nextId)
      }
      setSelectedIds(new Set()); setSelectedConnectionId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }, [api, selectProject])

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

  const backgroundMode = document?.background ?? 'dots'
  const cycleBackground = useCallback((): void => {
    mutate(previous => ({ ...previous, background: previous.background === 'dots' ? 'lines' : previous.background === 'lines' ? 'blank' : 'dots' }))
  }, [mutate])

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
    const isTextual = node.type === 'text' || isConfig
    return <div
      key={node.id}
      data-node-id={node.id}
      className={`${css.node} ${isConfig ? css.configNode : isTextual ? css.textNode : css.imageNode} ${isSelected ? css.nodeSelected : ''} ${isRelated ? css.nodeRelated : ''} ${isConnectTarget ? css.nodeConnectTarget : ''}`}
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
      {isTextual ? <header className={css.nodeHeader}>
        <span className={css.nodeTitle}>{node.title}</span>
      </header> : null}
      {isConfig ? <div className={css.configLinks} data-config-links={node.id}>
        <span className={css.composerChip}>{tt('canvas.composerLinked', { count: (document?.connections ?? []).filter(connection => connection.toNodeId === node.id).length })}</span>
      </div> : null}
      {isConfig
        ? <p className={css.configHint}>{tt('canvas.configHint')}</p>
        : isTextual
        ? <textarea
            className={css.textArea}
            value={metadata.text ?? ''}
            placeholder={tt('canvas.textPlaceholder')}
            onPointerDown={event => event.stopPropagation()}
            onChange={event => patchNode(node.id, { text: event.target.value })}
          />
        : <div className={css.nodeBody}>
            {isGenerating
              ? <div className={css.nodeState}><span className={css.spinner} aria-hidden="true" /><span>{tt('canvas.generatingNode')}</span></div>
              : isError
                ? <div className={css.nodeStateError}>{metadata.error ?? tt('canvas.generateFailed')}<button type="button" onClick={() => patchNode(node.id, { status: 'idle', error: undefined })}>{tt('canvas.dismiss')}</button></div>
                : hasImage
                  ? <img src={asset.url} alt={node.title} draggable={false} onDragStart={event => event.preventDefault()} />
                  : <button type="button" className={css.nodeEmpty} onClick={() => setPickerOpen(true)}><ToolbarIcon name="image" /><span>{tt('canvas.emptyImageNode')}</span></button>}
          </div>}
      {isSelected
        ? <div className={css.resizeHandle} onPointerDown={event => handleResizeStart(event, node, 'bottom-right')} title={tt('canvas.resizeHint')} />
        : null}
      <div className={`${css.handle} ${css.handleLeft}`} title={tt('canvas.connectHint')} onPointerDown={event => handleConnectStart(event, node.id, 'target')} />
      <div className={`${css.handle} ${css.handleRight}`} title={tt('canvas.connectHint')} onPointerDown={event => handleConnectStart(event, node.id, 'source')} />
      <div className={css.hoverToolbar} onPointerDown={event => event.stopPropagation()}>
        {node.type === 'image' && hasImage ? <IconButton name="download" label={tt('canvas.download')} onClick={() => downloadNode(node)} /> : null}
        <IconButton name="duplicate" label={tt('canvas.duplicate')} onClick={duplicateSelection} />
        <IconButton name="trash" label={tt('canvas.delete')} onClick={deleteSelection} />
      </div>
    </div>
  }

  const renderConnections = (): React.JSX.Element => (
    <svg
      className={css.connectionLayer}
      width={WORLD_PAD * 2}
      height={WORLD_PAD * 2}
      style={{ left: -WORLD_PAD, top: -WORLD_PAD }}
      aria-hidden="true"
    >
      <g transform={`translate(${WORLD_PAD},${WORLD_PAD})`}>
        {(document?.connections ?? []).map(connection => {
          const from = nodeById.get(connection.fromNodeId)
          const to = nodeById.get(connection.toNodeId)
          if (from === undefined || to === undefined) return null
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
            <path d={path} className={`${css.connectionPath} ${active ? css.connectionActive : ''}`} />
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
  )

  const renderComposer = (): ReactNode => {
    if (!composerVisible || document === null || composerTarget === null) return null
    const linkedCount = composerReferenceCount + composerTextCount
    const k = document.viewport.k
    const centerX = document.viewport.x + (composerTarget.x + composerTarget.width / 2) * k
    const clampedX = Math.min(Math.max(centerX, 292), Math.max(292, viewportSize.width - 292))
    const belowY = document.viewport.y + (composerTarget.y + composerTarget.height) * k + 14
    const top = belowY > viewportSize.height - 170
      ? Math.max(64, document.viewport.y + composerTarget.y * k - 158)
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
        <select value={composerModel} onChange={(event: ChangeEvent<HTMLSelectElement>) => setComposerModel(event.target.value)} aria-label={tt('canvas.model')}>
          <option value="">{tt('canvas.modelPlaceholder')}</option>
          {imageModels.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={composerSize} onChange={event => setComposerSize(event.target.value)} aria-label={tt('canvas.size')}>
          <option value="auto">{tt('canvas.sizeAuto')}</option>
          <option value="1:1">1:1</option>
          <option value="3:4">3:4</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
        </select>
        <select value={composerQuality} onChange={event => setComposerQuality(event.target.value)} aria-label={tt('canvas.quality')}>
          <option value="auto">{tt('canvas.qualityAuto')}</option>
          <option value="1k">1K</option>
          <option value="2k">2K</option>
          <option value="4k">4K</option>
        </select>
        <select value={composerCount} onChange={event => setComposerCount(Number(event.target.value))} aria-label={tt('canvas.count')}>
          {[1, 2, 3, 4].map(item => <option key={item} value={item}>{tt('canvas.countUnit', { count: item })}</option>)}
        </select>
        <button
          type="button"
          className={css.composerSend}
          aria-label={tt('canvas.generate')}
          title={tt('canvas.generate')}
          disabled={!connected || composerBusy || (composerPrompt.trim() === '' && composerTextCount === 0)}
          onClick={() => { void submitComposer(composerTarget) }}
        >{composerBusy ? <span className={css.spinner} aria-hidden="true" /> : <ToolbarIcon name="send" />}</button>
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
        items.push({ label: tt('canvas.duplicate'), icon: 'duplicate', action: duplicateSelection })
        items.push({ label: tt('canvas.delete'), icon: 'trash', action: deleteSelection, danger: true })
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
        items.push({ label: tt('canvas.paste'), icon: 'duplicate', action: () => pasteClipboard(contextMenu.world) })
        items.push({ label: tt('canvas.fitView'), icon: 'fit', action: fitView })
      }
      return <div className={css.contextMenu} style={{ left: contextMenu.screen.x, top: contextMenu.screen.y }} data-canvas-no-zoom="" role="menu">
        {items.map(item => <button key={item.label} type="button" role="menuitem" data-danger={item.danger ? '' : undefined} onClick={() => { item.action(); close() }}><ToolbarIcon name={item.icon} />{item.label}</button>)}
      </div>
    }
    if (createMenu !== null) {
      return <div className={css.contextMenu} style={{ left: createMenu.screen.x, top: createMenu.screen.y }} data-canvas-no-zoom="" role="menu">
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createImageNode({ assetId: '', url: '', mime: 'image/png', bytes: 0, width: 1, height: 1, origin: 'upload' }, createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="image" />{tt('canvas.addImageNode')}</button>
        <button type="button" role="menuitem" onClick={() => { placeNewNode(createTextNode(createMenu.world)); setCreateMenu(null) }}><ToolbarIcon name="text" />{tt('canvas.addTextNode')}</button>
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

  return <section className={css.root} data-canvas-workspace="">
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
      <IconButton name="background" label={tt('canvas.background')} onClick={cycleBackground} />
      <IconButton name="undo" label={tt('canvas.undo')} disabled={pastRef.current.length === 0} onClick={undo} />
      <IconButton name="redo" label={tt('canvas.redo')} disabled={futureRef.current.length === 0} onClick={redo} />
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
        setCreateMenu(null)
        setContextMenu({ type: 'canvas', screen: { x: event.clientX, y: event.clientY }, world: screenToWorld(event.clientX, event.clientY) })
      }}
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className={css.grid} style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${gridOffsetX}px ${gridOffsetY}px` }} data-mode={backgroundMode} aria-hidden="true" />
      <div className={css.world} style={{ transform: `translate(${document?.viewport.x ?? 0}px, ${document?.viewport.y ?? 0}px) scale(${document?.viewport.k ?? 1})` }}>
        {renderConnections()}
        {document?.nodes.map(renderNode)}
      </div>
      {marqueeRect !== null ? <div className={css.marquee} style={marqueeRect} aria-hidden="true" /> : null}
      {emptyState}
    </div>

    <div className={`${css.dock} ${cursorClass}`} data-canvas-no-zoom="">
      <IconButton name="select" label={tt('canvas.toolSelect')} active={tool === 'select'} onClick={() => setTool('select')} />
      <IconButton name="pan" label={tt('canvas.toolPan')} active={tool === 'pan'} onClick={() => setTool('pan')} />
      <span className={css.dockDivider} />
      <IconButton name="image" label={tt('canvas.addImage')} onClick={() => setPickerOpen(true)} />
      <IconButton name="text" label={tt('canvas.addText')} onClick={() => placeNewNode(createTextNode())} />
      <IconButton name="sparkle" label={tt('canvas.addConfigNode')} onClick={() => placeNewNode(createConfigNode())} />
      <span className={css.dockDivider} />
      <IconButton name="trash" label={tt('canvas.delete')} disabled={selectedIds.size === 0 && selectedConnectionId === null} onClick={deleteSelection} />
    </div>

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

    {error !== null ? <div className={css.errorToast} role="status" data-canvas-no-zoom="">{error}<button type="button" aria-label={tt('canvas.dismiss')} onClick={() => setError(null)}><ToolbarIcon name="close" /></button></div> : null}

    {pickerOpen ? <ImagePicker
      api={api}
      history={history}
      gallery={gallery}
      imageModels={imageModels}
      defaultChannelId={defaultChannelId}
      canvasId={document?.id ?? ''}
      connected={connected}
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

function ImagePicker(props: {
  api: ImageGenApi
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  imageModels: string[]
  defaultChannelId?: string
  canvasId: string
  connected: boolean
  onClose: () => void
  onAssets: (assets: CanvasAssetRef[]) => void
  onTask: (task: GenerationTask) => void
}): React.JSX.Element {
  const { api, history, gallery, imageModels, defaultChannelId, canvasId, connected, onClose, onAssets } = props
  const [tab, setTab] = useState<'upload' | 'history' | 'gallery' | 'generate'>('upload')
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
      {tab === 'generate' ? <div className={css.generateForm}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('canvas.composerPlaceholder')} /><select value={model} onChange={event => setModel(event.target.value)}>{imageModels.map(item => <option key={item} value={item}>{item}</option>)}</select><div className={css.inspectorRow}><select value={size} onChange={event => setSize(event.target.value)}><option value="auto">{tt('canvas.sizeAuto')}</option><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select><select value={quality} onChange={event => setQuality(event.target.value)}><option value="auto">{tt('canvas.qualityAuto')}</option><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option></select></div><button type="button" disabled={!connected || busy || prompt.trim() === ''} onClick={() => { void generate() }}><ToolbarIcon name="sparkle" />{tt('canvas.generateAndAdd')}</button>{!connected ? <small>{tt('canvas.needApi')}</small> : null}</div> : null}
    </div>
  </section></div>
}

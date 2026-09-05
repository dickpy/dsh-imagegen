/**
 * Infinite canvas workspace (Cowart-style): place generated images on a
 * pannable/zoomable surface, draw annotations (rect / arrow / brush / text)
 * straight onto an image, then flatten image + annotations into one reference
 * and submit an image-to-image edit — the result is placed back on the canvas
 * beside the source. Self-drawn (DOM transform + SVG overlay + 2D-canvas
 * flatten), deliberately without a canvas-library dependency.
 *
 * State lives in the parent (ImageGenPanel) so it survives workspace
 * switches; URL-backed items persist to localStorage, data-URL items are
 * session-only (data URLs must not enter localStorage).
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GeneratedImage, GenerateRequest, GenerationTask, HistoryEntry, HistoryImageRef } from '../protocol.ts'
import { tt } from './helpers.ts'
import css from './canvas.module.css'

export const CANVAS_STORAGE_KEY = 'dsh-imagegen-canvas'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 4
const ZOOM_STEP = 1.1
const MAX_FLATTEN_EDGE = 2000
const MAX_REFERENCE_CHARS = 13_000_000 // ≈10MB base64 ceiling for edit refs
const DEFAULT_ITEM_WIDTH = 360
const COLORS = ['#e5484d', '#f5a623', '#3b82f6', '#22c55e'] as const

export type CanvasTool = 'select' | 'rect' | 'arrow' | 'brush' | 'text'

interface AnnotationBase { color: string }

interface RectAnnotation extends AnnotationBase {
  type: 'rect'
  x: number; y: number; w: number; h: number
  strokeWidth: number
}

interface ArrowAnnotation extends AnnotationBase {
  type: 'arrow'
  x1: number; y1: number; x2: number; y2: number
  strokeWidth: number
}

interface BrushAnnotation extends AnnotationBase {
  type: 'brush'
  points: Array<{ x: number; y: number }>
  strokeWidth: number
}

interface TextAnnotation extends AnnotationBase {
  type: 'text'
  x: number; y: number
  text: string
  fontSize: number
}

type CanvasAnnotation = RectAnnotation | ArrowAnnotation | BrushAnnotation | TextAnnotation

export interface CanvasItem {
  id: string
  /** Same-origin route URL (persistable) or a data URL (session only). */
  src: string
  origin: 'url' | 'data'
  name: string
  /** Canvas-space display box. */
  x: number; y: number; w: number; h: number
  /** Natural pixel size — the coordinate space annotations live in. */
  nw: number; nh: number
  annotations: CanvasAnnotation[]
}

export interface CanvasViewport { x: number; y: number; z: number }

export interface CanvasState {
  items: CanvasItem[]
  viewport: CanvasViewport
  /** taskId → where the finished edit should land on the canvas. */
  pending: Record<string, { x: number; y: number; w: number; h: number }>
}

export function emptyCanvasState(): CanvasState {
  return { items: [], viewport: { x: 80, y: 60, z: 1 }, pending: {} }
}

/** Persist only URL-backed items (data URLs are too large for localStorage). */
export function persistCanvasState(state: CanvasState): void {
  const payload = JSON.stringify({
    items: state.items.filter(item => item.origin === 'url'),
    viewport: state.viewport,
  })
  window.localStorage.setItem(CANVAS_STORAGE_KEY, payload)
}

export function loadCanvasState(): CanvasState {
  const base = emptyCanvasState()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CANVAS_STORAGE_KEY) ?? '') as Partial<CanvasState> | null
    if (parsed === null || typeof parsed !== 'object') return base
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item): item is CanvasItem => {
        if (item === null || typeof item !== 'object') return false
        const record = item as Partial<CanvasItem>
        return typeof record.id === 'string' && typeof record.src === 'string' && record.src !== ''
          && Number.isFinite(record.x) && Number.isFinite(record.y) && Number.isFinite(record.w) && Number.isFinite(record.h)
          && Array.isArray(record.annotations)
      }).map(item => ({
        ...item,
        origin: 'url' as const,
        nw: Number.isFinite(item.nw) ? item.nw : 0,
        nh: Number.isFinite(item.nh) ? item.nh : 0,
        annotations: item.annotations.filter(annotation => annotation !== null && typeof annotation === 'object'),
      }))
      : []
    const viewport = parsed.viewport !== null && typeof parsed.viewport === 'object'
      ? {
        x: Number.isFinite(parsed.viewport.x) ? parsed.viewport.x : base.viewport.x,
        y: Number.isFinite(parsed.viewport.y) ? parsed.viewport.y : base.viewport.y,
        z: Number.isFinite(parsed.viewport.z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed.viewport.z)) : base.viewport.z,
      }
      : base.viewport
    return { items, viewport, pending: {} }
  } catch {
    return base
  }
}

function newCanvasId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function generatedSrc(image: GeneratedImage): string {
  return `data:${image.mime};base64,${image.b64}`
}

/** Add one image at a comfortable spot in the current viewport. */
export function addCanvasItem(state: CanvasState, source: { src: string; origin: 'url' | 'data'; name: string }): CanvasState {
  const item: CanvasItem = {
    id: newCanvasId(),
    src: source.src,
    origin: source.origin,
    name: source.name,
    x: -state.viewport.x + 420 + (state.items.length % 4) * 32,
    y: -state.viewport.y + 220 + (state.items.length % 4) * 28,
    w: DEFAULT_ITEM_WIDTH,
    h: DEFAULT_ITEM_WIDTH,
    nw: 0,
    nh: 0,
    annotations: [],
  }
  return { ...state, items: [...state.items, item] }
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = src
  await image.decode()
  return image
}

/**
 * Flatten one item's base image + annotations into a single reference data
 * URL (downsampled to MAX_FLATTEN_EDGE; falls back to JPEG if the PNG would
 * blow past the edit-reference ceiling).
 */
async function flattenItem(item: CanvasItem): Promise<string> {
  const image = await loadImageElement(item.src)
  const naturalW = item.nw > 0 ? item.nw : image.naturalWidth
  const naturalH = item.nh > 0 ? item.nh : image.naturalHeight
  let scale = 1
  if (Math.max(naturalW, naturalH) > MAX_FLATTEN_EDGE) scale = MAX_FLATTEN_EDGE / Math.max(naturalW, naturalH)
  const width = Math.max(1, Math.round(naturalW * scale))
  const height = Math.max(1, Math.round(naturalH * scale))
  const surface = document.createElement('canvas')
  surface.width = width
  surface.height = height
  const ctx = surface.getContext('2d')
  if (ctx === null) throw new Error(tt('canvas.flattenUnsupported'))
  ctx.drawImage(image, 0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const annotation of item.annotations) {
    ctx.strokeStyle = annotation.color
    ctx.fillStyle = annotation.color
    if (annotation.type === 'rect') {
      ctx.lineWidth = annotation.strokeWidth * scale
      ctx.strokeRect(annotation.x * scale, annotation.y * scale, annotation.w * scale, annotation.h * scale)
    } else if (annotation.type === 'arrow') {
      const { x1, y1, x2, y2 } = annotation
      ctx.lineWidth = annotation.strokeWidth * scale
      ctx.beginPath()
      ctx.moveTo(x1 * scale, y1 * scale)
      ctx.lineTo(x2 * scale, y2 * scale)
      ctx.stroke()
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const head = annotation.strokeWidth * 3 * scale
      ctx.beginPath()
      ctx.moveTo(x2 * scale, y2 * scale)
      ctx.lineTo((x2 - head * Math.cos(angle - Math.PI / 7)) * scale, (y2 - head * Math.sin(angle - Math.PI / 7)) * scale)
      ctx.lineTo((x2 - head * Math.cos(angle + Math.PI / 7)) * scale, (y2 - head * Math.sin(angle + Math.PI / 7)) * scale)
      ctx.closePath()
      ctx.fill()
    } else if (annotation.type === 'brush') {
      if (annotation.points.length < 2) continue
      ctx.lineWidth = annotation.strokeWidth * scale
      ctx.beginPath()
      ctx.moveTo(annotation.points[0]!.x * scale, annotation.points[0]!.y * scale)
      for (const point of annotation.points.slice(1)) ctx.lineTo(point.x * scale, point.y * scale)
      ctx.stroke()
    } else {
      ctx.font = `${Math.round(annotation.fontSize * scale)}px sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(annotation.text, annotation.x * scale, annotation.y * scale)
    }
  }
  let dataUrl = surface.toDataURL('image/png')
  if (dataUrl.length > MAX_REFERENCE_CHARS) dataUrl = surface.toDataURL('image/jpeg', 0.92)
  return dataUrl
}

const TOOLS: Array<{ id: CanvasTool; labelKey: string }> = [
  { id: 'select', labelKey: 'canvas.toolSelect' },
  { id: 'rect', labelKey: 'canvas.toolRect' },
  { id: 'arrow', labelKey: 'canvas.toolArrow' },
  { id: 'brush', labelKey: 'canvas.toolBrush' },
  { id: 'text', labelKey: 'canvas.toolText' },
]

function toolIcon(tool: CanvasTool): JSX.Element {
  switch (tool) {
    case 'select': return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5l8 4.5-3.6 1L7 12z" /></svg>
    case 'rect': return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" /></svg>
    case 'arrow': return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 13L13 3" /><path d="M8 3h5v5" /></svg>
    case 'brush': return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 13c2.5.5 4-.5 4.5-2L13 5.5a1.6 1.6 0 0 0-2.5-2L5 9c-1.5.5-2.5 2-2 4z" /></svg>
    case 'text': return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 3.5h10M8 3.5v9M5.5 12.5h5" /></svg>
  }
}

/** The canvas surface + floating toolbar + prompt card. */
export function CanvasWorkspace(props: {
  canvas: CanvasState
  onCanvasChange: (mutate: (previous: CanvasState) => CanvasState) => void
  history: HistoryEntry[]
  gallery: HistoryEntry[]
  imageModels: string[]
  tasks: GenerationTask[]
  busy: boolean
  onSubmitEdit: (request: GenerateRequest) => Promise<GenerationTask>
}) {
  const { canvas, onCanvasChange, history, gallery, imageModels, tasks, busy, onSubmitEdit } = props
  const surfaceRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLDivElement>())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [color, setColor] = useState<string>(COLORS[0])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerTab, setPickerTab] = useState<'history' | 'gallery'>('history')
  const [error, setError] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [model, setModel] = useState('')
  const [textDraft, setTextDraft] = useState<{ itemId: string; x: number; y: number; value: string } | null>(null)
  const [draft, setDraft] = useState<{ itemId: string; annotation: CanvasAnnotation } | null>(null)

  const viewport = canvas.viewport
  const selectedItem = canvas.items.find(item => item.id === selectedId) ?? null

  const patchItem = (itemId: string, patch: (item: CanvasItem) => CanvasItem): void => {
    onCanvasChange(previous => ({
      ...previous,
      items: previous.items.map(item => item.id === itemId ? patch(item) : item),
    }))
  }

  const setViewport = (viewport: CanvasViewport): void => {
    onCanvasChange(previous => ({ ...previous, viewport }))
  }

  // ---------------------------------------------------------- add / remove

  const addFromRef = (entry: HistoryEntry, image: HistoryImageRef): void => {
    onCanvasChange(previous => addCanvasItem(previous, { src: image.url, origin: 'url', name: entry.prompt.slice(0, 40) || 'image' }))
    setPickerOpen(false)
  }

  const addFromFiles = async (files: FileList | undefined, clientX?: number, clientY?: number): Promise<void> => {
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith('image/')) continue
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      onCanvasChange(previous => {
        const next = addCanvasItem(previous, { src: dataUrl, origin: 'data', name: file.name })
        if (clientX !== undefined && clientY !== undefined) {
          const item = next.items[next.items.length - 1]!
          const rect = surfaceRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            item.x = (clientX - rect.left - next.viewport.x) / next.viewport.z - item.w / 2
            item.y = (clientY - rect.top - next.viewport.y) / next.viewport.z - item.h / 2
          }
        }
        return next
      })
    }
  }

  const removeItem = (itemId: string): void => {
    itemRefs.current.delete(itemId)
    onCanvasChange(previous => ({ ...previous, items: previous.items.filter(item => item.id !== itemId) }))
    if (selectedId === itemId) { setSelectedId(null); setTool('select') }
  }

  // -------------------------------------------------------- pan / zoom ----

  const onSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    const startX = event.clientX
    const startY = event.clientY
    const originX = viewport.x
    const originY = viewport.y
    const onMove = (move: PointerEvent): void => {
      setViewport({ x: originX + (move.clientX - startX), y: originY + (move.clientY - startY), z: viewport.z })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onSurfaceWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewport.z * factor))
    const cursorX = event.clientX - rect.left
    const cursorY = event.clientY - rect.top
    setViewport({
      x: cursorX - (cursorX - viewport.x) * (z / viewport.z),
      y: cursorY - (cursorY - viewport.y) * (z / viewport.z),
      z,
    })
  }

  const zoomBy = (factor: number): void => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    const cx = (rect?.width ?? 800) / 2
    const cy = (rect?.height ?? 600) / 2
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewport.z * factor))
    setViewport({
      x: cx - (cx - viewport.x) * (z / viewport.z),
      y: cy - (cy - viewport.y) * (z / viewport.z),
      z,
    })
  }

  const fitToContent = (): void => {
    if (canvas.items.length === 0 || surfaceRef.current === null) {
      setViewport({ x: 80, y: 60, z: 1 })
      return
    }
    const rect = surfaceRef.current.getBoundingClientRect()
    const minX = Math.min(...canvas.items.map(item => item.x))
    const minY = Math.min(...canvas.items.map(item => item.y))
    const maxX = Math.max(...canvas.items.map(item => item.x + item.w))
    const maxY = Math.max(...canvas.items.map(item => item.y + item.h))
    const z = Math.min(1.5, Math.max(ZOOM_MIN, Math.min(rect.width / (maxX - minX + 80), rect.height / (maxY - minY + 80))))
    setViewport({
      x: rect.width / 2 - (minX + maxX) / 2 * z,
      y: rect.height / 2 - (minY + maxY) / 2 * z,
      z,
    })
  }

  // ---------------------------------------------------- item interactions --

  const imagePointOf = (itemId: string, clientX: number, clientY: number): { x: number; y: number } | null => {
    const element = itemRefs.current.get(itemId)
    const item = canvas.items.find(candidate => candidate.id === itemId)
    if (element === undefined || item === undefined || item.nw <= 0 || item.nh <= 0) return null
    const rect = element.getBoundingClientRect()
    return {
      x: Math.min(item.nw, Math.max(0, (clientX - rect.left) / rect.width * item.nw)),
      y: Math.min(item.nh, Math.max(0, (clientY - rect.top) / rect.height * item.nh)),
    }
  }

  const startAnnotation = (event: React.PointerEvent<HTMLDivElement>, item: CanvasItem): void => {
    if (tool === 'select' || item.nw <= 0) return
    event.stopPropagation()
    const start = imagePointOf(item.id, event.clientX, event.clientY)
    if (start === null) return
    if (tool === 'text') {
      setTextDraft({ itemId: item.id, x: start.x, y: start.y, value: '' })
      return
    }
    const base = { color }
    const annotation: CanvasAnnotation = tool === 'rect'
      ? { type: 'rect', ...base, x: start.x, y: start.y, w: 0, h: 0, strokeWidth: 6 }
      : tool === 'arrow'
        ? { type: 'arrow', ...base, x1: start.x, y1: start.y, x2: start.x, y2: start.y, strokeWidth: 6 }
        : { type: 'brush', ...base, points: [start], strokeWidth: 6 }
    setDraft({ itemId: item.id, annotation })
    const onMove = (move: PointerEvent): void => {
      const point = imagePointOf(item.id, move.clientX, move.clientY)
      if (point === null) return
      setDraft(current => {
        if (current === null || current.itemId !== item.id) return current
        const previous = current.annotation
        let next: CanvasAnnotation = previous
        if (previous.type === 'rect') {
          next = { ...previous, x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y) }
        } else if (previous.type === 'arrow') {
          next = { ...previous, x2: point.x, y2: point.y }
        } else if (previous.type === 'brush') {
          next = { ...previous, points: [...previous.points, point] }
        }
        return { ...current, annotation: next }
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDraft(current => {
        if (current === null || current.itemId !== item.id) return current
        const annotation = current.annotation
        const meaningful = annotation.type === 'brush'
          ? annotation.points.length > 1
          : annotation.type === 'rect'
            ? Math.abs(annotation.w) > 2 && Math.abs(annotation.h) > 2
            : annotation.type === 'arrow'
              ? Math.abs(annotation.x2 - annotation.x1) + Math.abs(annotation.y2 - annotation.y1) > 4
              : false
        if (meaningful) {
          patchItem(item.id, previousItem => ({ ...previousItem, annotations: [...previousItem.annotations, annotation] }))
        }
        return null
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const commitTextDraft = (): void => {
    setTextDraft(current => {
      if (current !== null && current.value.trim() !== '') {
        const item = canvas.items.find(candidate => candidate.id === current.itemId)
        if (item !== undefined && item.nw > 0) {
          const fontSize = Math.max(24, Math.round(item.nw / 32))
          patchItem(item.id, previousItem => ({
            ...previousItem,
            annotations: [...previousItem.annotations, { type: 'text', color, x: current.x, y: current.y, text: current.value.trim(), fontSize }],
          }))
        }
      }
      return null
    })
  }

  // ---------------------------------------------------- result placement --

  useEffect(() => {
    const pendingEntries = Object.entries(canvas.pending)
    if (pendingEntries.length === 0) return
    for (const task of tasks) {
      if (task.status !== 'completed' || canvas.pending[task.id] === undefined) continue
      const image = task.result?.images[0]
      const spot = canvas.pending[task.id]
      onCanvasChange(previous => {
        if (previous.pending[task.id] === undefined) return previous
        const pending = { ...previous.pending }
        delete pending[task.id]
        if (image === undefined) return { ...previous, pending }
        const id = `canvas-result-${task.id}`
        if (previous.items.some(item => item.id === id)) return { ...previous, pending }
        return {
          ...previous,
          pending,
          items: [...previous.items, {
            id,
            src: generatedSrc(image),
            origin: 'data' as const,
            name: 'canvas-edit.png',
            x: spot.x, y: spot.y, w: spot.w, h: spot.h,
            nw: 0, nh: 0,
            annotations: [],
          }],
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  // ------------------------------------------------------------- submit ----

  const submitEdit = async (): Promise<void> => {
    const item = selectedItem
    if (item === null || busy) return
    if (instruction.trim() === '') { setError(tt('canvas.instructionRequired')); return }
    setError(null)
    try {
      const dataUrl = await flattenItem(item)
      const request: GenerateRequest = {
        mode: 'edit',
        model: imageModels.includes(model) ? model : imageModels[0] ?? '',
        prompt: instruction.trim(),
        size: 'auto',
        quality: 'auto',
        n: 1,
        detail: '',
        image: dataUrl,
        refName: 'canvas-annotated.png',
      }
      const task = await onSubmitEdit(request)
      onCanvasChange(previous => ({
        ...previous,
        pending: { ...previous.pending, [task.id]: { x: item.x + item.w + 40, y: item.y, w: item.w, h: item.h } },
      }))
      setInstruction('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  // ------------------------------------------------------------- render ----

  const renderItemAnnotation = (annotation: CanvasAnnotation, key: number): JSX.Element | null => {
    if (annotation.type === 'rect') {
      return <rect key={key} x={annotation.x} y={annotation.y} width={annotation.w} height={annotation.h} fill="none" stroke={annotation.color} strokeWidth={annotation.strokeWidth} />
    }
    if (annotation.type === 'arrow') {
      const { x1, y1, x2, y2 } = annotation
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const head = annotation.strokeWidth * 3
      return (
        <g key={key}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={annotation.color} strokeWidth={annotation.strokeWidth} strokeLinecap="round" />
          <polygon
            points={`${x2},${y2} ${x2 - head * Math.cos(angle - Math.PI / 7)},${y2 - head * Math.sin(angle - Math.PI / 7)} ${x2 - head * Math.cos(angle + Math.PI / 7)},${y2 - head * Math.sin(angle + Math.PI / 7)}`}
            fill={annotation.color}
          />
        </g>
      )
    }
    if (annotation.type === 'brush') {
      return <polyline key={key} points={annotation.points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={annotation.color} strokeWidth={annotation.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    }
    return <text key={key} x={annotation.x} y={annotation.y + annotation.fontSize} fill={annotation.color} fontSize={annotation.fontSize} fontFamily="sans-serif">{annotation.text}</text>
  }

  return (
    <div
      className={css.workspace}
      data-canvas-workspace=""
      ref={surfaceRef}
      onPointerDown={onSurfacePointerDown}
      onWheel={onSurfaceWheel}
      onDragOver={event => { event.preventDefault() }}
      onDrop={event => {
        event.preventDefault()
        void addFromFiles(event.dataTransfer.files, event.clientX, event.clientY)
      }}
    >
      <div
        className={css.content}
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.z})` }}
      >
        {canvas.items.map(item => {
          const selected = item.id === selectedId
          const drawing = draft !== null && draft.itemId === item.id
          return (
            <div
              key={item.id}
              ref={element => { if (element === null) itemRefs.current.delete(item.id); else itemRefs.current.set(item.id, element) }}
              className={css.item}
              data-canvas-item=""
              data-selected={selected ? '' : undefined}
              style={{ left: item.x, top: item.y, width: item.w, height: item.h }}
              onPointerDown={event => {
                if (tool !== 'select') { startAnnotation(event, item); return }
                event.stopPropagation()
                setSelectedId(item.id)
                const startX = event.clientX
                const startY = event.clientY
                const originX = item.x
                const originY = item.y
                const onMove = (move: PointerEvent): void => {
                  const dx = (move.clientX - startX) / viewport.z
                  const dy = (move.clientY - startY) / viewport.z
                  patchItem(item.id, previousItem => ({ ...previousItem, x: originX + dx, y: originY + dy }))
                }
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove)
                  window.removeEventListener('pointerup', onUp)
                }
                window.addEventListener('pointermove', onMove)
                window.addEventListener('pointerup', onUp)
              }}
            >
              <img
                className={css.itemImage}
                src={item.src}
                alt={item.name}
                draggable={false}
                onLoad={event => {
                  const target = event.currentTarget
                  if (item.nw !== target.naturalWidth || item.nh !== target.naturalHeight) {
                    patchItem(item.id, previousItem => ({
                      ...previousItem,
                      nw: target.naturalWidth,
                      nh: target.naturalHeight,
                      h: previousItem.w * target.naturalHeight / Math.max(1, target.naturalWidth),
                    }))
                  }
                }}
              />
              <svg
                className={css.annoLayer}
                viewBox={item.nw > 0 && item.nh > 0 ? `0 0 ${item.nw} ${item.nh}` : undefined}
                preserveAspectRatio="none"
              >
                {item.annotations.map((annotation, index) => renderItemAnnotation(annotation, index))}
                {drawing && draft?.annotation !== undefined ? renderItemAnnotation(draft.annotation, -1) : null}
              </svg>
              {textDraft !== null && textDraft.itemId === item.id ? (
                <input
                  className={css.textDraft}
                  style={{ left: `${item.nw > 0 ? textDraft.x / item.nw * 100 : 0}%`, top: `${item.nh > 0 ? textDraft.y / item.nh * 100 : 0}%` }}
                  value={textDraft.value}
                  autoFocus
                  placeholder={tt('canvas.textPlaceholder')}
                  onChange={event => { setTextDraft(current => current === null ? current : { ...current, value: event.target.value }) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') commitTextDraft()
                    if (event.key === 'Escape') setTextDraft(null)
                  }}
                  onBlur={commitTextDraft}
                />
              ) : null}
              {selected ? (
                <span
                  className={css.resizeHandle}
                  title={tt('canvas.resizeHint')}
                  onPointerDown={event => {
                    event.stopPropagation()
                    const startX = event.clientX
                    const startWidth = item.w
                    const startHeight = item.h
                    const onMove = (move: PointerEvent): void => {
                      const scale = Math.max(0.15, (startWidth + (move.clientX - startX) / viewport.z) / startWidth)
                      patchItem(item.id, previousItem => ({
                        ...previousItem,
                        w: Math.max(48, startWidth * scale),
                        h: Math.max(48, startHeight * scale),
                      }))
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove)
                    window.addEventListener('pointerup', onUp)
                  }}
                />
              ) : null}
              <span className={css.itemActions}>
                <button
                  type="button"
                  className={css.itemAction}
                  title={tt('canvas.annotate')}
                  onClick={event => { event.stopPropagation(); setSelectedId(item.id); setTool('brush') }}
                >
                  {toolIcon('brush')}
                </button>
                <button
                  type="button"
                  className={css.itemAction}
                  title={tt('canvas.remove')}
                  onClick={event => { event.stopPropagation(); removeItem(item.id) }}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4.5h11" /><path d="M6 4.5V3.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3" /><path d="M4.3 4.5l.6 8.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.1" /></svg>
                </button>
              </span>
            </div>
          )
        })}
      </div>

      {canvas.items.length === 0 ? (
        <div className={css.emptyState}>
          <p>{tt('canvas.empty')}</p>
          <Button variant="outline" size="sm" onClick={() => { setPickerOpen(true) }}>{tt('canvas.add')}</Button>
        </div>
      ) : null}

      <div className={css.toolbar} onPointerDown={event => { event.stopPropagation() }}>
        <button type="button" className={css.toolButton} data-active={pickerOpen ? '' : undefined} title={tt('canvas.add')} onClick={() => { setPickerOpen(open => !open) }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <span className={css.toolbarDivider} aria-hidden="true" />
        {TOOLS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={css.toolButton}
            data-active={tool === entry.id ? '' : undefined}
            disabled={entry.id !== 'select' && selectedId === null}
            title={tt(entry.labelKey as never)}
            aria-label={tt(entry.labelKey as never)}
            onClick={() => { setTool(entry.id) }}
          >
            {toolIcon(entry.id)}
          </button>
        ))}
        <span className={css.toolbarDivider} aria-hidden="true" />
        {COLORS.map(entry => (
          <button
            key={entry}
            type="button"
            className={css.colorSwatch}
            data-active={color === entry ? '' : undefined}
            disabled={selectedId === null}
            title={tt('canvas.color')}
            aria-label={tt('canvas.color')}
            style={{ background: entry }}
            onClick={() => { setColor(entry) }}
          />
        ))}
        <button
          type="button"
          className={css.toolButton}
          disabled={selectedId === null || selectedItem === null || selectedItem.annotations.length === 0}
          title={tt('canvas.undo')}
          aria-label={tt('canvas.undo')}
          onClick={() => { if (selectedItem !== null) patchItem(selectedItem.id, previousItem => ({ ...previousItem, annotations: previousItem.annotations.slice(0, -1) })) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3L3 6l3 3" /><path d="M3 6h6.5A3.5 3.5 0 0 1 13 9.5V12" /></svg>
        </button>
        <button
          type="button"
          className={css.toolButton}
          disabled={selectedId === null || selectedItem === null || selectedItem.annotations.length === 0}
          title={tt('canvas.clearAnnotations')}
          aria-label={tt('canvas.clearAnnotations')}
          onClick={() => { if (selectedItem !== null) patchItem(selectedItem.id, previousItem => ({ ...previousItem, annotations: [] })) }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10" /><path d="M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
        </button>
        <span className={css.toolbarDivider} aria-hidden="true" />
        <button type="button" className={css.toolButton} title={tt('canvas.zoomOut')} aria-label={tt('canvas.zoomOut')} onClick={() => { zoomBy(1 / ZOOM_STEP) }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 8h9" /></svg>
        </button>
        <button type="button" className={css.zoomLevel} title={tt('canvas.zoomReset')} onClick={() => { setViewport({ ...viewport, z: 1 }) }}>
          {Math.round(viewport.z * 100)}%
        </button>
        <button type="button" className={css.toolButton} title={tt('canvas.zoomIn')} aria-label={tt('canvas.zoomIn')} onClick={() => { zoomBy(ZOOM_STEP) }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
        </button>
        <button type="button" className={css.toolButton} title={tt('canvas.fit')} aria-label={tt('canvas.fit')} onClick={fitToContent}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
        </button>
      </div>

      {pickerOpen ? (
        <div className={css.picker} data-canvas-picker="" onPointerDown={event => { event.stopPropagation() }}>
          <div className={css.pickerTabs} role="tablist">
            <button type="button" className={css.pickerTab} data-active={pickerTab === 'history' ? '' : undefined} onClick={() => { setPickerTab('history') }}>{tt('history.title')}</button>
            <button type="button" className={css.pickerTab} data-active={pickerTab === 'gallery' ? '' : undefined} onClick={() => { setPickerTab('gallery') }}>{tt('gallery.title')}</button>
            <label className={css.pickerUpload}>
              {tt('ecommerce.uploadShort')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                onChange={event => {
                  void addFromFiles(event.target.files ?? undefined)
                  event.target.value = ''
                }}
              />
            </label>
          </div>
          <div className={css.pickerGrid}>
            {(pickerTab === 'history' ? history : gallery).flatMap(entry => entry.images.map(image => (
              <button
                key={`${entry.id}:${image.url}`}
                type="button"
                className={css.pickerItem}
                data-canvas-picker-item=""
                title={entry.prompt.slice(0, 80)}
                onClick={() => { addFromRef(entry, image) }}
              >
                <img src={image.url} alt="" loading="lazy" />
              </button>
            )))}
            {(pickerTab === 'history' ? history : gallery).length === 0 ? (
              <span className={css.pickerEmpty}>{tt('canvas.pickerEmpty')}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={css.promptCard} data-canvas-prompt="" onPointerDown={event => { event.stopPropagation() }}>
        <textarea
          className={css.promptInput}
          rows={2}
          value={instruction}
          placeholder={selectedItem === null ? tt('canvas.selectFirst') : tt('canvas.instructionPlaceholder')}
          onChange={event => { setInstruction(event.target.value) }}
        />
        <div className={css.promptActions}>
          <select className={css.modelSelect} value={imageModels.includes(model) ? model : imageModels[0] ?? ''} aria-label={tt('model.label')} onChange={event => { setModel(event.target.value) }}>
            {imageModels.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <Button
            variant="primary"
            size="md"
            disabled={busy || selectedItem === null || instruction.trim() === '' || imageModels.length === 0}
            onClick={() => { void submitEdit() }}
          >
            {busy ? tt('generating') : tt('canvas.submit')}
          </Button>
        </div>
        {error !== null ? <p className={css.errorLine} role="alert">{error}</p> : null}
      </div>
    </div>
  )
}

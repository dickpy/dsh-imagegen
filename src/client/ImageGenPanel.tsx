/**
 * The AI 生图 studio: a three-column layout — left, a card-grouped
 * configuration sidebar (mode tabs, prompt with counter, rounded parameter
 * selectors, model dropdown + generate button); center, the result canvas;
 * right, a persistent generation history column.
 *
 * Controls ride the system UI primitives (@deepseek-ai/dsh-client-ui-primitives,
 * a platform module) so the studio matches the dsh shell look by construction.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { TemplateLibrary } from './TemplateLibrary.tsx'
import type { GeneratedImage, GenerateMode, GenerateRequest, GenerationTask, HistoryEntry, HistoryImageRef, UpdateInfo } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { DEFAULT_IMAGE_MODELS, normalizeImageModels } from '../image-models.ts'
import css from './panel.module.css'

/** Size options, presented as aspect ratios (auto = let the model decide).
 *  The host maps each ratio onto the model's own vocabulary: aspect_ratio for
 *  Grok Imagine, the closest pixel size for OpenAI-compatible endpoints. */
const SIZES = ['auto', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9'] as const

/** Size option keys in the locale dictionary. */
const SIZE_KEYS: Record<string, 'size.auto' | 'size.square' | 'size.portrait34' | 'size.landscape43' | 'size.portrait916' | 'size.portrait23' | 'size.landscape32' | 'size.wide169' | 'size.ultrawide21'> = {
  auto: 'size.auto',
  '1:1': 'size.square',
  '3:4': 'size.portrait34',
  '4:3': 'size.landscape43',
  '9:16': 'size.portrait916',
  '2:3': 'size.portrait23',
  '3:2': 'size.landscape32',
  '16:9': 'size.wide169',
  '21:9': 'size.ultrawide21',
}

/** Quality options, shown as output-resolution tiers (auto = let the model
 *  decide). The host maps them: resolution for Grok, quality level for
 *  OpenAI-compatible endpoints (1k→low, 2k→medium, 4k→high). */
const QUALITIES = ['auto', '1k', '2k', '4k'] as const

/** Detail options ('' = omit the passthrough). */
const DETAILS = ['', 'standard', 'high'] as const

const REF_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const PREVIEW_SCALE_MIN = 0.5
const PREVIEW_SCALE_MAX = 3
const PREVIEW_SCALE_STEP = 0.25

/** Legacy pixel sizes saved by older versions, mapped onto the current
 *  aspect-ratio vocabulary so restoring old history entries still works. */
const LEGACY_SIZE_TO_RATIO: Record<string, string> = {
  '512x512': '1:1',
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
}

/** Legacy quality levels saved by older versions, mapped onto resolution. */
const LEGACY_QUALITY_TO_RES: Record<string, string> = {
  low: '1k',
  medium: '2k',
  high: '4k',
}

/** Normalize a saved size value into a current dropdown option. */
function normalizeSize(value: string): string {
  if ((SIZES as readonly string[]).includes(value)) return value
  return LEGACY_SIZE_TO_RATIO[value] ?? 'auto'
}

/** Normalize a saved quality value into a current dropdown option. */
function normalizeQuality(value: string): string {
  if ((QUALITIES as readonly string[]).includes(value)) return value
  return LEGACY_QUALITY_TO_RES[value] ?? 'auto'
}

function clampPreviewScale(scale: number): number {
  return Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, scale))
}

/** Read the current config from the settings scope snapshot. */
function useConfig(scope: ImageGenScope): ImageGenConfig | undefined {
  const [value, setValue] = useState(scope.getSnapshot().value)
  useEffect(() => scope.subscribe(() => { setValue(scope.getSnapshot().value) }), [scope])
  return value
}

/** Track one redacted secret field without exposing its value to the panel. */
function useSecretSet(scope: ImageGenScope, field: string): boolean {
  const [isSet, setIsSet] = useState(scope.getSecretSetSnapshot(field))
  useEffect(() => scope.subscribeSecretSets(() => { setIsSet(scope.getSecretSetSnapshot(field)) }), [field, scope])
  return isSet
}

/** Tick a seconds counter while `running`. */
function useElapsed(running: boolean, startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running || startedAt === null) return
    const timer = window.setInterval(() => {
      setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  return elapsed
}

/** Data URL for a generated image. */
function srcOf(image: GeneratedImage): string {
  return `data:${image.mime};base64,${image.b64}`
}

/** Fetch persisted history image refs and decode them back to in-memory
 *  GeneratedImage[] (base64), so the canvas/preview can reuse the same
 *  rendering path as a fresh generation. */
async function historyImagesToGenerated(refs: HistoryImageRef[]): Promise<GeneratedImage[]> {
  return Promise.all(refs.map(async ref => {
    const response = await fetch(ref.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(new Error('image read failed'))
      reader.readAsDataURL(blob)
    })
    const comma = dataUrl.indexOf(',')
    return {
      b64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
      mime: ref.mime,
      ...ref.revisedPrompt === undefined ? {} : { revisedPrompt: ref.revisedPrompt },
    }
  }))
}

/** Compact, locale-independent timestamp for history entries. */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Studio tabs: the two generation modes plus the gallery view. */
type PanelTab = GenerateMode | 'gallery'

type GalleryFilter = string
type ComparisonSession = { taskIds: string[]; prompt: string }

/** Render the studio. */
export function ImageGenPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
}) {
  const { api, scope } = props
  const config = useConfig(scope)
  const enabled = config?.enabled ?? true
  const apiUrl = config?.apiUrl ?? ''
  const configured = apiUrl.trim() !== ''
  const apiKeySet = useSecretSet(scope, 'apiKey')
  const promptKeySet = useSecretSet(scope, 'promptApiKey')
  const connected = enabled && configured && apiKeySet
  const imageModels = normalizeImageModels(config?.imageModels)

  const [tab, setTab] = useState<PanelTab>('text')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>('auto')
  const [quality, setQuality] = useState<string>('auto')
  const [count, setCount] = useState(1)
  const [detail, setDetail] = useState('')
  const [model, setModel] = useState<string>(DEFAULT_IMAGE_MODELS[0])
  const [compareEnabled, setCompareEnabled] = useState(false)
  const [compareModels, setCompareModels] = useState<string[]>([...DEFAULT_IMAGE_MODELS])
  const [modelOpen, setModelOpen] = useState(false)
  const [refImage, setRefImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [configGuide, setConfigGuide] = useState<'generation' | 'enhancement' | 'disabled' | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null)
  const [gallery, setGallery] = useState<HistoryEntry[]>([])
  const [galleryViewingId, setGalleryViewingId] = useState<string | null>(null)
  const [galleryAdding, setGalleryAdding] = useState(false)
  const [galleryMessage, setGalleryMessage] = useState<string | null>(null)
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>('all')
  const [galleryRatio, setGalleryRatio] = useState('all')
  const [galleryTagFilter, setGalleryTagFilter] = useState<string | null>(null)
  const [galleryView, setGalleryView] = useState<'masonry' | 'grid'>('masonry')
  const [gallerySort, setGallerySort] = useState<'newest' | 'oldest'>('newest')
  const [galleryQuery, setGalleryQuery] = useState('')
  const [galleryTagInput, setGalleryTagInput] = useState('')
  const [editingGalleryTagsId, setEditingGalleryTagsId] = useState<string | null>(null)
  const [galleryTagEditInput, setGalleryTagEditInput] = useState('')
  const [selectedGalleryIds, setSelectedGalleryIds] = useState<Set<string>>(new Set())
  const [gallerySelecting, setGallerySelecting] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyModelFilter, setHistoryModelFilter] = useState('all')
  const [historyRatioFilter, setHistoryRatioFilter] = useState('all')
  const [preview, setPreview] = useState<{ images: GeneratedImage[]; index: number } | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [promptCopied, setPromptCopied] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<'success' | 'failed' | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [tasks, setTasks] = useState<GenerationTask[]>([])
  const [comparison, setComparison] = useState<ComparisonSession | null>(null)
  const [comparisonFullscreen, setComparisonFullscreen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewStage = useRef<HTMLDivElement>(null)
  const elapsed = useElapsed(generating, startedAt)

  // A saved settings change is authoritative. Keep the active selection and
  // comparison choices in that allow-list without disturbing valid choices.
  const imageModelKey = imageModels.join('\u0000')
  useEffect(() => {
    setModel(previous => imageModels.includes(previous) ? previous : imageModels[0])
    setCompareModels(previous => {
      const retained = previous.filter(candidate => imageModels.includes(candidate))
      return retained.length > 0 ? retained : [imageModels[0]]
    })
  }, [imageModelKey])

  const filteredGallery = gallery
    .filter(entry => {
      if (galleryFilter === 'all') return true
      if (galleryFilter === 'text' || galleryFilter === 'edit') return entry.mode === galleryFilter
      return entry.model === galleryFilter
    })
    .filter(entry => galleryRatio === 'all' || normalizeSize(entry.size) === galleryRatio)
    .filter(entry => galleryTagFilter === null || (entry.tags ?? []).includes(galleryTagFilter))
    .filter(entry => galleryQuery.trim() === '' || `${entry.prompt} ${entry.model} ${(entry.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(galleryQuery.trim().toLocaleLowerCase()))
    .slice()
    .sort((a, b) => gallerySort === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt)

  const galleryTagOptions = [...new Set(gallery.flatMap(entry => entry.tags ?? []))].sort((a, b) => a.localeCompare(b))
  const galleryModels = [...new Set([...imageModels, ...gallery.map(entry => entry.model)])]

  const filteredHistory = history.filter(entry => {
    const query = historyQuery.trim().toLocaleLowerCase()
    return (query === '' || `${entry.prompt} ${entry.model}`.toLocaleLowerCase().includes(query))
      && (historyModelFilter === 'all' || entry.model === historyModelFilter)
      && (historyRatioFilter === 'all' || normalizeSize(entry.size) === historyRatioFilter)
  })

  // Load the host-persisted history and gallery once on mount (they live in
  // ~/.dsh on the DSH host, so every browser/device sees the same lists).
  useEffect(() => {
    let disposed = false
    api.historyList()
      .then(entries => { if (!disposed) setHistory(entries) })
      .catch(() => { /* history unavailable — leave the list empty */ })
    api.galleryList()
      .then(entries => { if (!disposed) setGallery(entries) })
      .catch(() => { /* gallery unavailable — leave the list empty */ })
    return () => { disposed = true }
  }, [api])

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void api.taskList().then(next => {
        if (disposed) return
        setTasks(previous => {
          const completed = next.find(task => task.status === 'completed'
            && !previous.some(old => old.id === task.id && old.status === 'completed')
            && !comparison?.taskIds.includes(task.id))
          if (completed?.result !== undefined) {
            setImages(completed.result.images)
            if (completed.result.history !== undefined) setHistory(completed.result.history)
            setError(completed.result.historyError ?? null)
          }
          return next
        })
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 1500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [api, comparison])

  // Close the model dropdown when clicking anywhere outside it.
  const modelMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modelOpen) return
    const onPointer = (event: MouseEvent | FocusEvent): void => {
      const target = event.target
      if (target instanceof Node && modelMenuRef.current?.contains(target)) return
      setModelOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('focusin', onPointer)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('focusin', onPointer)
    }
  }, [modelOpen])

  // Release checks are host-mediated and intentionally best-effort: a GitHub
  // outage must never make the image-generation studio unavailable.
  useEffect(() => {
    let disposed = false
    api.updateCheck()
      .then(info => {
        if (!disposed && info.updateAvailable) setUpdate(info)
      })
      .catch(() => { /* update discovery is optional */ })
    return () => { disposed = true }
  }, [api])

  const applyUpdate = async (): Promise<void> => {
    if (update === null || updating) return
    setUpdating(true)
    setUpdateMessage(null)
    setUpdateResult(null)
    try {
      const result = await api.updateApply(update.latestVersion)
      setUpdateMessage(tt('update.success', { version: result.updatedVersion }))
      setUpdateResult('success')
    } catch {
      setUpdateMessage(tt('update.failed'))
      setUpdateResult('failed')
    } finally {
      setUpdating(false)
    }
  }

  const openSettingsGuide = (kind: 'generation' | 'enhancement' | 'disabled'): void => {
    setConfigGuide(kind)
    const openPluginSettings = (): void => {
      const pluginButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => /^(插件|Plugins)$/.test(button.textContent?.trim() ?? ''))
      pluginButton?.click()
      window.setTimeout(() => {
        const imageGenButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => /dsh-imagegen/i.test(button.textContent ?? ''))
        if (imageGenButton?.getAttribute('aria-expanded') !== 'true') imageGenButton?.click()
      }, 0)
    }
    const settingsButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => /^(设置|Settings)$/.test(button.textContent?.trim() ?? ''))
    if (settingsButton?.getAttribute('aria-expanded') !== 'true') settingsButton?.click()
    window.setTimeout(openPluginSettings, 0)
  }

  const enhanceCurrentPrompt = async (): Promise<void> => {
    if (prompt.trim() === '' || enhancing) return
    const promptEndpointConfigured = (config?.promptApiUrl ?? '').trim() !== '' || configured
    if ((config?.promptModel ?? '').trim() === '' || !promptEndpointConfigured || (!promptKeySet && !apiKeySet)) {
      openSettingsGuide('enhancement')
      return
    }
    setEnhancing(true)
    setError(null)
    try {
      setPrompt(await api.enhancePrompt(prompt))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setEnhancing(false)
    }
  }

  /** Read an uploaded reference image into a data URL. */
  const acceptFile = (file: File | undefined): void => {
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      setError(tt('edit.uploadHint'))
      return
    }
    if (file.size > REF_IMAGE_MAX_BYTES) {
      setError(tt('edit.uploadHint'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setRefImage({ dataUrl: reader.result, name: file.name })
    }
    reader.onerror = () => { setError(tt('edit.uploadHint')) }
    reader.readAsDataURL(file)
  }

  /** Run one generation. */
  const handleGenerate = async (): Promise<void> => {
    if (generating) return
    if (!enabled) {
      openSettingsGuide('disabled')
      return
    }
    if (!configured || !apiKeySet) {
      openSettingsGuide('generation')
      return
    }
    const promptText = prompt.trim()
    if (promptText === '') {
      setError(tt('prompt.required'))
      return
    }
    if (tab === 'edit' && refImage === null) {
      setError(tt('edit.required'))
      return
    }
    const request: GenerateRequest = {
      mode: tab === 'gallery' ? 'text' : tab,
      model: imageModels.includes(model) ? model : imageModels[0],
      prompt: promptText,
      size,
      quality,
      n: count,
      detail,
      ...tab === 'edit' && refImage !== null ? { image: refImage.dataUrl } : {},
      ...tab === 'edit' && refImage !== null ? { refName: refImage.name } : {},
    }
    setError(null)
    try {
      const targetModels = (compareEnabled ? compareModels : [request.model]).filter(candidate => imageModels.includes(candidate))
      if (targetModels.length === 0) {
        setError(tt('compare.selectRequired'))
        return
      }
      const submitted = await Promise.all(targetModels.map(targetModel => api.taskSubmit({ ...request, model: targetModel })))
      setTasks(previous => [...submitted, ...previous.filter(item => !submitted.some(task => task.id === item.id))])
      setComparison(targetModels.length > 1 ? { taskIds: submitted.map(task => task.id), prompt: promptText } : null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Open the full-screen image preview at a given index. */
  const openPreview = (previewImages: GeneratedImage[], index: number): void => {
    setPreview({ images: previewImages, index })
    setPreviewScale(1)
    setPromptCopied(false)
  }

  const closePreview = (): void => {
    setPreview(null)
    setPreviewScale(1)
    setPromptCopied(false)
  }

  /** Step the preview by ±1, wrapping around. */
  const stepPreview = (delta: number): void => {
    setPreviewScale(1)
    setPromptCopied(false)
    setPreview(current => {
      if (current === null) return null
      const total = current.images.length
      return { images: current.images, index: (current.index + delta + total) % total }
    })
  }

  // Keyboard navigation for the preview overlay.
  useEffect(() => {
    if (preview === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
      else if (event.key === 'ArrowLeft') stepPreview(-1)
      else if (event.key === 'ArrowRight') stepPreview(1)
      else if (event.key === '+' || event.key === '=') setPreviewScale(current => clampPreviewScale(current + PREVIEW_SCALE_STEP))
      else if (event.key === '-') setPreviewScale(current => clampPreviewScale(current - PREVIEW_SCALE_STEP))
      else if (event.key === '0') setPreviewScale(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  // A scaled image owns real scrollable space, rather than being visually
  // transformed and clipped. Recenter the viewport after every zoom or slide.
  useEffect(() => {
    if (preview === null) return
    const frame = window.requestAnimationFrame(() => {
      const stage = previewStage.current
      if (stage === null) return
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [preview, previewScale])

  /** Load a past generation's images into the canvas. */
  const viewHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      setImages(await historyImagesToGenerated(entry.images))
      setError(null)
      setViewingHistoryId(entry.id)
      setGalleryViewingId(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Restore a past generation's parameters (and its images) into the form. */
  const restoreHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const restored = await historyImagesToGenerated(entry.images)
      setTab(entry.mode)
      setPrompt(entry.prompt)
      setSize(normalizeSize(entry.size))
      setQuality(normalizeQuality(entry.quality))
      setDetail((DETAILS as readonly string[]).includes(entry.detail) ? entry.detail : '')
      setCount(entry.n >= 1 && entry.n <= 4 ? entry.n : 1)
      setModel(imageModels.includes(entry.model) ? entry.model : imageModels[0])
      setRefImage(null)
      setImages(restored)
      setError(null)
      setViewingHistoryId(entry.id)
      setGalleryViewingId(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove one history entry. */
  const deleteHistoryEntry = async (id: string): Promise<void> => {
    setHistory(history.filter(entry => entry.id !== id))
    if (viewingHistoryId === id) setViewingHistoryId(null)
    try {
      setHistory(await api.historyRemove(id))
    } catch {
      // Keep the optimistic local removal.
    }
  }

  /** Remove all history entries. */
  const clearHistory = async (): Promise<void> => {
    setHistory([])
    setViewingHistoryId(null)
    try {
      setHistory(await api.historyClear())
    } catch {
      // Keep the cleared local state.
    }
  }

  /** Add one generated image to the gallery (host deduplicates by content).
   *  `entry` makes the action available from a history/gallery list item (its
   *  metadata + first image are saved); otherwise the current form state is
   *  used. */
  const addToGallery = async (image: GeneratedImage, entry?: HistoryEntry): Promise<void> => {
    if (galleryAdding || tab === 'gallery') return
    const source = entry ?? viewingEntry ?? {
      mode: tab === 'edit' ? 'edit' as GenerateMode : 'text' as GenerateMode,
      model,
      prompt: prompt.trim(),
      size,
      quality,
      detail,
      ...refImage !== null ? { refName: refImage.name } : {},
    }
    setGalleryAdding(true)
    try {
      const result = await api.galleryAppend({
        id: '', // the host assigns a fresh id
        createdAt: Date.now(),
        mode: source.mode,
        model: source.model,
        prompt: source.prompt,
        size: source.size,
        quality: source.quality,
        detail: source.detail,
        n: 1,
        images: [image],
        ...source.refName === undefined ? {} : { refName: source.refName },
      })
      setGallery(result.entries)
      setGalleryMessage(result.added ? tt('gallery.added') : tt('gallery.already'))
      window.setTimeout(() => { setGalleryMessage(null) }, 2200)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setGalleryAdding(false)
    }
  }

  /** Add one history entry's first image to the gallery (fetches it from the
   *  history image route, then delegates to addToGallery). */
  const addHistoryEntryToGallery = async (entry: HistoryEntry): Promise<void> => {
    if (galleryAdding || entry.images.length === 0) return
    try {
      const [image] = await historyImagesToGenerated(entry.images.slice(0, 1))
      if (image === undefined) return
      await addToGallery(image, entry)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** View a gallery image in the canvas. */
  const viewGalleryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const restored = await historyImagesToGenerated(entry.images)
      setImages(restored)
      setError(null)
      setViewingHistoryId(null)
      setGalleryViewingId(entry.id)
      if (restored.length > 0) openPreview(restored, 0)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Restore a gallery entry's parameters (and its images) into the form. */
  const restoreGalleryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const restored = await historyImagesToGenerated(entry.images)
      setTab(entry.mode)
      setPrompt(entry.prompt)
      setSize(normalizeSize(entry.size))
      setQuality(normalizeQuality(entry.quality))
      setDetail((DETAILS as readonly string[]).includes(entry.detail) ? entry.detail : '')
      setCount(entry.n >= 1 && entry.n <= 4 ? entry.n : 1)
      setModel(imageModels.includes(entry.model) ? entry.model : imageModels[0])
      setRefImage(null)
      setImages(restored)
      setError(null)
      setViewingHistoryId(null)
      setGalleryViewingId(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove one gallery entry. */
  const deleteGalleryEntry = async (id: string): Promise<void> => {
    setGallery(gallery.filter(entry => entry.id !== id))
    if (galleryViewingId === id) setGalleryViewingId(null)
    try {
      setGallery(await api.galleryRemove(id))
    } catch {
      // Keep the optimistic local removal.
    }
  }

  /** Remove every gallery entry. */
  const clearGalleryAll = async (): Promise<void> => {
    setGallery([])
    setGalleryViewingId(null)
    try {
      setGallery(await api.galleryClear())
    } catch {
      // Keep the cleared local state.
    }
  }

  const applyGalleryTags = async (): Promise<void> => {
    const tags = galleryTagInput.split(',').map(tag => tag.trim()).filter(Boolean)
    if (tags.length === 0 || selectedGalleryIds.size === 0) return
    try {
      let next = gallery
      for (const id of selectedGalleryIds) {
        const existing = next.find(entry => entry.id === id)?.tags ?? []
        next = await api.gallerySetTags(id, [...existing, ...tags])
      }
      setGallery(next)
      setGalleryTagInput('')
    } catch (caught) { setError(errorMessage(caught)) }
  }

  const startEditingGalleryTags = (entry: HistoryEntry): void => {
    setEditingGalleryTagsId(entry.id)
    setGalleryTagEditInput((entry.tags ?? []).join(', '))
  }

  const saveGalleryTags = async (id: string): Promise<void> => {
    const tags = galleryTagEditInput.split(',').map(tag => tag.trim()).filter(Boolean)
    try {
      setGallery(await api.gallerySetTags(id, tags))
      setEditingGalleryTagsId(null)
      setGalleryTagEditInput('')
    } catch (caught) { setError(errorMessage(caught)) }
  }

  const toggleGallerySelection = (id: string): void => {
    setSelectedGalleryIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearGallerySelection = (): void => {
    setSelectedGalleryIds(new Set())
    setGallerySelecting(false)
  }

  const exportGalleryJson = (): void => {
    const entries = gallery.filter(entry => selectedGalleryIds.has(entry.id))
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `dsh-imagegen-gallery-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const downloadGalleryImages = (): void => {
    gallery.filter(entry => selectedGalleryIds.has(entry.id)).forEach((entry, index) => {
      const image = entry.images[0]
      if (image === undefined) return
      const anchor = document.createElement('a')
      anchor.href = image.url
      anchor.download = `dsh-gallery-${index + 1}.${extensionOf(image.mime)}`
      anchor.click()
    })
  }

  const generateDisabled = generating
  const viewingEntry = viewingHistoryId === null ? null : history.find(entry => entry.id === viewingHistoryId) ?? null
  const viewingGalleryEntry = galleryViewingId === null ? null : gallery.find(entry => entry.id === galleryViewingId) ?? null
  const previewImage = preview === null ? null : preview.images[preview.index] ?? null
  const comparisonTasks = comparison === null ? [] : comparison.taskIds.map(id => tasks.find(task => task.id === id)).filter((task): task is GenerationTask => task !== undefined)
  const comparisonResults = comparisonTasks.filter(task => task.status === 'completed' && task.result !== undefined)
  const previewFrameScale = Math.max(1, previewScale)
  const previewImageScale = previewScale / previewFrameScale

  const copyPreviewPrompt = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('copy failed')
      }
      setPromptCopied(true)
      window.setTimeout(() => { setPromptCopied(false) }, 1800)
    } catch {
      setPromptCopied(false)
    }
  }

  const addPreviewToEdit = (): void => {
    if (previewImage === null || preview === null) return
    setTab('edit')
    setRefImage({
      dataUrl: srcOf(previewImage),
      name: `dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`,
    })
    if (prompt.trim() === '' && previewImage.revisedPrompt !== undefined) setPrompt(previewImage.revisedPrompt)
    setError(null)
    closePreview()
  }

  return (
    <div className={css.panel}>
      <header className={css.panelHeader}>
        <span className={css.panelHeading}>
          <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
          <a
            className={css.githubLink}
            href="https://github.com/dickpy/dsh-imagegen"
            target="_blank"
            rel="noreferrer"
            title={tt('panel.githubTip')}
            aria-label={tt('panel.githubTip')}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
        </span>
        <button
          type="button"
          className={css.connectionStatus}
          data-connected={connected ? 'true' : 'false'}
          aria-label={tt(connected ? 'connection.connected' : 'connection.disconnected')}
        >
          <span className={css.connectionDot} aria-hidden="true" />
          {tt(connected ? 'connection.connected' : 'connection.disconnected')}
        </button>
      </header>

      {update !== null ? (
        <div className={css.updateBanner} data-kind={updateResult === 'success' ? 'ok' : 'warn'}>
          <span className={css.updateText}>
            {updateMessage ?? tt('update.available', { version: update.latestVersion })}
          </span>
          <span className={css.updateActions}>
            <a className={css.updateRelease} href={update.releaseUrl} target="_blank" rel="noreferrer">{tt('update.release')}</a>
            <Button variant="primary" size="sm" disabled={updating || updateMessage !== null} onClick={() => { void applyUpdate() }}>
              {updating ? tt('update.installing') : tt('update.install')}
            </Button>
          </span>
        </div>
      ) : null}

      <div className={css.studio}>
        {/* ---------------------------------------------------- config sidebar */}
        <aside className={css.config} data-gallery={tab === 'gallery' ? 'true' : undefined}>
          {tab === 'gallery' ? (
            <div className={css.galleryFilters}>
              <div className={css.galleryFilterHeading}>{tt('gallery.categories')}</div>
              {[
                ['all', tt('gallery.all')],
                ['text', tt('mode.text')],
                ['edit', tt('mode.edit')],
                ...galleryModels.map(value => [value, value]),
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={css.galleryFilter}
                  data-active={galleryFilter === value ? '' : undefined}
                  onClick={() => { setGalleryFilter(value) }}
                >
                  <span>{label}</span>
                  <span className={css.galleryFilterCount}>{gallery.filter(entry => value === 'all' || value === 'text' || value === 'edit' ? (value === 'all' ? true : entry.mode === value) : entry.model === value).length}</span>
                </button>
              ))}
              <div className={css.galleryFilterDivider} />
              <div className={css.galleryFilterHeading}>{tt('gallery.ratio')}</div>
              <div className={css.galleryRatioList}>
                {(['all', '1:1', '3:4', '4:3', '16:9'] as const).map(ratio => (
                  <button key={ratio} type="button" className={css.galleryRatio} data-active={galleryRatio === ratio ? '' : undefined} onClick={() => { setGalleryRatio(ratio) }}>
                    {ratio === 'all' ? tt('gallery.all') : ratio}
                  </button>
                ))}
              </div>
              {galleryTagOptions.length > 0 ? (
                <>
                  <div className={css.galleryFilterDivider} />
                  <div className={css.galleryFilterHeading}>{tt('gallery.tags')}</div>
                  <div className={css.galleryTagFilterList}>
                    {galleryTagOptions.map(tag => (
                      <button key={tag} type="button" className={css.galleryTagFilter} data-active={galleryTagFilter === tag ? '' : undefined} onClick={() => { setGalleryTagFilter(previous => previous === tag ? null : tag) }}>
                        <span>{tag}</span>
                        <span>{gallery.filter(entry => (entry.tags ?? []).includes(tag)).length}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <div className={css.galleryFilterNote}>{tt('gallery.filterHint')}</div>
            </div>
          ) : null}
          <div className={css.configScroll}>
            {/* mode / gallery tabs */}
            <section className={css.card}>
              <div className={css.modeRow} role="tablist" aria-label={tt('panel.title')}>
                <Pill active={tab === 'text'} onClick={() => { setTab('text') }} className={css.modePill}>{tt('mode.text')}</Pill>
                <Pill active={tab === 'edit'} onClick={() => { setTab('edit') }} className={css.modePill}>{tt('mode.edit')}</Pill>
                <Pill active={tab === 'gallery'} onClick={() => { setTab('gallery') }} className={css.modePill}>{tt('gallery.title')}</Pill>
              </div>
            </section>

            {/* reference image (edit mode) */}
            {tab === 'edit' ? (
              <section className={css.card}>
                {refImage === null
                  ? (
                    <button
                      type="button"
                      className={css.uploadBox}
                      onClick={() => { fileInput.current?.click() }}
                      onDragOver={(event) => { event.preventDefault() }}
                      onDrop={(event) => {
                        event.preventDefault()
                        acceptFile(event.dataTransfer.files?.[0])
                      }}
                    >
                      <span className={css.uploadIcon}>
                        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5V3"/><path d="M5 5.5l3-3 3 3"/><path d="M2.5 9v3.5h11V9"/></svg>
                      </span>
                      <span>{tt('edit.upload')}</span>
                      <span className={css.uploadHint}>{tt('edit.uploadHint')}</span>
                    </button>
                  )
                  : (
                    <div className={css.reference}>
                      <img className={css.referenceImage} src={refImage.dataUrl} alt={refImage.name} />
                      <div className={css.referenceActions}>
                        <Button variant="outline" size="sm" onClick={() => { fileInput.current?.click() }}>
                          {tt('edit.change')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setRefImage(null) }}>
                          {tt('edit.remove')}
                        </Button>
                      </div>
                    </div>
                  )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className={css.hiddenFile}
                  onChange={(event) => {
                    acceptFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </section>
            ) : null}

                {/* prompt */}
                <section className={css.card}>
              <textarea
                className={css.prompt}
                value={prompt}
                placeholder={tt('prompt.placeholder')}
                onChange={(event) => { setPrompt(event.target.value) }}
              />
              <div className={css.promptFooter}>
                <button
                  type="button"
                  className={css.templatesButton}
                  title={tt('templates.title')}
                  onClick={() => { setLibraryOpen(true) }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/></svg>
                  {tt('templates.open')}
                </button>
                <button
                  type="button"
                  className={css.enhanceButton}
                  disabled={prompt.trim() === '' || enhancing}
                  title={tt('prompt.enhanceHint')}
                  onClick={() => { void enhanceCurrentPrompt() }}
                >
                  {enhancing ? tt('prompt.enhancing') : tt('prompt.enhance')}
                </button>
                <span className={css.promptCount}>{tt('prompt.count', { count: prompt.length })}</span>
              </div>
            </section>

            {/* parameters */}
            <section className={css.card}>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.size')}</span>
                <div className={css.optionGrid}>
                  {SIZES.map(option => (
                    <Pill
                      key={option}
                      active={size === option}
                      onClick={() => { setSize(option) }}
                      className={css.optionPill}
                    >
                      {tt(SIZE_KEYS[option] ?? 'size.auto')}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.quality')}</span>
                <div className={css.optionRow}>
                  {QUALITIES.map(option => (
                    <Pill
                      key={option}
                      active={quality === option}
                      onClick={() => { setQuality(option) }}
                      className={css.optionPill}
                    >
                      {tt(`quality.${option}` as const)}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.count')}</span>
                <div className={css.optionRow}>
                  {[1, 2, 3, 4].map(option => (
                    <Pill
                      key={option}
                      active={count === option}
                      onClick={() => { setCount(option) }}
                      className={css.optionPill}
                    >
                      {tt(`count.${option === 1 ? 'one' : option === 2 ? 'two' : option === 3 ? 'three' : 'four'}` as const)}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.detail')}</span>
                <div className={css.optionRow}>
                  {DETAILS.map(option => (
                    <Pill
                      key={option === '' ? 'auto' : option}
                      active={detail === option}
                      onClick={() => { setDetail(option) }}
                      className={css.optionPill}
                    >
                      {tt(option === '' ? 'detail.auto' : option === 'standard' ? 'detail.standard' : 'detail.high')}
                    </Pill>
                  ))}
                </div>
                <span className={css.paramHint}>{tt('detail.hint')}</span>
              </div>
            </section>
          </div>

          {/* footer: model + generate — a fixed sibling of the scroll area, so
              it never overlaps the cards scrolling above it. */}
            <section className={css.footer}>
            <label className={css.modelWrap}>
              <span className={css.modelLabel}>{tt('model.label')}</span>
              <span ref={modelMenuRef} className={css.modelMenu} data-open={modelOpen ? 'true' : 'false'}>
                <button
                  type="button"
                  className={css.modelSelect}
                  disabled={generating}
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  onClick={() => { setModelOpen(open => !open) }}
                >
                  <span>{model}</span>
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5L4 6h8z"/></svg>
                </button>
                {modelOpen ? (
                  <div className={css.modelMenuList} role="listbox" aria-label={tt('model.label')}>
                    {imageModels.map(option => (
                      <button
                        key={option}
                        type="button"
                        role="option"
                        aria-selected={model === option}
                        className={css.modelMenuItem}
                        data-selected={model === option ? '' : undefined}
                        onClick={() => { setModel(option); setModelOpen(false) }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}
              </span>
            </label>
            <div className={css.compareControl}>
              <label className={css.compareToggle}>
                <input type="checkbox" checked={compareEnabled} onChange={event => { setCompareEnabled(event.target.checked) }} />
                <span>{tt('compare.enable')}</span>
              </label>
              {compareEnabled ? (
                <div className={css.compareModelChoices} role="group" aria-label={tt('compare.models')}>
                  {imageModels.map(option => (
                    <label key={option}>
                      <input type="checkbox" checked={compareModels.includes(option)} onChange={() => { setCompareModels(previous => previous.includes(option) ? previous.filter(value => value !== option) : [...previous, option]) }} />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <Button
              variant="primary"
              size="md"
              className={css.generateButton}
              disabled={generateDisabled}
              onClick={() => { void handleGenerate() }}
            >
              {generating ? (
                <span className={css.generateInner}>
                  <span className={css.spinner} />
                  {tt('generating')}
                </span>
              ) : tt('generate')}
              </Button>
            </section>
        </aside>

        {/* --------------------------------------------------------- canvas */}
        <section className={css.canvas} data-gallery={tab === 'gallery' ? 'true' : undefined}>
          {tab === 'gallery' ? (
            <div className={css.galleryWorkspace}>
              <header className={css.galleryToolbar}>
                <div>
                  <h3 className={css.galleryHeading}>{tt('gallery.all')}</h3>
                  <span className={css.galleryCount}>{tt('gallery.count', { count: filteredGallery.length })}</span>
                </div>
                <div className={css.galleryToolbarActions}>
                  <input className={css.gallerySearch} value={galleryQuery} onChange={event => { setGalleryQuery(event.target.value) }} placeholder={tt('gallery.search')} aria-label={tt('gallery.search')} />
                  <button type="button" className={css.gallerySelectMode} data-active={gallerySelecting ? '' : undefined} aria-pressed={gallerySelecting} onClick={() => { setGallerySelecting(previous => !previous) }}>
                    {gallerySelecting ? tt('gallery.selectionDone') : tt('gallery.select')}
                  </button>
                  <div className={css.galleryViewToggle} role="group" aria-label={tt('gallery.viewMode')}>
                    <button type="button" data-active={galleryView === 'masonry' ? '' : undefined} onClick={() => { setGalleryView('masonry') }} title={tt('gallery.masonry')}>
                      <span aria-hidden="true">▦</span> {tt('gallery.masonry')}
                    </button>
                    <button type="button" data-active={galleryView === 'grid' ? '' : undefined} onClick={() => { setGalleryView('grid') }} title={tt('gallery.grid')}>
                      <span aria-hidden="true">▤</span> {tt('gallery.grid')}
                    </button>
                  </div>
                  <select className={css.gallerySort} value={gallerySort} onChange={event => { setGallerySort(event.target.value as 'newest' | 'oldest') }} aria-label={tt('gallery.sort')}>
                    <option value="newest">{tt('gallery.newest')}</option>
                    <option value="oldest">{tt('gallery.oldest')}</option>
                  </select>
                  {gallery.length > 0 ? <button type="button" className={css.galleryClear} onClick={() => { void clearGalleryAll() }}>{tt('gallery.clear')}</button> : null}
                </div>
              </header>
              {selectedGalleryIds.size > 0 ? (
                <section className={css.gallerySelectionBar} aria-label={tt('gallery.selected', { count: selectedGalleryIds.size })}>
                  <strong>{tt('gallery.selected', { count: selectedGalleryIds.size })}</strong>
                  <input className={css.galleryTagInput} value={galleryTagInput} onChange={event => { setGalleryTagInput(event.target.value) }} placeholder={tt('gallery.tagsPlaceholder')} aria-label={tt('gallery.tagsPlaceholder')} />
                  <button type="button" className={css.galleryBulkButton} disabled={galleryTagInput.trim() === ''} onClick={() => { void applyGalleryTags() }}>{tt('gallery.tagsApply')}</button>
                  <button type="button" className={css.galleryBulkButton} onClick={downloadGalleryImages}>{tt('gallery.downloadSelected')}</button>
                  <button type="button" className={css.galleryBulkButton} onClick={exportGalleryJson}>{tt('gallery.exportJson')}</button>
                  <button type="button" className={css.gallerySelectionClear} onClick={clearGallerySelection}>{tt('gallery.selectionClear')}</button>
                </section>
              ) : null}
              {filteredGallery.length === 0 ? (
                <div className={css.historyEmpty}>{tt('gallery.empty')}</div>
              ) : (
                <div className={css.galleryMasonry} data-view={galleryView}>
                  {filteredGallery.map(entry => {
                    const image = entry.images[0]
                    if (image === undefined) return null
                    return (
                      <article key={entry.id} className={css.galleryCard} data-selected={selectedGalleryIds.has(entry.id) ? '' : undefined}>
                        <label className={css.gallerySelect} title={tt('gallery.select')}>
                          <input type="checkbox" checked={selectedGalleryIds.has(entry.id)} onChange={() => { setGallerySelecting(true); toggleGallerySelection(entry.id) }} />
                        </label>
                        <button type="button" className={css.galleryImageButton} data-selecting={gallerySelecting ? '' : undefined} onClick={() => { if (gallerySelecting) toggleGallerySelection(entry.id); else void viewGalleryEntry(entry) }} title={gallerySelecting ? tt('gallery.select') : tt('preview.open')}>
                          <img className={css.galleryImage} src={image.url} alt={entry.prompt} />
                          <span className={css.galleryBadge}>{entry.mode === 'edit' ? tt('mode.edit') : tt('mode.text')}</span>
                        </button>
                        <div className={css.galleryCardFooter}>
                          <span className={css.galleryAvatar}>{entry.model.startsWith('grok') ? 'G' : 'D'}</span>
                          <span className={css.galleryCardInfo}>
                            <strong>{entry.prompt || tt('gallery.untitled')}</strong>
                            <small>{entry.model} · {normalizeSize(entry.size)} · {formatTime(entry.createdAt)}</small>
                            <span className={css.galleryTags}>
                              {(entry.tags ?? []).map(tag => <button key={tag} type="button" onClick={() => { setGalleryTagFilter(tag) }}>{tag}</button>)}
                              <button type="button" className={css.galleryTagEdit} onClick={() => { startEditingGalleryTags(entry) }} title={tt('gallery.editTags')}>{tt('gallery.tagsEditShort')}</button>
                            </span>
                          </span>
                          <button type="button" className={css.galleryRemove} onClick={() => { void deleteGalleryEntry(entry.id) }} title={tt('gallery.delete')}>×</button>
                        </div>
                        {editingGalleryTagsId === entry.id ? (
                          <form className={css.galleryTagEditor} onSubmit={event => { event.preventDefault(); void saveGalleryTags(entry.id) }}>
                            <input value={galleryTagEditInput} onChange={event => { setGalleryTagEditInput(event.target.value) }} placeholder={tt('gallery.tagsPlaceholder')} aria-label={tt('gallery.tagsPlaceholder')} autoFocus />
                            <button type="submit">{tt('gallery.tagsSave')}</button>
                            <button type="button" onClick={() => { setEditingGalleryTagsId(null); setGalleryTagEditInput('') }}>{tt('gallery.tagsCancel')}</button>
                          </form>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}
          {tab !== 'gallery' && tasks.length > 0 ? (
            <section className={css.taskTray} aria-label={tt('tasks.title')}>
              <header className={css.taskTrayHeader}>{tt('tasks.title')} <span>{tasks.filter(task => task.status === 'queued' || task.status === 'running').length}</span></header>
              {tasks.slice(0, 5).map(task => (
                <div key={task.id} className={css.taskRow} data-status={task.status}>
                  <span className={css.taskStatus}>{tt(`tasks.${task.status}` as never)}</span>
                  <span className={css.taskPrompt}>{task.request.prompt}</span>
                  {(task.status === 'queued' || task.status === 'running') ? <button type="button" onClick={() => { void api.taskCancel(task.id) }}>{tt('tasks.cancel')}</button> : null}
                  {task.status === 'failed' || task.status === 'cancelled' ? <button type="button" onClick={() => { void api.taskRetry(task.id) }}>{tt('tasks.retry')}</button> : null}
                </div>
              ))}
            </section>
          ) : null}
          {tab !== 'gallery' && comparison !== null ? (
            <section className={css.comparisonBoard} aria-label={tt('compare.title')}>
              <header><div><strong>{tt('compare.title')}</strong><span>{comparisonResults.length} / {comparisonTasks.length}</span></div><button type="button" disabled={comparisonResults.length === 0} onClick={() => { setComparisonFullscreen(true) }}>{tt('compare.fullscreen')}</button></header>
              <div className={css.comparisonGrid}>
                {comparisonTasks.map(task => (
                  <article key={task.id}>
                    <strong>{task.request.model}</strong>
                    {task.result?.images[0] !== undefined ? <img src={srcOf(task.result.images[0])} alt={task.request.model} /> : <span>{tt(`tasks.${task.status}` as never)}</span>}
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {generating ? (
            <div className={css.canvasState} role="status">
              <span className={css.bigSpinner} />
              <span className={css.canvasStateTitle}>{tt('canvas.generating')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.elapsed', { seconds: elapsed })}</span>
            </div>
          ) : null}

          {!generating && error !== null ? (
            <div className={css.canvasError} role="alert">{tt('canvas.error', { error })}</div>
          ) : null}

          {!generating && !error && images.length === 0 ? (
            <div className={css.canvasState}>
              <span className={css.canvasEmptyIcon}>
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              </span>
              <span className={css.canvasStateTitle}>{tt('canvas.emptyTitle')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.emptyHint')}</span>
            </div>
          ) : null}

          {!generating && images.length > 0 ? (
            <div className={css.canvasBody}>
              <div className={css.canvasMeta}>
                <span>{tt('canvas.images', { count: images.length })}</span>
                {viewingEntry !== null || viewingGalleryEntry !== null ? (
                  <span className={css.canvasHistoryTag}>
                    {viewingEntry !== null
                      ? tt('history.viewing', { time: formatTime(viewingEntry.createdAt) })
                      : tt('gallery.viewing', { time: formatTime(viewingGalleryEntry!.createdAt) })}
                  </span>
                ) : null}
              </div>
              <div className={css.grid} data-count={images.length}>
                {images.map((image, index) => (
                  <figure
                    key={index}
                    className={css.imageCard}
                    role="button"
                    tabIndex={0}
                    title={tt('preview.open')}
                    onClick={() => { openPreview(images, index) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openPreview(images, index)
                      }
                    }}
                  >
                    <img
                      className={css.image}
                      src={srcOf(image)}
                      alt={image.revisedPrompt ?? `${tt('panel.title')} ${index + 1}`}
                    />
                    {image.revisedPrompt !== undefined ? (
                      <figcaption className={css.imageCaption} title={image.revisedPrompt}>
                        {tt('revisedPrompt', { prompt: image.revisedPrompt })}
                      </figcaption>
                    ) : null}
                    <span className={css.zoomHint}>
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="M13 13l-3.2-3.2"/><path d="M7 5.4v3.2M5.4 7h3.2"/></svg>
                      {tt('preview.open')}
                    </span>
                      <button
                        type="button"
                        className={css.galleryAdd}
                        title={tt('gallery.add')}
                        disabled={galleryAdding}
                        onClick={(event) => { event.stopPropagation(); void addToGallery(image) }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M8 5.8v4.4M5.8 8h4.4"/></svg>
                        {tt('gallery.add')}
                      </button>
                    <a
                      className={css.download}
                      href={srcOf(image)}
                      download={`dsh-image-${index + 1}.${extensionOf(image.mime)}`}
                      onClick={(event) => { event.stopPropagation() }}
                    >
                      {tt('download')}
                    </a>
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* ------------------------ right column: gallery (tab) or history */}
        {tab === 'gallery' ? (
          <aside className={css.history}>
            <header className={css.historyHeader}>
              <span className={css.historyTitle}>{tt('gallery.title')}</span>
              {gallery.length > 0 ? (
                <button type="button" className={css.historyClear} onClick={() => { void clearGalleryAll() }}>
                  {tt('gallery.clear')}
                </button>
              ) : null}
            </header>

            {gallery.length === 0 ? (
              <div className={css.historyEmpty}>{tt('gallery.empty')}</div>
            ) : (
              <div className={css.historyList}>
                {gallery.map(entry => (
                  <div
                    key={entry.id}
                    className={css.historyItem}
                    data-active={entry.id === galleryViewingId ? '' : undefined}
                  >
                    <button
                      type="button"
                      className={css.historyMain}
                      onClick={() => { void viewGalleryEntry(entry) }}
                    >
                      {entry.images.length > 0 ? (
                        <img className={css.historyThumb} src={entry.images[0]!.url} alt="" />
                      ) : (
                        <span className={css.historyThumbPlaceholder} />
                      )}
                      <span className={css.historyInfo}>
                        <span className={css.historyPrompt}>{entry.prompt}</span>
                        <span className={css.historyMeta}>
                          {tt(`mode.${entry.mode === 'edit' ? 'edit' : 'text'}` as const)}
                          {' · '}{formatTime(entry.createdAt)}
                        </span>
                      </span>
                    </button>
                    <span className={css.historyActions}>
                      <button type="button" className={css.historyAction} onClick={() => { void restoreGalleryEntry(entry) }}>
                        {tt('history.restore')}
                      </button>
                      <button type="button" className={css.historyAction} data-danger onClick={() => { void deleteGalleryEntry(entry.id) }}>
                        {tt('gallery.delete')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </aside>
        ) : (
          <aside className={css.history}>
          <header className={css.historyHeader}>
            <span className={css.historyTitle}>{tt('history.title')}</span>
            {history.length > 0 ? (
              <button type="button" className={css.historyClear} onClick={() => { void clearHistory() }}>
                {tt('history.clear')}
              </button>
            ) : null}
          </header>

          <div className={css.historyFilters}>
            <input className={css.historySearch} value={historyQuery} onChange={event => { setHistoryQuery(event.target.value) }} placeholder={tt('history.search')} aria-label={tt('history.search')} />
            <select value={historyModelFilter} onChange={event => { setHistoryModelFilter(event.target.value) }} aria-label={tt('history.model')}>
              <option value="all">{tt('history.allModels')}</option>
              {[...new Set(history.map(entry => entry.model))].map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <select value={historyRatioFilter} onChange={event => { setHistoryRatioFilter(event.target.value) }} aria-label={tt('history.ratio')}>
              <option value="all">{tt('history.allRatios')}</option>
              {[...new Set(history.map(entry => normalizeSize(entry.size)))].map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>

          {filteredHistory.length === 0 ? (
            <div className={css.historyEmpty}>{tt('history.empty')}</div>
          ) : (
            <div className={css.historyList}>
              {filteredHistory.map(entry => (
                <div
                  key={entry.id}
                  className={css.historyItem}
                  data-active={entry.id === viewingHistoryId ? '' : undefined}
                >
                  <button
                    type="button"
                    className={css.historyMain}
                    onClick={() => { void viewHistoryEntry(entry) }}
                  >
                    {entry.images.length > 0 ? (
                      <img className={css.historyThumb} src={entry.images[0]!.url} alt="" />
                    ) : (
                      <span className={css.historyThumbPlaceholder} />
                    )}
                    <span className={css.historyInfo}>
                      <span className={css.historyPrompt}>{entry.prompt}</span>
                      <span className={css.historyMeta}>
                        {tt(`mode.${entry.mode === 'edit' ? 'edit' : 'text'}` as const)}
                        {' · '}{formatTime(entry.createdAt)}
                        {' · '}{entry.images.length} {tt('history.images')}
                      </span>
                    </span>
                  </button>
                  <span className={css.historyActions}>
                    {entry.images.length > 0 ? (
                      <button
                        type="button"
                        className={css.historyAction}
                        disabled={galleryAdding}
                        title={tt('gallery.add')}
                        onClick={() => { void addHistoryEntryToGallery(entry) }}
                      >
                        {tt('gallery.add')}
                      </button>
                    ) : null}
                    <button type="button" className={css.historyAction} onClick={() => { void restoreHistoryEntry(entry) }}>
                      {tt('history.restore')}
                    </button>
                    <button type="button" className={css.historyAction} data-danger onClick={() => { void deleteHistoryEntry(entry.id) }}>
                      {tt('history.delete')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          </aside>
        )}
      </div>

      {/* ------------------------------------------------ template library */}
      {libraryOpen ? (
        <TemplateLibrary
          api={api}
          onClose={() => { setLibraryOpen(false) }}
          onUse={(text) => {
            setTab('text')
            setPrompt(text)
            setError(null)
            setLibraryOpen(false)
          }}
        />
      ) : null}

      {configGuide !== null ? (
        <div className={css.configGuide} role="dialog" aria-modal="true" aria-label={tt(`config.${configGuide}Title` as never)}>
          <div className={css.configGuideBody}>
            <strong>{tt(`config.${configGuide}Title` as never)}</strong>
            <span>{tt(`config.${configGuide}Hint` as never)}</span>
            <button type="button" onClick={() => { setConfigGuide(null) }}>{tt('preview.close')}</button>
          </div>
        </div>
      ) : null}

      {comparisonFullscreen && comparison !== null ? createPortal(
        <div className={css.comparisonFullscreen} role="dialog" aria-modal="true" aria-label={tt('compare.title')} onClick={() => { setComparisonFullscreen(false) }}>
          <button type="button" className={css.lightboxClose} aria-label={tt('preview.close')} onClick={() => { setComparisonFullscreen(false) }}>×</button>
          <div className={css.comparisonFullscreenGrid} onClick={event => { event.stopPropagation() }}>
            {comparisonResults.map(task => (
              <figure key={task.id}><figcaption>{task.request.model}</figcaption>{task.result!.images.map((image, index) => <img key={index} src={srcOf(image)} alt={task.request.model} />)}</figure>
            ))}
          </div>
        </div>, document.body) : null}

      {/* -------------------------------------------------- preview overlay */}
      {preview !== null && previewImage !== null
        ? createPortal(
          <div
            className={css.lightbox}
            role="dialog"
            aria-modal="true"
            aria-label={tt('preview.title')}
            onClick={closePreview}
          >
            <button type="button" className={css.lightboxClose} aria-label={tt('preview.close')} title={tt('preview.close')} onClick={closePreview}>
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
            {preview.images.length > 1 ? (
              <>
                <button type="button" className={css.lightboxNav} data-dir="prev" aria-label={tt('preview.prev')} onClick={(event) => { event.stopPropagation(); stepPreview(-1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3l-5 5 5 5"/></svg>
                </button>
                <button type="button" className={css.lightboxNav} data-dir="next" aria-label={tt('preview.next')} onClick={(event) => { event.stopPropagation(); stepPreview(1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
                </button>
              </>
            ) : null}
            <figure className={css.lightboxFigure} onClick={(event) => { event.stopPropagation() }}>
              <div
                ref={previewStage}
                className={css.lightboxStage}
                onWheel={(event) => {
                  event.preventDefault()
                  setPreviewScale(current => clampPreviewScale(current + (event.deltaY < 0 ? PREVIEW_SCALE_STEP : -PREVIEW_SCALE_STEP)))
                }}
              >
                <div
                  className={css.lightboxScaleFrame}
                  style={{ width: `${previewFrameScale * 100}%`, height: `${previewFrameScale * 100}%` }}
                >
                  <img
                    className={css.lightboxImage}
                    style={{ width: `${previewImageScale * 100}%`, height: `${previewImageScale * 100}%` }}
                    src={srcOf(previewImage)}
                    alt={previewImage.revisedPrompt ?? tt('preview.title')}
                  />
                </div>
              </div>
              <div className={css.lightboxTools} role="group" aria-label={tt('preview.zoomControls')}>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomOut')} title={tt('preview.zoomOut')} onClick={() => { setPreviewScale(current => clampPreviewScale(current - PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
                <button type="button" className={css.lightboxZoomLevel} aria-label={tt('preview.zoomReset')} title={tt('preview.zoomReset')} onClick={() => { setPreviewScale(1) }}>
                  {tt('preview.zoomLevel', { percent: Math.round(previewScale * 100) })}
                </button>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomIn')} title={tt('preview.zoomIn')} onClick={() => { setPreviewScale(current => clampPreviewScale(current + PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M7 4.8v4.4M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
              </div>
              {previewImage.revisedPrompt !== undefined ? (
                <div className={css.lightboxCaptionRow}>
                  <figcaption className={css.lightboxCaption} title={previewImage.revisedPrompt}>
                    {tt('revisedPrompt', { prompt: previewImage.revisedPrompt })}
                  </figcaption>
                  <button type="button" className={css.lightboxCopy} aria-label={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} title={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} onClick={() => { void copyPreviewPrompt(previewImage.revisedPrompt!) }}>
                    {promptCopied ? (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="7" height="8" rx="1"/><path d="M3 10V3.8c0-.44.36-.8.8-.8H9"/></svg>
                    )}
                    <span>{tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')}</span>
                  </button>
                </div>
              ) : null}
              <div className={css.lightboxMeta}>
                <span className={css.lightboxIndex}>{tt('preview.index', { index: preview.index + 1, total: preview.images.length })}</span>
                <span className={css.lightboxActions}>
                  <button type="button" className={css.lightboxEdit} disabled={galleryAdding} onClick={() => { void addToGallery(previewImage) }}>
                    {tt('gallery.add')}
                  </button>
                  <button type="button" className={css.lightboxEdit} onClick={addPreviewToEdit}>
                    {tt('preview.addToEdit')}
                  </button>
                  <a
                    className={css.lightboxDownload}
                    href={srcOf(previewImage)}
                    download={`dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`}
                  >
                    {tt('download')}
                  </a>
                </span>
              </div>
            </figure>
          </div>,
          document.body,
        )
        : null}

      {/* ------------------------------------------------- gallery toast */}
      {galleryMessage !== null ? (
        <div className={css.galleryToast} role="status">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M8 5.8v4.4M5.8 8h4.4"/></svg>
          {galleryMessage}
        </div>
      ) : null}
    </div>
  )
}

/** File extension for a MIME type (download filenames). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

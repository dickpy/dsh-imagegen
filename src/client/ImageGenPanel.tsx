/**
 * The AI 生图 studio: a three-column layout — left, a card-grouped
 * configuration sidebar (mode tabs, prompt with counter, rounded parameter
 * selectors, model dropdown + generate button); center, the result canvas;
 * right, a persistent generation history column.
 *
 * Controls ride the system UI primitives (@deepseek-ai/dsh-client-ui-primitives,
 * a platform module) so the studio matches the dsh shell look by construction.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { TemplateLibrary } from './TemplateLibrary.tsx'
import { InspirationGallery } from './InspirationGallery.tsx'
import { useImageGenLanguageTick } from './use-language.ts'
import type { EcommerceRefRole, GeneratedImage, GenerateMode, GenerateRequest, GenerationTask, GenerationTaskStatus, HistoryEntry, HistoryImageRef, ProductSetDraft, ProductSetSlot, UpdateInfo } from '../protocol.ts'
import { AGENT_IMAGE_API } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import { imageModelOptions } from './settings-scope.ts'
import { normalizeImageModels } from '../image-models.ts'
import { describeModel } from '../model-catalog.ts'
import { CHAT_IMAGE_EVENT, type ChatImageEventDetail, type ConversationService } from './conversation-sync.ts'
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
// The local DSH attachment backend defaults to a 2000px per-side limit. Keep
// the full-resolution result in the studio, but normalize the conversation
// copy before it enters the native composer and durable edit staging route.
const CONVERSATION_IMAGE_MAX_DIMENSION = 2000
const CONVERSATION_IMAGE_JPEG_QUALITY = 0.9
const PREVIEW_SCALE_MIN = 0.5
const PREVIEW_SCALE_MAX = 3
const PREVIEW_SCALE_STEP = 0.25
const CONFIG_COLLAPSED_STORAGE_KEY = 'dsh-imagegen-config-collapsed'
const ECOMMERCE_DRAFT_STORAGE_KEY = 'dsh-imagegen-ecommerce-draft'
/** Reference roles an uploaded product asset can play (slot selections can
 *  also pick 'none'). */
const ECOMMERCE_ASSET_ROLES = ['product', 'packaging', 'detail', 'style'] as const
type EcommerceAssetRole = Exclude<EcommerceRefRole, 'none'>
const MAX_ECOMMERCE_ASSETS = 4
const ECOMMERCE_ROLE_PROMPT_LABELS: Record<EcommerceAssetRole, string> = {
  product: '商品主体',
  packaging: '包装',
  detail: '细节/角度',
  style: '风格参考',
}
/** One uploaded product asset. Session-only: data URLs are far too large for
 *  the localStorage draft, so assets never persist across reloads. */
interface ProductAsset {
  id: string
  dataUrl: string
  name: string
  role: EcommerceAssetRole
}

const PRODUCT_SET_SLOTS: ProductSetSlot[] = [
  { key: 'main', label: '主图', description: '干净背景，突出商品主体', count: 1, enabled: true, refRole: 'product' },
  { key: 'selling-point', label: '卖点图', description: '用画面展示商品核心卖点', count: 2, enabled: true, refRole: 'product' },
  { key: 'scene', label: '场景图', description: '真实生活或使用场景', count: 2, enabled: true, refRole: 'product' },
  { key: 'detail', label: '细节图', description: '材质、结构或工艺特写', count: 1, enabled: true, refRole: 'detail' },
  { key: 'spec', label: '规格图', description: '尺寸、容量或参数展示', count: 1, enabled: false, refRole: 'product' },
  { key: 'model', label: '使用图', description: '人物上手或穿戴效果', count: 1, enabled: false, refRole: 'product' },
]

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

/** Keep the image canvas preference across panel remounts without making it
 * part of the host settings document. */
function readConfigCollapsed(): boolean {
  try {
    return window.localStorage.getItem(CONFIG_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const CHAT_COLLAPSED_STORAGE_KEY = 'dsh-imagegen:chat-collapsed'
const CONFIG_WIDTH_STORAGE_KEY = 'dsh-imagegen:config-width'
const CONFIG_WIDTH_MIN = 260
const CONFIG_WIDTH_MAX = 480
const CONFIG_WIDTH_DEFAULT = 300

/** The chat pane starts collapsed unless the user explicitly opened it. */
function readChatOpen(): boolean {
  try {
    return window.localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY) === 'open'
  } catch {
    return false
  }
}

function readConfigWidth(): number {
  try {
    const raw = window.localStorage.getItem(CONFIG_WIDTH_STORAGE_KEY)
    if (raw === null) return CONFIG_WIDTH_DEFAULT
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return Math.min(CONFIG_WIDTH_MAX, Math.max(CONFIG_WIDTH_MIN, Math.round(value)))
  } catch { /* storage unavailable */ }
  return CONFIG_WIDTH_DEFAULT
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
    if (!running || startedAt === null) {
      setElapsed(0)
      return
    }
    const update = (): void => {
      setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  return elapsed
}

/** Data URL for a generated image. */
function srcOf(image: GeneratedImage): string {
  return `data:${image.mime};base64,${image.b64}`
}

/** Decode one durable conversation attachment into the panel's image shape. */
async function attachmentToGenerated(ref: ImageAttachmentRef): Promise<GeneratedImage> {
  const query = new URLSearchParams({
    attachment_id: String(ref.attachmentId),
    media_type: ref.mediaType,
    bytes: String(ref.bytes),
    width: String(ref.width),
    height: String(ref.height),
  })
  const response = await fetch(`${AGENT_IMAGE_API}?${query.toString()}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const blob = await response.blob()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('image decode failed')
  return { b64: dataUrl.slice(comma + 1), mime: ref.mediaType }
}

/** Convert a generated image into the browser-owned draft format. */
function generatedImageToFile(image: GeneratedImage, index: number): File {
  const binary = atob(image.b64)
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset)
  return new File([bytes], `dsh-image-${index + 1}.${extensionOf(image.mime)}`, { type: image.mime })
}

/** Decode a data URL into a browser File for the native composer. */
function dataUrlToFile(dataUrl: string, name: string): File {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(dataUrl)
  if (match === null || match[1] === undefined || match[2] === undefined) throw new Error('image processing returned an invalid data URL')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset)
  return new File([bytes], name, { type: match[1] })
}

/** Read intrinsic dimensions without changing the original preview. */
function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      if (width < 1 || height < 1) reject(new Error('image dimensions are unavailable'))
      else resolve({ width, height })
    }
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = dataUrl
  })
}

/** Prepare the smaller conversation copy required by the host attachment policy. */
async function prepareConversationImage(image: GeneratedImage, index: number): Promise<{ file: File; dataUrl: string }> {
  const dataUrl = srcOf(image)
  const { width, height } = await imageDimensions(dataUrl)
  const longestSide = Math.max(width, height)
  if (longestSide <= CONVERSATION_IMAGE_MAX_DIMENSION) {
    return { file: generatedImageToFile(image, index), dataUrl }
  }

  const scale = CONVERSATION_IMAGE_MAX_DIMENSION / longestSide
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('image resize is unavailable in this browser')
  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const sourceImage = new Image()
    sourceImage.onload = () => resolve(sourceImage)
    sourceImage.onerror = () => reject(new Error('image decode failed'))
    sourceImage.src = dataUrl
  })
  context.drawImage(source, 0, 0, targetWidth, targetHeight)
  const resizedDataUrl = canvas.toDataURL('image/jpeg', CONVERSATION_IMAGE_JPEG_QUALITY)
  return {
    dataUrl: resizedDataUrl,
    file: dataUrlToFile(resizedDataUrl, `dsh-image-${index + 1}.jpg`),
  }
}

/** Follow the native session selection while the image panel stays mounted. */
function useCurrentSessionId(sessions: ISessions | undefined): SessionId | undefined {
  const [sessionId, setSessionId] = useState<SessionId | undefined>(() => sessions?.list.getSnapshot().current)
  useEffect(() => {
    if (sessions === undefined) {
      setSessionId(undefined)
      return
    }
    const sync = (): void => { setSessionId(sessions.list.getSnapshot().current) }
    sync()
    return sessions.list.subscribe(sync)
  }, [sessions])
  return sessionId
}

/** Find the host mounted in the shell's left navigation region. */
function useSidebarHistoryHost(): HTMLDivElement | null {
  const [host, setHost] = useState<HTMLDivElement | null>(() => (
    document.querySelector<HTMLDivElement>('[data-dsh-imagegen-history-host]')
  ))
  useEffect(() => {
    const sync = (): void => {
      setHost(document.querySelector<HTMLDivElement>('[data-dsh-imagegen-history-host]'))
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return host
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

function defaultEcommerceDraft(): ProductSetDraft {
  return {
    projectId: '', projectName: '', category: '通用商品', platform: '通用', language: '中文', customLanguage: '', size: '1:1',
    productName: '', sellingPoints: '', protectedFeatures: '', styleHint: '',
    slots: PRODUCT_SET_SLOTS.map(slot => ({ ...slot })),
  }
}

/** Standard copy-language choices; custom keeps uncommon locales usable. */
const ECOMMERCE_COPY_LANGUAGES = [
  ['中文', '中文'],
  ['English', 'English'],
  ['Русский', 'Русский'],
  ['日本語', '日本語'],
  ['한국어', '한국어'],
  ['Français', 'Français'],
  ['Deutsch', 'Deutsch'],
  ['Español', 'Español'],
  ['Português', 'Português'],
  ['custom', '自定义'],
] as const

function effectiveEcommerceLanguage(draft: ProductSetDraft): string {
  return draft.language === 'custom' ? draft.customLanguage?.trim() ?? '' : draft.language
}

function ecommercePrompt(draft: ProductSetDraft, slot: ProductSetSlot): string {
  const points = draft.sellingPoints.trim() || '突出商品真实材质、结构和核心价值'
  const protectedFeatures = draft.protectedFeatures.trim() || '保持商品颜色、形状、Logo、包装文字和结构真实，不添加不存在的配件'
  const language = effectiveEcommerceLanguage(draft) || '中文'
  const refClause = slot.refRole !== undefined && slot.refRole !== 'none'
    ? `本图以上传的${ECOMMERCE_ROLE_PROMPT_LABELS[slot.refRole]}图片为参考，商品与风格必须与参考图保持一致；`
    : ''
  return `电商${slot.label}：为${draft.productName.trim() || '该商品'}制作${slot.description}。商品品类：${draft.category}；平台：${draft.platform}；语言：${language}。商品卖点：${points}。必须遵守：${protectedFeatures}。${refClause}整体要求：商品主体清晰、比例真实、光线自然、画面干净、适合电商发布；${draft.styleHint.trim()}`
}

/** Consistency prefix for slots generated after the main image exists. */
function withAnchorNote(prompt: string): string {
  return '商品套图一致性约束：附件是本套商品的主图，图中商品（外形、颜色、材质、Logo、包装文字）必须与附件完全一致，不得重新发明商品。' + prompt
}

/** Studio tabs: the two generation modes plus the gallery view. */
type PanelTab = GenerateMode | 'gallery'

/** Top-level workspaces inside the panel. 'normal' is the classic studio;
 *  more task-oriented modes (prototype, …) can join alongside 'ecommerce'. */
type PanelWorkspace = 'normal' | 'ecommerce'

type GalleryFilter = string
type ComparisonSession = { taskIds: string[]; prompt: string; comparisonId: string }
type HistoryGroup = { key: string; entries: HistoryEntry[]; models: string[] }

/** One image unit in the ecommerce results canvas: a live queue task or a
 *  restored history entry of the viewed product set. */
interface EcommerceResultItem {
  id: string
  label: string
  slotKey: string
  status: GenerationTaskStatus
  model: string
  prompt: string
  error?: string
  images: GeneratedImage[]
  /** The request to resubmit when regenerating this slot. */
  source: GenerateRequest
}

function modelsOfHistoryEntry(entry: HistoryEntry): string[] {
  return entry.comparisonModels?.length !== undefined && entry.comparisonModels.length > 1
    ? entry.comparisonModels
    : [entry.model]
}

/** Comparison runs collapse by comparisonId, product sets by projectId. */
function historyGroupKey(entry: HistoryEntry): string {
  if (entry.comparisonId !== undefined) return entry.comparisonId
  if (entry.workflow === 'ecommerce' && entry.projectId !== undefined) return `project:${entry.projectId}`
  return entry.id
}

/** Collapse the per-model history rows that belong to one comparison run. */
function groupHistoryEntries(entries: HistoryEntry[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()
  for (const entry of entries) {
    const key = historyGroupKey(entry)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { key, entries: [entry], models: modelsOfHistoryEntry(entry) })
    } else {
      existing.entries.push(entry)
      existing.models = [...new Set([...existing.models, ...modelsOfHistoryEntry(entry)])]
    }
  }
  return [...groups.values()]
}

function newComparisonId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `comparison-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Render the studio. */
export function ImageGenPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
  sessions?: ISessions
  conversation?: ConversationService
}) {
  const { api, scope, sessions, conversation } = props
  const config = useConfig(scope)
  // The plugin language follows the DSH interface (bridged from ctx.locale);
  // this tick re-renders the tree so every tt() switches live — the template
  // library and the inspiration wall render inside this tree.
  useImageGenLanguageTick()
  const enabled = config?.enabled ?? true
  // Channel-aware model options: the panel lists every configured alias
  // (default channel first); legacy flat fields remain the upgrade fallback.
  const modelOptions = imageModelOptions(config)
  const hasChannels = (config?.channels ?? []).length > 0
  // With channels configured, the model list is exactly the configured aliases
  // (possibly empty — never fall back to the hardcoded legacy defaults).
  const imageModels = hasChannels ? modelOptions.models : normalizeImageModels(config?.imageModels)
  const defaultChannelId = modelOptions.defaultChannelId
  const apiUrl = defaultChannelId !== undefined && (config?.channels ?? []).length > 0
    ? (config!.channels!.find(channel => channel.id === defaultChannelId)?.apiUrl ?? '')
    : (config?.apiUrl ?? '')
  const configured = apiUrl.trim() !== ''
  const legacyKeySet = useSecretSet(scope, 'apiKey')
  const promptKeySet = useSecretSet(scope, 'promptApiKey')
  const channelKeySet = (config?.channels ?? []).some(channel => scope.getSecretSetSnapshot(`channelSecrets.${channel.id}`))
  const apiKeySet = (config?.channels ?? []).length > 0 ? channelKeySet : legacyKeySet
  const connected = enabled && configured && apiKeySet

  const [tab, setTab] = useState<PanelTab>('text')
  const [workspace, setWorkspace] = useState<PanelWorkspace>('normal')
  /** Switch to a normal-generation tab, leaving any task workspace. */
  const openTab = (next: PanelTab): void => {
    setWorkspace('normal')
    setTab(next)
  }
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>('auto')
  const [quality, setQuality] = useState<string>('auto')
  const [count, setCount] = useState(1)
  const [detail, setDetail] = useState('')
  const [model, setModel] = useState<string>('')
  const [compareEnabled, setCompareEnabled] = useState(false)
  const [compareModels, setCompareModels] = useState<string[]>([])
  const [modelOpen, setModelOpen] = useState(false)
  const [refImage, setRefImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [addingToConversation, setAddingToConversation] = useState<number | string | null>(null)
  const [galleryConversationAddingId, setGalleryConversationAddingId] = useState<string | null>(null)
  const [historyConversationAddingId, setHistoryConversationAddingId] = useState<string | null>(null)
  const [conversationMessage, setConversationMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Submission is brief; actual generation stays visible until the host
  // queue reports that every queued/running task has finished.
  const [submitting, setSubmitting] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [configGuide, setConfigGuide] = useState<'generation' | 'enhancement' | 'disabled' | null>(null)
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
  const tasksRef = useRef<GenerationTask[]>([])
  const [taskTrayOpen, setTaskTrayOpen] = useState(false)
  const [comparison, setComparison] = useState<ComparisonSession | null>(null)
  const [comparisonFullscreen, setComparisonFullscreen] = useState(false)
  const [ecommerce, setEcommerce] = useState<ProductSetDraft>(() => {
    try {
      const saved = window.localStorage.getItem(ECOMMERCE_DRAFT_STORAGE_KEY)
      if (saved !== null) {
        const merged: ProductSetDraft = { ...defaultEcommerceDraft(), ...JSON.parse(saved) as Partial<ProductSetDraft> }
        // Drafts saved before reference roles existed keep working: every slot
        // defaults to following the product image.
        if (Array.isArray(merged.slots)) {
          merged.slots = merged.slots.map(slot => ({ ...slot, refRole: slot.refRole ?? 'product' }))
        }
        return merged
      }
    } catch { /* ignore malformed or unavailable storage */ }
    return defaultEcommerceDraft()
  })
  const [ecommercePreview, setEcommercePreview] = useState(false)
  const [ecommerceGenerating, setEcommerceGenerating] = useState(false)
  const [ecommerceProjectId, setEcommerceProjectId] = useState<string | null>(null)
  const [ecommerceAssets, setEcommerceAssets] = useState<ProductAsset[]>([])
  /** History-restored product set currently shown in the results canvas. */
  const [ecommerceRestored, setEcommerceRestored] = useState<{ projectId: string; projectName: string; items: EcommerceResultItem[] } | null>(null)
  /** Pending main-image anchor: the main image task is in flight; once it
   *  completes, the remaining slots are resubmitted with it as their shared
   *  reference so every image in the set shows the same product. */
  const [ecommerceAnchor, setEcommerceAnchor] = useState<{ projectId: string; mainTaskIds: string[]; remaining: GenerateRequest[] } | null>(null)
  const [ecommerceRefOpen, setEcommerceRefOpen] = useState(false)
  const [configCollapsed, setConfigCollapsed] = useState(readConfigCollapsed)
  const [chatOpen, setChatOpen] = useState(readChatOpen)
  const [configWidth, setConfigWidth] = useState(readConfigWidth)
  const configAsideRef = useRef<HTMLElement>(null)
  const currentSessionId = useCurrentSessionId(sessions)
  const sidebarHistoryHost = useSidebarHistoryHost()
  const modeModels = tab === 'edit'
    ? imageModels.filter(candidate => describeModel(candidate).supportsEdit)
    : imageModels
  const fileInput = useRef<HTMLInputElement>(null)
  const previewStage = useRef<HTMLDivElement>(null)
  const activeTasks = tasks.filter(task => task.status === 'queued' || task.status === 'running')
  const activeTask = activeTasks.find(task => task.status === 'running') ?? activeTasks[0]
  const generating = submitting || activeTasks.length > 0
  const generationStartedAt = activeTask?.startedAt ?? activeTask?.createdAt ?? null
  const elapsed = useElapsed(generating, generationStartedAt)

  useEffect(() => {
    try { window.localStorage.setItem(ECOMMERCE_DRAFT_STORAGE_KEY, JSON.stringify(ecommerce)) } catch { /* optional draft persistence */ }
  }, [ecommerce])

  useEffect(() => {
    try {
      window.localStorage.setItem(CONFIG_COLLAPSED_STORAGE_KEY, String(configCollapsed))
    } catch {
      // Embedded shells may disable local storage; the in-memory toggle still works.
    }
  }, [configCollapsed])

  // Chat-pane visibility rides a document-level attribute so the center-column
  // grid can drop the conversation entirely. Collapsed by default.
  useEffect(() => {
    if (chatOpen) delete document.documentElement.dataset.dshImagegenChatCollapsed
    else document.documentElement.dataset.dshImagegenChatCollapsed = '1'
    try { window.localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, chatOpen ? 'open' : 'collapsed') } catch { /* optional */ }
  }, [chatOpen])

  useEffect(() => () => { delete document.documentElement.dataset.dshImagegenChatCollapsed }, [])

  // Main-image anchor chain: when the main image task of a product set
  // completes, resubmit the remaining slots with the generated main image as
  // their shared reference. Cleared up front so a re-render cannot double-
  // submit; failures surface as a canvas error.
  useEffect(() => {
    if (ecommerceAnchor === null) return
    const anchor = ecommerceAnchor
    const mains = tasks.filter(task => anchor.mainTaskIds.includes(task.id))
    if (mains.length === 0) return
    if (mains.every(task => task.status === 'failed' || task.status === 'cancelled')) {
      setEcommerceAnchor(null)
      setError(tt('ecommerce.anchorFailed'))
      return
    }
    const done = mains.find(task => task.status === 'completed' && task.result !== undefined && task.result.images.length > 0)
    if (done === undefined) return
    setEcommerceAnchor(null)
    const dataUrl = srcOf(done.result!.images[0]!)
    const requests = anchor.remaining.map(request => ({
      ...request,
      mode: 'edit' as const,
      image: dataUrl,
      refName: 'set-main-anchor',
      prompt: withAnchorNote(request.prompt),
    }))
    void Promise.all(requests.map(request => api.taskSubmit(request)))
      .then(submitted => { setTasks(previous => [...submitted, ...previous]) })
      .catch(caught => { setError(errorMessage(caught)) })
  }, [api, tasks, ecommerceAnchor])


  // A saved settings change is authoritative. Keep the active selection and
  // comparison choices in that allow-list without disturbing valid choices.
  const imageModelKey = modeModels.join('\u0000')
  useEffect(() => {
    setModel(previous => modeModels.includes(previous) ? previous : modeModels[0] ?? '')
    setCompareModels(previous => {
      const retained = previous.filter(candidate => modeModels.includes(candidate))
      return retained.length > 0 ? retained : modeModels[0] === undefined ? [] : [modeModels[0]]
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

  const filteredHistory = groupHistoryEntries(history).filter(group => group.entries.some(entry => {
    const query = historyQuery.trim().toLocaleLowerCase()
    const models = modelsOfHistoryEntry(entry)
    return (query === '' || `${entry.prompt} ${models.join(' ')}`.toLocaleLowerCase().includes(query))
      && (historyModelFilter === 'all' || models.includes(historyModelFilter))
      && (historyRatioFilter === 'all' || normalizeSize(entry.size) === historyRatioFilter)
  }))

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

  // Chat toolviews publish durable refs after they finish loading. Decode the
  // refs through the same host-authorized route and make them the current
  // canvas result for the selected session.
  useEffect(() => {
    const onChatImages = (event: Event): void => {
      const detail = (event as CustomEvent<ChatImageEventDetail>).detail
      if (detail === undefined || currentSessionId === undefined || detail.sessionId !== currentSessionId) return
      void Promise.all(detail.refs.map(attachmentToGenerated))
        .then(next => {
          openTab('text')
          setImages(next)
          setComparison(null)
          setViewingHistoryId(null)
          setGalleryViewingId(null)
          setError(null)
        })
        .catch(caught => { setError(errorMessage(caught)) })
    }
    document.addEventListener(CHAT_IMAGE_EVENT, onChatImages)
    return () => document.removeEventListener(CHAT_IMAGE_EVENT, onChatImages)
  }, [currentSessionId])

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void api.taskList().then(next => {
        if (disposed) return
        const newlyCompleted = next.filter(task => task.status === 'completed'
          && task.result !== undefined
          && !tasksRef.current.some(old => old.id === task.id && old.status === 'completed'))
        tasksRef.current = next
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
        if (newlyCompleted.length > 0) {
          void api.historyList().then(entries => {
            if (!disposed) setHistory(entries)
          }).catch(() => {})
        }
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

  /** Read uploaded product assets into session-only data-URL chips, capped at
   *  MAX_ECOMMERCE_ASSETS. Each starts as the product-role reference. */
  const acceptEcommerceFiles = (files: FileList | undefined): void => {
    if (files === undefined) return
    const incoming = Array.from(files).filter(file => file.type.startsWith('image/') && file.size <= REF_IMAGE_MAX_BYTES)
    if (incoming.length === 0) {
      setError(tt('edit.uploadHint'))
      return
    }
    for (const file of incoming) {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') return
        const dataUrl = reader.result
        setEcommerceAssets(previous => {
          if (previous.length >= MAX_ECOMMERCE_ASSETS) {
            setError(tt('ecommerce.assetsFull'))
            return previous
          }
          return [...previous, { id: newComparisonId(), dataUrl, name: file.name, role: 'product' }]
        })
      }
      reader.onerror = () => { setError(tt('edit.uploadHint')) }
      reader.readAsDataURL(file)
    }
  }

  /** Run one generation. */
  const handleGenerate = async (): Promise<void> => {
    if (submitting) return
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
      mode: tab === 'edit' ? 'edit' : 'text',
      model: modeModels.includes(model) ? model : modeModels[0] ?? '',
      prompt: promptText,
      size,
      quality,
      n: count,
      detail,
      ...defaultChannelId !== undefined ? { channelId: defaultChannelId } : {},
      ...tab === 'edit' && refImage !== null ? { image: refImage.dataUrl } : {},
      ...tab === 'edit' && refImage !== null ? { refName: refImage.name } : {},
    }
    setError(null)
    setSubmitting(true)
    try {
      const targetModels = (compareEnabled ? compareModels : [request.model]).filter(candidate => modeModels.includes(candidate))
      if (targetModels.length === 0) {
        setError(tt('compare.selectRequired'))
        return
      }
      const comparisonId = targetModels.length > 1 ? newComparisonId() : undefined
      const comparisonFields = comparisonId === undefined ? {} : { comparisonId, comparisonModels: targetModels }
      const submitted = await Promise.all(targetModels.map(targetModel => api.taskSubmit({ ...request, model: targetModel, ...comparisonFields })))
      setTasks(previous => [...submitted, ...previous.filter(item => !submitted.some(task => task.id === item.id))])
      setComparison(comparisonId === undefined ? null : { taskIds: submitted.map(task => task.id), prompt: promptText, comparisonId })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  const handleEcommerceGenerate = async (): Promise<void> => {
    if (ecommerceGenerateDisabled) return
    if (!enabled || !configured || !apiKeySet) { openSettingsGuide('generation'); return }
    const projectId = ecommerce.projectId || newComparisonId()
    const buildRequest = (slot: ProductSetSlot, index: number): GenerateRequest => {
      // Each slot picks one reference by asset role; a slot without a matching
      // asset (or 'none') falls back to text-to-image.
      const refRole = slot.refRole ?? 'product'
      const asset = refRole === 'none' ? undefined : ecommerceAssets.find(item => item.role === refRole)
      return {
        mode: asset !== undefined ? 'edit' as const : 'text' as const,
        model: modeModels.includes(model) ? model : modeModels[0] ?? '',
        prompt: ecommercePrompt(ecommerce, slot),
        size: ecommerce.size,
        quality,
        n: 1,
        detail,
        ...(defaultChannelId !== undefined ? { channelId: defaultChannelId } : {}),
        ...(asset !== undefined ? { image: asset.dataUrl, refName: asset.name } : {}),
        workflow: 'ecommerce' as const,
        projectId,
        projectName: ecommerce.productName.trim(),
        slotKey: `${slot.key}-${index + 1}`,
        slotLabel: slot.label,
      }
    }
    // Anchor chain: with a main-image slot enabled, only the main image is
    // submitted now; the remaining slots follow once it completes (see the
    // anchor effect) so the whole set shares one product. Without a main
    // slot, every slot submits immediately with its own reference.
    const mainSlots = ecommerceSlots.filter(slot => slot.key === 'main')
    const otherSlots = ecommerceSlots.filter(slot => slot.key !== 'main')
    const anchorChain = mainSlots.length > 0 && otherSlots.length > 0
    const leadSlots = anchorChain ? mainSlots : ecommerceSlots
    const requests = leadSlots.flatMap(slot => Array.from({ length: slot.count }, (_, index) => buildRequest(slot, index)))
    const remaining = anchorChain
      ? otherSlots.flatMap(slot => Array.from({ length: slot.count }, (_, index) => {
        const { image: _image, refName: _refName, ...rest } = buildRequest(slot, index)
        return rest
      }))
      : []
    setEcommerceGenerating(true); setSubmitting(true); setError(null); setEcommerceProjectId(projectId); setEcommerceRestored(null); setEcommerceAnchor(null)
    try {
      const submitted = await Promise.all(requests.map(request => api.taskSubmit(request)))
      setTasks(previous => [...submitted, ...previous])
      setEcommercePreview(false)
      if (anchorChain) setEcommerceAnchor({ projectId, mainTaskIds: submitted.map(task => task.id), remaining })
    } catch (caught) { setError(errorMessage(caught)) } finally { setSubmitting(false); setEcommerceGenerating(false) }
  }

  /** Start over with a fresh product draft (the old results stay in history). */
  const newEcommerceProduct = (): void => {
    setEcommerce(defaultEcommerceDraft())
    setEcommercePreview(false)
    setEcommerceProjectId(null)
    setEcommerceRestored(null)
    setEcommerceAnchor(null)
    setEcommerceAssets([])
    setRefImage(null)
    setError(null)
  }

  /** Re-run every image of one slot with its original request. */
  const regenerateEcommerceSlot = async (label: string): Promise<void> => {
    if (ecommerceGenerating) return
    const group = ecommerceMergedItems.filter(item => item.label === label)
    if (group.length === 0) return
    setEcommerceGenerating(true)
    setError(null)
    try {
      const submitted = await Promise.all(group.map(item => api.taskSubmit({ ...item.source })))
      setTasks(previous => [...submitted, ...previous])
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setEcommerceGenerating(false)
    }
  }

  /** Open one persisted product set from history: rebuild the grouped results
   *  canvas from its entries. Reference images are not persisted, so restored
   *  edit-mode slots regenerate as text-to-image. */
  const viewEcommerceProject = async (group: HistoryGroup): Promise<void> => {
    const entry = group.entries[0]
    if (entry === undefined || entry.projectId === undefined) return
    try {
      const items: EcommerceResultItem[] = await Promise.all(group.entries.map(async item => ({
        id: item.id,
        label: item.slotLabel ?? '',
        slotKey: item.slotKey ?? '',
        status: 'completed' as const,
        model: item.model,
        prompt: item.prompt,
        images: await historyImagesToGenerated(item.images),
        source: {
          mode: item.mode === 'edit' ? 'text' as const : item.mode,
          model: item.model,
          prompt: item.prompt,
          size: item.size,
          quality: item.quality,
          detail: item.detail,
          n: 1,
          ...item.channelId !== undefined ? { channelId: item.channelId } : {},
          workflow: 'ecommerce' as const,
          projectId: entry.projectId!,
          projectName: entry.projectName ?? '',
          slotKey: item.slotKey ?? '',
          slotLabel: item.slotLabel ?? '',
        },
      })))
      setWorkspace('ecommerce')
      setEcommerceRestored({ projectId: entry.projectId, projectName: entry.projectName ?? '', items })
      setEcommerceProjectId(entry.projectId)
      setEcommercePreview(false)
      setError(null)
      setViewingHistoryId(entry.id)
      setGalleryViewingId(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Download a JSON manifest describing the whole product set (prompts,
   *  slots and task outcomes) so results stay reproducible outside the panel. */
  const exportEcommerceManifest = (): void => {
    const manifest = {
      project: {
        id: ecommerceProjectId,
        name: ecommerce.projectName || ecommerce.productName,
        productName: ecommerce.productName,
        category: ecommerce.category,
        platform: ecommerce.platform,
        language: ecommerce.language,
        size: ecommerce.size,
        sellingPoints: ecommerce.sellingPoints,
        protectedFeatures: ecommerce.protectedFeatures,
        styleHint: ecommerce.styleHint,
      },
      generatedAt: new Date().toISOString(),
      images: ecommerceMergedItems.map(item => ({
        slotKey: item.slotKey,
        slotLabel: item.label,
        status: item.status,
        model: item.model,
        prompt: item.prompt,
        error: item.error,
      })),
    }
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `dsh-product-set-${(ecommerce.projectName || ecommerce.productName || 'set').replace(/[^\w-]+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

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

  const loadHistoryGroup = async (group: HistoryGroup): Promise<GeneratedImage[]> => {
    const loaded = await Promise.all(group.entries.map(entry => historyImagesToGenerated(entry.images)))
    return loaded.flat()
  }

  /** View every model result from one comparison as one canvas result set. */
  const viewHistoryGroup = async (group: HistoryGroup): Promise<void> => {
    const entry = group.entries[0]
    if (entry === undefined) return
    // Product sets rebuild their grouped results canvas instead of the
    // generic image workspace.
    if (entry.workflow === 'ecommerce' && entry.projectId !== undefined) {
      await viewEcommerceProject(group)
      return
    }
    // History is also the bridge out of the gallery: show the image workspace
    // immediately, then hydrate the selected result into its canvas.
    openTab('text')
    try {
      setImages(await loadHistoryGroup(group))
      setComparison(null)
      setError(null)
      setViewingHistoryId(entry.id)
      setGalleryViewingId(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove every persisted row belonging to one comparison group. */
  const deleteHistoryGroup = async (group: HistoryGroup): Promise<void> => {
    const ids = new Set(group.entries.map(entry => entry.id))
    setHistory(previous => previous.filter(entry => !ids.has(entry.id)))
    if (viewingHistoryId !== null && ids.has(viewingHistoryId)) setViewingHistoryId(null)
    if (ecommerceRestored !== null && group.entries.some(entry => entry.projectId === ecommerceRestored.projectId)) {
      setEcommerceRestored(null)
      setEcommerceProjectId(null)
      setEcommerceAnchor(null)
    }
    try {
      let next = history
      for (const id of ids) next = await api.historyRemove(id)
      setHistory(next)
    } catch {
      // Keep the optimistic local removal.
    }
  }

  /** Reset the workspace for a fresh image-generation run. */
  const startNewCreation = (): void => {
    openTab('text')
    setPrompt('')
    setRefImage(null)
    setImages([])
    setPreview(null)
    setPreviewScale(1)
    setPromptCopied(false)
    setViewingHistoryId(null)
    setGalleryViewingId(null)
    setGallerySelecting(false)
    setSelectedGalleryIds(new Set())
    setComparison(null)
    setComparisonFullscreen(false)
    setEcommerceRestored(null)
    setError(null)
    setConversationMessage(null)
    setGalleryMessage(null)
  }

  /** Remove all history entries. */
  const clearHistory = async (): Promise<void> => {
    if (!window.confirm(tt('history.clearConfirm'))) return
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
    if (galleryAdding || (workspace === 'normal' && tab === 'gallery')) return
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

  /** Put a generated image into the native conversation composer. */
  const addImageToConversation = async (image: GeneratedImage, index: number, actionKey: number | string = index): Promise<void> => {
    if (addingToConversation !== null) return
    if (conversation === undefined || sessions === undefined || currentSessionId === undefined) {
      setError(tt('conversation.noSession'))
      return
    }
    const sessionScope = sessions.scope(currentSessionId)
    if (sessionScope === undefined) {
      setError(tt('conversation.unavailable'))
      return
    }
    setAddingToConversation(actionKey)
    let attachments: ReturnType<ConversationService['createDraftImages']> = []
    let added = false
    try {
      const prepared = await prepareConversationImage(image, index)
      const file = prepared.file
      attachments = conversation.createDraftImages([file])
      const input = conversation.input.for(sessionScope)
      if (!input.addImages(attachments.map(attachment => attachment.id))) {
        throw new Error(tt('conversation.busy'))
      }
      added = true
      try {
        await api.attachConversationImage(String(currentSessionId), prepared.dataUrl, file.name)
      } catch (caught) {
        for (const attachment of attachments) input.removeImage(attachment.id)
        added = false
        throw caught
      }
      if (input.state.getSnapshot().draft.trim() === '' && prompt.trim() !== '') input.setDraft(prompt.trim())
      setConversationMessage(tt('conversation.added'))
      window.setTimeout(() => { setConversationMessage(null) }, 2200)
    } catch (caught) {
      if (!added) conversation.releaseDraftImages(attachments)
      setError(errorMessage(caught))
    } finally {
      setAddingToConversation(null)
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

  /** Add one history entry's first image to the current chat draft. */
  const addHistoryEntryToConversation = async (entry: HistoryEntry): Promise<void> => {
    if (historyConversationAddingId !== null || addingToConversation !== null || galleryConversationAddingId !== null || entry.images.length === 0) return
    setHistoryConversationAddingId(entry.id)
    try {
      const [image] = await historyImagesToGenerated(entry.images.slice(0, 1))
      if (image === undefined) return
      await addImageToConversation(image, 0, `history:${entry.id}`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setHistoryConversationAddingId(null)
    }
  }

  /** Load a persisted gallery image and add it to the current chat draft. */
  const addGalleryEntryToConversation = async (entry: HistoryEntry): Promise<void> => {
    if (galleryConversationAddingId !== null || addingToConversation !== null || entry.images.length === 0) return
    setGalleryConversationAddingId(entry.id)
    try {
      const [image] = await historyImagesToGenerated(entry.images.slice(0, 1))
      if (image === undefined) return
      await addImageToConversation(image, 0, `gallery:${entry.id}`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setGalleryConversationAddingId(null)
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
    if (!window.confirm(tt('gallery.clearConfirm'))) return
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

  const generateDisabled = submitting || modeModels.length === 0
  const ecommerceSlots = ecommerce.slots.filter(slot => slot.enabled && slot.count > 0)
  const ecommerceTotal = ecommerceSlots.reduce((total, slot) => total + slot.count, 0)
  const ecommerceGenerateDisabled = submitting || ecommerceGenerating || ecommerceSlots.length === 0 || ecommerce.productName.trim() === '' || (ecommerce.language === 'custom' && effectiveEcommerceLanguage(ecommerce) === '')
  const ecommerceFileInput = useRef<HTMLInputElement>(null)
  // The results canvas merges live tasks of the active project with restored
  // history entries of the same project; restored slots that were regenerated
  // this session are covered by their live counterparts (same slotKey).
  const ecommerceProjectTasks = ecommerceProjectId === null
    ? []
    : tasks.filter(task => task.request.workflow === 'ecommerce' && task.request.projectId === ecommerceProjectId)
  const liveSlotKeys = new Set(ecommerceProjectTasks.map(task => task.request.slotKey ?? task.id))
  const ecommerceMergedItems: EcommerceResultItem[] = [
    ...ecommerceProjectTasks.map(task => ({
      id: task.id,
      label: task.request.slotLabel ?? '',
      slotKey: task.request.slotKey ?? '',
      status: task.status,
      model: task.request.model,
      prompt: task.request.prompt,
      ...task.error !== undefined ? { error: task.error } : {},
      images: task.result?.images ?? [],
      source: task.request,
    })),
    ...(ecommerceRestored !== null && ecommerceRestored.projectId === ecommerceProjectId
      ? ecommerceRestored.items.filter(item => !liveSlotKeys.has(item.slotKey))
      : []),
  ]
  const ecommerceDoneCount = ecommerceMergedItems.filter(item => item.status === 'completed').length
  const ecommerceFailedCount = ecommerceMergedItems.filter(item => item.status === 'failed' || item.status === 'cancelled').length
  const ecommerceResultGroups = [...new Set(ecommerceMergedItems.map(item => item.label))]
    .filter(label => label !== '')
    .map(label => ({ label, items: ecommerceMergedItems.filter(item => item.label === label) }))
  const conversationBusy = addingToConversation !== null || galleryConversationAddingId !== null || historyConversationAddingId !== null
  const viewingEntry = viewingHistoryId === null ? null : history.find(entry => entry.id === viewingHistoryId) ?? null
  const viewingGalleryEntry = galleryViewingId === null ? null : gallery.find(entry => entry.id === galleryViewingId) ?? null
  const previewImage = preview === null ? null : preview.images[preview.index] ?? null
  const comparisonTasks = comparison === null ? [] : comparison.taskIds.map(id => tasks.find(task => task.id === id)).filter((task): task is GenerationTask => task !== undefined)
  const comparisonResults = comparisonTasks.filter(task => task.status === 'completed' && task.result !== undefined)
  const previewFrameScale = Math.max(1, previewScale)
  const previewImageScale = previewScale / previewFrameScale

  /** Drag the config panel's right edge to resize it (persisted per browser). */
  const onConfigResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const aside = configAsideRef.current
    if (aside === null) return
    const left = aside.getBoundingClientRect().left
    const onMove = (move: PointerEvent): void => {
      const width = Math.round(Math.min(CONFIG_WIDTH_MAX, Math.max(CONFIG_WIDTH_MIN, move.clientX - left)))
      setConfigWidth(width)
      try { window.localStorage.setItem(CONFIG_WIDTH_STORAGE_KEY, String(width)) } catch { /* optional */ }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.style.removeProperty('cursor')
      document.documentElement.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    document.documentElement.style.setProperty('cursor', 'col-resize')
    document.documentElement.style.setProperty('user-select', 'none')
  }

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
    openTab('edit')
    setRefImage({
      dataUrl: srcOf(previewImage),
      name: `dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`,
    })
    if (prompt.trim() === '' && previewImage.revisedPrompt !== undefined) setPrompt(previewImage.revisedPrompt)
    setError(null)
    closePreview()
  }

  // Render history into the shell sidebar so it remains a separate navigation
  // surface from both the image workspace and the native conversation.
  const historyPanel = (
    <aside className={css.history} data-dsh-imagegen-history>
      <header className={css.historyHeader}>
        <span className={css.historyTitle}>{tt('history.title')}</span>
        <div className={css.historyHeaderActions}>
          <button
            type="button"
            className={css.historyNew}
            data-history-new=""
            aria-label={tt('canvas.new')}
            title={tt('canvas.newHint')}
            onClick={startNewCreation}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
          </button>
          <button
            type="button"
            className={css.historyNew}
            data-history-open-folder=""
            aria-label={tt('gallery.openFolder')}
            title={tt('gallery.openFolderHint')}
            onClick={() => { void api.openDataFolder() }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h2.9l1.6 1.9h6.1A1.2 1.2 0 0 1 14.5 6.1v6.2a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" /></svg>
          </button>
          {history.length > 0 ? (
            <button type="button" className={css.historyClear} data-history-clear="" onClick={() => { void clearHistory() }}>
              {tt('history.clear')}
            </button>
          ) : null}
        </div>
      </header>

      <div className={css.historyFilters}>
        <input className={css.historySearch} value={historyQuery} onChange={event => { setHistoryQuery(event.target.value) }} placeholder={tt('history.search')} aria-label={tt('history.search')} />
        <select value={historyModelFilter} onChange={event => { setHistoryModelFilter(event.target.value) }} aria-label={tt('history.model')}>
          <option value="all">{tt('history.allModels')}</option>
          {[...new Set(history.flatMap(entry => modelsOfHistoryEntry(entry)))].map(option => <option key={option} value={option}>{option}</option>)}
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
          {filteredHistory.map(group => {
            const entry = group.entries[0]!
            const isComparison = group.models.length > 1
            const imageCount = group.entries.reduce((total, item) => total + item.images.length, 0)
            return (
              <div
                key={group.key}
                className={css.historyItem}
                data-active={group.entries.some(item => item.id === viewingHistoryId) ? '' : undefined}
                data-comparison={isComparison ? '' : undefined}
              >
                <button
                  type="button"
                  className={css.historyMain}
                  data-dsh-imagegen-history-main=""
                  onClick={() => { void viewHistoryGroup(group) }}
                >
                  {entry.images.length > 0 ? (
                    <img className={css.historyThumb} src={entry.images[0]!.url} alt="" />
                  ) : (
                    <span className={css.historyThumbPlaceholder} />
                  )}
                  <span className={css.historyInfo}>
                    <span className={css.historyPrompt}>{entry.prompt}</span>
                    <span className={css.historyMeta}>
                      {isComparison
                        ? tt('compare.title')
                        : entry.workflow === 'ecommerce'
                          ? `${tt('ecommerce.short')}${entry.projectName !== undefined && entry.projectName !== '' ? ` · ${entry.projectName}` : ''}`
                          : tt(`mode.${entry.mode === 'edit' ? 'edit' : 'text'}` as const)}
                      {' · '}{isComparison ? group.models.join(' · ') : entry.model}
                      {' · '}{formatTime(entry.createdAt)}
                      {' · '}{imageCount} {tt('history.images')}
                    </span>
                  </span>
                </button>
                <span className={css.historyActions}>
                  {entry.images.length > 0 ? (
                    <button
                      type="button"
                      className={css.historyIconAction}
                      disabled={conversationBusy}
                      title={`${tt('conversation.add')}：${tt('conversation.addHint')}`}
                      aria-label={tt('conversation.add')}
                      data-history-add-conversation=""
                      onClick={() => { void addHistoryEntryToConversation(entry) }}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v5a1.5 1.5 0 0 1-1.5 1.5H8.5L5.5 13v-2.5H4A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5z" /></svg>
                    </button>
                  ) : null}
                  {entry.images.length > 0 ? (
                    <button
                      type="button"
                      className={css.historyIconAction}
                      disabled={galleryAdding}
                      title={tt('gallery.add')}
                      aria-label={tt('gallery.add')}
                      data-history-add-gallery=""
                      onClick={() => { void addHistoryEntryToGallery(entry) }}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="5.9" cy="6.1" r="1" /><path d="M13.5 10.2l-3.1-3.1L4.6 13" /></svg>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={css.historyIconAction}
                    data-danger
                    title={tt('history.delete')}
                    aria-label={tt('history.delete')}
                    onClick={() => { void deleteHistoryGroup(group) }}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4.5h11" /><path d="M6 4.5V3.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3" /><path d="M4.3 4.5l.6 8.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.1" /><path d="M6.7 7v4M9.3 7v4" /></svg>
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )

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
        <nav className={css.topNav} role="tablist" aria-label={tt('workspace.label')}>
          <button type="button" className={css.topNavItem} data-active={workspace === 'normal' && tab !== 'gallery' ? '' : undefined} onClick={() => { if (workspace !== 'normal' || tab === 'gallery') openTab('text') }}>{tt('workspace.normal')}</button>
          <button type="button" className={css.topNavItem} data-active={workspace === 'normal' && tab === 'gallery' ? '' : undefined} onClick={() => { openTab('gallery') }}>{tt('gallery.title')}</button>
          <span className={css.topNavDivider} aria-hidden="true" />
          <button type="button" className={css.topNavItem} data-active={workspace === 'ecommerce' ? '' : undefined} onClick={() => { setWorkspace('ecommerce') }}>{tt('workspace.ecommerce')}<span className={css.previewBadge}>{tt('ecommerce.badge')}</span></button>
        </nav>
        <span className={css.panelHeaderActions}>
          <button
            type="button"
            className={css.chatToggle}
            data-open={chatOpen ? 'true' : 'false'}
            aria-pressed={chatOpen}
            title={chatOpen ? tt('chat.collapse') : tt('chat.expand')}
            onClick={() => { setChatOpen(open => !open) }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H6.8L3.8 13.6v-2.6H2.5z"/></svg>
            {tt('chat.toggle')}
          </button>
          <button
            type="button"
            className={css.connectionStatus}
            data-connected={connected ? 'true' : 'false'}
            aria-label={tt(connected ? 'connection.connected' : 'connection.disconnected')}
          >
            <span className={css.connectionDot} aria-hidden="true" />
            {tt(connected ? 'connection.connected' : 'connection.disconnected')}
          </button>
        </span>
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
        {/* ------------------------------- left history + generation workspace */}
        <div className={css.generation}>
          {/* ------------------------------------------------ config sidebar */}
          <aside
            ref={configAsideRef}
            className={css.config}
            style={{ '--dsh-imagegen-config-width': `${configWidth}px` } as CSSProperties}
            data-collapsed={configCollapsed ? 'true' : 'false'}
            data-gallery={workspace === 'normal' && tab === 'gallery' ? 'true' : undefined}
          >
            <div className={css.configResizer} title={tt('config.resizeHint')} onPointerDown={onConfigResizeStart} />
          <div className={css.configHeader}>
            <button
              type="button"
              className={css.configToggle}
              aria-expanded={!configCollapsed}
              aria-label={tt(configCollapsed ? 'panel.expandConfig' : 'panel.collapseConfig')}
              title={tt(configCollapsed ? 'panel.expandConfig' : 'panel.collapseConfig')}
              onClick={() => { setConfigCollapsed(previous => !previous) }}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={configCollapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'} />
              </svg>
            </button>
          </div>
          {workspace === 'normal' && tab === 'gallery' ? (
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
            {/* generation sub-modes live inside the normal workspace */}
            {workspace === 'normal' && tab !== 'gallery' ? (
              <section className={css.card}>
                <div className={css.modeRow} role="tablist" aria-label={tt('panel.title')}>
                  <Pill active={tab === 'text'} onClick={() => { setTab('text') }} className={css.modePill}>{tt('mode.text')}</Pill>
                  <Pill active={tab === 'edit'} onClick={() => { setTab('edit') }} className={css.modePill}>{tt('mode.edit')}</Pill>
                </div>
              </section>
            ) : null}

            {workspace === 'ecommerce' ? (
              <section className={css.ecommerceWorkspace} data-ecommerce-workspace="">
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.product')}</h3>
                  <label className={css.ecommerceField}>
                    <span className={css.ecommerceFieldLabel}>{tt('ecommerce.productName')}</span>
                    <input value={ecommerce.productName} placeholder={tt('ecommerce.productName')} onChange={event => setEcommerce(previous => ({ ...previous, productName: event.target.value }))} />
                  </label>
                  {ecommerceAssets.length === 0 ? (
                    <button
                      type="button"
                      className={css.ecommerceUploadHero}
                      data-ecommerce-upload=""
                      onClick={() => { ecommerceFileInput.current?.click() }}
                      onDragOver={(event) => { event.preventDefault() }}
                      onDrop={(event) => {
                        event.preventDefault()
                        acceptEcommerceFiles(event.dataTransfer.files ?? undefined)
                      }}
                    >
                      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10V3.5"/><path d="M5.5 5.5L8 3l2.5 2.5"/><path d="M3 9.5V12a1.5 1.5 0 001.5 1.5h7A1.5 1.5 0 0013 12V9.5"/></svg>
                      <span>{tt('ecommerce.uploadRef')}</span>
                      <small>{tt('edit.uploadHint')}</small>
                    </button>
                  ) : (
                    <div className={css.ecommerceAssets}>
                      {ecommerceAssets.map(asset => (
                        <div key={asset.id} className={css.ecommerceAsset} data-ecommerce-asset="">
                          <img src={asset.dataUrl} alt={asset.name} />
                          <select
                            value={asset.role}
                            data-ecommerce-asset-role=""
                            aria-label={tt('ecommerce.refSelect')}
                            onChange={event => setEcommerceAssets(previous => previous.map(item => item.id === asset.id ? { ...item, role: event.target.value as EcommerceAssetRole } : item))}
                          >
                            {ECOMMERCE_ASSET_ROLES.map(role => (
                              <option key={role} value={role}>{tt(`ecommerce.role.${role}` as never)}</option>
                            ))}
                          </select>
                          <button type="button" aria-label={tt('edit.remove')} onClick={() => { setEcommerceAssets(previous => previous.filter(item => item.id !== asset.id)) }}>×</button>
                        </div>
                      ))}
                      {ecommerceAssets.length < MAX_ECOMMERCE_ASSETS ? (
                        <button
                          type="button"
                          className={css.ecommerceAssetAdd}
                          data-ecommerce-upload=""
                          title={tt('ecommerce.uploadRef')}
                          onClick={() => { ecommerceFileInput.current?.click() }}
                          onDragOver={(event) => { event.preventDefault() }}
                          onDrop={(event) => {
                            event.preventDefault()
                            acceptEcommerceFiles(event.dataTransfer.files ?? undefined)
                          }}
                        >
                          <span aria-hidden="true">＋</span>
                          <small>{tt('ecommerce.uploadShort')}</small>
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.params')}</h3>
                  <div className={css.ecommerceParamGrid}>
                    <label className={css.ecommerceField}>
                      <span className={css.ecommerceFieldLabel}>{tt('ecommerce.platformLabel')}</span>
                      <select value={ecommerce.platform} onChange={event => setEcommerce(previous => ({ ...previous, platform: event.target.value }))}><option>通用</option><option>淘宝 / 京东</option><option>Amazon</option></select>
                    </label>
                    <label className={css.ecommerceField}>
                      <span className={css.ecommerceFieldLabel}>{tt('ecommerce.languageLabel')}</span>
                      <select aria-label={tt('ecommerce.languageLabel')} value={ecommerce.language} onChange={event => setEcommerce(previous => ({ ...previous, language: event.target.value }))}>
                        {ECOMMERCE_COPY_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{value === 'custom' ? tt('ecommerce.customLanguageOption') : label}</option>)}
                      </select>
                      {ecommerce.language === 'custom' ? (
                        <input
                          value={ecommerce.customLanguage ?? ''}
                          maxLength={40}
                          placeholder={tt('ecommerce.customLanguagePlaceholder')}
                          aria-label={tt('ecommerce.customLanguageLabel')}
                          onChange={event => setEcommerce(previous => ({ ...previous, customLanguage: event.target.value }))}
                        />
                      ) : null}
                    </label>
                    <label className={css.ecommerceField}>
                      <span className={css.ecommerceFieldLabel}>{tt('ecommerce.ratioLabel')}</span>
                      <select value={ecommerce.size} onChange={event => setEcommerce(previous => ({ ...previous, size: event.target.value }))}>{SIZES.filter(size => size !== 'auto').map(size => <option key={size}>{size}</option>)}</select>
                    </label>
                    <label className={css.ecommerceField}>
                      <span className={css.ecommerceFieldLabel}>{tt('ecommerce.categoryLabel')}</span>
                      <select value={ecommerce.category} onChange={event => setEcommerce(previous => ({ ...previous, category: event.target.value }))}><option>通用商品</option><option>食品饮料</option><option>美妆个护</option><option>服装配饰</option><option>家居用品</option><option>3C 数码</option></select>
                    </label>
                  </div>
                </div>
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.sellingTitle')}</h3>
                  <textarea value={ecommerce.sellingPoints} placeholder={tt('ecommerce.sellingPoints')} onChange={event => setEcommerce(previous => ({ ...previous, sellingPoints: event.target.value }))} />
                </div>
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.setStructure')}<small className={css.ecommerceSectionHint}>{tt('ecommerce.multiSelect')}</small></h3>
                  <div className={css.ecommerceStructureGrid}>
                    {ecommerce.slots.map(slot => (
                      <button
                        key={slot.key}
                        type="button"
                        className={css.ecommerceSlotCard}
                        data-active={slot.enabled ? '' : undefined}
                        title={`${slot.label}：${slot.description}`}
                        onClick={() => setEcommerce(previous => ({ ...previous, slots: previous.slots.map(item => item.key === slot.key ? { ...item, enabled: !item.enabled } : item) }))}
                      >
                        {slot.label}
                        {slot.enabled ? (
                          <span
                            className={css.ecommerceSlotCount}
                            title={tt('ecommerce.countHint')}
                            onClick={event => {
                              event.stopPropagation()
                              setEcommerce(previous => ({ ...previous, slots: previous.slots.map(item => item.key === slot.key ? { ...item, count: item.count >= 4 ? 1 : item.count + 1 } : item) }))
                            }}
                          >
                            {slot.count}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {ecommerceSlots.length > 0 ? (
                    <>
                      <button type="button" className={css.ecommerceAdvancedToggle} aria-expanded={ecommerceRefOpen} aria-controls="dsh-ecommerce-reference-settings" onClick={() => { setEcommerceRefOpen(open => !open) }}>
                        <span>{tt('ecommerce.refSettings')}</span>
                        <span className={css.ecommerceAdvancedChevron} aria-hidden="true">{ecommerceRefOpen ? '⌃' : '⌄'}</span>
                      </button>
                      {ecommerceRefOpen ? (
                        <div id="dsh-ecommerce-reference-settings" className={css.ecommerceAdvancedBody}>
                          {ecommerceSlots.map(slot => (
                            <label key={slot.key} className={css.ecommerceRefRow}>
                              <span>{slot.label}</span>
                              <select value={slot.refRole ?? 'product'} data-ecommerce-ref-select="" aria-label={`${tt('ecommerce.refSelect')} · ${slot.label}`} onChange={event => setEcommerce(previous => ({ ...previous, slots: previous.slots.map(item => item.key === slot.key ? { ...item, refRole: event.target.value as EcommerceRefRole } : item) }))}>
                                <option value="none">{tt('ecommerce.refNone')}</option>
                                {ECOMMERCE_ASSET_ROLES.map(role => <option key={role} value={role}>{tt(`ecommerce.role.${role}` as never)}</option>)}
                              </select>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.generation')}</h3>
                  <select value={modeModels.includes(model) ? model : modeModels[0] ?? ''} aria-label={tt('model.label')} onChange={event => setModel(event.target.value)}>{modeModels.map(option => <option key={option} value={option}>{option}</option>)}</select>
                  <div className={css.optionRow}>{QUALITIES.map(option => <Pill key={option} active={quality === option} onClick={() => { setQuality(option) }} className={css.optionPill}>{tt(`quality.${option}` as const)}</Pill>)}</div>
                </div>
                <div className={css.ecommerceSection}>
                  <h3>{tt('ecommerce.styleTitle')}</h3>
                  <textarea value={ecommerce.styleHint} placeholder={tt('ecommerce.styleHint')} onChange={event => setEcommerce(previous => ({ ...previous, styleHint: event.target.value }))} />
                  <span className={css.ecommerceFieldLabel}>{tt('ecommerce.protectedLabel')}</span>
                  <textarea value={ecommerce.protectedFeatures} placeholder={tt('ecommerce.protectedFeatures')} onChange={event => setEcommerce(previous => ({ ...previous, protectedFeatures: event.target.value }))} />
                </div>
                <input
                  ref={ecommerceFileInput}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className={css.hiddenFile}
                  onChange={(event) => {
                    acceptEcommerceFiles(event.target.files ?? undefined)
                    event.target.value = ''
                  }}
                />
              </section>
            ) : null}

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

                {/* prompt (normal workspace only — ecommerce has its own form) */}
                {workspace === 'normal' ? (<>
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
            </>) : null}
          </div>

          {/* footer: model + generate — a fixed sibling of the scroll area, so
              it never overlaps the cards scrolling above it. */}
            <section className={css.footer}>
            {workspace === 'ecommerce' ? (
              <div className={css.ecommerceFooterBody}>
                {ecommercePreview ? (
                  <>
                    <div className={css.ecommercePlanMini}>
                      <strong>{tt('ecommerce.planTitle', { count: ecommerceTotal })}</strong>
                      <div className={css.ecommercePlanList}>
                        {ecommerceSlots.map(slot => <div key={slot.key}><span>{slot.label}</span><span>×{slot.count}</span></div>)}
                      </div>
                      <div className={css.ecommercePlanNote}>{tt('ecommerce.anchorNote')}</div>
                      {ecommerceAssets.length === 0 ? <div className={css.ecommercePlanWarn}>{tt('ecommerce.noAssetWarn')}</div> : null}
                    </div>
                    <Button variant="primary" size="md" className={css.ecommercePrimaryAction} disabled={ecommerceGenerateDisabled} onClick={() => { void handleEcommerceGenerate() }}>{ecommerceGenerating ? tt('generating') : tt('ecommerce.confirm')}</Button>
                    <button type="button" className={css.ecommercePlanBack} onClick={() => { setEcommercePreview(false) }}>{tt('gallery.tagsCancel')}</button>
                  </>
                ) : (
                  <>
                    <span className={css.ecommerceFooterHint}>{ecommerceTotal > 0 ? tt('ecommerce.footerReady', { count: ecommerceTotal }) : tt('ecommerce.footerEmpty')}</span>
                    <Button variant="primary" size="md" className={css.ecommercePrimaryAction} disabled={ecommerce.productName.trim() === '' || ecommerceTotal === 0} onClick={() => setEcommercePreview(true)}>{tt('ecommerce.preview')}</Button>
                  </>
                )}
              </div>
            ) : null}
            {workspace === 'ecommerce' ? null : <label className={css.modelWrap}>
              <span className={css.modelLabel}>{tt('model.label')}</span>
              <span ref={modelMenuRef} className={css.modelMenu} data-open={modelOpen ? 'true' : 'false'}>
                <button
                  type="button"
                  className={css.modelSelect}
                  disabled={submitting}
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  onClick={() => { setModelOpen(open => !open) }}
                >
                  <span>{model || tt('model.noEditModels')}</span>
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5L4 6h8z"/></svg>
                </button>
                {modelOpen ? (
                  <div className={css.modelMenuList} role="listbox" aria-label={tt('model.label')}>
                    {modeModels.map(option => (
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
            </label>}
            {workspace !== 'ecommerce' ? <div className={css.compareControl}>
              <label className={css.compareToggle}>
                <input type="checkbox" checked={compareEnabled} onChange={event => { setCompareEnabled(event.target.checked) }} />
                <span>{tt('compare.enable')}</span>
              </label>
              {compareEnabled ? (
                <div className={css.compareModelChoices} role="group" aria-label={tt('compare.models')}>
                  {modeModels.map(option => (
                    <label key={option}>
                      <input type="checkbox" checked={compareModels.includes(option)} onChange={() => { setCompareModels(previous => previous.includes(option) ? previous.filter(value => value !== option) : [...previous, option]) }} />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div> : null}
            {workspace !== 'ecommerce' ? <Button
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
              </Button> : null}
            </section>
          </aside>

          {/* ------------------------------------------------------- canvas */}
          <section className={css.canvas} data-gallery={workspace === 'normal' && tab === 'gallery' ? 'true' : undefined}>
          {workspace === 'normal' && tab === 'gallery' ? (
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
                  <button type="button" className={css.galleryClear} data-gallery-open-folder="" title={tt('gallery.openFolderHint')} onClick={() => { void api.openDataFolder() }}>{tt('gallery.openFolder')}</button>
                  {gallery.length > 0 ? <button type="button" className={css.galleryClear} data-gallery-clear="" onClick={() => { void clearGalleryAll() }}>{tt('gallery.clear')}</button> : null}
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
                        <div className={css.galleryCardActions}>
                          <button
                            type="button"
                            className={css.galleryCardAction}
                            data-gallery-add-conversation=""
                            disabled={conversationBusy}
                            title={tt('conversation.addHint')}
                            onClick={(event) => { event.stopPropagation(); void addGalleryEntryToConversation(entry) }}
                          >
                            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10v7H3z"/><path d="M5.5 2.5h5M8 6v4M6 8h4"/></svg>
                            {galleryConversationAddingId === entry.id || addingToConversation === `gallery:${entry.id}` ? tt('conversation.adding') : tt('conversation.add')}
                          </button>
                        </div>
                        <div className={css.galleryCardFooter}>
                          <span className={css.galleryAvatar}>{entry.model.toLowerCase().startsWith('nanobanana') ? 'N' : entry.model.toLowerCase().startsWith('seedream') ? 'S' : entry.model.startsWith('grok') ? 'G' : 'D'}</span>
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
          {workspace === 'ecommerce' ? (
            <div className={css.ecommerceResults} data-ecommerce-results="">
              <header className={css.ecommerceResultsHeader}>
                <div>
                  <h3>{tt('ecommerce.results.title')}</h3>
                  {ecommerceRestored !== null && ecommerceRestored.projectId === ecommerceProjectId && ecommerceRestored.projectName !== '' ? (
                    <span>{ecommerceRestored.projectName}</span>
                  ) : null}
                  {ecommerceMergedItems.length > 0 ? (
                    <span>
                      {tt('ecommerce.results.progress', { done: ecommerceDoneCount, total: ecommerceMergedItems.length })}
                      {ecommerceFailedCount > 0 ? ` · ${tt('ecommerce.results.failed', { count: ecommerceFailedCount })}` : ''}
                    </span>
                  ) : null}
                  {ecommerceAnchor !== null ? <span data-ecommerce-anchor="">{tt('ecommerce.anchorPending')}</span> : null}
                </div>
                <div className={css.ecommerceResultsActions}>
                  {ecommerceMergedItems.length > 0 ? <button type="button" className={css.galleryBulkButton} data-ecommerce-export="" onClick={exportEcommerceManifest}>{tt('ecommerce.results.export')}</button> : null}
                  <button type="button" className={css.galleryBulkButton} data-ecommerce-new="" onClick={newEcommerceProduct}>{tt('ecommerce.results.newProduct')}</button>
                </div>
              </header>
              {ecommerceMergedItems.length === 0 ? (
                <div className={css.ecommerceResultsEmpty}>{tt('ecommerce.results.empty')}</div>
              ) : (
                <div className={css.ecommerceGroups}>
                  {ecommerceResultGroups.map(group => (
                    <section key={group.label} className={css.ecommerceGroup} data-ecommerce-group={group.label}>
                      <header>
                        <strong>{group.label}</strong>
                        <span>{group.items.filter(item => item.status === 'completed').length}/{group.items.length}</span>
                        <button type="button" className={css.galleryBulkButton} disabled={ecommerceGenerating} onClick={() => { void regenerateEcommerceSlot(group.label) }}>{tt('ecommerce.results.regenerate')}</button>
                      </header>
                      <div className={css.ecommerceGroupGrid}>
                        {group.items.map(item => (
                          <div key={item.id} className={css.ecommerceTaskCard} data-status={item.status}>
                            {item.status === 'completed' && item.images.length > 0 ? item.images.map((image, imageIndex) => (
                              <figure
                                key={imageIndex}
                                className={css.imageCard}
                                role="button"
                                tabIndex={0}
                                title={tt('preview.open')}
                                onClick={() => { openPreview(item.images, imageIndex) }}
                              >
                                <img className={css.image} src={srcOf(image)} alt={`${group.label} ${imageIndex + 1}`} />
                                <span className={css.ecommerceResultBadge}>{group.label}</span>
                                <span className={css.ecommerceTaskActions} onClick={event => event.stopPropagation()}>
                                  <a className={css.ecommerceActionChip} href={srcOf(image)} download={`product-${item.slotKey || item.id}-${imageIndex + 1}.${extensionOf(image.mime)}`}>{tt('download')}</a>
                                  <button type="button" className={css.ecommerceActionChip} disabled={galleryAdding} onClick={() => { void addToGallery(image) }}>{tt('gallery.add')}</button>
                                  <button type="button" className={css.ecommerceActionChip} disabled={conversationBusy} onClick={() => { void addImageToConversation(image, imageIndex, `${item.id}:${imageIndex}`) }}>{addingToConversation === `${item.id}:${imageIndex}` ? tt('conversation.adding') : tt('conversation.add')}</button>
                                </span>
                              </figure>
                            )) : (
                              <span className={css.ecommerceTaskState}>
                                <b>{group.label}</b>
                                {tt(`tasks.${item.status}` as never)}
                                {item.error !== undefined ? ` · ${item.error}` : ''}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {(workspace === 'ecommerce' || tab !== 'gallery') && tasks.length > 0 ? (
            <section className={css.taskTray} data-open={taskTrayOpen ? 'true' : 'false'} aria-label={tt('tasks.title')}>
              <header className={css.taskTrayHeader}>
                <button type="button" className={css.taskTrayToggle} aria-expanded={taskTrayOpen} onClick={() => { setTaskTrayOpen(open => !open) }}>
                  <span>{tt('tasks.title')}</span>
                  <span className={css.taskTrayCount}>{activeTasks.length}</span>
                  <span className={css.taskTrayChevron} aria-hidden="true">{taskTrayOpen ? '⌃' : '⌄'}</span>
                </button>
                {taskTrayOpen ? <button type="button" className={css.taskTrayClose} aria-label={tt('preview.close')} onClick={() => { setTaskTrayOpen(false) }}>×</button> : null}
              </header>
              <div className={css.taskRows}>
                {tasks.slice(0, 5).map(task => (
                  <div key={task.id} className={css.taskRow} data-status={task.status}>
                    <span className={css.taskStatus}>{tt(`tasks.${task.status}` as never)}</span>
                    <span className={css.taskPrompt}>{task.request.prompt}</span>
                    {(task.status === 'queued' || task.status === 'running') ? <button type="button" onClick={() => { void api.taskCancel(task.id) }}>{tt('tasks.cancel')}</button> : null}
                    {task.status === 'failed' || task.status === 'cancelled' ? <button type="button" onClick={() => { void api.taskRetry(task.id) }}>{tt('tasks.retry')}</button> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {workspace === 'normal' && tab !== 'gallery' && comparison !== null ? (
            <section className={css.comparisonBoard} aria-label={tt('compare.title')}>
              <header><div><strong>{tt('compare.title')}</strong><span>{comparisonResults.length} / {comparisonTasks.length}{generating ? ` · ${tt('canvas.elapsed', { seconds: elapsed })}` : ''}</span></div><button type="button" disabled={comparisonResults.length === 0} onClick={() => { setComparisonFullscreen(true) }}>{tt('compare.fullscreen')}</button></header>
              <div className={css.comparisonGrid}>
                {comparisonTasks.map(task => {
                  const taskImages = task.result?.images ?? []
                  const image = taskImages[0]
                  return (
                    <article key={task.id}>
                      <strong>{task.request.model}</strong>
                      {image !== undefined ? (
                        <button
                          type="button"
                          className={css.comparisonImageButton}
                          title={tt('preview.open')}
                          onClick={() => { openPreview(taskImages, 0) }}
                        >
                          <img src={srcOf(image)} alt={task.request.model} />
                        </button>
                      ) : <span>{tt(`tasks.${task.status}` as never)}</span>}
                    </article>
                  )
                })}
              </div>
            </section>
          ) : null}
          {generating && comparison === null && workspace !== 'ecommerce' ? (
            <div className={css.canvasState} data-generation-state={activeTask?.status ?? 'submitting'} role="status">
              <span className={css.bigSpinner} />
              <span className={css.canvasStateTitle}>
                {submitting && activeTask === undefined
                  ? tt('canvas.submitting')
                  : activeTask?.status === 'queued'
                    ? tt('canvas.queued')
                    : tt('canvas.generating')}
              </span>
              <span className={css.canvasStateHint}>
                {activeTask?.status === 'queued'
                  ? tt('canvas.queueHint', { count: activeTasks.length })
                  : tt('canvas.elapsed', { seconds: elapsed })}
              </span>
            </div>
          ) : null}

          {!generating && error !== null ? (
            <div className={css.canvasError} role="alert">{tt('canvas.error', { error })}</div>
          ) : null}

          {!generating && !error && images.length === 0 && workspace !== 'ecommerce' ? (
            <InspirationGallery
              api={api}
              onUse={(text) => {
                setPrompt(text)
                setError(null)
              }}
            />
          ) : null}

          {!generating && images.length > 0 && workspace !== 'ecommerce' ? (
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
                      <button
                        type="button"
                        className={css.conversationAdd}
                        title={tt('conversation.add')}
                        disabled={conversationBusy}
                        onClick={(event) => { event.stopPropagation(); void addImageToConversation(image, index) }}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10v7H3z"/><path d="M5.5 2.5h5M8 6v4M6 8h4"/></svg>
                        {addingToConversation === index ? tt('conversation.adding') : tt('conversation.add')}
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
        </div>

      </div>

      {sidebarHistoryHost !== null && historyPanel !== null
        ? createPortal(historyPanel, sidebarHistoryHost)
        : null}

      {/* ------------------------------------------------ template library */}
      {libraryOpen ? (
        <TemplateLibrary
          api={api}
          onClose={() => { setLibraryOpen(false) }}
          onUse={(text) => {
            openTab('text')
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
                  <button type="button" className={css.lightboxEdit} disabled={conversationBusy} title={tt('conversation.addHint')} onClick={() => { void addImageToConversation(previewImage, preview.index) }}>
                    {addingToConversation === preview.index ? tt('conversation.adding') : tt('conversation.add')}
                  </button>
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
      {conversationMessage !== null ? (
        <div className={css.conversationToast} role="status">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10v7H3z"/><path d="M5.5 2.5h5M8 6v4M6 8h4"/></svg>
          {conversationMessage}
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

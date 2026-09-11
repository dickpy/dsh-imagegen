/**
 * Wire contract shared by the host and client halves of dsh-imagegen: the
 * settings namespace, the route paths, and the generate payload/result shapes.
 * Pure types + constants 鈥?safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const IMAGEGEN_SETTINGS_NAMESPACE = 'dsh-imagegen'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '1.5.12'

/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
export const SETTINGS_API = {
  describe: '/api/dsh-imagegen/settings/describe',
  mutate: '/api/dsh-imagegen/settings/mutate',
} as const

/** The image-generation proxy route. */
export const GENERATE_API = '/api/dsh-imagegen/generate'

/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
export const PROMPT_ENHANCE_API = {
  models: '/api/dsh-imagegen/prompt-enhance/models',
  enhance: '/api/dsh-imagegen/prompt-enhance',
} as const

/** Host-mediated candidate discovery for the configured image API. */
export const IMAGE_MODEL_API = {
  models: '/api/dsh-imagegen/image-models',
} as const

/** Host-served built-in provider catalog (channels the user can instantiate). */
export const PRESETS_API = '/api/dsh-imagegen/presets' as const

/** Loopback-only image reader for Agent tool-result previews. */
export const AGENT_IMAGE_API = '/api/dsh-imagegen/agent-image' as const

/** Store the current composer image for the direct edit_image command. */
export const CONVERSATION_IMAGE_API = '/api/dsh-imagegen/conversation-image' as const

/**
 * Host-computed per-channel usage counters (generation-count badges in the
 * settings card): entries are tallied from the persisted history and gallery
 * by channel + model alias.
 */
export const USAGE_API = '/api/dsh-imagegen/usage' as const

/** Host-resident generation queue endpoints. */
export const TASK_API = {
  submit: '/api/dsh-imagegen/tasks/submit',
  list: '/api/dsh-imagegen/tasks/list',
  cancel: '/api/dsh-imagegen/tasks/cancel',
  retry: '/api/dsh-imagegen/tasks/retry',
} as const

/** Reveal the host data directory (saved images) in the OS file manager. */
export const DATA_FOLDER_API = '/api/dsh-imagegen/data-folder/open' as const

/** Probe the configured S3-compatible object storage. */
export const STORAGE_API = {
  test: '/api/dsh-imagegen/storage/test',
} as const

/** Host-mediated GitHub Release update routes. */
export const UPDATE_API = {
  check: '/api/dsh-imagegen/update/check',
  apply: '/api/dsh-imagegen/update/apply',
} as const

/**
 * Same-origin route family for the host-persisted generation history. Images
 * live as files under ~/.dsh/dsh-imagegen/images/ and are served back through
 * the `image` prefix route, so list responses carry metadata only (never
 * base64) and the browser loads thumbnails/previews lazily.
 */
export const HISTORY_API = {
  list: '/api/dsh-imagegen/history/list',
  append: '/api/dsh-imagegen/history/append',
  remove: '/api/dsh-imagegen/history/remove',
  clear: '/api/dsh-imagegen/history/clear',
  image: '/api/dsh-imagegen/history/image',
} as const

/**
 * Same-origin route family for the user-curated gallery (favorites). Entries
 * reuse the history wire shape and persist under ~/.dsh/dsh-imagegen/gallery/;
 * unlike history there is no size cap 鈥?the user adds images on purpose.
 */
export const GALLERY_API = {
  list: '/api/dsh-imagegen/gallery/list',
  append: '/api/dsh-imagegen/gallery/append',
  remove: '/api/dsh-imagegen/gallery/remove',
  clear: '/api/dsh-imagegen/gallery/clear',
  tags: '/api/dsh-imagegen/gallery/tags',
  image: '/api/dsh-imagegen/gallery/image',
} as const

/** Host-persisted infinite canvas projects and their content-addressed assets. */
export const CANVAS_API = {
  list: '/api/dsh-imagegen/canvas/list',
  create: '/api/dsh-imagegen/canvas/create',
  read: '/api/dsh-imagegen/canvas/read',
  save: '/api/dsh-imagegen/canvas/save',
  remove: '/api/dsh-imagegen/canvas/remove',
  assetUpload: '/api/dsh-imagegen/canvas/asset/upload',
  assetImport: '/api/dsh-imagegen/canvas/asset/import',
  asset: '/api/dsh-imagegen/canvas/asset',
  /** Vision-model layer decomposition for the canvas layer-split tool. */
  layers: '/api/dsh-imagegen/canvas/layers',
  /** Raw-binary upload for arbitrary canvas file nodes (no base64 inflation). */
  fileUpload: '/api/dsh-imagegen/canvas/file/upload',
  /** Structured content preview (text / table / office / archive) of one asset. */
  filePreview: '/api/dsh-imagegen/canvas/file/preview',
} as const

/** Same-origin route family for canvas skills (catalog + run control). */
export const CANVAS_SKILL_API = {
  list: '/api/dsh-imagegen/canvas/skills/list',
  run: '/api/dsh-imagegen/canvas/skills/run',
  task: '/api/dsh-imagegen/canvas/skills/task',
  cancel: '/api/dsh-imagegen/canvas/skills/cancel',
  /** Local skill library (`~/.dsh/skills`): inspect, install, remove. */
  library: '/api/dsh-imagegen/canvas/skills/library',
  install: '/api/dsh-imagegen/canvas/skills/install',
  remove: '/api/dsh-imagegen/canvas/skills/remove',
  /** Per-skill configuration values declared by `skill.config.json` (or a recipe). */
  configSave: '/api/dsh-imagegen/canvas/skills/config/save',
  /** Run a declaration's `apply` steps (commands / files) with the saved values. */
  configApply: '/api/dsh-imagegen/canvas/skills/config/apply',
} as const

/** Maximum number of history entries retained host-side (oldest evicted). */
export const HISTORY_MAX = 50

/**
 * Same-origin route family for the prompt-template libraries. The library is
 * multi-source: every request names a source id from {@link TEMPLATE_SOURCES},
 * each source keeps an independent snapshot/image cache host-side, and
 * reference images are proxied through the source-scoped `image` prefix route
 * (`…/image/<sourceId>/<file>`) and cached on disk so repeated views never hit
 * the network again.
 */
export const TEMPLATES_API = {
  list: '/api/dsh-imagegen/templates/list',
  refresh: '/api/dsh-imagegen/templates/refresh',
  sample: '/api/dsh-imagegen/templates/sample',
  image: '/api/dsh-imagegen/templates/image',
} as const

/** Same-origin route family for the user's saved (favorited) templates. */
export const TEMPLATE_FAVORITES_API = {
  list: '/api/dsh-imagegen/templates/favorites/list',
  add: '/api/dsh-imagegen/templates/favorites/add',
  remove: '/api/dsh-imagegen/templates/favorites/remove',
} as const

/** One prompt-template library source (a tab in the library overlay). */
export interface TemplateSourceMeta {
  /** Stable source id: snapshot dir name, image-cache dir, and request key. */
  id: string
  /** Tab label shown in the library overlay. */
  label: string
  /** Source homepage linked in the overlay footer. */
  homepage: string
  /** One-line description of the source (tab tooltip). */
  description: string
}

/**
 * The template-library source registry. Each entry is fully independent (own
 * upstream JSON, own image pool, own refresh state) and renders as its own
 * tab; adding a source later means appending an entry here plus a host-side
 * fetch definition in templates-store.ts and an optional bundled snapshot.
 */
export const TEMPLATE_SOURCES: TemplateSourceMeta[] = [
  {
    id: 'vibeui',
    label: '精选案例库',
    homepage: 'https://vibeui.top/',
    description: 'awesome-gpt-image-2 精选提示词案例（vibeui.top 镜像）',
  },
  {
    id: 'canghe',
    label: '沧河案例库',
    homepage: 'https://gpt-image2.canghe.ai/',
    description: 'GPT-Image2 Prompt Gallery（gpt-image2.canghe.ai，定期更新）',
  },
]

/** Default source id when a request does not name one (legacy clients). */
export const DEFAULT_TEMPLATE_SOURCE_ID = TEMPLATE_SOURCES[0]!.id

/** True when the id names a registered template source. */
export function isTemplateSourceId(id: string): boolean {
  return TEMPLATE_SOURCES.some(source => source.id === id)
}

/** One prompt-library case as the browser consumes it. */
export interface TemplateCase {
  /** Upstream case number (stable across refreshes). */
  id: number
  /** Short case title. */
  title: string
  /** Full reusable prompt text. */
  prompt: string
  /** English category name (grouping key). */
  category: string
  /** Chinese category display name. */
  categoryZh: string
  /** Style tags. */
  styles: string[]
  /** Scene tags. */
  scenes: string[]
  /** Original author handle, e.g. @vista8. */
  sourceLabel: string
  /** Original author link. */
  sourceUrl: string
  /** awesome-gpt-image-2 repo anchor link. */
  githubUrl: string
  /** Reference-image file name served through the image route ('' when none). */
  image: string
  /** Whether the source gallery featured the case. */
  featured: boolean
}

/** Template-library list payload (one source). */
export interface TemplateListResult {
  /** The source this list belongs to. */
  sourceId: string
  cases: TemplateCase[]
  total: number
  /** Where the served list came from. */
  origin: 'bundled' | 'refreshed'
  /** Upstream repository the library mirrors. */
  repository: string
  /** ISO time of the last successful refresh / bundle snapshot. */
  fetchedAt: string
}

/** Template-library refresh outcome (one source). */
export interface TemplateRefreshResult {
  sourceId: string
  total: number
  fetchedAt: string
}

/** One random inspiration pick served to the studio's empty state. */
export interface TemplateSample {
  /** Source the case came from (drives the image proxy URL). */
  sourceId: string
  /** The sampled case (full prompt is handed to the form on use). */
  case: TemplateCase
}

/** One favorited template as persisted host-side and served to the browser. */
export interface TemplateFavorite {
  /** Stable key: `${sourceId}:${caseId}`. */
  key: string
  /** Source the case came from. */
  sourceId: string
  /** ISO time the favorite was saved. */
  savedAt: string
  /** Full case snapshot, so favorites survive upstream list churn. */
  case: TemplateCase
}

/** Generation modes. */
export type GenerateMode = 'text' | 'edit'

/** Origin information carried by a generation started from the canvas. */
export interface CanvasTaskMeta {
  canvasId: string
  sourceNodeId?: string
  /** Legacy v1 annotation workflow; kept so old history entries still parse. */
  annotationNodeId?: string
  parentNodeId?: string
  placement?: 'right' | 'below'
}

/** One image or file asset referenced by a canvas node. Image assets always
 *  carry real dimensions; file assets may report `0` (nothing to preview). */
export interface CanvasAssetRef {
  assetId: string
  url: string
  mime: string
  bytes: number
  width: number
  height: number
  origin: 'upload' | 'history' | 'gallery' | 'generated'
  originId?: string
  entryId?: string
  imageIndex?: number
  /** Discriminator for nodes that carry arbitrary files; absent = image. */
  kind?: 'image' | 'file'
  /** Original (upload) or produced (skill run) file name, without a path. */
  name?: string
  /** Extracted text head for inline preview of text-like files. */
  textPreview?: string
}

export type CanvasNodeType = 'image' | 'text' | 'file' | 'config'

/** Coarse bucket driving the file node's icon and preview branch. */
export type CanvasFileKind = 'text' | 'pdf' | 'image' | 'office' | 'archive' | 'audio' | 'video' | 'other'

/**
 * One structured file preview built host-side for a canvas file node. Media
 * types that the browser can already render (image / pdf / audio / video) are
 * handed back as an inline URL; everything else arrives decoded, bounded, and
 * shaped for one of the renderers below.
 */
export type CanvasFilePreview =
  /** The asset itself renders in the browser (image, pdf, audio, video). */
  | {
    kind: 'media'
    media: 'image' | 'pdf' | 'audio' | 'video'
    /** Same-origin URL that serves the asset inline. */
    url: string
    width: number
    height: number
  }
  /** Decoded plain text (text files, extracted office documents, PDF fallback). */
  | {
    kind: 'text'
    /** Format bucket used in the UI, e.g. `md` / `docx` / `pdf`. */
    format: string
    text: string
    /** True when the file is longer than the preview cap. */
    truncated: boolean
    /** Total line count of the returned text. */
    lines: number
    /** Non-fatal extraction note (heuristics, partial reads). */
    warning?: string
  }
  /** HTML document rendered in a sandboxed iframe (scripts disabled). */
  | { kind: 'html'; format: 'html'; html: string; truncated: boolean }
  /** Markdown source, rendered to rich text by the client. */
  | { kind: 'markdown'; format: 'markdown'; markdown: string; truncated: boolean }
  /** SVG source, rendered as a browser image (scripts never run in `<img>`). */
  | { kind: 'svg'; format: 'svg'; svg: string; truncated: boolean }
  /** Rectangular data (CSV / TSV / XLSX) rendered as a grid. */
  | {
    kind: 'table'
    format: string
    rows: string[][]
    /** Row count in the source file (may exceed `rows.length`). */
    totalRows: number
    truncated: boolean
  }
  /** ZIP central directory listing. */
  | {
    kind: 'archive'
    entries: Array<{ name: string; size: number; dir: boolean }>
    /** Total entries in the archive (may exceed `entries.length`). */
    totalEntries: number
    truncated: boolean
  }
  /** Structured document preview (DOCX): headings, runs, lists, tables. */
  | { kind: 'document'; format: string; blocks: CanvasDocBlock[]; truncated: boolean }
  /** Slide-deck preview (PPTX): one card per slide with text and pictures. */
  | { kind: 'slides'; format: string; slides: CanvasSlidePreview[]; truncated: boolean }
  /** Nothing readable: the node shows the reason plus a download action. */
  | {
    kind: 'none'
    format: string
    /** Machine-readable reason so the browser can localize its own copy. */
    reason: 'unsupported' | 'unreadable'
    /** Host-side detail; used as a tooltip fallback, never as primary copy. */
    message?: string
  }

/** One styled run of rich document text (bold / italic fragments). */
export interface CanvasDocRun {
  text: string
  bold?: true
  italic?: true
}

/** One block of a structured document preview. Lists arrive pre-grouped so the
 *  renderer only walks a flat sequence. */
export type CanvasDocBlock =
  | { type: 'heading'; level: 1 | 2 | 3; runs: CanvasDocRun[] }
  | { type: 'paragraph'; runs: CanvasDocRun[] }
  | { type: 'list'; ordered: boolean; items: CanvasDocRun[][] }
  | { type: 'table'; rows: string[][] }

/** One slide of a PPTX preview: title, body lines and embedded pictures as
 *  data URLs (bounded: raster formats only, capped count and total bytes). */
export interface CanvasSlidePreview {
  title?: string
  lines: string[]
  images: Array<{ mime: string; data: string }>
}

/** Provenance stamped on nodes produced by a canvas skill run. */
export interface CanvasSkillProvenance {
  id: string
  label: string
  sourceNodeIds: string[]
  createdAt: number
  /** Wall-clock duration of the producing run in ms (absent for instant runs). */
  durationMs?: number
}

/**
 * One skill offered to canvas nodes. `builtin` entries are implemented by this
 * plugin (prompt actions, extraction, PPT conversion); `external` entries come
 * from the host skill registry (`ctx.skills`) and run through their own body.
 */
export interface CanvasSkillDescriptor {
  id: string
  name: string
  description: string
  whenToUse?: string
  origin: 'builtin' | 'external'
  /** light = one chat completion; heavy = a headless DSH agent run. */
  tier: 'light' | 'heavy'
  accepts: CanvasNodeType[]
  output: 'text' | 'image' | 'file' | 'nodes'
  /** Human-readable cost/time hint shown before a heavy run. */
  costHint?: string
  /** Extra preconditions the run reports as actionable errors. */
  requires?: string[]
  /** Built-in parameter vocabulary, e.g. polish styles. */
  params?: Array<{ id: string; label: string; placeholder?: string }>
  /** Host-skill name backing this entry (built-in deck conversion included). */
  skillName?: string
  /** Canonical home of the backing skill, offered as a one-click install. */
  installUrl?: string
  /**
   * Labels of required configuration fields that still have no value. The
   * picker shows them with a "go configure" affordance; it does not disable the
   * action, because a skill may still run without the value.
   */
  configMissing?: string[]
}

export type CanvasSkillTier = CanvasSkillDescriptor['tier']

export type CanvasSkillRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Node/connection drafts a finished run hands back to the browser. The client
 *  is the single writer: it merges these into the document through its own
 *  mutation path so undo, autosave and revision checks keep working. */
export interface CanvasSkillOutput {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  warnings: string[]
}

export interface CanvasSkillTask {
  id: string
  canvasId: string
  skillId: string
  label: string
  tier: CanvasSkillTier
  status: CanvasSkillRunStatus
  /** Coarse progress stage for the UI (queued / preparing / running / collecting). */
  stage?: string
  /** Machine-readable phase that drives the run card's step indicator. */
  phase?: 'queued' | 'preparing' | 'running' | 'collecting'
  /** Input node ids the run was queued with (the client rebuilds its run cards). */
  nodeIds?: string[]
  startedAt: number
  finishedAt?: number
  /** Copy language of the run, so polled stages stay in the caller's language. */
  language?: string
  output?: CanvasSkillOutput
  error?: string
}

export interface CanvasSkillRunRequest {
  canvasId: string
  skillId: string
  /** Nodes whose content feeds the run (the selected/acting node first). */
  nodeIds: string[]
  /** Free-form instruction (custom polish, extra requirements). */
  instruction?: string
  /** Built-in parameter selection, e.g. `{ style: 'formal' }`. */
  params?: Record<string, string>
  /** New-node placement hint, mirroring the generation workflow. */
  placement?: 'right' | 'below'
  /** UI language for host-rendered copy (pool copy, errors, stage labels). */
  language?: string
}

/** Polls and cancels carry the same language hint so stages stay translated.
 *  A `canvasId` without a `taskId` lists that canvas's unfinished runs, which
 *  is how a reopened canvas rebuilds its live run cards. */
export interface CanvasSkillTasksRequest {
  taskId: string
  canvasId?: string
  language?: string
}

export interface CanvasSkillCatalog {
  skills: CanvasSkillDescriptor[]
  /** Whether the host agent runtime is available for heavy skills. */
  agentAvailable: boolean
  /** Whether the host skill registry answered. */
  registryAvailable: boolean
  /**
   * Names of the external skills the canvas can actually offer: whatever the
   * host registry exposes plus everything loadable under the local skill root
   * (`~/.dsh/skills`). Drives the install affordance on entries whose backing
   * skill is missing.
   */
  installed: string[]
  /** Why the catalog is partial, when it is. */
  reason?: string
}

/** One configuration field a skill declares (see `docs/skill-config.md`). */
export interface CanvasSkillConfigField {
  id: string
  label: string
  description?: string
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select'
  required?: boolean
  default?: string
  /** `select` only. */
  options?: Array<{ value: string; label: string }>
  /**
   * Whether the value may ride the run prompt as a "configured" context block.
   * Secrets are never exposable, whatever the declaration says.
   */
  expose?: boolean
}

/**
 * One skill's configuration as the panel sees it. Values are never secrets: a
 * secret field reports only whether the host holds one.
 */
export interface CanvasSkillConfigView {
  fields: CanvasSkillConfigField[]
  values: Array<{ id: string; set: boolean; value?: string }>
  /** Where the declaration came from: the skill bundle, or this plugin. */
  source: 'skill' | 'plugin'
  /** Whether `apply` declares steps "save and apply" can run. */
  applicable: boolean
  /** Labels of required fields that still have no value. */
  missing: string[]
  /** Author note rendered above the form. */
  note?: string
  /** Why the declaration was ignored, when it was (host-rendered copy). */
  issue?: string
}

/** Save request: only the fields the user edited are sent. */
export interface CanvasSkillConfigSaveRequest {
  name: string
  /** Edited values; an empty string clears that field. */
  values?: Array<{ id: string; value: string }>
  language?: string
}

export interface CanvasSkillConfigSaveResult {
  ok: boolean
  library: CanvasSkillLibrary
  message?: string
}

/** One executed `apply` step, as reported back to the panel. */
export interface CanvasSkillConfigStep {
  kind: 'command' | 'file'
  /** Human-readable summary of what was executed or written (secrets masked). */
  detail: string
  ok: boolean
  /** Tail of the command output, secrets masked. */
  output?: string
}

export interface CanvasSkillConfigApplyRequest {
  name: string
  language?: string
}

export interface CanvasSkillConfigApplyResult {
  ok: boolean
  library: CanvasSkillLibrary
  steps: CanvasSkillConfigStep[]
  message?: string
}

/** One skill inside the local skill library (`~/.dsh/skills`). */
export interface CanvasSkillLibraryEntry {
  name: string
  description: string
  /** Registry path of the skill's `SKILL.md`, when the registry reports one. */
  path?: string
  sizeBytes: number
  updatedAt: number
  /** Browsable upstream home, when this plugin knows one for the name. */
  installUrl?: string
  /**
   * Why the node skill menu cannot offer this entry, in the caller's language.
   * Present when the host skill registry would ignore the bundle (a
   * non-kebab-case frontmatter name, a missing description, a user-only
   * invocation policy), so an install that "succeeded" is never silently
   * unusable.
   */
  issue?: string
  /** The skill's declared configuration, when it has one. */
  config?: CanvasSkillConfigView
}

export interface CanvasSkillLibrary {
  /** Root the host writes installs into. */
  root: string
  entries: CanvasSkillLibraryEntry[]
  /** Names a source install is available for, so the UI can offer one click. */
  catalog: Array<{ name: string; url: string }>
  /** Whether the host can fetch sources at all (git / network availability). */
  networkAvailable: boolean
}

export interface CanvasSkillInstallRequest {
  /** One or more sources: a git URL, an archive URL, or a raw `SKILL.md` URL. */
  sources?: string[]
  /** Previously uploaded archive asset (from the canvas file upload route). */
  asset?: CanvasAssetRef
  /** Target folder name override for archive installs that carry no name. */
  name?: string
  /** Replace an already installed skill of the same name. */
  force?: boolean
  language?: string
}

export interface CanvasSkillInstallResult {
  ok: boolean
  installed: string[]
  failed: Array<{ source: string; message: string }>
  library: CanvasSkillLibrary
  message?: string
}

export interface CanvasSkillRemoveRequest {
  name: string
  language?: string
}

export interface CanvasSkillRemoveResult {
  ok: boolean
  library: CanvasSkillLibrary
  message?: string
}

/** Normalized (0..1) rectangle inside an image asset: origin top-left. */
export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

/** One annotation box drawn on an image node by the 标注 tool. */
export interface CanvasAnnotation extends CanvasRect {
  id: string
  /** Text node holding the prompt for this box (absent once deleted). */
  nodeId?: string
}

/** Layer kinds produced by the canvas layer-split tool. */
export type CanvasLayerKind = 'background' | 'object' | 'text'

/** One layer in a vision-model decomposition of an image. */
export interface CanvasLayerPlanItem {
  kind: CanvasLayerKind
  label: string
  /** Object/text layers: the normalized box the layer occupies. */
  rect?: CanvasRect
  /** Text layers: the recognized string. */
  text?: string
  /** Text layers: recognized color as a hex string. */
  color?: string
}

/** Result of the host-mediated layer decomposition. */
export interface CanvasLayerPlan {
  layers: CanvasLayerPlanItem[]
}

/** Provenance kept on nodes produced by the layer-split tool. */
export interface CanvasLayerInfo {
  kind: CanvasLayerKind
  label: string
  sourceNodeId: string
}

/** One free-hand stroke on a sketch board. Points are normalized to the board
 *  rect (0..1 on both axes) so the drawing survives resize and raster export. */
export interface CanvasSketchStroke {
  color: string
  /** Stroke width in board pixels (the board's on-screen size at 100% zoom). */
  width: number
  points: Array<{ x: number; y: number }>
}

/** Sketch boards: vector strokes kept in node metadata, rasterized to a PNG
 *  asset in the background so downstream nodes treat the board like an image. */
export interface CanvasSketchDrawing {
  strokes: CanvasSketchStroke[]
}

export interface CanvasViewport {
  x: number
  y: number
  /** Zoom factor. */
  k: number
}

/** Free-form per-node state, mirroring the node-graph canvas model. */
export interface CanvasNodeMetadata {
  /** Image nodes: the rendered asset. */
  asset?: CanvasAssetRef
  status?: 'idle' | 'generating' | 'success' | 'error'
  error?: string
  /** Config/image nodes: generation settings. */
  prompt?: string
  model?: string
  size?: string
  quality?: string
  /** Config nodes: how many images to generate (1-4). */
  count?: number
  /** Config nodes: generation mode (image) or plain writing (text). */
  mode?: 'image' | 'text'
  taskId?: string
  sourceNodeId?: string
  /** Text nodes. */
  text?: string
  fontSize?: number
  /** Text nodes: CSS color for the text (absent = theme label color). */
  color?: string
  /** Text nodes: bold weight toggle. */
  bold?: boolean
  /** Text nodes created by the 标注 tool: the box this prompt describes. */
  annotation?: { sourceNodeId: string; rect: CanvasRect }
  /** Image nodes: annotation boxes drawn on this image. */
  annotations?: CanvasAnnotation[]
  /** Generated nodes: the 标注 edit behind them. The result is composited back
   *  onto the clean original outside these boxes, so the red marker that the
   *  model may echo never reaches the finished image. */
  annotationEdit?: { sourceNodeId: string; boxes: CanvasRect[] }
  /** Image nodes: layer-split provenance (label/kind of the extracted layer). */
  layer?: CanvasLayerInfo
  /** Image nodes: the asset carries real transparency (local matting). */
  transparent?: boolean
  /** Sketch boards: the live drawing behind an image node. */
  sketch?: CanvasSketchDrawing
  /** File nodes: coarse bucket driving the icon and preview branch. */
  fileKind?: CanvasFileKind
  /** Skill-produced nodes: which skill produced this and from what. */
  skill?: CanvasSkillProvenance
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  metadata?: CanvasNodeMetadata
}

export interface CanvasConnection {
  id: string
  fromNodeId: string
  toNodeId: string
}

export interface CanvasDocument {
  version: 2
  id: string
  title: string
  revision: number
  viewport: CanvasViewport
  background: 'dots' | 'lines' | 'blank' | 'image' | 'flow' | 'liquid' | 'floatingLines' | 'galaxy' | 'silk' | 'waves' | 'faultyTerminal' | 'dotField' | 'dotGrid' | 'shapeGrid'
  /** Custom background image URL (a canvas asset) when background is 'image'. */
  backgroundImage?: string
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  createdAt: number
  updatedAt: number
}

export interface CanvasSummary {
  id: string
  title: string
  revision: number
  nodeCount: number
  createdAt: number
  updatedAt: number
}

/** Metadata shared by the ecommerce product-set workflow. */
export interface EcommerceTaskMeta {
  workflow?: 'ecommerce'
  projectId?: string
  projectName?: string
  slotKey?: string
  slotLabel?: string
}

/** Role an uploaded product asset plays in the ecommerce workflow. 'none' is
 *  only used as a slot selection meaning "generate without a reference". */
export type EcommerceRefRole = 'none' | 'product' | 'packaging' | 'detail' | 'style'

/** One planned image slot in a product set. */
export interface ProductSetSlot {
  key: string
  label: string
  description: string
  count: number
  enabled: boolean
  /** Which uploaded asset role this slot uses as its edit reference. */
  refRole?: EcommerceRefRole
}

/** A browser-local ecommerce product-set draft. */
export interface ProductSetDraft {
  projectId: string
  projectName: string
  category: string
  platform: string
  language: string
  /** Custom copy language when language is 'custom'. */
  customLanguage?: string
  size: string
  productName: string
  /** 参数信息（提示词）: the merged reference-info field (v1.5.9+). */
  promptInfo: string
  /** Per-image prompt overrides keyed by `slotKey` (`main-1`, `selling-2`…);
   *  written from the pre-generation preview board. */
  promptOverrides?: Record<string, string>
  /** Legacy v1.5.9 separate fields; folded into promptInfo on load. */
  sellingPoints?: string
  protectedFeatures?: string
  styleHint?: string
  slots: ProductSetSlot[]
}

/** A client → host generate request (what the panel collects). */
export interface GenerateRequest extends EcommerceTaskMeta {
  /** text-to-image (images/generations) or image-to-image (images/edits). */
  mode: GenerateMode
  /**
   * User-facing model name (an alias from the channel's model catalog). The
   * host maps it onto the configured channel and fills `upstream` with the
   * real id before the engine sees it.
   */
  model: string
  /** The prompt. Upstream providers may impose their own length limits. */
  prompt: string
  /** Canvas size as an aspect ratio: 'auto' or e.g. '1:1' / '16:9' / '21:9'.
   *  The host maps it onto each model's own vocabulary (aspect_ratio for Grok
   *  and Nano Banana, resolution-tier size for Seedream, the closest pixel size for
   *  OpenAI-compatible endpoints). */
  size: string
  /** Clarity tier: 'auto' | '1k' | '2k' | '4k'. The host maps it onto the
   *  model's own vocabulary (resolution for Grok, image_size for Nano Banana,
   *  and size for Seedream,
   *  Nano Banana, quality for OpenAI). */
  quality: string
  /** Number of images, 1-4. */
  n: number
  /**
   * Passthrough detail parameter: '' (omit), 'standard', or 'high'. Some
   * gpt-image-2 gateways expose it; official OpenAI endpoints reject unknown
   * parameters, so the UI defaults to '' (omit).
   */
  detail: string
  /** Reference image as a data URL (edit mode only). */
  image?: string
  /** Additional reference images as data URLs (edit mode only). The first
   *  image stays in `image`; providers that accept several references get them
   *  all, single-reference providers see `image` alone. */
  images?: string[]
  /** Original reference-image name, retained in the history entry. */
  refName?: string
  /** Channel this request targets (the host falls back to the default when
   *  absent, and re-routes by model alias when the alias lives elsewhere). */
  channelId?: string
  /** Channel display name snapshot, kept on the history entry (host-filled). */
  channel?: string
  /** Upstream model id actually sent to the gateway (host-filled from the
   *  alias mapping; defaults to `model` when absent). */
  upstream?: string
  /** Stable client-created id shared by the tasks in one comparison run. */
  comparisonId?: string
  /** All model aliases selected for one comparison run. */
  comparisonModels?: string[]
  /** Optional canvas lineage metadata. */
  canvas?: CanvasTaskMeta
}

/** One generated image, normalized host-side to base64 so the browser never
 *  has to fetch the upstream (no CORS, no key exposure). */
export interface GeneratedImage {
  /** Raw base64 payload (no data: prefix). */
  b64: string
  /** MIME type of the payload, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful generate outcome. */
export interface GenerateResult {
  images: GeneratedImage[]
  /** Updated host-persisted history, when returned by the generate route. */
  history?: HistoryEntry[]
  /** Persistence failure after images were successfully generated. */
  historyError?: string
}

/**
 * One model mapping in a channel's catalog: the display alias the user, the
 * panel, and the Agent see, and the upstream model id actually sent to the
 * gateway. The alias defaults to the upstream id but can be renamed freely.
 */
export interface ModelMapping {
  /** User-facing model name (defaults to the upstream id). */
  alias: string
  /** Upstream model id sent to the gateway. */
  id: string
}

/**
 * One configured image channel (provider). Secrets never live here — the API
 * key is stored at `channelSecrets.<channelId>` in the settings document so
 * whole-array writes can never clobber keys the user did not re-enter.
 */
export interface ChannelConfig {
  /** Stable channel id (the channelSecrets dict is keyed by it). */
  id: string
  /** Preset provider id this channel was created from ('' = custom). */
  preset: string
  /** Display name shown in the list, the panel, and Agent guidance. */
  name: string
  /** OpenAI-compatible base URL. */
  apiUrl: string
  /** The channel's model catalog (alias → upstream id). */
  models: ModelMapping[]
}

/** One built-in provider as the settings card consumes it. */
export interface PresetProviderView {
  id: string
  name: string
  apiUrl: string
  hint: string
  models: ModelMapping[]
}

export type GenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface GenerationTask extends EcommerceTaskMeta {
  id: string
  request: GenerateRequest
  status: GenerationTaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: GenerateResult
  error?: string
}

/** GitHub Release update information shown by the client. */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
}

/** One history image reference as the browser consumes it (a served URL). */
export interface HistoryImageRef {
  /** Same-origin URL: `${HISTORY_API.image}/<file>`. */
  url: string
  /** MIME type, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** A saved generation as the browser consumes it (metadata + served images). */
export interface HistoryEntry extends EcommerceTaskMeta {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: HistoryImageRef[]
  /** Reference-image filename (edit mode), kept for display only. */
  refName?: string
  /** User-managed gallery labels (unused by history entries). */
  tags?: string[]
  /** Channel id snapshot (usage counters key by it for new entries). */
  channelId?: string
  /** Channel display name snapshot (survives channel deletion). */
  channel?: string
  /** Stable id shared by the history entries in one comparison run. */
  comparisonId?: string
  /** Model aliases included in the comparison run. */
  comparisonModels?: string[]
  canvas?: CanvasTaskMeta
}

/** A history entry the client submits for persistence (images still carry base64). */
export interface HistoryEntryInput extends EcommerceTaskMeta {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: GeneratedImage[]
  refName?: string
  /** Channel id snapshot, tallied by the usage endpoint. */
  channelId?: string
  /** Channel display name snapshot (survives channel deletion). */
  channel?: string
  /** Stable id shared by the history entries in one comparison run. */
  comparisonId?: string
  /** Model aliases included in the comparison run. */
  comparisonModels?: string[]
  canvas?: CanvasTaskMeta
}

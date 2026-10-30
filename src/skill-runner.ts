/**
 * Canvas skill runner.
 *
 * Runs one skill for one set of canvas nodes and hands node/connection drafts
 * back to the browser (the browser stays the single writer of canvas documents,
 * so undo, autosave and revision conflict handling are untouched).
 *
 * Two execution tiers, chosen by the catalog:
 *
 *  - **light** — assemble the node contents plus the skill body into one chat
 *    completion against the configured OpenAI-compatible endpoint. Used for
 *    polish, description, extraction and summarization.
 *  - **heavy** — create a headless DSH agent (`ctx.agents`) whose scoped system
 *    prompt carries the skill body, materialize the input files into a run
 *    directory, and let the agent execute the skill for real (files, CLI, child
 *    agents). Used for `image-to-editable-ppt` and similar pipelines.
 *
 * Everything the host cannot do for itself is injected through narrow backends
 * ({@link SkillRunnerBackend}) so the smoke suite can run the whole thing with
 * stubs and the plugin keeps its "no runtime dependency on DSH packages" rule.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CanvasAssetRef,
  CanvasConnection,
  CanvasDocument,
  CanvasNode,
  CanvasSkillCatalog,
  CanvasSkillDescriptor,
  CanvasSkillOutput,
  CanvasSkillRunRequest,
  CanvasSkillTask,
  PptRunRequest,
} from './protocol.ts'
import { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
import { redactDiagnosticText } from './diagnostics-store.ts'
import { readZipDirectory, readZipEntry } from './zip.ts'
import {
  BUILTIN_DESCRIBE,
  BUILTIN_EXTRACT,
  BUILTIN_POLISH,
  BUILTIN_PPT,
  canvasSkillCatalog,
  EDITABLE_PPT_SKILL,
  isEditablePptSkill,
  type CatalogTranslate,
  type ExternalSkillSummary,
} from './skills-catalog.ts'
import { fileKindOf } from './canvas-store.ts'
import { PptTaskStore } from './ppt-task-store.ts'
import { pptActivity, PptProgressMonitor } from './ppt-progress.ts'
import { runCommand } from './skill-config.ts'
import { runDeckPipeline, type DeckPipelineResult } from './ppt-deck-pipeline.ts'
import { acceptDeck, inspectDeck, type DeckRejection } from './ppt-deck-check.ts'

// ---------------------------------------------------------------- contracts

/** One multimodal chat part, mirroring the OpenAI wire shape. */
export type SkillChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** Chat completion seam (the real one wraps {@link chatComplete}). */
export interface SkillChatBackend {
  complete: (options: {
    system: string
    content: string | SkillChatPart[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }) => Promise<string>
}

/** Skill registry seam: catalog summaries plus bodies loaded on demand. */
export interface SkillRegistryBackend {
  list: () => Promise<readonly ExternalSkillSummary[]>
  get: (name: string) => Promise<{ name: string; content: string } | undefined>
}

/** The renderer face of a live agent, narrowed to what a skill run drives. */
export interface SkillAgentSession {
  readonly seq?: number
  eventAt?: (seq: number) => unknown
  deriveMessages: () => readonly unknown[]
}

/** A live headless agent owned by one skill run. */
export interface SkillAgentHandle {
  session: SkillAgentSession
  followup: (text: string) => void
  whenIdle: () => Promise<void>
  cancel: () => void
  dispose: () => Promise<void>
}

/** Agent-runtime seam; `create` returns undefined when the runtime cannot
 *  compose a headless agent (missing factory, missing model, …). */
export interface SkillAgentBackend {
  available: () => boolean
  create: (options: {
    sessionId: string
    cwd: string
    systemPrompt: string
    signal?: AbortSignal
    /** Resolve one copy key in the run's language, for a composition failure. */
    fail: (key: string) => string
  }) => Promise<SkillAgentHandle | undefined>
}

/** Canvas storage seam (the real one is the CanvasStore). */
export interface SkillCanvasBackend {
  read: (id: string) => Promise<CanvasDocument | undefined>
  readAsset: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  readAssets: (refs: readonly CanvasAssetRef[]) => Promise<Map<string, { data: Buffer; mime: string }>>
  materialize: (ref: CanvasAssetRef, targetPath: string) => Promise<void>
  putFile: (input: {
    data: Uint8Array
    mime: string
    name: string
    origin: CanvasAssetRef['origin']
    originId?: string
  }) => Promise<CanvasAssetRef>
}

/**
 * Skill-configuration seam. The host owns declarations and values
 * (`docs/skill-config.md`); the runner only needs to know which required fields
 * are still unset, and what an exposable value set looks like in a prompt.
 */
export interface SkillConfigBackend {
  /** Labels of unset required fields, per skill name (absent = configured). */
  missing: (names: readonly string[]) => Promise<Map<string, string[]>>
  /** Non-secret "configured values" block for one skill, when it exposes any. */
  note: (name: string) => Promise<string | undefined>
}

/** Everything one runner needs, injected so tests can replace any layer. */
export interface SkillRunnerBackend {
  chat?: SkillChatBackend
  registry?: SkillRegistryBackend
  agents?: SkillAgentBackend
  /** Per-skill configuration, when the host has a declaration store. */
  skillConfig?: SkillConfigBackend
  canvas: SkillCanvasBackend
}

export interface SkillRunnerOptions {
  backend: SkillRunnerBackend
  /** Whether the canvas feature is enabled at all (settings master switch). */
  enabled: () => boolean
  /** Whether long agent runs are permitted (settings switch). */
  heavyEnabled: () => boolean
  /** External-skill allowlist; empty means every registered skill. */
  allowlist: () => string[]
  /** Run directory root for heavy skills; empty uses the canvas data root. */
  runRoot: () => string
  /** Heavy-skill timeout in milliseconds. */
  heavyTimeoutMs: () => number
  /** Data root (the same one the canvas store uses). */
  dataRoot: () => string
  /** Upstream home of the deck pipeline, surfaced as a one-click install. */
  pptInstallUrl?: string
  pptCommand?: () => Promise<string>
  /**
   * Deck driver selection. `local` runs the host-driven `editppt` pipeline
   * (no headless agent, no shell permission, no approval round-trip); `agent`
   * keeps the legacy agent driver. Unset means `agent` so an un-upgraded host
   * keeps the behaviour it always had.
   */
  deckMode?: () => 'local' | 'agent'
  /** Local-pipeline limits (page concurrency and per-page budget). */
  deckLimits?: () => { concurrency: number; pageBudgetMs: number }
  /** Whether a chat model is configured that can look at a slide image. */
  deckChatReady?: () => boolean
  /** Read one document out of the installed upstream skill bundle. */
  pptSkillDoc?: (relative: string) => Promise<string | undefined>
  /** Durable task storage seam; defaults to immutable filesystem checkpoints. */
  pptTasks?: Pick<PptTaskStore, 'write' | 'list'>
}

// ---------------------------------------------------------------- constants

/** Hard cap on input nodes per run: more than this is a mis-click, not a task. */
export const MAX_SKILL_INPUT_NODES = 12

/** Cap on the text handed to the light tier from text nodes. */
const MAX_INLINE_TEXT = 40_000

/** Cap on the images handed to one vision call. */
const MAX_VISION_IMAGES = 6

/** Completed tasks are kept for the poll window, then evicted. */
const MAX_TRACKED_TASKS = 200

/** Output node footprints (world units), matching the client's node sizes. */
const TEXT_NODE_SIZE = { width: 320, height: 260 }
const FILE_NODE_SIZE = { width: 300, height: 170 }
const NODE_GAP = 96
const STACK_GAP = 48

/** Chat-model instructions per built-in light action. */
const POLISH_DIRECTIVES: Record<string, { zh: string; en: string }> = {
  formal: {
    zh: '改写得更正式、专业、书面化，保留原意与信息量，不要添加新事实。',
    en: 'Rewrite it in a more formal, professional register. Preserve meaning and facts; add nothing.',
  },
  casual: {
    zh: '改写得更口语、轻松、自然，保留原意与信息量。',
    en: 'Rewrite it in a casual, conversational, natural voice. Preserve meaning and facts.',
  },
  shorter: {
    zh: '压缩到原文 60% 以内的篇幅，只保留关键信息，语句通顺。',
    en: 'Compress it to at most 60% of the original length, keeping only the key information.',
  },
  expand: {
    zh: '在保留原意的前提下扩写，补充必要的细节、例子或过渡，让内容更充实。',
    en: 'Expand it with necessary detail, examples or transitions while preserving the original intent.',
  },
}

const DESCRIBE_SYSTEM = '你是图像理解引擎。请用简洁、具体的语言描述这张图片：主体、场景、构图、光线、色彩风格、文字与关键元素。只输出描述正文，不要客套话，不要 markdown 标题。'

function describeSystem(language: string): string {
  return language.startsWith('zh') || language === ''
    ? DESCRIBE_SYSTEM
    : 'You are an image-understanding engine. Describe this image concretely: subject, scene, composition, lighting, color and style, text and key elements. Output the description only — no preface, no markdown headings.'
}

// ---------------------------------------------------------------- helpers

/** Deterministic id generator, injectable for tests. */
let idFactory: (prefix: string) => string = prefix => `${prefix}-${randomUUID()}`
/** Override the id generator (host integration tests only). */
export function setIdFactory(factory: (prefix: string) => string): void {
  idFactory = factory
}

function newId(prefix: string): string {
  return idFactory(prefix)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

function isImageAsset(asset: CanvasAssetRef): boolean {
  return asset.kind !== 'file' && baseMime(asset.mime).startsWith('image/')
}

/** Filesystem-safe single-component name for a materialized deck input. */
function safeFileName(original: string): string {
  return original.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'input'
}

/** Read a small JSON artifact (a validation report), never a huge binary. */
async function readBoundedJson(file: string): Promise<Record<string, unknown> | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (stat === undefined || !stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined
  const value = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw)).catch(() => undefined)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Localized rejection reason for a deck that failed the acceptance gate. */
function deckRejectText(t: CatalogTranslate, reason: DeckRejection): string {
  switch (reason) {
    case 'invalid-package': return t('ppt.rejectInvalidPackage')
    case 'slide-count': return t('ppt.rejectSlideCount')
    case 'report-not-passed': return t('ppt.rejectReport')
    case 'raster-only': return t('ppt.rejectRaster')
  }
}

/** One input node plus its loaded asset, resolved once per run. */
interface RunInput {
  node: CanvasNode
  asset?: CanvasAssetRef
  data?: Buffer
}

function nodeText(node: CanvasNode): string {
  return typeof node.metadata?.text === 'string' ? node.metadata.text.trim() : ''
}

function nodeTitle(node: CanvasNode): string {
  return node.title.trim() === '' ? node.type : node.title.trim()
}

/** Union of explicit ids and every node connected into them. */
function resolveInputIds(document: CanvasDocument, request: CanvasSkillRunRequest): string[] {
  const explicit = request.nodeIds.filter(id => id.trim() !== '')
  const targets = explicit.length > 0 ? explicit : []
  const ids = new Set<string>(targets)
  for (const connection of document.connections) {
    if (targets.includes(connection.toNodeId)) ids.add(connection.fromNodeId)
  }
  return [...ids]
}

/** Place a stack of produced nodes beside (or under) the source node. */
function placeOutputs(
  produced: CanvasNode[],
  source: CanvasNode | undefined,
  nodes: readonly CanvasNode[],
  placement: 'right' | 'below',
): CanvasNode[] {
  if (produced.length === 0) return produced
  const anchor = source ?? nodes[nodes.length - 1]
  if (anchor === undefined) return produced
  const height = produced.reduce((total, node) => total + node.height + STACK_GAP, 0)
  if (placement === 'below') {
    let y = anchor.y + anchor.height + STACK_GAP
    const x = anchor.x
    return produced.map(node => {
      const placed = { ...node, x: Math.round(x), y: Math.round(y) }
      y += node.height + STACK_GAP
      return placed
    })
  }
  const width = Math.max(...produced.map(node => node.width))
  let x = anchor.x + anchor.width + NODE_GAP
  for (let guard = 0; guard < 24; guard += 1) {
    const clash = nodes.filter(node => node.id !== anchor.id
      && x < node.x + node.width + 24 && x + width > node.x - 24
      && anchor.y < node.y + node.height + 24 && anchor.y + height > node.y - 24)
    if (clash.length === 0) break
    x = Math.max(...clash.map(node => node.x + node.width)) + 48
  }
  let y = anchor.y
  return produced.map(node => {
    const placed = { ...node, x: Math.round(x), y: Math.round(y) }
    y += node.height + STACK_GAP
    return placed
  })
}

function textOutputNode(source: CanvasNode, title: string, text: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  const metadata = source.metadata ?? {}
  return {
    id: newId('node'),
    type: 'text',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width: TEXT_NODE_SIZE.width,
    height: TEXT_NODE_SIZE.height,
    metadata: {
      text,
      fontSize: typeof metadata.fontSize === 'number' ? metadata.fontSize : 14,
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

function fileOutputNode(source: CanvasNode, asset: CanvasAssetRef, title: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  return {
    id: newId('node'),
    type: 'file',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width: FILE_NODE_SIZE.width,
    height: FILE_NODE_SIZE.height,
    metadata: {
      asset,
      fileKind: fileKindOf(asset.mime, asset.name ?? ''),
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

function imageOutputNode(source: CanvasNode, asset: CanvasAssetRef, title: string, skillId: string, label: string, sourceIds: string[]): CanvasNode {
  const width = asset.width > 0 ? Math.min(512, asset.width) : 320
  const height = asset.width > 0 && asset.height > 0 ? Math.round(width * (asset.height / asset.width)) : 320
  return {
    id: newId('node'),
    type: 'image',
    title,
    x: source.x + source.width + NODE_GAP,
    y: source.y,
    width,
    height,
    metadata: {
      asset,
      status: 'success',
      skill: { id: skillId, label, sourceNodeIds: sourceIds, createdAt: Date.now() },
    },
  }
}

/** Wrap produced nodes into the wire output (drafts only — no ids rewritten). */
function outputOf(nodes: CanvasNode[], connections: CanvasConnection[], warnings: string[] = []): CanvasSkillOutput {
  return { nodes, connections, warnings }
}

/** Find the last assistant text in a session message list (structural). */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'assistant' || !Array.isArray(record.content)) continue
    const text = record.content.flatMap(block => {
      if (block === null || typeof block !== 'object') return []
      const entry = block as { type?: unknown; text?: unknown }
      return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
    }).join('\n').trim()
    if (text !== '') return text
  }
  return undefined
}

/** whenIdle contains driver errors; inspect its durable turn ending instead. */
export function agentSessionFailure(session: SkillAgentSession): string | undefined {
  if (session.eventAt === undefined || !Number.isSafeInteger(session.seq)) return undefined
  for (let index = session.seq! - 1; index >= Math.max(0, session.seq! - 1000); index -= 1) {
    const raw = session.eventAt(index) as { type?: string; data?: { reason?: { kind?: string; error?: { code?: string; message?: string }; reason?: { kind?: string } } } } | undefined
    if (raw?.type !== 'turn/end') continue
    const reason = raw.data?.reason
    if (reason?.kind === 'error') return redactDiagnosticText([reason.error?.code, reason.error?.message].filter(Boolean).join(': ') || 'Agent execution failed')
    if (reason?.kind === 'aborted') return `Agent stopped (${reason.reason?.kind ?? 'aborted'})`
    return undefined
  }
  return undefined
}

// ---------------------------------------------------------------- runner

export class SkillRunner {
  private readonly tasks = new Map<string, CanvasSkillTask>()
  private readonly cancellers = new Map<string, { dispose: () => Promise<void> }>()
  private tail: Promise<void> = Promise.resolve()
  private backend: SkillRunnerBackend
  private readonly pptStore: Pick<PptTaskStore, 'write' | 'list'>

  constructor(private readonly options: SkillRunnerOptions) {
    this.backend = { ...options.backend }
    this.pptStore = options.pptTasks ?? new PptTaskStore(options.dataRoot)
  }

  /**
   * Attach or replace the optional host seams (skill registry, agent runtime).
   * Called from the plugin's soft injection once those services exist, and with
   * an empty object when they unload. The chat and canvas seams are never
   * replaced here.
   * @param parts - the seams to adopt; omitted keys are cleared.
   */
  attach(parts: { registry?: SkillRegistryBackend; agents?: SkillAgentBackend; skillConfig?: SkillConfigBackend }): void {
    this.backend.registry = parts.registry
    this.backend.agents = parts.agents
    this.backend.skillConfig = parts.skillConfig
  }

  /**
   * The catalog offered to the canvas (built-ins + allowlisted host skills).
   * @param language - UI language for the catalog copy (falls back to the
   *   installed resolver, then to the runner default).
   */
  async list(language?: string): Promise<CanvasSkillCatalog> {
    const t = this.translate(language)
    const registry = this.backend.registry
    const agentAvailable = this.backend.agents?.available() === true && this.options.heavyEnabled()
    if (!this.options.enabled()) {
      return { skills: [], agentAvailable, registryAvailable: registry !== undefined, installed: [], reason: t('canvas.skills.disabled') }
    }
    let external: readonly ExternalSkillSummary[] = []
    let registryAvailable = false
    let reason: string | undefined
    if (registry === undefined) {
      reason = t('canvas.skills.noRegistry')
    } else {
      try {
        const listed = await registry.list()
        const allow = this.options.allowlist().map(item => item.trim()).filter(item => item !== '')
        external = allow.length === 0 ? listed : listed.filter(skill => allow.includes(skill.name))
        registryAvailable = true
      } catch (error) {
        reason = t('canvas.skills.registryFailed', { message: messageOf(error) })
      }
    }
    // Required configuration that is still unset: the picker shows it with a
    // "go configure" affordance instead of letting the run fail halfway.
    const missing = this.backend.skillConfig === undefined
      ? undefined
      : await this.backend.skillConfig.missing(external.map(skill => skill.name)).catch(() => undefined)
    return {
      skills: canvasSkillCatalog(external, t, {
        agentAvailable,
        ...this.options.pptInstallUrl === undefined ? {} : { pptInstallUrl: this.options.pptInstallUrl },
        ...missing === undefined ? {} : { configMissing: name => missing.get(name) },
      }),
      agentAvailable,
      registryAvailable,
      installed: external.map(skill => skill.name),
      deckExecution: this.deckAvailability(t, external, agentAvailable),
      ...reason === undefined ? {} : { reason },
      ...agentAvailable ? {} : { reason: reason ?? t('canvas.skills.needAgent') },
    }
  }

  /**
   * Can the deck conversion run right now, and through which driver?
   *
   * The local pipeline only needs the upstream skill bundle (for its field
   * contracts) plus a chat model that can look at an image; it never touches
   * the agent runtime. The legacy agent driver keeps demanding both the skill
   * and an available agent. Reporting the missing piece here is what lets the
   * PPT workspace disable its button with a reason instead of letting a paid
   * run stall at twenty minutes.
   */
  private deckAvailability(
    t: CatalogTranslate,
    external: readonly ExternalSkillSummary[],
    agentAvailable: boolean,
  ): CanvasSkillCatalog['deckExecution'] {
    const mode = this.options.deckMode?.() ?? 'agent'
    const installed = external.some(skill => isEditablePptSkill(skill.name))
    const reason = !installed
      ? t('canvas.skills.skillMissing', { name: EDITABLE_PPT_SKILL })
      : mode === 'local'
        ? this.options.deckChatReady?.() === false ? t('ppt.noVisionModel') : undefined
        : !agentAvailable ? t('canvas.skills.needAgent') : undefined
    return { mode, ready: reason === undefined, ...reason === undefined ? {} : { reason } }
  }

  /** Queue one run and return its task immediately (the client polls it). */
  async run(request: CanvasSkillRunRequest): Promise<CanvasSkillTask> {
    const t = this.translate(request.language)
    const catalog = await this.list(request.language)
    const skill = catalog.skills.find(item => item.id === request.skillId)
    if (skill === undefined) throw new Error(t('canvas.skills.unknown'))
    const document = await this.backend.canvas.read(request.canvasId)
    if (document === undefined) throw new Error(t('canvas.skills.canvasMissing'))
    const ids = resolveInputIds(document, request).slice(0, MAX_SKILL_INPUT_NODES)
    const byId = new Map(document.nodes.map(node => [node.id, node]))
    const inputs: RunInput[] = ids.flatMap(id => {
      const node = byId.get(id)
      if (node === undefined || node.type === 'config') return []
      const asset = node.metadata?.asset
      return [{ node, ...asset === undefined ? {} : { asset } }]
    })
    if (inputs.length === 0) throw new Error(t('canvas.skills.noInput'))
    // A skill the target node cannot feed is a mis-click, not a run.
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    if (!skill.accepts.includes(target.node.type)) throw new Error(t('canvas.skills.incompatible'))
    if (skill.tier === 'heavy' && !catalog.agentAvailable) throw new Error(t('canvas.skills.needAgent'))

    return this.startTask(request, skill, inputs)
  }

  /** Standalone mode uses the same installed skill, without creating a canvas. */
  async runPpt(request: PptRunRequest): Promise<CanvasSkillTask> {
    const t = this.translate(request.language)
    const catalog = await this.list(request.language)
    const skill = catalog.skills.find(item => item.id === BUILTIN_PPT)
    if (skill === undefined) throw new Error(t('canvas.skills.unknown'))
    // One gate for both drivers: the catalog already knows which prerequisite
    // is missing (skill bundle, chat model, or agent runtime).
    const deck = catalog.deckExecution ?? { mode: 'agent' as const, ready: catalog.agentAvailable && catalog.installed.includes(EDITABLE_PPT_SKILL) }
    if (!deck.ready) throw new Error(deck.reason ?? t('canvas.skills.needAgent'))
    if (request.images.length === 0 || request.images.length > MAX_SKILL_INPUT_NODES) throw new Error(t('ppt.inputLimit'))
    const inputs: RunInput[] = []
    for (const [index, asset] of request.images.entries()) {
      const found = await this.backend.canvas.readAsset(asset.assetId)
      if (found === undefined || !/^image\/(png|jpeg|webp)$/.test(found.mime)) throw new Error(t('ppt.invalidImage'))
      const safeAsset: CanvasAssetRef = { ...asset, mime: found.mime, kind: 'image', name: `slide-${index + 1}.${found.mime === 'image/jpeg' ? 'jpg' : found.mime.split('/')[1]}` }
      inputs.push({ asset: safeAsset, node: { id: newId('ppt-input'), type: 'image', title: safeAsset.name!, x: 0, y: 0, width: 320, height: 240, metadata: { asset: safeAsset } } })
    }
    return this.startTask({ canvasId: 'ppt', skillId: BUILTIN_PPT, nodeIds: inputs.map(input => input.node.id), language: request.language, offlineOcr: request.offlineOcr,
      instruction: request.offlineOcr ? 'The user explicitly chose offline text detection for this run. Use upstream editppt prepare --no-text-hints, then editppt page hints for each page to generate offline hints before reconstruction. Do not call PaddleOCR for this run or ask about a token again. All other upstream steps remain required.' : 'Use the configured PaddleOCR token. Follow the upstream skill if OCR fails; do not silently downgrade quality.' }, skill, inputs, true)
  }

  /** Durable conversion history survives panel reloads and host restarts. */
  async pptTasks(): Promise<CanvasSkillTask[]> {
    const persisted: CanvasSkillTask[] = []
    let saved: CanvasSkillTask[]
    try { saved = await this.pptStore.list() }
    catch (error) {
      const live = [...this.tasks.values()].filter(task => task.canvasId === 'ppt')
      if (live.length === 0) throw error
      for (const task of live) task.persistenceError = redactDiagnosticText(messageOf(error))
      return live.sort((a, b) => b.startedAt - a.startedAt)
    }
    for (const task of saved) {
      const live = this.tasks.get(task.id)
      if (live !== undefined) { persisted.push(live); continue }
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'failed'
        task.error = this.translate(task.language)('ppt.interrupted')
        task.finishedAt = Date.now()
        await this.persistPpt(task)
      }
      persisted.push(task)
    }
    for (const task of this.tasks.values()) if (task.canvasId === 'ppt' && !persisted.some(item => item.id === task.id)) persisted.push(task)
    return persisted.sort((a, b) => b.startedAt - a.startedAt)
  }

  private async persistPpt(task: CanvasSkillTask, required = false): Promise<void> {
    if (task.canvasId !== 'ppt') return
    const { persistenceError: _previous, ...snapshot } = task
    try {
      await this.pptStore.write(snapshot)
      delete task.persistenceError
    } catch (error) {
      task.persistenceError = redactDiagnosticText(messageOf(error))
      // The initial queue record is required before starting work. Later history errors
      // must not abort the Agent, erase its real error, or invalidate a completed deck.
      if (required) throw error
    }
  }

  private async startTask(request: CanvasSkillRunRequest, skill: CanvasSkillDescriptor, inputs: RunInput[], ppt = false): Promise<CanvasSkillTask> {
    const language = request.language
    const task: CanvasSkillTask = {
      id: newId('skillrun'),
      canvasId: request.canvasId,
      skillId: skill.id,
      label: skill.name,
      tier: skill.tier,
      status: 'queued',
      stage: this.translate(language)('canvas.skills.stageQueued'),
      phase: 'queued',
      nodeIds: [...request.nodeIds],
      startedAt: Date.now(),
      ...ppt ? { pptImages: inputs.map(input => input.asset!) } : {},
      ...language === undefined || language === '' ? {} : { language },
    }
    pptActivity(task, task.stage!)
    this.tasks.set(task.id, task)
    try { await this.persistPpt(task, true) } catch (error) { this.tasks.delete(task.id); throw error }
    this.pruneTasks()
    const job = this.enqueue(task, skill, inputs, request)
    // The caller polls the task; the job never rejects outward.
    job.catch(error => {
      task.status = 'failed'
      task.error = messageOf(error)
      task.finishedAt = Date.now()
    })
    return task
  }

  /** One task snapshot, or undefined once evicted. */
  task(id: string): CanvasSkillTask | undefined {
    return this.tasks.get(id)
  }

  /** Unfinished runs of one canvas, so a reopened canvas can rebuild its live
   *  run cards after a reload (the browser holds no run state itself). */
  tasksOfCanvas(canvasId: string): CanvasSkillTask[] {
    return [...this.tasks.values()].filter(task => task.canvasId === canvasId
      && (task.status === 'queued' || task.status === 'running'))
  }

  /** Cancel a queued or running task. */
  async cancel(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
    task.status = 'cancelled'
    task.stage = this.translate(task.language)('canvas.skills.stageCancelled')
    pptActivity(task, task.stage, 'warning')
    task.finishedAt = Date.now()
    const canceller = this.cancellers.get(id)
    this.cancellers.delete(id)
    if (canceller !== undefined) await canceller.dispose().catch(() => { /* best effort */ })
    await this.persistPpt(task)
    return true
  }

  private enqueue(task: CanvasSkillTask, skill: CanvasSkillDescriptor, inputs: RunInput[], request: CanvasSkillRunRequest): Promise<void> {
    const cancelled = (): boolean => this.tasks.get(task.id)?.status === 'cancelled'
    const run = async (): Promise<void> => {
      if (cancelled()) return
      task.status = 'running'
      task.phase = 'running'
      try {
        // The deck conversion has two drivers: the host-driven pipeline (no
        // agent, no shell permission) and the legacy headless-agent driver.
        if (skill.id === BUILTIN_PPT && (this.options.deckMode?.() ?? 'agent') === 'local') {
          task.output = await this.runPptLocal(task, skill, inputs, request)
        } else {
          task.output = skill.tier === 'heavy'
            ? await this.runHeavy(task, skill, inputs, request)
            : await this.runLight(task, skill, inputs, request)
        }
        if (!cancelled()) {
          task.status = 'completed'
          task.stage = this.translate(task.language)('canvas.skills.stageDone')
          task.phase = undefined
          pptActivity(task, task.stage, 'done')
        }
      } catch (error) {
        if (!cancelled()) {
          task.status = 'failed'
          task.error = messageOf(error)
          task.phase = undefined
          pptActivity(task, this.translate(task.language)('ppt.activityFailed'), 'warning')
        }
      } finally {
        task.finishedAt = Date.now()
        this.cancellers.delete(task.id)
        await this.persistPpt(task)
      }
    }
    const next = this.tail.then(run, run)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private pruneTasks(): void {
    if (this.tasks.size <= MAX_TRACKED_TASKS) return
    const finished = [...this.tasks.values()]
      .filter(task => task.finishedAt !== undefined)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    for (const task of finished.slice(0, this.tasks.size - MAX_TRACKED_TASKS)) this.tasks.delete(task.id)
  }

  // ------------------------------------------------------------- light tier

  private async runLight(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    const chat = this.backend.chat
    if (chat === undefined) throw new Error(t('canvas.skills.noChat'))
    task.stage = t('canvas.skills.stageReading')
    task.phase = 'running'
    await this.loadAssets(inputs)
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    // Extraction reads the file itself; every other built-in asks the model.
    if (skill.id === BUILTIN_EXTRACT && target.node.type === 'file') {
      return this.runBuiltinExtract(target, skill, t)
    }
    // Extraction from an image (or from several selected nodes) has no text
    // decoder to rely on, so it degrades to handing the collected content to
    // the model — same path an external light skill takes.
    if (skill.id === BUILTIN_EXTRACT) {
      return this.runCollectedLight(target, inputs, skill, t)
    }
    if (skill.id === BUILTIN_DESCRIBE) return this.runBuiltinDescribe(target, inputs, skill, chat, t)
    if (skill.id === BUILTIN_POLISH) return this.runBuiltinPolish(target, skill, request, chat, t)
    return this.runExternalLight(target, inputs, skill, request, chat, t)
  }

  /** Read the asset bytes for every image/file input once. */
  private async loadAssets(inputs: RunInput[]): Promise<void> {
    const canvas = this.backend.canvas
    const pending = inputs.filter(input => input.asset !== undefined && input.data === undefined)
    if (pending.length === 0) return
    const refs = pending.map(input => input.asset!).filter(ref => ref.assetId !== '')
    const found = await canvas.readAssets(refs)
    for (const input of pending) {
      const asset = input.asset!
      const hit = found.get(asset.assetId)
      if (hit !== undefined) input.data = hit.data
    }
  }

  private runBuiltinExtract(target: RunInput, skill: CanvasSkillDescriptor, t: CatalogTranslate): CanvasSkillOutput {
    const asset = target.asset
    if (asset === undefined || target.data === undefined) throw new Error(t('canvas.skills.fileMissing'))
    const name = asset.name ?? asset.assetId
    const extracted = extractFileText(target.data, name, asset.mime)
    const warnings = [
      ...extracted.warning === undefined ? [] : [extracted.warning],
      ...extracted.truncated ? [t('canvas.skills.truncated', { count: MAX_EXTRACTED_CHARS })] : [],
    ]
    if (!extracted.supported) throw new Error(extracted.warning ?? t('canvas.skills.extractFailed'))
    const sourceIds = [target.node.id]
    const node = textOutputNode(
      target.node,
      t('canvas.skills.extractNodeTitle', { name }),
      extracted.text,
      skill.id,
      skill.name,
      sourceIds,
    )
    const connection: CanvasConnection = { id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }
    return outputOf([node], [connection], warnings)
  }

  /** Collect text from every input and hand it to the model in one shot. Used
   *  when a built-in cannot decode the input itself (image extraction). */
  private runCollectedLight(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    t: CatalogTranslate,
  ): CanvasSkillOutput {
    const subject = inputs.find(input => input.node.id === target.node.id) ?? inputs[0]!
    const pieces: string[] = []
    const warnings: string[] = []
    for (const input of inputs) {
      const text = nodeText(input.node)
      if (text !== '') { pieces.push(text); continue }
      const asset = input.asset
      if (asset === undefined || input.data === undefined) continue
      const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime)
      if (extracted.supported && extracted.text !== '') pieces.push(extracted.text)
      else if (extracted.warning !== undefined) warnings.push(extracted.warning)
    }
    if (pieces.length === 0) throw new Error(t('canvas.skills.nothingToRead'))
    const joined = pieces.join('\n\n---\n\n')
    const head = t('canvas.skills.summaryHead', { count: pieces.length })
    const text = `${head}\n\n${joined.slice(0, MAX_EXTRACTED_CHARS)}`
    const node = textOutputNode(subject.node, skill.name, text, skill.id, skill.name, [subject.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: subject.node.id, toNodeId: node.id }], warnings)
  }

  private async runBuiltinDescribe(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const images = inputs.filter(input => input.node.type === 'image' && input.asset !== undefined && isImageAsset(input.asset!))
    if (images.length === 0) throw new Error(t('canvas.skills.needImage'))
    const parts: SkillChatPart[] = [{ type: 'text', text: t('canvas.skills.describeAsk', { count: images.length }) }]
    for (const input of images.slice(0, MAX_VISION_IMAGES)) {
      if (input.data === undefined) continue
      parts.push({ type: 'image_url', image_url: { url: `data:${baseMime(input.asset!.mime)};base64,${input.data.toString('base64')}` } })
    }
    const answer = await chat.complete({ system: describeSystem(currentSkillLanguage()), content: parts, temperature: 0.3 })
    const warnings = images.length > MAX_VISION_IMAGES ? [t('canvas.skills.tooManyImages', { count: MAX_VISION_IMAGES })] : []
    const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }], warnings)
  }

  private async runBuiltinPolish(
    target: RunInput,
    skill: CanvasSkillDescriptor,
    request: CanvasSkillRunRequest,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const original = nodeText(target.node)
    if (original === '') throw new Error(t('canvas.skills.needText'))
    const style = (request.params?.style ?? 'formal').trim()
    const language = currentSkillLanguage()
    const english = !(language.startsWith('zh') || language === '')
    const directive = style === 'custom'
      ? (request.instruction ?? '').trim()
      : (POLISH_DIRECTIVES[style] ?? POLISH_DIRECTIVES.formal!)[english ? 'en' : 'zh']
    if (directive === '') throw new Error(t('canvas.skills.needInstruction'))
    const system = english
      ? 'You are a text editor. Rewrite the user text following the instruction exactly. Preserve the original language and every fact. Return only the rewritten text — no preface, no quotes, no markdown fences.'
      : '你是文字编辑。请严格按指令改写用户提供的文本，保持原语言与全部事实不变。只输出改写后的正文，不要任何说明、引号或 markdown 代码块。'
    const answer = await chat.complete({ system, content: `${directive}\n\n---\n${original}`, temperature: 0.4 })
    const node = textOutputNode(target.node, t('canvas.skills.polishNodeTitle', { style: t(`canvas.polish.${style}`) }), answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }])
  }

  /** External skill through the light tier: skill body in, answer out. */
  private async runExternalLight(
    target: RunInput,
    inputs: RunInput[],
    skill: CanvasSkillDescriptor,
    request: CanvasSkillRunRequest,
    chat: SkillChatBackend,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const registry = this.backend.registry
    const name = skill.id.startsWith('skill:') ? skill.id.slice('skill:'.length) : skill.id
    const definition = registry === undefined ? undefined : await registry.get(name)
    const warnings: string[] = []
    const sections: string[] = []
    if (definition !== undefined && definition.content.trim() !== '') sections.push(definition.content.trim())
    // Values the skill's declaration marks exposable ride the prompt; secrets
    // never do (the host filters them out before handing the block over).
    const configNote = await this.backend.skillConfig?.note(name).catch(() => undefined)
    if (configNote !== undefined && configNote !== '') sections.push(`${t('canvas.skills.configHeader')}\n${configNote}`)
    for (const input of inputs) {
      const text = nodeText(input.node)
      if (text !== '') {
        sections.push(`### ${nodeTitle(input.node)}\n${text.slice(0, MAX_INLINE_TEXT)}`)
        continue
      }
      const asset = input.asset
      if (asset === undefined || input.data === undefined) continue
      const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime)
      if (extracted.supported && extracted.text !== '') sections.push(`### ${asset.name ?? nodeTitle(input.node)}\n${extracted.text.slice(0, MAX_INLINE_TEXT)}`)
      else if (extracted.warning !== undefined) warnings.push(extracted.warning)
    }
    const parts: SkillChatPart[] = [{ type: 'text', text: this.externalUserPrompt(skill, sections, request, t) }]
    for (const input of inputs) {
      const asset = input.asset
      if (asset === undefined || input.data === undefined || !isImageAsset(asset)) continue
      if (parts.length > MAX_VISION_IMAGES) { warnings.push(t('canvas.skills.tooManyImages', { count: MAX_VISION_IMAGES })); break }
      parts.push({ type: 'image_url', image_url: { url: `data:${baseMime(asset.mime)};base64,${input.data.toString('base64')}` } })
    }
    const answer = await chat.complete({
      system: t('canvas.skills.externalSystem', { name: skill.name }),
      content: parts,
      temperature: 0.35,
    })
    const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id])
    return outputOf([node], [{ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id }], warnings)
  }

  private externalUserPrompt(
    skill: CanvasSkillDescriptor,
    sections: string[],
    request: CanvasSkillRunRequest,
    t: CatalogTranslate,
  ): string {
    const header = t('canvas.skills.externalHeader', { name: skill.name })
    const instruction = (request.instruction ?? '').trim()
    return [
      header,
      ...instruction === '' ? [] : ['', t('canvas.skills.extraInstruction'), instruction],
      '',
      t('canvas.skills.inputsHeader'),
      ...sections.length === 0 ? [t('canvas.skills.inputsEmpty')] : sections,
    ].join('\n')
  }

  // ------------------------------------------------------------- heavy tier

  private async runHeavy(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    const agents = this.backend.agents
    if (agents === undefined || !agents.available()) throw new Error(t('canvas.skills.needAgent'))
    const canvas = this.backend.canvas
    const document = await canvas.read(request.canvasId)
    const target = inputs.find(input => request.nodeIds.includes(input.node.id)) ?? inputs[0]!
    const runRoot = this.options.runRoot().trim() === '' ? path.join(this.options.dataRoot(), 'canvas', 'runs') : this.options.runRoot().trim()
    const runDir = path.join(runRoot, request.canvasId, task.id)
    if (task.canvasId === 'ppt') task.runDirectory = runDir
    const inputDir = path.join(runDir, 'input')
    const outputDir = path.join(runDir, 'output')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.mkdir(outputDir, { recursive: true })

    task.stage = t('canvas.skills.stagePreparing')
    task.phase = 'preparing'
    pptActivity(task, task.stage)
    // Materialize every input that resolves to a real asset, so the agent works
    // on ordinary files (its tools read paths, not canvas asset ids).
    const fileLines: string[] = []
    const warnings: string[] = []
    let index = 0
    for (const input of inputs) {
      index += 1
      const asset = input.asset
      if (asset === undefined || asset.assetId === '') {
        const text = nodeText(input.node)
        if (text !== '') {
          const name = `${String(index).padStart(2, '0')}_${input.node.type}-${input.node.id}.md`
          await fs.writeFile(path.join(inputDir, name), text, 'utf8')
          fileLines.push(`- ${path.join(inputDir, name)}（文本节点内容）`)
        }
        continue
      }
      const original = asset.name ?? `${asset.assetId}`
      const safe = original.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'input'
      const name = `${String(index).padStart(2, '0')}_${safe}`
      const target2 = path.join(inputDir, name)
      await canvas.materialize(asset, target2)
      fileLines.push(`- ${target2}`)
    }
    if (fileLines.length === 0) throw new Error(t('canvas.skills.noInput'))
    task.stage = t('canvas.skills.stagePrepared', { count: fileLines.length })
    pptActivity(task, task.stage)

    const skillName = this.heavySkillName(skill)
    const body = await this.loadSkillBody(skillName)
    // A heavy built-in without its host skill cannot run at all: fail with an
    // actionable message instead of starting an agent that has nothing to do.
    if (body === undefined) throw new Error(t('canvas.skills.skillMissing', { name: skillName }))
    // Exposable declared values (secrets filtered host-side) tell the agent what
    // is already configured, so it does not hunt for settings it already has.
    const configNote = await this.backend.skillConfig?.note(skillName).catch(() => undefined)
    const definition = await this.backend.registry?.list().then(items => items.find(item => item.name === skillName)).catch(() => undefined)
    const command = task.canvasId === 'ppt' ? await this.options.pptCommand?.() : undefined
    const systemPrompt = [this.heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote),
      ...definition?.path === undefined ? [] : [`Skill entry path: ${JSON.stringify(definition.path)}. Resolve every skill-local reference, prompt builder and CLI source relative to its directory.`],
      ...task.canvasId !== 'ppt' ? [] : [
        'This is an image-to-editable-PPT conversion explicitly requested by the user. Follow the installed upstream skill unchanged; do not design a replacement pipeline.',
        'The input order is the slide order. Use the original images as source slides. Copy ONLY the validated final deck, final previews and validation report to the output directory. Do not copy intermediate page decks as final decks. If finalize cannot pass, report failure; never substitute a full-slide raster.',
        `Runtime CLI: ${JSON.stringify(command ?? 'editppt')}. Use this executable for editppt commands; add its parent directory to your shell PATH for upstream helpers.`,
        request.instruction ?? '',
      ],
    ].join('\n\n')
    task.stage = t('canvas.skills.stageRunning')
    task.phase = 'running'
    const controller = new AbortController()
    const timeout = this.options.heavyTimeoutMs()
    /** Whether the abort came from the watchdog, so the copy can say so. */
    let timedOut = false
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; controller.abort() }, timeout) : undefined
    timer?.unref?.()
    let handle: SkillAgentHandle | undefined
    const cancelled = (): boolean => task.status === 'cancelled'
    try {
      if (cancelled()) throw new Error(t('canvas.skills.stageCancelled'))
      const sessionId = newId('skillagent')
      if (task.canvasId === 'ppt') { task.agentSessionId = sessionId; await this.persistPpt(task) }
      pptActivity(task, t('ppt.activityAgent'))
      handle = await agents.create({
        sessionId,
        cwd: runDir,
        systemPrompt,
        signal: controller.signal,
        fail: key => t(key),
      })
      if (handle === undefined) throw new Error(t('canvas.skills.agentFailed'))
      if (cancelled()) { handle.cancel(); throw new Error(t('canvas.skills.stageCancelled')) }
      this.cancellers.set(task.id, {
        dispose: async () => {
          // Aborting is what reaches the agent: the listener above calls
          // `cancel()` exactly once, for both the user's cancel and the watchdog.
          controller.abort()
          await handle?.dispose().catch(() => { /* best effort */ })
        },
      })
      handle.followup(this.heavyUserPrompt(skill, skillName, inputDir, outputDir, body !== undefined, t))
      // An abort must reach the adapter, not just the waiting promise.
      controller.signal.addEventListener('abort', () => { handle?.cancel() }, { once: true })
      // The agent thinks for minutes on a deck pipeline; the only honest live
      // signal is what it has already written into the output directory.
      const progress = task.canvasId === 'ppt' ? new PptProgressMonitor(task, handle.session, runDir, t) : undefined
      progress?.start()
      const watch = task.canvasId === 'ppt' ? undefined : this.watchOutputDir(task, outputDir, t)
      try {
        // `whenIdle` settles only when the agent goes quiet on its own. Without
        // racing the abort here, a wedged adapter (Windows sandbox failures did
        // exactly this) holds the serial queue and the task reads "running"
        // past its own timeout, blocking every later canvas skill.
        await Promise.race([
          handle.whenIdle(),
          new Promise<never>((_resolve, reject) => {
            const fail = (): void => reject(new Error(timedOut
              ? t('ppt.timeout', { minutes: String(Math.max(1, Math.round(timeout / 60_000))) })
              : t('canvas.skills.stageCancelled')))
            if (controller.signal.aborted) fail()
            else controller.signal.addEventListener('abort', fail, { once: true })
          }),
        ])
      } finally {
        watch?.stop()
        await progress?.stop()
      }
      if (timedOut) throw new Error(t('ppt.timeout', { minutes: String(Math.max(1, Math.round(timeout / 60_000))) }))
      if (cancelled()) throw new Error(t('canvas.skills.stageCancelled'))
      task.stage = t('canvas.skills.stageCollecting')
      task.phase = 'collecting'
      pptActivity(task, task.stage)
      const failure = agentSessionFailure(handle.session)
      if (failure !== undefined) throw new Error(t('ppt.agentFailed', { error: failure }))
      const answer = lastAssistantText(handle.session.deriveMessages())
      if (task.canvasId === 'ppt') await this.recoverFinalizedPpt(runDir, outputDir, task.pptImages?.length ?? 0)
      return await this.collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      await handle?.dispose().catch(() => { /* best effort */ })
    }
  }

  /**
   * Host-driven deck conversion (see `docs/ppt-local-pipeline.md`).
   *
   * This is the path that must work on a desktop install where a headless agent
   * cannot even start a shell: every deterministic step runs through the
   * upstream `editppt` CLI inside this process, and the model is asked for
   * exactly one thing per page - what the slide contains. Nothing reaches the
   * canvas until the deck passes the single acceptance gate at the end, so a
   * full-page screenshot can never be delivered as an "editable" result.
   */
  private async runPptLocal(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    inputs: RunInput[],
    request: CanvasSkillRunRequest,
  ): Promise<CanvasSkillOutput> {
    const t = this.translate(task.language)
    const chat = this.backend.chat
    if (chat === undefined) throw new Error(t('canvas.skills.noChat'))
    if (this.options.deckChatReady?.() === false) throw new Error(t('ppt.noVisionModel'))
    const canvas = this.backend.canvas
    const runRoot = this.options.runRoot().trim() === '' ? path.join(this.options.dataRoot(), 'canvas', 'runs') : this.options.runRoot().trim()
    const runDir = path.join(runRoot, request.canvasId, task.id)
    task.runDirectory = runDir
    const inputDir = path.join(runDir, 'input')
    await fs.mkdir(inputDir, { recursive: true })
    task.phase = 'preparing'
    task.stage = t('canvas.skills.stagePreparing')
    pptActivity(task, task.stage)
    const files: Array<{ path: string; name: string }> = []
    let index = 0
    for (const input of inputs) {
      index += 1
      const asset = input.asset
      if (asset === undefined || !isImageAsset(asset)) throw new Error(t('ppt.invalidImage'))
      const name = `${String(index).padStart(2, '0')}_${safeFileName(asset.name ?? asset.assetId)}`
      const target = path.join(inputDir, name)
      await canvas.materialize(asset, target)
      files.push({ path: target, name })
    }
    task.stage = t('canvas.skills.stagePrepared', { count: files.length })
    pptActivity(task, task.stage)
    await this.persistPpt(task)

    const limits = this.options.deckLimits?.() ?? { concurrency: 2, pageBudgetMs: 360_000 }
    const controller = new AbortController()
    this.cancellers.set(task.id, { dispose: async () => { controller.abort() } })
    if (task.status === 'cancelled') throw new Error(t('canvas.skills.stageCancelled'))
    task.phase = 'running'
    task.stage = t('canvas.skills.stageRunning')
    const command = await this.options.pptCommand?.() ?? 'editppt'
    const result = await runDeckPipeline(files, runDir, {
      offlineOcr: request.offlineOcr ?? false,
      language: task.language ?? '',
    }, {
      editppt: async () => command,
      run: async (argv, options) => {
        if (controller.signal.aborted) throw new Error(t('canvas.skills.stageCancelled'))
        return await runCommand(argv, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? limits.pageBudgetMs })
      },
      chat,
      readSkillDoc: async relative => await this.options.pptSkillDoc?.(relative),
      concurrency: () => limits.concurrency,
      pageBudgetMs: () => limits.pageBudgetMs,
      onEvent: event => {
        // The pipeline reports copy keys (it stays presentation-free); resolve
        // them in the run's language so a Chinese user never sees `ppt.*`, and
        // pass any untranslated text through as-is.
        const label = /^(?:ppt|canvas)\.[A-Za-z]/.test(event.label)
          ? /\{page\}/.test(t(event.label)) ? t(event.label, { page: String(event.page ?? '') }) : t(event.label)
          : event.label
        pptActivity(task, label, event.state, event.time)
        if (event.page === undefined) return
        const progress = task.progress ??= { lastActivityAt: event.time, events: [] }
        const pages = progress.pages ??= []
        const found = pages.find(item => item.page === event.page)
        if (found === undefined) pages.push({ page: event.page, state: event.state === 'done' ? 'validated' : 'running' })
        else if (event.state === 'done') found.state = 'validated'
      },
      signal: controller.signal,
    })
    return await this.publishDeck(task, skill, inputs[0]!.node, inputs.map(input => input.node.id), result, files.length, t)
  }

  /**
   * Accept the finished deck, then publish it. One gate for both drivers, so a
   * file the agent chose to deliver is never trusted more than the upstream
   * validation report that says the pages are actually editable.
   */
  private async publishDeck(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    source: CanvasNode,
    sourceIds: string[],
    result: DeckPipelineResult,
    expectedSlides: number,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    task.phase = 'collecting'
    task.stage = t('canvas.skills.stageCollecting')
    pptActivity(task, t('ppt.activityAccepting'))
    const canvas = this.backend.canvas
    const deckBuffer = await fs.readFile(result.deckPath)
    const report = await readBoundedJson(result.reportPath)
    const decision = acceptDeck({
      inspection: inspectDeck(deckBuffer),
      expectedSlides,
      reportPassed: report?.passed === true,
    })
    if (!decision.ok) throw new Error(t('ppt.deckRejected', { reason: deckRejectText(t, decision.reason) }))
    const nodes: CanvasNode[] = []
    const connections: CanvasConnection[] = []
    const deckName = path.basename(result.deckPath)
    const deckAsset = await canvas.putFile({
      data: deckBuffer,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: deckName,
      origin: 'generated',
      originId: task.id,
    })
    const deckNode = fileOutputNode(source, deckAsset, deckName, skill.id, skill.name, sourceIds)
    nodes.push(deckNode)
    connections.push({ id: newId('edge'), fromNodeId: source.id, toNodeId: deckNode.id })
    for (const artifact of [...result.previews, ...(result.reportPath === undefined ? [] : [result.reportPath])]) {
      const data = await fs.readFile(artifact).catch(() => undefined)
      if (data === undefined || data.length === 0) continue
      const name = path.basename(artifact)
      const asset = await canvas.putFile({ data, mime: name.toLowerCase().endsWith('.json') ? 'application/json' : 'image/png', name, origin: 'generated', originId: task.id })
      const node = fileOutputNode(deckNode, asset, name, skill.id, skill.name, [deckNode.id])
      nodes.push(node)
      connections.push({ id: newId('edge'), fromNodeId: deckNode.id, toNodeId: node.id })
    }
    pptActivity(task, t('ppt.activityAccepted'), 'done')
    return outputOf(nodes, connections)
  }

  /**
   * Accept the agent driver's deck through the same gate as the local pipeline.
   *
   * The agent is told to copy only the validated final deck, but "told" is not
   * "verified": an earlier build published any `.pptx` whose slide count matched,
   * which let a deck of full-page screenshots finish as `completed`. Every
   * candidate must pass `acceptDeck` - valid package, page count, upstream
   * report `passed: true`, and real editable objects per page - before a single
   * byte is published, and the file named by `run_summary.json` wins when the
   * agent left an intermediate page deck beside the final one.
   */
  private async collectPptOutput(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    target: RunInput,
    outputDir: string,
    answer: string | undefined,
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    const files: Array<{ file: string; size: number }> = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { await walk(full, depth + 1); continue }
        if (!entry.isFile()) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (stat === undefined || stat.size === 0) continue
        files.push({ file: full, size: stat.size })
      }
    }
    await walk(outputDir, 0)
    const decks = files.filter(entry => entry.file.toLowerCase().endsWith('.pptx')).sort((a, b) => b.size - a.size)
    const expectedSlides = task.pptImages?.length ?? 0
    if (decks.length === 0) {
      throw new Error([t('ppt.noDeck'), answer?.trim() || t('ppt.noAgentReply')].filter(Boolean).join('\n'))
    }
    const reportFile = files.find(entry => path.basename(entry.file).toLowerCase() === 'validation.json')
    const summaryFile = files.find(entry => path.basename(entry.file).toLowerCase() === 'run_summary.json')
    const report = reportFile === undefined ? undefined : await readBoundedJson(reportFile.file)
    const summary = summaryFile === undefined ? undefined : await readBoundedJson(summaryFile.file)
    // Upstream `run finalize` always writes this report. A deck delivered
    // without it (or with `passed: false`) is not an accepted conversion - the
    // file the agent chose says nothing about the objects inside it.
    if (reportFile === undefined || report?.passed !== true) {
      throw new Error([
        t('ppt.deckRejected', { reason: deckRejectText(t, 'report-not-passed') }),
        answer?.trim() ?? '',
      ].filter(Boolean).join('\n'))
    }
    const named = typeof summary?.output === 'string' ? path.basename(summary.output).toLowerCase() : undefined
    const ordered = named === undefined
      ? decks
      : [...decks].sort((a, b) => Number(path.basename(b.file).toLowerCase() === named) - Number(path.basename(a.file).toLowerCase() === named))
    let lastReason: string | undefined
    for (const candidate of ordered) {
      const buffer = await fs.readFile(candidate.file).catch(() => undefined)
      if (buffer === undefined) continue
      const decision = acceptDeck({ inspection: inspectDeck(buffer), expectedSlides, reportPassed: report?.passed === true })
      if (!decision.ok) { lastReason = decision.reason; continue }
      const previews = files
        .filter(entry => /\.png$/i.test(entry.file) && path.basename(entry.file).toLowerCase().includes('preview'))
        .map(entry => entry.file)
      const result: DeckPipelineResult = {
        deckPath: candidate.file,
        reportPath: reportFile.file,
        runSummaryPath: summaryFile?.file ?? candidate.file,
        previews,
        pages: [],
        runDirectory: path.dirname(outputDir),
      }
      return await this.publishDeck(task, skill, target.node, [target.node.id], result, expectedSlides, t)
    }
    throw new Error([
      t('ppt.deckRejected', { reason: deckRejectText(t, (lastReason ?? 'invalid-package') as DeckRejection) }),
      answer?.trim() ?? '',
    ].filter(Boolean).join('\n'))
  }

  /** Report newly produced output files on the task while the agent works, so
   *  the canvas run card shows "已产出 N 个文件" instead of a silent spinner. */
  private watchOutputDir(task: CanvasSkillTask, outputDir: string, t: CatalogTranslate): { stop: () => void } {
    let seen = -1
    const timer = setInterval(() => {
      void fs.readdir(outputDir, { recursive: true, withFileTypes: true }).then(entries => {
        const count = entries.filter(entry => entry.isFile()).length
        if (count === 0 || count === seen) return
        seen = count
        task.stage = t('canvas.skills.stageArtifacts', { count })
      }).catch(() => { /* the directory outlives the run; nothing to report */ })
    }, 2_000)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  }

  /** The host skill name a heavy built-in maps to (the deck pipeline). */
  private heavySkillName(skill: CanvasSkillDescriptor): string {
    if (skill.id.startsWith('skill:')) return skill.id.slice('skill:'.length)
    if (skill.id === BUILTIN_PPT) return EDITABLE_PPT_SKILL
    return skill.name
  }

  private async loadSkillBody(name: string): Promise<string | undefined> {
    const registry = this.backend.registry
    if (registry === undefined) return undefined
    const definition = await registry.get(name).catch(() => undefined)
    if (definition === undefined || definition.content.trim() === '') return undefined
    return definition.content
  }

  private heavySystemPrompt(
    skill: CanvasSkillDescriptor,
    body: string | undefined,
    fileLines: string[],
    outputDir: string,
    t: CatalogTranslate,
    configNote?: string,
  ): string {
    return [
      t('canvas.skills.heavyIntro', { name: skill.name }),
      ...body === undefined ? [] : ['', t('canvas.skills.heavyBodyHeader'), body],
      ...configNote === undefined || configNote === '' ? [] : ['', t('canvas.skills.configHeader'), configNote],
      '',
      t('canvas.skills.heavyInputsHeader'),
      ...fileLines,
      '',
      t('canvas.skills.heavyOutputHeader', { dir: outputDir }),
      t('canvas.skills.heavyRules'),
    ].join('\n')
  }

  private heavyUserPrompt(
    skill: CanvasSkillDescriptor,
    skillName: string,
    inputDir: string,
    outputDir: string,
    hasBody: boolean,
    t: CatalogTranslate,
  ): string {
    return [
      t('canvas.skills.heavyAsk', { name: skill.name }),
      '',
      t('canvas.skills.heavyAskInputs', { dir: inputDir }),
      t('canvas.skills.heavyAskOutput', { dir: outputDir }),
      ...hasBody ? [] : ['', t('canvas.skills.heavyAskLoadSkill', { name: skillName })],
    ].join('\n')
  }

  /** Upstream finalize writes final/run_summary.json outside our output folder.
   * Collect only a completed, validated final deck; never an intermediate page. */
  private async recoverFinalizedPpt(runDir: string, outputDir: string, pageCount: number): Promise<void> {
    const root = await fs.realpath(runDir)
    const inside = (file: string): boolean => file.startsWith(root + path.sep)
    const resolveFile = async (raw: string, base: string): Promise<string | undefined> => {
      const file = await fs.realpath(path.resolve(base, raw)).catch(() => undefined)
      return file !== undefined && inside(file) ? file : undefined
    }
    const boundedJson = async (file: string): Promise<Record<string, unknown> | undefined> => {
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return undefined
      const value = await fs.readFile(file, 'utf8').then(raw => JSON.parse(raw)).catch(() => undefined)
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    }
    let inspected = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 7 || inspected > 2000) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (++inspected > 2000) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !['input', 'pages', 'node_modules', '.venv'].includes(entry.name)) { await walk(full, depth + 1); continue }
        if (!entry.isFile() || entry.name !== 'run_summary.json') continue
        const summary = await boundedJson(full)
        if (summary?.status !== 'complete' || summary.page_count !== pageCount || typeof summary.output !== 'string' || typeof summary.validation !== 'string') continue
        const deck = await resolveFile(summary.output, dir)
        const report = await resolveFile(summary.validation, dir)
        if (deck === undefined || report === undefined || !deck.toLowerCase().endsWith('.pptx')) continue
        const validation = await boundedJson(report)
        if (validation?.passed !== true) continue
        const size = await fs.stat(deck)
        if (!size.isFile() || size.size === 0 || size.size > 64 * 1024 * 1024) continue
        const target = path.join(outputDir, path.basename(deck))
        // A deck already delivered explicitly is authoritative; don't overwrite it.
        if (!(await fs.stat(target).then(() => true, () => false))) await fs.copyFile(deck, target)
        await fs.copyFile(report, path.join(outputDir, 'validation.json'))
        await fs.copyFile(full, path.join(outputDir, 'run_summary.json'))
      }
    }
    const delivered = await fs.readdir(outputDir).then(names => names.some(name => name.toLowerCase().endsWith('.pptx')))
    if (!delivered) await walk(runDir, 0)
  }

  private async collectHeavyOutput(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    target: RunInput,
    outputDir: string,
    answer: string | undefined,
    warnings: string[],
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
    // Deck runs never take the "any .pptx in the folder counts as success"
    // shortcut: they go through the same acceptance gate as the local pipeline.
    if (task.canvasId === 'ppt') return await this.collectPptOutput(task, skill, target, outputDir, answer, t)
    const canvas = this.backend.canvas
    const files: Array<{ file: string; size: number }> = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { await walk(full, depth + 1); continue }
        if (!entry.isFile()) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (stat === undefined || stat.size === 0) continue
        files.push({ file: full, size: stat.size })
      }
    }
    await walk(outputDir, 0)
    const nodes: CanvasNode[] = []
    const connections: CanvasConnection[] = []
    for (const found of files.sort((a, b) => a.file.localeCompare(b.file))) {
      const data = await fs.readFile(found.file).catch(() => undefined)
      if (data === undefined) continue
      const name = path.basename(found.file)
      const asset = await canvas.putFile({
        data,
        mime: mimeFromName(name),
        name,
        origin: 'generated',
        originId: task.id,
      })
      const node = fileOutputNode(target.node, asset, name, skill.id, skill.name, [target.node.id])
      nodes.push(node)
      connections.push({ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id })
    }
    if (nodes.length === 0) {
      // The skill finished without a file: keep the agent's answer so the run
      // is not a silent no-op.
      const text = answer ?? ''
      if (text !== '') {
        const node = textOutputNode(target.node, skill.name, text, skill.id, skill.name, [target.node.id])
        nodes.push(node)
        connections.push({ id: newId('edge'), fromNodeId: target.node.id, toNodeId: node.id })
      }
      warnings.push(t('canvas.skills.noOutputFile'))
    }
    return outputOf(nodes, connections, warnings)
  }

  /**
   * Resolve copy for one run's language, falling back to the host-installed
   * resolver when the caller sent none.
   * @param language - the caller's UI language, when it sent one.
   */
  private translate(language?: string): CatalogTranslate {
    return canvasSkillCopy(language)
  }
}

/** Minimal extension→MIME map for produced files (the store validates again). */
function mimeFromName(name: string): string {
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  switch (extension) {
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'pdf': return 'application/pdf'
    case 'json': return 'application/json'
    case 'csv': return 'text/csv'
    case 'md': return 'text/markdown'
    case 'txt': return 'text/plain'
    case 'zip': return 'application/zip'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

/** Copy resolver shared with the browser bundle (see locale-tables.ts). */
let translateHook: (key: string, params: Record<string, string | number> | undefined, language: string) => string = key => key
/** Install the real copy resolver (host half wires the locale dictionaries). */
export function setSkillTranslate(hook: typeof translateHook): void {
  translateHook = hook
}
function translateCanvasSkill(key: string, params: Record<string, string | number> | undefined, language: string): string {
  return translateHook(key, params, language)
}

/**
 * Active UI language for host-rendered copy. A run request carries no locale, so
 * the host half installs a resolver here; without one the host answers in
 * English (the browser half always renders its own copy through `tt`).
 */
let languageHook: () => string = () => 'en'
/** Install the active-language resolver. */
export function setSkillLanguage(hook: () => string): void {
  languageHook = hook
}
function currentSkillLanguage(): string {
  try { return languageHook() } catch { return 'zh' }
}

/**
 * Copy resolver for host-rendered canvas copy outside a run (the skill library
 * panel): the caller's language wins, the installed language resolver backs it
 * up, exactly as {@link SkillRunner.translate} does for runs.
 * @param language - the caller's UI language, when it sent one.
 */
export function canvasSkillCopy(language?: string): CatalogTranslate {
  const preferred = language !== undefined && language !== '' ? language : undefined
  return (key, params) => translateCanvasSkill(key, params, preferred ?? currentSkillLanguage())
}

export { isEditablePptSkill }

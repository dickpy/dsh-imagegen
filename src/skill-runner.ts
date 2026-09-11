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
} from './protocol.ts'
import { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
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
  deriveMessages: () => readonly unknown[]
}

/** A live headless agent owned by one skill run. */
export interface SkillAgentHandle {
  session: SkillAgentSession
  followup: (text: string) => void
  whenIdle: () => Promise<void>
  cancel: (reason?: string) => void
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

/** Everything one runner needs, injected so tests can replace any layer. */
export interface SkillRunnerBackend {
  chat?: SkillChatBackend
  registry?: SkillRegistryBackend
  agents?: SkillAgentBackend
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

// ---------------------------------------------------------------- runner

export class SkillRunner {
  private readonly tasks = new Map<string, CanvasSkillTask>()
  private readonly cancellers = new Map<string, { dispose: () => Promise<void> }>()
  private tail: Promise<void> = Promise.resolve()
  private backend: SkillRunnerBackend

  constructor(private readonly options: SkillRunnerOptions) {
    this.backend = { ...options.backend }
  }

  /**
   * Attach or replace the optional host seams (skill registry, agent runtime).
   * Called from the plugin's soft injection once those services exist, and with
   * an empty object when they unload. The chat and canvas seams are never
   * replaced here.
   * @param parts - the seams to adopt; omitted keys are cleared.
   */
  attach(parts: { registry?: SkillRegistryBackend; agents?: SkillAgentBackend }): void {
    this.backend.registry = parts.registry
    this.backend.agents = parts.agents
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
    return {
      skills: canvasSkillCatalog(external, t, {
        agentAvailable,
        ...this.options.pptInstallUrl === undefined ? {} : { pptInstallUrl: this.options.pptInstallUrl },
      }),
      agentAvailable,
      registryAvailable,
      installed: external.map(skill => skill.name),
      ...reason === undefined ? {} : { reason },
      ...agentAvailable ? {} : { reason: reason ?? t('canvas.skills.needAgent') },
    }
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

    const language = request.language
    const task: CanvasSkillTask = {
      id: newId('skillrun'),
      canvasId: request.canvasId,
      skillId: skill.id,
      label: skill.name,
      tier: skill.tier,
      status: 'queued',
      stage: this.translate(language)('canvas.skills.stageQueued'),
      startedAt: Date.now(),
      ...language === undefined || language === '' ? {} : { language },
    }
    this.tasks.set(task.id, task)
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

  /** Cancel a queued or running task. */
  async cancel(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (task === undefined) return false
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
    task.status = 'cancelled'
    task.stage = this.translate(task.language)('canvas.skills.stageCancelled')
    task.finishedAt = Date.now()
    const canceller = this.cancellers.get(id)
    this.cancellers.delete(id)
    if (canceller !== undefined) await canceller.dispose().catch(() => { /* best effort */ })
    return true
  }

  private enqueue(task: CanvasSkillTask, skill: CanvasSkillDescriptor, inputs: RunInput[], request: CanvasSkillRunRequest): Promise<void> {
    const cancelled = (): boolean => this.tasks.get(task.id)?.status === 'cancelled'
    const run = async (): Promise<void> => {
      if (cancelled()) return
      task.status = 'running'
      try {
        task.output = skill.tier === 'heavy'
          ? await this.runHeavy(task, skill, inputs, request)
          : await this.runLight(task, skill, inputs, request)
        if (!cancelled()) {
          task.status = 'completed'
          task.stage = this.translate(task.language)('canvas.skills.stageDone')
        }
      } catch (error) {
        if (!cancelled()) {
          task.status = 'failed'
          task.error = messageOf(error)
        }
      } finally {
        task.finishedAt = Date.now()
        this.cancellers.delete(task.id)
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
    const inputDir = path.join(runDir, 'input')
    const outputDir = path.join(runDir, 'output')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.mkdir(outputDir, { recursive: true })

    task.stage = t('canvas.skills.stagePreparing')
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

    const skillName = this.heavySkillName(skill)
    const body = await this.loadSkillBody(skillName)
    // A heavy built-in without its host skill cannot run at all: fail with an
    // actionable message instead of starting an agent that has nothing to do.
    if (body === undefined) throw new Error(t('canvas.skills.skillMissing', { name: skillName }))
    const systemPrompt = this.heavySystemPrompt(skill, body, fileLines, outputDir, t)
    task.stage = t('canvas.skills.stageRunning')
    const controller = new AbortController()
    const timeout = this.options.heavyTimeoutMs()
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined
    timer?.unref?.()
    let handle: SkillAgentHandle | undefined
    try {
      handle = await agents.create({
        sessionId: newId('skillagent'),
        cwd: runDir,
        systemPrompt,
        signal: controller.signal,
      })
      if (handle === undefined) throw new Error(t('canvas.skills.agentFailed'))
      this.cancellers.set(task.id, {
        dispose: async () => {
          controller.abort()
          handle?.cancel('canvas-skill-cancelled')
          await handle?.dispose().catch(() => { /* best effort */ })
        },
      })
      handle.followup(this.heavyUserPrompt(skill, skillName, inputDir, outputDir, body !== undefined, t))
      await handle.whenIdle()
      task.stage = t('canvas.skills.stageCollecting')
      const answer = lastAssistantText(handle.session.deriveMessages())
      return await this.collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      await handle?.dispose().catch(() => { /* best effort */ })
    }
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
  ): string {
    return [
      t('canvas.skills.heavyIntro', { name: skill.name }),
      ...body === undefined ? [] : ['', t('canvas.skills.heavyBodyHeader'), body],
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

  private async collectHeavyOutput(
    task: CanvasSkillTask,
    skill: CanvasSkillDescriptor,
    target: RunInput,
    outputDir: string,
    answer: string | undefined,
    warnings: string[],
    t: CatalogTranslate,
  ): Promise<CanvasSkillOutput> {
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
    const preferred = language !== undefined && language !== '' ? language : undefined
    return (key, params) => translateCanvasSkill(key, params, preferred ?? currentSkillLanguage())
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

export { isEditablePptSkill }

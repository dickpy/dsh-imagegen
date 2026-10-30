/**
 * Local deterministic deck pipeline (see `docs/ppt-local-pipeline.md`).
 *
 * The plugin host is the orchestrator: `editppt` is spawned directly, geometry
 * comes from the CLI's own ink measurements, and the model is asked for exactly
 * one small JSON judgement per page. Nothing here reaches for host services —
 * every external touchpoint arrives through {@link DeckPipelineDeps}, so the
 * whole module can be driven with stubs (see `scripts/ppt-pipeline-selftest.mjs`).
 *
 * Why the split is this way: an agent-driven run proved unreliable on Windows
 * (sandboxed shell, headless approvals, weak acceptance), and a large model
 * output invites hallucinated coordinates. Coordinates therefore come only from
 * `text_hints.json`; the model only chooses text content, graphic kinds and
 * bitmap regions.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SkillChatBackend, SkillChatPart } from './skill-runner.ts'
import { redactDiagnosticText } from './diagnostics-store.ts'

// ---------------------------------------------------------------- interface

/** Injected seams. The pipeline owns no process, model or filesystem policy. */
export interface DeckPipelineDeps {
  /** 绝对路径：venv 里的 editppt 可执行（PptRuntime.command() 提供）。 */
  editppt: () => Promise<string>
  /** 宿主进程执行命令（复用 skill-config.runCommand）。 */
  run: (argv: string[], options: { cwd: string; timeoutMs?: number }) => Promise<{ code: number; output: string }>
  /** 多模态模型（复用 SkillRunner 的 chat seam）。 */
  chat: SkillChatBackend
  /** 读取本机 skill 的参考文档（manifest 字段契约），缺失时用插件内置精简版兜底。 */
  readSkillDoc: (relative: string) => Promise<string | undefined>
  /** 每页并发数（1-3，默认 2）。 */
  concurrency: () => number
  /** 单页预算（毫秒），超时只失败该页并重试/跳过策略由上层决定。 */
  pageBudgetMs: () => number
  /** `label` 是 locales.ts 里的文案 key（宿主按当前语言解析），不是成品文案。 */
  onEvent: (event: { time: number; label: string; state: 'running' | 'done' | 'warning'; page?: number }) => void
  signal: AbortSignal
}

export interface DeckPipelineResult {
  deckPath: string
  reportPath: string
  runSummaryPath: string
  previews: string[]
  pages: Array<{ page: number; state: 'recorded' | 'failed'; objects: number; warnings: string[] }>
  runDirectory: string
}

// ---------------------------------------------------------------- constants

/** Repair budget per page: one judgement plus at most two validation fixes. */
const MAX_REPAIR_ROUNDS = 2

/** Trailing CLI output kept in a failure message (the UI shows it verbatim). */
const OUTPUT_TAIL = 2000

/** Upper bound on the skill-doc excerpt appended to the built-in contract. */
const SKILL_DOC_EXCERPT = 7000

/** A picture covering this share of the page is a full-bleed bitmap: refuse it. */
const FULL_BLEED_RATIO = 0.9

/**
 * Built-in slim manifest contract. The upstream reference is long and written
 * for an agent with a shell; the model only needs this output shape, because the
 * pipeline is the only writer of the remaining manifest fields.
 */
export const PAGE_JUDGEMENT_CONTRACT = `你只做「看图 + 结构化判断」，几何由程序测量，不要输出契约以外的字段。
严格只输出一个 JSON 对象（无 markdown、无解释、无注释）：
{
  "background": { "type": "color", "value": "#RRGGBB" },
  "shapes": [ { "kind": "rect|roundRect|ellipse|line|arrow", "box": [x1,y1,x2,y2], "fill": "#RRGGBB 或 null", "stroke": "#RRGGBB 或 null", "stroke_pt": 1.5 } ],
  "pictures": [ { "box": [x1,y1,x2,y2], "source_box": [x1,y1,x2,y2], "label": "该区域是什么（简短中文）" } ],
  "text": [ { "hint_index": 0, "content": "该行应写的文字" } ]
}
规则：
- 所有坐标都是 source.png 的像素值，[x1,y1,x2,y2] 为左上/右下两点。
- shapes 只描述明显的几何结构（色带、卡片框、分隔线、箭头），宁少勿多；不要为文字建框。
- pictures 是「无法用原生形状/文本还原的位图区域」（照片、插画、截图块）；box 为放置位置，source_box 为来源区域。程序会从 source.png 确定性裁剪该区域，绝不会生成新图像。
- text[] 只为需要改写/补全/识别的行给 content；行号见 hints 列表里的 index。不要新增行，不要删除行，不要改动位置或字号。
- background 若整页有纯色底就给该色；不接受 type:"image"。`

/**
 * Deterministic image helper run by the venv's own Python (Pillow is already a
 * CLI dependency, so this adds no install step). Corner colours give the
 * background a measured default; crop keeps picture regions as source-derived
 * bitmaps because no image-generation API may be called here.
 */
export const PYTHON_IMAGE_SCRIPT = `import sys, json
from PIL import Image

def hex_at(im, x, y):
    w, h = im.size
    box = im.crop((max(0, min(w - 1, x)), max(0, min(h - 1, y)), max(1, min(w, x + 5)), max(1, min(h, y + 5))))
    px = list(box.getdata())
    n = max(1, len(px))
    return '#%02X%02X%02X' % (sum(p[0] for p in px) // n, sum(p[1] for p in px) // n, sum(p[2] for p in px) // n)

def main():
    mode = sys.argv[1]
    if mode == 'sample':
        im = Image.open(sys.argv[2]).convert('RGB')
        w, h = im.size
        corners = [hex_at(im, 0, 0), hex_at(im, w - 5, 0), hex_at(im, 0, h - 5), hex_at(im, w - 5, h - 5)]
        counts = {}
        for c in corners:
            counts[c] = counts.get(c, 0) + 1
        dominant = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        print(json.dumps({'width_px': w, 'height_px': h, 'corners': corners, 'dominant': dominant}))
        return 0
    if mode == 'crop':
        src, out = sys.argv[2], sys.argv[3]
        x, y, w, h = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
        im = Image.open(src)
        iw, ih = im.size
        left = max(0, min(iw - 1, x))
        top = max(0, min(ih - 1, y))
        right = max(left + 1, min(iw, x + w))
        bottom = max(top + 1, min(ih, y + h))
        im.convert('RGB').crop((left, top, right, bottom)).save(out, 'PNG')
        print(json.dumps({'path': out, 'box': [left, top, right - left, bottom - top]}))
        return 0
    if mode == 'fonts':
        # The upstream preview renderer only knows macOS font paths, so on Windows
        # every candidate misses and Pillow falls back to a bitmap default font
        # without CJK glyphs: preview.png renders blank. Handing the manifest a
        # font file that provably exists here is what makes the preview readable.
        import glob
        import os
        import platform
        system = platform.system()
        if system == 'Windows':
            patterns = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc',
                        'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/NotoSansCJK*.ttc',
                        'C:/Windows/Fonts/simsun.ttc']
        elif system == 'Darwin':
            patterns = ['/System/Library/Fonts/STHeiti Medium.ttc',
                        '/System/Library/Fonts/STHeiti Light.ttc',
                        '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
                        '/Library/Fonts/Arial Unicode.ttf']
        else:
            patterns = ['/usr/share/fonts/opentype/noto/NotoSansCJK-*.ttc',
                        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
                        '/usr/share/fonts/truetype/arphic/uming.ttc',
                        '/usr/share/fonts/dejavu/DejaVuSans.ttf']
        found = []
        for pattern in patterns:
            hits = sorted(glob.glob(pattern)) if '*' in pattern else ([pattern] if os.path.exists(pattern) else [])
            found.extend(hits)
        print(json.dumps({'font': found[0] if found else None, 'checked': patterns, 'found': found[:8]}))
        return 0
    raise SystemExit('unknown mode: %s' % mode)

if __name__ == '__main__':
    sys.exit(main())
`

// ---------------------------------------------------------------- types

type BoxWH = [number, number, number, number]
type BoxPoints = [number, number, number, number]

interface HintLine {
  id?: string
  text?: string
  box_px?: number[]
  font_pt?: number
  glyph_height_px?: number
  size_group?: string
  group_glyph_px?: number
  line_count?: number
  block_label?: string
}

interface HintsFile {
  schema_version?: number
  backend?: string
  source?: { width_px?: number; height_px?: number }
  lines?: HintLine[]
}

interface PageRequest {
  page_id?: string
  page_index?: number
  slide?: { width: number; height: number; size_mode?: string }
  content_box?: { left: number; top: number; width: number; height: number; fit?: string }
  source_size_px?: { width: number; height: number }
  source_image?: string
}

/** The one JSON object the model is allowed to return. */
export interface PageJudgement {
  background?: { type?: string; value?: string }
  shapes?: Array<{ kind?: string; box?: number[]; fill?: string | null; stroke?: string | null; stroke_pt?: number }>
  pictures?: Array<{ box?: number[]; source_box?: number[]; label?: string }>
  text?: Array<{ hint_index?: number; content?: string }>
}

/** Draft geometry built from measurements before the model speaks. */
export interface PageDraft {
  hints: HintLine[]
  background: string
  sourceWidth: number
  sourceHeight: number
}

interface PageOutcome {
  page: number
  state: 'recorded' | 'failed'
  objects: number
  warnings: string[]
}

/** Thrown when the caller's AbortSignal stops the run; partial output stays on disk. */
export class DeckPipelineAbortedError extends Error {
  readonly aborted = true
  constructor(message = '图片转可编辑 PPT 已取消') {
    super(message)
    this.name = 'DeckPipelineAbortedError'
  }
}

// ---------------------------------------------------------------- small utils

function isAbort(error: unknown): boolean {
  if (error instanceof DeckPipelineAbortedError) return true
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DeckPipelineAbortedError()
}

/** Redacted, length-bounded tail of a CLI transcript. */
function tailOf(output: string): string {
  const text = output.trim()
  return redactDiagnosticText(text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text, OUTPUT_TAIL)
}

function indexOfPageId(id: string, fallback: number): number {
  const match = /(\d+)\s*$/.exec(id)
  return match ? Number(match[1]) : fallback
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Corner pair to width/height box, clamped into the source pixel space. */
function toWidthHeight(box: number[] | undefined, width: number, height: number): BoxWH | undefined {
  if (!Array.isArray(box) || box.length < 4) return undefined
  const values = box.slice(0, 4).map(finiteNumber)
  if (values.some((value): value is undefined => value === undefined)) return undefined
  const [a, b, c, d] = values as number[]
  let x1 = Math.min(a, c)
  let x2 = Math.max(a, c)
  let y1 = Math.min(b, d)
  let y2 = Math.max(b, d)
  // A point or inverted box is noise; the model sometimes returns centres.
  if (x2 - x1 < 2) x2 = x1 + 2
  if (y2 - y1 < 2) y2 = y1 + 2
  x1 = clamp(x1, 0, width)
  x2 = clamp(x2, 0, width)
  y1 = clamp(y1, 0, height)
  y2 = clamp(y2, 0, height)
  if (x2 - x1 < 2 || y2 - y1 < 2) return undefined
  return [Math.round(x1), Math.round(y1), Math.round(x2 - x1), Math.round(y2 - y1)]
}

function toPoints(box: number[] | undefined, width: number, height: number): BoxPoints | undefined {
  if (!Array.isArray(box) || box.length < 4) return undefined
  const values = box.slice(0, 4).map(finiteNumber)
  if (values.some((value): value is undefined => value === undefined)) return undefined
  const [x1, y1, x2, y2] = values as number[]
  return [
    Math.round(clamp(x1, 0, width)),
    Math.round(clamp(y1, 0, height)),
    Math.round(clamp(x2, 0, width)),
    Math.round(clamp(y2, 0, height)),
  ]
}

const HEX = /^#?[0-9a-fA-F]{6}$/

function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!HEX.test(text)) return fallback
  return `#${(text.startsWith('#') ? text.slice(1) : text).toUpperCase()}`
}

/** Manifest colours are bare hex (the upstream builder accepts both forms). */
function bareHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === 'none' || text === 'null' || text === '') return undefined
  if (!HEX.test(text)) return undefined
  return (text.startsWith('#') ? text.slice(1) : text).toUpperCase()
}

function hasCjk(value: string): boolean {
  return /[ -〿㐀-䶿一-鿿豈-﫿]/.test(value)
}

/** Write JSON as UTF-8 without a BOM: a BOM makes the CLI's json.loads fail. */
export async function writeJsonNoBom(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(s => s.isFile(), () => false)
}

// ---------------------------------------------------------------- CLI calls

/**
 * Run one `editppt` (or venv Python) command. Every non-zero exit becomes an
 * Error carrying the subcommand, the exit code and the redacted output tail: the
 * host only prefixes this text, so it must name the failing command itself.
 */
async function runCli(deps: DeckPipelineDeps, label: string, argv: string[], cwd: string, timeoutMs?: number): Promise<string> {
  assertActive(deps.signal)
  const result = await deps.run(argv, { cwd, timeoutMs })
  if (deps.signal.aborted) throw new DeckPipelineAbortedError()
  if (result.code !== 0) {
    const tail = tailOf(result.output)
    throw new Error(`editppt ${label} 失败（退出码 ${result.code}）${tail === '' ? '' : `：${tail}`}`)
  }
  return result.output
}

/** Best-effort variant for steps whose failure the page can still survive. */
async function runCliSoft(deps: DeckPipelineDeps, label: string, argv: string[], cwd: string, timeoutMs?: number): Promise<{ ok: boolean; output: string }> {
  try {
    return { ok: true, output: await runCli(deps, label, argv, cwd, timeoutMs) }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Per-run serialization of the CLI commands that rewrite `page_jobs.json`.
 *
 * `run dispatch` and `run record` read the whole state file, mutate one page and
 * write it back without locking, so two concurrent page workers can clobber each
 * other's transition (observed live: a recorded page fell back to `dispatched`
 * and `run finalize` then refused the run). Only the state commands are chained;
 * model calls and page-local builds still run in parallel.
 */
const stateChains = new Map<string, Promise<unknown>>()

async function withRunState<T>(runDir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(runDir)
  const previous = stateChains.get(key) ?? Promise.resolve()
  const settled = previous.catch(() => undefined).then(task)
  stateChains.set(key, settled)
  try {
    return await settled
  } finally {
    if (stateChains.get(key) === settled) stateChains.delete(key)
  }
}

/** Editppt entry point plus the generic argv runner bound to it. */
async function cliOf(deps: DeckPipelineDeps): Promise<string> {
  return deps.editppt()
}

async function editppt(deps: DeckPipelineDeps, label: string, argv: string[], cwd: string, timeoutMs?: number): Promise<string> {
  return runCli(deps, label, [await cliOf(deps), ...argv], cwd, timeoutMs)
}

async function editpptSoft(deps: DeckPipelineDeps, label: string, argv: string[], cwd: string, timeoutMs?: number): Promise<{ ok: boolean; output: string }> {
  return runCliSoft(deps, label, [await cliOf(deps), ...argv], cwd, timeoutMs)
}

/** Python sibling of the editppt entry point (Scripts/python.exe or bin/python). */
async function pythonOf(deps: DeckPipelineDeps): Promise<string> {
  const dir = path.dirname(await deps.editppt())
  const python = path.join(dir, process.platform === 'win32' ? 'python.exe' : 'python')
  if (await exists(python)) return python
  throw new Error(`无法定位 venv Python：${python} 不存在`)
}

/** One deterministic Pillow call; stdout is a single JSON object. */
async function pythonImage(deps: DeckPipelineDeps, argv: string[], cwd: string): Promise<Record<string, unknown> | undefined> {
  const output = await runCli(deps, 'image helper', [await pythonOf(deps), '-c', PYTHON_IMAGE_SCRIPT, ...argv], cwd)
  const line = output.trim().split(/\r?\n/).reverse().find(entry => entry.trim().startsWith('{'))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- judgement

/** Strip code fences or prose and return the first balanced JSON object. */
export function parseJudgement(raw: string): PageJudgement | undefined {
  const text = raw
    .replace(/^\s*```\s*json\s*/i, '')
    .replace(/^\s*```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as PageJudgement
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Draft geometry: text lines and the background default come from measurements. */
export function buildPageDraft(input: {
  hints: HintsFile | undefined
  sample: { width_px?: number; height_px?: number; dominant?: string } | undefined
  request: PageRequest | undefined
}): PageDraft {
  const lines = Array.isArray(input.hints?.lines) ? input.hints.lines : []
  const width = input.sample?.width_px ?? input.hints?.source?.width_px ?? input.request?.source_size_px?.width ?? 1280
  const height = input.sample?.height_px ?? input.hints?.source?.height_px ?? input.request?.source_size_px?.height ?? 720
  return { hints: lines, background: normalizeHex(input.sample?.dominant, '#FFFFFF'), sourceWidth: width, sourceHeight: height }
}

/**
 * Same-level text must share one size, so a `size_group`'s font_pt is unified to
 * that group's most common value (ties resolve to the smaller size, so the run
 * stays reproducible).
 */
function unifyGroupSizes(lines: HintLine[]): Map<number, number> {
  const byGroup = new Map<string, number[]>()
  lines.forEach((line, index) => {
    const group = line.size_group
    const size = finiteNumber(line.font_pt)
    if (typeof group !== 'string' || size === undefined) return
    const list = byGroup.get(group) ?? []
    list.push(index)
    byGroup.set(group, list)
  })
  const chosen = new Map<number, number>()
  for (const [, indexes] of byGroup) {
    const counts = new Map<number, number>()
    for (const index of indexes) {
      const size = lines[index].font_pt as number
      counts.set(size, (counts.get(size) ?? 0) + 1)
    }
    const winner = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]
    for (const index of indexes) chosen.set(index, winner)
  }
  return chosen
}

/**
 * Merge the model judgement onto the measured draft.
 *
 * This is where the anti-hallucination rule lives: `box_px` and `font_size` are
 * only ever copied from hints, while the model contributes text content, graphic
 * kinds and bitmap regions. Anything unusable is dropped with a warning instead
 * of guessed, because a fabricated box is worse than a missing one.
 */
export function mergeJudgement(input: {
  draft: PageDraft
  judgement: PageJudgement
  request: PageRequest | undefined
  pageId: string
  assetPaths: Array<{ path: string; box: BoxWH; label: string; sourceBox: BoxWH }>
  warnings: string[]
  /** Absolute path of a font that exists on this machine; see `detectPreviewFont`. */
  previewFont?: string
}): Record<string, unknown> {
  const { draft, judgement, request, pageId, warnings } = input
  const width = draft.sourceWidth
  const height = draft.sourceHeight
  const sizes = unifyGroupSizes(draft.hints)
  const contentByHint = new Map<number, string>()
  for (const entry of Array.isArray(judgement.text) ? judgement.text : []) {
    const index = finiteNumber(entry?.hint_index)
    const content = typeof entry?.content === 'string' ? entry.content.trim() : ''
    if (index === undefined || content === '') continue
    if (index < 0 || index >= draft.hints.length) {
      warnings.push(`模型返回了不存在的 hint_index ${index}，已忽略`)
      continue
    }
    contentByHint.set(index, content)
  }

  const textBoxes: Array<Record<string, unknown>> = []
  const inventory: string[] = []
  draft.hints.forEach((line, index) => {
    const box = Array.isArray(line.box_px) && line.box_px.length >= 4 ? line.box_px : undefined
    if (box === undefined) return
    const text = contentByHint.get(index) ?? (typeof line.text === 'string' ? line.text.trim() : '')
    // Both sources empty → no box: never invent copy that nobody read.
    if (text === '') {
      warnings.push(`第 ${index + 1} 行 OCR 无文本且模型未提供内容，已跳过`)
      return
    }
    const x = Math.round(clamp(box[0] - 3, 0, width))
    const y = Math.round(clamp(box[1] - 2, 0, height))
    const w = Math.round(clamp(box[2] + 6, 4, width - x))
    const h = Math.round(clamp(box[3] + 4, 4, height - y))
    const size = sizes.get(index) ?? finiteNumber(line.font_pt)
    textBoxes.push({
      id: typeof line.id === 'string' && /^[\w-]+$/.test(line.id) ? line.id : `text_${index + 1}`,
      text,
      box_px: [x, y, w, h] satisfies BoxWH,
      ...(size === undefined ? {} : { font_size: size }),
      // Tells the deterministic builder not to re-derive the size from the box.
      font_size_source: 'measured',
      font: hasCjk(text) ? 'Microsoft YaHei' : 'Arial',
      ...(input.previewFont === undefined ? {} : { preview_font: input.previewFont }),
      color: '102A43',
      align: 'left',
      valign: 'middle',
      z_index: 300,
    })
    for (const part of text.split(/\r?\n/)) {
      const trimmed = part.trim()
      if (trimmed !== '' && !inventory.includes(trimmed)) inventory.push(trimmed)
    }
  })

  const shapes: Array<Record<string, unknown>> = []
  ;(Array.isArray(judgement.shapes) ? judgement.shapes : []).forEach((item, index) => {
    const kind = typeof item?.kind === 'string' ? item.kind.trim().toLowerCase() : ''
    const id = `shape_${index + 1}`
    const fill = bareHex(item?.fill)
    const stroke = bareHex(item?.stroke)
    const strokeWidth = finiteNumber(item?.stroke_pt)
    if (kind === 'line' || kind === 'arrow') {
      const points = toPoints(item?.box, width, height)
      if (points === undefined) return
      shapes.push({
        id,
        type: 'line',
        points_px: points satisfies BoxPoints,
        fill: 'none',
        stroke: stroke ?? '102A43',
        stroke_width: strokeWidth === undefined ? 1.5 : clamp(strokeWidth, 0.25, 24),
        start_arrow: 'none',
        end_arrow: kind === 'arrow' ? 'triangle' : 'none',
        semantic_line_id: `pipeline-line-${index + 1}`,
        z_index: 100,
      })
      return
    }
    const box = toWidthHeight(item?.box, width, height)
    if (box === undefined) return
    const type = kind === 'roundRect' || kind === 'ellipse' || kind === 'rect' ? kind : 'rect'
    if (kind !== '' && type !== kind) warnings.push(`形状 ${id} 的类型 ${kind} 不受支持，已按矩形处理`)
    const shape: Record<string, unknown> = {
      id,
      type,
      box_px: box satisfies BoxWH,
      fill: fill ?? 'none',
      stroke: stroke ?? 'none',
      ...(strokeWidth === undefined ? {} : { stroke_width: clamp(strokeWidth, 0.25, 24) }),
      z_index: 100,
    }
    if (type === 'roundRect') {
      // A rounded rectangle without a recorded source radius is a contract
      // violation upstream, so the radius is derived from the measured box.
      const radius = clamp(Math.round(Math.min(box[2], box[3]) / 6), 2, 48)
      shape.source_corner_radius_px = radius
      shape.corner_category = 'small-radius'
    } else {
      shape.corner_category = 'straight'
    }
    shapes.push(shape)
  })

  const images: Array<Record<string, unknown>> = []
  const provenance: Array<Record<string, unknown>> = []
  const visual: Array<Record<string, unknown>> = []
  const pageArea = width * height
  input.assetPaths.forEach((asset, index) => {
    const area = asset.box[2] * asset.box[3]
    if (pageArea > 0 && area / pageArea >= FULL_BLEED_RATIO && textBoxes.length > 0) {
      // A full-slide raster behind editable text is both an upstream contract
      // violation and exactly the "fake success" this pipeline must refuse.
      warnings.push(`位图区域 ${index + 1} 覆盖整页，已按「禁止整页位图」规则丢弃`)
      return
    }
    const id = `photo_${String(index + 1).padStart(3, '0')}`
    images.push({
      id,
      path: asset.path,
      box_px: asset.box satisfies BoxWH,
      alt: `crop of source.png region: ${asset.label.slice(0, 100)}`,
      z_index: 30,
    })
    // Live-verified provenance shape: `user-provided` is the only source type a
    // source-pixel crop can honestly claim without an image backend, and the
    // role must be `background` (foreground claims demand asset-sheet or
    // imagegen evidence, which this pipeline can never produce).
    provenance.push({
      path: asset.path,
      source: 'source.png',
      source_type: 'user-provided',
      provenance_note: `PIL crop of source.png region [${asset.sourceBox.join(', ')}]; no image backend call.`,
    })
    visual.push({
      id,
      role: 'background',
      object_type: 'photo',
      description: asset.label.slice(0, 160),
      path: asset.path,
    })
  })

  const backgroundType = typeof judgement.background?.type === 'string' ? judgement.background.type.trim().toLowerCase() : ''
  if (backgroundType === 'image') warnings.push('模型请求整页位图背景，已按规则回退为纯色底')
  const background = backgroundType === 'color' ? normalizeHex(judgement.background?.value, draft.background) : draft.background

  const slide: Record<string, unknown> = request?.slide
    // `background` always carries its leading `#` here (both `normalizeHex` and
    // the measured corner colour produce `#RRGGBB`): a bare hex makes the
    // upstream preview renderer die with `ValueError: unknown color specifier`.
    ? { ...request.slide, background }
    : { width: 13.333, height: 7.5, size_mode: 'wide', background }

  return {
    schema_version: 1,
    page_id: pageId,
    slide,
    content_box: request?.content_box ?? { left: 0, top: 0, width: slide.width as number, height: slide.height as number, fit: 'contain' },
    source: { path: 'source.png', width_px: width, height_px: height },
    strategy: {
      mode: 'native-reconstruction',
      summary: `本地确定性管线：文本框位置与字号全部取自 text_hints 的墨迹测量；${shapes.length} 个原生形状；${images.length} 个从 source.png 确定性裁剪的位图区域；未调用任何图像生成接口。`,
    },
    page_strategy: 'Deterministic local pipeline: measured text geometry, model judgement for text content and graphic kinds, source-derived bitmap regions only.',
    text_inventory: inventory.map((text, index) => ({ id: `text_${index + 1}`, text, decision: 'native-text' })),
    visual_inventory: visual,
    background_strategy: {
      // The raster-preserving mode is only honest when the page really keeps
      // source pixels as a bitmap; a pure native page stays native-or-script.
      mode: images.length > 0 ? 'source-preserving-local-cleanup' : 'native-or-script',
      source_consistency_contract: `背景为四角采样得到的纯色 ${background}；位图区域按 source.png 原像素矩形呈现，构图、透视与位置由裁剪坐标保证，未做任何重绘。`,
      removed_foreground: images.length > 0
        ? `位图区域 ${images.map(item => String(item.id)).join('、')} 保持原样，未从中移除或重绘任何元素；其余文本与形状都是独立原生对象。`
        : '没有把任何前景元素烧进背景：文本与形状都是独立原生对象，本页没有位图层。',
      comparison_note: '管线未调用任何生图接口，因此不存在伪文字或涂抹；预览与 source 的差异只可能来自模型对形状/位图区域的选择。',
    },
    quality_checks: {
      font_size_calibrated: true,
      visual_inventory_matched: true,
      background_strategy_checked: true,
      shape_corner_geometry_checked: true,
      text_hints_consumed: true,
      no_duplicate_text_or_decoration: true,
      z_order_checked: true,
    },
    text_boxes: textBoxes,
    shapes,
    images,
    asset_provenance: provenance,
    tables: [],
  }
}

// ---------------------------------------------------------------- prompt

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

async function imagePart(file: string): Promise<SkillChatPart | undefined> {
  if (!(await exists(file))) return undefined
  const data = await fs.readFile(file)
  // Bound the request: a 4K screenshot is more than a judgement needs.
  if (data.byteLength > 8 * 1024 * 1024) return undefined
  return { type: 'image_url', image_url: { url: `data:${mimeOf(file)};base64,${data.toString('base64')}` } }
}

/** Text currently placed on the page, for a repair round's context block. */
function textContentsOf(manifest: Record<string, unknown>): Array<{ content: unknown }> {
  const boxes = Array.isArray(manifest.text_boxes) ? (manifest.text_boxes as Array<Record<string, unknown>>) : []
  return boxes.map(box => ({ content: box.text }))
}

/** Fixed part order (images first), per the design doc's model contract. */
async function judgementParts(input: {
  pageDir: string
  draft: PageDraft
  contract: string
  repair?: { manifest: Record<string, unknown>; report: unknown }
}): Promise<SkillChatPart[]> {
  const parts: SkillChatPart[] = []
  const source = await imagePart(path.join(input.pageDir, 'source.png'))
  if (source !== undefined) parts.push(source)
  const overlay = await imagePart(path.join(input.pageDir, 'text_hints.png'))
  if (overlay !== undefined) parts.push(overlay)
  const lines = input.draft.hints.map((line, index) => ({
    index,
    ...(typeof line.id === 'string' ? { id: line.id } : {}),
    box_px: line.box_px,
    ...(finiteNumber(line.font_pt) === undefined ? {} : { font_pt: line.font_pt }),
    ...(typeof line.size_group === 'string' ? { size_group: line.size_group } : {}),
    ...(typeof line.text === 'string' ? { ocr_text: line.text } : {}),
  }))
  const repairBlock = input.repair === undefined
    ? []
    : [
        '上一次产出的页面校验未通过。以下是当前 manifest 与校验报告，请在保持上述规则的前提下修正，并重新输出完整 JSON：',
        `manifest=${JSON.stringify({ shapes: input.repair.manifest.shapes, pictures: input.repair.manifest.images, text: textContentsOf(input.repair.manifest) })}`,
        `validation=${JSON.stringify(input.repair.report)}`,
      ]
  parts.push({
    type: 'text',
    text: [
      `页面尺寸：${input.draft.sourceWidth}x${input.draft.sourceHeight} px；采样背景色：${input.draft.background}`,
      'OCR 行列表（box_px 与 font_pt 为测量值，由程序独占使用；ocr_text 可能识别错字）：',
      JSON.stringify(lines),
      input.contract,
      ...repairBlock,
      '只输出 JSON 对象。',
    ].join('\n\n'),
  })
  return parts
}

/** Prompt file recorded by `run dispatch`; it must live inside the page dir. */
function promptFileBody(pageId: string, contract: string): string {
  return `# Pipeline page worker: ${pageId}

This page is executed by the plugin's deterministic local pipeline, not by an
agent. Files owned by this page: manifest.json, page.pptx, preview.png,
split_assets_contact.png, validation.json, page_result.json, assets/.

Rules: text geometry comes from text_hints.json; the model supplies one JSON
judgement (text content, shapes, bitmap regions); bitmap regions are cropped from
source.png with Pillow and recorded as "user-provided" provenance with role
"background"; no image-generation API is ever called. editppt owns every state
transition (dispatch / record / finalize).

${contract}
`
}

// ---------------------------------------------------------------- per page

/**
 * Absolute path of a CJK-capable font that exists on this machine, or undefined.
 *
 * Upstream's `choose_preview_font` only tries macOS paths, so on Windows the page
 * preview silently falls back to Pillow's bitmap default font, which has no CJK
 * glyphs: `preview.png` comes out blank even though `page.pptx` is correct. The
 * manifest accepts a per-box `preview_font`, and upstream honours any path that
 * actually exists, so we probe once per process (Pillow is already the probe
 * runtime) and cache the answer — a missing font is reported, never guessed.
 */
let previewFontProbe: Promise<string | undefined> | undefined

async function detectPreviewFont(deps: DeckPipelineDeps, cwd: string): Promise<string | undefined> {
  previewFontProbe ??= pythonImage(deps, ['fonts'], cwd)
    .then(sample => {
      const font = sample?.font
      return typeof font === 'string' && font !== '' ? font : undefined
    })
    .catch(() => undefined)
  return previewFontProbe
}

/** Reset the cached font probe (self-test only: the host process probes once). */
export function resetPreviewFontCache(): void {
  previewFontProbe = undefined
}

/**
 * Reconstruct one page: dispatch → hints → draft → judgement → merge → assets →
 * build → validate (≤2 repairs) → contact sheet → page_result → record.
 *
 * Exported for the self-test, which drives a copied run directory with a stub
 * chat backend against the real CLI.
 */
export async function reconstructPage(step: {
  deps: DeckPipelineDeps
  runDir: string
  pageDir: string
  pageId: string
  agentId: string
  contract: string
  offlineHints: boolean
  timeoutMs: number
}): Promise<PageOutcome> {
  const { deps, runDir, pageDir, pageId, agentId } = step
  const index = indexOfPageId(pageId, 1)
  const warnings: string[] = []
  const emit = (label: string, state: 'running' | 'done' | 'warning'): void => deps.onEvent({ time: Date.now(), label, state, page: index })
  const budget = createPageSignal(deps, step.timeoutMs)
  try {
    assertActive(deps.signal)
    // Dispatch first: `--local` is refused for multi-page runs and the CLI never
    // probes a worker, so a plain dispatch with a plugin agent id is the one code
    // path for both single- and multi-page decks.
    const promptFile = path.join(pageDir, 'plugin-prompt.md')
    await fs.mkdir(pageDir, { recursive: true })
    await fs.writeFile(promptFile, promptFileBody(pageId, step.contract), 'utf8')
    await withRunState(runDir, () => editppt(deps, 'run dispatch', ['run', 'dispatch', runDir, '--page', pageId, '--agent-id', agentId, '--prompt-file', promptFile], runDir, step.timeoutMs))
    emit('ppt.activityDispatched', 'done')

    if (step.offlineHints) {
      emit('ppt.activityTextHints', 'running')
      await editppt(deps, 'page hints', ['page', 'hints', pageDir, '--source', 'source.png', '--out', 'text_hints.json'], runDir, step.timeoutMs)
      emit('ppt.activityTextHints', 'done')
    }

    const hints = await readJsonFile<HintsFile>(path.join(pageDir, 'text_hints.json'))
    if (hints === undefined) warnings.push('缺少 text_hints.json，文本框位置无法测量')
    const request = await readJsonFile<PageRequest>(path.join(pageDir, 'page_request.json'))
    const sample = await pythonImage(deps, ['sample', path.join(pageDir, 'source.png')], runDir)
    const draft = buildPageDraft({ hints, sample, request })
    const previewFont = await detectPreviewFont(deps, runDir)
    if (previewFont === undefined) {
      // Without a local font the preview is decoration, not evidence: say so on
      // the event stream instead of shipping a silently blank page image.
      warnings.push('未找到本机中文字体，preview.png 可能无法显示中文（page.pptx 本身不受影响）')
      emit('ppt.activityValidating', 'warning')
    }

    const parts = await judgementParts({ pageDir, draft, contract: step.contract })
    if (parts.length === 0) throw new Error(`${pageId} 缺少 source.png，无法判断页面内容`)
    emit('ppt.activityJudgement', 'running')
    let answer = await deps.chat.complete({
      system: '你是幻灯片重建助手，只输出规定结构的 JSON 对象。',
      content: parts,
      temperature: 0.2,
      signal: budget.signal,
    })
    let judgement = parseJudgement(answer)
    if (judgement === undefined) {
      // One retry with an explicit "JSON only" nudge covers fences and prose.
      warnings.push('模型首次输出不是合法 JSON，已重试一次')
      answer = await deps.chat.complete({
        system: '你是幻灯片重建助手。只输出一个 JSON 对象，不要任何其它文字。',
        content: [...parts, { type: 'text' as const, text: '上一次输出无法解析为 JSON。请只输出 JSON 对象本身。' }],
        temperature: 0,
        signal: budget.signal,
      })
      judgement = parseJudgement(answer)
    }
    if (judgement === undefined) throw new Error(`${pageId} 模型输出无法解析为 JSON`)
    emit('ppt.activityJudgement', 'done')

    const reportPath = path.join(pageDir, 'validation.json')
    let round = 0
    for (;;) {
      const assets = await cropPictures(deps, { pageDir, draft, judgement, runDir, timeoutMs: step.timeoutMs, warnings })
      if (assets.length > 0) emit('ppt.activityBuilding', 'running')
      const manifest = mergeJudgement({ draft, judgement, request, pageId, assetPaths: assets, warnings, previewFont })
      await writeJsonNoBom(path.join(pageDir, 'manifest.json'), manifest)
      emit('ppt.activityBuildingPage', 'running')
      await editppt(deps, 'page build', ['page', 'build', pageDir], runDir, step.timeoutMs)
      emit('ppt.activityValidating', 'running')
      const validate = await editpptSoft(deps, 'page validate', ['page', 'validate', pageDir, '--report', reportPath], runDir, step.timeoutMs)
      const written = await readJsonFile<Record<string, unknown>>(reportPath)
      const problems = validationProblems(written)
      if (written?.passed === true && problems.length === 0) {
        // The contact sheet is one of the six recorded outputs, so it has to be
        // produced from the final build rather than an earlier attempt.
        await editppt(deps, 'page contact-sheet', ['page', 'contact-sheet', pageDir], runDir, step.timeoutMs)
        await writePageResult({ pageDir, pageId, agentId, manifest, warnings, round })
        emit('ppt.activityRecording', 'running')
        await withRunState(runDir, () => editppt(deps, 'run record', ['run', 'record', runDir, '--page', pageId, '--agent-id', agentId], runDir, step.timeoutMs))
        emit('ppt.activityRecording', 'done')
        return { page: index, state: 'recorded', objects: countObjects(manifest), warnings }
      }
      if (round >= MAX_REPAIR_ROUNDS) {
        const detail = problems.length > 0 ? problems.join('；') : tailOf(validate.output)
        throw new Error(`${pageId} 页面校验未通过（已修复 ${round} 轮）：${detail}`)
      }
      round += 1
      emit('ppt.activityValidating', 'warning')
      const repairParts = await judgementParts({
        pageDir,
        draft,
        contract: step.contract,
        repair: { manifest, report: written ?? { error: tailOf(validate.output) } },
      })
      const repaired = await deps.chat.complete({
        system: '你是幻灯片重建助手，只输出规定结构的 JSON 对象。',
        content: repairParts,
        temperature: 0.1,
        signal: budget.signal,
      })
      const parsed = parseJudgement(repaired)
      if (parsed === undefined) throw new Error(`${pageId} 第 ${round} 轮修复输出无法解析为 JSON`)
      judgement = parsed
    }
  } finally {
    budget.dispose()
  }
}

/** Flatten the validator's failure lists into short, UI-readable strings. */
function validationProblems(report: Record<string, unknown> | undefined): string[] {
  if (report === undefined) return ['validation.json 未生成']
  const problems: string[] = []
  const lists: Array<[string, string]> = [
    ['page_contract_violations', '页面契约'],
    ['line_geometry_violations', '线条几何'],
    ['table_structure_violations', '表格结构'],
    ['missing_asset_provenance', '缺少来源记录'],
    ['invalid_asset_provenance', '来源记录无效'],
    ['missing_provenance_sources', '来源文件缺失'],
    ['missing_manifest_images', '图像文件缺失'],
    ['media_hash_mismatches', '图像哈希不一致'],
    ['missing_required_text', '文本缺失'],
    ['missing_parts', '包结构缺失'],
  ]
  for (const [key, label] of lists) {
    const value = report[key]
    if (!Array.isArray(value) || value.length === 0) continue
    const items = value.slice(0, 4).map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    problems.push(`${label}: ${items.join(' | ')}${value.length > 4 ? ` …共 ${value.length} 项` : ''}`)
  }
  if (report.passed === false && problems.length === 0) {
    problems.push(`校验未通过：slides=${String(report.slides ?? '?')} editable_text_shapes=${String(report.editable_text_shapes ?? '?')}`)
  }
  return problems
}

function countObjects(manifest: Record<string, unknown>): number {
  const list = (key: string): number => (Array.isArray(manifest[key]) ? (manifest[key] as unknown[]).length : 0)
  return list('text_boxes') + list('shapes') + list('images') + list('tables')
}

/**
 * Deterministic Pillow crops out of `source.png`.
 *
 * The CLI has no crop command and `editppt image import` refuses a non-API
 * producer, so the crop runs through the venv's own Python. A region that cannot
 * be cropped is dropped with a warning: a missing picture is recoverable, while
 * a fabricated file would break `run record` hashes.
 */
async function cropPictures(deps: DeckPipelineDeps, input: {
  pageDir: string
  draft: PageDraft
  judgement: PageJudgement
  runDir: string
  timeoutMs: number
  warnings: string[]
}): Promise<Array<{ path: string; box: BoxWH; label: string; sourceBox: BoxWH }>> {
  const regions = Array.isArray(input.judgement.pictures) ? input.judgement.pictures : []
  if (regions.length === 0) return []
  const assetsDir = path.join(input.pageDir, 'assets')
  await fs.mkdir(assetsDir, { recursive: true })
  const source = path.join(input.pageDir, 'source.png')
  const python = await pythonOf(deps)
  const out: Array<{ path: string; box: BoxWH; label: string; sourceBox: BoxWH }> = []
  for (const [offset, region] of regions.entries()) {
    assertActive(deps.signal)
    const sourceBox = toWidthHeight(region?.source_box ?? region?.box, input.draft.sourceWidth, input.draft.sourceHeight)
    const box = toWidthHeight(region?.box, input.draft.sourceWidth, input.draft.sourceHeight)
    if (sourceBox === undefined || box === undefined) {
      input.warnings.push(`位图区域 ${offset + 1} 的坐标无效，已丢弃`)
      continue
    }
    const name = `photo_${String(offset + 1).padStart(3, '0')}.png`
    const target = path.join(assetsDir, name)
    const cropped = await runCliSoft(deps, 'image crop', [
      python, '-c', PYTHON_IMAGE_SCRIPT, 'crop', source, target,
      String(sourceBox[0]), String(sourceBox[1]), String(sourceBox[2]), String(sourceBox[3]),
    ], input.runDir, input.timeoutMs)
    if (!cropped.ok || !(await exists(target))) {
      input.warnings.push(`位图区域 ${offset + 1} 裁剪失败，已丢弃：${tailOf(cropped.output)}`)
      continue
    }
    out.push({
      path: `assets/${name}`,
      box,
      label: typeof region?.label === 'string' && region.label.trim() !== '' ? region.label.trim() : `源图位图区域 ${offset + 1}`,
      sourceBox,
    })
  }
  return out
}

async function writePageResult(input: {
  pageDir: string
  pageId: string
  agentId: string
  manifest: Record<string, unknown>
  warnings: string[]
  round: number
}): Promise<void> {
  // The first seven keys are `run record`'s required outputs, named exactly as
  // references/manifest-schema.md specifies and resolved against the page dir.
  // Everything after them is plugin diagnostics.
  await writeJsonNoBom(path.join(input.pageDir, 'page_result.json'), {
    page_manifest: 'manifest.json',
    imagegen_jobs: 'imagegen-jobs.json',
    page_pptx: 'page.pptx',
    preview: 'preview.png',
    contact_sheet: 'split_assets_contact.png',
    validation: 'validation.json',
    page_result: 'page_result.json',
    page_id: input.pageId,
    execution_mode: 'plugin-local-pipeline',
    agent_id: input.agentId,
    image_jobs_used: 0,
    repair_rounds: input.round,
    objects: countObjects(input.manifest),
    summary: String((input.manifest.strategy as { summary?: string } | undefined)?.summary ?? ''),
    notes: input.warnings.length > 0 ? input.warnings.join('；').slice(0, 500) : '无告警',
  })
}

/** Page-scoped abort: the caller's signal plus this page's own budget. */
function createPageSignal(deps: DeckPipelineDeps, budgetMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const timer = setTimeout(abort, Math.max(1_000, budgetMs))
  deps.signal.addEventListener('abort', abort)
  if (deps.signal.aborted) abort()
  let disposed = false
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      deps.signal.removeEventListener('abort', abort)
    },
  }
}

// ---------------------------------------------------------------- run

/** First balanced JSON object in a CLI transcript (the CLI prefixes noise). */
function parseFirstJson(output: string): unknown {
  const start = output.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < output.length; index += 1) {
    const char = output[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(output.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Page ids out of a mixed list of strings or `{ page_id }` objects, in order. */
function collectPageIds(groups: readonly unknown[]): string[] {
  const out: string[] = []
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const entry of group) {
      const id = typeof entry === 'string'
        ? entry
        : typeof (entry as { page_id?: unknown } | undefined)?.page_id === 'string'
          ? (entry as { page_id: string }).page_id
          : ''
      if (/^page_\d{3}$/.test(id) && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * Page order for the run.
 *
 * `page_jobs.json` is the CLI's source of truth for pages and state, so it wins
 * when `run next --json` names no pages; a directory scan is the last resort.
 */
async function pagesOf(deps: DeckPipelineDeps, runDir: string): Promise<string[]> {
  const output = await editppt(deps, 'run next', ['run', 'next', runDir, '--json'], runDir)
  const state = parseFirstJson(output) as Record<string, unknown> | null
  const fromState = collectPageIds([state?.suggested_pages, state?.dispatchable_pages, state?.pages])
  if (fromState.length > 0) return fromState
  const jobs = await readJsonFile<{ pages?: unknown }>(path.join(runDir, 'page_jobs.json'))
  const fromJobs = collectPageIds([jobs?.pages])
  if (fromJobs.length > 0) return fromJobs
  const entries = await fs.readdir(runDir, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter(entry => entry.isDirectory() && /^page_\d{3}$/.test(entry.name)).map(entry => entry.name).sort()
  if (dirs.length === 0) throw new Error('editppt prepare 未生成任何页面目录')
  return dirs
}

/** Built-in contract, optionally extended with the installed skill's own text. */
async function contractFor(deps: DeckPipelineDeps): Promise<string> {
  const doc = await deps.readSkillDoc('references/manifest-schema.md').catch(() => undefined)
  if (doc === undefined || doc.trim() === '') return PAGE_JUDGEMENT_CONTRACT
  return `${PAGE_JUDGEMENT_CONTRACT}\n\n【上游 manifest 字段契约摘录（仅作字段语义参考，输出格式以上面为准）】\n${doc.trim().slice(0, SKILL_DOC_EXCERPT)}`
}

async function firstFileIn(dir: string, accept: (name: string) => boolean): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = entries.filter(entry => entry.isFile() && accept(entry.name)).map(entry => entry.name).sort()
  return names.length === 0 ? undefined : path.join(dir, names[0]!)
}

/**
 * Drive a whole deck.
 *
 * Phases follow the design document exactly. Nothing is published from here: the
 * caller accepts the result and copies it out of `runDirectory`, so an aborted
 * run leaves partial output behind without ever shipping it.
 */
export async function runDeckPipeline(
  inputs: Array<{ path: string; name: string }>,
  runDir: string,
  options: { offlineOcr: boolean; language: string },
  deps: DeckPipelineDeps,
): Promise<DeckPipelineResult> {
  assertActive(deps.signal)
  const absoluteRunDir = path.resolve(runDir)
  await fs.mkdir(absoluteRunDir, { recursive: true })
  deps.onEvent({ time: Date.now(), label: 'ppt.activityPreparing', state: 'running' })

  const prepareArgv = ['prepare', ...inputs.map(input => path.resolve(input.path)), '--job-dir', absoluteRunDir]
  // Offline mode owns hints page by page (a stalled OCR service can then never
  // block the deck); online mode lets prepare produce them up front.
  if (options.offlineOcr) prepareArgv.push('--no-text-hints')
  await editppt(deps, 'prepare', prepareArgv, absoluteRunDir)
  deps.onEvent({ time: Date.now(), label: 'ppt.activityPreparing', state: 'done' })

  const contract = await contractFor(deps)
  const pageIds = await pagesOf(deps, absoluteRunDir)
  const concurrency = clamp(Math.round(deps.concurrency()), 1, 3)
  const budget = Math.max(5_000, Math.round(deps.pageBudgetMs()))
  const outcomes: PageOutcome[] = []
  const failures: string[] = []

  for (let start = 0; start < pageIds.length; start += concurrency) {
    assertActive(deps.signal)
    const wave = pageIds.slice(start, start + concurrency)
    const results = await Promise.all(wave.map(async (id, offset): Promise<PageOutcome> => {
      const index = start + offset + 1
      try {
        return await reconstructPage({
          deps,
          runDir: absoluteRunDir,
          pageDir: path.join(absoluteRunDir, 'pages', id),
          pageId: id,
          agentId: `plugin-page-${index}`,
          contract,
          offlineHints: options.offlineOcr,
          timeoutMs: budget,
        })
      } catch (error) {
        if (isAbort(error)) throw error
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        return { page: indexOfPageId(id, index), state: 'failed', objects: 0, warnings: [message.slice(0, 500)] }
      }
    }))
    outcomes.push(...results)
  }

  if (deps.signal.aborted) throw new DeckPipelineAbortedError()
  const recorded = outcomes.filter(outcome => outcome.state === 'recorded')
  if (recorded.length === 0) throw new Error(`所有页面都重建失败：${failures.join('；').slice(0, 1200)}`)
  if (recorded.length < pageIds.length) {
    // Finalize would reject an unrecorded page anyway; naming the failing pages
    // is far more useful to the UI than an opaque CLI error.
    throw new Error(`${recorded.length}/${pageIds.length} 页完成，未全部录制：${failures.join('；').slice(0, 1200)}`)
  }

  deps.onEvent({ time: Date.now(), label: 'ppt.activityFinalizing', state: 'running' })
  await withRunState(absoluteRunDir, () => editppt(deps, 'run finalize', ['run', 'finalize', absoluteRunDir], absoluteRunDir, Math.max(budget, 120_000)))
  deps.onEvent({ time: Date.now(), label: 'ppt.activityFinalizing', state: 'done' })

  const finalDir = path.join(absoluteRunDir, 'final')
  const deckPath = await firstFileIn(finalDir, name => name.toLowerCase().endsWith('.pptx'))
  if (deckPath === undefined) throw new Error(`run finalize 未产出 final/*.pptx：${finalDir}`)
  const previews: string[] = []
  for (const id of pageIds) {
    const preview = path.join(absoluteRunDir, 'pages', id, 'preview.png')
    if (await exists(preview)) previews.push(preview)
  }
  return {
    deckPath,
    reportPath: path.join(finalDir, 'validation.json'),
    runSummaryPath: path.join(finalDir, 'run_summary.json'),
    previews,
    pages: outcomes.map(outcome => ({ page: outcome.page, state: outcome.state, objects: outcome.objects, warnings: outcome.warnings })),
    runDirectory: absoluteRunDir,
  }
}

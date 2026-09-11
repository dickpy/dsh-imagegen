/**
 * Per-skill configuration (`docs/skill-config.md`).
 *
 * Skills are data, so DSH itself has no notion of a skill setting; the canvas
 * supplies one. A skill declares what it needs in a `skill.config.json` beside
 * its `SKILL.md`, the panel renders a form from that declaration, the values
 * live in this plugin's settings namespace, and "save and apply" runs the
 * declared steps — the skill's own CLI (`editppt config …`) or a config file it
 * reads. A built-in recipe covers well-known skills that ship no declaration.
 *
 * Everything here treats the declaration as untrusted data:
 *
 *  - parsing never executes anything and never writes a file;
 *  - the manifest is bounded (fields, steps, content size) and versioned;
 *  - `apply` runs only when the user clicks, with the exact argv shown first;
 *  - commands run without a shell, from a fixed cwd, under a timeout;
 *  - `file` targets expand `~`, refuse `..` escapes, and refuse the DSH home's
 *    control files;
 *  - secrets never reach the run prompt, the run directory, or a step's
 *    reported detail/output.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CanvasSkillConfigField, CanvasSkillConfigView } from './protocol.ts'

/** Cap on one declaration's fields / steps / file body. */
const MAX_CONFIG_FIELDS = 32
const MAX_CONFIG_STEPS = 16
const MAX_CONFIG_CONTENT_BYTES = 8 * 1024
const MAX_CONFIG_LABEL_CHARS = 240
/** Wall-clock cap for one `command` step. */
const COMMAND_TIMEOUT_MS = 180_000
/** Cap on the command output kept for the panel. */
const MAX_COMMAND_OUTPUT_CHARS = 8_000

/** One guarded step runs only when the referenced field matches `set`. */
export interface SkillConfigGuard {
  field: string
  set: boolean
}

/** One `apply` step as the host executes it. */
export type SkillConfigStep =
  | { kind: 'command'; argv: string[]; cwd: 'run' | 'skill'; when?: SkillConfigGuard }
  | { kind: 'file'; path: string; content: string; when?: SkillConfigGuard }

/** A validated declaration. */
export interface SkillConfigManifest {
  note?: string
  fields: CanvasSkillConfigField[]
  steps: SkillConfigStep[]
}

/** Why a declaration was ignored. */
export type SkillConfigIssue = 'unreadable' | 'unsupported-version' | 'empty' | 'refused-path'

/** A declaration plus where it came from. */
export interface SkillConfigDeclaration {
  manifest: SkillConfigManifest
  source: 'skill' | 'plugin'
}

/** Read outcome for one skill: a declaration, an issue, or nothing at all. */
export interface SkillConfigLookup {
  declaration?: SkillConfigDeclaration
  issue?: SkillConfigIssue
}

/** The two settings dictionaries skill values live in. */
export interface SkillConfigStore {
  /** Non-secret values, keyed `<skill>/<field>`. */
  values: Record<string, string>
  /** Secret values, keyed `<skill>/<field>`. */
  secrets: Record<string, string>
}

/** Key one value inside the settings dictionaries. */
export function skillConfigKey(skill: string, field: string): string {
  return `${skill}/${field}`
}

/** Coerce one dictionary-shaped settings value into a detached record. */
export function asConfigDict(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

// ------------------------------------------------------------------ parsing

/** One field id the manifest may reference from `apply`. */
const FIELD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const FIELD_TYPES = new Set(['string', 'secret', 'boolean', 'number', 'select'])

/** Trim one declaration string to its cap, or undefined when it is not text. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** Parse one `fields[]` entry. */
function parseField(raw: unknown): CanvasSkillConfigField | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!FIELD_ID.test(id)) return undefined
  const type = typeof entry.type === 'string' && FIELD_TYPES.has(entry.type) ? entry.type as CanvasSkillConfigField['type'] : 'string'
  const label = text(entry.label, MAX_CONFIG_LABEL_CHARS) ?? id
  const description = text(entry.description, MAX_CONFIG_LABEL_CHARS)
  const fallback = text(entry.default, MAX_CONFIG_CONTENT_BYTES)
  const options = type !== 'select' || !Array.isArray(entry.options)
    ? undefined
    : entry.options
      .map(option => {
        if (option === null || typeof option !== 'object') return undefined
        const record = option as Record<string, unknown>
        const value = text(record.value, MAX_CONFIG_LABEL_CHARS)
        if (value === undefined) return undefined
        return { value, label: text(record.label, MAX_CONFIG_LABEL_CHARS) ?? value }
      })
      .filter((option): option is { value: string; label: string } => option !== undefined)
      .slice(0, 64)
  return {
    id,
    label,
    type,
    ...description === undefined ? {} : { description },
    ...entry.required === true ? { required: true } : {},
    ...fallback === undefined ? {} : { default: fallback },
    ...options === undefined || options.length === 0 ? {} : { options },
    // A secret is never expository, whatever the declaration claims.
    ...type === 'secret' ? {} : entry.expose === true ? { expose: true } : {},
  }
}

/** Parse one `apply[]` entry. */
function parseStep(raw: unknown): SkillConfigStep | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const when = entry.when !== null && typeof entry.when === 'object' ? entry.when as Record<string, unknown> : undefined
  const guard: SkillConfigGuard | undefined = when === undefined || typeof when.field !== 'string' || !FIELD_ID.test(when.field.trim())
    ? undefined
    : { field: when.field.trim(), set: when.set !== false }
  const kind = typeof entry.kind === 'string' ? entry.kind : ''
  if (kind === 'command') {
    if (!Array.isArray(entry.argv)) return undefined
    const argv = entry.argv
      .map(part => typeof part === 'string' ? part.trim() : '')
      .filter(part => part !== '')
      .slice(0, 32)
    if (argv.length === 0) return undefined
    return {
      kind: 'command',
      argv,
      cwd: entry.cwd === 'skill' ? 'skill' : 'run',
      ...guard === undefined ? {} : { when: guard },
    }
  }
  if (kind === 'file') {
    const target = text(entry.path, 1_024)
    const content = typeof entry.content === 'string' ? entry.content : undefined
    if (target === undefined || content === undefined) return undefined
    if (content.length > MAX_CONFIG_CONTENT_BYTES) return undefined
    return {
      kind: 'file',
      path: target,
      content,
      ...guard === undefined ? {} : { when: guard },
    }
  }
  return undefined
}

/**
 * Validate one declaration object.
 * @param raw - parsed JSON (or any value).
 * @returns the bounded manifest, or the issue that made it unusable.
 */
export function parseSkillConfigManifest(raw: unknown): { manifest?: SkillConfigManifest; issue?: SkillConfigIssue } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { issue: 'unreadable' }
  const entry = raw as Record<string, unknown>
  if (entry.version !== 1) return { issue: 'unsupported-version' }
  const fields = (Array.isArray(entry.fields) ? entry.fields : [])
    .map(parseField)
    .filter((field): field is CanvasSkillConfigField => field !== undefined)
    .slice(0, MAX_CONFIG_FIELDS)
  const steps = (Array.isArray(entry.apply) ? entry.apply : [])
    .map(parseStep)
    .filter((step): step is SkillConfigStep => step !== undefined)
    .slice(0, MAX_CONFIG_STEPS)
  if (fields.length === 0 && steps.length === 0) return { issue: 'empty' }
  const note = text(entry.note, MAX_CONFIG_LABEL_CHARS)
  return {
    manifest: {
      fields,
      steps,
      ...note === undefined ? {} : { note },
    },
  }
}

/** Read `<bundleDir>/skill.config.json` when the bundle has one. */
export async function readSkillConfigFile(bundleDir: string): Promise<{ manifest?: SkillConfigManifest; issue?: SkillConfigIssue } | undefined> {
  const file = path.join(bundleDir, 'skill.config.json')
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return { issue: 'unreadable' }
  }
  return parseSkillConfigManifest(raw)
}

// ------------------------------------------------------------------- values

/** Current values for one skill, secrets included (host side only). */
export function valuesFor(declaration: SkillConfigDeclaration, store: SkillConfigStore, skill: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const field of declaration.manifest.fields) {
    const key = skillConfigKey(skill, field.id)
    const stored = field.type === 'secret' ? store.secrets[key] : store.values[key]
    values.set(field.id, typeof stored === 'string' ? stored : (field.default ?? ''))
  }
  return values
}

/** Labels of required fields with no value yet, in declaration order. */
export function missingFields(declaration: SkillConfigDeclaration, values: ReadonlyMap<string, string>): string[] {
  return declaration.manifest.fields
    .filter(field => field.required === true && (values.get(field.id) ?? '').trim() === '')
    .map(field => field.label)
}

/**
 * The panel-facing view of one skill's configuration. An ignored declaration
 * still reports why, so the author sees the typo instead of an empty panel.
 * @param declaration - validated declaration, when there is one.
 * @param values - resolved values (secrets included).
 * @param issue - host-rendered copy for an ignored declaration, when any.
 */
export function configView(
  declaration: SkillConfigDeclaration | undefined,
  values: ReadonlyMap<string, string>,
  issue?: string,
): CanvasSkillConfigView | undefined {
  if (declaration === undefined) {
    return issue === undefined
      ? undefined
      : { fields: [], values: [], source: 'skill', applicable: false, missing: [], issue }
  }
  return {
    fields: declaration.manifest.fields,
    values: declaration.manifest.fields.map(field => {
      const value = values.get(field.id) ?? ''
      return field.type === 'secret'
        ? { id: field.id, set: value !== '' }
        : { id: field.id, set: value !== '', value }
    }),
    source: declaration.source,
    applicable: declaration.manifest.steps.length > 0,
    missing: missingFields(declaration, values),
    ...declaration.manifest.note === undefined ? {} : { note: declaration.manifest.note },
    ...issue === undefined ? {} : { issue },
  }
}

/**
 * The non-secret "configured values" block a run may carry, or undefined when
 * the declaration exposes nothing. Secrets never appear here.
 * @param declaration - validated declaration.
 * @param values - resolved values (secrets included; they are filtered out).
 */
export function configNote(declaration: SkillConfigDeclaration, values: ReadonlyMap<string, string>): string | undefined {
  const lines = declaration.manifest.fields
    .filter(field => field.expose === true && field.type !== 'secret')
    .map(field => {
      const value = (values.get(field.id) ?? '').trim()
      return value === '' ? undefined : `- ${field.label}: ${value}`
    })
    .filter((line): line is string => line !== undefined)
  return lines.length === 0 ? undefined : lines.join('\n')
}

// -------------------------------------------------------------------- apply

/** One step's outcome, ready for the panel. */
export interface SkillConfigStepResult {
  step: SkillConfigStep
  ok: boolean
  detail: string
  output?: string
}

/** Substitute `{field}` references; undefined when a referenced value is empty. */
function substitute(template: string, values: ReadonlyMap<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = template.replace(/\{([a-z0-9][a-z0-9-]{0,63})\}/g, (_match, id: string) => {
    const value = (values.get(id) ?? '').trim()
    if (value === '') {
      missing.push(id)
      return ''
    }
    return value
  })
  return { text, missing }
}

/** Whether one guarded step should run. */
function guardAllows(step: SkillConfigStep, values: ReadonlyMap<string, string>): boolean {
  const when = step.when
  if (when === undefined) return true
  const value = (values.get(when.field) ?? '').trim()
  return when.set ? value !== '' : value === ''
}

/**
 * Resolve one `file` target: expand `~`, refuse `..` escapes, and refuse the
 * DSH home's own control files (a declaration is untrusted, so the blast radius
 * of one careless click stays small).
 * @param raw - the declared path.
 * @returns the absolute target, or a refusal code.
 */
export function resolveConfigTarget(raw: string): { path: string } | { issue: SkillConfigIssue } {
  const trimmed = raw.trim()
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? path.join(homedir(), trimmed.slice(1))
    : trimmed
  if (!path.isAbsolute(expanded)) return { issue: 'refused-path' }
  // A `..` segment is refused before resolution, so no spelling of the escape
  // can land outside the intended tree.
  if (expanded.split(/[\\/]+/).includes('..')) return { issue: 'refused-path' }
  const normalized = path.resolve(expanded)
  const home = (process.env.DSH_HOME ?? '').trim() === '' ? path.join(homedir(), '.dsh') : process.env.DSH_HOME!.trim()
  const control = ['settings.yaml', 'cordis.patch.yml', 'cordis.yml'].map(name => path.join(home, name))
  const profiles = path.join(home, 'profiles')
  if (control.includes(normalized)) return { issue: 'refused-path' }
  if (normalized === profiles || normalized.startsWith(`${profiles}${path.sep}`)) return { issue: 'refused-path' }
  return { path: normalized }
}

/** Mask every secret value inside one report string. */
function mask(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.trim().length >= 4) out = out.split(secret).join('•••')
  }
  return out
}

/** Run one command without a shell, bounded by a timer and an output cap. */
function runCommand(argv: string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    let settled = false
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let output = ''
    const collect = (chunk: Buffer): void => { if (output.length < MAX_COMMAND_OUTPUT_CHARS) output += chunk.toString('utf8') }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: -1, output: `${output}\n超时（${Math.round(options.timeoutMs / 1000)}s）` })
    }, options.timeoutMs)
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, output: String(error.message) })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

/** Write one file atomically, creating its parents. */
async function writeConfigFile(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid.toString(36)}`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => { /* best effort */ })
    throw error
  }
}

/**
 * Execute a declaration's `apply` steps in order.
 * @param declaration - validated declaration.
 * @param values - resolved values (secrets included).
 * @param options - `runRoot` is the default cwd; `skillDir` backs `cwd: 'skill'`;
 *   `timeoutMs` overrides the per-command cap.
 * @returns one result per declared step, in order (secrets masked).
 */
export async function applySkillConfigSteps(
  declaration: SkillConfigDeclaration,
  values: ReadonlyMap<string, string>,
  options: { runRoot: string; skillDir?: string; timeoutMs?: number },
): Promise<SkillConfigStepResult[]> {
  const secrets = declaration.manifest.fields
    .filter(field => field.type === 'secret')
    .map(field => values.get(field.id) ?? '')
  const results: SkillConfigStepResult[] = []
  const stepDir = (step: SkillConfigStep): string => {
    if (step.kind === 'command' && step.cwd === 'skill' && options.skillDir !== undefined) return options.skillDir
    return options.runRoot
  }
  for (const step of declaration.manifest.steps) {
    if (!guardAllows(step, values)) {
      results.push({ step, ok: true, detail: 'skipped' })
      continue
    }
    if (step.kind === 'command') {
      const substituted = step.argv.map(part => substitute(part, values))
      const missing = [...new Set(substituted.flatMap(part => part.missing))]
      const argv = substituted.map(part => part.text)
      if (missing.length > 0) {
        results.push({ step, ok: false, detail: mask(argv.join(' '), secrets), output: `缺少配置：${missing.join('、')}` })
        continue
      }
      const cwd = stepDir(step)
      const outcome = await runCommand(argv, { cwd, timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS })
      const output = mask(outcome.output.trim().slice(-MAX_COMMAND_OUTPUT_CHARS), secrets)
      results.push({
        step,
        ok: outcome.code === 0,
        detail: mask(argv.join(' '), secrets),
        ...output === '' ? {} : { output },
      })
      continue
    }
    const target = resolveConfigTarget(step.path)
    if ('issue' in target) {
      results.push({ step, ok: false, detail: step.path, output: '该路径不允许写入（只允许绝对路径 / ~ 展开，且不能写 DSH 主目录的控制文件）' })
      continue
    }
    const rendered = substitute(step.content, values)
    if (rendered.missing.length > 0) {
      results.push({ step, ok: false, detail: `→ ${target.path}`, output: `缺少配置：${[...new Set(rendered.missing)].join('、')}` })
      continue
    }
    try {
      await writeConfigFile(target.path, rendered.text)
      results.push({ step, ok: true, detail: `→ ${target.path}` })
    } catch (error) {
      results.push({ step, ok: false, detail: `→ ${target.path}`, output: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

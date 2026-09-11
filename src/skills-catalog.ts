/**
 * Canvas skill catalog.
 *
 * Two sources merge into one menu:
 *
 *  - **Built-in canvas actions** — implemented by this plugin (text polish,
 *    image description, content extraction, summarization, image→editable-PPT).
 *    They ship with the plugin, need no installation, and their prompt bodies
 *    live here.
 *  - **External host skills** — everything the host skill registry
 *    (`ctx.skills`, i.e. the user's `~/.dsh/skills` plus project roots) offers.
 *    Their bodies are loaded at run time and never copied into the canvas.
 *
 * The catalog is the *only* place that decides a skill's execution tier:
 * built-ins declare it, and an external skill is `heavy` when its metadata or
 * name marks it as a long multi-step job (deck/ppt/document pipelines), light
 * otherwise.
 */

import type {
  CanvasNodeType,
  CanvasSkillDescriptor,
  CanvasSkillTier,
} from './protocol.ts'

/** Copy function resolving the catalog's own i18n keys. */
export type CatalogTranslate = (key: string, params?: Record<string, string | number>) => string

/** The external-skill name of the deck-rebuilding pipeline this plugin knows
 *  how to drive end to end (image → editable .pptx). */
export const EDITABLE_PPT_SKILL = 'image-to-editable-ppt'

/** Origin label used for built-in catalog entries. */
const BUILTIN_ORIGIN = 'builtin'

/** Style presets offered by the text polish action. */
export const POLISH_STYLES = ['formal', 'casual', 'shorter', 'expand', 'custom'] as const
export type PolishStyle = typeof POLISH_STYLES[number]

/** Copy keys of the polish style labels (kept literal so the copy table can
 *  typecheck them; a computed template literal would widen to `string`). The
 *  catalog reuses the canvas button labels so one style reads the same in the
 *  picker and on the text node toolbar. */
const POLISH_STYLE_KEYS = {
  formal: 'canvas.polish.formal',
  casual: 'canvas.polish.casual',
  shorter: 'canvas.polish.shorter',
  expand: 'canvas.polish.expand',
  custom: 'canvas.polish.custom',
} as const

/** Built-in ids (stable: they are persisted on produced nodes as provenance). */
export const BUILTIN_POLISH = 'polish.text'
export const BUILTIN_DESCRIBE = 'describe.image'
export const BUILTIN_EXTRACT = 'extract.content'
export const BUILTIN_PPT = 'ppt.fromImages'

/**
 * The built-in catalog. Order is the menu order: the high-frequency text
 * actions first, the long-running deck conversion last.
 * @param t - copy resolver for the current UI language.
 * @param options - whether the host agent runtime answered; a heavy entry
 *   without one stays visible but marked unavailable. `pptInstallUrl` is the
 *   upstream home of the deck pipeline, offered as a one-click install.
 */
export function builtinCanvasSkills(
  t: CatalogTranslate,
  options: { agentAvailable: boolean; pptInstallUrl?: string },
): CanvasSkillDescriptor[] {
  const polishStyles: CanvasSkillDescriptor['params'] = POLISH_STYLES.map(style => ({ id: style, label: t(POLISH_STYLE_KEYS[style]) }))
  return [
    {
      id: BUILTIN_POLISH,
      name: t('canvas.skills.polish'),
      description: t('canvas.skills.polishDesc'),
      origin: BUILTIN_ORIGIN,
      tier: 'light',
      accepts: ['text'],
      output: 'text',
      params: polishStyles,
    },
    {
      id: BUILTIN_DESCRIBE,
      name: t('canvas.skills.describe'),
      description: t('canvas.skills.describeDesc'),
      origin: BUILTIN_ORIGIN,
      tier: 'light',
      accepts: ['image'],
      output: 'text',
    },
    {
      id: BUILTIN_EXTRACT,
      name: t('canvas.skills.extract'),
      description: t('canvas.skills.extractDesc'),
      origin: BUILTIN_ORIGIN,
      tier: 'light',
      accepts: ['file', 'image'],
      output: 'text',
    },
    {
      id: BUILTIN_PPT,
      name: t('canvas.skills.ppt'),
      description: t('canvas.skills.pptDesc'),
      origin: BUILTIN_ORIGIN,
      tier: 'heavy',
      accepts: ['image'],
      output: 'file',
      costHint: t('canvas.skills.pptCost'),
      requires: options.agentAvailable ? [t('canvas.skills.pptRequires')] : [t('canvas.skills.needAgent')],
      // Backed by a user-installed host skill: the picker offers the install.
      skillName: EDITABLE_PPT_SKILL,
      ...options.pptInstallUrl === undefined ? {} : { installUrl: options.pptInstallUrl },
    },
  ]
}

/** Long-running pipeline markers: a skill matching one of these runs an agent. */
const HEAVY_SKILL_HINTS = [
  'ppt', 'pptx', 'slide', 'deck', 'keynote', 'presentation',
  'pdf', 'word', 'docx', 'excel', 'xlsx',
  'video', 'render', 'export',
  'batch', 'pipeline', 'ocr',
]

/** Minimum shape this catalog needs from a host `SkillSummary`. Structural so
 *  the host half never depends on the skill package at run time. */
export interface ExternalSkillSummary {
  name: string
  description: string
  whenToUse?: string
  source?: string
  path?: string
  metadata?: Readonly<Record<string, unknown>>
}

/** Declared tier in skill frontmatter, when a skill author set one. */
function declaredTier(metadata: Readonly<Record<string, unknown>> | undefined): CanvasSkillTier | undefined {
  if (metadata === undefined) return undefined
  for (const key of ['tier', 'canvasTier', 'executionTier', 'runtime']) {
    const value = metadata[key]
    if (value === 'heavy' || value === 'light') return value
  }
  return undefined
}

/**
 * Decide whether an external skill needs the headless-agent tier. Explicit
 * frontmatter wins; otherwise the name/description is matched against the
 * long-running pipeline vocabulary. Unknown skills default to `light`, which is
 * the cheaper and more predictable failure mode (a light run that is too small
 * reports an actionable error instead of silently burning an agent run).
 */
export function tierOfExternalSkill(skill: ExternalSkillSummary): CanvasSkillTier {
  const declared = declaredTier(skill.metadata)
  if (declared !== undefined) return declared
  const haystack = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`.toLowerCase()
  return HEAVY_SKILL_HINTS.some(hint => haystack.includes(hint)) ? 'heavy' : 'light'
}

/** Whether one external skill is the deck pipeline this plugin drives itself. */
export function isEditablePptSkill(name: string): boolean {
  return name === EDITABLE_PPT_SKILL || name.includes('image-to-editable') || name.includes('editable-ppt')
}

/**
 * Merge the host registry's summaries into the canvas catalog. Only
 * model-invocable skills are offered: the canvas runs skills through a model,
 * so a user-only (slash-command) skill would fail halfway.
 * @param skills - host registry summaries.
 * @param t - copy resolver for the current UI language.
 * @param options - run-layer availability, used for the heavy entries' hints.
 */
export function mergeExternalSkills(
  skills: readonly ExternalSkillSummary[],
  t: CatalogTranslate,
  options: { agentAvailable: boolean },
): CanvasSkillDescriptor[] {
  return skills.map(skill => {
    const tier = tierOfExternalSkill(skill)
    const name = t('canvas.skills.externalName', { name: skill.name })
    return {
      id: `skill:${skill.name}`,
      name,
      description: skill.description.trim() === '' ? t('canvas.skills.noDescription') : skill.description,
      ...skill.whenToUse === undefined || skill.whenToUse.trim() === '' ? {} : { whenToUse: skill.whenToUse },
      origin: 'external',
      tier,
      accepts: ['image', 'text', 'file'],
      output: 'text',
      ...tier === 'heavy'
        ? {
            costHint: t('canvas.skills.externalHeavyCost', { name: skill.name }),
            requires: options.agentAvailable ? [] : [t('canvas.skills.needAgent')],
          }
        : {},
    }
  })
}

/** The whole catalog for one canvas: built-ins first, then host skills. */
export function canvasSkillCatalog(
  external: readonly ExternalSkillSummary[],
  t: CatalogTranslate,
  options: { agentAvailable: boolean; pptInstallUrl?: string },
): CanvasSkillDescriptor[] {
  const builtins = builtinCanvasSkills(t, options)
  const taken = new Set(builtins.map(skill => skill.id))
  const merged = mergeExternalSkills(external, t, options)
    // A host skill never shadows a built-in action id.
    .filter(skill => !taken.has(skill.id))
  return [...builtins, ...merged]
}

/**
 * Whether a catalog entry's backing host skill is present.
 *
 * Entries without a host skill (the prompt actions) are always runnable; the
 * deck conversion is not, and neither is an external entry the registry stopped
 * reporting. `undefined` means "the registry could not be asked", which is
 * deliberately reported as *not* missing so the UI never nags without evidence.
 * @param skill - the catalog entry.
 * @param installed - names the registry actually exposes.
 */
export function skillMissing(skill: CanvasSkillDescriptor, installed: ReadonlySet<string> | undefined): boolean {
  if (skill.skillName === undefined) return false
  if (installed === undefined) return false
  return !installed.has(skill.skillName)
}

/** Resolve one catalog entry by id (built-ins are stable, externals prefixed). */
export function findCanvasSkill(catalog: readonly CanvasSkillDescriptor[], id: string): CanvasSkillDescriptor | undefined {
  return catalog.find(skill => skill.id === id)
}

/** Whether a node type may feed one skill. */
export function skillAcceptsNode(skill: CanvasSkillDescriptor, type: CanvasNodeType): boolean {
  if (type === 'config') return false
  return skill.accepts.includes(type)
}

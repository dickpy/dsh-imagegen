/**
 * Staged form model behind the plugin settings card. A card stages what the
 * user types and writes it only when they save — the settings write is a
 * durable, revision-fenced document mutation, so staging keeps what is on
 * screen exactly what a save would store. Self-contained slice of the same
 * pattern the dsh-web-ui family cards use (this package must not depend on a
 * sibling UI package).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** How one field converts between its stored value and its draft text. */
export interface FieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
  /**
   * True for secret fields (role('secret') in the namespace schema): the
   * redacted wire view never returns the stored value, so the form treats an
   * empty draft as "no change" and judges writes by the namespace's secrets
   * sidecar instead of the user layer.
   */
  secret?: boolean
}

/** One field as the card renders it. */
export interface FieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state every plugin settings card shares. */
export interface CardShell {
  /** False while the namespace is still loading; the card renders nothing. */
  available: boolean
  /** Whether the namespace is actually served (the bridge answered). */
  exposed: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions the card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** One staged edit resolved into the write a save performs. */
interface PlannedWrite {
  /** Field this entry writes. */
  field: string
  /** Perform the write and report whether the Host holds the staged value afterwards. */
  run: (() => Promise<boolean>) | undefined
}

/** A free-text field. An empty draft clears the field. */
export function textField(field: string): FieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** A newline/comma-separated model list, persisted as a normalized string array. */
export function stringListField(field: string): FieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : '',
    parse: (text) => {
      const values = [...new Set(text.split(/[\n,]/).map(item => item.trim()).filter(Boolean))]
      return values.length === 0 ? { kind: 'clear' } : { kind: 'set', value: values }
    },
  }
}

/** A boolean field, edited through true/false draft text. */
export function booleanField(field: string): FieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/**
 * A secret field (role('secret') in the namespace schema). The stored value is
 * never rendered or returned by the redacted wire view, so:
 *  - an empty draft means "no change" (typing nothing must never clear an
 *    invisible stored key); the dedicated clear action stages an explicit clear;
 *  - a write's outcome is judged by the namespace's secrets sidecar through
 *    the {@link CardForm} `secretSettled` hook, never by the user layer.
 */
export function secretField(field: string): FieldSpec {
  return {
    field,
    secret: true,
    format: () => '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return undefined
      return { kind: 'set', value: trimmed }
    },
  }
}

/**
 * Stages one card's edits over one settings scope and writes them on save.
 *
 * The Host is the only authority on whether a value was accepted — its
 * validators own the constraints no schema can express — so the outcome is
 * read back from the section rather than predicted here. A save that did not
 * land keeps its drafts, so the user can correct them instead of retyping.
 */
export class CardForm<T> {
  private readonly specs: Map<string, FieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param specs - the fields this card edits.
   * @param options.secretSettled - for secret fields, whether the namespace
   *   currently holds a stored secret (the redacted view never round-trips the
   *   value, so a write's outcome is read from the secrets sidecar instead).
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    specs: FieldSpec[],
    private readonly options: { secretSettled?: (field: string) => boolean } = {},
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /** Publish a projection of this form, rebuilt whenever the scope or a draft changes. */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status !== 'loading',
      exposed: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** Read one field's state from the effective section and its staged draft. */
  field(field: string): FieldState {
    const spec = this.specOf(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      // A secret field's empty draft is "no change" (see secretField), never
      // an invalid state — the stored value is invisible, so the user cannot
      // be expected to type over it.
      invalid: write === undefined && !(spec.secret === true && staged.text.trim() === ''),
    }
  }

  /** The actions the card's slot registration injects. */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.specOf(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   * @returns settlement after every write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no write: the form is still dirty, and the save
   * refuses rather than dropping the edit. A staged edit that matches the
   * effective section is not a write at all.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.specOf(field)
      if (staged.clear) {
        const present = spec.secret === true
          ? (this.options.secretSettled?.(field) ?? false)
          : this.stored(field)
        if (present) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    const spec = this.specOf(field)
    if (spec.secret === true) return !(this.options.secretSettled?.(field) ?? false)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    const spec = this.specOf(field)
    if (spec.secret === true) return this.options.secretSettled?.(field) ?? true
    return this.userLayer()?.[field] === value
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private specOf(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`settings card has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return (this.snapshotOf().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.snapshotOf().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshotOf().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Staged form model for the channel list of the settings card. Mirrors the
 * CardForm staging pattern (dirty → one save) but for a structured value, so
 * the card can edit N channels, per-channel keys, and the default-channel
 * flag, then persist everything in one revision-fenced mutate call.
 *
 * Storage rules (dictated by dsh-settings semantics):
 *  - the whole `channels` array is written wholesale via `path: ['channels']`;
 *  - every channel's API key lives at `channelSecrets.<channelId>` (a secret
 *    dict), written per-key so untouched keys are never clobbered by a save
 *    the reader could not see (keys are redacted out of the wire view);
 *  - path ops never navigate *inside* the channels array.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChannelConfig, ModelMapping } from '../protocol.ts'
import type { ImageGenScope, SettingsOp } from './settings-scope.ts'

/** One channel as the editor stages it (secrets never travel here). */
export interface ChannelDraft {
  id: string
  preset: string
  name: string
  apiUrl: string
  models: ModelMapping[]
}

/** One staged key edit for a channel. */
export type KeyEdit = { kind: 'set'; value: string } | { kind: 'clear' }

/** The state the card renders. */
export interface ChannelsFormState {
  /** Staged channel list (the scope value when nothing is staged). */
  channels: ChannelDraft[]
  /** Which channels currently hold a stored secret (staged edits included). */
  keySet: Record<string, boolean>
  /** The effective default channel id. */
  defaultChannelId: string
  /** Whether a save would write anything. */
  dirty: boolean
  /** Whether the document accepts writes. */
  writable: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save failed (cleared by the next edit or save). */
  failed: boolean
}

/** The actions the card's slot entry injects. */
export interface ChannelsFormActions {
  /** Replace the whole channel list (add/edit/remove go through here). */
  setChannels: (channels: ChannelDraft[]) => void
  /** Stage a key for one channel ('' clears; undefined = no staged change). */
  setChannelKey: (id: string, value: string | undefined) => void
  /** Stage the default-channel flag. */
  setDefaultChannel: (id: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  commit: () => Promise<void>
  /** Drop every staged edit. */
  discard: () => void
}

/** Deep equality over JSON-compatible data (the change predicate). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => key in right && deepEqualJson(left[key], right[key]))
}

/** Trim and normalize a draft channel (models never carry empty aliases). */
function stripChannel(channel: ChannelDraft): ChannelDraft {
  const models = channel.models
    .map(model => ({ alias: model.alias.trim(), id: model.id.trim() === '' ? model.alias.trim() : model.id.trim() }))
    .filter(model => model.alias !== '')
  return {
    id: channel.id,
    preset: channel.preset,
    name: channel.name.trim(),
    apiUrl: channel.apiUrl.trim(),
    models: [...new Map(models.map(model => [model.alias, model])).values()],
  }
}

export class ChannelsForm {
  private stagedChannels: ChannelDraft[] | null = null
  private readonly stagedKeys = new Map<string, KeyEdit>()
  private stagedDefault: string | null = null
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(private readonly scope: ImageGenScope) {
    scope.subscribe(() => { this.publish() })
    scope.subscribeSecretSets(() => { this.publish() })
  }

  /** Publish a projection of this form, rebuilt on every scope or draft change. */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /** Subscribe to staged and persisted channel changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The staged channel list, or the scope value when nothing is staged. */
  private channelsValue(): ChannelDraft[] {
    const view = this.scope.getSnapshot().value as { channels?: ChannelConfig[] } | undefined
    return this.stagedChannels ?? (Array.isArray(view?.channels) ? view.channels.map(toDraft) : [])
  }

  /** Whether a channel currently holds a stored or staged secret. */
  private keyHeld(id: string): boolean {
    const edit = this.stagedKeys.get(id)
    if (edit !== undefined) return edit.kind === 'set' && edit.value !== ''
    return this.scope.getSecretSetSnapshot(`channelSecrets.${id}`)
  }

  private defaultValue(): string {
    if (this.stagedDefault !== null) return this.stagedDefault
    const view = this.scope.getSnapshot().value as { defaultChannelId?: string } | undefined
    const channels = this.channelsValue()
    if (view?.defaultChannelId !== undefined && channels.some(channel => channel.id === view.defaultChannelId)) return view.defaultChannelId
    return channels[0]?.id ?? ''
  }

  private dirtyValue(): boolean {
    const channels = this.channelsValue()
    const stagedChanged = this.stagedChannels !== null && !deepEqualJson(this.stagedChannels, scopeChannelsOf(this.scope))
    const scopeView = this.scope.getSnapshot().value as { defaultChannelId?: string } | undefined
    const scopeDefault = scopeView?.defaultChannelId ?? channels[0]?.id ?? ''
    const defaultChanged = this.stagedDefault !== null && this.stagedDefault !== scopeDefault
    return stagedChanged || defaultChanged || this.stagedKeys.size > 0
  }

  /** The card-facing snapshot. */
  snapshot(): ChannelsFormState {
    const channels = this.channelsValue()
    const keySet: Record<string, boolean> = {}
    for (const channel of channels) keySet[channel.id] = this.keyHeld(channel.id)
    return {
      channels,
      keySet,
      defaultChannelId: this.defaultValue(),
      dirty: this.dirtyValue(),
      writable: this.scope.getSnapshot().writable !== false,
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** The actions the card's slot registration injects. */
  actions(): ChannelsFormActions {
    return {
      setChannels: (channels) => { this.stageChannels(channels) },
      setChannelKey: (id, value) => { this.stageKey(id, value) },
      setDefaultChannel: (id) => { this.stagedDefault = id; this.failed = false; this.publish() },
      commit: () => this.commit(),
      discard: () => {
        if (this.stagedChannels === null && this.stagedKeys.size === 0 && this.stagedDefault === null && !this.failed) return
        this.stagedChannels = null
        this.stagedKeys.clear()
        this.stagedDefault = null
        this.failed = false
        this.publish()
      },
    }
  }

  // ------------------------------------------------------------------ staging

  private stageChannels(channels: ChannelDraft[]): void {
    const cleaned = channels.map(stripChannel)
    this.stagedChannels = cleaned
    this.failed = false
    this.publish()
  }

  private stageKey(id: string, value: string | undefined): void {
    if (value === undefined || value.trim() === '') {
      if (this.keyHeld(id)) this.stagedKeys.set(id, { kind: 'clear' })
      // An empty key for a key-less channel stages nothing.
    } else {
      this.stagedKeys.set(id, { kind: 'set', value: value.trim() })
    }
    this.failed = false
    this.publish()
  }

  // ----------------------------------------------------------------- save

  /** Build the single batch of path ops a save performs. */
  private planOps(): SettingsOp[] {
    const ops: SettingsOp[] = []
    if (this.stagedChannels !== null) {
      ops.push({ op: 'set', path: ['channels'], value: this.stagedChannels })
      // Once channels exist, the legacy flat fields are obsolete (idempotent).
      ops.push({ op: 'unset', path: ['apiUrl'] })
      ops.push({ op: 'unset', path: ['apiKey'] })
      ops.push({ op: 'unset', path: ['imageModels'] })
    }
    for (const [id, edit] of this.stagedKeys) {
      if (edit.kind === 'set') ops.push({ op: 'set', path: ['channelSecrets', id], value: edit.value })
      else ops.push({ op: 'unset', path: ['channelSecrets', id] })
    }
    if (this.stagedDefault !== null) {
      ops.push({ op: 'set', path: ['defaultChannelId'], value: this.stagedDefault })
    }
    return ops
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   * @returns settlement after the write settles.
   */
  async commit(): Promise<void> {
    if (this.saving) return
    const ops = this.planOps()
    if (ops.length === 0) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.mutateOps(ops)
      this.stagedChannels = null
      this.stagedKeys.clear()
      this.stagedDefault = null
      this.failed = false
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Project a stored channel into a draft (secrets never travel in channels). */
function toDraft(channel: ChannelConfig): ChannelDraft {
  return { id: channel.id, preset: channel.preset, name: channel.name, apiUrl: channel.apiUrl, models: channel.models.map(model => ({ ...model })) }
}

/** The scope's current channels value (a plain array), for change detection. */
function scopeChannelsOf(scope: ImageGenScope): unknown {
  const view = scope.getSnapshot().value as { channels?: unknown } | undefined
  return Array.isArray(view?.channels) ? view.channels : []
}

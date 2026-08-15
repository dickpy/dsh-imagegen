/**
 * Browser-side settings scope for the dsh-imagegen namespace, served by the
 * plugin's own loopback bridge routes (/api/dsh-imagegen/settings). The
 * official rc.6 settings scope answers "unavailable" for every third-party
 * namespace (the host-apiproxy allowlist is hard-coded), so this package
 * re-serves its namespace through the host settings seam over a same-origin,
 * loopback-only HTTP pair — the same pattern the dsh-web-ui family bridge
 * uses, self-contained per plugin.
 */

import {
  createSnapshotStore,
  type SettingsScope,
  type SettingsScopeSnapshot,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { SETTINGS_API } from '../protocol.ts'

/** The fields this plugin's settings card edits. */
export interface ImageGenConfig {
  enabled?: boolean
  announceToAgent?: boolean
  apiUrl?: string
  apiKey?: string
}

/** Wire shape of one namespace view from the bridge. */
interface BridgeView {
  ns: string
  value: unknown
  base?: unknown
  user?: unknown
  revision: number
  secrets?: Array<{ path: string[]; set: boolean }>
}

/** The bridge response envelope ({ ok: true, value } | { ok: false, code, message }). */
type BridgeEnvelope =
  | { ok: true; value: { namespaces?: BridgeView[]; writable?: boolean } | BridgeView }
  | { ok: false; code: string; message: string }

/** Settings wire face over the bridge routes (fetch-backed). */
function createBridgeApi(fetchFn: typeof fetch): {
  settings: {
    describe(payload: Record<string, never>): Promise<{ result: BridgeEnvelope }>
    mutate(payload: { ns: string; ops: unknown[]; expectedRevision?: number }): Promise<{ result: BridgeEnvelope }>
  }
} {
  const post = async (path: string, body: unknown): Promise<{ result: BridgeEnvelope }> => {
    try {
      const response = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        return { result: { ok: false, code: 'internal', message: `bridge HTTP ${response.status}` } }
      }
      return { result: await response.json() as BridgeEnvelope }
    } catch {
      return { result: { ok: false, code: 'internal', message: 'settings bridge unreachable' } }
    }
  }
  return {
    settings: {
      describe: async payload => post(SETTINGS_API.describe, payload),
      mutate: async payload => post(SETTINGS_API.mutate, payload),
    },
  }
}

/**
 * A SettingsScope over the bridge face: serialized queue, revision-fenced
 * writes, recovery read after a refusal. Mirrors the official controller's
 * ordering but trusts the Host-seam value without re-running the wire-schema
 * validation — the seam already validated it.
 */
class BridgeScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  /** Whether the namespace currently holds a stored secret (e.g. apiKey). */
  private readonly keySet: SnapshotStore<boolean>
  private tail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly api: ReturnType<typeof createBridgeApi>['settings'],
    private readonly spec: { namespace: string },
  ) {
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    })
    this.keySet = createSnapshotStore(false)
  }

  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /** Whether a stored secret exists (from the redacted view's secrets list). */
  getKeySetSnapshot(): boolean {
    return this.keySet.getSnapshot()
  }

  /** Observe the secret-set flag. */
  subscribeKeySet(listener: () => void): () => void {
    return this.keySet.subscribe(listener)
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Queue a bridge refresh. */
  load(): Promise<void> {
    return this.enqueue(() => this.read())
  }

  set(field: string, value: unknown): Promise<void> {
    return this.enqueue(() => this.write({ op: 'set', path: [field], value }))
  }

  unset(field: string): Promise<void> {
    return this.enqueue(() => this.write({ op: 'unset', path: [field] }))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    this.tail = task.catch(() => {})
    return task
  }

  private async read(): Promise<void> {
    let response
    try {
      response = await this.api.describe({})
    } catch {
      if (!this.disposed) this.store.update(draft => { draft.status = 'unavailable' })
      return
    }
    if (!response.result.ok || this.disposed) {
      if (!this.disposed) this.store.update(draft => { draft.status = 'unavailable' })
      return
    }
    const { namespaces, writable } = response.result.value as { namespaces?: BridgeView[]; writable?: boolean }
    const view = namespaces?.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update(draft => {
        draft.status = 'unavailable'
        draft.writable = writable === true
      })
      this.keySet.set(false)
      return
    }
    this.accept(view, writable)
  }

  private async write(op: { op: 'set' | 'unset'; path: string[]; value?: unknown }): Promise<void> {
    const revision = this.getSnapshot().revision
    let response
    try {
      response = await this.api.mutate({
        ns: this.spec.namespace,
        ops: [op],
        ...revision === undefined ? {} : { expectedRevision: revision },
      })
    } catch {
      await this.read()
      return
    }
    if (!response.result.ok || this.disposed) {
      await this.read()
      return
    }
    this.accept(response.result.value as BridgeView, undefined)
  }

  private accept(view: BridgeView, writable: boolean | undefined): void {
    this.store.update(draft => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      if (writable !== undefined) draft.writable = writable
      draft.status = 'ready'
      // Trust the Host-seam value: the seam already validated it, and the
      // card binds without a narrowing decoder.
      draft.value = view.value as T
    })
    this.keySet.set(Array.isArray(view.secrets) && view.secrets.some(secret => secret.set))
  }
}

/** The bound scope plus the secret-set flag, as the card and panel consume it. */
export interface ImageGenScope extends SettingsScope<ImageGenConfig> {
  /** Queue a bridge refresh (the invalidation path re-reads the namespace). */
  load(): Promise<void>
  getKeySetSnapshot(): boolean
  subscribeKeySet(listener: () => void): () => void
}

/**
 * Bind the dsh-imagegen settings scope over the bridge routes and start its
 * initial read (the caller mounts nothing until the scope settles).
 * @param fetchFn - the fetch implementation (the global fetch on loopback).
 * @returns the scope; unavailable when the bridge is unreachable.
 */
export function bindImageGenScope(fetchFn: typeof fetch = fetch): ImageGenScope {
  const controller = new BridgeScopeController<ImageGenConfig>(createBridgeApi(fetchFn).settings, {
    namespace: 'dsh-imagegen',
  })
  void controller.load()
  return controller
}

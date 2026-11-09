import type { IncomingMessage } from 'node:http'

/** A profile-level opt-in; never infer trust from request headers or settings writes. */
export type RemoteAccess = 'read-only' | 'trusted-host'
export type RequestRejection = 401 | 403

/** Structural compatibility with the official Host Connection (old dev typings omit it). */
export interface RemoteAccessConnection {
  readonly browserPeer?: { readonly id?: unknown }
  readonly admit?: (request: Pick<IncomingMessage, 'headers'>) =>
    { readonly peer: { readonly id?: unknown } } | { readonly rejection: RequestRejection }
}

/** Preserve the original literal loopback + same-origin policy, including proxy safety. */
export function isLoopbackRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Pure decision surface: callers must obtain admission from official connection.admit. */
export function remoteAccessRejection(facts: {
  loopback: boolean
  crossSite: boolean
  remoteAccess?: unknown
  describe?: boolean
  ownerId?: unknown
  admission?: { readonly peer: { readonly id?: unknown } } | { readonly rejection: RequestRejection }
}): RequestRejection | undefined {
  if (facts.loopback) return undefined
  if (facts.crossSite) return 403
  if (facts.admission === undefined) return 403
  if ('rejection' in facts.admission) return facts.admission.rejection === 401 ? 401 : 403
  // Matching principals alone is insufficient: only the shared browser owner Peer is allowed.
  if (typeof facts.ownerId !== 'string' || facts.ownerId === '' || facts.admission.peer?.id !== facts.ownerId) return 403
  if (facts.remoteAccess !== 'trusted-host' && facts.describe !== true) return 403
  return undefined
}

/** Adapt official synchronous admission; missing/old services and thrown errors fail closed. */
export function requestAccessRejection(
  request: IncomingMessage,
  remoteAccess: unknown,
  resolveConnection?: () => RemoteAccessConnection | undefined,
  describe = false,
): RequestRejection | undefined {
  if (isLoopbackRequest(request)) return undefined
  const site = request.headers['sec-fetch-site']
  // Fetch metadata also protects requests without Origin (e.g. cross-site image GETs).
  const crossSite = (Array.isArray(site) ? site : [site]).some(value => value?.trim().toLowerCase() === 'cross-site')
  if (crossSite) return 403
  try {
    const connection = resolveConnection?.()
    return remoteAccessRejection({
      loopback: false,
      crossSite,
      remoteAccess,
      describe,
      ownerId: connection?.browserPeer?.id,
      admission: typeof connection?.admit === 'function' ? connection.admit(request) : undefined,
    })
  } catch {
    return 403
  }
}

/** Pure bridge policy: reject root edits, policy edits, malformed ops and prototype paths. */
export function remoteSettingsMutationAllowed(namespace: unknown, expectedNamespace: string, ops: unknown): boolean {
  if (namespace !== expectedNamespace || !Array.isArray(ops)) return false
  return ops.every((op: unknown) => {
    if (typeof op !== 'object' || op === null) return false
    const edit = op as { op?: unknown; path?: unknown }
    if (edit.op !== 'set' && edit.op !== 'unset') return false
    if (!Array.isArray(edit.path) || edit.path.length === 0) return false
    if (edit.path[0] === 'remoteAccess') return false
    return edit.path.every(part => typeof part === 'string' && part !== '__proto__' && part !== 'prototype' && part !== 'constructor')
  })
}

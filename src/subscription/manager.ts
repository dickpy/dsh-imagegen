/**
 * Subscription account manager: login flows, blob storage through the DSH
 * Credentials service, token refresh with per-account locking, and image
 * generation on the logged-in account.
 *
 * The account store pattern follows @goodandready/dsh-subscriptions (MIT,
 * (c) 2026 GooDAnDReaDY) lib/accounts.js, trimmed to one account per vendor
 * (no rotation, no cooldowns) because this bundle has exactly two vendors
 * and no chat adapter to protect.
 *
 * Isolation invariants (project rules):
 * - OAuth blobs live under SUBSCRIPTION_OAUTH_* refs, never the API-key refs.
 * - Login/logout never touches any other setting or credential.
 * - The browser side never sees a token; it sees the authorize URL and
 *   status words only. Generation happens host-side, mirroring every other
 *   adapter in this bundle.
 */
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type CredentialProvider from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { createPkce, type Pkce } from './oauth.js'
import { startLoopback } from './loopback.js'
import { parseBlob, serializeBlob, type SubscriptionBlob } from './blob.js'
import {
  CODEX_IMAGE_EDIT_URL,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_URL,
  CODEX_REDIRECT_URI,
  codexAuthorizeUrl,
  codexConfig,
  codexExchangeCode,
  codexIdentityHeaders,
  codexRefresh,
} from './vendors/codex.js'
import {
  GROK_IMAGE_EDIT_URL,
  GROK_IMAGE_MODEL,
  GROK_IMAGE_URL,
  GROK_REDIRECT_URI,
  grokAuthorizeUrl,
  grokBeginDeviceLogin,
  grokConfig,
  grokExchangeCode,
  grokIdentityHeaders,
  grokPollDeviceLogin,
  grokRefresh,
} from './vendors/grok.js'
import {
  OPENROUTER_IMAGE_MODEL,
  OPENROUTER_IMAGE_URL,
  OPENROUTER_REDIRECT_URI,
  openRouterAuthorizeUrl,
  openRouterExchangeCode,
  openRouterIdentityHeaders,
  openRouterRefresh,
} from './vendors/openrouter.ts'
import {
  ANTIGRAVITY_REDIRECT_URI,
  antigravityAuthorizeUrl,
  antigravityConfig,
  antigravityExchangeCode,
  antigravityGenerateImage,
  antigravityRefresh,
  antigravityResolveProject,
} from './vendors/antigravity.js'
import { SUBSCRIPTION_PROVIDER_DISPLAY_NAMES, type SubscriptionProvider } from '../protocol.ts'

/** Vendor ids used by the credential refs and the wire calls. */
export type SubscriptionVendor = 'codex' | 'grok' | 'antigravity' | 'openrouter'

/**
 * Reference image passed to edit calls. Structural so callers can pass their
 * own resolved types without importing from the plugin root.
 */
export interface SubscriptionReferenceImage {
  data: Uint8Array
  mediaType: string
}

/** The vendor each dsh-image-gen subscription provider maps onto. */
export function vendorOf(provider: SubscriptionProvider): SubscriptionVendor {
  if (provider === 'chatgpt-sub') return 'codex'
  if (provider === 'google-sub') return 'antigravity'
  if (provider === 'openrouter-sub') return 'openrouter'
  return 'grok'
}

/** Credential ref one vendor's OAuth blob is stored under (index fixed at 1). */
export function subscriptionOauthRef(vendor: SubscriptionVendor): CredentialRef {
  return credentialRef(`DSH_IMAGEGEN_${vendor.toUpperCase()}_OAUTH_1`)
}

/** Sizes both vendors understand. */
export const SUBSCRIPTION_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const

/**
 * Reference images per edit call. Every subscription channel accepts at
 * least this many (Codex edits up to 16, Grok up to 5, Antigravity up to 10),
 * so 5 keeps one shared guard in line with the Studio UI's upload cap.
 */
export const SUBSCRIPTION_MAX_REFERENCE_IMAGES = 5

/** Login status the settings card renders as a badge. */
export type SubscriptionLoginStatus =
  | { state: 'logged-in'; email: string }
  | { state: 'logged-out' }
  | { state: 'unknown' }

/** Callback shape the login flow reports to the pending HTTP response. */
export interface LoginOutcome {
  ok: boolean
  email?: string
  message?: string
}

/**
 * Per-application manager instance. Constructed once in the plugin entry,
 * owns the pending-login map (PKCE state to login session) and the refresh
 * locks; nothing here is persisted except the blobs themselves.
 */
/** Provider names by vendor for login-result pages and errors. */
function providerNameOf(vendor: SubscriptionVendor): string {
  return SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[vendor === 'codex' ? 'chatgpt-sub' : vendor === 'antigravity' ? 'google-sub' : vendor === 'openrouter' ? 'openrouter-sub' : 'grok-sub']
}

export class SubscriptionManager {
  private readonly pending = new Map<string, { vendor: SubscriptionVendor; pkce: Pkce }>()
  private readonly refreshLocks = new Map<SubscriptionVendor, Promise<SubscriptionBlob>>()
  /** Cheap in-memory expiry cache so badges do not hit credentials on read. */
  private readonly blobCache = new Map<SubscriptionVendor, SubscriptionBlob>()
  /** Antigravity needs a per-account project id on every generation call. */
  private readonly projectCache = new Map<string, string>()
  /** Last failed browser/device login, exposed to the settings card without secrets. */
  private readonly loginErrors = new Map<SubscriptionVendor, string>()

  constructor(private readonly ctx: Context) {}

  /** Resolve Credentials dynamically so this service stays optional. */
  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials') as CredentialProvider | undefined
    if (credentials === undefined) throw new Error('当前部署未挂载 DSH Credentials，订阅账号不可用')
    return credentials
  }

  /** Read a vendor's stored blob, or undefined when signed out. */
  async readBlob(vendor: SubscriptionVendor): Promise<SubscriptionBlob | undefined> {
    try {
      const resolved = await this.credentials().resolve(subscriptionOauthRef(vendor))
      const raw = resolved?.value ?? ''
      if (raw.trim().length === 0) return undefined
      return parseBlob(raw)
    } catch {
      return undefined
    }
  }

  /** Last login failure for the settings card; never throws. */
  lastLoginError(vendor: SubscriptionVendor): string | undefined {
    return this.loginErrors.get(vendor)
  }

  /** Login status for the settings card; never throws. */
  async loginStatus(vendor: SubscriptionVendor): Promise<SubscriptionLoginStatus> {
    const blob = await this.readBlob(vendor)
    if (blob === undefined) return { state: 'logged-out' }
    return { state: 'logged-in', email: blob.email }
  }

  /**
   * Begin a login: registers PKCE state, starts the loopback catch server on
   * the vendor-fixed redirect port, and returns the authorize URL for the
   * browser to open. Completion lands in the loopback callback.
   */
  async beginLogin(vendor: SubscriptionVendor): Promise<{ url: string; code?: string; expiresInSeconds?: number }> {
    if (vendor === 'grok') {
      const device = await grokBeginDeviceLogin()
      this.loginErrors.delete('grok')
      void grokPollDeviceLogin(device)
        .then(async blob => { await this.saveBlob('grok', blob); this.loginErrors.delete('grok') })
        .catch(error => { this.loginErrors.set('grok', error instanceof Error ? error.message : String(error)) })
      return { url: device.verificationUri, code: device.userCode, expiresInSeconds: device.expiresInSeconds }
    }
    const redirectUri = vendor === 'codex' ? CODEX_REDIRECT_URI
      : vendor === 'antigravity' ? ANTIGRAVITY_REDIRECT_URI
      : vendor === 'openrouter' ? OPENROUTER_REDIRECT_URI
      : GROK_REDIRECT_URI
    const pkce = await createPkce()
    this.pending.set(pkce.state, { vendor, pkce })
    const url = vendor === 'codex' ? codexAuthorizeUrl(codexConfig(), pkce)
      : vendor === 'antigravity' ? antigravityAuthorizeUrl(antigravityConfig(), pkce)
      : vendor === 'openrouter' ? openRouterAuthorizeUrl(pkce)
      : grokAuthorizeUrl(grokConfig(), pkce)
    // The catch server must be listening before the browser opens, otherwise
    // the redirect to localhost:<port> hits a dead port and the login hangs.
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const ready = (): void => { if (!settled) { settled = true; resolve() } }
      const failed = (error: Error): void => { if (!settled) { settled = true; reject(error) } }
      void startLoopback({
        redirectUri,
        onReady: ready,
        onError: failed,
        onCode: async params => {
          try {
            const html = await this.completeLoginFromCallback(vendor, params.get('code') ?? '', params.get('state') ?? '')
            this.loginErrors.delete(vendor)
            return html
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.loginErrors.set(vendor, message)
            throw error
          }
        },
      }).catch(error => { failed(error instanceof Error ? error : new Error(String(error))) })
    })
    this.loginErrors.delete(vendor)
    return { url }
  }

  /** Complete a browser login from a pasted redirect URL/code when loopback cannot be reached. */
  async completeLogin(vendor: SubscriptionVendor, input: string): Promise<void> {
    const raw = input.trim()
    if (raw === '') throw new Error('authorization redirect URL/code is required')
    let code = ''
    let state = ''
    try {
      const url = new URL(raw)
      code = url.searchParams.get('code') ?? ''
      state = url.searchParams.get('state') ?? ''
    } catch {
      code = raw
    }
    if (state === '') {
      const found = [...this.pending.entries()].reverse().find(([, row]) => row.vendor === vendor)
      if (found === undefined) throw new Error('login session expired; start again')
      state = found[0]
    }
    try {
      await this.completeLoginFromCallback(vendor, code, state)
      this.loginErrors.delete(vendor)
    } catch (error) {
      this.loginErrors.set(vendor, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /** Loopback callback: validate state, exchange the code, store the blob. */
  private async completeLoginFromCallback(vendor: SubscriptionVendor, code: string, state: string): Promise<string> {
    if (code.length === 0) throw new Error('callback carried no authorization code')
    const row = this.pending.get(state)
    if (row === undefined || row.vendor !== vendor) throw new Error('login session expired; start again')
    const blob = vendor === 'codex'
      ? await codexExchangeCode(codexConfig(), row.pkce, code)
      : vendor === 'antigravity'
        ? await antigravityExchangeCode(antigravityConfig(), row.pkce, code)
        : vendor === 'openrouter'
          ? await openRouterExchangeCode(row.pkce, code)
          : await grokExchangeCode(grokConfig(), row.pkce, code)
    await this.saveBlob(vendor, blob)
    this.pending.delete(state)
    return `<!doctype html><meta charset="utf-8"><title>dsh-image-gen</title><p>${providerNameOf(vendor)} 登录成功（${escapeHtml(blob.email)}），可以关闭此页返回设置。</p>`
  }

  /** Sign out: clear the blob and the caches. No other setting changes. */
  async logout(vendor: SubscriptionVendor): Promise<void> {
    await this.credentials().unset(subscriptionOauthRef(vendor))
    this.loginErrors.delete(vendor)
    this.blobCache.delete(vendor)
    this.projectCache.clear()
  }

  private async saveBlob(vendor: SubscriptionVendor, blob: SubscriptionBlob): Promise<void> {
    await this.credentials().set(subscriptionOauthRef(vendor), serializeBlob(blob))
    this.blobCache.set(vendor, blob)
  }

  /**
   * Return a blob whose access token is usable; refreshes first when the
   * stored one is expired (or expiring within the skew window). Single-flight
   * per vendor so concurrent generate calls share one refresh.
   */
  async ensureFresh(vendor: SubscriptionVendor): Promise<SubscriptionBlob> {
    const blob = await this.readBlob(vendor)
    if (blob === undefined) throw notLoggedInError(vendor)
    if (blob.refreshToken.length === 0) return blob
    const SKEW_MS = 60_000
    if (blob.expiresAt !== 0 && blob.expiresAt - SKEW_MS > Date.now()) return blob
    const inflight = this.refreshLocks.get(vendor)
    if (inflight !== undefined) return inflight
    const refresh = (async () => {
      const next = vendor === 'codex' ? await codexRefresh(blob)
        : vendor === 'antigravity' ? await antigravityRefresh(blob)
        : vendor === 'openrouter' ? await openRouterRefresh(blob)
        : await grokRefresh(blob)
      const merged: SubscriptionBlob = {
        ...next,
        refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
        accountId: next.accountId.length > 0 ? next.accountId : blob.accountId,
      }
      await this.saveBlob(vendor, merged)
      return merged
    })().finally(() => { this.refreshLocks.delete(vendor) })
    this.refreshLocks.set(vendor, refresh)
    return refresh
  }

  /** Generate one image through the logged-in account. b64 reply decoded host-side. */
  async generate(options: {
    vendor: SubscriptionVendor
    prompt: string
    size?: string
    quality?: string
    referenceImages?: ReadonlyArray<SubscriptionReferenceImage>
    signal?: AbortSignal
  }): Promise<Array<{ b64_json: string; revisedPrompt?: string }>> {
    const { vendor, prompt } = options
    const session = await this.ensureFresh(vendor)
    const text = prompt.trim()
    if (text.length === 0) throw new Error('prompt must be a non-empty string')
    const references = options.referenceImages ?? []
    if (references.length > SUBSCRIPTION_MAX_REFERENCE_IMAGES) {
      throw new Error(`订阅生图最多支持 ${String(SUBSCRIPTION_MAX_REFERENCE_IMAGES)} 张参考图，当前 ${String(references.length)} 张`)
    }

    if (vendor === 'openrouter') {
      const response = await fetch(OPENROUTER_IMAGE_URL, {
        method: 'POST',
        headers: openRouterIdentityHeaders(session),
        body: JSON.stringify({
          model: OPENROUTER_IMAGE_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text },
              ...references.map(image => ({ type: 'image_url', image_url: { url: toDataUrl(image) } })),
            ],
          }],
          modalities: ['image'],
          stream: false,
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const payload: unknown = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = extractErrorMessage(payload)
        throw new Error(`openrouter HTTP ${String(response.status)}${detail === undefined ? '' : `: ${detail.slice(0, 200)}`}`)
      }
      return parseOpenRouterImages(payload)
    }

    // Antigravity speaks the Gemini contents protocol, not OpenAI-style
    // generations; it gets its own wire call and skips the shared shape below.
    if (vendor === 'antigravity') {
      const projectId = await this.ensureAntigravityProject(session)
      const aspectRatio = antigravityAspectRatioOf(options.size)
      const result = await antigravityGenerateImage({
        blob: session,
        projectId,
        prompt: text,
        ...(aspectRatio !== undefined ? { aspectRatio } : {}),
        hd: options.quality === 'hd' || options.quality === 'high',
        ...(references.length > 0 ? { referenceImages: references } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      return [{ b64_json: result.b64 }]
    }

    let url: string
    let headers: Record<string, string>
    let body: Record<string, unknown>
    if (vendor === 'codex') {
      // Codex edits ride a sibling endpoint with the same identity headers;
      // reference images go as data-URL image_url entries (JSON, not multipart).
      url = references.length > 0 ? CODEX_IMAGE_EDIT_URL : CODEX_IMAGE_URL
      headers = codexIdentityHeaders(session)
      body = {
        prompt: text,
        model: CODEX_IMAGE_MODEL,
        ...(references.length > 0 ? { images: references.map(image => ({ image_url: toDataUrl(image) })) } : {}),
        ...(options.size !== undefined && options.size.length > 0 ? { size: options.size } : {}),
        ...(options.quality !== undefined && options.quality.length > 0 ? { quality: options.quality } : {}),
      }
    } else {
      // Grok edits ride the public /v1/images/edits JSON endpoint; reference
      // images go as typed image_url entries (JSON, not multipart).
      url = references.length > 0 ? GROK_IMAGE_EDIT_URL : GROK_IMAGE_URL
      headers = grokIdentityHeaders(session)
      // Grok thinks in aspect ratios, not sizes; and has two quality tiers
      // where high is composed from medium.
      const aspect: Record<string, string> = { '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2', auto: 'auto' }
      const level = options.quality === 'low' ? 'low' : (options.quality === 'medium' || options.quality === 'high') ? 'medium' : undefined
      body = {
        prompt: text,
        model: GROK_IMAGE_MODEL,
        response_format: 'b64_json',
        ...(references.length > 0 ? { images: references.map(image => ({ type: 'image_url', image_url: toDataUrl(image) })) } : {}),
        ...(options.size !== undefined && aspect[options.size] !== undefined ? { aspect_ratio: aspect[options.size] } : {}),
        ...(level !== undefined ? { quality: level } : {}),
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = extractErrorMessage(payload)
      throw new Error(`${vendor} HTTP ${String(response.status)}${detail !== undefined ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    return parseImages(payload)
  }

  /**
   * Resolve (and cache per refresh token) the managed project id the
   * Antigravity generation envelope needs. Re-resolved when the account
   * signs out or a different account logs in.
   */
  private async ensureAntigravityProject(blob: SubscriptionBlob): Promise<string> {
    const cacheKey = blob.refreshToken.length > 0 ? blob.refreshToken : blob.accessToken.slice(0, 32)
    const cached = this.projectCache.get(cacheKey)
    if (cached !== undefined) return cached
    const projectId = await antigravityResolveProject(blob)
    this.projectCache.set(cacheKey, projectId)
    return projectId
  }
}

/** Map an OpenAI-style size onto the aspect ratio Antigravity accepts. */
function antigravityAspectRatioOf(size: string | undefined): string | undefined {
  const table: Record<string, string> = {
    '1024x1024': '1:1',
    '1024x1536': '2:3',
    '1536x1024': '3:2',
    '768x1398': '9:16',
    '1398x768': '16:9',
    auto: '1:1',
  }
  if (size === undefined) return undefined
  const mapped = table[size]
  if (mapped !== undefined) return mapped
  // Already a ratio like 16:9 passes through; anything else falls back to 1:1.
  return /^\d+:\d+$/.test(size) ? size : '1:1'
}

/** Encode one reference image as the data URL the edit endpoints accept. */
function toDataUrl(image: SubscriptionReferenceImage): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

/** Parse OpenRouter's image-capable chat completion response. */
function parseOpenRouterImages(payload: unknown): Array<{ b64_json: string; revisedPrompt?: string }> {
  if (typeof payload !== 'object' || payload === null) throw new Error('response contains no images')
  const choices = Array.isArray((payload as Record<string, unknown>).choices) ? (payload as { choices: unknown[] }).choices : []
  const images: Array<{ b64_json: string; revisedPrompt?: string }> = []
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const message = (choice as { message?: unknown }).message
    if (typeof message !== 'object' || message === null) continue
    const rows = (message as { images?: unknown }).images
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const raw = (row as { image_url?: unknown }).image_url
      const url = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null && typeof (raw as { url?: unknown }).url === 'string' ? (raw as { url: string }).url : ''
      const match = /^data:([^;]+);base64,(.+)$/s.exec(url)
      if (match?.[2] !== undefined) images.push({ b64_json: match[2] })
    }
  }
  if (images.length === 0) throw new Error('response contains no images')
  return images
}

/** Response parsing: both vendors reply in the same `{data:[{b64_json}]}` shape. */
function parseImages(payload: unknown): Array<{ b64_json: string; revisedPrompt?: string }> {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const rows = Array.isArray(body.data) ? body.data : []
  const images: Array<{ b64_json: string; revisedPrompt?: string }> = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const b64 = (row as Record<string, unknown>).b64_json
    if (typeof b64 !== 'string' || b64.length === 0) continue
    const revised = (row as Record<string, unknown>).revised_prompt
    images.push({
      b64_json: b64,
      ...(typeof revised === 'string' && revised.length > 0 ? { revisedPrompt: revised } : {}),
    })
  }
  if (images.length === 0) throw new Error('response contains no images')
  return images
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const error = (payload as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  const row = error as Record<string, unknown>
  if (typeof row.message === 'string') return row.message
  if (typeof row.code === 'string') return row.code
  return undefined
}

function notLoggedInError(vendor: SubscriptionVendor): Error {
  const display = providerNameOf(vendor)
  return new Error(`${display} 未登录：请到「设置 → 生图配置 → 官方订阅」完成登录`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}
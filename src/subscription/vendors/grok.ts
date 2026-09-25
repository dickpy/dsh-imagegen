/**
 * Grok subscription image vendor.
 *
 * Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
 * lib/vendors/grok.js and lib/images.js — only the pieces the image channel
 * needs: authorize URL, code exchange, refresh, and the generations call
 * (grok-cli token, not an xAI API key).
 */
import { buildAuthorizeUrl, emailFromToken, formTokenRequest, type Pkce } from '../oauth.js'
import type { SubscriptionBlob } from '../blob.js'

const GROK_AUTH = 'https://auth.x.ai/oauth2/authorize'
const GROK_TOKEN = 'https://auth.x.ai/oauth2/token'
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write'

/** Where the Grok subscription image request goes. */
export const GROK_IMAGE_URL = 'https://api.x.ai/v1/images/generations'
/** Where the Grok subscription image edit request goes. */
export const GROK_IMAGE_EDIT_URL = 'https://api.x.ai/v1/images/edits'
/** The model served by this endpoint. */
export const GROK_IMAGE_MODEL = 'grok-imagine-image-2.0'

/** Public client id of the grok-cli; vendor-fixed redirect on 127.0.0.1:56121. */
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_REDIRECT_URI = 'http://127.0.0.1:56121/callback'

export function grokConfig(): { clientId: string; redirectUri: string } {
  return { clientId: GROK_CLIENT_ID, redirectUri: GROK_REDIRECT_URI }
}

export function grokAuthorizeUrl(cfg: { clientId: string; redirectUri: string }, pkce: Pkce): string {
  return buildAuthorizeUrl({
    authUrl: GROK_AUTH,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    challenge: pkce.challenge,
    state: pkce.state,
    scope: GROK_SCOPE,
  })
}

/** Identity fields every grok.com call must carry (the API host ignores them). */
export function grokIdentityHeaders(blob: SubscriptionBlob): Record<string, string> {
  return {
    authorization: `Bearer ${blob.accessToken}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-client-version': '0.2.103',
    'User-Agent': 'xai-grok-cli',
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

const GROK_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code'
const GROK_DEVICE_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

export interface GrokDeviceLogin {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

async function grokForm(url: string, fields: Record<string, string>, signal?: AbortSignal, allowDevicePollingStatus = false): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const error = typeof body.error === 'string' ? body.error : ''
    const description = typeof body.error_description === 'string' ? body.error_description : ''
    // RFC 8628 polling errors are expected control messages, not fatal errors.
    if (allowDevicePollingStatus && (error === 'authorization_pending' || error === 'slow_down')) return body
    throw new Error(`xAI OAuth HTTP ${response.status}${error || description ? `: ${[error, description].filter(Boolean).join(': ')}` : ''}`)
  }
  return body
}

export async function grokBeginDeviceLogin(signal?: AbortSignal): Promise<GrokDeviceLogin> {
  const body = await grokForm(GROK_DEVICE_CODE_URL, { client_id: GROK_CLIENT_ID, scope: GROK_DEVICE_SCOPE, referrer: 'pi' }, signal)
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
  const userCode = typeof body.user_code === 'string' ? body.user_code : ''
  const verificationUri = typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : typeof body.verification_uri === 'string' ? body.verification_uri : ''
  if (deviceCode === '' || userCode === '' || verificationUri === '') throw new Error('xAI device authorization response is incomplete')
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
    expiresInSeconds: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900,
  }
}

export async function grokPollDeviceLogin(device: GrokDeviceLogin, signal?: AbortSignal): Promise<SubscriptionBlob> {
  const deadline = Date.now() + device.expiresInSeconds * 1000
  let interval = Math.max(1, device.intervalSeconds) * 1000
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Login cancelled')) }, { once: true })
    })
    const body = await grokForm(GROK_TOKEN, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: GROK_CLIENT_ID,
      device_code: device.deviceCode,
    }, signal, true)
    if (typeof body.access_token === 'string' && body.access_token !== '') {
      return { ...tokenBlobFromOAuth(body), label: 'Grok' }
    }
    if (body.error === 'slow_down' && typeof body.interval === 'number') interval = Math.max(1, body.interval) * 1000
    else if (body.error !== 'authorization_pending') throw new Error(typeof body.error_description === 'string' ? body.error_description : `xAI device login failed: ${String(body.error ?? 'unknown error')}`)
  }
  throw new Error('xAI device code expired')
}

function tokenBlobFromOAuth(json: Record<string, unknown>): SubscriptionBlob {
  const access = json.access_token
  const refresh = json.refresh_token
  return {
    accessToken: typeof access === 'string' ? access : '',
    refreshToken: typeof refresh === 'string' ? refresh : '',
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    label: '',
    email: '',
    accountId: '',
  }
}

export async function grokExchangeCode(cfg: { clientId: string; redirectUri: string }, pkce: Pkce, code: string): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(GROK_TOKEN, {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: pkce.verifier,
  }, fetch)
  const blob = tokenBlobFromOAuth(json)
  return { ...blob, email: blob.email.length > 0 ? blob.email : emailFromToken(blob.accessToken), label: 'Grok' }
}

export async function grokRefresh(blob: SubscriptionBlob): Promise<SubscriptionBlob> {
  const json = await formTokenRequest(GROK_TOKEN, {
    grant_type: 'refresh_token',
    client_id: GROK_CLIENT_ID,
    refresh_token: blob.refreshToken,
  }, fetch)
  const next = tokenBlobFromOAuth(json)
  return {
    ...next,
    refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
    label: blob.label.length > 0 ? blob.label : 'Grok',
    email: blob.email.length > 0 ? blob.email : next.email,
  }
}
/**
 * Object-storage sync for saved images: one S3-compatible uploader (SigV4,
 * zero dependencies) that covers Tencent COS / Alibaba OSS / Qiniu S3 /
 * MinIO / R2 style endpoints, plus a fire-and-forget hook the image stores
 * call after a file lands on disk. The handler is registered by the plugin
 * root (it owns the live settings), so framework-free stores stay decoupled
 * from the settings seam.
 *
 * Object keys: `${prefix}/gallery/<file>` and `${prefix}/images/<file>` —
 * content-addressed file names dedupe re-uploads naturally.
 */

import { createHash, createHmac } from 'node:crypto'

/** The storage section of the plugin settings document. */
export interface StorageSyncConfig {
  endpoint: string
  region: string
  accessKey: string
  secretKey: string
  prefix: string
}

/** Registered by index.ts: uploads `filePath` when the settings allow it. */
export type StorageUploadHandler = (kind: 'gallery' | 'history', filePath: string) => void

let uploadHandler: StorageUploadHandler | undefined

/** Register the live uploader (index.ts apply). Pass undefined to clear. */
export function setStorageSyncHandler(handler: StorageUploadHandler | undefined): void {
  uploadHandler = handler
}

/** Fire-and-forget notification from the image stores after a file write. */
export function notifyImageSaved(kind: 'gallery' | 'history', filePath: string): void {
  try {
    uploadHandler?.(kind, filePath)
  } catch {
    // A sync failure must never break the save path.
  }
}

/** URL-encode per RFC 3986 (AWS SigV4 canonical forms). */
function uriEncode(value: string, encodeSlash = true): string {
  return value.replace(/[^A-Za-z0-9-_.~]/g, char => {
    const hex = char.charCodeAt(0).toString(16).toUpperCase()
    return `%${hex.padStart(2, '0')}`
  }).replace(/%2F/g, encodeSlash ? '%2F' : '/')
}

/** HMAC-SHA256 helper. */
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * PUT one object to an S3-compatible endpoint (SigV4, virtual-hosted or
 * path-style — the endpoint URL already includes the bucket). Returns the
 * elapsed milliseconds so the settings card can show a latency reading.
 */
export async function putObject(config: StorageSyncConfig, key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<{ ms: number }> {
  const endpoint = config.endpoint.trim().replace(/\/+$/, '')
  if (endpoint === '' || config.accessKey.trim() === '' || config.secretKey.trim() === '') {
    throw new Error('对象存储配置不完整：请填写接口地址与密钥')
  }
  const url = new URL(`${endpoint}/${key.split('/').map(part => uriEncode(part)).join('/')}`)
  const payloadHash = createHash('sha256').update(data).digest('hex')
  const now = new Date()
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}` // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8)
  const host = url.host
  const canonicalUri = url.pathname
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${dateStamp}/${config.region.trim() || 'us-east-1'}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')}`
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey.trim()}`, dateStamp), config.region.trim() || 'us-east-1'), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey.trim()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const started = Date.now()
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    },
    body: new Uint8Array(data),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`对象存储拒绝上传（HTTP ${response.status}）${text !== '' ? `：${text.slice(0, 200)}` : ''}`)
  }
  return { ms: Date.now() - started }
}

/** Upload a small probe object; used by the settings card's test button. */
export async function testStorage(config: StorageSyncConfig): Promise<{ ms: number; key: string }> {
  const key = `${config.prefix.trim() || 'dsh-imagegen'}/ping.txt`
  const { ms } = await putObject(config, key, Buffer.from('dsh-imagegen storage ok', 'utf8'), 'text/plain')
  return { ms, key }
}

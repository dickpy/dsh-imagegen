/**
 * Does the configured chat endpoint actually accept image parts?
 *
 * The local deck pipeline sends `image_url` data URIs, so a gateway that lists
 * a model but rejects image content is a hard prerequisite failure - and it must
 * be discovered by one 1x1-pixel probe instead of a five-minute conversion.
 *
 * Usage: node scripts/ppt-chat-vision-probe.mjs [model]
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const profilePatch = process.env.DSH_PROFILE_PATCH
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const text = fs.readFileSync(profilePatch, 'utf8')
const start = text.indexOf('\n- id: imagegen\n')
const block = text.slice(start, text.indexOf('\n- id: ', start + 1) < 0 ? text.length : text.indexOf('\n- id: ', start + 1))
const channels = []
const secrets = new Map()
let mode = null
let current = null
for (const raw of block.split(/\r?\n/)) {
  if (/^\s+channels:\s*$/.test(raw)) { mode = 'channels'; continue }
  if (/^\s+channelSecrets:\s*$/.test(raw)) { mode = 'secrets'; continue }
  if (/^\s{2,}(defaultModel|skillConfig|promptModel|promptApiUrl|config):\s*/.test(raw)) { mode = null; continue }
  const entry = raw.match(/^\s*- id: (\S+)\s*$/)
  if (mode === 'channels' && entry) { current = { id: entry[1], apiUrl: '', auth: 'api-key' }; channels.push(current); continue }
  if (mode === 'channels' && current) {
    const url = raw.match(/^\s+apiUrl:\s*(\S*)\s*$/)
    if (url) current.apiUrl = url[1].replace(/^"|"$/g, '')
    const auth = raw.match(/^\s+auth:\s*(\S+)\s*$/)
    if (auth) current.auth = auth[1]
  }
  if (mode === 'secrets') {
    const secret = raw.match(/^\s+([0-9a-f-]{36}):\s*(\S+)\s*$/)
    if (secret) secrets.set(secret[1], secret[2])
  }
}
const usable = channels.filter(channel => channel.apiUrl !== '' && channel.auth !== 'subscription' && secrets.get(channel.id))
const model = process.argv[2] ?? 'gpt-6.1-sol'
// A real slide image, not a synthetic dot: layout understanding is the point.
const image = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'output', 'feasibility-ppt-20261030', 'live-run', 'slide-2.png'))
console.log(`probe image ${image.length} bytes sha ${createHash('sha256').update(image).digest('hex').slice(0, 12)}`)

for (const channel of usable) {
  const key = secrets.get(channel.id)
  const endpoint = `${channel.apiUrl.replace(/\/$/, '')}/chat/completions`
  const body = {
    model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张幻灯片的主标题是什么？只回答标题文字。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
      ],
    }],
  }
  let verdict
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    if (response.ok) {
      const answer = JSON.parse(raw)?.choices?.[0]?.message?.content ?? ''
      verdict = `VISION OK (${JSON.stringify(String(answer).slice(0, 80))})`
    } else {
      verdict = `HTTP ${response.status}: ${raw.replace(/\s+/g, ' ').slice(0, 180)}`
    }
  } catch (error) {
    verdict = `transport error: ${error instanceof Error ? error.message : String(error)}`
  }
  // Never print the key: only the host and the verdict.
  console.log(`${new URL(channel.apiUrl).host} · ${model} → ${verdict}`)
}

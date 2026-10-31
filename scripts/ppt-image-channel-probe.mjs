/**
 * Which configured channel can actually serve image generation today?
 *
 * The deck pipeline's clean-base step shells out to `editppt image edit`, which
 * reads `~/.editppt/config.yaml` (Codex OAuth first, then an OpenAI-compatible
 * fallback). That file was pointed at a row whose gateway has no image channel,
 * so artwork-heavy pages silently degraded to text. This probe answers, without
 * touching any config: try each channel's own /models + one tiny image edit.
 *
 * Keys are read from the installed profile in-process and never printed.
 */
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const profile = process.env.DSH_PROFILE_PATCH
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const text = fs.readFileSync(profile, 'utf8')
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
  if (mode === 'channels' && entry) { current = { id: entry[1], name: '', apiUrl: '', auth: 'api-key', models: [] }; channels.push(current); continue }
  if (mode === 'channels' && current) {
    const url = raw.match(/^\s+apiUrl:\s*(\S*)\s*$/)
    if (url) current.apiUrl = url[1].replace(/^"|"$/g, '')
    const name = raw.match(/^\s+name:\s*(.+?)\s*$/)
    if (name) current.name = name[1].replace(/^"|"$/g, '')
    const auth = raw.match(/^\s+auth:\s*(\S+)\s*$/)
    if (auth) current.auth = auth[1]
    const model = raw.match(/^\s+- id: (\S+)\s*$/)
    if (model) current.models.push(model[1])
  }
  if (mode === 'secrets') {
    const secret = raw.match(/^\s+(\S+):\s*(\S+)\s*$/)
    if (secret) secrets.set(secret[1], secret[2])
  }
}

const source = path.resolve(import.meta.dirname, '..', 'output', 'postmortem', 'real-slide-1.png')
const png = fs.readFileSync(source)
const dataUrl = `data:image/png;base64,${png.toString('base64')}`
console.log(`codex oauth file present: ${fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'))}`)

for (const channel of channels) {
  const key = secrets.get(channel.id) ?? ''
  if (channel.apiUrl === '' || key === '') { console.log(`${channel.name || channel.id}: skipped (no url or key)`); continue }
  const base = channel.apiUrl.replace(/\/$/, '')
  // The prompt asks for a text-free version of the page - the deck's clean base.
  const body = {
    model: channel.models.find(model => /image/i.test(model)) ?? channel.models[0],
    prompt: 'Remove all text, letters and numbers from this slide. Keep background, illustrations, shapes and colors unchanged. No new elements.',
    image: [dataUrl],
    size: '1024x1024',
  }
  let verdict
  try {
    const response = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = await response.text()
    if (response.ok) {
      const json = JSON.parse(payload)
      const item = json?.data?.[0]
      const bytes = item?.b64_json ? Buffer.from(item.b64_json, 'base64').length : (item?.url ? `url ${item.url.slice(0, 40)}…` : 'empty')
      verdict = `OK model=${body.model} bytes=${bytes}`
    } else {
      verdict = `HTTP ${response.status} ${payload.replace(/\s+/g, ' ').slice(0, 160)}`
    }
  } catch (error) {
    verdict = `error ${error instanceof Error ? error.message : String(error)}`
  }
  console.log(`${new URL(base).host} · ${body.model} → ${verdict}`)
}

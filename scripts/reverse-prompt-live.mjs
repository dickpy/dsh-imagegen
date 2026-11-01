/**
 * Live check of the prompt reverse-engineer, through the real host seam.
 *
 * Instantiates the real `SkillRunner` with the profile's chat channel and a stub
 * asset store, then prints the prompt it writes for one or more local images.
 * The only fakes are the canvas and the settings.
 *
 * Usage: node scripts/reverse-prompt-live.mjs <image> [more images...]
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import url from 'node:url'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const profile = process.env.DSH_PROFILE_PATCH
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const inputs = process.argv.slice(2).map(file => path.resolve(file))
if (inputs.length === 0) throw new Error('usage: node scripts/reverse-prompt-live.mjs <image> [...]')
for (const file of inputs) if (!fs.existsSync(file)) throw new Error(`missing image: ${file}`)

/** Read the plugin's channel list + secrets out of the installed profile. */
function readChannels(file) {
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf('\n- id: imagegen\n')
  if (start < 0) throw new Error('no imagegen entry in the profile patch')
  const next = text.indexOf('\n- id: ', start + 1)
  const block = text.slice(start, next < 0 ? text.length : next)
  const channels = []
  const secrets = new Map()
  let mode = null
  let current = null
  for (const raw of block.split(/\r?\n/)) {
    if (/^\s+channels:\s*$/.test(raw)) { mode = 'channels'; continue }
    if (/^\s+channelSecrets:\s*$/.test(raw)) { mode = 'secrets'; continue }
    if (/^\s{2,}(defaultModel|skillConfig|skillConfigSecrets|promptModel|promptApiUrl|config):\s*/.test(raw)) { mode = null; continue }
    const entry = raw.match(/^\s*- id: (\S+)\s*$/)
    if (mode === 'channels' && entry) { current = { id: entry[1], apiUrl: '', auth: 'api-key' }; channels.push(current); continue }
    if (mode === 'channels' && current) {
      const apiUrl = raw.match(/^\s+apiUrl:\s*(\S*)\s*$/)
      if (apiUrl) current.apiUrl = apiUrl[1].replace(/^"|"$/g, '')
      const auth = raw.match(/^\s+auth:\s*(\S+)\s*$/)
      if (auth) current.auth = auth[1]
    }
    if (mode === 'secrets') {
      const secret = raw.match(/^\s+([0-9a-f-]{36}):\s*(\S+)\s*$/)
      if (secret) secrets.set(secret[1], secret[2])
    }
  }
  return { channels, secrets }
}

const { channels, secrets } = readChannels(profile)
const reusable = channels.find(channel => channel.apiUrl !== '' && channel.auth !== 'subscription' && secrets.get(channel.id))
if (reusable === undefined) throw new Error('no reusable OpenAI-compatible channel in the profile')
const apiKey = secrets.get(reusable.id)
const model = process.env.REVERSE_CHAT_MODEL ?? 'gpt-6.1-sol'
console.log(`chat: ${reusable.apiUrl} · ${model} · key ${apiKey === undefined ? 'MISSING' : `(${apiKey.length} chars)`}`)

async function complete({ system, content, temperature = 0.35, maxTokens = 2000, signal }) {
  const response = await fetch(`${reusable.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
  })
  if (!response.ok) throw new Error(`chat ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const body = await response.json()
  const text = body?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text === '') throw new Error('chat returned no content')
  return text
}

const store = new Map()
const refs = inputs.map(file => {
  const data = fs.readFileSync(file)
  const assetId = `${createHash('sha256').update(data).digest('hex').slice(0, 24)}.png`
  store.set(assetId, { data, mime: 'image/png' })
  return { assetId, url: `/asset/${assetId}`, mime: 'image/png', width: 0, height: 0, bytes: data.length, origin: 'upload', kind: 'image', name: path.basename(file) }
})

const host = await import(url.pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const tables = await import(url.pathToFileURL(path.join(root, 'lib', 'locale-tables.js')).href)
host.setSkillTranslate((key, params, language) => tables.interpolate(key, params, tables.imageGenLanguageOf(language)))

const runner = new host.SkillRunner({
  backend: {
    canvas: {
      read: async () => undefined,
      readAsset: async id => store.get(id),
      readAssets: async refsIn => new Map(refsIn.map(ref => [ref.assetId, store.get(ref.assetId)])),
      materialize: async () => {},
      putFile: async () => { throw new Error('not used') },
    },
    chat: { complete },
  },
  enabled: () => true,
  heavyEnabled: () => false,
  allowlist: () => [],
  runRoot: () => path.join(root, 'output'),
  heavyTimeoutMs: () => 0,
  dataRoot: () => path.join(root, 'output'),
})

const detail = (process.env.REVERSE_DETAIL ?? 'standard')
const output = (process.env.REVERSE_OUTPUT ?? 'follow')
const started = Date.now()
const result = await runner.reversePrompt({
  images: refs,
  detail,
  output,
  ...(process.env.REVERSE_EXTRA === undefined ? {} : { instruction: process.env.REVERSE_EXTRA }),
  language: 'zh',
})
console.log(`\n--- prompt (${detail}/${output}, ${Math.round((Date.now() - started) / 1000)}s, ${result.prompt.length} chars) ---\n`)
console.log(result.prompt)

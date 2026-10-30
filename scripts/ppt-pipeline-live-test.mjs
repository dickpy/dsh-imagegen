/**
 * Live end-to-end check of the local deck pipeline through the real seams.
 *
 * Unlike `ppt-pipeline-selftest.mjs` (stub model) this drives the *published*
 * bundle the way the host does: a real `SkillRunner` in `local` deck mode, the
 * real `editppt` CLI, and one real multimodal call per page. It exists because
 * the shipping path cannot be exercised from inside this checkout without a
 * host restart - here the only fakes are the canvas store and the settings.
 *
 * Usage: node scripts/ppt-pipeline-live-test.mjs [imageA imageB ...]
 * Secrets are read from the installed profile for the duration of the process
 * and never printed, logged, or written anywhere.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const outBase = path.join(root, 'output', 'feasibility-ppt-20261030', 'live-run')
const profilePatch = process.env.DSH_PROFILE_PATCH
  ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const editppt = process.env.EDITPPT_CLI
  ?? path.join(os.homedir(), '.dsh', 'dsh-imagegen', 'ppt-runtime', 'Scripts', 'editppt.exe')
const skillRoot = process.env.PPT_SKILL_ROOT
  ?? path.join(os.homedir(), '.dsh', 'skills', 'image-to-editable-ppt')

const inputs = (process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      path.join(root, 'output', 'feasibility-ppt-20261030', 'probe-clip', 'a.png'),
      path.join(root, 'output', 'feasibility-ppt-20261030', 'probe-clip', 'b.png'),
    ]).map(file => path.resolve(file))
for (const file of inputs) if (!fsSync.existsSync(file)) throw new Error(`missing input image: ${file}`)
for (const [name, file] of [['profile patch', profilePatch], ['editppt CLI', editppt], ['skill bundle', path.join(skillRoot, 'SKILL.md')]]) {
  if (!fsSync.existsSync(file)) throw new Error(`missing ${name}: ${file}`)
}

await fs.mkdir(outBase, { recursive: true })

// ------------------------------------------------------ chat endpoint (read)

/** Pull the plugin's own channel list + secrets out of the installed profile. */
function readChannels(file) {
  const text = fsSync.readFileSync(file, 'utf8')
  const start = text.indexOf('\n- id: imagegen\n')
  if (start < 0) throw new Error('no imagegen bundle entry in the profile patch')
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
  return { channels, secrets }
}

const { channels, secrets } = readChannels(profilePatch)
// Mirror `resolvePromptModelConfig`: with no explicit prompt endpoint, reuse the
// first real API-key channel (never a subscription row).
const reusable = channels.find(channel => channel.apiUrl !== '' && channel.auth !== 'subscription')
if (reusable === undefined) throw new Error('no reusable OpenAI-compatible channel in the profile')
const apiKey = secrets.get(reusable.id) ?? ''
const model = process.env.PPT_CHAT_MODEL ?? 'gpt-6.1-sol'
console.log(`chat: ${reusable.apiUrl} · model ${model} · key ${apiKey === '' ? 'MISSING' : `(${apiKey.length} chars)`}`)
if (apiKey === '') throw new Error('the reusable channel has no stored secret')

/** One OpenAI-compatible completion, text or multimodal parts. */
async function complete({ system, content, temperature = 0.2, maxTokens = 6000, signal }) {
  const response = await fetch(`${reusable.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
  })
  if (!response.ok) throw new Error(`chat ${response.status}: ${(await response.text()).slice(0, 400)}`)
  const body = await response.json()
  const text = body?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text === '') throw new Error('chat returned no content')
  return text
}

// ----------------------------------------------------------- canvas fake (I/O)

const assetStore = new Map()
const published = path.join(outBase, 'assets')
await fs.mkdir(published, { recursive: true })

/** Register one local file as a canvas asset reference. */
function addAsset(file) {
  const data = fsSync.readFileSync(file)
  const assetId = `${createHash('sha256').update(data).digest('hex').slice(0, 24)}.png`
  assetStore.set(assetId, { data, mime: 'image/png' })
  return {
    assetId,
    url: `/api/dsh-imagegen/canvas/asset/${assetId}`,
    mime: 'image/png',
    width: 0,
    height: 0,
    bytes: data.length,
    origin: 'upload',
    kind: 'image',
    name: path.basename(file),
  }
}

const canvas = {
  read: async () => undefined,
  readAsset: async id => assetStore.get(id),
  readAssets: async refs => new Map(refs.map(ref => [ref.assetId, assetStore.get(ref.assetId)])),
  materialize: async (ref, target) => {
    const found = assetStore.get(ref.assetId)
    if (found === undefined) throw new Error(`unknown asset ${ref.assetId}`)
    await fs.writeFile(target, found.data)
  },
  putFile: async ({ data, mime, name }) => {
    const safe = name.replace(/[\\/:*?"<>|]/g, '_')
    await fs.writeFile(path.join(published, safe), data)
    const assetId = `${createHash('sha256').update(data).digest('hex').slice(0, 24)}-${safe}`
    return { assetId, url: `/asset/${assetId}`, mime, width: 0, height: 0, bytes: data.length, origin: 'generated', kind: 'file', name: safe }
  },
}

const registry = {
  list: async () => [{ name: 'image-to-editable-ppt', description: 'deck pipeline', path: path.join(skillRoot, 'SKILL.md') }],
  get: async name => name === 'image-to-editable-ppt'
    ? { name, content: await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8') }
    : undefined,
}

// ------------------------------------------------------------------- run it

const host = await import(url.pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const tables = await import(url.pathToFileURL(path.join(root, 'lib', 'locale-tables.js')).href)
host.setSkillTranslate((key, params, language) => tables.interpolate(key, params, tables.imageGenLanguageOf(language)))

const runner = new host.SkillRunner({
  backend: { canvas, chat: { complete }, registry },
  enabled: () => true,
  heavyEnabled: () => true,
  allowlist: () => [],
  runRoot: () => path.join(outBase, 'runs'),
  heavyTimeoutMs: () => 0,
  dataRoot: () => outBase,
  pptCommand: async () => editppt,
  deckMode: () => 'local',
  deckLimits: () => ({ concurrency: Number(process.env.PPT_CONCURRENCY ?? 2), pageBudgetMs: 300_000 }),
  deckChatReady: () => true,
  pptSkillDoc: async relative => {
    try { return await fs.readFile(path.join(skillRoot, relative), 'utf8') } catch { return undefined }
  },
})

const catalog = await runner.list('zh')
console.log(`deck gate: ${JSON.stringify(catalog.deckExecution)}`)
if (catalog.deckExecution?.ready !== true) throw new Error('the local pipeline reports itself not ready')

const started = Date.now()
// The PPT workspace defaults to offline text detection, so that branch is the
// one a first click actually takes: exercise it here unless told otherwise.
const offlineOcr = process.env.PPT_OFFLINE_OCR !== '0'
const task = await runner.runPpt({ images: inputs.map(addAsset), offlineOcr, language: 'zh' })
const deadline = started + Number(process.env.PPT_LIVE_TIMEOUT_MS ?? 900_000)
let current = task
for (;;) {
  current = runner.task(task.id) ?? current
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`[${elapsed}s] ${current.status} · ${current.stage ?? ''} · ${current.progress?.currentOperation ?? ''}`)
  if (current.status !== 'running' && current.status !== 'queued') break
  if (Date.now() > deadline) throw new Error('live test deadline exceeded')
  await new Promise(resolve => setTimeout(resolve, 5000))
}

for (const event of (current.progress?.events ?? []).slice(-14)) console.log(`  · ${event.state.padEnd(7)} ${event.label}`)
if (current.status !== 'completed') {
  console.error(`FAILED: ${current.error ?? 'no error recorded'}`)
  console.error(`run directory kept at ${current.runDirectory}`)
  process.exit(1)
}

const deckNode = (current.output?.nodes ?? []).find(node => node.metadata?.asset?.name?.toLowerCase().endsWith('.pptx'))
if (deckNode === undefined) throw new Error('completed run produced no .pptx node')
const deckFile = path.join(published, deckNode.metadata.asset.name)
const { inspectDeck, acceptDeck } = host
const inspection = inspectDeck(fsSync.readFileSync(deckFile))
console.log('deck:', deckNode.metadata.asset.name, fsSync.statSync(deckFile).size, 'bytes')
console.log('inspection:', JSON.stringify({ ...inspection, pages: inspection?.pages }))
const decision = acceptDeck({ inspection, expectedSlides: inputs.length, reportPassed: true })
console.log('acceptance:', JSON.stringify(decision))

// Copy the finished deck where a human can open it.
const finalCopy = path.join(outBase, 'live-deck.pptx')
await fs.copyFile(deckFile, finalCopy)
console.log(`copied to ${finalCopy} in ${Math.round((Date.now() - started) / 1000)}s`)
if (!decision.ok) { console.error('LIVE TEST REJECTED: ' + decision.reason); process.exit(2) }
console.log('LIVE TEST OK')

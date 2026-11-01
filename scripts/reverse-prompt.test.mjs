/**
 * Unit tests for prompt reverse-engineering (`SkillRunner.reversePrompt`).
 *
 * The model is stubbed, so this locks the contract that matters: the detail and
 * output parameters must reach the system prompt, the answer must be trimmed and
 * de-fenced, and a broken answer must fail instead of returning junk.
 *
 * Run: node scripts/reverse-prompt.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import url from 'node:url'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const host = await import(url.pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const tables = await import(url.pathToFileURL(path.join(root, 'lib', 'locale-tables.js')).href)
host.setSkillTranslate((key, params, language) => tables.interpolate(key, params, tables.imageGenLanguageOf(language)))

/** One fake PNG asset; the reverse path only checks the mime prefix. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

/** Build a runner whose chat records every call and answers with `reply`. */
function makeRunner(reply, options = {}) {
  const calls = []
  const store = new Map([['a.png', { data: PNG, mime: 'image/png' }], ['b.png', { data: PNG, mime: 'image/jpeg' }]])
  const runner = new host.SkillRunner({
    backend: {
      canvas: {
        read: async () => undefined,
        readAsset: async id => store.get(id),
        readAssets: async refs => new Map(refs.map(ref => [ref.assetId, store.get(ref.assetId)])),
        materialize: async () => {},
        putFile: async () => { throw new Error('not used') },
      },
      chat: {
        complete: async request => {
          calls.push(request)
          if (reply instanceof Error) throw reply
          return reply
        },
      },
    },
    enabled: () => true,
    heavyEnabled: () => false,
    allowlist: () => [],
    runRoot: () => path.join(root, 'output'),
    heavyTimeoutMs: () => 0,
    dataRoot: () => path.join(root, 'output'),
    ...options,
  })
  return { runner, calls }
}

const ref = (assetId, mime = 'image/png') => ({ assetId, url: `/asset/${assetId}`, mime, width: 0, height: 0, bytes: PNG.length, origin: 'upload', kind: 'image', name: assetId })

test('a) standard/中文：提示词被 trim、去围栏，参数进入 system', async () => {
  const { runner, calls } = makeRunner('```\n85mm 定焦，浅景深，浅金色晨光。\n```')
  const result = await runner.reversePrompt({ images: [ref('a.png')], detail: 'standard', output: 'zh', language: 'zh' })
  assert.equal(result.prompt, '85mm 定焦，浅景深，浅金色晨光。')
  assert.equal(calls.length, 1)
  const system = calls[0].system
  assert.match(system, /图像逆向提示词工程师/)
  assert.match(system, /约 120 词/, 'standard detail hint must be in the system prompt')
  assert.doesNotMatch(system, /60 词以内/, 'brief hint must not leak into standard')
  // The images ride the same user message, after the instruction text.
  const parts = calls[0].content
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/)
})

test('b) brief + en：英文规则与短长度提示', async () => {
  const { runner, calls } = makeRunner('a cat, 85mm, soft window light')
  const result = await runner.reversePrompt({ images: [ref('a.png')], detail: 'brief', output: 'en', language: 'zh' })
  assert.equal(result.prompt, 'a cat, 85mm, soft window light')
  const system = calls[0].system
  assert.match(system, /prompt reverse-engineer/)
  assert.match(system, /under 60 words/)
})

test('c) 多图 + 额外要求：都进入同一请求，并声明是多图', async () => {
  const { runner, calls } = makeRunner('combined prompt')
  await runner.reversePrompt({
    images: [ref('a.png'), ref('b.png', 'image/jpeg')],
    detail: 'detailed',
    output: 'follow',
    instruction: 'keep the palette',
    language: 'en',
  })
  const parts = calls[0].content
  assert.equal(parts.filter(part => part.type === 'image_url').length, 2)
  assert.ok(parts.some(part => part.type === 'text' && /keep the palette/.test(part.text)))
  assert.match(calls[0].system, /one combined prompt/)
  assert.match(parts[0].text, /2 reference image/)
})

test('d) 空回答 / 模型报错 / 图太多：明确失败', async () => {
  const empty = makeRunner('   ')
  await assert.rejects(empty.runner.reversePrompt({ images: [ref('a.png')], language: 'zh' }), /没有返回提示词/)
  const broken = makeRunner(new Error('chat 401: bad key'))
  await assert.rejects(broken.runner.reversePrompt({ images: [ref('a.png')], language: 'zh' }), /401/)
  const many = makeRunner('x')
  await assert.rejects(many.runner.reversePrompt({ images: Array.from({ length: 7 }, () => ref('a.png')), language: 'zh' }), /超过|6 张|too many/i)
})

test('e) 未知资产不是图片：拒绝，不把空图发给模型', async () => {
  const { runner, calls } = makeRunner('x')
  await assert.rejects(runner.reversePrompt({ images: [ref('missing.png')], language: 'zh' }), /图片|image/i)
  assert.equal(calls.length, 0)
})

test('f) 没有配置可读图的聊天模型：先提示去配置，不发请求', async () => {
  const { runner, calls } = makeRunner('x', { chatReady: () => false })
  await assert.rejects(runner.reversePrompt({ images: [ref('a.png')], language: 'zh' }), /提示词增强/)
  assert.equal(calls.length, 0)
})

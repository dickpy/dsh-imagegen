import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareChoice,
  compareKey,
  defaultGenerationSettings,
  GENERATION_SETTINGS_STORAGE_KEY,
  normalizeCount,
  normalizeDetail,
  normalizeQuality,
  normalizeSize,
  readGenerationSettings,
  writeGenerationSettings,
} from '../src/client/generation-settings.ts'

/** Minimal Web Storage stand-in; `throwOn` simulates blocked storage. */
function memoryStorage(initial = {}, throwOn = '') {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(key) {
      if (throwOn === 'get') throw new Error('storage unavailable')
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      if (throwOn === 'set') throw new Error('quota exceeded')
      map.set(key, value)
    },
  }
}

test('#68 defaults are used when nothing was stored', () => {
  assert.deepEqual(readGenerationSettings(memoryStorage()), defaultGenerationSettings())
  assert.deepEqual(readGenerationSettings(null), defaultGenerationSettings())
  assert.deepEqual(readGenerationSettings(undefined), defaultGenerationSettings())
  assert.deepEqual(defaultGenerationSettings(), {
    size: 'auto',
    quality: 'auto',
    count: 1,
    detail: '',
    model: '',
    channelId: '',
    compareEnabled: false,
    compareModels: [],
  })
})

test('#68 a written selection reads back unchanged', () => {
  const storage = memoryStorage()
  const settings = {
    size: '16:9',
    quality: '4k',
    count: 3,
    detail: 'high',
    model: 'gpt-image-2.6-flare',
    channelId: 'packapi',
    compareEnabled: true,
    compareModels: [compareKey('packapi', 'gpt-image-2.6-flare'), compareKey('xlink', 'gpt-image-2.5-flare')],
  }
  writeGenerationSettings(storage, settings)
  assert.deepEqual(readGenerationSettings(storage), settings)
  assert.ok(storage.map.has(GENERATION_SETTINGS_STORAGE_KEY), 'the payload uses the documented key')
})

test('#68 legacy sizes and qualities from older records still load', () => {
  assert.equal(normalizeSize('1024x1024'), '1:1')
  assert.equal(normalizeSize('1536x1024'), '3:2')
  assert.equal(normalizeSize('1024x1792'), '9:16')
  assert.equal(normalizeSize('512x512'), '1:1')
  assert.equal(normalizeSize('16:9'), '16:9')
  assert.equal(normalizeSize('nonsense'), 'auto')
  assert.equal(normalizeQuality('high'), '4k')
  assert.equal(normalizeQuality('medium'), '2k')
  assert.equal(normalizeQuality('low'), '1k')
  assert.equal(normalizeQuality('2k'), '2k')
  assert.equal(normalizeQuality('nonsense'), 'auto')
  assert.equal(normalizeDetail('standard'), 'standard')
  assert.equal(normalizeDetail('ultra'), '')

  const storage = memoryStorage({
    [GENERATION_SETTINGS_STORAGE_KEY]: JSON.stringify({ size: '1024x1024', quality: 'high', detail: 'bogus' }),
  })
  const restored = readGenerationSettings(storage)
  assert.equal(restored.size, '1:1')
  assert.equal(restored.quality, '4k')
  assert.equal(restored.detail, '')
})

test('#68 the image count is clamped into the supported range', () => {
  assert.equal(normalizeCount(1), 1)
  assert.equal(normalizeCount(4), 4)
  assert.equal(normalizeCount(0), 1)
  assert.equal(normalizeCount(-3), 1)
  assert.equal(normalizeCount(9), 4)
  assert.equal(normalizeCount(2.6), 3)
  assert.equal(normalizeCount('3'), 3)
  assert.equal(normalizeCount('many'), 1)
  assert.equal(normalizeCount(Number.NaN), 1)
  assert.equal(normalizeCount(undefined), 1)

  const restored = readGenerationSettings(memoryStorage({ [GENERATION_SETTINGS_STORAGE_KEY]: JSON.stringify({ count: 7 }) }))
  assert.equal(restored.count, 4)
})

test('#68 malformed payloads degrade to defaults instead of throwing', () => {
  for (const raw of ['not json', '[]', 'null', '"text"', '42', '{}']) {
    const storage = memoryStorage({ [GENERATION_SETTINGS_STORAGE_KEY]: raw })
    assert.deepEqual(readGenerationSettings(storage), defaultGenerationSettings(), `payload ${raw} falls back`)
  }
  assert.doesNotThrow(() => readGenerationSettings(memoryStorage({}, 'get')))
  assert.doesNotThrow(() => writeGenerationSettings(memoryStorage({}, 'set'), defaultGenerationSettings()))
})

test('#68 comparison keys round-trip and reject malformed entries', () => {
  assert.deepEqual(compareChoice(compareKey('', 'gpt-image-2')), { channelId: '', model: 'gpt-image-2' })
  assert.deepEqual(compareChoice(compareKey('packapi', 'gpt-image-2.6-flare')), { channelId: 'packapi', model: 'gpt-image-2.6-flare' })
  assert.equal(compareChoice('no-separator'), undefined)
  assert.equal(compareChoice(compareKey('packapi', '')), undefined)

  const storage = memoryStorage({
    [GENERATION_SETTINGS_STORAGE_KEY]: JSON.stringify({
      model: 'gpt-image-2.6-flare',
      channelId: 'packapi',
      compareModels: ['no-separator', compareKey('xlink', 'gpt-image-2'), compareKey('xlink', 'gpt-image-2'), 42],
    }),
  })
  const restored = readGenerationSettings(storage)
  assert.deepEqual(restored.compareModels, [compareKey('xlink', 'gpt-image-2')], 'invalid keys are dropped and duplicates collapse')
})

test('#68 a remembered model seeds the comparison list', () => {
  const storage = memoryStorage({
    [GENERATION_SETTINGS_STORAGE_KEY]: JSON.stringify({ model: 'gpt-image-2.5-sunburst', channelId: 'packapi' }),
  })
  const restored = readGenerationSettings(storage)
  assert.equal(restored.model, 'gpt-image-2.5-sunburst')
  assert.deepEqual(restored.compareModels, [compareKey('packapi', 'gpt-image-2.5-sunburst')])
})

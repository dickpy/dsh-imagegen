import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureAgentImageConfigured } from '../src/agent-image-tools.ts'

function config(channel) {
  return {
    enabled: true,
    allowAgentImageGeneration: true,
    defaultChannelId: 'channel-a',
    channels: [{
      id: 'channel-a',
      preset: '',
      name: 'Image channel',
      apiUrl: '',
      apiUrlFull: false,
      apiKey: '',
      models: [{ alias: 'image-model', id: 'image-model' }],
      ...channel,
    }],
  }
}

test('subscription channel with a resolved subscription passes image preflight', () => {
  assert.doesNotThrow(() => ensureAgentImageConfigured(config({ auth: 'subscription', subscription: 'chatgpt-sub' })))
})

test('subscription channel without a resolved subscription fails image preflight', () => {
  assert.throws(() => ensureAgentImageConfigured(config({ auth: 'subscription' })), { code: 'image-api-not-configured' })
})

test('API-key channel with URL and key passes image preflight', () => {
  assert.doesNotThrow(() => ensureAgentImageConfigured(config({ auth: 'api-key', apiUrl: 'https://example.com/v1', apiKey: 'test-key' })))
})

test('empty API-key channel fails image preflight', () => {
  assert.throws(() => ensureAgentImageConfigured(config({ auth: 'api-key' })), { code: 'image-api-not-configured' })
})

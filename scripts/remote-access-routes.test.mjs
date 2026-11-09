import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { makeRoutes } from '../lib/index.js'

const descriptor = { ns: 'dsh-imagegen', value: { channels: [{ id: 'images', models: [{ id: 'gpt-image-2', alias: 'GPT Image 2' }] }] }, base: {}, user: {}, secrets: [], revision: 1 }
function fixture(mode = 'trusted-host', admission = { peer: { id: 'owner' } }) {
  let mutations = 0
  const routes = makeRoutes({
    resolve: () => ({ apiUrl: '', apiKey: '' }),
    resolveRemoteAccess: () => mode,
    resolveConnection: () => ({ browserPeer: { id: 'owner' }, admit: () => admission }),
    settings: { writable: true, describe: () => [descriptor], mutate: async () => { mutations++ } },
    attachments: { saveImage: async () => { throw Error('must not be reached') }, readImage: async () => { throw Error('must not be reached') } },
    pendingConversationImages: new Map(),
  })
  return { routes, mutations: () => mutations }
}
async function invoke(route, body = {}, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, { headers: { host: 'images.example', origin: 'https://images.example', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: route.path })
  let status, content
  const res = { writeHead(code) { status = code }, end(value) { content = value } }
  await route.handler(req, res)
  return { status, body: JSON.parse(content) }
}

test('every registered route rejects unauthenticated remote requests before reading bodies or doing work', async () => {
  const { routes } = fixture('trusted-host', { rejection: 401 })
  assert.ok(routes.length > 50)
  for (const route of routes) {
    const result = await invoke(route)
    assert.equal(result.status, 401, route.path)
  }
})

test('all routes reject a valid nonowner API peer', async () => {
  const { routes } = fixture('trusted-host', { peer: { id: 'api-peer' } })
  for (const route of routes) assert.equal((await invoke(route)).status, 403, route.path)
})

test('read-only only exposes redacted settings description, without granting mutations or generation', async () => {
  const { routes } = fixture('read-only')
  for (const route of routes) {
    const result = await invoke(route)
    if (route.path === '/api/dsh-imagegen/settings/describe') {
      assert.equal(result.status, 200)
      assert.equal(result.body.value.writable, false)
      assert.equal(result.body.value.namespaces[0].value.channels[0].models[0].alias, 'GPT Image 2')
    } else assert.equal(result.status, 403, route.path)
  }
})

test('trusted owner can read/write settings but cannot change host remoteAccess policy', async () => {
  const f = fixture()
  const describe = f.routes.find(r => r.path.endsWith('/settings/describe'))
  const mutate = f.routes.find(r => r.path.endsWith('/settings/mutate'))
  assert.equal((await invoke(describe)).body.value.writable, true)
  assert.equal((await invoke(mutate, { ns: 'dsh-imagegen', expectedRevision: 1, ops: [{ op: 'set', path: ['channels'], value: [] }] })).body.ok, true)
  assert.equal(f.mutations(), 1)
  for (const path of [['remoteAccess'], []]) {
    const result = await invoke(mutate, { ns: 'dsh-imagegen', ops: [{ op: 'set', path, value: 'trusted-host' }] })
    assert.equal(result.status, 403)
  }
  assert.equal(f.mutations(), 1)
})

test('cross-site request metadata rejects all routes even for a valid owner', async () => {
  const { routes } = fixture()
  for (const route of routes) assert.equal((await invoke(route, {}, { origin: undefined, 'sec-fetch-site': 'cross-site' })).status, 403, route.path)
})

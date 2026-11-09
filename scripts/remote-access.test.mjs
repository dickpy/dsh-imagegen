import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteAccessRejection, requestAccessRejection, remoteSettingsMutationAllowed } from '../src/remote-access.ts'

const owner = { ownerId: 'browser-owner', admission: { peer: { id: 'browser-owner' } } }
const base = { loopback: false, crossSite: false, remoteAccess: 'trusted-host', ...owner }
const req = (headers = {}) => ({ headers: { host: 'images.example', origin: 'https://images.example', ...headers }, socket: { remoteAddress: '127.0.0.1' } })

test('remote management requires explicit opt-in and admitted browser owner', () => {
  assert.equal(remoteAccessRejection(base), undefined)
  for (const remoteAccess of [undefined, 'read-only', 'bad-value', true]) assert.equal(remoteAccessRejection({ ...base, remoteAccess }), 403)
  assert.equal(remoteAccessRejection({ ...base, remoteAccess: 'read-only', describe: true }), undefined)
  assert.equal(remoteAccessRejection({ ...base, admission: undefined }), 403)
  assert.equal(remoteAccessRejection({ ...base, ownerId: undefined }), 403)
  assert.equal(remoteAccessRejection({ ...base, admission: { peer: { id: 'api-peer' } } }), 403)
  assert.equal(remoteAccessRejection({ ...base, admission: { rejection: 401 } }), 401)
  assert.equal(remoteAccessRejection({ ...base, admission: { rejection: 403 } }), 403)
  assert.equal(remoteAccessRejection({ ...base, crossSite: true }), 403)
})

test('original request is delegated to official admission and failures stay closed', () => {
  const request = req(); let received
  const connection = { browserPeer: { id: 'browser-owner' }, admit(r) { received = r; return owner.admission } }
  assert.equal(requestAccessRejection(request, 'trusted-host', () => connection), undefined)
  assert.equal(received, request)
  for (const connection of [undefined, {}, { browserPeer: { id: 'owner' } }, { admit() { throw Error('offline') } }]) assert.equal(requestAccessRejection(request, 'trusted-host', () => connection), 403)
  for (const rejection of [401, 403]) assert.equal(requestAccessRejection(request, 'trusted-host', () => ({ browserPeer: { id: 'browser-owner' }, admit: () => ({ rejection }) })), rejection)
})

test('cross-site metadata is rejected even if Origin is absent and admission would pass', () => {
  let called = false
  const request = req({ origin: undefined, 'sec-fetch-site': 'cross-site' })
  assert.equal(requestAccessRejection(request, 'trusted-host', () => { called = true; return { browserPeer: { id: 'browser-owner' }, admit: () => owner.admission } }), 403)
  assert.equal(called, false)
})

test('loopback retains its literal authority and same-origin boundary', () => {
  assert.equal(requestAccessRejection(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), 'read-only'), undefined)
  assert.equal(requestAccessRejection(req({ host: '127.0.0.1:3080', origin: 'https://attacker.example' }), 'trusted-host'), 403)
  assert.equal(requestAccessRejection(req({ host: '127.0.0.1:3080', origin: undefined, 'sec-fetch-site': 'cross-site' }), 'trusted-host'), 403)
  const request = req({ host: '127.0.0.1:3080', origin: undefined }); request.socket.remoteAddress = '203.0.113.1'
  assert.equal(requestAccessRejection(request, 'trusted-host'), 403)
})

test('remote mutation cannot enable itself, replace the root, change namespace or traverse prototypes', () => {
  const allowed = [{ op: 'set', path: ['channels'], value: [] }, { op: 'set', path: ['channelSecrets', 'provider'], value: 'secret' }]
  assert.equal(remoteSettingsMutationAllowed('dsh-imagegen', 'dsh-imagegen', allowed), true)
  for (const op of [
    { op: 'set', path: ['remoteAccess'], value: 'trusted-host' },
    { op: 'unset', path: ['remoteAccess'] }, { op: 'set', path: [], value: {} },
    { op: 'set', path: ['__proto__', 'remoteAccess'], value: 'trusted-host' },
    { op: 'set', path: ['channels', 'constructor'], value: {} }, { op: 'reset', path: ['channels'] },
    null, {},
  ]) assert.equal(remoteSettingsMutationAllowed('dsh-imagegen', 'dsh-imagegen', [op]), false)
  assert.equal(remoteSettingsMutationAllowed('other', 'dsh-imagegen', allowed), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { appendGallery, listGallery } from '../src/gallery-store.ts'
import { addTemplateFavorite, clearTemplateFavoritesMemo, listTemplateFavorites, setLegacyFavoritesPathForTests } from '../src/template-favorites.ts'

// Never let the legacy-import probe read the developer's real home directory.
const absentLegacy = path.join(tmpdir(), `dsh-imagegen-legacy-absent-${process.pid}.json`)
setLegacyFavoritesPathForTests(absentLegacy)

const favoriteCase = id => ({
  id, title: 't', prompt: 'p', category: '', categoryZh: '', styles: [], scenes: [],
  sourceLabel: '', sourceUrl: '', githubUrl: '', image: '', featured: false,
})

const galleryInput = id => ({
  id,
  createdAt: 1,
  mode: 'text',
  model: 'm',
  prompt: 'p',
  size: '',
  quality: '',
  detail: '',
  n: 1,
  images: [{ b64: 'aGk=', mime: 'image/png' }],
})

function quarantineBackups(dir, prefix) {
  return readdirSync(dir).filter(name => name.startsWith(`${prefix}.bad-`))
}

test('a corrupt gallery index is backed up instead of silently overwritten', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-gallery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  setImageDataRoot(root)
  const galleryDir = path.join(root, 'gallery')
  mkdirSync(galleryDir, { recursive: true })
  writeFileSync(path.join(galleryDir, 'index.json'), '{ "entries": [ broken')

  assert.deepEqual(await listGallery(), [])
  const backups = quarantineBackups(galleryDir, 'index.json')
  assert.equal(backups.length, 1)
  assert.match(readFileSync(path.join(galleryDir, backups[0]), 'utf8'), /broken/)

  // The next append must keep the backup around and start a fresh index.
  const appended = await appendGallery(galleryInput('one'))
  assert.equal(appended.added, true)
  assert.equal((await listGallery()).length, 1)
  assert.equal(quarantineBackups(galleryDir, 'index.json').length, 1)
})

test('a gallery index with partially invalid entries keeps the valid rows and the original', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-gallery-partial-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  setImageDataRoot(root)
  const galleryDir = path.join(root, 'gallery')
  mkdirSync(galleryDir, { recursive: true })
  const valid = { id: 'a-1', createdAt: 1, mode: 'text', model: 'm', prompt: 'p', size: '', quality: '', detail: '', n: 1, images: [{ file: 'a-0.png', mime: 'image/png' }] }
  writeFileSync(path.join(galleryDir, 'index.json'), JSON.stringify({ entries: [valid, 'garbage'] }))

  const entries = await listGallery()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'a-1')
  assert.equal(quarantineBackups(galleryDir, 'index.json').length, 1)
})

test('a corrupt favorites file is backed up and the next star keeps the backup', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-favorites-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  setImageDataRoot(root)
  clearTemplateFavoritesMemo()
  const templatesDir = path.join(root, 'templates')
  mkdirSync(templatesDir, { recursive: true })
  writeFileSync(path.join(templatesDir, 'favorites.json'), 'not json at all')

  assert.deepEqual(await listTemplateFavorites(), [])
  const backups = quarantineBackups(templatesDir, 'favorites.json')
  assert.equal(backups.length, 1)
  assert.match(readFileSync(path.join(templatesDir, backups[0]), 'utf8'), /not json/)

  await addTemplateFavorite('vibeui', {
    id: 'c1', title: 't', prompt: 'p', category: '', categoryZh: '', styles: [], scenes: [],
    sourceLabel: '', sourceUrl: '', githubUrl: '', image: '', featured: false,
  })
  assert.equal((await listTemplateFavorites()).length, 1)
  assert.equal(quarantineBackups(templatesDir, 'favorites.json').length, 1)
})

test('a favorites file with invalid rows keeps the valid rows and the original', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-favorites-partial-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  setImageDataRoot(root)
  clearTemplateFavoritesMemo()
  const templatesDir = path.join(root, 'templates')
  mkdirSync(templatesDir, { recursive: true })
  writeFileSync(path.join(templatesDir, 'favorites.json'), JSON.stringify(['garbage', { key: 'vibeui:c2', sourceId: 'vibeui', savedAt: '2026-01-01T00:00:00.000Z', case: { id: 'c2', title: 't', prompt: 'p', category: '', categoryZh: '', styles: [], scenes: [], sourceLabel: '', sourceUrl: '', githubUrl: '', image: '', featured: false } }]))

  const favorites = await listTemplateFavorites()
  assert.equal(favorites.length, 1)
  assert.equal(favorites[0].key, 'vibeui:c2')
  assert.equal(quarantineBackups(templatesDir, 'favorites.json').length, 1)
})

test('favorites follow the data root without overwriting another root', async t => {
  const rootA = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-root-a-'))
  const rootB = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-root-b-'))
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })
  setImageDataRoot(rootA)
  clearTemplateFavoritesMemo()
  await addTemplateFavorite('vibeui', favoriteCase('a'))
  assert.equal((await listTemplateFavorites()).length, 1)

  const favoritesB = path.join(rootB, 'templates', 'favorites.json')
  mkdirSync(path.dirname(favoritesB), { recursive: true })
  writeFileSync(favoritesB, JSON.stringify([
    { key: 'vibeui:b', sourceId: 'vibeui', savedAt: '2026-01-01T00:00:00.000Z', case: favoriteCase('b') },
  ]))

  // Switching the data root must re-read the new root, not serve the memo.
  setImageDataRoot(rootB)
  assert.deepEqual((await listTemplateFavorites()).map(entry => entry.key), ['vibeui:b'])
  await addTemplateFavorite('vibeui', favoriteCase('c'))

  const onDiskA = JSON.parse(readFileSync(path.join(rootA, 'templates', 'favorites.json'), 'utf8'))
  const onDiskB = JSON.parse(readFileSync(favoritesB, 'utf8'))
  assert.deepEqual(onDiskA.map(entry => entry.key), ['vibeui:a'], 'the old root is untouched')
  assert.deepEqual(onDiskB.map(entry => entry.key), ['vibeui:c', 'vibeui:b'])
})

test('favorites import once from the legacy default path', async t => {
  const legacy = path.join(tmpdir(), `dsh-imagegen-legacy-${process.pid}-${Date.now()}.json`)
  writeFileSync(legacy, JSON.stringify([
    { key: 'vibeui:old', sourceId: 'vibeui', savedAt: '2026-01-01T00:00:00.000Z', case: favoriteCase('old') },
  ]))
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-imagegen-migrate-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(legacy, { force: true })
    setLegacyFavoritesPathForTests(absentLegacy)
  })
  setLegacyFavoritesPathForTests(legacy)
  setImageDataRoot(root)
  clearTemplateFavoritesMemo()

  const imported = await listTemplateFavorites()
  assert.deepEqual(imported.map(entry => entry.key), ['vibeui:old'])
  assert.equal(existsSync(path.join(root, 'templates', 'favorites.json')), true, 'the imported copy is persisted')
  assert.deepEqual((await listTemplateFavorites()).map(entry => entry.key), ['vibeui:old'])
})

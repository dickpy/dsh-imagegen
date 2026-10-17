/** Verify the actual npm tarball, not just the working tree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const file = process.argv[2]
assert.ok(file, 'Usage: node scripts/verify-package.mjs package.tgz')
const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim().split('\n')
for (const path of ['package/package.json', 'package/lib/index.js', 'package/lib/client.js', 'package/lib/locale-tables.js', 'package/cordis.patch.yml', 'package/src/poster.ts', 'package/src/client/template-library-state.ts', 'package/docs/releases/v1.7.0.md']) assert.ok(entries.includes(path), `missing ${path}`)
assert.ok(!entries.some(path => /node_modules|\.poster-preview|\.template-preview|\.npmrc|\.env(?:\.|$)/.test(path)), 'package contains no local dependencies, preview output or credentials')
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(manifest.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
const client = execFileSync('tar', ['-xOzf', file, 'package/lib/client.js'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
assert.ok(client.includes('data-template-drawer'), 'packaged client includes the template drawer')
assert.ok(client.includes('data-poster-editor'), 'packaged client includes the editor')
assert.ok(client.includes('__ModuleLoader__.load'), 'packaged client retains the host loader contract')
console.log(`PASS package ${manifest.name}@${manifest.version}: host/client entrypoints, editor, manifest, release notes and clean contents`)

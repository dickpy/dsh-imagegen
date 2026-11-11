/** Verify the actual npm tarball, not just the working tree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const file = process.argv[2]
assert.ok(file, 'Usage: node scripts/verify-package.mjs package.tgz')
const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim().split('\n')
for (const path of ['package/package.json', 'package/lib/index.js', 'package/lib/client.js', 'package/lib/locale-tables.js', 'package/cordis.patch.yml', 'package/src/poster.ts', 'package/src/client/template-library-state.ts', 'package/src/client/ReferenceImages.tsx', 'package/src/client/reference-images.ts', 'package/src/remote-access.ts', 'package/src/client/StudioResults.tsx', 'package/src/client/studio-state.ts', 'package/src/client/MaskEditor.tsx', 'package/src/image-dimensions.ts']) assert.ok(entries.includes(path), `missing ${path}`)
assert.ok(!entries.some(path => /node_modules|\.poster-preview|\.template-preview|\.references-preview|\.result-preview|\.npmrc|\.env(?:\.|$)/.test(path)), 'package contains no local dependencies, preview output or credentials')
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(manifest.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
assert.ok(entries.includes(`package/docs/releases/v${manifest.version}.md`), 'package includes current release notes')
assert.ok(entries.includes('package/src/ppt-runtime.ts'))
assert.ok(entries.includes('package/src/client/PptWorkspace.tsx'))
const client = execFileSync('tar', ['-xOzf', file, 'package/lib/client.js'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
// PPT conversion now uses the shared canvas skill surface, not a standalone tab.
assert.ok(client.includes('data-skill-run'), 'packaged client includes canvas skill task status')
assert.ok(client.includes('data-comparison-task'), 'packaged client includes per-model comparison slots')
assert.ok(client.includes('data-result-preview-grid'), 'packaged client includes the fitted result preview')
assert.ok(client.includes('update.hostManagedHint'), 'packaged client includes desktop update guidance')
assert.ok(client.includes('data-studio-slot') && client.includes('data-mask-editor'), 'packaged client includes fixed result cards and mask editing')
assert.ok(client.includes('data-edit-references'), 'packaged client includes multi-reference upload')
assert.ok(client.includes('data-template-drawer'), 'packaged client includes the template drawer')
assert.ok(client.includes('data-poster-editor'), 'packaged client includes the editor')
assert.ok(client.includes('__ModuleLoader__.load'), 'packaged client retains the host loader contract')
console.log(`PASS package ${manifest.name}@${manifest.version}: host/client entrypoints, editor, manifest, release notes and clean contents`)

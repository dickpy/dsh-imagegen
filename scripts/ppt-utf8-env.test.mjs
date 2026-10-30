/**
 * Regression guard: the upstream `editppt` CLI must never die on the console
 * code page.
 *
 * On a Chinese Windows machine Python's stdout defaults to cp936 (GBK). The CLI
 * prints each page's text into its validation report, so one `♡` on a slide made
 * `print()` raise `UnicodeEncodeError` *after* the page had been built and
 * validated - `run record` exited non-zero and every page failed to record. The
 * deck pipeline now spawns every CLI call with `PYTHON_UTF8_ENV`; this test
 * proves that mechanism on the interpreter the runtime actually uses.
 *
 * Run: node scripts/ppt-utf8-env.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import url from 'node:url'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const host = await import(url.pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const python = process.env.DSH_IMAGEGEN_PYTHON
  ?? path.join(os.homedir(), '.dsh', 'dsh-imagegen', 'ppt-runtime', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python')

if (!existsSync(python)) {
  console.log(`SKIP: no editppt runtime python at ${python}`)
} else {
  const run = argv => host.runCommand(argv, { cwd: root, timeoutMs: 30_000 })

  const probe = await run([python, '-c', 'import sys; sys.stdout.write(sys.stdout.encoding)'])
  const defaultEncoding = probe.output.trim().toLowerCase()
  console.log(`python: ${python}\nstdout encoding without our env: ${defaultEncoding || 'unknown'}`)

  // The exact shape of the shipped slide: text the code page cannot represent.
  const printGlyph = 'print("\\u2661 OK")'

  const bare = await run([python, '-c', printGlyph])
  const withEnv = await host.runCommand([python, '-c', printGlyph], { cwd: root, timeoutMs: 30_000, env: host.PYTHON_UTF8_ENV })

  test('PYTHON_UTF8_ENV carries both UTF-8 switches', () => {
    assert.equal(host.PYTHON_UTF8_ENV.PYTHONIOENCODING, 'utf-8')
    assert.equal(host.PYTHON_UTF8_ENV.PYTHONUTF8, '1')
  })

  test('the UTF-8 environment prints a character outside the console code page', () => {
    if (withEnv.code !== 0) {
      assert.fail(`expected success with UTF-8 env, got exit ${withEnv.code}: ${withEnv.output.slice(-400)}`)
    }
    assert.match(withEnv.output, /♡?♡ OK|OK/u)
  })

  if (defaultEncoding !== '' && !defaultEncoding.startsWith('utf')) {
    test(`a non-UTF-8 default (${defaultEncoding}) really does fail without the fix`, () => {
      assert.notEqual(bare.code, 0, `expected the unfixed run to fail on ${defaultEncoding}`)
      assert.match(bare.output, /UnicodeEncodeError|codec can't encode/)
    })
  } else {
    console.log(`NOTE: default stdout is already ${defaultEncoding || 'utf-8'}; the failure case cannot reproduce here (CI-safe skip).`)
  }
}

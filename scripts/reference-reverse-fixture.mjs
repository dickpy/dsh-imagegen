/** Real panel/API client; deterministic local vision responses, no paid requests. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

export const referencePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYlnfnPwAGXgLgLdtE6gAAAABJRU5ErkJggg==', 'base64')
export async function startReverseFixture() {
  const uploads = [], reversals = [], generations = []
  const control = { fail: false, delay: 0, uploadDelay: 0 }
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fcfcfd;--dsw-alias-bg-layer-2:#f1f2f6;--dsw-alias-bg-layer-3:#e6e8ee;--dsw-alias-border-l1:#e2e3ea;--dsw-alias-border-l2:#d4d6df;--dsw-alias-brand-primary:#5d55d9;--dsw-alias-label-primary:#25262a;--dsw-alias-label-secondary:#575b65;--dsw-alias-label-tertiary:#858b98}*{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui,sans-serif}.fixture-controls{height:36px;display:flex;gap:10px;padding:4px 14px;background:#eceef3}button,input,textarea{font-family:inherit}`
  const task = { id: 'source', request: { mode: 'text', prompt: 'Existing result', model: 'gpt-image-2', channelId: 'one', size: '1:1', quality: '1k', detail: '', n: 1 }, status: 'completed', createdAt: Date.now(), result: { images: [{ b64: referencePng.toString('base64'), mime: 'image/png', width: 1, height: 1 }] } }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test'), path = url.pathname
    if (path === '/preview.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(new URL('../.studio-preview/preview.js', import.meta.url))) }
    if (!path.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/preview.js"></script></html>`) }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (path.endsWith('/canvas/file/upload')) {
      const name = url.searchParams.get('name'), assetId = `reference-${uploads.length}.png`
      uploads.push({ name, bytes, mime: req.headers['content-type'] })
      if (control.uploadDelay) await new Promise(resolve => setTimeout(resolve, control.uploadDelay))
      return json(res, { ok: true, asset: { assetId, name, url: `/asset/${assetId}`, mime: 'image/png', width: 1, height: 1, bytes: bytes.length, origin: 'upload' } })
    }
    const body = bytes.length ? JSON.parse(bytes.toString()) : {}
    if (path.endsWith('/reverse-prompt')) {
      reversals.push(body)
      if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay))
      if (control.fail) return json(res, { ok: false, error: 'fixture vision unavailable' }, 503)
      return json(res, { ok: true, prompt: `Reusable prompt from ${body.images[0].name}` })
    }
    if (path.endsWith('/tasks/submit')) { generations.push(body); return json(res, { ok: true, task }) }
    if (path.endsWith('/tasks/get')) return json(res, { ok: true, task })
    if (path.endsWith('/tasks/list')) return json(res, { ok: true, tasks: [] })
    if (path.endsWith('/templates/list')) return json(res, { ok: true, sourceId: body.source, cases: [], total: 0, origin: 'bundled', repository: 'fixture', fetchedAt: Date.now() })
    return json(res, { ok: true, entries: [], favorites: [], samples: [], categories: [], projects: [], available: false })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, uploads, reversals, generations, control }
}

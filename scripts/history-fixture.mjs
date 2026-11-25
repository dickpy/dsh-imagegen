import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function png(red, green, blue) {
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) } return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, b.length - 4)), b.length - 4); return b }
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc(65 * 16)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set([red, green, blue, 255], y * 65 + x * 4 + 1)
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const assets = { 'text-a': png(220, 40, 50), 'text-b': png(30, 80, 220), edit: png(30, 180, 80), missing: png(100, 100, 100), live: png(220, 170, 40) }
const request = { mode: 'text', model: 'gpt-image-2', channelId: 'one', prompt: 'Latest live task', size: '1:1', quality: '1k', detail: '', n: 1 }
const task = { id: 'live', request, createdAt: Date.now(), status: 'completed', result: { images: [{ b64: assets.live.toString('base64'), mime: 'image/png', model: 'gpt-image-2' }] } }
const entries = ['text-a', 'text-b', 'edit', 'missing'].map((id, index) => ({
  id, createdAt: Date.parse('2026-11-13T12:30:00Z') - index * 60_000,
  mode: id === 'edit' ? 'edit' : 'text', prompt: `History ${id}`, model: 'gpt-image-2', channelId: 'one',
  size: '16:9', quality: '2k', detail: '', n: 1, images: [{ url: `/history/image/${id}.png`, mime: 'image/png' }],
}))
entries.push({ ...entries[0], id: 'live-history', prompt: 'Saved live task', comparisonId: 'live-run', images: [{ url: '/history/image/live.png', mime: 'image/png' }] })
const delays = new Map()
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const css = `:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fcfcfd;--dsw-alias-bg-layer-2:#f1f2f6;--dsw-alias-border-l1:#e2e3ea;--dsw-alias-label-primary:#25262a;--dsw-alias-label-secondary:#575b65;--dsw-alias-label-tertiary:#858b98}*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui,sans-serif}body{display:flex}#root{flex:1;min-width:0;height:100%}.fixture-controls{height:36px;display:flex;align-items:center;gap:10px;padding:4px 14px;background:#eceef3}.host_sidebarCol{width:260px;flex:none}.host_root{height:100%;display:flex;flex-direction:column;padding:8px;gap:8px}.host_logoRow{height:36px;flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;position:relative}.host_brand{flex:1;display:flex;align-items:center;border:0;background:transparent;font:inherit;color:#25262a;text-align:left;cursor:pointer}.host_toggle{width:28px;height:28px;flex:none;border:0;border-radius:6px;background:transparent;color:#575b65;cursor:pointer}.host_newSessionRow{height:38px;flex:none;display:flex;align-items:center;gap:6px}.host_newSession{container-type:inline-size;flex:1 1 auto;min-width:0;height:38px;overflow:hidden}.host_newSessionContent{display:flex;gap:8px;align-items:center;justify-content:center;width:100cqw;white-space:nowrap}.host_quickAction{width:28px;flex:none}.host_scrollRegion,.host_scrollArea{display:flex;flex:1;min-height:0;flex-direction:column}.host_regionArea{flex:1;min-height:0;position:relative}.host_footArea{height:24px;flex:none}.host_panelList{display:flex;flex-direction:column;gap:2px;margin-bottom:8px}.host_panelEntry{display:flex;border-inline:3px solid transparent;border-radius:8px;background-clip:padding-box}.host_panelRow{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;margin:0;padding:5px 9px;box-sizing:border-box;border:0;border-radius:8px;background:transparent;color:#25262a;font:inherit;line-height:22px;text-align:left;cursor:pointer}`
// The shipped shell's own shape: the collapse control is a SIBLING of the brand
// inside `logoRow` (non-darwin), and a skin adds its own top band. Keeping both
// here is what makes the "collapse button disappears" regression reachable.
const sidebar = '<aside class="host_sidebarCol" data-pane="sidebar"><div class="host_root"><div class="host_logoRow"><button class="host_brand" type="button">DSH 0.2.2-rc.3</button><button class="host_toggle" type="button" data-sidebar-toggle aria-label="收起侧边栏" onclick="window.toggleClicks=(window.toggleClicks||0)+1">⟨</button></div><div class="host_newSessionRow"><button class="host_newSession" aria-label="新建会话" onclick="window.nativeSessions=(window.nativeSessions||0)+1"><span class="host_newSessionContent"><span>＋</span><span>新建会话</span></span></button><button class="host_quickAction">⋮</button></div><div class="host_scrollRegion"><div class="host_scrollArea"><nav class="host_panelList" aria-label="全局面板"><button class="host_panelRow" type="button">插件</button><button class="host_panelRow" type="button">自动化任务</button></nav><div class="host_regionArea">Native sessions</div></div></div><div class="host_footArea">Account</div></div></aside>'
const mountSidebar = 'const c = new window.studioSidebar.Controller(); c.open(); window.sidebarController=c; window.sidebarDispose=window.studioSidebar.mount();'
// The shipped shell renders the plugin's launcher icon inside its `sidebar.panellist`
// row; the static fixture shell predates that, so the row gets the same marker the
// real one carries. Keeping the icon on the fixture keeps the primary marker path
// (resolved from our own icon) under test.
const iconInject = `(function(){var row=document.querySelectorAll('.host_panelRow')[1];if(row&&!row.querySelector('[data-dsh-imagegen-panel-icon]'))row.insertAdjacentHTML('afterbegin','<span data-dsh-imagegen-panel-icon></span>')})()`

/**
 * The dsh-islands-ui sidebar: same host markup, restructured into the skin's
 * five-row grid (gap / brand band / island / two foot seats) with a rail column
 * and `data-islands-part` markers. Only the geometry that the takeover has to
 * survive is reproduced — the empty band above the history is exactly the
 * reserved leading rows, so this fixture makes that regression measurable.
 */
const islandsCss = `.host_sidebarCol{width:316px;position:relative;padding-left:56px}.host_root{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:8px 36px minmax(0,1fr) auto auto;height:100%;padding:0 8px 0 0;gap:0}.host_logoRow{grid-area:2/1;height:36px;margin:0 0 6px;display:flex;align-items:center;justify-content:flex-end}.host_scrollRegion{grid-area:3/1/5/2}.host_scrollArea{height:100%}.host_panelList{display:none}.host_footArea{grid-area:5/1}.isl-rail{position:absolute;left:0;top:0;bottom:0;width:56px}`
const islandsSidebar = '<aside class="host_sidebarCol" data-pane="sidebar"><div class="host_root" data-islands-part="sidebar-root"><div class="host_logoRow" data-islands-part="logo-row"><button class="host_brand" type="button" data-islands-part="brand-button">DSH</button><button class="host_toggle" type="button" data-sidebar-toggle data-islands-part="sidebar-toggle" aria-label="收起侧边栏" onclick="window.toggleClicks=(window.toggleClicks||0)+1">⟨</button></div><nav class="host_panelList" data-islands-part="panel-list"><button class="host_panelRow" type="button">插件</button><button class="host_panelRow" type="button">生图</button></nav><div class="host_scrollRegion" data-islands-part="sidebar-scroll-region"><div class="host_scrollArea" data-islands-part="sidebar-scroll-area"><div class="host_regionArea" data-islands-part="region-area">Native sessions</div></div></div><div class="host_footArea" data-islands-part="foot-area">Account</div></div><div class="isl-rail"></div></aside>'
export function addPaginatedHistory(entries) {
  const source = entries[1]
  const archive = Array.from({ length: 16 }, (_, index) => ({
    ...source, id: `archive-${index + 1}`, prompt: `Archive record ${index + 1}`,
    createdAt: source.createdAt - (index + 5) * 60_000,
  }))
  const oldest = archive.at(-1)
  oldest.model = 'gpt-image-2.5-flare'
  oldest.size = '3:2'
  entries.push(...archive, { ...oldest, id: 'archive-16-edit', mode: 'edit', prompt: 'Archive revision',
    parentId: oldest.id, parentImageIndex: 0, threadId: oldest.id, createdAt: oldest.createdAt + 1 })
}

export async function startHistoryFixture() {
  let settings = { enabled: true, defaultChannelId: 'sense', defaultModel: 'SenseNova image', channels: [
    { id: 'sense', preset: '', name: 'SenseNova relay', apiUrl: 'https://relay.example/v1', apiUrlFull: false, protocol: 'images', models: [{ alias: 'SenseNova image', id: 'sensenova-u1.5-lite' }, { alias: 'GPT fallback', id: 'gpt-image-2' }] },
    { id: 'plain', preset: '', name: 'OpenAI channel', apiUrl: 'https://api.openai.com/v1', apiUrlFull: false, protocol: 'images', models: [{ alias: 'GPT Image', id: 'gpt-image-2' }] },
  ] }
  let revision = 1
  const settingsMutations = []
  const requests = []
  const settingsView = () => ({ ns: 'dsh-imagegen', value: settings, base: settings, user: settings, revision, secrets: settings.channels.map(channel => ({ path: ['channelSecrets', channel.id], set: true })) })
  const server = createServer(async (req, res) => {
    if (req.url === '/preview.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(new URL('../.studio-preview/preview.js', import.meta.url))) }
    if (req.url.startsWith('/history/image/')) {
      const id = req.url.split('/').at(-1).replace('.png', '')
      if (req.headers['sec-fetch-dest'] !== 'image') {
        if (delays.has(id)) await new Promise(resolve => setTimeout(resolve, delays.get(id)))
        if (id === 'missing') { res.writeHead(503); return res.end('fixture image unavailable') }
      }
      res.setHeader('content-type', 'image/png'); return res.end(assets[id])
    }
    if (!req.url.startsWith('/api/')) {
      // `?takeover` mirrors what mount.tsx publishes when the setting is on:
      // the attribute on <html> plus the setting the panel reads for its own
      // header. Keeping it on the page URL means the assertions run against the
      // real stylesheet instead of a hand-written copy of the rule.
      const takeover = req.url.includes('takeover')
      const islands = req.url.includes('islands')
      if (takeover && settings.sidebarTakeover !== true) settings = { ...settings, sidebarTakeover: true }
      res.setHeader('content-type', 'text/html')
      const style = islands ? `${css}${islandsCss}` : css
      const shell = islands ? islandsSidebar : sidebar
      const bodyAttr = islands ? ' data-islands-ui' : ''
      return res.end(`<!doctype html><html data-dsh-imagegen-active${takeover ? ' data-dsh-imagegen-sidebar-takeover' : ''}><meta charset="utf-8"><style>${style}</style><body${bodyAttr}>${shell}<div id="root"></div><script src="/preview.js"></script><script>${iconInject};${mountSidebar}</script></body></html>`)
    }
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : {}
    if (req.url.endsWith('/settings/describe')) return json(res, { ok: true, value: { writable: true, namespaces: [settingsView()] } })
    if (req.url.endsWith('/settings/mutate')) {
      settingsMutations.push(body)
      for (const op of body.ops ?? []) {
        if (op.path.length !== 1) continue
        if (op.op === 'set') settings = { ...settings, [op.path[0]]: op.value }
        else delete settings[op.path[0]]
      }
      revision++
      return json(res, { ok: true, value: settingsView() })
    }
    if (req.url.endsWith('/image-models')) return json(res, { ok: true, models: ['sensenova-u1.5-lite', 'gpt-image-2'] })
    if (req.url.endsWith('/tasks/list')) return json(res, { ok: true, tasks: [{ ...task, result: undefined, resultAvailable: true }] })
    if (req.url.endsWith('/tasks/get')) return json(res, { ok: true, task })
    if (req.url.endsWith('/tasks/submit')) { requests.push(body); return json(res, { ok: true, task: { ...task, request: body } }) }
    if (req.url.endsWith('/history/list')) return json(res, { ok: true, entries })
    if (req.url.endsWith('/history/remove')) {
      const index = entries.findIndex(entry => entry.id === body.id)
      if (index >= 0) entries.splice(index, 1)
      return json(res, { ok: true, entries })
    }
    if (req.url.endsWith('/update/check')) return json(res, { ok: true, update: { currentVersion: '1.17.0', latestVersion: '1.17.0', updateAvailable: false } })
    return json(res, { ok: true, entries: [], samples: [], tasks: [], available: false, categories: [], projects: [] })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, assets, entries, task, delays, settingsMutations, requests }
}

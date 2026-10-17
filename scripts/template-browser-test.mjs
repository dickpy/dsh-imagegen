/** Run after pnpm exec tsdown --config scripts/template-preview.config.ts.
 * Uses real TemplateLibrary, scoped styles, browser pointer/keyboard events and
 * deterministic local images/API; does not call a model or any live host.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const runtimeRequire = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.template-test.cjs`) : require
const { chromium } = runtimeRequire('playwright')
const css = `
${process.env.TEMPLATE_PREVIEW_FONT ? '@font-face{font-family:PreviewCJK;src:url(/font)}' : ''}
:root{--dsw-font-family:Inter,PreviewCJK,system-ui,sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f8f8f9;--dsw-alias-bg-layer-2:#f0f0f2;--dsw-alias-bg-mask-1:#11111135;--dsw-alias-border-l1:#e6e6e8;--dsw-alias-border-l2:#d7d7da;--dsw-alias-label-primary:#242426;--dsw-alias-label-secondary:#656569;--dsw-alias-label-tertiary:#838389;--dsw-alias-label-dimmed:#95959c;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-brand-primary:#303034;--dsw-alias-button-primary-fill:#303034;--dsw-alias-button-primary-hover:#45454a;--dsw-alias-interactive-bg-hover:#ebebee}
:root[data-dark]{--dsw-alias-bg-base:#202023;--dsw-alias-bg-layer-1:#28282c;--dsw-alias-bg-layer-2:#333338;--dsw-alias-bg-mask-1:#0008;--dsw-alias-border-l1:#3e3e43;--dsw-alias-border-l2:#525259;--dsw-alias-label-primary:#ededf0;--dsw-alias-label-secondary:#b4b4bd;--dsw-alias-label-tertiary:#9c9ca6;--dsw-alias-label-dimmed:#898992;--dsw-alias-label-primary-foreground:#202023;--dsw-alias-brand-primary:#e5e5ea;--dsw-alias-button-primary-fill:#e5e5ea;--dsw-alias-button-primary-hover:#fff;--dsw-alias-interactive-bg-hover:#393940}
*{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px var(--dsw-font-family)}button,input,textarea,select{font-family:inherit}.fixture-header{height:70px;padding:0 30px;display:flex;align-items:center;gap:28px;border-bottom:1px solid var(--dsw-alias-border-l1)}.fixture-header span{color:var(--dsw-alias-label-tertiary);font-size:12px}.fixture-header select{margin-left:auto;border:0;background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:9px;padding:9px}.fixture-workspace{position:relative;display:flex;height:calc(100dvh - 70px);min-height:0}.fixture-config{width:280px;flex:none;padding:24px;border-right:1px solid var(--dsw-alias-border-l1)}.fixture-config h3{margin:0 0 30px;font-size:15px}.fixture-config small{display:block;margin:20px 0 10px;color:var(--dsw-alias-label-secondary)}.fixture-config textarea{width:100%;height:150px;padding:13px;line-height:1.8;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);resize:none}.fixture-control{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;font-size:12px}.fixture-generate{width:100%;margin-top:28px;padding:12px;border:0;border-radius:12px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.fixture-stage{flex:1;align-self:center;text-align:center;color:var(--dsw-alias-label-secondary)}.fixture-kicker{font-size:11px;letter-spacing:2px}.fixture-stage h1{font-size:28px;font-weight:550;color:var(--dsw-alias-label-primary);margin:18px 0}.fixture-stage p{font-size:13px}.fixture-empty{margin:40px auto;width:180px;height:170px;background:var(--dsw-alias-bg-layer-1);border-radius:20px;display:grid;place-items:center;font-size:35px;font-weight:200;color:var(--dsw-alias-border-l2)}@media(max-width:760px){.fixture-header{padding:0 16px;gap:12px}.fixture-header span{display:none}.fixture-config{width:100%;border:0}.fixture-stage{display:none}}
`
function poster(index) {
  const colors = ['#dae4db','#e8dbbd','#b6bbac','#d3b7a5','#c0d0dd','#d5d5b6','#d7c5bb','#d1d2ce','#bdcad0','#d9c7b3','#cba297','#afbccc']
  const captions = ['PURE / FORM','SUMMER STUDIO','THE DAILY CUP','CITY JOURNAL','A NEW PERSPECTIVE','BOTANICAL','SHAPES OF LIFE','HAND / MADE','OBJECT STUDIES','SLOW LIVING','LIMITED EDITION','TYPE IN MOTION']
  const i = Number(index) % 12
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="540" viewBox="0 0 720 540"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${colors[i]}"/><stop offset="1" stop-color="#f7f4ef"/></linearGradient><filter id="s"><feGaussianBlur stdDeviation="14"/></filter></defs><rect width="720" height="540" fill="url(#g)"/><text x="40" y="57" font-family="Arial" font-size="14" letter-spacing="4" fill="#333">FORM STUDIO / 2026</text><circle cx="540" cy="215" r="145" fill="#fff" opacity=".3"/><ellipse cx="360" cy="440" rx="150" ry="22" fill="#4b4b44" opacity=".2" filter="url(#s)"/>${i%3===0?'<rect x="278" y="165" width="164" height="265" rx="26" fill="#f6f6ed"/><rect x="302" y="120" width="116" height="75" rx="10" fill="#414b45"/><text x="360" y="284" text-anchor="middle" font-family="serif" font-size="32" fill="#485247">pure.</text><text x="360" y="316" text-anchor="middle" font-family="Arial" font-size="10" letter-spacing="3">BOTANICAL CARE</text>':i%3===1?'<circle cx="360" cy="285" r="135" fill="#af8658" opacity=".8"/><circle cx="360" cy="285" r="92" fill="#e5d5b7"/><rect x="258" y="269" width="204" height="17" fill="#453c32" transform="rotate(-28 360 285)"/>':'<path d="M235 210h235l-35 200H270z" fill="#f1ede3"/><ellipse cx="352" cy="210" rx="117" ry="36" fill="#ddd8ce"/><ellipse cx="352" cy="210" rx="96" ry="27" fill="#62503f"/><path d="M460 242c125-40 80 170-13 88" fill="none" stroke="#f1ede3" stroke-width="28"/>'}<text x="40" y="493" font-family="Arial" font-size="29" letter-spacing="2" fill="#383d3a">${captions[i]}</text><text x="40" y="521" font-family="Arial" font-size="10" letter-spacing="2" fill="#555">A LOCAL PREVIEW IMAGE / TEMPLATE LIBRARY</text></svg>`
}
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/dsh-imagegen/templates/image/')) { res.setHeader('content-type','image/svg+xml'); res.end(poster(req.url.split('/').pop().split('.')[0])); return }
  if (req.url === '/preview.js') { res.setHeader('content-type','text/javascript'); res.end(readFileSync(new URL('../.template-preview/preview.js', import.meta.url))); return }
  if (req.url === '/font' && process.env.TEMPLATE_PREVIEW_FONT) { res.end(readFileSync(process.env.TEMPLATE_PREVIEW_FONT)); return }
  res.setHeader('content-type','text/html'); res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/preview.js"></script></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless:true, ...(process.env.TEMPLATE_CHROMIUM_PATH ? {executablePath:process.env.TEMPLATE_CHROMIUM_PATH,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']} : {}) })
  const page = await browser.newPage({ viewport: {width:1440,height:1000} })
  const errors=[]; page.on('pageerror', error => errors.push(error.message))
  const url=`http://127.0.0.1:${server.address().port}`
  await page.goto(url); await page.evaluate(() => document.fonts.ready)
  const images=new URL('../docs/images/',import.meta.url); mkdirSync(images,{recursive:true})
  const shot = async name => { await page.screenshot({path:new URL(name,images).pathname}) }
  const trigger=page.locator('[data-template-library-trigger]')
  await shot('template-drawer-entry.png')
  await trigger.click()
  const drawer=page.locator('[data-template-drawer]')
  const shell=drawer.locator('section').first()
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).waitFor()
  const initial=await shell.boundingBox(); assert.equal(initial.width,1080,'drawer is 75% wide'); assert.equal(initial.y,70,'drawer is scoped below header')
  await shot('template-drawer-desktop.png')
  await page.getByRole('button',{name:'铺满工作区',exact:true}).click()
  assert.equal((await shell.boundingBox()).width,1440)
  await page.getByRole('button',{name:'恢复宽度',exact:true}).click()
  // Pointer resize grows the drawer; width preference survives reopening.
  const handle=page.getByRole('separator',{name:'调整模板库宽度'}), handleBox=await handle.boundingBox()
  await page.mouse.move(handleBox.x+5,handleBox.y+130); await page.mouse.down(); await page.mouse.move(handleBox.x-120,handleBox.y+130,{steps:10}); await page.mouse.up()
  const resized=(await shell.boundingBox()).width; assert.ok(resized>initial.width+100)
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).click()
  await page.getByRole('button',{name:'追加到提示词',exact:true}).waitFor()
  await shot('template-drawer-detail.png')
  await page.getByRole('button',{name:'追加到提示词',exact:true}).click()
  await drawer.waitFor({state:'detached'})
  assert.match(await page.getByLabel('当前提示词',{exact:true}).inputValue(),/^为新品.*\n\nCreate/s)
  await trigger.click(); assert.equal((await shell.boundingBox()).width,resized)
  await page.getByRole('tab',{name:'最近使用',exact:true}).click(); await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).waitFor()
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).click()
  await page.keyboard.press('Escape'); await page.locator('[data-template-detail]').waitFor({state:'detached'}); assert.ok(await drawer.isVisible(),'Escape first returns from detail')
  await page.keyboard.press('Escape'); await drawer.waitFor({state:'detached'}); assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'focus returns to entry')
  await trigger.click()
  await page.getByLabel('搜索范围',{exact:true}).selectOption('all')
  await page.getByLabel('搜索模板标题或提示词…',{exact:true}).fill('护肤')
  await page.waitForTimeout(100)
  assert.equal(await drawer.locator('button[class*="_card"]').count(),5,'cross-source search includes five libraries')
  await page.getByLabel('搜索模板标题或提示词…',{exact:true}).fill('no-such-case')
  await page.getByText('没有匹配的模板',{exact:false}).waitFor()
  await page.getByLabel('搜索模板标题或提示词…',{exact:true}).fill('')
  await page.getByRole('tab',{name:/精选案例库/}).click()
  // Favorite without opening details, then inspect the independent view.
  const card=page.getByRole('button',{name:/极简护肤 · 产品主视觉/}); await card.hover()
  await card.getByRole('button',{name:'收藏此模板',exact:true}).click()
  await page.getByRole('tab',{name:/★ 收藏/}).click()
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).waitFor()
  await page.getByRole('tab',{name:'全部模板',exact:true}).click()
  await page.evaluate(()=>document.documentElement.setAttribute('data-dark',''))
  await shot('template-drawer-dark.png')
  await page.keyboard.press('Escape')
  await page.evaluate(()=>document.documentElement.removeAttribute('data-dark'))
  // Width preference does not constrain mobile: the drawer fills the viewport.
  await page.setViewportSize({width:390,height:844}); await trigger.click()
  assert.equal((await shell.boundingBox()).width,390)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,'mobile has no horizontal overflow')
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).waitFor()
  await shot('template-drawer-mobile.png')
  await page.getByRole('button',{name:/极简护肤 · 产品主视觉/}).click()
  const detail=page.locator('[data-template-detail]'); const d=await detail.boundingBox(); assert.ok(d.x>=0 && d.x+d.width<=390)
  await page.getByRole('button',{name:'追加到提示词',exact:true}).click(); await drawer.waitFor({state:'detached'})
  // A failed source keeps other sources usable and offers a retry.
  await page.setViewportSize({width:1440,height:1000}); await page.goto(`${url}/?fail=canghe`)
  await trigger.click(); await page.getByRole('tab',{name:/沧河案例库/}).click(); await page.getByRole('alert').waitFor()
  await page.getByRole('button',{name:'重试',exact:true}).click(); await page.getByRole('button',{name:/沧河案例库 · 极简护肤/}).waitFor()
  assert.deepEqual(errors,[],'browser reports no runtime errors')
  console.log('PASS template drawer browser: width, resize persistence, fullscreen, details, append, recents, search, favorites, focus, mobile, retry; 5 review screenshots')
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)) }

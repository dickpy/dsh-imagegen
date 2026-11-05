/** Chromium checks of the actual reference uploader and its async state hook.
 * Build: pnpm exec tsdown --config scripts/references-preview.config.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require=createRequire(import.meta.url)
const runtime=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/.reference-test.cjs`):require
const {chromium}=runtime('playwright'),sharp=runtime('sharp')
const samples=await Promise.all([0,1,2].map(async i=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${['#e9e7df','#d5be98','#bcad96'][i]}"/><stop offset="1" stop-color="#fbf8ef"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/>${i===0?'<ellipse cx="400" cy="480" rx="145" ry="22" fill="#414138" opacity=".1"/><rect x="295" y="170" width="210" height="310" rx="36" fill="#f6f5ed"/><rect x="315" y="115" width="170" height="80" rx="12" fill="#4f5c50"/><text x="400" y="332" text-anchor="middle" font-family="serif" font-size="46" fill="#566151">pure.</text>':i===1?'<path d="M0 0h800v100L0 600z" fill="#fff" opacity=".25"/><path d="M160 0h80v600h-80zM490 0h55v600h-55z" fill="#8a785d" opacity=".13"/>':'<rect x="45" y="45" width="710" height="320" rx="6" fill="#ece6d9"/><path d="M400 45v320M45 205h710" stroke="#988773" stroke-width="12"/><path d="M0 390h800v210H0z" fill="#bda17f"/><ellipse cx="610" cy="490" rx="76" ry="25" fill="#69553f" opacity=".3"/><path d="M550 400h120l-14 80h-92z" fill="#efeadd"/>'}</svg>`)).png().toBuffer()))
const submissions=[]
const css=`${process.env.REFERENCES_PREVIEW_FONT?'@font-face{font-family:PreviewCJK;src:url(/font)}':''}
:root{--dsw-font-family:PreviewCJK,system-ui,sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f7f8;--dsw-alias-bg-layer-2:#efeff1;--dsw-alias-bg-mask-1:#11111170;--dsw-alias-border-l1:#e4e4e7;--dsw-alias-border-l2:#ceced3;--dsw-alias-label-primary:#28282b;--dsw-alias-label-secondary:#68686e;--dsw-alias-label-tertiary:#909098;--dsw-alias-brand-primary:#303034;--dsw-alias-interactive-bg-hover:#f0f0f2}
:root[data-dark]{--dsw-alias-bg-base:#222225;--dsw-alias-bg-layer-1:#2c2c30;--dsw-alias-bg-mask-1:#0009;--dsw-alias-border-l1:#414148;--dsw-alias-border-l2:#5a5a63;--dsw-alias-label-primary:#ededf1;--dsw-alias-label-secondary:#b9b9c2;--dsw-alias-label-tertiary:#9999a3;--dsw-alias-brand-primary:#e4e4eb;--dsw-alias-interactive-bg-hover:#34343b}
*{box-sizing:border-box}body{margin:0;font:13px var(--dsw-font-family);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}button,select,textarea{font-family:inherit}.fixture-header{height:68px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:36px;padding:0 28px}.fixture-header strong{margin-right:40px}.fixture-header span{font-size:12px;color:var(--dsw-alias-label-secondary)}.fixture-header span:first-of-type{color:var(--dsw-alias-label-primary);border-bottom:2px solid currentColor;padding:24px 0}.fixture-workspace{display:flex;min-height:calc(100dvh - 68px)}.fixture-config{width:340px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);padding:16px 12px}.fixture-modes{display:flex;justify-content:space-around;padding:0 0 14px;color:var(--dsw-alias-label-secondary)}.fixture-modes strong{color:var(--dsw-alias-label-primary);border-bottom:2px solid currentColor;padding-bottom:7px}.fixture-config>select{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base);color:inherit;margin-bottom:12px}.fixture-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;margin-bottom:12px}.fixture-card>strong{font-size:12px}.fixture-card textarea{margin-top:10px;padding:10px;width:100%;height:140px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:12px;line-height:1.7;resize:vertical}.fixture-card small{color:var(--dsw-alias-label-tertiary);font-size:11px}.fixture-ratios{display:flex;gap:10px;margin-top:12px}.fixture-ratios>*{flex:1;text-align:center;background:var(--dsw-alias-bg-layer-1);padding:7px;border-radius:7px}.fixture-ratios strong{background:#34343a;color:white}.fixture-card>p{font-size:12px;margin:18px 0 0}.fixture-generate{width:100%;border:0;border-radius:10px;padding:13px;background:#303034;color:white}.fixture-generate:disabled{opacity:.4}.fixture-reset{display:block;margin:12px auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}.fixture-error{font-size:11px;color:#a84436;line-height:1.6}.fixture-stage{position:relative;flex:1;text-align:center;padding:125px 40px 60px}.fixture-stage>span{font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:2px}.fixture-stage h1{font-size:26px;font-weight:500;margin:18px 0;color:var(--dsw-alias-label-primary)}.fixture-stage p,.fixture-stage small{color:var(--dsw-alias-label-tertiary);font-size:12px}.fixture-examples{display:flex;gap:14px;margin:40px auto 22px;max-width:750px}.fixture-examples img{width:calc((100% - 28px)/3);border-radius:14px;border:1px solid var(--dsw-alias-border-l1)}.fixture-template{position:absolute;right:28px;bottom:80px;padding:11px 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:30px;background:var(--dsw-alias-bg-base);color:inherit;box-shadow:0 4px 15px #0001}@media(max-width:700px){.fixture-header{height:58px;padding:0 16px}.fixture-header span{display:none}.fixture-workspace{min-height:calc(100dvh - 58px)}.fixture-config{width:100%;border:0}.fixture-stage{display:none}}
`
const server=createServer(async(req,res)=>{
 if(req.url==='/preview.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(new URL('../.references-preview/preview.js',import.meta.url)));return}
 if(req.url==='/font'&&process.env.REFERENCES_PREVIEW_FONT){res.end(readFileSync(process.env.REFERENCES_PREVIEW_FONT));return}
 if(req.url?.startsWith('/sample/')){res.setHeader('content-type','image/png');res.end(samples[Number(req.url.split('/').pop().split('.')[0])]);return}
 if(req.url==='/submit'){const chunks=[];for await(const chunk of req)chunks.push(chunk);submissions.push(JSON.parse(Buffer.concat(chunks).toString()));res.end('{}');return}
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/preview.js"></script></html>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try{
 browser=await chromium.launch({headless:true,...process.env.REFERENCES_CHROMIUM_PATH?{executablePath:process.env.REFERENCES_CHROMIUM_PATH,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']}:{} })
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const url=`http://127.0.0.1:${server.address().port}`
 await page.goto(url);await page.evaluate(()=>document.fonts.ready)
 assert.equal(await page.evaluate(()=>window.checkPolicies()),true,'adapter policy follows actual alias/protocol/subscription routing')
 const upload=page.locator('[data-edit-references] input[type=file]'),thumbs=page.locator('[data-edit-reference]'),generate=page.getByRole('button',{name:'开始生成',exact:true}),clear=page.getByRole('button',{name:'清空',exact:true})
 const file=(i,name=`ref-${i+1}.png`)=>({name,mimeType:'image/png',buffer:samples[i%3]})
 const count=async n=>{await page.waitForFunction(expected=>document.querySelectorAll('[data-edit-reference]').length===expected,n)}
 await upload.setInputFiles([file(0),file(1),file(2)]);await count(3)
 assert.deepEqual(await thumbs.locator('img').evaluateAll(images=>images.map(image=>image.alt)),['ref-1.png','ref-2.png','ref-3.png'])
 const b=await thumbs.first().boundingBox();assert.equal(b.width,64);assert.equal(b.height,64)
 const images=process.env.REFERENCES_SCREENSHOT_DIR?pathToFileURL(`${process.env.REFERENCES_SCREENSHOT_DIR}/`):new URL('../docs/images/',import.meta.url);mkdirSync(images,{recursive:true})
 const shot=async name=>{await page.screenshot({path:new URL(name,images).pathname})}
 await shot('multi-reference-desktop.png')
 await page.getByRole('button',{name:'预览图1：ref-1.png',exact:true}).click()
 const preview=page.getByRole('dialog',{name:'参考图片预览',exact:true});await preview.waitFor()
 await page.keyboard.press('ArrowRight');assert.equal(await preview.locator('img').getAttribute('alt'),'ref-2.png')
 await page.keyboard.press('ArrowLeft');assert.equal(await preview.locator('img').getAttribute('alt'),'ref-1.png')
 await shot('multi-reference-preview.png');await page.keyboard.press('Escape');await preview.waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:'预览图1：ref-1.png',exact:true}).evaluate(button=>button===document.activeElement),true,'closing restores thumbnail focus')
 await generate.click();await page.getByText('已提交',{exact:true}).waitFor()
 assert.equal(submissions.at(-1).image,`data:image/png;base64,${samples[0].toString('base64')}`)
 assert.deepEqual(submissions.at(-1).images,samples.slice(1).map(image=>`data:image/png;base64,${image.toString('base64')}`))
 await page.getByRole('button',{name:'删除图2：ref-2.png',exact:true}).click();await count(2)
 assert.equal(await page.getByRole('button',{name:'预览图2：ref-3.png',exact:true}).count(),1,'indices follow deletion')
 await page.getByLabel('模型',{exact:true}).selectOption('grok-imagine-image');assert.equal(await generate.isDisabled(),true)
 await page.getByText('当前选中的模型适配最多支持 1 张参考图，请切换模型或移除多余图片。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'删除图2：ref-3.png',exact:true}).click();await count(1);assert.equal(await generate.isEnabled(),true)
 await generate.click();await page.waitForTimeout(50);assert.equal(submissions.at(-1).images,undefined,'one reference uses legacy shape')
 await page.getByLabel('模型',{exact:true}).selectOption('gpt-image-2')
 // Drop on the whole reference card; clipboard images also append from prompt.
 await page.evaluate(async()=>{
   const blob=await(await fetch('/sample/1.png')).blob(),dt=new DataTransfer();dt.items.add(new File([blob],'dropped.png',{type:'image/png'}))
   const card=document.querySelector('[data-edit-references]'),fire=(target,type)=>target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}))
   fire(document.body,'dragenter');fire(card,'dragenter');fire(card.querySelector('button'),'dragenter');fire(card,'dragover');fire(card,'drop')
 });await count(2)
 assert.deepEqual(await page.evaluate(()=>({active:window.hostDrop.active,depth:window.hostDrop.depth,attachments:window.hostDrop.attachments.length})),{active:false,depth:0,attachments:0},'external nested drop closes the host overlay without attaching to chat')
 await page.evaluate(async()=>{const blob=await(await fetch('/sample/2.png')).blob(),dt=new DataTransfer();dt.items.add(new File([blob],'pasted.png',{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))});await count(3)
 assert.equal(await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','keep ordinary text paste');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});document.querySelector('textarea').dispatchEvent(event);return event.defaultPrevented}),false,'ordinary text paste remains native')
 // Exercise the browser clipboard API itself, not a mocked navigator object.
 await page.context().grantPermissions(['clipboard-read','clipboard-write'])
 await page.evaluate(async()=>{const blob=await(await fetch('/sample/0.png')).blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})])})
 await page.getByRole('button',{name:'粘贴图片',exact:true}).click();await count(4)
 assert.equal(await thumbs.last().locator('img').getAttribute('alt'),'clipboard-1.png')
 await page.getByRole('button',{name:'删除图4：clipboard-1.png',exact:true}).click();await count(3)
 await page.evaluate(()=>document.documentElement.setAttribute('data-dark',''));await shot('multi-reference-dark.png');await page.evaluate(()=>document.documentElement.removeAttribute('data-dark'))
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);await shot('multi-reference-mobile.png')
 await page.getByRole('button',{name:'预览图1：ref-1.png',exact:true}).click();const p=await preview.boundingBox();assert.ok(p.x>=0&&p.x+p.width<=390);await page.keyboard.press('Escape')
 await page.setViewportSize({width:1440,height:960});await clear.click();await count(0)
 // Complete the second read first; selection order must still win. Reset
 // while a read is pending and require the old result to stay discarded.
 await page.evaluate(()=>{const Native=window.FileReader;window.FileReader=class extends Native{readAsDataURL(file){if(file.name==='failed.png'){setTimeout(()=>this.dispatchEvent(new ProgressEvent('error')),20);return}const loaded=this.onload;this.onload=event=>setTimeout(()=>loaded?.call(this,event),file.name.startsWith('slow')?160:0);super.readAsDataURL(file)}}})
 await upload.setInputFiles([file(0,'slow.png'),file(1,'fast.png')]);await count(2)
 assert.deepEqual(await thumbs.locator('img').evaluateAll(images=>images.map(image=>image.alt)),['slow.png','fast.png'])
 await clear.click();await upload.setInputFiles(file(0,'slow-cleared.png'));await page.getByText('正在读取参考图片…',{exact:true}).waitFor();await clear.click();await upload.setInputFiles(file(1,'new-after-clear.png'));await count(1);await page.waitForTimeout(220)
 assert.deepEqual(await thumbs.locator('img').evaluateAll(images=>images.map(image=>image.alt)),['new-after-clear.png'],'clear invalidates old reads without discarding new uploads')
 await clear.click();await upload.setInputFiles([file(0,'slow-batch.png')]);await upload.setInputFiles([file(1,'next-batch.png')]);await count(2)
 assert.deepEqual(await thumbs.locator('img').evaluateAll(images=>images.map(image=>image.alt)),['slow-batch.png','next-batch.png'],'separate upload batches preserve order')
 await clear.click();await upload.setInputFiles([file(0,'failed.png'),file(1,'survives.png')]);await count(1);await page.getByRole('alert').filter({hasText:'部分图片读取失败'}).waitFor();assert.equal(await thumbs.locator('img').getAttribute('alt'),'survives.png','one failed read does not discard other images')
 await clear.click();await upload.setInputFiles(Array.from({length:6},(_,i)=>file(i,`limit-${i}.png`)));await count(5);await page.getByRole('alert').filter({hasText:'最多添加 5 张'}).waitFor()
 await clear.click();await upload.setInputFiles([{name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('bad')},{name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(11*1024*1024)},file(0)]);await count(1);await page.getByRole('alert').filter({hasText:'部分图片未添加'}).waitFor()
 await clear.click();await upload.setInputFiles([0,1].map(i=>({name:`large-${i}.png`,mimeType:'image/png',buffer:Buffer.concat([samples[i],Buffer.alloc(9*1024*1024-samples[i].length)])})));await count(1);await page.getByRole('alert').filter({hasText:'合计大小不能超过16MB'}).waitFor()
 await page.getByRole('button',{name:'新建创作',exact:true}).click();await count(0);assert.equal(await generate.isDisabled(),true)
 assert.deepEqual(errors,[],'no browser runtime errors')
 console.log('PASS multi-reference browser: thumbnails, append, ordered async reads/batches, cancel on clear, preview/focus/keyboard, delete/renumber, external host drag lifecycle, real clipboard API paste, model guard, file/count/total limits, mobile/dark, request fields; 4 screenshots')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}

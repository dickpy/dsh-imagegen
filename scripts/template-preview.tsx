/** Real drawer component in a local, deterministic host/API fixture. No generation calls. */
import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { TemplateLibrary, TemplateLibraryButton } from '../src/client/TemplateLibrary.tsx'
import { mergeTemplatePrompt } from '../src/client/template-library-state.ts'
import { TEMPLATE_SOURCES, type TemplateCase, type TemplateFavorite } from '../src/protocol.ts'
import type { ImageGenApi } from '../src/client/api.ts'

const titles = ['极简护肤 · 产品主视觉', '夏日新品 · 清爽海报', '咖啡日常 · 品牌故事', '城市漫游 · 杂志封面', '科技产品 · 发布主图', '自然生活 · 有机质感', '几何构成 · 艺术排版', '手作温度 · 包装设计', '时尚配饰 · 光影实验', '居家日常 · 生活方式', '节日限定 · 礼盒展示', '品牌字标 · 视觉探索']
let favorites: TemplateFavorite[] = []
const calls = new Map<string, number>()
const api = {
  templatesList: async (sourceId: string) => {
    calls.set(sourceId, (calls.get(sourceId) ?? 0) + 1)
    await new Promise(resolve => setTimeout(resolve, 40))
    if (new URLSearchParams(location.search).get('fail') === sourceId && calls.get(sourceId) === 1) throw new Error('Fixture source unavailable')
    return { sourceId, cases: titles.map((title, i): TemplateCase => ({ id: String(i), title: sourceId === 'vibeui' ? title : `${TEMPLATE_SOURCES.find(source => source.id === sourceId)!.label} · ${title}`, prompt: `Create a premium editorial product composition. ${title}.\nSoft studio lighting, balanced negative space, refined typography. Keep the product shape and packaging faithful to the reference.`, category: ['product', 'poster', 'brand'][i % 3], categoryZh: ['产品与电商', '海报与排版', '品牌与设计'][i % 3], image: `${i}.svg`, sourceLabel: TEMPLATE_SOURCES.find(source => source.id === sourceId)!.label, sourceUrl: '', githubUrl: '', styles: [], scenes: [], featured: i === 0 })), total: titles.length, origin: 'bundled', repository: 'local-fixture', fetchedAt: '' }
  },
  favoritesList: async () => favorites,
  favoritesAdd: async (sourceId: string, item: TemplateCase) => { const key = `${sourceId}:${item.id}`; favorites = [...favorites.filter(entry => entry.key !== key), { key, sourceId, case: item, savedAt: new Date().toISOString() }]; return favorites },
  favoritesRemove: async (key: string) => { favorites = favorites.filter(entry => entry.key !== key); return favorites },
  templatesRefresh: async () => ({ total: 12 }),
} as unknown as ImageGenApi
function Fixture() {
  const anchor = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('为新品设计一张简洁的产品海报，保留包装文字。')
  const [mode, setMode] = useState('normal')
  return <>
    <header className="fixture-header"><strong>DSH Image Studio</strong><span>模板库 · 审核预览</span><select aria-label="预览模式" value={mode} onChange={event => { setMode(event.target.value); setOpen(false) }}><option value="normal">普通生图</option><option value="edit">图生图</option><option value="ecommerce">电商模式</option><option value="canvas">无限画布</option></select></header>
    <main ref={anchor} className="fixture-workspace">
      <aside className="fixture-config"><h3>创作设置</h3><small>提示词</small><textarea aria-label="当前提示词" value={prompt} onChange={event => setPrompt(event.target.value)} /><small>模型</small><div className="fixture-control">GPT Image 2</div><small>画面比例</small><div className="fixture-control">1 : 1</div><button className="fixture-generate">生成图片</button></aside>
      <section className="fixture-stage"><span className="fixture-kicker">从一个想法开始</span><h1>把灵感变成画面</h1><p>在模板库中发现适合你的创作起点</p><div className="fixture-empty">＋</div></section>
      <TemplateLibraryButton expanded={open} onClick={() => setOpen(true)} />
    </main>
    {open ? <TemplateLibrary api={api} anchor={anchor.current} hasExistingPrompt={mode !== 'canvas' && prompt.trim() !== ''} appendOnly={mode === 'ecommerce'} onClose={() => setOpen(false)} onUse={(text, applyMode) => setPrompt(current => mergeTemplatePrompt(current, text, applyMode))} /> : null}
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

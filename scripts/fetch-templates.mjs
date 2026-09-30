/**
 * Build bundled prompt-template snapshots.
 *
 * Usage:
 *   node scripts/fetch-templates.mjs                 # refresh every source
 *   node scripts/fetch-templates.mjs handraw         # one named source
 *   node scripts/fetch-templates.mjs <url> <file>    # ad-hoc vibeui/canghe JSON
 *
 * The three community libraries that do not publish one aggregate JSON file
 * are assembled from pinned upstream commits here. Their runtime sources are
 * deliberately non-refreshable; updating them is a plugin-release step.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FETCH_TIMEOUT_MS = 60_000

const HANDRAW_COMMIT = '3737026e2e829540faf5c0627f37251be02b092d'
const PROMPT_SIGNAL_COMMIT = 'ab00db4e4301f172e16ff178691e41d941fa1acc'
const EVOLINK_COMMIT = 'e2a269ad1a055a0b4f6c1e170341c6c1aba30faa'

const CATEGORY_ZH = {
  'Architecture & Spaces': '建筑与空间',
  'Brand & Logos': '品牌与标志',
  'Characters & People': '人物与角色',
  'Charts & Infographics': '图表与信息可视化',
  'Documents & Publishing': '文档与出版物',
  'History & Classical Themes': '历史与古风题材',
  'Illustration & Art': '插画与艺术',
  'Other Use Cases': '其他应用场景',
  'Photography & Realism': '摄影与写实',
  'Posters & Typography': '海报与排版',
  'Products & E-commerce': '商品与电商',
  'Scenes & Storytelling': '场景与叙事',
  'UI & Interfaces': 'UI 与界面',
  'Portraits & Fashion': '人像与时尚',
  'Celebrities & Sports': '名人与运动',
  'Characters & IP': '角色与 IP',
  'Food & Beverage': '美食与饮品',
  'Brand & Icons': '品牌与图标',
  'Social Media & Stickers': '社媒与表情包',
  'Infographics & Diagrams': '信息图与图解',
  'UI & App Screens': 'UI 与应用界面',
  'Architecture & Interiors': '建筑与室内',
  'Cinematic & Storytelling': '影视与叙事',
  'Illustration & Comics': '插画与漫画',
  'Historical & Fantasy': '历史与幻想',
  'Animals & Nature': '动物与自然',
  'Other Creative Uses': '其他创意用途',
}

const PROMPT_SIGNAL_CATEGORY_ZH = {
  photography: '摄影写实',
  product: '商业产品',
  poster: '海报字体',
  illustration: '插画艺术',
  technical: '图表信息图',
  ui: 'UI 界面',
  characters: '角色人物',
  anime: '动漫',
  isometric: '等距模型',
  brand: '品牌 Logo',
  scenes: '场景叙事',
  architecture: '建筑空间',
  documents: '文档出版',
  history: '历史古典',
  other: '其他玩法',
}

const EVOLINK_CATEGORIES = {
  'ad-creative': { key: 'Ad Creative', zh: '广告创意', file: 'ad-creative.md' },
  character: { key: 'Character Design', zh: '角色设计', file: 'character.md' },
  comparison: { key: 'Comparison & Community', zh: '对比与社区案例', file: 'comparison.md' },
  ecommerce: { key: 'E-commerce', zh: '电商与产品', file: 'ecommerce.md' },
  portrait: { key: 'Portrait & Photography', zh: '人像与摄影', file: 'portrait.md' },
  poster: { key: 'Poster & Illustration', zh: '海报与插画', file: 'poster.md' },
  ui: { key: 'UI & Social Media', zh: 'UI 与社媒', file: 'ui.md' },
}

function imageFileOf(path) {
  const value = String(path ?? '').replace(/^\/+/, '')
  const name = value.split('/').pop() ?? ''
  return /^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(name) ? name : ''
}

function normalizeHttpUrl(value) {
  const raw = String(value ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function makeSnapshot(repository, cases, sourceUrl) {
  return {
    repository,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    totalCases: cases.length,
    categories: [...new Set(cases.map(item => item.category).filter(Boolean))],
    cases,
  }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status} ${url}`)
  return response.text()
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url))
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length)
  let index = 0
  const worker = async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await mapper(items[current], current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function fetchLegacyList(name, url, out) {
  const payload = await fetchJson(url)
  const rawCases = Array.isArray(payload.cases) ? payload.cases : []
  if (rawCases.length === 0) throw new Error(`no cases in the source payload: ${url}`)
  const cases = []
  for (const raw of rawCases) {
    if (raw === null || typeof raw !== 'object') continue
    const id = Number(raw.id)
    const title = String(raw.title ?? '').trim()
    const prompt = String(raw.prompt ?? '').trim()
    const image = imageFileOf(raw.image)
    if (!Number.isInteger(id) || title === '' || prompt === '') continue
    const category = String(raw.category ?? '')
    cases.push({
      id: String(id),
      title,
      prompt,
      category,
      categoryZh: CATEGORY_ZH[category] ?? category,
      styles: Array.isArray(raw.styles) ? raw.styles.map(String) : [],
      scenes: Array.isArray(raw.scenes) ? raw.scenes.map(String) : [],
      sourceLabel: String(raw.sourceLabel ?? ''),
      sourceUrl: String(raw.sourceUrl ?? ''),
      githubUrl: String(raw.githubUrl ?? ''),
      image,
      featured: raw.featured === true,
    })
  }
  cases.sort((a, b) => Number(b.id) - Number(a.id))
  const snapshot = makeSnapshot(String(payload.repository ?? 'freestylefly/awesome-gpt-image-2'), cases, url)
  await writeSnapshot(name, out, snapshot)
}

function handrawStyleImage(number) {
  const n = Number.parseInt(String(number), 10)
  const band = n <= 200 ? '001-200' : '201-400'
  return `https://cdn.jsdelivr.net/gh/yang0/handraw-style@${HANDRAW_COMMIT}/images/individual/${band}/${String(n).padStart(3, '0')}.webp`
}

async function buildHandraw() {
  const base = `https://raw.githubusercontent.com/yang0/handraw-style/${HANDRAW_COMMIT}`
  const refs = `${base}/skills/handdraw-style-prompter/references`
  const [styles, layouts, colors] = await Promise.all([
    fetchJson(`${refs}/styles.json`),
    fetchJson(`${refs}/layouts.json`),
    fetchJson(`${refs}/colors.json`),
  ])
  if (!Array.isArray(styles) || !Array.isArray(layouts) || !Array.isArray(colors)) {
    throw new Error('handraw-style references are not arrays')
  }
  const layoutPrompts = new Map(await mapConcurrent(layouts, 12, async (layout) => {
    const id = String(layout.id)
    return [id, await fetchText(`${refs}/layouts/${id}.md`)]
  }))
  const layoutCategoryZh = { 'social-card': '社媒卡', infographic: '信息图', 'comic-storyboard': '漫画分镜' }
  const cases = []

  for (const style of styles) {
    const number = String(style.number)
    const category = `风格 · ${String(style.group).split('·').slice(1).join('·').trim() || String(style.group)}`
    cases.push({
      id: `s-${number.padStart(3, '0')}`,
      title: `#${number.padStart(3, '0')} ${String(style.generation_name)}`,
      image: handrawStyleImage(number),
      sourceLabel: String(style.reference ?? ''),
      sourceUrl: 'https://github.com/yang0/handraw-style',
      githubUrl: 'https://github.com/yang0/handraw-style',
      prompt: [
        `手绘风格 #${number.padStart(3, '0')} · ${String(style.generation_name)}（原参考：${String(style.reference)}）。`,
        `核心风格特征：${String(style.traits)}`,
        '使用：把"主题：……"替换为你的主题；纯图模式直接生图，图文模式可让文字参与构图；可再叠加排版图型编号与主题色编号。',
      ].join('\n'),
      category,
      categoryZh: category,
      styles: [String(style.group).split('·').slice(1).join('·').trim() || String(style.group)],
      scenes: [],
      featured: false,
    })
  }

  for (const layout of layouts) {
    const id = String(layout.id)
    const categoryZh = layoutCategoryZh[layout.category] ?? String(layout.category)
    const category = `排版 · ${categoryZh}`
    const md = layoutPrompts.get(id) ?? ''
    const zh = (md.match(/<!-- zh -->\s*([\s\S]*?)(?:\n<!-- en -->|$)/) ?? [])[1]?.trim() ?? ''
    const en = (md.match(/<!-- en -->\s*([\s\S]*)$/) ?? [])[1]?.trim() ?? ''
    cases.push({
      id: `l-${id.toLowerCase()}`,
      title: `${id} ${String(layout.name)}`,
      image: `https://cdn.jsdelivr.net/gh/yang0/handraw-style@${HANDRAW_COMMIT}/images/layouts/${String(layout.category)}s/${id}.webp`,
      sourceLabel: '',
      sourceUrl: 'https://github.com/yang0/handraw-style',
      githubUrl: 'https://github.com/yang0/handraw-style',
      prompt: [zh, en].filter(Boolean).join('\n\n') || `排版图型 ${id} ${String(layout.name)}`,
      category,
      categoryZh,
      styles: [String(layout.name)],
      scenes: Array.isArray(layout.keywords) ? layout.keywords.slice(0, 5).map(String) : [],
      featured: false,
    })
  }

  for (const color of colors) {
    const id = String(color.id)
    const category = `单色 · ${String(color.category_zh)}`
    cases.push({
      id: `c-${id.toLowerCase()}`,
      title: `${id} ${String(color.name_zh)}`,
      image: `https://cdn.jsdelivr.net/gh/yang0/handraw-style@${HANDRAW_COMMIT}/images/colors/${id}.webp`,
      sourceLabel: '',
      sourceUrl: 'https://github.com/yang0/handraw-style',
      githubUrl: 'https://github.com/yang0/handraw-style',
      prompt: `主题色 ${id} · ${String(color.name_zh)}（${String(color.name_en)}）——${String(color.quote_zh)}。\n${String(color.prompt_zh)}\n${String(color.prompt_en)}\n约束：主题色仅用于画面配色，禁止把色名、色号或色值渲染成图内文字。`,
      category,
      categoryZh: category,
      styles: [String(color.name_zh)],
      scenes: [],
      featured: false,
    })
  }

  return makeSnapshot('https://github.com/yang0/handraw-style', cases, `https://github.com/yang0/handraw-style/tree/${HANDRAW_COMMIT}`)
}

function promptSignalImage(value) {
  const raw = String(value ?? '').trim()
  if (/^https?:\/\//i.test(raw)) return normalizeHttpUrl(raw)
  if (raw.startsWith('/images/')) {
    return `https://raw.githubusercontent.com/andy7076/image_prompt/${PROMPT_SIGNAL_COMMIT}/public${raw}`
  }
  return ''
}

async function buildPromptSignal() {
  const base = `https://raw.githubusercontent.com/andy7076/image_prompt/${PROMPT_SIGNAL_COMMIT}/src`
  const files = [
    'cases.generated.json',
    'zhidawang.generated.json',
    'x.hot.generated.json',
    'x.sairah.generated.json',
    'x.naiknelofar.generated.json',
    'x.hann7712.generated.json',
  ]
  const dataCode = (await fetchText(`${base}/data.js`)).replaceAll('import.meta.env.BASE_URL', "'/'")
  const tempModule = resolve(tmpdir(), `dsh-imagegen-prompt-signal-${process.pid}-${Date.now()}.mjs`)
  await writeFile(tempModule, dataCode, 'utf8')
  let featuredPrompts = []
  try {
    const module = await import(pathToFileURL(tempModule).href)
    featuredPrompts = Array.isArray(module.featuredPrompts) ? module.featuredPrompts : []
  } finally {
    await rm(tempModule, { force: true })
  }
  const lists = await Promise.all(files.map(file => fetchJson(`${base}/${file}`)))
  const all = [...featuredPrompts, ...lists.flat()]
  const cases = []
  const seen = new Set()
  for (const item of all) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id ?? '').trim()
    const title = String(item.title ?? '').trim()
    const prompt = String(item.prompt ?? '').trim()
    if (id === '' || title === '' || prompt === '' || seen.has(id)) continue
    seen.add(id)
    const category = String(item.category ?? 'other')
    const sources = Array.isArray(item.sources) ? item.sources : []
    const githubUrl = sources.find(source => typeof source?.url === 'string' && /github\.com/i.test(source.url))?.url
    cases.push({
      id,
      title,
      prompt,
      category,
      categoryZh: PROMPT_SIGNAL_CATEGORY_ZH[category] ?? category,
      styles: Array.isArray(item.tags) ? item.tags.map(String) : [],
      scenes: [],
      sourceLabel: String(item.author ?? item.sourceLabel ?? ''),
      sourceUrl: normalizeHttpUrl(item.source ?? sources[0]?.url),
      githubUrl: normalizeHttpUrl(githubUrl),
      image: promptSignalImage(item.image ?? item.images?.[0]?.url),
      featured: item.featured === true,
    })
  }
  return makeSnapshot('https://github.com/andy7076/image_prompt', cases, `https://github.com/andy7076/image_prompt/tree/${PROMPT_SIGNAL_COMMIT}`)
}

function evolinkImage(value) {
  let raw = String(value ?? '').trim().replaceAll('&amp;', '&')
  if (raw === '') return ''
  if (raw.startsWith('../')) raw = `/${raw.replace(/^\.\.\/+/, '')}`
  if (raw.startsWith('/')) {
    return `https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/${EVOLINK_COMMIT}${raw}`
  }
  const oldPrefix = /^https:\/\/raw\.githubusercontent\.com\/EvoLinkAI\/awesome-gpt-image-2-API-and-Prompts\/[^/]+/i
  if (oldPrefix.test(raw)) raw = raw.replace(oldPrefix, `https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/${EVOLINK_COMMIT}`)
  return normalizeHttpUrl(raw)
}

async function buildEvolink() {
  const base = `https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/${EVOLINK_COMMIT}`
  const files = [
    ...Object.entries(EVOLINK_CATEGORIES).map(([slug, meta]) => ({ ...meta, slug, path: `cases/${meta.file}` })),
    { key: 'Featured', zh: '精选案例', slug: 'featured', path: 'README.md' },
  ]
  const parsed = []
  for (const meta of files) {
    const markdown = await fetchText(`${base}/${meta.path}`)
    const heading = /^### Case (\d+): (?:(?:\[([^\]]+)\]\(([^)]+)\))|(.+?))\s*$/gm
    const matches = [...markdown.matchAll(heading)]
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]
      const section = markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length)
      const number = Number(match[1])
      const rawTitle = String(match[2] ?? match[4] ?? '').trim()
      const inlineTitle = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rawTitle)
      const title = inlineTitle?.[1]?.trim() ?? rawTitle
      const sourceMatch = /\*\*Source\*\*:\s*\[([^\]]+)\]\(([^)]+)\)/i.exec(section)
      const sourceUrl = normalizeHttpUrl(match[3] ?? inlineTitle?.[2] ?? sourceMatch?.[2])
      const authorMatch = /\(by \[@([^\]]+)\]/i.exec(section) ?? /\*\*Source\*\*:\s*\[@([^\]]+)\]/i.exec(section)
      const author = String(authorMatch?.[1] ?? '').trim()
      const imageMatch = /<img\s+src="([^"]+)"/i.exec(section) ?? /!\[[^\]]*\]\(([^)]+)\)/.exec(section)
      const promptMatch = /\*\*Prompt(?:\*\*:|:\*\*)\s*```[^\n]*\n([\s\S]*?)\n```/i.exec(section)
      const prompt = promptMatch?.[1]?.trim() ?? ''
      if (!Number.isInteger(number) || title === '' || prompt === '') continue
      parsed.push({
        id: `case-${number}`,
        number,
        title,
        prompt,
        category: meta.key,
        categoryZh: meta.zh,
        styles: [],
        scenes: [],
        sourceLabel: author === '' ? '' : `@${author}`,
        sourceUrl,
        githubUrl: 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts',
        image: evolinkImage(imageMatch?.[1]),
        featured: false,
      })
    }
  }

  const byId = new Map()
  for (const item of parsed) {
    const current = byId.get(item.id)
    if (current === undefined) {
      byId.set(item.id, item)
    } else if (item.prompt.length > current.prompt.length) {
      byId.set(item.id, { ...item, image: item.image || current.image, sourceUrl: item.sourceUrl || current.sourceUrl })
    } else if (item.image !== '' && current.image === '') {
      byId.set(item.id, { ...current, image: item.image, sourceUrl: current.sourceUrl || item.sourceUrl })
    }
  }
  const cases = [...byId.values()]
    .sort((a, b) => a.number - b.number)
    .map(({ number: _number, ...item }) => item)
  return makeSnapshot('https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts', cases, `https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts/tree/${EVOLINK_COMMIT}`)
}

async function writeSnapshot(name, out, snapshot) {
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`[${name}] wrote ${snapshot.cases.length} cases -> ${out}`)
}

const SOURCES = {
  vibeui: {
    build: () => fetchJson('https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json'),
    out: resolve(ROOT, 'src/templates/cases.json'),
    legacy: true,
  },
  canghe: {
    build: () => fetchJson('https://gpt-image2.canghe.ai/cases.json'),
    out: resolve(ROOT, 'src/templates/canghe-cases.json'),
    legacy: true,
  },
  handraw: { build: buildHandraw, out: resolve(ROOT, 'src/templates/handraw-cases.json') },
  'prompt-signal': { build: buildPromptSignal, out: resolve(ROOT, 'src/templates/prompt-signal-cases.json') },
  evolink: { build: buildEvolink, out: resolve(ROOT, 'src/templates/evolink-cases.json') },
}

const [argOne, argTwo] = process.argv.slice(2)
if (argOne !== undefined && argTwo !== undefined) {
  await fetchLegacyList('adhoc', argOne, resolve(argTwo))
} else {
  const targets = argOne !== undefined && argOne in SOURCES
    ? [argOne]
    : argOne !== undefined
      ? (() => { throw new Error(`unknown source: ${argOne} (expected ${Object.keys(SOURCES).join(' | ')})`) })()
      : Object.keys(SOURCES)
  for (const name of targets) {
    const source = SOURCES[name]
    if (source.legacy) {
      const url = name === 'vibeui'
        ? 'https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json'
        : 'https://gpt-image2.canghe.ai/cases.json'
      await fetchLegacyList(name, url, source.out)
    } else {
      await writeSnapshot(name, source.out, await source.build())
    }
  }
}

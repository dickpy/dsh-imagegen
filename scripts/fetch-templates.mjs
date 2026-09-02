/**
 * Refresh the bundled template-library snapshots shipped inside the plugin
 * package (src/templates/*.json), one per registered source:
 *
 *   vibeui  ← https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json
 *   canghe  ← https://gpt-image2.canghe.ai/cases.json
 *
 * The snapshots carry prompt text + metadata only — reference images stay
 * remote and are pulled through the host's caching proxy route at runtime
 * (hundreds of images ≈ 100 MB per source would bloat the npm tarball).
 *
 * Usage:
 *   node scripts/fetch-templates.mjs               # refresh every source
 *   node scripts/fetch-templates.mjs vibeui        # refresh one source
 *   node scripts/fetch-templates.mjs <url> <file>  # ad-hoc url + output
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The bundled snapshots, named by source id (mirrors templates-store.ts). */
const SOURCES = {
  vibeui: {
    url: 'https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json',
    out: resolve(ROOT, 'src/templates/cases.json'),
  },
  canghe: {
    url: 'https://gpt-image2.canghe.ai/cases.json',
    out: resolve(ROOT, 'src/templates/canghe-cases.json'),
  },
}

/** Category label map mirrored from the upstream sites' site.js (zh names). */
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

function imageFileOf(path) {
  const value = String(path ?? '').replace(/^\/+/, '')
  const name = value.split('/').pop() ?? ''
  return /^[\w.-]+\.(jpg|jpeg|png|webp|gif)$/i.test(name) ? name : ''
}

async function fetchSource(name, url, out) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status} ${url}`)
  const payload = await response.json()
  const rawCases = Array.isArray(payload.cases) ? payload.cases : []
  if (rawCases.length === 0) throw new Error(`no cases in the source payload: ${url}`)

  const cases = []
  let skipped = 0
  for (const raw of rawCases) {
    if (raw === null || typeof raw !== 'object') { skipped++; continue }
    const id = Number(raw.id)
    const title = String(raw.title ?? '').trim()
    const prompt = String(raw.prompt ?? '').trim()
    const image = imageFileOf(raw.image)
    if (!Number.isInteger(id) || title === '' || prompt === '') { skipped++; continue }
    cases.push({
      id,
      title,
      prompt,
      category: String(raw.category ?? ''),
      categoryZh: CATEGORY_ZH[String(raw.category ?? '')] ?? String(raw.category ?? ''),
      styles: Array.isArray(raw.styles) ? raw.styles.map(String) : [],
      scenes: Array.isArray(raw.scenes) ? raw.scenes.map(String) : [],
      sourceLabel: String(raw.sourceLabel ?? ''),
      sourceUrl: String(raw.sourceUrl ?? ''),
      githubUrl: String(raw.githubUrl ?? ''),
      image,
      featured: raw.featured === true,
    })
  }
  cases.sort((a, b) => b.id - a.id)

  const snapshot = {
    repository: String(payload.repository ?? 'freestylefly/awesome-gpt-image-2'),
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    totalCases: cases.length,
    categories: [...new Set(cases.map(item => item.category))],
    cases,
  }

  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`[${name}] wrote ${cases.length} cases (skipped ${skipped}) -> ${out}`)
}

const [argOne, argTwo] = process.argv.slice(2)
if (argOne !== undefined && argTwo !== undefined) {
  await fetchSource('adhoc', argOne, resolve(argTwo))
} else {
  const targets = argOne !== undefined && argOne in SOURCES
    ? [argOne]
    : argOne !== undefined
      ? (() => { throw new Error(`unknown source: ${argOne} (expected ${Object.keys(SOURCES).join(' | ')} or <url> <file>)`) })()
      : Object.keys(SOURCES)
  for (const name of targets) {
    await fetchSource(name, SOURCES[name].url, SOURCES[name].out)
  }
}

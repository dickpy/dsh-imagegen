/**
 * Fetch the awesome-gpt-image-2 prompt gallery (mirrored by vibeui.top) and
 * write the bundled template-library snapshot shipped inside the plugin
 * package (src/templates/cases.json).
 *
 * The snapshot carries prompt text + metadata only — reference images stay
 * remote and are pulled through the host's caching proxy route at runtime
 * (441 images ≈ 100 MB would bloat the npm tarball).
 *
 * Usage: node scripts/fetch-templates.mjs [cases-json-url]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = process.argv[2] ?? 'https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json'
const OUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../src/templates/cases.json')

/** Category label map mirrored from vibeui.top's site.js (zh display names). */
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

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) })
if (!response.ok) {
  console.error(`fetch failed: HTTP ${response.status} ${SOURCE_URL}`)
  process.exit(1)
}
const payload = await response.json()
const rawCases = Array.isArray(payload.cases) ? payload.cases : []
if (rawCases.length === 0) {
  console.error('no cases in the source payload')
  process.exit(1)
}

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
  sourceUrl: SOURCE_URL,
  fetchedAt: new Date().toISOString(),
  totalCases: cases.length,
  categories: [...new Set(cases.map(item => item.category))],
  cases,
}

await mkdir(dirname(OUT_PATH), { recursive: true })
await writeFile(OUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
console.log(`wrote ${cases.length} cases (skipped ${skipped}) -> ${OUT_PATH}`)

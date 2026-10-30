/**
 * Standalone self-test for `src/ppt-deck-pipeline.ts`.
 *
 * No host services, no settings, no network model: the chat seam is a stub whose
 * judgement is derived from the committed feasibility fixture, while the CLI seam
 * really runs the installed venv `editppt.exe`. Two phases:
 *
 *  A. copy `run-001` → `pipeline-selftest/run-copy`, reset page_001, and drive
 *     one page through dispatch → build → validate → contact sheet → record.
 *  B. run the whole `runDeckPipeline` over **two** input images (offline hints)
 *     and finalize, asserting the deck, reports and previews come out passed.
 *
 * Run: node scripts/ppt-pipeline-selftest.mjs
 * The original `run-001` directory and `~/.dsh` are read-only inputs here.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { reconstructPage, runDeckPipeline, parseJudgement, mergeJudgement } = await import('../src/ppt-deck-pipeline.ts')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = path.join(ROOT, 'output', 'feasibility-ppt-20261030', 'run-001')
const SELFTEST = path.join(ROOT, 'output', 'feasibility-ppt-20261030', 'pipeline-selftest')
const COPY = path.join(SELFTEST, 'run-copy')
const TWO = path.join(SELFTEST, 'run-two')
const EDITPPT = 'C:\\Users\\Administrator\\.dsh\\dsh-imagegen\\ppt-runtime\\Scripts\\editppt.exe'
const SKILL_DOC = 'C:\\Users\\Administrator\\.dsh\\skills\\image-to-editable-ppt\\references\\manifest-schema.md'

const commands = []
const events = []
const failures = []
let chatCalls = 0

function check(label, condition, detail = '') {
  const line = `${condition ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`
  console.log(line)
  if (!condition) failures.push(label)
}

async function runCommand(argv, options) {
  const record = { argv: argv.slice(), cwd: options.cwd, code: -1 }
  commands.push(record)
  const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill() } catch {} }, options.timeoutMs ?? 180_000)
    child.on('error', error => { clearTimeout(timer); output += `\n${error.message}`; resolve(-1) })
    child.on('close', value => { clearTimeout(timer); resolve(value ?? 1) })
  })
  record.code = code
  record.output = output
  return { code, output }
}

/** Derive a page judgement from the fixture manifest, keyed by hint box centres. */
function fixtureJudgement(lines, fixture) {
  const centre = box => [box[0] + box[2] / 2, box[1] + box[3] / 2]
  const boxes = (fixture.manifest.text_boxes ?? []).filter(box => Array.isArray(box.box_px))
  const text = lines.map((line, index) => {
    let best = null
    let bestDistance = Number.POSITIVE_INFINITY
    const target = centre(Array.isArray(line.box_px) && line.box_px.length >= 4 ? line.box_px : [0, 0, 1, 1])
    for (const box of boxes) {
      const other = centre(box.box_px)
      const distance = Math.hypot(target[0] - other[0], target[1] - other[1])
      if (distance < bestDistance) { bestDistance = distance; best = box }
    }
    const content = best !== null && bestDistance <= 150 ? best.text : `本地管线测试文本 ${index + 1}`
    return { hint_index: index, content }
  })
  const shapes = (fixture.manifest.shapes ?? []).map(shape => {
    if (Array.isArray(shape.points_px)) {
      return { kind: shape.end_arrow === 'triangle' ? 'arrow' : 'line', box: shape.points_px, fill: null, stroke: `#${shape.stroke}`, stroke_pt: shape.stroke_width ?? 1.5 }
    }
    const box = shape.box_px
    return { kind: shape.type === 'roundRect' ? 'roundRect' : shape.type === 'ellipse' ? 'ellipse' : 'rect', box: [box[0], box[1], box[0] + box[2], box[1] + box[3]], fill: shape.fill === 'none' ? null : `#${shape.fill}`, stroke: shape.stroke === 'none' ? null : `#${shape.stroke}`, stroke_pt: shape.stroke_width ?? 1.5 }
  })
  return {
    background: { type: 'color', value: fixture.manifest.slide?.background ?? '#FFFFFF' },
    shapes,
    // One deliberate source crop: exercises the Pillow path and the
    // user-provided/background provenance rule the live runner confirmed.
    pictures: [{ box: [880, 300, 1160, 440], source_box: [880, 300, 1160, 440], label: '本地裁剪的流程卡片区域' }],
    text,
  }
}

function makeChat(fixture) {
  return {
    complete: async ({ content }) => {
      chatCalls += 1
      const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')
      const marker = text.indexOf('OCR 行列表')
      const block = text.slice(marker)
      const start = block.indexOf('[')
      const end = block.indexOf('\n', start)
      const lines = JSON.parse(block.slice(start, end))
      return '```json\n' + JSON.stringify(fixtureJudgement(lines, fixture)) + '\n```'
    },
  }
}

function baseDeps(chat) {
  return {
    editppt: async () => EDITPPT,
    run: runCommand,
    chat,
    readSkillDoc: async () => fs.readFile(SKILL_DOC, 'utf8').catch(() => undefined),
    concurrency: () => 2,
    pageBudgetMs: () => 150_000,
    onEvent: event => events.push(event),
    signal: new AbortController().signal,
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function firstBytes(file) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(3)
    await handle.read(buffer, 0, 3, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

async function exists(file) {
  return fs.stat(file).then(() => true, () => false)
}

async function main() {
  check('editppt.exe 存在', await exists(EDITPPT), EDITPPT)
  check('fixture run-001 存在', await exists(path.join(FIXTURE, 'deck_manifest.json')))
  const fixtureManifest = await readJson(path.join(FIXTURE, 'pages', 'page_001', 'manifest.json'))
  const fixture = { manifest: fixtureManifest }

  // ---------------------------------------------------------------- phase A
  await fs.rm(COPY, { recursive: true, force: true })
  await fs.cp(FIXTURE, COPY, { recursive: true })
  const pageDir = path.join(COPY, 'pages', 'page_001')
  await fs.rm(path.join(pageDir, 'manifest.json'), { force: true })
  await fs.rm(path.join(pageDir, 'page.pptx'), { force: true })
  await fs.rm(path.join(pageDir, 'preview.png'), { force: true })
  await fs.rm(path.join(pageDir, 'validation.json'), { force: true })
  await fs.rm(path.join(pageDir, 'split_assets_contact.png'), { force: true })
  await fs.rm(path.join(pageDir, 'page_result.json'), { force: true })
  // The copied page is `accepted` (the fixture ran to completion) and `run reset`
  // refuses accepted pages, so the copy's own state file is rewritten to the
  // post-prepare shape. Only the copy is touched — never the fixture.
  const jobs = await readJson(path.join(COPY, 'page_jobs.json'))
  for (const page of jobs.pages) {
    page.status = 'pending'
    page.dispatch = null
    page.result = null
    page.accepted = false
  }
  jobs.run_status = 'pages_pending'
  await fs.writeFile(path.join(COPY, 'page_jobs.json'), `${JSON.stringify(jobs, null, 2)}\n`, 'utf8')
  const deck = await readJson(path.join(COPY, 'deck_manifest.json'))
  for (const page of deck.pages ?? []) {
    page.status = 'pending'
    page.agent_status = 'pending'
    page.dispatch = null
    page.result = null
    page.accepted = false
  }
  await fs.writeFile(path.join(COPY, 'deck_manifest.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8')
  const nextOut = await runCommand([EDITPPT, 'run', 'next', COPY, '--json'], { cwd: COPY, timeoutMs: 60_000 })
  const nextStage = /"stage"\s*:\s*"([^"]+)"/.exec(String(nextOut.output))?.[1] ?? 'unknown'
  check('phase A 状态已回到待分派', nextOut.code === 0 && nextStage !== 'finalize' && nextStage !== 'unknown', `stage=${nextStage} code=${nextOut.code}`)

  const outcome = await reconstructPage({
    deps: baseDeps(makeChat(fixture)),
    runDir: COPY,
    pageDir,
    pageId: 'page_001',
    agentId: 'plugin-page-1',
    contract: '（selftest 精简契约）只输出 JSON。',
    offlineHints: false,
    timeoutMs: 150_000,
  })
  check('phase A 页面已 recorded', outcome.state === 'recorded', JSON.stringify(outcome).slice(0, 300))
  const aManifestFile = path.join(pageDir, 'manifest.json')
  const aManifest = await readJson(aManifestFile)
  const bom = await firstBytes(aManifestFile)
  check('manifest.json 无 BOM', !(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf), bom.toString('hex'))
  const request = await readJson(path.join(pageDir, 'page_request.json'))
  check('slide/content_box 原样来自 page_request', JSON.stringify([aManifest.slide.width, aManifest.slide.height]) === JSON.stringify([request.slide.width, request.slide.height]) && aManifest.content_box.width === request.content_box.width)
  const aValidation = await readJson(path.join(pageDir, 'validation.json'))
  check('page validate passed === true', aValidation.passed === true, JSON.stringify(aValidation.page_contract_violations ?? []).slice(0, 300))
  const aResult = await readJson(path.join(pageDir, 'page_result.json'))
  check('page_result 七件套键齐全', ['page_manifest', 'imagegen_jobs', 'page_pptx', 'preview', 'contact_sheet', 'validation', 'page_result'].every(key => typeof aResult[key] === 'string'))
  const crop = path.join(pageDir, 'assets', 'photo_001.png')
  check('确定性裁剪产物存在', await exists(crop), crop)
  const provenance = aManifest.asset_provenance.find(entry => entry.path === 'assets/photo_001.png')
  check('裁剪贴图 source_type 为 user-provided', provenance?.source_type === 'user-provided', JSON.stringify(provenance ?? {}))
  const visual = aManifest.visual_inventory.find(entry => entry.path === 'assets/photo_001.png')
  check('裁剪贴图 role 为 background', visual?.role === 'background', JSON.stringify(visual ?? {}))
  const measured = aManifest.text_boxes.filter(box => box.font_size_source === 'measured')
  check('文本框字号全部来自 hints', measured.length === aManifest.text_boxes.length && aManifest.text_boxes.every(box => Array.isArray(box.box_px)))
  check('slide.background 带 # 前缀', /^#[0-9A-F]{6}$/.test(String(aManifest.slide.background)), String(aManifest.slide.background))
  const fonts = [...new Set(aManifest.text_boxes.map(box => box.preview_font))]
  let fontsAllExist = fonts.length > 0
  for (const font of fonts) if (!(await exists(String(font)))) fontsAllExist = false
  check('text_boxes 带本机存在的 preview_font', fontsAllExist, JSON.stringify(fonts))
  const aJobs = await readJson(path.join(COPY, 'page_jobs.json'))
  check('dispatch/record agent-id 一致', aJobs.pages[0].status === 'recorded' && aJobs.pages[0].result.agent_id === 'plugin-page-1' && aJobs.pages[0].dispatch.agent_id === 'plugin-page-1')
  check('prompt 文件位于页目录内', await exists(path.join(pageDir, 'plugin-prompt.md')) && path.basename(aJobs.pages[0].dispatch.prompt) === 'plugin-prompt.md', String(aJobs.pages[0].dispatch.prompt))

  // ---------------------------------------------------------------- phase B
  await fs.rm(TWO, { recursive: true, force: true })
  const inputsDir = path.join(SELFTEST, 'inputs')
  await fs.rm(inputsDir, { recursive: true, force: true })
  await fs.mkdir(inputsDir, { recursive: true })
  const source = path.join(FIXTURE, 'input', 'source.png')
  const inputs = []
  for (const name of ['page-01.png', 'page-02.png']) {
    const target = path.join(inputsDir, name)
    await fs.cp(source, target)
    inputs.push({ path: target, name })
  }
  const result = await runDeckPipeline(inputs, TWO, { offlineOcr: true, language: 'zh' }, baseDeps(makeChat(fixture)))
  check('phase B 两页均 recorded', result.pages.length === 2 && result.pages.every(page => page.state === 'recorded'), JSON.stringify(result.pages).slice(0, 400))
  check('deck 产物存在', await exists(result.deckPath), result.deckPath)
  check('report 产物存在', await exists(result.reportPath))
  check('run_summary 产物存在', await exists(result.runSummaryPath))
  check('previews 两页齐全', result.previews.length === 2, JSON.stringify(result.previews))
  const deckReport = await readJson(result.reportPath)
  check('final validation.passed === true', deckReport.passed === true, JSON.stringify(deckReport).slice(0, 400))
  check('final deck 页数 === 2', deckReport.slides === 2 || deckReport.slide_count === 2, String(deckReport.slides ?? deckReport.slide_count))
  const bJobs = await readJson(path.join(TWO, 'page_jobs.json'))
  check('多页 agent-id 形如 plugin-page-<N> 且未用 --local', bJobs.pages.every((page, i) => page.dispatch.agent_id === `plugin-page-${i + 1}` && page.dispatch.execution_mode !== 'local'), JSON.stringify(bJobs.pages.map(page => [page.dispatch.agent_id, page.dispatch.execution_mode])))
  check('离线模式产出了每页 text_hints', await exists(path.join(TWO, 'pages', 'page_001', 'text_hints.json')))
  const banned = commands.filter(entry => entry.argv.some(arg => /^editppt$/.test(path.basename(arg)) && entry.argv.includes('generate')) || entry.argv.some(arg => entry.argv.some(inner => /image\s+(generate|edit)$/.test(inner))))
  check('从未调用任何生图 API', banned.length === 0, JSON.stringify(banned.map(entry => entry.argv.slice(0, 4))))
  check('事件 label 均为 locales key', events.every(event => /^[a-z]+\.[A-Za-z]+$/.test(event.label)), JSON.stringify([...new Set(events.map(event => event.label))]))
  check('parseJudgement 能剥围栏', parseJudgement('```json\n{"text":[]}\n```')?.text?.length === 0)
  check('mergeJudgement 丢弃越界 hint_index', (() => {
    const merged = mergeJudgement({
      draft: { hints: [{ box_px: [1, 2, 3, 4], font_pt: 12 }], background: '#FFFFFF', sourceWidth: 100, sourceHeight: 100 },
      judgement: { text: [{ hint_index: 9, content: 'x' }] },
      request: undefined,
      pageId: 'page_001',
      assetPaths: [],
      warnings: [],
    })
    return merged.text_boxes.length === 1 && merged.text_boxes[0].text === '' || merged.text_boxes.length === 0
  })())
  console.log(`\n命令调用 ${commands.length} 次，模型 stub 调用 ${chatCalls} 次，事件 ${events.length} 条`)
  console.log(`产物目录：${COPY}\n          ${TWO}`)
  if (failures.length > 0) {
    console.log(`\n失败项：${failures.join(' | ')}`)
    process.exitCode = 1
    return
  }
  console.log('\nSELFTEST OK')
}

main().catch(error => {
  console.error(error)
  const failing = commands.filter(entry => entry.code !== 0)
  if (failing.length > 0) {
    const last = failing[failing.length - 1]
    console.error(`最后失败命令：${last.argv.join(' ')}\n(code=${last.code})\n${String(last.output).slice(-2000)}`)
  }
  process.exitCode = 1
})

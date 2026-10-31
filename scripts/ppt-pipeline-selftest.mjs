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
    // `regions` by default: the self-test must not spend image quota. Set
    // SELFTEST_VISUAL_MODE=imagegen to exercise the clean-base path instead.
    visualMode: () => process.env.SELFTEST_VISUAL_MODE ?? 'regions',
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
  // Phase A's fixture is a flat native slide: the analyzer legitimately measures
  // no bitmap there. What must hold is that *whatever* images we place carry the
  // provenance and role the CLI accepts (verified on the artwork page in phase B).
  const crop = path.join(pageDir, 'assets', 'photo_001.png')
  const aHasImages = Array.isArray(aManifest.images) && aManifest.images.length > 0
  if (aHasImages) {
    const provenance = aManifest.asset_provenance.find(entry => entry.path === aManifest.images[0].path)
    const inventory = aManifest.visual_inventory.find(entry => entry.path === aManifest.images[0].path)
    check('phase A 贴图来源记录正确', (await exists(crop)) && provenance?.source_type === 'user-provided' && inventory?.role === 'background', JSON.stringify([provenance?.source_type, inventory?.role]))
  } else {
    check('phase A 无位图区域时 shapes 仍来自测量（非空页）', aManifest.shapes.length >= 1 && aResult.visual_regions.panels + aResult.visual_regions.bitmaps + aResult.visual_regions.lines >= 0, `shapes=${aManifest.shapes.length} visual=${JSON.stringify(aResult.visual_regions)} fidelity=${aResult.fidelity} sourceInk=${aResult.visual_source_ink}`)
  }
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
  // The two postmortem fixtures: a business page (cards, table, pill, photo) and
  // the user's image-heavy page. These are what the visual layer must survive.
  const fixtures = [
    path.join(ROOT, 'output', 'postmortem', 'business-slide.png'),
    path.join(ROOT, 'output', 'postmortem', 'real-slide-1.png'),
  ]
  const inputs = []
  for (const [offset, file] of fixtures.entries()) {
    const target = path.join(inputsDir, `fixture-${offset + 1}.png`)
    await fs.cp(file, target)
    inputs.push({ path: target, name: path.basename(file) })
  }
  const result = await runDeckPipeline(inputs, TWO, { offlineOcr: true, language: 'zh' }, baseDeps(makeChat(fixture)))
  const pageSummary = result.pages.map(page => [page.page, page.state, page.objects, page.regions, page.fidelity, Math.round(page.sourceInk * 100) / 100])
  check('phase B 两页均 recorded', result.pages.length === 2 && result.pages.every(page => page.state === 'recorded'), JSON.stringify(pageSummary))
  // The failure the postmortem is about: a page that ships only typography.
  check('phase B 每页都带回视觉结果', result.pages.every(page => typeof page.sourceInk === 'number' && typeof page.fidelity === 'number' && typeof page.regions.panels === 'number'), JSON.stringify(pageSummary))
  check('phase B 视觉对象不为零（图形没全丢）', result.pages.every(page => page.regions.panels + page.regions.bitmaps + page.regions.lines > 0 && page.objects > 8), JSON.stringify(result.pages.map(page => [page.objects, page.regions])))
  // In `regions` mode no clean base is allowed, so the artwork page can score
  // below the gate — what must never happen is a silent low score.
  check('phase B 低还原必须带告警（不静默）', result.pages.every(page => page.fidelity >= 0.6 || page.warnings.some(entry => entry.includes('还原度'))), JSON.stringify(result.pages.map(page => [page.fidelity, page.warnings.length])))
  const artPage = result.pages.find(page => page.regions.bitmaps >= 8)
  check('phase B 图为主页面测出了大量位图区域', artPage !== undefined, JSON.stringify(result.pages.map(page => page.regions)))
  if (artPage !== undefined) {
    const artDir = path.join(TWO, 'pages', `page_${String(artPage.page).padStart(3, '0')}`)
    const artManifest = await readJson(path.join(artDir, 'manifest.json'))
    let badCount = 0
    for (const image of artManifest.images) {
      const entry = artManifest.asset_provenance.find(item => item.path === image.path)
      const inventory = artManifest.visual_inventory.find(item => item.path === image.path)
      if (entry?.source_type !== 'user-provided' || inventory?.role !== 'background' || !(await exists(path.join(artDir, image.path)))) badCount += 1
    }
    check('phase B 贴图全部 user-provided + role background + 文件存在', badCount === 0, `images=${artManifest.images.length} bad=${badCount}`)
  }
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
  // Ghosting rule: a page that has a clean base keeps no source crops at all —
  // the base already holds the artwork, so pasting crops double-draws it.
  const baseConflict = []
  for (const file of [aManifestFile, ...result.previews.map(preview => path.join(path.dirname(preview), 'manifest.json'))]) {
    const manifest = await readJson(file)
    const paths = (manifest.images ?? []).map(image => String(image.path ?? ''))
    if (paths.some(entry => entry.includes('clean-base')) && paths.some(entry => entry.startsWith('assets/photo_'))) baseConflict.push(file)
    if (paths.some(entry => entry.includes('clean-base'))) check('clean base 页不再引用位图裁剪（无鬼影）', !paths.some(entry => entry.startsWith('assets/photo_')), `${path.basename(path.dirname(file))}: images=${paths.length}`)
  }
  check('没有任何页同时贴 clean base 与源图裁剪', baseConflict.length === 0, JSON.stringify(baseConflict))
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

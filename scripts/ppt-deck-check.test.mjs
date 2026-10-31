/**
 * Unit tests for `src/ppt-deck-check.ts`.
 *
 * The fixtures are generated on the spot with python-pptx (a real producer, not
 * a hand-written ZIP), because the point of the check is to judge packages that
 * PowerPoint-compatible writers actually emit. Three decks are built:
 *
 *  - `editable.pptx` — one slide, two text boxes and one autoshape (no picture);
 *  - `raster.pptx`   — one slide, one picture stretched over the whole page;
 *  - plus the same editable deck used with a wrong expected page count and a
 *    failing validation report, and a non-ZIP buffer.
 *
 * Run directly (`node scripts/ppt-deck-check.test.mjs`) or via `node --test`.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acceptDeck, FULL_BLEED_RATIO, inspectDeck } from '../src/ppt-deck-check.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Only this directory is written; it is the repo's ignored scratch output. */
const fixtureDir = path.join(root, 'output', 'ppt-deck-check-fixtures')

/** Interpreters worth trying, in order; the first one with python-pptx wins. */
const PYTHON_CANDIDATES = [
  ...(process.env.PPT_FIXTURE_PYTHON === undefined ? [] : [[process.env.PPT_FIXTURE_PYTHON]]),
  ['D:\\miniforge\\python.exe'],
  ...(process.platform === 'win32' ? [['py', '-3']] : []),
  ['python'],
  ['python3'],
]

function probePython(argv) {
  const result = spawnSync(argv[0], [...argv.slice(1), '-c', 'import pptx, PIL; print(pptx.__version__)'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

const pythonArgv = PYTHON_CANDIDATES.find(argv => probePython(argv) !== undefined)
if (pythonArgv === undefined) {
  throw new Error('需要带 python-pptx 与 Pillow 的 Python（可用 PPT_FIXTURE_PYTHON 指定解释器）')
}
const pythonVersion = probePython(pythonArgv)

const MAKER = String.raw`
import pathlib
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Emu
from PIL import Image

out = pathlib.Path(__file__).resolve().parent
SLIDE_W, SLIDE_H = 12192000, 6858000  # 13.333in x 7.5in, 16:9

def deck():
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    return prs

def textbox(slide, x, y, w, h, text):
    box = slide.shapes.add_textbox(Emu(x), Emu(y), Emu(w), Emu(h))
    box.text_frame.text = text
    return box

# a) legal, editable single slide: two text boxes + one drawn shape, no picture
prs = deck()
slide = prs.slides.add_slide(prs.slide_layouts[6])
textbox(slide, 914400, 685800, 5486400, 914400, "\u6807\u9898\u4e00")
textbox(slide, 914400, 1828800, 5486400, 914400, "\u6b63\u6587\u4e8c")
slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Emu(914400), Emu(3657600), Emu(2743200), Emu(1371600))
prs.save(out / "editable.pptx")

# b) the cheat: one screenshot stretched over the page, no text, no shape
Image.new("RGB", (1600, 900), (30, 60, 90)).save(out / "page.png")
prs = deck()
slide = prs.slides.add_slide(prs.slide_layouts[6])
slide.shapes.add_picture(str(out / "page.png"), 0, 0, prs.slide_width, prs.slide_height)
prs.save(out / "raster.pptx")

# c) the page whose graphic IS a table: native a:tbl inside a graphic frame,
#    no p:pic and no p:sp geometry - the visual-loss gate must not call this empty.
prs = deck()
slide = prs.slides.add_slide(prs.slide_layouts[6])
table = slide.shapes.add_table(3, 3, Emu(914400), Emu(1828800), Emu(7315200), Emu(1371600)).table
for r in range(3):
    for c in range(3):
        table.cell(r, c).text = f"单元格 {r}{c}"
prs.save(out / "table.pptx")

print("fixtures written to", out)
`

mkdirSync(fixtureDir, { recursive: true })
writeFileSync(path.join(fixtureDir, 'make_fixtures.py'), MAKER, 'utf8')
const made = spawnSync(pythonArgv[0], [...pythonArgv.slice(1), path.join(fixtureDir, 'make_fixtures.py')], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
})
if (made.status !== 0) throw new Error(`夹具生成失败：${made.stdout}${made.stderr}`)

const editableDeck = () => readFileSync(path.join(fixtureDir, 'editable.pptx'))
const rasterDeck = () => readFileSync(path.join(fixtureDir, 'raster.pptx'))
const tableDeck = () => readFileSync(path.join(fixtureDir, 'table.pptx'))

/** Fixture provenance, printed once so a failure is reproducible. */
console.log(`# fixtures: ${fixtureDir}`)
console.log(`# python:   ${pythonArgv.join(' ')} (python-pptx ${pythonVersion})`)
console.log(`# full-bleed threshold: ${FULL_BLEED_RATIO * 100}% of the slide area`)

test('a) 可编辑单页：指标与验收', () => {
  const inspection = inspectDeck(editableDeck())
  console.log('inspection(editable) =', JSON.stringify(inspection))
  assert.ok(inspection !== undefined, 'editable.pptx 必须被识别为合法 pptx')
  assert.equal(inspection.slides, 1)
  assert.equal(inspection.textRuns, 2, '两个文本框各 1 个非空 <a:t>')
  assert.equal(inspection.nativeShapes, 3, '2 个文本框 + 1 个圆角矩形都是无 blipFill 的 p:sp')
  assert.equal(inspection.pictures, 0)
  assert.equal(inspection.fullBleedPictures, 0)
  assert.equal(inspection.pages.length, 1)
  assert.equal(inspection.pages[0].page, 1)
  assert.deepEqual(inspection.pages[0].notes, [])
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 1, reportPassed: true }), { ok: true })
})

test('b) 整页位图单页：raster-only 拒绝', () => {
  const inspection = inspectDeck(rasterDeck())
  console.log('inspection(raster) =', JSON.stringify(inspection))
  assert.ok(inspection !== undefined)
  assert.equal(inspection.slides, 1)
  assert.equal(inspection.textRuns, 0)
  assert.equal(inspection.nativeShapes, 0)
  assert.equal(inspection.pictures, 1)
  assert.equal(inspection.fullBleedPictures, 1, '铺满页面的 p:pic 必须计入整页位图')
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 1, reportPassed: true }), {
    ok: false,
    reason: 'raster-only',
  })
})

test('c) 反向用例：页数不符 / 报告未通过 / 不是 pptx', () => {
  const inspection = inspectDeck(editableDeck())
  assert.ok(inspection !== undefined)
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 2, reportPassed: true }), {
    ok: false,
    reason: 'slide-count',
  })
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 0, reportPassed: true }), {
    ok: false,
    reason: 'slide-count',
  })
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 1, reportPassed: false }), {
    ok: false,
    reason: 'report-not-passed',
  })
  const junk = Buffer.from('not-a-pptx')
  assert.equal(inspectDeck(junk), undefined)
  assert.deepEqual(acceptDeck({ inspection: inspectDeck(junk), expectedSlides: 1, reportPassed: true }), {
    ok: false,
    reason: 'invalid-package',
  })
})

test('d) 整册只有图片（无逐页细节）也按 raster-only 拒绝', () => {
  // 调用方只给聚合值时，仍不能放过「全是图片」的整册。
  const inspection = {
    slides: 2,
    textRuns: 0,
    nativeShapes: 0,
    graphicShapes: 0,
    pictures: 2,
    fullBleedPictures: 2,
    notes: [],
    pages: [],
  }
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 2, reportPassed: true }), {
    ok: false,
    reason: 'raster-only',
  })
})

/**
 * A page that only carries text boxes: `nativeShapes` is 2 (text boxes are
 * `p:sp`), so the older rules call it editable - and it is, for words. But when
 * the *source* page had artwork, that is precisely the "只有文字" failure.
 */
const textOnlyInspection = {
  slides: 1,
  textRuns: 6,
  nativeShapes: 2,
  graphicShapes: 0,
  pictures: 0,
  fullBleedPictures: 0,
  notes: [],
  pages: [{ page: 1, textRuns: 6, nativeShapes: 2, graphicShapes: 0, pictures: 0, fullBleedPictures: 0, notes: [] }],
}

test('e) 源图有图形、成片只剩文本框：visual-loss 拒绝', () => {
  assert.deepEqual(acceptDeck({ inspection: textOnlyInspection, expectedSlides: 1, reportPassed: true, visualPages: [1] }), {
    ok: false,
    reason: 'visual-loss',
  })
})

test('f) 不带 visualPages 时行为不变（老调用方不会被新规则误伤）', () => {
  assert.deepEqual(acceptDeck({ inspection: textOnlyInspection, expectedSlides: 1, reportPassed: true }), { ok: true })
})

test('g) 文本框不算图形：有 panel 形状或贴图时 visualPages 放行', () => {
  const withPanels = {
    ...textOnlyInspection,
    graphicShapes: 9,
    pictures: 1,
    pages: [{ ...textOnlyInspection.pages[0], graphicShapes: 9, pictures: 1 }],
  }
  assert.deepEqual(acceptDeck({ inspection: withPanels, expectedSlides: 1, reportPassed: true, visualPages: [1] }), { ok: true })
})

test('h) 真跑产物：文本框页在 visualPages 下必须被拦，含形状页必须放行', () => {
  const editable = inspectDeck(editableDeck())
  assert.ok(editable !== undefined)
  // The editable fixture carries a rounded rectangle, so it is real geometry.
  assert.ok(editable.graphicShapes > 0, 'fixture should expose at least one non-text-box shape')
  assert.deepEqual(acceptDeck({ inspection: editable, expectedSlides: 1, reportPassed: true, visualPages: [1] }), { ok: true })
})

test('i) 原生表格单页：tables>0 且 graphicShapes=0，visualPages 下不得判 visual-loss', () => {
  const inspection = inspectDeck(tableDeck())
  assert.ok(inspection !== undefined, 'table.pptx 必须是合法包')
  console.log('inspection(table) =', JSON.stringify(inspection.pages[0]))
  assert.equal(inspection.pages[0].tables, 1, 'slide 1 的 graphicFrame 里有一张 a:tbl')
  assert.equal(inspection.pages[0].graphicShapes, 0, 'python-pptx 的表格是 graphicFrame，不是 p:sp')
  assert.equal(inspection.pages[0].pictures, 0)
  assert.ok(inspection.pages[0].textRuns > 0, '单元格文字必须是可编辑 a:t')
  // 业务页的「图形」常常就是这张表：不能因为没 p:sp/p:pic 就被当成没还原。
  assert.deepEqual(acceptDeck({ inspection, expectedSlides: 1, reportPassed: true, visualPages: [1] }), { ok: true })
})

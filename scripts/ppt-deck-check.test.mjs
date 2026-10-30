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

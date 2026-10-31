/**
 * Structural acceptance check for a produced deck (`ppt.fromImages`).
 *
 * The deck pipeline hands the plugin a `.pptx` plus the upstream validation
 * report. Neither can be trusted on its own: the report is a file the pipeline
 * itself wrote, and the historical failure mode was a *legal* OOXML package that
 * merely wrapped every source screenshot in a full-slide picture — structurally
 * valid, slide count correct, and useless as an editable deck.
 *
 * So acceptance is one pure function over three facts: what the package
 * contains (this module's inspection), how many slides the user supplied, and
 * whether upstream's `validation.json` passed. Nothing here touches the disk,
 * the network or the model, which keeps the rule testable and the delivery path
 * (direct copy *and* recovery from `final/`) sharing exactly one entry point.
 *
 * Numbers are deliberately aggregate-first: OOXML has no nesting of `p:sp` or
 * `p:pic`, so a bounded regex scan over each slide part is both sufficient and
 * cheap (a slide part is a single XML document, not a tree we need to resolve).
 */

import { readZipDirectory, readZipEntry, type ZipEntry } from './zip.ts'

/** One slide part's contribution to the aggregate inspection. */
export interface DeckSlideInspection {
  /** 1-based slide number, taken from `ppt/slides/slideN.xml`. */
  page: number
  /** Non-empty `<a:t>` runs on this slide. */
  textRuns: number
  /** `<p:sp>` blocks without a `<a:blipFill>` (editable vector/text shapes). */
  nativeShapes: number
  /**
   * Shapes that are real geometry: no `<a:blipFill>` and not a text box
   * (`txBox="1"`). This is what {@link acceptDeck} measures visual recovery
   * against, because a page of nothing but text boxes has `nativeShapes > 0`.
   */
  graphicShapes: number
  /** Native tables (`a:tbl` inside a graphic frame); a table page has no `p:pic`. */
  tables: number
  /** `<p:pic>` elements on this slide. */
  pictures: number
  /** Pictures whose `<a:xfrm><a:ext>` covers at least {@link FULL_BLEED_RATIO}. */
  fullBleedPictures: number
  /** Human-readable explanations for anything that could not be measured. */
  notes: string[]
}

/** Aggregate structure of one deck. */
export interface DeckInspection {
  /** Number of `ppt/slides/slideN.xml` parts found in the package. */
  slides: number
  /** Total non-empty `<a:t>` runs across all slides. */
  textRuns: number
  /** Total `<p:sp>` blocks with no `<a:blipFill>` across all slides. */
  nativeShapes: number
  /** Total geometry shapes (no picture fill, not a text box) across all slides. */
  graphicShapes: number
  /** Total native tables across all slides. */
  tables: number
  /** Total `<p:pic>` elements across all slides. */
  pictures: number
  /** Total pictures covering at least 85% of the slide area. */
  fullBleedPictures: number
  /** Package-level explanations (missing slide size, skipped parts, …). */
  notes: string[]
  /** Per-slide breakdown; the aggregate fields are its sums. */
  pages: DeckSlideInspection[]
}

/** Why a deck was refused. The documented vocabulary plus the visual-loss case. */
export type DeckRejection = 'invalid-package' | 'slide-count' | 'report-not-passed' | 'raster-only' | 'visual-loss'

/** Acceptance result: no details on success keeps callers from branching on them. */
export type DeckAcceptance = { ok: true } | { ok: false; reason: DeckRejection }

/**
 * A picture counts as "full bleed" at 85% of the slide area rather than 100%
 * because decks routinely inset a hero image by a few percent (margins, a
 * shadow, `w:…` rounding); a page that is really one screenshot lands at 95%+
 * and 85% leaves comfortable headroom for a deliberate small inset while still
 * catching the screenshot-as-slide case. Area (not width) is used so a
 * full-height, 60%-wide strip is not mistaken for a page background.
 */
export const FULL_BLEED_RATIO = 0.85

/** Slide parts matching the deck layout; also bounds the scan below. */
const SLIDE_ENTRY = /^ppt\/slides\/slide(\d+)\.xml$/

/** Hard cap on slide parts inspected, so a hostile package cannot burn time. */
const MAX_SLIDES = 200

/** Cap for one slide part; far above a realistic slide, far below a zip bomb. */
const MAX_SLIDE_XML_BYTES = 16 * 1024 * 1024

/** `<a:t>` (text run literal) with content; self-closing `<a:t/>` is empty. */
const TEXT_RUN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g

/** Any `<p:pic>` opening tag; pictures are never self-closed by real authors. */
const PICTURE_OPEN = /<p:pic\b/g

/** One `<p:pic>…</p:pic>` block, used for its transform. */
const PICTURE_BLOCK = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g

/** One `<p:sp>…</p:sp>` block; `\b` keeps `<p:spPr>` from matching. */
const SHAPE_BLOCK = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g

/** One `<p:graphicFrame>` block - the carrier of native tables and charts. */
const GRAPHIC_FRAME = /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g

/** The placement transform of a picture. */
const XFRM_BLOCK = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/

/** The `a:ext` inside a transform (the first is the 2D extent). */
const XFRM_EXT = /<a:ext\b[^>]*>/

/** `<p:sldSz cx cy>` — the deck's page size in EMUs. */
const SLIDE_SIZE = /<p:sldSz\b[^>]*>/

/** First central-directory entry per name; duplicate names keep the first. */
function entryMap(entries: readonly ZipEntry[]): Map<string, ZipEntry> {
  const map = new Map<string, ZipEntry>()
  for (const entry of entries) if (!map.has(entry.name)) map.set(entry.name, entry)
  return map
}

/** Read one numeric attribute out of a start tag, or 0 when absent. */
function attribute(tag: string, name: string): number {
  const match = new RegExp(`\\s${name}="(-?\\d+)"`).exec(tag)
  if (match === null) return 0
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Count non-empty `<a:t>` literals: a whitespace-only run renders nothing. */
function countTextRuns(xml: string): number {
  let count = 0
  TEXT_RUN.lastIndex = 0
  for (let match = TEXT_RUN.exec(xml); match !== null; match = TEXT_RUN.exec(xml)) {
    if ((match[1] ?? '').trim() !== '') count += 1
  }
  return count
}

/**
 * Count editable, non-picture shape blocks.
 *
 * `<p:sp>` is the container for every autoshape, text box and placeholder, so
 * "a shape exists" is not the same as "the page has object-level content": a
 * picture-filled placeholder is an `<p:sp>` whose `<p:spPr>` carries a
 * `<a:blipFill>`, i.e. a bitmap dressed as a shape. Excluding those is what
 * makes `nativeShapes` a measure of *editable* geometry.
 */
function countNativeShapes(xml: string): number {
  let count = 0
  SHAPE_BLOCK.lastIndex = 0
  for (let match = SHAPE_BLOCK.exec(xml); match !== null; match = SHAPE_BLOCK.exec(xml)) {
    if (!/<a:blipFill\b/.test(match[1] ?? '')) count += 1
  }
  return count
}

/**
 * Count shapes that carry *geometry*, not typography.
 *
 * This exists because `nativeShapes` counts text boxes too: a deck that only put
 * the OCR'd words on a blank slide still shows six "editable shapes", which made
 * the visual-loss gate below vacuous - and that is exactly the deck a real user
 * rejected as "只有文字". python-pptx marks a text box with `txBox="1"` on its
 * non-visual shape properties, so the honest measure of recovered artwork is
 * the shape blocks that are neither a picture nor a text box.
 */
function countGraphicShapes(xml: string): number {
  let count = 0
  SHAPE_BLOCK.lastIndex = 0
  for (let match = SHAPE_BLOCK.exec(xml); match !== null; match = SHAPE_BLOCK.exec(xml)) {
    const body = match[1] ?? ''
    if (/<a:blipFill\b/.test(body)) continue
    if (/<p:cNvSpPr\b[^>]*\btxBox="1"/.test(body)) continue
    count += 1
  }
  return count
}

/**
 * Count native tables (`a:tbl` inside a `p:graphicFrame`).
 *
 * A page whose graphics *are* a table - very common in business decks - carries
 * no `p:pic` and no `p:sp` geometry, so counting only those two would make the
 * visual-loss gate reject a faithful reconstruction. Tables are editable objects
 * in PowerPoint, so they count as a recovered visual layer; a screenshot of a
 * table is a `p:pic` and is counted by `pictures` instead.
 */
function countTables(xml: string): number {
  let count = 0
  GRAPHIC_FRAME.lastIndex = 0
  for (let match = GRAPHIC_FRAME.exec(xml); match !== null; match = GRAPHIC_FRAME.exec(xml)) {
    count += (match[1] ?? '').match(/<a:tbl\b/g)?.length ?? 0
  }
  return count
}

/**
 * Measure one slide's pictures and how much of the page each covers.
 *
 * The extent is read from `<a:xfrm><a:ext>`. A `p:pic` without a transform is
 * counted as a picture but with an extent of 0, because inventing a size from
 * the image's intrinsic pixels would be a guess: an absent ext means the
 * producer relies on a placeholder/group transform we did not resolve, so the
 * honest answer is "not measurable" plus a note (and therefore not full bleed).
 * @param xml - one slide part.
 * @param slideArea - page area in EMU², or 0 when `sldSz` was unreadable.
 * @returns picture counts plus the notes explaining the ones not measured.
 */
function measurePictures(xml: string, slideArea: number): { pictures: number; fullBleedPictures: number; notes: string[] } {
  const notes: string[] = []
  let pictures = 0
  PICTURE_OPEN.lastIndex = 0
  while (PICTURE_OPEN.exec(xml) !== null) pictures += 1
  let fullBleedPictures = 0
  let unmeasured = 0
  PICTURE_BLOCK.lastIndex = 0
  for (let match = PICTURE_BLOCK.exec(xml); match !== null; match = PICTURE_BLOCK.exec(xml)) {
    const xfrm = XFRM_BLOCK.exec(match[1] ?? '')
    // `exec` answers `null` (no match) where a missing xfrm answers `undefined`;
    // both mean "no extent to measure".
    const ext = xfrm === null ? undefined : XFRM_EXT.exec(xfrm[1] ?? '') ?? undefined
    if (ext === undefined) { unmeasured += 1; continue }
    const cx = attribute(ext[0], 'cx')
    const cy = attribute(ext[0], 'cy')
    if (cx === 0 || cy === 0) { unmeasured += 1; continue }
    if (slideArea > 0 && cx * cy >= slideArea * FULL_BLEED_RATIO) fullBleedPictures += 1
  }
  if (unmeasured > 0) {
    // Counted as pictures, treated as "not full bleed": a missing extent must
    // never let a screenshot page slip through the 85% rule.
    notes.push(`${unmeasured} 个 p:pic 缺少可解析的 xfrm/ext，按面积 0 处理（不计为整页位图）`)
  }
  if (slideArea === 0 && pictures > 0) notes.push('presentation.xml 缺少 sldSz，跳过 85% 面积判定')
  return { pictures, fullBleedPictures, notes }
}

/**
 * Inspect one `.pptx` package.
 *
 * A package is only treated as inspectable when it is a readable ZIP with
 * `[Content_Types].xml` (the OOXML part manifest) and a `ppt/presentation.xml`.
 * Anything else - a text file renamed to `.pptx`, a truncated download, a
 * deflate stream that will not inflate - is `undefined`, which callers must map
 * to `invalid-package` rather than "0 slides".
 * @param buffer - the whole deck file.
 * @returns the inspection, or `undefined` when this is not a usable OOXML deck.
 */
export function inspectDeck(buffer: Buffer): DeckInspection | undefined {
  const entries = readZipDirectory(buffer)
  if (entries.length === 0) return undefined
  const byName = entryMap(entries)
  const contentTypes = byName.get('[Content_Types].xml')
  const presentation = byName.get('ppt/presentation.xml')
  if (contentTypes === undefined || presentation === undefined) return undefined
  if (readZipEntry(buffer, contentTypes) === undefined) return undefined
  const presentationXml = readZipEntry(buffer, presentation)
  if (presentationXml === undefined) return undefined

  const notes: string[] = []
  // Page area is only needed for the full-bleed ratio; a missing sldSz means the
  // producer relies on the application default, which we do not guess.
  const sizeTag = SLIDE_SIZE.exec(presentationXml.toString('utf8'))
  const slideWidth = sizeTag === null ? 0 : attribute(sizeTag[0], 'cx')
  const slideHeight = sizeTag === null ? 0 : attribute(sizeTag[0], 'cy')
  const slideArea = slideWidth * slideHeight
  if (sizeTag === null) notes.push('presentation.xml 缺少 p:sldSz，整页位图判定按不可测量处理')
  else if (slideArea === 0) notes.push('p:sldSz 的 cx/cy 不可用，整页位图判定按不可测量处理')

  // Slide order comes from the part name, which is the deck's own numbering.
  const slideEntries = entries
    .map(entry => ({ entry, number: Number(SLIDE_ENTRY.exec(entry.name)?.[1] ?? NaN) }))
    .filter(item => Number.isSafeInteger(item.number) && item.number > 0)
    .sort((a, b) => a.number - b.number)
  if (slideEntries.length > MAX_SLIDES) {
    notes.push(`幻灯片部件超过 ${MAX_SLIDES} 个，只检查前 ${MAX_SLIDES} 个`)
    slideEntries.length = MAX_SLIDES
  }

  const pages: DeckSlideInspection[] = []
  for (const { entry, number } of slideEntries) {
    const xml = readZipEntry(buffer, entry, MAX_SLIDE_XML_BYTES)
    // A slide we cannot inflate makes the package undeliverable: reporting a
    // partial inspection would let a broken deck look complete.
    if (xml === undefined) return undefined
    const text = xml.toString('utf8')
    const measured = measurePictures(text, slideArea)
    pages.push({
      page: number,
      textRuns: countTextRuns(text),
      nativeShapes: countNativeShapes(text),
      graphicShapes: countGraphicShapes(text),
      tables: countTables(text),
      pictures: measured.pictures,
      fullBleedPictures: measured.fullBleedPictures,
      notes: measured.notes,
    })
  }
  if (pages.length === 0) notes.push('包内没有 ppt/slides/slideN.xml')

  const sum = (pick: (page: DeckSlideInspection) => number): number => pages.reduce((total, page) => total + pick(page), 0)
  return {
    slides: pages.length,
    textRuns: sum(page => page.textRuns),
    nativeShapes: sum(page => page.nativeShapes),
    graphicShapes: sum(page => page.graphicShapes),
    tables: sum(page => page.tables),
    pictures: sum(page => page.pictures),
    fullBleedPictures: sum(page => page.fullBleedPictures),
    notes,
    pages,
  }
}

/**
 * Whether a slide carries anything a user could edit.
 *
 * One text run is enough (a title-only page), and so is one native shape (an
 * icon-only page). A page with neither is a picture frame or a blank: there is
 * nothing to select, retype or restyle, which is exactly the failure the local
 * pipeline exists to prevent.
 */
function hasEditableContent(page: DeckSlideInspection): boolean {
  return page.textRuns > 0 || page.nativeShapes > 0
}

/**
 * Accept or refuse a produced deck.
 *
 * The four reasons are checked in dependency order - a broken package cannot be
 * counted, a wrong page count cannot be reported on, and a passing report does
 * not make a raster deck editable - so the first failing reason is the most
 * actionable one for the task card.
 *
 * `raster-only` covers three shapes of the same cheat:
 *  - the aggregate "everything is pictures" deck (`textRuns == 0` and
 *    `nativeShapes == 0` while pictures exist), which is the whole-deck
 *    screenshot dump;
 *  - any single page with no text run and no native shape (per-page detail),
 *    which is the one-screenshot-per-slide deck;
 *  - every page a full-bleed picture with no text anywhere, which survives the
 *    per-page test when the producer also drops an invisible white panel shape
 *    on each page. That is still a raster deck: the 85% rule catches it even
 *    though the page technically owns one native shape.
 * @param input - inspection (or `undefined` when the package did not parse), the
 *   number of input images, upstream's `validation.json.passed`, and the 1-based
 *   page numbers whose *source* image carried real artwork (`visualPages`).
 * @returns `{ ok: true }` or the first failing reason.
 */
export function acceptDeck(input: {
  inspection: DeckInspection | undefined
  expectedSlides: number
  reportPassed: boolean
  visualPages?: number[]
}): DeckAcceptance {
  if (input.inspection === undefined) return { ok: false, reason: 'invalid-package' }
  const inspection = input.inspection
  // A caller with no expected page count has nothing to accept against: treating
  // that as a mismatch keeps a mis-wired call from silently passing.
  if (input.expectedSlides <= 0 || inspection.slides !== input.expectedSlides) {
    return { ok: false, reason: 'slide-count' }
  }
  if (!input.reportPassed) return { ok: false, reason: 'report-not-passed' }

  if (inspection.pages.length > 0) {
    if (inspection.pages.some(page => !hasEditableContent(page))) return { ok: false, reason: 'raster-only' }
  } else if (inspection.textRuns === 0 && inspection.nativeShapes === 0) {
    // No per-page detail (a hand-built or legacy inspection): fall back to the
    // aggregate, which still refuses a deck made only of pictures.
    return { ok: false, reason: 'raster-only' }
  }
  if (inspection.fullBleedPictures >= inspection.slides && inspection.textRuns === 0) {
    return { ok: false, reason: 'raster-only' }
  }
  // A page whose *source* carried artwork must come back with a visual layer.
  // Text-only output on such a page is exactly what a real user reported: every
  // word editable, the slide itself gone. Geometry counts, plain text boxes do
  // not - otherwise a page of nothing but text boxes would pass its own gate.
  // Native tables count as a visual layer: a page whose graphic *is* a table has
  // no `p:pic` and no `p:sp`, and rejecting it would fail a faithful reconstruction.
  const visualPages = input.visualPages ?? []
  if (visualPages.length > 0 && inspection.pages.length > 0) {
    const lost = inspection.pages.some(page => visualPages.includes(page.page)
      && page.pictures === 0 && page.graphicShapes === 0 && (page.tables ?? 0) === 0)
    if (lost) return { ok: false, reason: 'visual-loss' }
  }
  return { ok: true }
}

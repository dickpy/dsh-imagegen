/**
 * Content previews for canvas file nodes.
 *
 * A file node stores arbitrary bytes, so the browser cannot be handed a URL and
 * told to render them: HTML/SVG-shaped payloads must never execute in the app's
 * origin, and office documents are ZIP containers rather than viewable pages.
 * This module turns one stored asset into a bounded, structured preview:
 *
 *  - images / PDFs / audio / video return an inline URL (the only types the
 *    asset route will serve inline — see the route's MIME allow-list);
 *  - HTML / SVG / Markdown decode whole so the client can render them as the
 *    original document (sandboxed iframe / `<img>` / rich-text renderer);
 *  - CSV / TSV / XLSX become a grid;
 *  - DOCX parses into headings, lists, tables and styled runs; PPTX into one
 *    card per slide with its text and embedded pictures;
 *  - remaining text-like / office files reuse the extractor the
 *    `extract.content` skill already relies on;
 *  - ZIP archives list their central directory.
 *
 * Every branch is bounded: a hostile or merely huge file can waste CPU here,
 * but it cannot make the host allocate unbounded memory or hang the request.
 */

import path from 'node:path'
import type {
  CanvasDocBlock, CanvasDocRun, CanvasFilePreview, CanvasSlidePreview,
} from './protocol.ts'
import { extractFileText, MAX_EXTRACTED_CHARS } from './file-text.ts'
import { baseMime, fileKindOf, isTextMime } from './canvas-store.ts'
import { isZipDirectory, readZipDirectory, readZipEntry, type ZipEntry } from './zip.ts'

/** Characters of text handed to the viewer (about 120k, ~350KB of JSON). */
export const MAX_PREVIEW_CHARS = 120_000

/** Rows / columns rendered for spreadsheets and delimited files. */
export const MAX_PREVIEW_ROWS = 300
export const MAX_PREVIEW_COLS = 40

/** Archive entries listed. */
export const MAX_PREVIEW_ENTRIES = 400

/** Blocks of a structured document preview and pages of a slide preview. */
export const MAX_PREVIEW_BLOCKS = 900
export const MAX_PREVIEW_SLIDES = 80

/** Embedded slide pictures: at most 6 per slide and 6 MB raw in total. */
export const MAX_PREVIEW_MEDIA_PER_SLIDE = 6
export const MAX_PREVIEW_MEDIA_BYTES = 6 * 1024 * 1024

/** Image MIME types every current browser renders inside an `<img>`. */
const INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/

/** Delimited text formats turned into a grid instead of a wall of commas. */
const TABLE_EXTENSIONS = new Set(['csv', 'tsv'])

/** Raster formats an `<img>` tag can show; EMF/WMF metafiles are skipped. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
}

export interface FilePreviewInput {
  data: Uint8Array
  /** Stored or client-reported MIME type. */
  mime: string
  /** Original file name when known; its extension drives the branch. */
  name?: string
  /** Same-origin URL that serves this asset inline (media previews). */
  url: string
}

function extensionOf(name: string | undefined): string {
  if (name === undefined) return ''
  return path.extname(name).replace(/^\./, '').toLowerCase()
}

function decodeText(data: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length)
  if (replacementRatio < 0.02) return utf8
  return new TextDecoder('latin1').decode(data)
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function clampText(text: string): { text: string; truncated: boolean } {
  const cap = Math.min(MAX_PREVIEW_CHARS, MAX_EXTRACTED_CHARS)
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap), truncated: true }
}

/** Split one delimited document into rows, honouring quotes and embedded newlines. */
function parseDelimited(text: string, delimiter: string): { rows: string[][]; totalRows: number } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let totalRows = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1 } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') { quoted = true; continue }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      field = ''
      totalRows += 1
      if (rows.length < MAX_PREVIEW_ROWS) rows.push(row.slice(0, MAX_PREVIEW_COLS))
      row = []
      continue
    }
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    totalRows += 1
    if (rows.length < MAX_PREVIEW_ROWS) rows.push(row.slice(0, MAX_PREVIEW_COLS))
  }
  return { rows, totalRows }
}

/** Column index of an A1-style cell reference (`B7` -> 1). */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/i.exec(reference)?.[1]
  if (letters === undefined) return 0
  let value = 0
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

/** Shared-string table of one XLSX workbook (`xl/sharedStrings.xml`). */
function readSharedStrings(buffer: Buffer, entries: ZipEntry[]): string[] {
  const entry = entries.find(item => item.name.toLowerCase() === 'xl/sharedstrings.xml')
  if (entry === undefined) return []
  const raw = readZipEntry(buffer, entry)
  if (raw === undefined) return []
  const xml = decodeText(raw)
  const out: string[] = []
  const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) !== null) {
    const body = match[1] ?? ''
    let text = ''
    const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let part: RegExpExecArray | null
    while ((part = textPattern.exec(body)) !== null) text += decodeXmlEntities(part[1] ?? '')
    out.push(text)
  }
  return out
}

/** Read the first worksheet of an XLSX workbook into a bounded grid. */
function readXlsxGrid(buffer: Buffer): { rows: string[][]; totalRows: number; truncated: boolean } | undefined {
  const entries = readZipDirectory(buffer)
  if (entries.length === 0) return undefined
  const sheets = entries
    .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  if (sheets.length === 0) return undefined
  const raw = readZipEntry(buffer, sheets[0]!)
  if (raw === undefined) return undefined
  const shared = readSharedStrings(buffer, entries)
  const xml = decodeText(raw)
  const rows: string[][] = []
  let totalRows = 0
  let more = false
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    // Stop scanning once the preview grid is full: the rest of a large sheet is
    // only ever summarised by the "truncated" flag.
    if (rows.length >= MAX_PREVIEW_ROWS) { more = true; break }
    totalRows += 1
    const body = rowMatch[1] ?? ''
    const cells: string[] = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const attributes = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const reference = /r="([A-Z]+\d+)"/i.exec(attributes)?.[1] ?? ''
      const type = /t="([a-z]+)"/i.exec(attributes)?.[1]?.toLowerCase() ?? ''
      let value = ''
      if (type === 's') {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
        value = shared[index] ?? ''
      } else if (type === 'inlinestr') {
        const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g
        let part: RegExpExecArray | null
        while ((part = textPattern.exec(inner)) !== null) value += decodeXmlEntities(part[1] ?? '')
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
        value = type === 'b' ? (raw.trim() === '1' ? 'TRUE' : 'FALSE') : decodeXmlEntities(raw)
      }
      const column = reference === '' ? cells.length : columnIndex(reference)
      if (column >= MAX_PREVIEW_COLS) continue
      while (cells.length < column) cells.push('')
      cells[column] = value
    }
    rows.push(cells.map(cell => cell ?? ''))
  }
  if (totalRows === 0) return undefined
  return { rows, totalRows, truncated: more }
}

/** Whether an on/off run property (`<w:b>` / `<w:i>`) is switched on. */
function docxRunFlag(body: string, tag: 'b' | 'i'): true | undefined {
  const pattern = new RegExp(`<w:${tag}(?=[\\s/>])[^>]*>`, 'g')
  let on = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    on = !/w:val="(?:0|false|off)"/i.test(match[0])
  }
  return on || undefined
}

/** Styled runs of one DOCX paragraph fragment; adjacent same-style runs merge. */
function docxRuns(fragment: string): CanvasDocRun[] {
  const runs: CanvasDocRun[] = []
  const runPattern = /<w:r\b[^>]*(?:\/>|>([\s\S]*?)<\/w:r>)/g
  let match: RegExpExecArray | null
  while ((match = runPattern.exec(fragment)) !== null) {
    const body = match[1] ?? ''
    let text = ''
    const partPattern = /<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g
    let part: RegExpExecArray | null
    while ((part = partPattern.exec(body)) !== null) {
      if (part[0].startsWith('<w:br')) text += '\n'
      else if (part[0].startsWith('<w:tab')) text += '\t'
      else text += decodeXmlEntities(part[1] ?? '')
    }
    if (text === '') continue
    const bold = docxRunFlag(body, 'b')
    const italic = docxRunFlag(body, 'i')
    const previous = runs.at(-1)
    if (previous !== undefined && !!previous.bold === !!bold && !!previous.italic === !!italic) {
      previous.text += text
      continue
    }
    runs.push({ text, ...(bold === undefined ? {} : { bold }), ...(italic === undefined ? {} : { italic }) })
  }
  return runs
}

/** numId -> list kind (`bullet` vs everything counted) from `word/numbering.xml`. */
function readDocxNumbering(buffer: Buffer, entries: ZipEntry[]): Map<string, boolean> {
  const orderedByNumId = new Map<string, boolean>()
  const entry = entries.find(item => item.name.toLowerCase() === 'word/numbering.xml')
  if (entry === undefined) return orderedByNumId
  const raw = readZipEntry(buffer, entry)
  if (raw === undefined) return orderedByNumId
  const xml = decodeText(raw)
  const orderedByAbstract = new Map<string, boolean>()
  const abstractPattern = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g
  let abstract: RegExpExecArray | null
  while ((abstract = abstractPattern.exec(xml)) !== null) {
    // The first level (lvl 0) decides bullet vs numbered for the whole list.
    const format = /<w:numFmt w:val="([^"]+)"/.exec(abstract[2] ?? '')?.[1]?.toLowerCase()
    orderedByAbstract.set(abstract[1]!, format !== 'bullet')
  }
  const numPattern = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"[^>]*\/>[\s\S]*?<\/w:num>/g
  let num: RegExpExecArray | null
  while ((num = numPattern.exec(xml)) !== null) {
    const ordered = orderedByAbstract.get(num[2]!)
    if (ordered !== undefined) orderedByNumId.set(num[1]!, ordered)
  }
  return orderedByNumId
}

/** Cell texts of one DOCX table (`<w:tbl>` fragment), one paragraph per line. */
function docxTableRows(fragment: string): string[][] {
  const rows: string[][] = []
  const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g
  let row: RegExpExecArray | null
  while ((row = rowPattern.exec(fragment)) !== null && rows.length < MAX_PREVIEW_ROWS) {
    const cells: string[] = []
    const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g
    let cell: RegExpExecArray | null
    while ((cell = cellPattern.exec(row[0])) !== null && cells.length < MAX_PREVIEW_COLS) {
      const paragraphs: string[] = []
      const paraPattern = /<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g
      let para: RegExpExecArray | null
      while ((para = paraPattern.exec(cell[0])) !== null) {
        const text = docxRuns(para[0]).map(run => run.text).join('').replace(/\s+/g, ' ').trim()
        if (text !== '') paragraphs.push(text)
      }
      cells.push(paragraphs.join('\n'))
    }
    rows.push(cells)
  }
  return rows
}

/** Structured preview of a DOCX body: headings, lists, tables, styled runs.
 *  Undefined when the document has no body blocks (flat extraction takes over). */
function readDocxBlocks(buffer: Buffer): { blocks: CanvasDocBlock[]; truncated: boolean } | undefined {
  const entries = readZipDirectory(buffer)
  const documentEntry = entries.find(item => item.name.toLowerCase() === 'word/document.xml')
  if (documentEntry === undefined) return undefined
  const raw = readZipEntry(buffer, documentEntry)
  if (raw === undefined) return undefined
  const xml = decodeText(raw)
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml
  const numbering = readDocxNumbering(buffer, entries)
  const blocks: CanvasDocBlock[] = []
  let truncated = false
  let chars = 0
  let list: { ordered: boolean; items: CanvasDocRun[][] } | undefined
  const flushList = (): void => {
    if (list !== undefined && list.items.length > 0) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = undefined
  }

  const scanner = /<w:tbl[ >]|<w:p[ >/]/g
  scanner.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = scanner.exec(body)) !== null) {
    if (blocks.length >= MAX_PREVIEW_BLOCKS) { truncated = true; break }
    if (match[0].startsWith('<w:p')) {
      // Word emits self-closing `<w:p/>` spacers between real paragraphs;
      // they have no close tag, so skipping them must not swallow a neighbour.
      const tagEnd = body.indexOf('>', match.index)
      if (tagEnd < 0) { truncated = true; break }
      if (body[tagEnd - 1] === '/') { scanner.lastIndex = tagEnd + 1; continue }
    }
    if (match[0].startsWith('<w:tbl')) {
      // Tables can nest; walk to the matching close tag before slicing.
      let depth = 0
      let end = -1
      const tagPattern = /<\/?w:tbl[ >]/g
      tagPattern.lastIndex = match.index
      let tag: RegExpExecArray | null
      while ((tag = tagPattern.exec(body)) !== null) {
        depth += tag[0].startsWith('</') ? -1 : 1
        if (depth === 0) { end = tag.index + tag[0].length; break }
      }
      if (end < 0) { truncated = true; break }
      flushList()
      const rows = docxTableRows(body.slice(match.index, end))
      if (rows.length > 0) blocks.push({ type: 'table', rows })
      scanner.lastIndex = end
      continue
    }
    const close = body.indexOf('</w:p>', match.index)
    if (close < 0) { truncated = true; break }
    const fragment = body.slice(match.index, close + 6)
    scanner.lastIndex = close + 6

    const style = /<w:pStyle w:val="([^"]+)"/i.exec(fragment)?.[1] ?? ''
    let headingLevel = 0
    const headingStyle = /^heading([1-9])$/i.exec(style)
    if (headingStyle !== null) headingLevel = Math.min(3, Number(headingStyle[1])) as 1 | 2 | 3
    else if (/^title$/i.test(style)) headingLevel = 1
    else if (/^subtitle$/i.test(style)) headingLevel = 2
    else {
      const outline = /<w:outlineLvl w:val="([0-8])"/i.exec(fragment)?.[1]
      if (outline !== undefined) headingLevel = Math.min(3, Number(outline) + 1) as 1 | 2 | 3
    }

    const runs = docxRuns(fragment)
    const text = runs.map(run => run.text).join('')
    if (text.trim() === '') { flushList(); continue }
    chars += text.length
    if (chars > MAX_PREVIEW_CHARS) { truncated = true; break }

    const numId = /<w:numId w:val="(\d+)"\s*\/>/i.exec(fragment)?.[1]
    if (headingLevel > 0 || numId === undefined || numId === '0') {
      flushList()
      if (headingLevel > 0) blocks.push({ type: 'heading', level: headingLevel as 1 | 2 | 3, runs })
      else blocks.push({ type: 'paragraph', runs })
      continue
    }
    const ordered = numbering.get(numId) ?? false
    if (list !== undefined && list.ordered !== ordered) flushList()
    if (list === undefined) list = { ordered, items: [] }
    list.items.push(runs)
  }
  flushList()
  if (blocks.length === 0) return undefined
  return { blocks, truncated }
}

/** Paragraph texts of one PPTX shape / table fragment (one entry per `<a:p>`). */
function slideParagraphs(fragment: string): string[] {
  const out: string[] = []
  const paragraphPattern = /<a:p\b[\s\S]*?<\/a:p>/g
  let paragraph: RegExpExecArray | null
  while ((paragraph = paragraphPattern.exec(fragment)) !== null) {
    // Slide-number / date fields would otherwise leak their rendered digits.
    let text = (paragraph[0].replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, ''))
    let value = ''
    const textPattern = /<a:t\b[^>]*\/>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
    let part: RegExpExecArray | null
    while ((part = textPattern.exec(text)) !== null) value += decodeXmlEntities(part[1] ?? '')
    value = value.replace(/\s+/g, ' ').trim()
    if (value !== '') out.push(value)
  }
  return out
}

/** Slide-deck preview: one entry per slide with title, body lines and pictures.
 *  Pictures ride along as data URLs within a shared byte budget so an
 *  image-heavy deck still comes back bounded. */
function readPptxSlides(buffer: Buffer): { slides: CanvasSlidePreview[]; truncated: boolean } | undefined {
  const entries = readZipDirectory(buffer)
  const slideEntries = entries
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  if (slideEntries.length === 0) return undefined

  /** rId -> zip path of one slide's relationship target. */
  const relsOf = (slideName: string): Map<string, string> => {
    const map = new Map<string, string>()
    const relEntry = entries.find(item => item.name.toLowerCase() === `ppt/slides/_rels/${slideName.toLowerCase()}.rels`)
    if (relEntry === undefined) return map
    const raw = readZipEntry(buffer, relEntry)
    if (raw === undefined) return map
    const relPattern = /<Relationship\b[^>]*>/g
    let rel: RegExpExecArray | null
    while ((rel = relPattern.exec(decodeText(raw))) !== null) {
      const id = /\bId="([^"]+)"/.exec(rel[0])?.[1]
      const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1]
      if (id === undefined || target === undefined) continue
      // Targets are relative to ppt/slides ("../media/image1.png").
      const stack: string[] = []
      for (const part of `ppt/slides/${target}`.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') stack.pop()
        else stack.push(part)
      }
      map.set(id, stack.join('/'))
    }
    return map
  }

  const slides: CanvasSlidePreview[] = []
  let mediaBudget = MAX_PREVIEW_MEDIA_BYTES
  let truncated = false
  for (const slideEntry of slideEntries) {
    if (slides.length >= MAX_PREVIEW_SLIDES) { truncated = true; break }
    const raw = readZipEntry(buffer, slideEntry)
    if (raw === undefined) continue
    const xml = decodeText(raw)
    const slide: CanvasSlidePreview = { lines: [], images: [] }

    const rels = relsOf(slideEntry.name.replace(/^ppt\/slides\//i, ''))
    const blipPattern = /<a:blip\b[^>]*r:embed="([^"]+)"/g
    let blip: RegExpExecArray | null
    while ((blip = blipPattern.exec(xml)) !== null && slide.images.length < MAX_PREVIEW_MEDIA_PER_SLIDE) {
      const target = rels.get(blip[1]!)
      if (target === undefined) continue
      const mime = IMAGE_MIME_BY_EXTENSION[target.split('.').pop()?.toLowerCase() ?? '']
      if (mime === undefined) continue
      const mediaEntry = entries.find(item => item.name.toLowerCase() === target.toLowerCase())
      if (mediaEntry === undefined || mediaEntry.uncompressedSize > mediaBudget) { truncated = true; continue }
      const media = readZipEntry(buffer, mediaEntry)
      if (media === undefined) continue
      mediaBudget -= media.byteLength
      slide.images.push({ mime, data: `data:${mime};base64,${media.toString('base64')}` })
    }

    const shapePattern = /<p:sp\b[\s\S]*?<\/p:sp>/g
    let shape: RegExpExecArray | null
    while ((shape = shapePattern.exec(xml)) !== null) {
      const paragraphs = slideParagraphs(shape[0])
      if (paragraphs.length === 0) continue
      if (/<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape[0]) && slide.title === undefined) slide.title = paragraphs.join(' ')
      else slide.lines.push(...paragraphs)
    }
    // Slide tables live in graphic frames outside `<p:sp>`, but their cells
    // still carry `<a:p>` paragraphs, so they surface as extra body lines.
    const tablePattern = /<a:tbl\b[\s\S]*?<\/a:tbl>/g
    let table: RegExpExecArray | null
    while ((table = tablePattern.exec(xml)) !== null) slide.lines.push(...slideParagraphs(table[0]))

    slides.push(slide)
  }
  return { slides, truncated }
}

/** Content preview of one stored canvas file asset. Never throws. */
export function buildFilePreview(input: FilePreviewInput): CanvasFilePreview {
  const name = input.name ?? ''
  const extension = extensionOf(name)
  const mime = baseMime(input.mime)
  const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
  const kind = fileKindOf(mime, name)

  // ------------------------------------------------ browser-renderable media
  if (INLINE_IMAGE_MIME.test(mime) || (kind === 'image' && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(extension))) {
    return { kind: 'media', media: 'image', url: input.url, width: 0, height: 0 }
  }
  if (mime === 'application/pdf' || extension === 'pdf') {
    return { kind: 'media', media: 'pdf', url: input.url, width: 0, height: 0 }
  }
  if (mime.startsWith('audio/')) return { kind: 'media', media: 'audio', url: input.url, width: 0, height: 0 }
  if (mime.startsWith('video/')) return { kind: 'media', media: 'video', url: input.url, width: 0, height: 0 }

  // ---------------------------------------------- rendered text-like formats
  // Markdown / HTML / SVG are decoded whole and rendered by the browser: HTML
  // inside a script-less sandboxed iframe, SVG through an `<img>` (scripts in
  // image context never run), Markdown by the client-side renderer.
  const decoded = (): string | undefined => {
    const text = decodeText(data)
    return text.includes('\u0000') ? undefined : text
  }
  if (['md', 'markdown', 'mdx'].includes(extension) || mime === 'text/markdown' || mime === 'text/x-markdown') {
    const text = decoded()
    if (text !== undefined) {
      const cut = clampText(text)
      return { kind: 'markdown', format: 'markdown', markdown: cut.text, truncated: cut.truncated }
    }
  }
  if (extension === 'html' || extension === 'htm' || mime === 'text/html') {
    const text = decoded()
    if (text !== undefined) {
      const cut = clampText(text)
      return { kind: 'html', format: 'html', html: cut.text, truncated: cut.truncated }
    }
  }
  if (extension === 'svg' || mime === 'image/svg+xml') {
    const text = decoded()
    if (text !== undefined) {
      const cut = clampText(text)
      return { kind: 'svg', format: 'svg', svg: cut.text, truncated: cut.truncated }
    }
  }

  // ------------------------------------------------------------- spreadsheets
  const looksZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b
  if (extension === 'xlsx' || mime.includes('spreadsheetml.sheet')) {
    if (looksZip) {
      const grid = readXlsxGrid(data)
      if (grid !== undefined) {
        return {
          kind: 'table',
          format: 'xlsx',
          rows: grid.rows,
          totalRows: grid.totalRows,
          truncated: grid.truncated,
        }
      }
    }
  }
  if (TABLE_EXTENSIONS.has(extension) || mime === 'text/csv' || mime === 'text/tab-separated-values') {
    const decoded = decodeText(data)
    if (!decoded.includes('\u0000')) {
      const delimiter = extension === 'tsv' || mime === 'text/tab-separated-values' ? '\t' : ','
      const parsed = parseDelimited(decoded, delimiter)
      return {
        kind: 'table',
        format: extension === '' ? 'csv' : extension,
        rows: parsed.rows,
        totalRows: parsed.totalRows,
        truncated: parsed.totalRows > parsed.rows.length,
      }
    }
  }

  // ------------------------------------------------------- plain text & docs
  if (isTextMime(mime) || kind === 'text' || kind === 'office') {
    // OOXML word processors and slide decks parse into a structure the client
    // can lay out; when nothing usable comes out, flat extraction takes over.
    if (looksZip && (extension === 'docx' || mime.includes('wordprocessingml.document'))) {
      const document = readDocxBlocks(data)
      if (document !== undefined) {
        return { kind: 'document', format: 'docx', blocks: document.blocks, truncated: document.truncated }
      }
    }
    if (looksZip && (extension === 'pptx' || mime.includes('presentationml.presentation'))) {
      const deck = readPptxSlides(data)
      if (deck !== undefined) {
        return { kind: 'slides', format: 'pptx', slides: deck.slides, truncated: deck.truncated }
      }
    }
    const extracted = extractFileText(data, name, mime)
    if (extracted.supported) {
      const cut = clampText(extracted.text)
      return {
        kind: 'text',
        format: extracted.format,
        text: cut.text,
        truncated: cut.truncated || extracted.truncated,
        lines: cut.text === '' ? 0 : cut.text.split('\n').length,
        ...extracted.warning === undefined ? {} : { warning: extracted.warning },
      }
    }
    return {
      kind: 'none',
      format: extracted.format,
      reason: 'unreadable',
      message: extracted.warning ?? '无法读取此文件的文字内容。',
    }
  }

  // ---------------------------------------------------------------- archives
  if (looksZip || kind === 'archive') {
    const entries = looksZip ? readZipDirectory(data) : []
    if (entries.length > 0) {
      return {
        kind: 'archive',
        entries: entries.slice(0, MAX_PREVIEW_ENTRIES).map(entry => ({
          name: entry.name,
          size: entry.uncompressedSize,
          dir: isZipDirectory(entry),
        })),
        totalEntries: entries.length,
        truncated: entries.length > MAX_PREVIEW_ENTRIES,
      }
    }
    return {
      kind: 'none',
      format: extension === '' ? 'archive' : extension,
      reason: 'unsupported',
      message: '这个压缩格式无法在画布内展开，请下载后用系统程序查看。',
    }
  }

  return {
    kind: 'none',
    format: extension === '' ? (mime === '' ? 'bin' : mime) : extension,
    reason: 'unsupported',
    message: '这种格式没有可读内容，请下载后查看，或先转成图片 / 文本节点再交给技能处理。',
  }
}

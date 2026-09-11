/**
 * Best-effort plain-text extraction for canvas file nodes.
 *
 * The light skill tier sends text to a chat model, so a file node needs *some*
 * readable text before it can be processed at all. This module covers the
 * formats that are genuinely extractable without native dependencies:
 *
 *  - text-like files (txt / md / csv / json / code) decode directly;
 *  - OOXML and ODF documents (docx / pptx / xlsx / odt / odp / ods) are ZIP
 *    archives of XML, so the XML parts are inflated with `node:zlib` and their
 *    text nodes are pulled out in document order;
 *  - PDFs are scanned for FlateDecode content streams and the text-showing
 *    operators are decoded.
 *
 * Anything else (images, media, archives, opaque binaries) reports
 * `supported: false` with a reason instead of silently returning noise, so the
 * UI can suggest the heavy agent tier instead.
 */

import { inflateSync } from 'node:zlib'
import { readZipDirectory, readZipEntry } from './zip.ts'

/** Cap on extracted text handed to a model (about 200k characters). */
export const MAX_EXTRACTED_CHARS = 200_000

export interface ExtractedFileText {
  /** Whether this format can be read as text at all. */
  supported: boolean
  /** Human-readable file format bucket, used in messages. */
  format: string
  text: string
  /** True when the text was cut at {@link MAX_EXTRACTED_CHARS}. */
  truncated: boolean
  /** Present when `supported` is false, or when extraction was only partial. */
  warning?: string
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'swift', 'sql', 'sh', 'bat', 'ps1', 'lua', 'r', 'pl', 'vue', 'svelte',
])

const OOXML_PART_PATTERN = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|ppt\/notesSlides\/notesSlide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|content\.xml)$/i
const ODF_PART_PATTERN = /^content\.xml$/i

/** Decode bytes as UTF-8, falling back to a Latin-1 read for odd encodings. */
function decodeText(data: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length)
  if (replacementRatio < 0.02) return utf8
  return new TextDecoder('latin1').decode(data)
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim())
  return match === null ? '' : match[1]!.toLowerCase()
}

/** Strip XML markup and decode the entities OOXML/ODF bodies actually use. */
function xmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/w:tr>/gi, '\n')
    .replace(/<w:tab\b[^>]*\/>|<a:br\b[^>]*\/>/gi, '\t')
  const stripped = withBreaks.replace(/<[^>]*>/g, '')
  return stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Pull readable text out of a PDF's FlateDecode content streams. */
function extractPdfText(data: Buffer): string {
  const chunks: string[] = []
  const marker = Buffer.from('stream')
  let cursor = 0
  while (cursor < data.length && chunks.length < 400) {
    const at = data.indexOf(marker, cursor)
    if (at < 0) break
    let start = at + marker.length
    if (data[start] === 0x0d) start += 1
    if (data[start] === 0x0a) start += 1
    const end = data.indexOf(Buffer.from('endstream'), start)
    if (end < 0) break
    cursor = end + 9
    const raw = data.subarray(start, end)
    let inflated: Buffer | undefined
    try { inflated = inflateSync(raw) } catch { inflated = undefined }
    if (inflated === undefined) continue
    const content = inflated.toString('latin1')
    if (!/BT[\s\S]{0,4000}?ET/.test(content)) continue
    const texts: string[] = []
    const pattern = /\((?:\\.|[^\\()])*\)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const inner = match[0]!.slice(1, -1)
      const decoded = inner
        .replace(/\\([nrtbf])/g, (_, code: string) => code === 'n' ? '\n' : code === 'r' ? '\n' : code === 't' ? '\t' : '')
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
      if (decoded.trim() !== '') texts.push(decoded)
    }
    if (texts.length > 0) chunks.push(texts.join(' '))
  }
  return chunks.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_EXTRACTED_CHARS), truncated: true }
}

/**
 * Extract readable text from one stored file asset.
 * @param data - raw file bytes.
 * @param name - original file name (drives the format decision).
 * @param mime - stored MIME type, used when the name has no extension.
 * @returns extraction result; never throws for malformed input.
 */
export function extractFileText(data: Uint8Array, name: string, mime = ''): ExtractedFileText {
  const extension = extensionOf(name)
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const looksZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
  const looksPdf = buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-'

  if (looksPdf || extension === 'pdf') {
    const text = extractPdfText(buffer)
    const cut = truncate(text)
    if (text.trim() === '') {
      return {
        supported: false,
        format: 'pdf',
        text: '',
        truncated: false,
        warning: 'PDF 未能提取到可读文字（可能是扫描件或使用了非标准编码），建议改用「重任务」技能或先转成图片节点走视觉模型。',
      }
    }
    return {
      supported: true,
      format: 'pdf',
      text: cut.text,
      truncated: cut.truncated,
      warning: 'PDF 文字为启发式提取，复杂排版可能丢失顺序。',
    }
  }

  if (looksZip) {
    const entries = readZipDirectory(buffer)
    const isOdf = entries.some(entry => ODF_PART_PATTERN.test(entry.name))
    const wanted = entries.filter(entry => isOdf ? ODF_PART_PATTERN.test(entry.name) : OOXML_PART_PATTERN.test(entry.name))
    if (wanted.length > 0) {
      const parts: string[] = []
      for (const entry of wanted.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
        const raw = readZipEntry(buffer, entry)
        if (raw === undefined) continue
        const text = xmlToText(decodeText(raw))
        if (text !== '') parts.push(text)
      }
      const joined = parts.join('\n\n')
      const cut = truncate(joined)
      const format = extension === '' ? (isOdf ? 'odf' : 'ooxml') : extension
      if (joined.trim() === '') {
        return {
          supported: false,
          format,
          text: '',
          truncated: false,
          warning: '文档里没有提取到文字（可能是纯图片幻灯片或表格）。可以先转成图片节点，再交给视觉模型处理。',
        }
      }
      return { supported: true, format, text: cut.text, truncated: cut.truncated }
    }
    return {
      supported: false,
      format: extension === '' ? 'zip' : extension,
      text: '',
      truncated: false,
      warning: '压缩包不能直接抽取内容，请先解压后上传其中的文档。',
    }
  }

  const textLike = TEXT_EXTENSIONS.has(extension)
    || mime.startsWith('text/')
    || mime === 'application/json'
    || mime === 'application/xml'
    || mime === 'application/x-yaml'
    || mime === 'application/yaml'
  if (textLike) {
    const decoded = decodeText(buffer)
    const cut = truncate(decoded)
    return { supported: true, format: extension === '' ? 'text' : extension, text: cut.text, truncated: cut.truncated }
  }

  return {
    supported: false,
    format: extension === '' ? 'binary' : extension,
    text: '',
    truncated: false,
    warning: `无法把 .${extension === '' ? 'bin' : extension} 文件当作文本读取，请换用支持该格式的技能，或先转成文本/图片节点。`,
  }
}

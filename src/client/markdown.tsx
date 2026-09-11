/**
 * Minimal dependency-free Markdown renderer for canvas file previews.
 *
 * Everything parses into React elements — there is no `dangerouslySetInnerHTML`
 * anywhere — so a hostile document cannot inject markup: text arrives in React
 * text nodes, links are restricted to safe protocols, and block structure is
 * deliberately simple (headings, paragraphs, fenced code, quotes, lists, GFM
 * tables, images, emphasis). The host already caps the source, so every loop
 * below is bounded by the 120k-character preview cap.
 */

import { Fragment, type ReactNode } from 'react'

/** Protocols an `<a>` may point at; anything else stays plain text. */
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i
/** Protocols an `<img>` may load; image data URLs are inert by construction. */
const SAFE_IMAGE = /^(?:https?:\/\/|data:image\/)/i

/**
 * One inline pass: code spans, links, autolinks (bracketed and bare), images,
 * bold, italic and strikethrough. Built per call because block parsing
 * recurses (quotes) and a shared /g regex would tangle its lastIndex state.
 */
const INLINE_SOURCE = [
  '(`+)([\\s\\S]*?)\\1', //                                        1-2 code span
  '!\\[([^\\]]*)\\]\\(\\s*([^)\\s]*)(?:\\s+"[^"]*")?\\s*\\)', //    3-4 image
  '\\[([^\\]]*)\\]\\(\\s*([^)\\s]*)(?:\\s+"[^"]*")?\\s*\\)', //     5-6 link
  '<(https?:\\/\\/[^>\\s]+|mailto:[^>\\s]+)>', //                          7 autolink
  '(https?:\\/\\/[^\\s<>()\\[\\]{}"\'\u201c\u201d\u2018\u2019\uff0c\u3002\uff1b\uff1a\uff01\uff1f\uff08\uff09\u3010\u3011\u300a\u300b]+)', // 8 bare URL
  '\\*\\*([\\s\\S]+?)\\*\\*', //                                     9 **bold**
  '__([\\s\\S]+?)__', //                                            10 __bold__
  '~~([\\s\\S]+?)~~', //                                            11 ~~strike~~
  '\\*([^\\s*](?:[^*\\n]*[^\\s*])?)\\*', //                          12 *italic*
].join('|')

function renderInline(source: string, keyPrefix: string): ReactNode[] {
  const pattern = new RegExp(INLINE_SOURCE, 'g')
  const nodes: ReactNode[] = []
  let last = 0
  let serial = 0
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (match.index > last) nodes.push(source.slice(last, match.index))
    const key = `${keyPrefix}i${serial++}`
    if (match[2] !== undefined) {
      nodes.push(<code key={key}>{match[2].replace(/^\n|\n$/g, '')}</code>)
    } else if (match[4] !== undefined) {
      const alt = match[3] ?? ''
      nodes.push(SAFE_IMAGE.test(match[4])
        ? <img key={key} src={match[4]} alt={alt} loading="lazy" draggable={false} />
        : alt)
    } else if (match[6] !== undefined) {
      const label = match[5] ?? ''
      nodes.push(SAFE_LINK.test(match[6])
        ? <a key={key} href={match[6]} target="_blank" rel="noreferrer noopener">{renderInline(label, key)}</a>
        : label)
    } else if (match[7] !== undefined) {
      nodes.push(<a key={key} href={match[7]} target="_blank" rel="noreferrer noopener">{match[7]}</a>)
    } else if (match[8] !== undefined) {
      nodes.push(<a key={key} href={match[8]} target="_blank" rel="noreferrer noopener">{match[8]}</a>)
    } else if (match[9] !== undefined || match[10] !== undefined) {
      nodes.push(<strong key={key}>{renderInline(match[9] ?? match[10] ?? '', key)}</strong>)
    } else if (match[11] !== undefined) {
      nodes.push(<del key={key}>{renderInline(match[11]!, key)}</del>)
    } else if (match[12] !== undefined) {
      nodes.push(<em key={key}>{renderInline(match[12]!, key)}</em>)
    }
    last = pattern.lastIndex
  }
  if (last < source.length) nodes.push(source.slice(last))
  return nodes
}

/** A line that ends the current paragraph and starts one of the block forms. */
const BLOCK_START = /^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|(?:[-*+]|\d{1,9}[.)])\s)/

function splitTableRow(row: string): string[] {
  let value = row.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map(cell => cell.trim())
}

function renderBlocks(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let serial = 0
  const key = (): string => `${keyPrefix}b${serial++}`
  let cursor = 0
  while (cursor < lines.length) {
    const line = lines[cursor]!
    if (line.trim() === '') { cursor += 1; continue }

    // fenced code ``` / ~~~
    const fence = /^(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const body: string[] = []
      cursor += 1
      while (cursor < lines.length && !lines[cursor]!.startsWith(marker)) { body.push(lines[cursor]!); cursor += 1 }
      if (cursor < lines.length) cursor += 1
      nodes.push(<pre key={key()}><code>{body.join('\n')}</code></pre>)
      continue
    }

    // heading
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1]!.length, 6)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      nodes.push(<Tag key={key()}>{renderInline(heading[2]!, key())}</Tag>)
      cursor += 1
      continue
    }

    // thematic break
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { nodes.push(<hr key={key()} />); cursor += 1; continue }

    // blockquote
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (cursor < lines.length && /^\s*>/.test(lines[cursor]!)) {
        quoted.push(lines[cursor]!.replace(/^\s*>\s?/, ''))
        cursor += 1
      }
      nodes.push(<blockquote key={key()}>{renderBlocks(quoted, key())}</blockquote>)
      continue
    }

    // GFM table: header row, then a delimiter row of dashes
    if (line.includes('|') && cursor + 1 < lines.length
      && /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(lines[cursor + 1]!) && lines[cursor + 1]!.includes('|')) {
      const header = splitTableRow(line)
      cursor += 2
      const rows: string[][] = []
      while (cursor < lines.length && lines[cursor]!.trim() !== '' && lines[cursor]!.includes('|') && rows.length < 200) {
        rows.push(splitTableRow(lines[cursor]!))
        cursor += 1
      }
      nodes.push(
        <table key={key()}>
          <thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, key())}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, rowIndex) => <tr key={rowIndex}>
              {header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '', key())}</td>)}
            </tr>)}
          </tbody>
        </table>,
      )
      continue
    }

    // lists (nested by two-space indentation)
    const firstItem = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line)
    if (firstItem !== null) {
      interface DocListItem { node: ReactNode; children: DocListFrame[] }
      interface DocListFrame { ordered: boolean; items: DocListItem[] }
      const stack: DocListFrame[] = []
      const renderFrame = (frame: DocListFrame, keyPrefix: string): ReactNode => {
        const items = frame.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {item.node}
            {item.children.map((child, childIndex) => renderFrame(child, `${keyPrefix}-${childIndex}`))}
          </li>
        ))
        return frame.ordered ? <ol key={keyPrefix}>{items}</ol> : <ul key={keyPrefix}>{items}</ul>
      }
      const release = (frame: DocListFrame): void => {
        const parent = stack.at(-1)
        if (parent !== undefined && parent.items.length > 0) parent.items.at(-1)!.children.push(frame)
        else nodes.push(renderFrame(frame, key()))
      }
      const closeTo = (level: number): void => {
        while (stack.length > level + 1) release(stack.pop()!)
      }
      while (cursor < lines.length) {
        const item = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(lines[cursor]!)
        if (item === null) break
        const level = Math.min(4, Math.floor(item[1]!.length / 2))
        const ordered = item[2] === undefined
        closeTo(level)
        if (stack.length === level + 1 && stack[level]!.ordered !== ordered) release(stack.pop()!)
        if (stack.length < level + 1) stack.push({ ordered, items: [] })
        const frame = stack.at(-1)!
        frame.ordered = ordered
        frame.items.push({ node: renderInline(item[4]!, key()), children: [] })
        cursor += 1
      }
      // -1 flushes every open frame, including the root list itself.
      closeTo(-1)
      continue
    }

    // paragraph: everything until a blank line or the next block form
    const paragraph: string[] = []
    while (cursor < lines.length && lines[cursor]!.trim() !== '' && !BLOCK_START.test(lines[cursor]!)) {
      paragraph.push(lines[cursor]!)
      cursor += 1
    }
    nodes.push(<p key={key()}>{renderInline(paragraph.join('\n'), key())}</p>)
  }
  return nodes
}

/** Render one Markdown document into React block elements. */
export function renderMarkdown(source: string): ReactNode[] {
  return renderBlocks(source.replace(/\r\n?/g, '\n').split('\n'), 'md')
}

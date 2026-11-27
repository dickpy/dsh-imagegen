import { useEffect, useRef, useState, type CSSProperties, type Key, type ReactNode } from 'react'
import type { GeneratedImage } from '../protocol.ts'
import { planResultLayout } from './result-layout.ts'
import css from './studio-results.module.css'

export interface ResultImageSize {
  width: number
  height: number
}

interface ResultSheetItem {
  key: Key
  image: GeneratedImage | undefined
  /** Pending and error details need the entire cell. */
  keepFullCell?: boolean
}

/** The shared sheet for live results and opened history or gallery records. */
export function ResultSheet({ items, renderCard }: {
  items: ResultSheetItem[]
  renderCard: (index: number, size: ResultImageSize | undefined, onImageLoad: (element: HTMLImageElement) => void) => ReactNode
}): React.JSX.Element {
  const [decodedSizes] = useState(() => new WeakMap<GeneratedImage, ResultImageSize>())
  const [, refresh] = useState(0)
  const [sheetWidth, setSheetWidth] = useState(0)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const sizes = items.map(({ image }) => {
    if (image === undefined) return undefined
    const { width, height } = image
    return width !== undefined && height !== undefined && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : decodedSizes.get(image)
  })
  const aspects = sizes.map(size => size === undefined ? undefined : size.width / size.height)
  const layout = planResultLayout({ count: items.length, aspects, width: sheetWidth })
  const { rows, scroll } = layout
  const allLandscape = aspects.every(aspect => aspect !== undefined && aspect >= 1.2)
  const dynamic = sheetWidth > 0 && items.length > 2 && !(allLandscape && items.length <= 4)
  const landscapePair = items.length === 2 && sizes.every(size => size !== undefined && size.width > size.height)

  useEffect(() => {
    const node = gridRef.current
    if (node === null) return
    const measure = (): void => { setSheetWidth(node.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return <div
    ref={gridRef}
    className={css.grid}
    data-count={items.length <= 4 ? String(items.length) : 'many'}
    data-result-preview-grid="" data-dynamic={dynamic ? '' : undefined}
    data-rows={rows.length}
    data-scroll={scroll ? '' : undefined}
    data-landscape-pair={landscapePair ? '' : undefined}
  >
    {rows.map((row, rowIndex) => (
      <div className={css.row} key={rowIndex} data-result-row={rowIndex}>
        {row.map(index => {
          const { key, image, keepFullCell } = items[index]!
          const size = sizes[index]
          const fit = size !== undefined && !keepFullCell
          return <div
            key={key}
            className={css.cell}
            data-fit-image={fit ? '' : undefined}
            style={fit ? { '--result-aspect': size.width / size.height } as CSSProperties : undefined}
          >
            {renderCard(index, size, element => {
              if (image === undefined || size !== undefined) return
              const { naturalWidth: width, naturalHeight: height } = element
              if (width > 0 && height > 0 && !decodedSizes.has(image)) {
                decodedSizes.set(image, { width, height })
                refresh(version => version + 1)
              }
            })}
          </div>
        })}
      </div>
    ))}
  </div>
}


import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { tt } from './helpers.ts'
import css from './mask-editor.module.css'

type Stroke = { erase: boolean; width: number; points: { x: number; y: number }[] }

/** A full-resolution PNG alpha mask. Transparent pixels are the editable area. */
export function MaskEditor({ src, onApply, onClose }: { src: string; onApply: (mask: string) => void; onClose: () => void }): React.JSX.Element {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [brush, setBrush] = useState(5)
  const [erase, setErase] = useState(false)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [error, setError] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<Stroke | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => { dialogRef.current?.focus() }, [])
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas === null || ctx === null || ctx === undefined) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const stroke of strokes) {
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
      ctx.strokeStyle = '#f04452'; ctx.fillStyle = '#f04452'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.lineWidth = stroke.width * Math.min(size.width, size.height)
      const first = stroke.points[0]
      if (first === undefined) continue
      ctx.beginPath(); ctx.arc(first.x * size.width, first.y * size.height, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.moveTo(first.x * size.width, first.y * size.height)
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * size.width, point.y * size.height)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }, [strokes, size])
  const point = (event: PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  const apply = (): void => {
    const selection = canvasRef.current
    if (selection === null || size.width < 2) return
    const pixels = selection.getContext('2d')!.getImageData(0, 0, size.width, size.height).data
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) { setError(tt('mask.empty')); return }
    const mask = document.createElement('canvas'); mask.width = size.width; mask.height = size.height
    const ctx = mask.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height)
    ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selection, 0, 0)
    onApply(mask.toDataURL('image/png'))
  }
  return createPortal(<div className={css.overlay} onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={css.dialog} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tt('mask.title')} data-mask-editor="" onKeyDown={event => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input')
        if (!controls?.length) return
        if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); controls[controls.length - 1]?.focus() }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus() }
      }
    }}>
      <header><strong>{tt('mask.title')}</strong><button type="button" aria-label={tt('preview.close')} onClick={onClose}>×</button></header>
      <p>{tt('mask.hint')}</p>
      <div className={css.tools}>
        <button type="button" aria-pressed={!erase} onClick={() => setErase(false)}>{tt('mask.brush')}</button>
        <button type="button" aria-pressed={erase} onClick={() => setErase(true)}>{tt('mask.eraser')}</button>
        <label>{tt('mask.size')}<input type="range" min="1" max="25" value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
        <button type="button" disabled={!strokes.length} onClick={() => setStrokes(previous => previous.slice(0, -1))}>{tt('mask.undo')}</button>
        <button type="button" disabled={!strokes.length} onClick={() => setStrokes([])}>{tt('mask.clear')}</button>
      </div>
      <div className={css.stage}><div className={css.imageWrap}>
        <img src={src} alt={tt('mask.source')} draggable={false} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError(tt('mask.loadFailed'))} />
        <canvas ref={canvasRef} width={size.width} height={size.height} aria-label={tt('mask.paint')} onPointerDown={event => {
          if (event.button !== 0 || size.width < 2) return
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
          const stroke = { erase, width: brush / 100, points: [point(event)] }
          drawing.current = stroke; setStrokes(previous => [...previous, stroke]); setError('')
        }} onPointerMove={event => {
          if (drawing.current === null) return
          drawing.current = { ...drawing.current, points: [...drawing.current.points, point(event)] }
          const next = drawing.current; setStrokes(previous => [...previous.slice(0, -1), next])
        }} onPointerUp={() => { drawing.current = null }} onPointerCancel={() => { drawing.current = null }} />
      </div></div>
      {error && <p role="alert">{error}</p>}
      <footer><small>{size.width > 1 ? `${size.width} × ${size.height}` : ''}</small><button type="button" onClick={onClose}>{tt('mask.cancel')}</button><button type="button" disabled={size.width < 2 || strokes.length === 0} onClick={apply}>{tt('mask.apply')}</button></footer>
    </div>
  </div>, document.body)
}

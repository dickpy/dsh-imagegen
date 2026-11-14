/**
 * "Reverse prompt" dialog: read one reference or generated image into a reusable
 * generation prompt.
 *
 * The host owns the vision model, the detail shaping and the output-language
 * instruction; this dialog only collects the three knobs, uploads the image as
 * a canvas asset (the same content-addressed store the canvas uses), and hands
 * the returned text back to the studio composer.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ScanText, Copy, ArrowDownToLine, X } from 'lucide-react'
import { StudioActionButton } from './StudioActionButton.tsx'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './panel.module.css'

/** How much of the image the host describes. */
type ReverseDetail = 'brief' | 'standard' | 'detailed'
/** Which language the returned prompt should be written in. */
type ReverseOutput = 'follow' | 'zh' | 'en'

const DETAIL_OPTIONS: Array<{ value: ReverseDetail; label: 'canvas.reverse.detailBrief' | 'canvas.reverse.detailStandard' | 'canvas.reverse.detailDetailed' }> = [
  { value: 'brief', label: 'canvas.reverse.detailBrief' },
  { value: 'standard', label: 'canvas.reverse.detailStandard' },
  { value: 'detailed', label: 'canvas.reverse.detailDetailed' },
]

const OUTPUT_OPTIONS: Array<{ value: ReverseOutput; label: 'canvas.reverse.outputFollow' | 'canvas.reverse.outputZh' | 'canvas.reverse.outputEn' }> = [
  { value: 'follow', label: 'canvas.reverse.outputFollow' },
  { value: 'zh', label: 'canvas.reverse.outputZh' },
  { value: 'en', label: 'canvas.reverse.outputEn' },
]

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  width: 'min(560px, calc(100vw - 48px))',
  maxHeight: 'min(680px, calc(100vh - 48px))',
  padding: '18px 20px',
  overflow: 'auto',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 24px 64px rgb(0 0 0 / 32%)',
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }
const labelStyle: CSSProperties = { flex: '0 0 auto', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }
const controlStyle: CSSProperties = { flex: 1, minWidth: 0, padding: '6px 8px', font: 'inherit', fontSize: 13, color: 'inherit', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }
const footerStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }

export function ReversePromptDialog({ api, file, onUse, close, autoApply = false }: {
  api: ImageGenApi
  /** The image to read, decoded from a reference or generated result. */
  file: File
  /** Hand the returned prompt to the studio composer. */
  onUse: (prompt: string) => void
  close: () => void
  /** Reference-image entry: run once on open, then fill the composer and close. */
  autoApply?: boolean
}): React.JSX.Element {
  // Re-render on locale change, matching the rest of the panel.
  useImageGenLanguageTick()
  const root = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<ReverseDetail>('standard')
  const [output, setOutput] = useState<ReverseOutput>('follow')
  const [extra, setExtra] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const autoStarted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Escape closes, Tab stays inside the dialog, and focus returns to whatever
  // opened it — the same contract the PPT dialog had.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (autoApply) root.current?.focus()
    else root.current?.querySelector<HTMLElement>('select, input, button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    root.current?.addEventListener('keydown', onKey)
    const element = root.current
    return () => { element?.removeEventListener('keydown', onKey); previous?.focus() }
    // Mount-only: `close` is a fresh arrow function each render, and re-binding
    // would pull focus out of whichever field the user is typing in.
  }, [])

  const run = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true)
    setError('')
    setCopied(false)
    try {
      const asset = await api.canvasFileUpload(file)
      if (!mounted.current) return
      const prompt = await api.reversePrompt({
        images: [asset],
        detail,
        output,
        ...extra.trim() === '' ? {} : { instruction: extra.trim() },
      })
      if (!mounted.current) return
      setResult(prompt)
      if (autoApply) { onUse(prompt); close() }
    } catch (caught) {
      if (mounted.current) setError(tt('prompt.reverse.failed', { message: errorMessage(caught) }))
    } finally {
      inFlight.current = false
      if (mounted.current) setRunning(false)
    }
  }, [api, file, detail, output, extra, autoApply, onUse, close])

  useEffect(() => {
    if (!autoApply || autoStarted.current) return
    autoStarted.current = true
    void run()
  }, [autoApply, run])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result)
      if (mounted.current) setCopied(true)
    } catch {
      // Clipboard unavailable (permissions / insecure context): leave the
      // textarea as the source of truth rather than claiming a copy happened.
      if (mounted.current) setCopied(false)
    }
  }, [result])

  return createPortal(
    <div
      className={css.lightbox}
      data-reverse-dialog=""
      onClick={event => { if (event.target === event.currentTarget) close() }}
    >
      <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tt('prompt.reverse.title')} style={cardStyle}>
        <header>
          <strong style={{ fontSize: 14 }}>{tt('prompt.reverse.title')}</strong>
          <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' }}>{tt('prompt.reverse.hint')}</p>
          <p data-reverse-source="" style={{ margin: '6px 0 0', fontSize: 12, overflowWrap: 'anywhere' }}>{file.name}</p>
        </header>

        <div style={rowStyle}>
          <label style={labelStyle} htmlFor="dsh-imagegen-reverse-detail">{tt('prompt.reverse.detail')}</label>
          <select
            id="dsh-imagegen-reverse-detail"
            style={controlStyle}
            value={detail}
            disabled={running}
            onChange={event => { setDetail(event.target.value as ReverseDetail) }}
          >
            {DETAIL_OPTIONS.map(option => <option key={option.value} value={option.value}>{tt(option.label)}</option>)}
          </select>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle} htmlFor="dsh-imagegen-reverse-output">{tt('prompt.reverse.output')}</label>
          <select
            id="dsh-imagegen-reverse-output"
            style={controlStyle}
            value={output}
            disabled={running}
            onChange={event => { setOutput(event.target.value as ReverseOutput) }}
          >
            {OUTPUT_OPTIONS.map(option => <option key={option.value} value={option.value}>{tt(option.label)}</option>)}
          </select>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle} htmlFor="dsh-imagegen-reverse-extra">{tt('prompt.reverse.extra')}</label>
          <input
            id="dsh-imagegen-reverse-extra"
            style={controlStyle}
            type="text"
            value={extra}
            disabled={running}
            placeholder={tt('prompt.reverse.extraPlaceholder')}
            onChange={event => { setExtra(event.target.value) }}
          />
        </div>

        <textarea
          readOnly
          data-reverse-result=""
          aria-label={tt('prompt.reverse.title')}
          placeholder={tt('prompt.reverse.empty')}
          value={result}
          style={{ ...controlStyle, flex: 'none', minHeight: 96, resize: 'vertical', lineHeight: 1.5 }}
        />

        {error !== '' ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-brand-primary)' }}>{error}</p> : null}
        {error === '' && running ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{tt('prompt.reverse.running')}</p> : null}
        {error === '' && !running && result === '' ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{tt('prompt.reverse.empty')}</p> : null}

        <footer style={footerStyle}>
          <StudioActionButton icon={<X />} onClick={close}>{tt('preview.close')}</StudioActionButton>
          <StudioActionButton icon={<Copy />} disabled={result === ''} onClick={() => { void copy() }}>{copied ? tt('prompt.reverse.copied') : tt('prompt.reverse.copy')}</StudioActionButton>
          <StudioActionButton icon={<ArrowDownToLine />} disabled={result === ''} onClick={() => { onUse(result); close() }}>{tt('prompt.reverse.use')}</StudioActionButton>
          <StudioActionButton icon={<ScanText />} variant="primary" data-reverse-run="" disabled={running} onClick={() => { void run() }}>
            {running ? tt('prompt.reverse.running') : tt('prompt.reverse.run')}
          </StudioActionButton>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

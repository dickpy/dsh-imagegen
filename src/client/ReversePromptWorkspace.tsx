/** Inline image-to-prompt workspace. Opening or selecting an image never runs a request. */
import { useEffect, useRef, useState } from 'react'
import { ScanText, Copy, ArrowDownToLine, Upload, Settings } from 'lucide-react'
import { StudioActionButton } from './StudioActionButton.tsx'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './reverse-workspace.module.css'

export function ReversePromptWorkspace({ api, file, onFile, ready, onSettings, onUse }: {
  api: ImageGenApi
  file: File | null
  onFile: (file: File) => void
  ready: boolean
  onSettings: () => void
  onUse: (text: string) => void
}): React.JSX.Element {
  useImageGenLanguageTick()
  const [detail, setDetail] = useState<'brief' | 'standard' | 'detailed'>('standard')
  const [output, setOutput] = useState<'follow' | 'zh' | 'en'>('follow')
  const [extra, setExtra] = useState('')
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const epoch = useRef(0)
  const busy = useRef(false)
  const currentFile = useRef(file)
  currentFile.current = file
  useEffect(() => {
    epoch.current++
    busy.current = false
    setRunning(false); setResult(''); setError(''); setCopied(false); setPreview('')
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPreview(String(reader.result))
    reader.readAsDataURL(file)
    return () => { epoch.current++; reader.abort() }
  }, [file])
  useEffect(() => () => { epoch.current++ }, [])

  const select = (files: FileList | File[]): void => {
    const image = Array.from(files).find(candidate => candidate.type.startsWith('image/'))
    if (image) onFile(image)
  }
  const run = async (): Promise<void> => {
    if (!file || busy.current) return
    if (!ready) { onSettings(); return }
    const token = epoch.current, source = file
    const valid = (): boolean => token === epoch.current && currentFile.current === source
    busy.current = true
    setRunning(true); setError(''); setCopied(false)
    try {
      const asset = await api.canvasFileUpload(file)
      if (!valid()) return
      const text = await api.reversePrompt({ images: [asset], detail, output, ...(extra.trim() ? { instruction: extra.trim() } : {}) })
      if (valid()) setResult(text)
    } catch (caught) {
      if (valid()) setError(tt('prompt.reverse.failed', { message: errorMessage(caught) }))
    } finally {
      if (valid()) { busy.current = false; setRunning(false) }
    }
  }
  return <section className={css.workspace} data-reverse-workspace="" aria-label={tt('prompt.reverse.title')}
    onDragOver={event => { event.preventDefault() }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); select(event.dataTransfer.files) }}
    onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); event.stopPropagation(); select(event.clipboardData.files) } }}>
    <header className={css.header}>
      <span className={css.eyebrow}>IMAGE → PROMPT</span>
      <h2>{tt('prompt.reverse.title')}</h2>
      <p>{tt('prompt.reverse.hint')}</p>
    </header>
    <div className={css.columns}>
      <div className={css.source}>
        <h3>01 · {tt('prompt.reverse.source')}</h3>
        <input ref={input} hidden type="file" accept="image/*" data-reverse-upload="" onChange={event => { select(event.target.files ?? []); event.target.value = '' }} />
        <button className={css.upload} type="button" onClick={() => input.current?.click()} aria-label={tt('prompt.reverse.upload')}>
          {preview ? <img src={preview} alt={file?.name ?? ''} /> : <><Upload size={28} /><strong>{tt('prompt.reverse.upload')}</strong><span>{tt('prompt.reverse.drop')}</span></>}
        </button>
        {file ? <div className={css.file}><span data-reverse-source="">{file.name}</span><StudioActionButton icon={<Upload />} onClick={() => input.current?.click()}>{tt('prompt.reverse.change')}</StudioActionButton></div> : null}
        <div className={css.parameters}>
          <label>{tt('prompt.reverse.detail')}<select data-reverse-detail="" value={detail} disabled={running} onChange={event => setDetail(event.target.value as typeof detail)}>
            <option value="brief">{tt('canvas.reverse.detailBrief')}</option><option value="standard">{tt('canvas.reverse.detailStandard')}</option><option value="detailed">{tt('canvas.reverse.detailDetailed')}</option>
          </select></label>
          <label>{tt('prompt.reverse.output')}<select data-reverse-output="" value={output} disabled={running} onChange={event => setOutput(event.target.value as typeof output)}>
            <option value="follow">{tt('canvas.reverse.outputFollow')}</option><option value="zh">{tt('canvas.reverse.outputZh')}</option><option value="en">{tt('canvas.reverse.outputEn')}</option>
          </select></label>
        </div>
        <label className={css.extra}>{tt('prompt.reverse.extra')}<textarea data-reverse-extra="" value={extra} disabled={running} placeholder={tt('prompt.reverse.extraPlaceholder')} onChange={event => setExtra(event.target.value)} /></label>
        {!ready ? <StudioActionButton icon={<Settings />} onClick={onSettings}>{tt('prompt.reverse.configure')}</StudioActionButton> : null}
        <StudioActionButton variant="primary" icon={<ScanText />} data-reverse-run="" disabled={!file || running} onClick={() => { void run() }}>{running ? tt('prompt.reverse.running') : tt('prompt.reverse.run')}</StudioActionButton>
      </div>
      <div className={css.result}>
        <h3>02 · {tt('prompt.reverse.result')}</h3>
        <textarea data-reverse-result="" aria-label={tt('prompt.reverse.result')} placeholder={tt('prompt.reverse.empty')} value={result} onChange={event => { setResult(event.target.value); setCopied(false) }} />
        <p className={css.status} role={error ? 'alert' : 'status'}>{error || (running ? tt('prompt.reverse.running') : tt('prompt.reverse.review'))}</p>
        <footer>
          <StudioActionButton icon={<Copy />} disabled={!result.trim() || running} onClick={() => {
            void navigator.clipboard.writeText(result).then(() => setCopied(true)).catch(() => setCopied(false))
          }}>{copied ? tt('prompt.reverse.copied') : tt('prompt.reverse.copy')}</StudioActionButton>
          <StudioActionButton variant="primary" icon={<ArrowDownToLine />} data-reverse-use="" disabled={!result.trim() || running} onClick={() => onUse(result)}>{tt('prompt.reverse.use')}</StudioActionButton>
        </footer>
      </div>
    </div>
  </section>
}

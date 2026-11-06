/** Local visual fixture; no provider requests or simulated percentage. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GenerationLoading } from '../src/client/GenerationLoading'
import { GenerationDurationBadge } from '../src/client/GenerationDurationBadge.tsx'
import css from '../src/client/panel.module.css'

function Fixture() {
  const [mode, setMode] = useState('文生图')
  const [state, setState] = useState('running')
  const [dark, setDark] = useState(false)
  const [models, setModels] = useState(1)
  const title = state === 'queued' ? '任务排队中…' : state === 'submitting' ? '正在提交任务…' : '正在生成图片…'
  return <div data-dark={dark} className="fixture">
    <header><strong>DSH · 生图动画</strong>
      <select aria-label="模式" value={mode} onChange={event => setMode(event.target.value)}><option>文生图</option><option>图生图</option></select>
      <select aria-label="状态" value={state} onChange={event => setState(event.target.value)}>{['submitting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'mixed'].map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="对比模型数" value={models} onChange={event => setModels(Number(event.target.value))}>{[1, 2, 4].map(value => <option key={value}>{value}</option>)}</select>
      <label><input type="checkbox" checked={dark} onChange={event => setDark(event.target.checked)} />深色</label>
    </header>
    <main className={css.canvas}>
      {models > 1 ? <section className={css.comparisonBoard} aria-label="多模型对比">
        <header><strong>{mode} · 多模型对比</strong><span>各模型独立生成</span></header>
        <div className={css.comparisonGrid}>{Array.from({ length: models }, (_, index) => {
          const status = state === 'mixed' ? ['completed', 'running', 'queued', 'failed'][index] : state
          return <article key={index} data-comparison-task={`model-${index}`} data-task-status={status}>
            <strong>{['GPT Image 2', 'Grok Imagine', 'Seedream', 'Nano Banana'][index]}</strong>
            {status === 'completed' ? <button className={css.comparisonImageButton}><img alt="已完成的本地示例" src={'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"><rect width="600" height="700" fill="#dfdad0"/><rect x="210" y="220" width="180" height="300" rx="22" fill="#f8f6ec"/><rect x="236" y="160" width="128" height="80" rx="10" fill="#687764"/><text x="300" y="380" text-anchor="middle" font-family="serif" font-size="40" fill="#687764">pure.</text></svg>')} /><GenerationDurationBadge durationMs={[62345, 125000, 0, undefined][index]} /></button>
              : ['submitting', 'queued', 'running'].includes(status!) ? <div className={css.comparisonPending} role="status"><GenerationLoading compact title={status === 'queued' ? '任务排队中…' : '正在生成图片…'} hint="已用时 24 秒" /></div>
                : <span>{status === 'failed' ? '失败' : '已取消'}</span>}
          </article>
        })}</div>
      </section> : ['submitting', 'queued', 'running'].includes(state)
        ? <div className={`${css.canvasState} ${css.generationState}`} role="status" data-generation-state={state}><GenerationLoading title={title} hint={state === 'queued' ? '当前有 1 个任务等待处理' : '已用时 24 秒'} /></div>
        : <div className={css.canvasState} role="status">{state === 'completed' ? '图片已生成' : state === 'failed' ? '生成失败，请重试' : '任务已取消'}</div>}
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

import type { CanvasSkillTask } from '../protocol.ts'
import { tt } from './helpers.ts'
import css from './ppt-workspace.module.css'

/** Visual recovery below this share means the page is probably still text-only. */
const LOW_FIDELITY_PERCENT = 60

/**
 * 「图形 9 个 · 贴图 2 个 · 视觉还原 61%」.
 *
 * `progress.pages[]` carries panels/bitmaps/lines/fidelity only for pages the
 * local reconstruction actually measured, so every part is printed or skipped
 * on its own: agent-path pages and tasks stored before these fields existed
 * show the plain state chip, and nothing here is ever estimated client-side
 * (the repo convention is no invented percentages).
 */
function visualSummary(page: { panels?: number; bitmaps?: number; fidelity?: number }): string {
  return visualParts(page).join(' · ')
}

/** The reported metrics of one page, in display order (empty when the host measured nothing). */
function visualParts(page: { panels?: number; bitmaps?: number; fidelity?: number }): string[] {
  const parts: string[] = []
  if (typeof page.panels === 'number') parts.push(tt('ppt.visualPanels', { count: page.panels }))
  if (typeof page.bitmaps === 'number') parts.push(tt('ppt.visualBitmaps', { count: page.bitmaps }))
  // protocol.ts documents fidelity as the 0-100 share of the source's non-text ink.
  if (typeof page.fidelity === 'number') parts.push(tt('ppt.visualFidelity', { percent: Math.round(page.fidelity) }))
  return parts
}

export function PptProgressCard({ task, clock, visualMode, onDiagnostic }: { task: CanvasSkillTask; clock: number; visualMode?: 'hybrid' | 'regions' | 'text'; onDiagnostic: () => void }) {
  const progress = task.progress
  const active = task.status === 'queued' || task.status === 'running'
  const idle = Math.max(0, Math.floor((clock - (progress?.lastActivityAt ?? task.startedAt)) / 1000))
  const log = <ol className={css.activityLog}>{progress?.events.map((event, index) => <li key={index} data-state={event.state}>
    <time>{new Date(event.time).toLocaleTimeString()}</time><span>{event.label}</span>
  </li>)}</ol>
  return <section className={css.progressCard} data-ppt-progress="">
    <header><strong>{tt('ppt.progressTitle')}</strong><button type="button" data-ppt-diagnostic="" onClick={onDiagnostic}>{tt('ppt.diagnostic')}</button></header>
    {active ? <><p className={css.currentOperation} role="status">{progress?.currentOperation || task.stage || tt('ppt.working')}</p>
      <small>{tt('ppt.lastActivity', { seconds: idle })}</small>
      {idle >= 60 ? <p className={css.idleNote}>{tt('ppt.idleNote')}</p> : null}</> : null}
    {progress?.pages ? <div className={css.pageProgress}><strong>{tt('ppt.pageProgress', { done: progress.pages.filter(page => page.state === 'validated').length, total: progress.pages.length })}</strong>
      <ul>{progress.pages.map(page => {
        const fidelity = typeof page.fidelity === 'number' ? Math.round(page.fidelity) : undefined
        return <li key={page.page} data-state={page.state}>{tt('ppt.progressPage', { page: page.page })}<span>{tt(`ppt.pageState.${page.state}`)}</span>
          {visualParts(page).length > 0 ? <span data-ppt-visual="">{visualSummary(page)}</span> : null}
          {/* 低还原是提示不是失败：沿用 .pageProgress li span 的灰色小字，不套 error 红。 */}
          {fidelity !== undefined && fidelity < LOW_FIDELITY_PERCENT ? <span data-ppt-visual="low">{tt('ppt.visualLow')}</span> : null}
          {visualMode === 'text' ? <span data-ppt-visual="mode">{tt('ppt.visualModeTextOnly')}</span> : null}
        </li>
      })}</ul>
    </div> : null}
    {progress?.events.length ? active ? log : <details><summary>{tt('ppt.activityHistory')}</summary>{log}</details> : active ? <p>{tt('ppt.waitingActivity')}</p> : null}
  </section>
}

import { useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationSessionTarget } from './session-target.ts'
import { activeImageGenLanguage, type ImageGenLanguage } from './helpers.ts'
import css from './panel.module.css'

export interface ConversationSessionPickerLabels {
  title: string
  hint: string
  /** Accessible name of the target list. */
  target: string
  search: string
  empty: string
  /** Template holding `{count}`, e.g. "{count} conversations". */
  count: string
  running: string
  jump: string
  confirm: string
  cancel: string
}

const LOCALE_TAGS: Record<ImageGenLanguage, string> = { zh: 'zh-CN', en: 'en', ru: 'ru' }

/**
 * Host-updated time, phrased for scanning: a long list of conversation titles
 * is much easier to tell apart when each row says when it last moved.
 */
function formatUpdatedAt(time: number): string {
  const tag = LOCALE_TAGS[activeImageGenLanguage()]
  const elapsed = Math.max(0, Date.now() - time)
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' })
  // "40 seconds ago" reads like a stopwatch; anything inside a minute is "now".
  if (elapsed < 60_000) return relative.format(0, 'second')
  if (elapsed < 3_600_000) return relative.format(-Math.round(elapsed / 60_000), 'minute')
  if (elapsed < 86_400_000) return relative.format(-Math.round(elapsed / 3_600_000), 'hour')
  if (elapsed < 7 * 86_400_000) return relative.format(-Math.round(elapsed / 86_400_000), 'day')
  return new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric' }).format(new Date(time))
}

/** Last path segment, so a workspace hint stays one short word. */
function pathHint(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

/**
 * Require a deliberate target choice when DSH has no current session id.
 *
 * The previous version was a native `<select>`: one line per conversation, no
 * search, no sense of recency, and no way to see the workspace — unreadable
 * once a user has more than a handful of conversations (the reported list was
 * 25 entries tall). This is a searchable list with keyboard navigation instead:
 * ↑/↓ move, Enter confirms, Esc cancels, and a double-click picks a row.
 */
export function ConversationSessionPicker(props: {
  options: readonly ConversationSessionTarget[]
  labels: ConversationSessionPickerLabels
  onSelect: (sessionId: SessionId) => void
  onCancel: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<SessionId | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { options, labels, onSelect, onCancel } = props

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter(option => `${option.title}\n${option.cwd ?? ''}`.toLowerCase().includes(needle))
  }, [options, query])

  // The selection is an identity, not a position: filtering a row away must
  // clear the choice instead of silently highlighting whichever row slid up.
  const activeIndex = activeId === null ? -1 : filtered.findIndex(option => option.id === activeId)
  const active = activeIndex >= 0 ? filtered[activeIndex] : undefined
  const confirm = (): void => { if (active !== undefined) onSelect(active.id) }
  const move = (delta: number): void => {
    if (filtered.length === 0) return
    const next = activeIndex < 0
      ? (delta > 0 ? 0 : filtered.length - 1)
      : Math.min(filtered.length - 1, Math.max(0, activeIndex + delta))
    setActiveId(filtered[next]!.id)
    listRef.current?.querySelector<HTMLElement>(`[data-session-index="${next}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }

  return <div
    className={css.conversationPicker}
    role="dialog"
    aria-modal="true"
    aria-label={labels.title}
    data-dsh-imagegen-session-picker
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'Enter' && active !== undefined) {
        event.preventDefault()
        confirm()
      }
    }}
  >
    <section className={css.conversationPickerBody}>
      <header className={css.conversationPickerHeader}>
        <h2>{labels.title}</h2>
        <p>{labels.hint}</p>
      </header>
      <label className={css.conversationPickerSearch}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="M13 13l-2.8-2.8" /></svg>
        <input
          autoFocus
          type="search"
          value={query}
          aria-label={labels.search}
          placeholder={labels.search}
          data-session-search=""
          onChange={event => { setQuery(event.target.value) }}
        />
      </label>
      <div className={css.conversationPickerList} role="listbox" aria-label={labels.target} ref={listRef} data-session-list="">
        {filtered.map((option, index) => <button
          key={option.id}
          type="button"
          role="option"
          aria-selected={option.id === activeId}
          className={css.conversationPickerRow}
          data-active={option.id === activeId ? '' : undefined}
          data-session-id={option.id}
          data-session-index={index}
          onClick={() => { setActiveId(option.id) }}
          onDoubleClick={() => { onSelect(option.id) }}
        >
          <span className={css.conversationPickerRowTitle} title={option.title}>{option.title}</span>
          <span className={css.conversationPickerRowMeta}>
            {option.updatedAt === undefined ? null : <span>{formatUpdatedAt(option.updatedAt)}</span>}
            {option.cwd === undefined ? null : <span className={css.conversationPickerPath} title={option.cwd}>{pathHint(option.cwd)}</span>}
            {option.running === true ? <span className={css.conversationPickerRunning}>{labels.running}</span> : null}
          </span>
        </button>)}
        {filtered.length === 0 ? <p className={css.conversationPickerEmpty}>{labels.empty}</p> : null}
      </div>
      <footer className={css.conversationPickerFooter}>
        <div className={css.conversationPickerFooterInfo}>
          <span className={css.conversationPickerCount}>{labels.count.replace('{count}', String(filtered.length))}</span>
          <span className={css.conversationPickerJump}>{labels.jump}</span>
        </div>
        <div className={css.conversationPickerActions}>
          <button type="button" onClick={onCancel}>{labels.cancel}</button>
          <button type="button" data-session-confirm="" disabled={active === undefined} onClick={confirm}>{labels.confirm}</button>
        </div>
      </footer>
    </section>
  </div>
}

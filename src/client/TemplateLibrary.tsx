/**
 * Prompt-template library overlay: a searchable, category-filtered gallery of
 * the bundled awesome-gpt-image-2 cases. The case list is served by the host
 * (bundled snapshot, optionally refreshed online); reference images load
 * lazily through the host's caching proxy, so browsing progressively mirrors
 * the gallery onto the local disk. Picking a template hands its prompt back
 * to the studio form.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { TEMPLATES_API, type TemplateCase, type TemplateListResult } from '../protocol.ts'
import css from './templates.module.css'

/** Concurrent image downloads while caching the whole gallery offline. */
const CACHE_ALL_CONCURRENCY = 4

/** Same-origin URL of one case's reference image (host caching proxy). */
function imageUrlOf(item: TemplateCase): string {
  return `${TEMPLATES_API.image}/${encodeURIComponent(item.image)}`
}

/** A card thumbnail that falls back to a placeholder when the proxy 404s. */
function TemplateThumb(props: { item: TemplateCase }) {
  const [failed, setFailed] = useState(false)
  if (props.item.image === '' || failed) {
    return (
      <span className={css.thumbPlaceholder} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      </span>
    )
  }
  return (
    <img
      className={css.thumb}
      src={imageUrlOf(props.item)}
      alt={props.item.title}
      loading="lazy"
      onError={() => { setFailed(true) }}
    />
  )
}

/** The template-library modal. Rendered through a portal above the studio. */
export function TemplateLibrary(props: {
  api: ImageGenApi
  /** Hand a picked prompt back to the studio form and close the library. */
  onUse: (prompt: string) => void
  onClose: () => void
}) {
  const { api, onUse, onClose } = props
  const [list, setList] = useState<TemplateListResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<TemplateCase | null>(null)
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [cacheAll, setCacheAll] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 })
  const searchRef = useRef<HTMLInputElement>(null)
  const load = (): void => {
    api.templatesList()
      .then(result => { setList(result); setLoadError(null) })
      .catch(caught => { setLoadError(errorMessage(caught)) })
  }

  // Load once on open; focus the search box for immediate typing.
  useEffect(() => {
    load()
    searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const categories = useMemo(() => {
    if (list === null) return [] as Array<{ key: string; label: string; count: number }>
    const counts = new Map<string, { label: string; count: number }>()
    for (const item of list.cases) {
      const entry = counts.get(item.category) ?? { label: item.categoryZh || item.category, count: 0 }
      entry.count += 1
      counts.set(item.category, entry)
    }
    return [...counts.entries()].map(([key, value]) => ({ key, label: value.label, count: value.count }))
  }, [list])

  const filtered = useMemo(() => {
    if (list === null) return [] as TemplateCase[]
    const needle = query.trim().toLowerCase()
    return list.cases.filter(item => {
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return item.title.toLowerCase().includes(needle)
        || item.prompt.toLowerCase().includes(needle)
        || item.sourceLabel.toLowerCase().includes(needle)
    })
  }, [list, query, category])

  // Escape backs out of the detail view first, then closes the modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (selected !== null) setSelected(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, onClose])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setNotice(null)
    try {
      const result = await api.templatesRefresh()
      const reloaded = await api.templatesList()
      setList(reloaded)
      setLoadError(null)
      setNotice(tt('templates.refreshed', { count: result.total }))
    } catch (caught) {
      setNotice(tt('templates.refreshFailed', { error: errorMessage(caught) }))
    } finally {
      setRefreshing(false)
    }
  }

  /** Mirror every reference image through the host cache (offline browsing). */
  const cacheAllImages = async (): Promise<void> => {
    if (cacheAll.running || list === null) return
    const files = [...new Set(list.cases.map(item => item.image).filter(name => name !== ''))]
    setCacheAll({ running: true, done: 0, total: files.length })
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const file = files[index]!
        index += 1
        try {
          await fetch(`${TEMPLATES_API.image}/${encodeURIComponent(file)}`)
        } catch { /* individual failures are retried on the next run */ }
        setCacheAll(current => ({ ...current, done: current.done + 1 }))
      }
    }
    await Promise.all(Array.from({ length: CACHE_ALL_CONCURRENCY }, () => worker()))
    setCacheAll({ running: false, done: files.length, total: files.length })
  }

  const copyPrompt = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copiedOk = document.execCommand('copy')
        textarea.remove()
        if (!copiedOk) throw new Error('copy failed')
      }
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1800)
    } catch {
      setCopied(false)
    }
  }

  const originLabel = list === null ? '' : tt(list.origin === 'refreshed' ? 'templates.origin.refreshed' : 'templates.origin.bundled')

  return createPortal(
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={tt('templates.title')} onClick={onClose}>
      <section className={css.shell} onClick={(event) => { event.stopPropagation() }}>
        <header className={css.header}>
          <span className={css.heading}>
            <h3 className={css.title}>{tt('templates.title')}</h3>
            {list !== null ? (
              <span className={css.meta}>{tt('templates.meta', { count: list.total, origin: originLabel })}</span>
            ) : null}
          </span>
          <span className={css.headerActions}>
            <Button variant="outline" size="sm" disabled={refreshing || cacheAll.running} onClick={() => { void refresh() }}>
              {refreshing ? tt('templates.refreshing') : tt('templates.refresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={list === null || cacheAll.running}
              title={tt('templates.cacheAllHint')}
              onClick={() => { void cacheAllImages() }}
            >
              {cacheAll.running
                ? tt('templates.caching', { done: cacheAll.done, total: cacheAll.total })
                : cacheAll.total > 0 && cacheAll.done === cacheAll.total
                  ? tt('templates.cached')
                  : tt('templates.cacheAll')}
            </Button>
            <button type="button" className={css.close} aria-label={tt('templates.close')} title={tt('templates.close')} onClick={onClose}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
          </span>
        </header>

        <div className={css.toolbar}>
          <input
            ref={searchRef}
            type="search"
            className={css.search}
            placeholder={tt('templates.search')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <div className={css.categoryRow}>
            <button
              type="button"
              className={css.categoryPill}
              data-active={category === '' ? '' : undefined}
              onClick={() => { setCategory('') }}
            >
              {tt('templates.all')}{list !== null ? ` ${list.total}` : ''}
            </button>
            {categories.map(entry => (
              <button
                key={entry.key}
                type="button"
                className={css.categoryPill}
                data-active={category === entry.key ? '' : undefined}
                onClick={() => { setCategory(entry.key) }}
              >
                {entry.label} {entry.count}
              </button>
            ))}
          </div>
        </div>

        {notice !== null ? <div className={css.notice} role="status">{notice}</div> : null}

        <div className={css.body}>
          {list === null && loadError === null ? (
            <div className={css.state} role="status">
              <span className={css.spinner} />
              <span>{tt('templates.loading')}</span>
            </div>
          ) : null}

          {loadError !== null ? (
            <div className={css.state} role="alert">
              <span>{tt('templates.loadFailed', { error: loadError })}</span>
              <Button variant="outline" size="sm" onClick={() => { setLoadError(null); setList(null); load() }}>
                {tt('templates.retry')}
              </Button>
            </div>
          ) : null}

          {list !== null && filtered.length === 0 ? (
            <div className={css.state}>{tt('templates.empty')}</div>
          ) : null}

          {list !== null && filtered.length > 0 ? (
            <div className={css.grid}>
              {filtered.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={css.card}
                  onClick={() => { setSelected(item); setCopied(false) }}
                >
                  <span className={css.thumbWrap}>
                    <TemplateThumb item={item} />
                    {item.featured ? <span className={css.featuredBadge}>{tt('templates.featured')}</span> : null}
                  </span>
                  <span className={css.cardBody}>
                    <span className={css.cardTitle}>{item.title}</span>
                    <span className={css.cardMeta}>
                      <span className={css.cardCategory}>{item.categoryZh || item.category}</span>
                      {item.sourceLabel !== '' ? <span className={css.cardSource}>{item.sourceLabel}</span> : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <footer className={css.footer}>
          <span className={css.attribution}>{tt('templates.attribution')}</span>
          <a className={css.sourceLink} href="https://vibeui.top/" target="_blank" rel="noreferrer">
            {tt('templates.source')}
          </a>
        </footer>
      </section>

      {selected !== null ? (
        <div className={css.detailOverlay} onClick={() => { setSelected(null) }}>
          <section className={css.detail} onClick={(event) => { event.stopPropagation() }}>
            <div className={css.detailMedia}>
              {selected.image !== '' ? (
                <img className={css.detailImage} src={imageUrlOf(selected)} alt={selected.title} />
              ) : (
                <span className={css.thumbPlaceholder} aria-hidden="true" />
              )}
            </div>
            <div className={css.detailInfo}>
              <h4 className={css.detailTitle}>{selected.title}</h4>
              <div className={css.detailMeta}>
                <span className={css.cardCategory}>{selected.categoryZh || selected.category}</span>
                {selected.sourceUrl !== '' ? (
                  <a className={css.detailLink} href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.sourceLabel || selected.sourceUrl}</a>
                ) : null}
                {selected.githubUrl !== '' ? (
                  <a className={css.detailLink} href={selected.githubUrl} target="_blank" rel="noreferrer">GitHub</a>
                ) : null}
              </div>
              <pre className={css.detailPrompt}>{selected.prompt}</pre>
              <div className={css.detailActions}>
                <Button variant="primary" size="md" onClick={() => { onUse(selected.prompt) }}>
                  {tt('templates.use')}
                </Button>
                <Button variant="outline" size="md" onClick={() => { void copyPrompt(selected.prompt) }}>
                  {copied ? tt('templates.copied') : tt('templates.copy')}
                </Button>
                <Button variant="outline" size="md" onClick={() => { setSelected(null) }}>
                  {tt('templates.back')}
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

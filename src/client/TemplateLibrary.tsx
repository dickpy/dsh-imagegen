/**
 * Prompt-template library overlay: a multi-source, searchable, category-
 * filtered gallery. Each registered source (TEMPLATE_SOURCES) renders as its
 * own tab with an independent list, refresh state, and image pool; case lists
 * are served by the host (bundled snapshot, optionally refreshed online or
 * auto-synced in the background) and reference images load lazily through the
 * host's caching proxy, so browsing progressively mirrors the gallery onto the
 * local disk. Templates can be starred; favorites persist host-side as full
 * case snapshots and are reachable through the ★ filter pill per tab. Picking
 * a template hands its prompt back to the studio form.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { TEMPLATE_SOURCES, TEMPLATES_API, type TemplateCase, type TemplateFavorite, type TemplateListResult } from '../protocol.ts'
import css from './templates.module.css'

/** Concurrent image downloads while caching the whole gallery offline. */
const CACHE_ALL_CONCURRENCY = 4

/** Stable favorites key of one case within a source. */
function favoriteKeyOf(sourceId: string, item: TemplateCase): string {
  return `${sourceId}:${item.id}`
}

/** Same-origin URL of one case's reference image (host caching proxy). */
function imageUrlOf(sourceId: string, item: TemplateCase): string {
  return `${TEMPLATES_API.image}/${encodeURIComponent(sourceId)}/${encodeURIComponent(item.image)}`
}

/** A card thumbnail that falls back to a placeholder when the proxy 404s. */
function TemplateThumb(props: { sourceId: string; item: TemplateCase }) {
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
      src={imageUrlOf(props.sourceId, props.item)}
      alt={props.item.title}
      loading="lazy"
      onError={() => { setFailed(true) }}
    />
  )
}

/** Card-corner star toggle; the click must not open the detail view. Rendered
 *  as a span (a button cannot nest inside the card button). */
function FavoriteStar(props: { active: boolean; title: string; onToggle: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={css.favStar}
      data-active={props.active ? '' : undefined}
      aria-label={props.title}
      title={props.title}
      onClick={(event) => { event.stopPropagation(); props.onToggle() }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.stopPropagation()
        event.preventDefault()
        props.onToggle()
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill={props.active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>
    </span>
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
  const [activeSource, setActiveSource] = useState(TEMPLATE_SOURCES[0]!.id)
  const [lists, setLists] = useState<Record<string, TemplateListResult>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [favorites, setFavorites] = useState<TemplateFavorite[]>([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [selected, setSelected] = useState<TemplateCase | null>(null)
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [cacheAll, setCacheAll] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 })
  const searchRef = useRef<HTMLInputElement>(null)

  const list = lists[activeSource]
  const loadError = loadErrors[activeSource] || null

  /** Fetch one source's list into the per-source cache. */
  const loadSource = (sourceId: string): void => {
    api.templatesList(sourceId)
      .then(result => {
        setLists(current => ({ ...current, [sourceId]: result }))
        setLoadErrors(current => ({ ...current, [sourceId]: '' }))
      })
      .catch(caught => { setLoadErrors(current => ({ ...current, [sourceId]: errorMessage(caught) })) })
  }

  // Load the first source plus the favorites on open; focus the search box.
  useEffect(() => {
    loadSource(TEMPLATE_SOURCES[0]!.id)
    api.favoritesList().then(setFavorites).catch(() => { /* favorites stay empty; toggling retries */ })
    searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchSource = (sourceId: string): void => {
    if (sourceId === activeSource) return
    setActiveSource(sourceId)
    setCategory('')
    setFavoritesOnly(false)
    setSelected(null)
    setNotice(null)
    if (lists[sourceId] === undefined) loadSource(sourceId)
  }

  const categories = useMemo(() => {
    if (list === undefined) return [] as Array<{ key: string; label: string; count: number }>
    const counts = new Map<string, { label: string; count: number }>()
    for (const item of list.cases) {
      const entry = counts.get(item.category) ?? { label: item.categoryZh || item.category, count: 0 }
      entry.count += 1
      counts.set(item.category, entry)
    }
    return [...counts.entries()].map(([key, value]) => ({ key, label: value.label, count: value.count }))
  }, [list])

  /** Favorites of the active source, as standalone case snapshots. */
  const activeFavorites = useMemo(
    () => favorites.filter(entry => entry.sourceId === activeSource).map(entry => entry.case),
    [favorites, activeSource],
  )
  const favKeys = useMemo(() => new Set(favorites.map(entry => entry.key)), [favorites])

  const filtered = useMemo(() => {
    const pool = favoritesOnly ? activeFavorites : list?.cases ?? []
    const needle = query.trim().toLowerCase()
    return pool.filter(item => {
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return item.title.toLowerCase().includes(needle)
        || item.prompt.toLowerCase().includes(needle)
        || item.sourceLabel.toLowerCase().includes(needle)
    })
  }, [list, activeFavorites, favoritesOnly, query, category])

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
      const result = await api.templatesRefresh(activeSource)
      const reloaded = await api.templatesList(activeSource)
      setLists(current => ({ ...current, [activeSource]: reloaded }))
      setNotice(tt('templates.refreshed', { count: result.total }))
    } catch (caught) {
      setNotice(tt('templates.refreshFailed', { error: errorMessage(caught) }))
    } finally {
      setRefreshing(false)
    }
  }

  /** Star / unstar one template of the active source. */
  const toggleFavorite = (item: TemplateCase): void => {
    const key = favoriteKeyOf(activeSource, item)
    const pending = favKeys.has(key)
      ? api.favoritesRemove(key)
      : api.favoritesAdd(activeSource, item)
    pending.then(setFavorites).catch(() => { /* leave the star as-is on failure */ })
  }

  /** Mirror every reference image of the active source through the host cache. */
  const cacheAllImages = async (): Promise<void> => {
    if (cacheAll.running || list === undefined) return
    const files = [...new Set(list.cases.map(item => item.image).filter(name => name !== ''))]
    setCacheAll({ running: true, done: 0, total: files.length })
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const file = files[index]!
        index += 1
        try {
          await fetch(`${TEMPLATES_API.image}/${encodeURIComponent(activeSource)}/${encodeURIComponent(file)}`)
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

  const originLabel = list === undefined ? '' : tt(list.origin === 'refreshed' ? 'templates.origin.refreshed' : 'templates.origin.bundled')
  const activeMeta = TEMPLATE_SOURCES.find(source => source.id === activeSource)!

  return createPortal(
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={tt('templates.title')} onClick={onClose}>
      <section className={css.shell} onClick={(event) => { event.stopPropagation() }}>
        <header className={css.header}>
          <span className={css.heading}>
            <h3 className={css.title}>{tt('templates.title')}</h3>
            {list !== undefined ? (
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
              disabled={list === undefined || cacheAll.running}
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

        <div className={css.sourceTabs} role="tablist" aria-label={tt('templates.sources')}>
          {TEMPLATE_SOURCES.map(source => (
            <button
              key={source.id}
              type="button"
              role="tab"
              aria-selected={source.id === activeSource}
              className={css.sourceTab}
              data-active={source.id === activeSource ? '' : undefined}
              title={source.description}
              onClick={() => { switchSource(source.id) }}
            >
              {source.label}
              {lists[source.id] !== undefined ? <span className={css.sourceTabCount}>{lists[source.id]!.total}</span> : null}
            </button>
          ))}
        </div>

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
              data-active={favoritesOnly ? '' : undefined}
              title={tt('templates.favoritesHint')}
              onClick={() => { setFavoritesOnly(value => !value) }}
            >
              ★ {tt('templates.favorites')}{activeFavorites.length > 0 ? ` ${activeFavorites.length}` : ''}
            </button>
            <button
              type="button"
              className={css.categoryPill}
              data-active={!favoritesOnly && category === '' ? '' : undefined}
              onClick={() => { setFavoritesOnly(false); setCategory('') }}
            >
              {tt('templates.all')}{list !== undefined ? ` ${list.total}` : ''}
            </button>
            {categories.map(entry => (
              <button
                key={entry.key}
                type="button"
                className={css.categoryPill}
                data-active={!favoritesOnly && category === entry.key ? '' : undefined}
                onClick={() => { setFavoritesOnly(false); setCategory(entry.key) }}
              >
                {entry.label} {entry.count}
              </button>
            ))}
          </div>
        </div>

        {notice !== null ? <div className={css.notice} role="status">{notice}</div> : null}

        <div className={css.body}>
          {list === undefined && loadError === null ? (
            <div className={css.state} role="status">
              <span className={css.spinner} />
              <span>{tt('templates.loading')}</span>
            </div>
          ) : null}

          {loadError !== null ? (
            <div className={css.state} role="alert">
              <span>{tt('templates.loadFailed', { error: loadError })}</span>
              <Button variant="outline" size="sm" onClick={() => { setLoadErrors(current => ({ ...current, [activeSource]: '' })); loadSource(activeSource) }}>
                {tt('templates.retry')}
              </Button>
            </div>
          ) : null}

          {loadError === null && (list !== undefined || favoritesOnly) && filtered.length === 0 ? (
            <div className={css.state}>
              {favoritesOnly && activeFavorites.length === 0 ? tt('templates.favoritesEmpty') : tt('templates.empty')}
            </div>
          ) : null}

          {filtered.length > 0 ? (
            <div className={css.grid}>
              {filtered.map(item => (
                <button
                  key={`${activeSource}:${item.id}`}
                  type="button"
                  className={css.card}
                  onClick={() => { setSelected(item); setCopied(false) }}
                >
                  <span className={css.thumbWrap}>
                    <TemplateThumb sourceId={activeSource} item={item} />
                    {item.featured ? <span className={css.featuredBadge}>{tt('templates.featured')}</span> : null}
                    <FavoriteStar
                      active={favKeys.has(favoriteKeyOf(activeSource, item))}
                      title={favKeys.has(favoriteKeyOf(activeSource, item)) ? tt('templates.favoriteRemove') : tt('templates.favoriteAdd')}
                      onToggle={() => { toggleFavorite(item) }}
                    />
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
          <a className={css.sourceLink} href={activeMeta.homepage} target="_blank" rel="noreferrer">
            {tt('templates.source', { label: activeMeta.label })}
          </a>
        </footer>
      </section>

      {selected !== null ? (
        <div className={css.detailOverlay} onClick={() => { setSelected(null) }}>
          <section className={css.detail} onClick={(event) => { event.stopPropagation() }}>
            <div className={css.detailMedia}>
              {selected.image !== '' ? (
                <img className={css.detailImage} src={imageUrlOf(activeSource, selected)} alt={selected.title} />
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
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => { toggleFavorite(selected) }}
                >
                  {favKeys.has(favoriteKeyOf(activeSource, selected)) ? tt('templates.unfavorite') : tt('templates.favorite')}
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

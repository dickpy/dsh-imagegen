/**
 * Prompt-template library overlay: a multi-source, searchable, category-
 * filtered gallery. Each registered source (TEMPLATE_SOURCES) renders as its
 * own tab with an independent list, refresh state, and image pool; case lists
 * are served by the host (bundled snapshot, optionally refreshed online or
 * auto-synced in the background) and reference images load lazily through the
 * host's caching proxy, so browsing progressively mirrors the gallery onto the
 * local disk. Templates can be starred; favorites persist host-side as full
 * case snapshots and are reachable through a top-level tab grouped by source.
 * Picking a template hands its prompt back and closes the library.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { BookOpen, Maximize2, Minimize2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { errorMessage, tt } from './helpers.ts'
import { TEMPLATE_SOURCES, TEMPLATES_API, type TemplateCase, type TemplateFavorite, type TemplateListResult } from '../protocol.ts'
import { DRAWER_WIDTH_KEY, readDrawerWidth, readRecentTemplates, rememberTemplate, type TemplateApplyMode, type TemplateEntry } from './template-library-state.ts'
import css from './templates.module.css'


/** Detail-view selection keeps its source so proxy URLs and stars stay scoped. */
interface SelectedTemplate extends TemplateEntry {}

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

/** Shared floating entry, positioned inside the active creation workspace. */
export function TemplateLibraryButton(props: { onClick: () => void; expanded: boolean }): React.JSX.Element {
  return <button type="button" className={css.floatingEntry} data-template-library-trigger="" aria-label={tt('templates.open')} aria-haspopup="dialog" aria-expanded={props.expanded} onPointerDown={event => event.stopPropagation()} onClick={props.onClick}>
    <BookOpen size={18} aria-hidden="true" /><span>{tt('templates.shortLabel')}</span>
  </button>
}

/** The shared wide drawer. Existing callers keep the same prompt callback. */
export function TemplateLibrary(props: {
  api: ImageGenApi
  /** Hand a picked prompt back to the studio form and close the library. */
  onUse: (prompt: string, mode?: TemplateApplyMode) => void
  anchor?: HTMLElement | null
  hasExistingPrompt?: boolean
  appendOnly?: boolean
  privacyMode?: boolean
  onClose: () => void
}) {
  const { api, onUse, onClose } = props
  const shellRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const [bounds, setBounds] = useState<CSSProperties>({})
  const [widthRatio, setWidthRatio] = useState(readDrawerWidth)
  const [fullscreen, setFullscreen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const requestedSources = useRef(new Set<string>())
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  const [recents, setRecents] = useState(readRecentTemplates)
  const [recentView, setRecentView] = useState(false)
  const [searchAll, setSearchAll] = useState(false)
  const [activeSource, setActiveSource] = useState(TEMPLATE_SOURCES[0]!.id)
  const [lists, setLists] = useState<Record<string, TemplateListResult>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [favorites, setFavorites] = useState<TemplateFavorite[]>([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [favoritesView, setFavoritesView] = useState(false)
  const [selected, setSelected] = useState<SelectedTemplate | null>(null)
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [cacheAll, setCacheAll] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 })
  const searchRef = useRef<HTMLInputElement>(null)

  const list = lists[activeSource]
  const specialView = favoritesView || recentView
  const sourceIds = searchAll ? TEMPLATE_SOURCES.map(source => source.id) : [activeSource]
  const loadError = specialView ? null : sourceIds.map(id => loadErrors[id]).filter(Boolean).join(' · ') || null
  const loading = !specialView && sourceIds.some(id => lists[id] === undefined && !loadErrors[id])

  /** Fetch one source's list into the per-source cache. */
  const loadSource = useCallback((sourceId: string, retry = false): void => {
    if (!retry && requestedSources.current.has(sourceId)) return
    requestedSources.current.add(sourceId)
    setLoadErrors(current => ({ ...current, [sourceId]: '' }))
    api.templatesList(sourceId)
      .then(result => {
        setLists(current => ({ ...current, [sourceId]: result }))
        setLoadErrors(current => ({ ...current, [sourceId]: '' }))
      })
      .catch(caught => { setLoadErrors(current => ({ ...current, [sourceId]: errorMessage(caught) })) })
  }, [api])

  // Load the first source plus the favorites on open; focus the search box.
  useEffect(() => {
    loadSource(TEMPLATE_SOURCES[0]!.id)
    api.favoritesList().then(setFavorites).catch(() => { /* favorites stay empty; toggling retries */ })
    searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchSource = (sourceId: string): void => {
    if (sourceId === activeSource && !specialView && !searchAll) return
    setActiveSource(sourceId)
    setCategory('')
    setFavoritesView(false)
    setRecentView(false)
    setSearchAll(false)
    setSelected(null)
    setNotice(null)
    if (lists[sourceId] === undefined) loadSource(sourceId)
  }

  // Bound the portal to the active work area rather than covering the host shell.
  useEffect(() => {
    const anchor = props.anchor
    if (!anchor) return
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setBounds({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: 'auto', bottom: 'auto' })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(anchor)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [props.anchor])

  useEffect(() => {
    if (searchAll && !specialView) TEMPLATE_SOURCES.forEach(source => loadSource(source.id))
  }, [loadSource, searchAll, specialView])

  useEffect(() => {
    const previous = previousFocus.current
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    if (shellRef.current) shellRef.current.inert = selected !== null
    if (selected !== null) detailRef.current?.focus()
    else searchRef.current?.focus()
  }, [selected])

  const changeWidth = (value: number): void => {
    const next = Math.max(0.55, Math.min(1, value))
    setWidthRatio(next)
    try { window.localStorage.setItem(DRAWER_WIDTH_KEY, String(next)) } catch { /* optional preference */ }
  }

  /** Every favorite keeps its source so the favorites tab can group libraries. */
  const favoriteItems = useMemo<TemplateEntry[]>(
    () => favorites.map(entry => ({ sourceId: entry.sourceId, item: entry.case })),
    [favorites],
  )
  const visibleItems = useMemo<TemplateEntry[]>(() => {
    if (favoritesView) return favoriteItems
    if (recentView) return recents
    if (searchAll) return TEMPLATE_SOURCES.flatMap(source => (lists[source.id]?.cases ?? []).map(item => ({ sourceId: source.id, item })))
    return (list?.cases ?? []).map(item => ({ sourceId: activeSource, item }))
  }, [activeSource, favoriteItems, favoritesView, recentView, recents, searchAll, lists, list])
  const favKeys = useMemo(() => new Set(favorites.map(entry => entry.key)), [favorites])

  const categories = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const { item } of visibleItems) {
      const entry = counts.get(item.category) ?? { label: item.categoryZh || item.category, count: 0 }
      entry.count += 1
      counts.set(item.category, entry)
    }
    return [...counts.entries()].map(([key, value]) => ({ key, label: value.label, count: value.count }))
  }, [visibleItems])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return visibleItems.filter(({ item }) => {
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return item.title.toLowerCase().includes(needle)
        || item.prompt.toLowerCase().includes(needle)
        || item.sourceLabel.toLowerCase().includes(needle)
    })
  }, [visibleItems, query, category])

  // Isolate the drawer from the canvas shortcuts; Escape returns from details first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (selected !== null) setSelected(null)
        else onClose()
      } else if (event.key === 'Tab') {
        const container = selected !== null ? detailRef.current : shellRef.current
        const items = [...(container?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter(item => !item.hidden)
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, onClose])

  const refresh = async (): Promise<void> => {
    const source = TEMPLATE_SOURCES.find(candidate => candidate.id === activeSource)
    if (refreshing || source?.refreshable === false) return
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

  /** Star / unstar one template, preserving its owning source. */
  const toggleFavorite = (sourceId: string, item: TemplateCase): void => {
    const key = favoriteKeyOf(sourceId, item)
    const pending = favKeys.has(key)
      ? api.favoritesRemove(key)
      : api.favoritesAdd(sourceId, item)
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

  const renderCard = ({ sourceId, item }: TemplateEntry): React.JSX.Element => {
    const key = favoriteKeyOf(sourceId, item)
    const active = favKeys.has(key)
    return <button
      key={key}
      type="button"
      className={css.card}
      onClick={() => { setSelected({ sourceId, item }); setCopied(false) }}
    >
      <span className={css.thumbWrap}>
        <TemplateThumb sourceId={sourceId} item={item} />
        {item.featured ? <span className={css.featuredBadge}>{tt('templates.featured')}</span> : null}
        <FavoriteStar
          active={active}
          title={active ? tt('templates.favoriteRemove') : tt('templates.favoriteAdd')}
          onToggle={() => { toggleFavorite(sourceId, item) }}
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
  }

  const applySelected = (mode: TemplateApplyMode = 'replace'): void => {
    if (selected === null) return
    const prompt = selected.item.prompt
    setRecents(rememberTemplate(selected, recents))
    setSelected(null)
    onUse(prompt, props.appendOnly ? 'append' : mode)
    onClose()
  }

  const originLabel = list === undefined ? '' : tt(list.origin === 'refreshed' ? 'templates.origin.refreshed' : 'templates.origin.bundled')
  const activeMeta = TEMPLATE_SOURCES.find(source => source.id === activeSource)!

  return createPortal(
    <div ref={overlayRef} className={css.overlay} style={bounds} data-template-drawer="" data-imagegen-private={props.privacyMode ? 'true' : undefined} role="dialog" aria-modal="true" aria-label={tt('templates.title')} onClick={onClose} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <section ref={shellRef} className={css.shell} data-fullscreen={fullscreen ? '' : undefined} data-resizing={resizing ? '' : undefined} style={{ width: fullscreen ? '100%' : `${widthRatio * 100}%` }} onClick={(event) => { event.stopPropagation() }}>
        {!fullscreen ? <div className={css.resizeHandle} role="separator" aria-label={tt('templates.resize')} aria-orientation="vertical" aria-valuemin={55} aria-valuemax={100} aria-valuenow={Math.round(widthRatio * 100)} tabIndex={0}
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); setResizing(true) }}
          onPointerMove={event => { if (!resizing) return; const rect = overlayRef.current?.getBoundingClientRect(); if (rect && rect.width > 0) changeWidth((rect.right - event.clientX) / rect.width) }}
          onPointerUp={() => setResizing(false)} onPointerCancel={() => setResizing(false)} onLostPointerCapture={() => setResizing(false)}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); changeWidth(widthRatio + (event.key === 'ArrowLeft' ? 0.05 : -0.05)) } }}
        /> : null}
        <header className={css.header}>
          <span className={css.heading}>
            <h3 className={css.title}>{tt('templates.title')}</h3>
            {specialView ? (
              <span className={css.meta}>{tt(recentView ? 'templates.recentsCount' : 'templates.favoritesCount', { count: recentView ? recents.length : favorites.length })}</span>
            ) : list !== undefined ? (
              <span className={css.meta}>{tt('templates.meta', { count: searchAll ? visibleItems.length : list.total, origin: searchAll ? tt('templates.allSources') : originLabel })}</span>
            ) : null}
          </span>
          <span className={css.headerActions}>
            <button type="button" className={css.close} aria-label={tt(fullscreen ? 'templates.restore' : 'templates.fullscreen')} title={tt(fullscreen ? 'templates.restore' : 'templates.fullscreen')} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
            {activeMeta.refreshable === false ? null : (
              <Button variant="outline" size="sm" disabled={refreshing || cacheAll.running || specialView || searchAll} onClick={() => { void refresh() }}>
                {refreshing ? tt('templates.refreshing') : tt('templates.refresh')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={specialView || searchAll || list === undefined || cacheAll.running}
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
              aria-selected={!specialView && !searchAll && source.id === activeSource}
              className={css.sourceTab}
              data-active={!specialView && !searchAll && source.id === activeSource ? '' : undefined}
              title={source.description}
              onClick={() => { switchSource(source.id) }}
            >
              {source.label}
              {lists[source.id] !== undefined ? <span className={css.sourceTabCount}>{lists[source.id]!.total}</span> : null}
            </button>
          ))}
        </div>
        <div className={css.viewTabs} role="tablist" aria-label={tt('templates.views')}>
          <button type="button" role="tab" aria-selected={!specialView} data-active={!specialView ? '' : undefined} className={css.viewTab} onClick={() => { setFavoritesView(false); setRecentView(false); setCategory(''); setSelected(null) }}>{tt('templates.browse')}</button>
          <button type="button" role="tab" aria-selected={favoritesView} data-active={favoritesView ? '' : undefined} className={css.viewTab} title={tt('templates.favoritesHint')} onClick={() => { setFavoritesView(true); setRecentView(false); setCategory(''); setSelected(null); setNotice(null) }}>★ {tt('templates.favorites')}{favorites.length > 0 ? ` ${favorites.length}` : ''}</button>
          <button type="button" role="tab" aria-selected={recentView} data-active={recentView ? '' : undefined} className={css.viewTab} onClick={() => { setRecentView(true); setFavoritesView(false); setCategory(''); setSelected(null); setNotice(null) }}>{tt('templates.recents')}</button>
        </div>

        <div className={css.toolbar}>
          <div className={css.searchRow}>
          <input
            ref={searchRef}
            type="search"
            aria-label={tt('templates.search')}
            className={css.search}
            placeholder={tt('templates.search')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          {!specialView ? <select className={css.searchScope} aria-label={tt('templates.searchScope')} value={searchAll ? 'all' : 'current'} onChange={event => { setSearchAll(event.target.value === 'all'); setCategory('') }}><option value="current">{tt('templates.currentSource')}</option><option value="all">{tt('templates.allSources')}</option></select> : null}
          </div>
          <div className={css.categoryRow}>
            <button
              type="button"
              className={css.categoryPill}
              data-active={category === '' ? '' : undefined}
              onClick={() => { setCategory('') }}
            >
              {tt('templates.all')}{visibleItems.length > 0 ? ` ${visibleItems.length}` : ''}
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
          {loading && visibleItems.length === 0 ? (
            <div className={css.state} role="status">
              <span className={css.spinner} />
              <span>{tt('templates.loading')}</span>
            </div>
          ) : null}

          {!specialView && loadError !== null ? (
            <div className={filtered.length > 0 ? css.partialError : css.state} role="alert">
              <span>{tt('templates.loadFailed', { error: loadError })}</span>
              <Button variant="outline" size="sm" onClick={() => { sourceIds.filter(id => loadErrors[id]).forEach(id => loadSource(id, true)) }}>
                {tt('templates.retry')}
              </Button>
            </div>
          ) : null}

          {specialView && filtered.length === 0 ? (
            <div className={css.state}>{tt(query.trim() !== '' || category !== '' ? 'templates.empty' : recentView ? 'templates.recentsEmpty' : 'templates.favoritesEmpty')}</div>
          ) : null}

          {!specialView && !loading && loadError === null && filtered.length === 0 ? (
            <div className={css.state}>{tt('templates.empty')}</div>
          ) : null}

          {favoritesView && filtered.length > 0 ? (
            <div className={css.favoriteGroups}>
              {TEMPLATE_SOURCES.map(source => {
                const group = filtered.filter(entry => entry.sourceId === source.id)
                if (group.length === 0) return null
                return <section key={source.id} className={css.favoriteGroup}>
                  <div className={css.favoriteGroupHead}>
                    <span className={css.favoriteGroupTitle}>{source.label}</span>
                    <span className={css.favoriteGroupCount}>{group.length}</span>
                  </div>
                  <div className={css.grid}>{group.map(renderCard)}</div>
                </section>
              })}
            </div>
          ) : null}

          {!favoritesView && filtered.length > 0 ? (
            <div className={css.grid}>{filtered.map(renderCard)}</div>
          ) : null}
        </div>

        <footer className={css.footer}>
          <span className={css.attribution}>{tt('templates.attribution')}</span>
          {!specialView && !searchAll ? <a className={css.sourceLink} href={activeMeta.homepage} target="_blank" rel="noreferrer">
            {tt('templates.source', { label: activeMeta.label })}
          </a> : null}
        </footer>
      </section>

      {selected !== null ? (
        <div className={css.detailOverlay} onClick={() => { setSelected(null) }}>
          <section ref={detailRef} className={css.detail} tabIndex={-1} role="dialog" aria-modal="true" aria-label={selected.item.title} data-template-detail="" onClick={(event) => { event.stopPropagation() }}>
            <div className={css.detailMedia}>
              {selected.item.image !== '' ? (
                <img className={css.detailImage} src={imageUrlOf(selected.sourceId, selected.item)} alt={selected.item.title} />
              ) : (
                <span className={css.thumbPlaceholder} aria-hidden="true" />
              )}
            </div>
            <div className={css.detailInfo}>
              <h4 className={css.detailTitle}>{selected.item.title}</h4>
              <div className={css.detailMeta}>
                <span className={css.cardCategory}>{selected.item.categoryZh || selected.item.category}</span>
                {selected.item.sourceUrl !== '' ? (
                  <a className={css.detailLink} href={selected.item.sourceUrl} target="_blank" rel="noreferrer">{selected.item.sourceLabel || selected.item.sourceUrl}</a>
                ) : null}
                {selected.item.githubUrl !== '' ? (
                  <a className={css.detailLink} href={selected.item.githubUrl} target="_blank" rel="noreferrer">GitHub</a>
                ) : null}
              </div>
              {props.appendOnly ? <p className={css.applyHint}>{tt('templates.ecommerceHint')}</p> : null}
              <pre className={css.detailPrompt}>{selected.item.prompt}</pre>
              <div className={css.detailActions}>
                <Button variant="primary" size="md" onClick={() => applySelected(props.appendOnly ? 'append' : 'replace')}>
                  {tt(props.appendOnly ? 'templates.applyStyle' : props.hasExistingPrompt ? 'templates.replace' : 'templates.use')}
                </Button>
                {props.hasExistingPrompt && !props.appendOnly ? <Button variant="outline" size="md" onClick={() => applySelected('append')}>{tt('templates.append')}</Button> : null}
                <Button variant="outline" size="md" onClick={() => { void copyPrompt(selected.item.prompt) }}>
                  {copied ? tt('templates.copied') : tt('templates.copy')}
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => { toggleFavorite(selected.sourceId, selected.item) }}
                >
                  {favKeys.has(favoriteKeyOf(selected.sourceId, selected.item)) ? tt('templates.unfavorite') : tt('templates.favorite')}
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

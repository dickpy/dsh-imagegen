/**
 * Inspiration wall for the studio's empty canvas: a small grid of random
 * template cases sampled host-side across every library source. Clicking a
 * card hands its prompt to the form; the 随机 button re-rolls the pick. On
 * failure the wall collapses to nothing (the panel falls back to the plain
 * empty-state hint).
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import { TEMPLATES_API, type TemplateSample } from '../protocol.ts'
import css from './inspiration.module.css'

/** Card count per deal — a 4×3 wall that uses the canvas's spare width. */
const SAMPLE_COUNT = 12

/** Same-origin proxy URL of one sampled case's reference image. */
function imageUrlOf(sample: TemplateSample): string {
  return `${TEMPLATES_API.image}/${encodeURIComponent(sample.sourceId)}/${encodeURIComponent(sample.case.image)}`
}

/** One thumbnail that degrades to a text tile when the image 404s. */
function SampleThumb(props: { sample: TemplateSample }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={css.thumbWrap}>
      {props.sample.case.image !== '' && !failed ? (
        <img className={css.thumb} src={imageUrlOf(props.sample)} alt={props.sample.case.title} loading="lazy" onError={() => { setFailed(true) }} />
      ) : (
        <span className={css.thumbFallback} aria-hidden="true">{props.sample.case.title}</span>
      )}
      <span className={css.thumbTitle}>{props.sample.case.title}</span>
    </span>
  )
}

/** The random-case wall shown while the canvas has no results. */
export function InspirationGallery(props: {
  api: ImageGenApi
  /** Hand the picked prompt back to the studio form. */
  onUse: (prompt: string) => void
}) {
  const { api, onUse } = props
  const [samples, setSamples] = useState<TemplateSample[] | null>(null)
  const [loading, setLoading] = useState(false)

  const deal = (): void => {
    if (loading) return
    setLoading(true)
    api.templatesSample(SAMPLE_COUNT)
      .then(setSamples)
      .catch(() => { setSamples(current => current ?? []) })
      .finally(() => { setLoading(false) })
  }

  // Deal once on mount; shuffles re-use the same handler.
  useEffect(() => {
    deal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sample fetch failed or the libraries are empty: collapse to the plain
  // empty-state hint so the canvas never looks broken.
  if (samples !== null && samples.length === 0) {
    return (
      <div className={css.wrap} aria-label={tt('inspiration.title')}>
        <span className={css.emptyIcon}>
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
        </span>
        <span className={css.emptyTitle}>{tt('canvas.emptyTitle')}</span>
        <span className={css.emptyHint}>{tt('canvas.emptyHint')}</span>
      </div>
    )
  }

  return (
    <div className={css.wrap} aria-label={tt('inspiration.title')}>
      <span className={css.title}>{tt('inspiration.title')}</span>
      {samples === null ? (
        <span className={css.spinner} aria-hidden="true" />
      ) : (
        <>
          <div className={css.grid}>
            {samples.map(sample => (
              <button
                key={`${sample.sourceId}:${sample.case.id}`}
                type="button"
                className={css.tile}
                title={tt('inspiration.useHint')}
                onClick={() => { onUse(sample.case.prompt) }}
              >
                <SampleThumb sample={sample} />
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={deal}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></svg>
            {loading ? tt('inspiration.shuffling') : tt('inspiration.shuffle')}
          </Button>
        </>
      )}
    </div>
  )
}

import { generationDurationLabel } from './helpers.ts'
import css from './panel.module.css'

/** Display metadata only: downloaded/copied image bytes remain the original. */
export function GenerationDurationBadge({ durationMs }: { durationMs?: number }): React.JSX.Element | null {
  const label = generationDurationLabel(durationMs)
  return label === undefined ? null : (
    <span className={css.generationDuration} data-generation-duration="" title={label}>{label}</span>
  )
}

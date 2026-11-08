/**
 * Full-window prompt editor.
 *
 * The composer's prompt field is ~250–300px wide, so a long prompt is only ever
 * half-visible there (and the native resize handle only makes the box taller,
 * never wider). The corner button on the composer opens this dialog instead:
 * one wide, tall field, the same live character counter, and the same enhance /
 * clear actions — edits stream straight into the studio state, so closing can
 * never lose text.
 *
 * Follows the dialog contract the other studio dialogs use: Escape closes, Tab
 * stays inside, focus returns to whatever opened it, and a backdrop click closes.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import { tt } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './panel.module.css'

export function PromptEditorDialog(props: {
  /** The studio's prompt; this dialog never keeps its own copy. */
  value: string
  /** The active model's prompt limit, or null when it documents none. */
  limit: number | null
  /** The value is at or over the model's documented limit. */
  overLimit: boolean
  enhancing: boolean
  onChange: (next: string) => void
  onEnhance: () => void
  onClear: () => void
  close: () => void
}): React.JSX.Element {
  // Re-render on locale change, matching the rest of the panel.
  useImageGenLanguageTick()
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const textarea = field.current
    textarea?.focus()
    // Land the caret at the end: the user opened this to continue a long prompt.
    if (textarea !== null) textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); props.close() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); props.close() }
      if (event.key === 'Tab') {
        const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    const element = root.current
    element?.addEventListener('keydown', onKey)
    return () => { element?.removeEventListener('keydown', onKey); previous?.focus() }
    // Mount-only: `close` is a fresh arrow function each render, and re-binding
    // would pull focus out of the field the user is typing in.
  }, [])

  const count = props.value.length
  const counter = props.limit === null
    ? tt('prompt.count', { count })
    : tt('prompt.countLimit', { count, limit: props.limit })

  return createPortal(
    <div
      className={css.promptEditorBackdrop}
      data-prompt-editor=""
      onClick={event => { if (event.target === event.currentTarget) props.close() }}
    >
      <div
        ref={root}
        className={css.promptEditor}
        role="dialog"
        aria-modal="true"
        aria-label={tt('prompt.editor.title')}
        aria-describedby="dsh-imagegen-prompt-editor-hint"
      >
        <header className={css.promptEditorHeader}>
          <span className={css.promptEditorTitle}>
            <Maximize2 size={15} strokeWidth={1.8} aria-hidden="true" />
            {tt('prompt.editor.title')}
          </span>
          <span id="dsh-imagegen-prompt-editor-hint" className={css.promptEditorHint}>{tt('prompt.editor.hint')}</span>
          <button type="button" className={css.promptEditorClose} aria-label={tt('preview.close')} title={tt('preview.close')} onClick={props.close}>
            <X size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>

        <textarea
          ref={field}
          className={css.promptEditorField}
          data-prompt-editor-field=""
          value={props.value}
          placeholder={tt('prompt.placeholder')}
          spellCheck={false}
          onChange={event => { props.onChange(event.target.value) }}
        />

        <footer className={css.promptEditorFooter}>
          <span
            className={css.promptCount}
            data-over={props.overLimit ? '' : undefined}
            title={props.overLimit ? tt('prompt.overLimit', { limit: props.limit ?? 0 }) : undefined}
          >
            {counter}
          </span>
          <span className={css.promptEditorSpacer} />
          <button type="button" className={css.promptClear} disabled={props.value === '' || props.enhancing} onClick={props.onClear}>
            {tt('prompt.clear')}
          </button>
          <button
            type="button"
            className={css.enhanceButton}
            disabled={props.value.trim() === '' || props.enhancing}
            title={tt('prompt.enhanceHint')}
            onClick={props.onEnhance}
          >
            {props.enhancing ? tt('prompt.enhancing') : tt('prompt.enhance')}
          </button>
          <button type="button" className={css.promptEditorDone} onClick={props.close}>
            {tt('prompt.editor.done')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

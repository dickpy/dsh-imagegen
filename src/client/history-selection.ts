import type { GenerateMode } from '../protocol.ts'

export const HISTORY_SELECTION_KEY = 'dsh-imagegen:history-selection:v1'
export interface HistorySelection {
  mode: GenerateMode
  ids: Record<GenerateMode, string | null>
}

/** Persist only record identities, never image bytes, prompts or credentials. */
export function readHistorySelection(storage?: Pick<Storage, 'getItem'> | null): HistorySelection {
  const selection: HistorySelection = { mode: 'text', ids: { text: null, edit: null } }
  try {
    const saved = JSON.parse(storage?.getItem(HISTORY_SELECTION_KEY) ?? 'null')
    if (saved?.mode === 'edit') selection.mode = 'edit'
    for (const mode of ['text', 'edit'] as const) {
      if (typeof saved?.ids?.[mode] === 'string' && saved.ids[mode].length > 0) selection.ids[mode] = saved.ids[mode]
    }
  } catch { /* corrupt or unavailable storage must not block the studio */ }
  return selection
}

export function writeHistorySelection(storage: Pick<Storage, 'setItem'> | null, selection: HistorySelection): void {
  try { storage?.setItem(HISTORY_SELECTION_KEY, JSON.stringify({ mode: selection.mode, ids: { text: selection.ids.text, edit: selection.ids.edit } })) } catch { /* optional persistence */ }
}

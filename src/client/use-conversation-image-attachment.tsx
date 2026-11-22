import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { GeneratedImage } from '../protocol.ts'
import { addConversationImageDraft } from './conversation-sync.ts'
import type { ConversationService } from './conversation-sync.ts'
import { conversationSessionTargets, currentConversationSessionId, type ConversationSessionTarget } from './session-target.ts'

export interface PreparedConversationImage {
  file: File
  dataUrl: string
}

interface ConversationImageAttachmentMessages {
  noSession: string
  unavailable: string
  busy: string
}

interface PendingConversationImage {
  image: GeneratedImage
  index: number
  actionKey: number | string
}

/**
 * Coordinate native composer attachment with a safe session fallback.
 *
 * The currently selected session always comes from DSH's list snapshot. When
 * that authoritative value is absent (or cannot resolve a scope), callers get
 * an explicit target picker; list order is never treated as user intent.
 */
export function useConversationImageAttachment(options: {
  sessions?: ISessions
  conversation?: ConversationService
  prompt: string
  prepareImage: (image: GeneratedImage, index: number) => Promise<PreparedConversationImage>
  attachImage: (sessionId: string, dataUrl: string, name: string) => Promise<void>
  messages: ConversationImageAttachmentMessages
  onError: (error: unknown) => void
  onAdded: () => void
}) {
  const { sessions, conversation } = options
  const subscribe = useCallback((listener: () => void) => sessions?.list.subscribe(listener) ?? (() => {}), [sessions])
  const getSnapshot = useCallback(() => sessions?.list.getSnapshot(), [sessions])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const targets = conversationSessionTargets(snapshot)
  const [pending, setPending] = useState<PendingConversationImage | null>(null)
  const [busyKey, setBusyKey] = useState<number | string | null>(null)

  const perform = useCallback(async (
    image: GeneratedImage,
    index: number,
    actionKey: number | string,
    sessionId: SessionId,
  ): Promise<void> => {
    if (sessions === undefined || conversation === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }
    const sessionScope = sessions.scope(sessionId)
    if (sessionScope === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }

    setBusyKey(actionKey)
    try {
      const prepared = await options.prepareImage(image, index)
      await addConversationImageDraft({
        conversation,
        sessionId,
        sessionScope,
        file: prepared.file,
        dataUrl: prepared.dataUrl,
        name: prepared.file.name,
        prompt: options.prompt,
        attachImage: options.attachImage,
        unavailableMessage: options.messages.unavailable,
        busyMessage: options.messages.busy,
      })
      // Follow the picture. Without this the image lands in a conversation the
      // user cannot see from the studio, which reads as "nothing happened";
      // opening the target session is exactly the sidebar click they expected.
      try { sessions.open(sessionId) } catch { /* navigation is best-effort */ }
      options.onAdded()
    } catch (error) {
      options.onError(error)
    } finally {
      setBusyKey(null)
    }
  }, [conversation, options, sessions])

  const add = useCallback((image: GeneratedImage, index: number, actionKey: number | string = index): void => {
    if (busyKey !== null || pending !== null) return
    if (sessions === undefined || conversation === undefined) {
      options.onError(new Error(options.messages.unavailable))
      return
    }

    const current = currentConversationSessionId(sessions)
    if (current !== undefined && sessions.scope(current) !== undefined) {
      void perform(image, index, actionKey, current)
      return
    }

    const currentTargets = conversationSessionTargets(sessions.list.getSnapshot())
    if (currentTargets.length === 0) {
      options.onError(new Error(options.messages.noSession))
      return
    }
    setPending({ image, index, actionKey })
  }, [busyKey, conversation, options, pending, perform, sessions])

  const selectTarget = useCallback((sessionId: SessionId): void => {
    if (pending === null || sessions === undefined) return
    // Revalidate against the latest authoritative list after the user choice.
    const stillListed = conversationSessionTargets(sessions.list.getSnapshot()).some(target => target.id === sessionId)
    if (!stillListed) {
      setPending(null)
      options.onError(new Error(options.messages.unavailable))
      return
    }
    const selected = pending
    setPending(null)
    void perform(selected.image, selected.index, selected.actionKey, sessionId)
  }, [options, pending, perform, sessions])

  const cancelPicker = useCallback((): void => { setPending(null) }, [])

  return { add, busyKey, pending, targets, selectTarget, cancelPicker }
}

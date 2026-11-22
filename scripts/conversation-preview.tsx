import { useCallback, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationService } from '../src/client/conversation-sync.ts'
import { ConversationSessionPicker } from '../src/client/ConversationSessionPicker.tsx'
import { useConversationImageAttachment } from '../src/client/use-conversation-image-attachment.tsx'
import css from '../src/client/panel.module.css'

const currentParam = new URLSearchParams(location.search).get('current')
const sessionIds = ['session-older', 'session-latest'] as const

function createSessionService(record: (value: string) => void): ISessions {
  const snapshot = {
    ids: [...sessionIds] as SessionId[],
    current: currentParam === null ? undefined : currentParam as SessionId,
    byId: {
      'session-older': { displayTitle: 'Older conversation', updatedAt: Date.now() - 3 * 86_400_000, cwd: 'C:\\work\\older-project' },
      'session-latest': { displayTitle: 'Most recent conversation', updatedAt: Date.now() - 5 * 60_000, running: true, cwd: 'C:\\work\\latest-project' },
    },
  }
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    scope: (id: SessionId) => snapshot.ids.includes(id) ? { sessionId: id } : undefined,
    // The real service switches the active conversation; the fixture records it
    // so the tests can assert that adding an image follows the picture.
    open: (id: SessionId) => { record(`open:${id}`) },
  } as unknown as ISessions
}

function Harness(): React.JSX.Element {
  const [events, setEvents] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const eventRef = useRef<(value: string) => void>(() => {})
  eventRef.current = value => { setEvents(previous => [...previous, value]) }
  const record = useCallback((value: string) => { eventRef.current(value) }, [])
  const sessions = useMemo(() => createSessionService(record), [record])
  const conversation = useMemo(() => ({
    createDrafts(sessionId: SessionId, files: readonly File[]) {
      record(`createDrafts:${sessionId}:${files[0]?.name ?? ''}`)
      return [{ id: `draft-${sessionId}`, kind: 'file' }]
    },
    releaseDraftAttachments(attachments: readonly { id: string }[]) { record(`release:${attachments.map(item => item.id).join(',')}`) },
    input: {
      for(scope: { sessionId: SessionId }) {
        record(`input.for:${scope.sessionId}`)
        return {
          addAttachments(ids: readonly string[]) { record(`addAttachments:${scope.sessionId}:${ids.join(',')}`); return true },
          removeAttachment(id: string) { record(`removeAttachment:${scope.sessionId}:${id}`); return true },
          state: { getSnapshot: () => ({ draft: '' }) },
          setDraft(text: string) { record(`setDraft:${scope.sessionId}:${text}`) },
        }
      },
    },
  }), [record]) as unknown as ConversationService
  const attachment = useConversationImageAttachment({
    sessions,
    conversation,
    prompt: 'sample generated image prompt',
    async prepareImage(image, index) {
      record(`prepare:${index}`)
      return { file: new File(['image'], `dsh-image-${index + 1}.png`, { type: 'image/png' }), dataUrl: `data:${image.mime};base64,${image.b64}` }
    },
    async attachImage(sessionId, dataUrl, name) { record(`attachConversationImage:${sessionId}:${name}:${dataUrl.slice(0, 22)}`) },
    messages: { noSession: 'No session is available', unavailable: 'Conversation unavailable', busy: 'Conversation is busy' },
    onError(error) { setMessage(error instanceof Error ? error.message : String(error)) },
    onAdded() { setMessage('Image added') },
  })
  const image = { b64: 'aW1hZ2U=', mime: 'image/png' }
  return (
    <main className={css.conversationE2e}>
      <button type="button" data-add-image-to-conversation onClick={() => { attachment.add(image, 0) }}>Add image to chat</button>
      {message !== '' ? <output role="status" data-attachment-message>{message}</output> : null}
      <pre data-attachment-events>{events.join('\n')}</pre>
      {attachment.pending !== null ? (
        <ConversationSessionPicker
          options={attachment.targets}
          labels={{ title: 'Choose a conversation', hint: 'Choose exactly where the generated image should go.', target: 'Target conversation', search: 'Search titles or paths', empty: 'No matching conversations', count: '{count} conversations', running: 'Running', jump: 'The conversation opens once the image is added', confirm: 'Add to selected conversation', cancel: 'Cancel' }}
          onSelect={attachment.selectTarget}
          onCancel={attachment.cancelPicker}
        />
      ) : null}
      <section data-layout-tests>
        <div data-layout="web">
          <div data-dsh-imagegen-sidebar-root data-host-sidebar>
            <div className="host_logoRow" data-host-logo>Web logo</div>
            <div data-dsh-imagegen-session-tabs>Session / Image</div>
            <div className="host_regionArea">Workspaces</div>
            <div className="host_footArea">Account</div>
            <div className="host_pluginEntry" data-host-hidden>Other plugin</div>
          </div>
        </div>
        <div data-layout="windows">
          <div data-dsh-imagegen-sidebar-root data-host-sidebar>
            <div className="host_topStrip" data-host-top-strip style={{ height: 40 }}>Windows title strip</div>
            <div className="host_logoRow" data-host-logo>Windows logo</div>
            <div data-dsh-imagegen-session-tabs>Session / Image</div>
            <div className="host_regionArea">Workspaces</div>
            <div className="host_footArea">Account</div>
            <div className="host_pluginEntry" data-host-hidden>Other plugin</div>
          </div>
        </div>
        <div data-layout="macos">
          <div data-dsh-imagegen-sidebar-root data-host-sidebar>
            <div className="host_topStrip" data-host-top-strip style={{ height: 52 }}>Traffic lights and collapse control</div>
            <div className="host_logoRow" data-host-logo>macOS logo</div>
            <div data-dsh-imagegen-session-tabs>Session / Image</div>
            <div className="host_regionArea">Workspaces</div>
            <div className="host_footArea">Account</div>
            <div className="host_pluginEntry" data-host-hidden>Other plugin</div>
          </div>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)

import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ImageGenPanel } from '../src/client/ImageGenPanel.tsx'
import { ImageGenApi } from '../src/client/api.ts'
import type { ImageGenScope } from '../src/client/settings-scope.ts'
import { compositeMaskedResult, loadRaster } from '../src/client/image-ops.ts'
import { mountSidebarEntry } from '../src/client/sidebar-entry.ts'
import { ImageGenController } from '../src/client/controller.ts'
import { ImageGenSettingsCardController, ImageGenSettingsSurface, type ImageGenSettingsCardState } from '../src/client/SettingsCard.tsx'
import { bindImageGenScope } from '../src/client/settings-scope.ts'
import { tt } from '../src/client/helpers.ts'

const value = { enabled: true, ...new URLSearchParams(location.search).has('reverse') ? { promptModel: 'fixture-vision' } : {}, defaultChannelId: 'one', defaultModel: 'gpt-image-2', channels: [
  { id: 'one', name: 'Provider A', apiUrl: 'https://one.test/v1', models: [{ id: 'gpt-image-2', alias: 'gpt-image-2' }, { id: 'gpt-image-2.5-flare', alias: 'gpt-image-2.5-flare' }] },
  { id: 'two', name: 'Provider B', apiUrl: 'https://two.test/v1', models: [{ id: 'gpt-image-2', alias: 'gpt-image-2' }] },
] }
const scope = { getSnapshot: () => ({ value, writable: true, status: 'ready' }), subscribe: () => () => {}, getSecretSetSnapshot: () => true, subscribeSecretSets: () => () => {} } as unknown as ImageGenScope
const api = new ImageGenApi()
function Fixture(): React.JSX.Element {
  const [key, setKey] = useState(0), [visible, setVisible] = useState(true)
  return <><nav className="fixture-controls"><button onClick={() => setKey(key + 1)}>Remount studio</button><button onClick={() => setVisible(!visible)}>Toggle workspace</button></nav><div style={{ height: 'calc(100% - 36px)', display: visible ? 'block' : 'none' }}><ImageGenPanel key={key} api={api} scope={scope} /></div></>
}
Object.assign(window, { studioRaster: { compositeMaskedResult, loadRaster }, studioSidebar: { mount: mountSidebarEntry, Controller: ImageGenController } })
const root = createRoot(document.getElementById('root')!)
if (new URLSearchParams(location.search).has('settings')) {
  const face = new ImageGenSettingsCardController(bindImageGenScope()).inject()
  function useSettings<T>(select: (state: ImageGenSettingsCardState) => T): T {
    return select(useSyncExternalStore(face.hooks.imageGenSettingsCard.subscribe, face.hooks.imageGenSettingsCard.getSnapshot))
  }
  root.render(<ImageGenSettingsSurface {...face} mode="section" useImageGenSettingsCard={useSettings} t={tt} />)
} else root.render(<Fixture />)

/**
 * The dsh-imagegen settings card: channel management (list rows with status
 * dots, an editor dialog with the model-catalog alias → upstream mapping, and
 * built-in provider presets), plus the prompt-enhancement model and the plugin
 * switches. Registers into the official `settings.plugin.item` slot (the
 * Settings → Plugins → Configurable tab), independent of the dsh-web-ui family
 * group, bound to the plugin's own bridge settings scope.
 *
 * The interaction mirrors the host's model-provider page: one row per channel
 * (status dot + edit/delete), two add buttons (built-in provider / custom),
 * and an editor holding API key, display name, API URL, and the model catalog
 * with detection.
 */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, booleanField, secretField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { ChannelsForm, type ChannelDraft, type ChannelsFormActions, type ChannelsFormState } from './channels-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { describeModel } from '../model-catalog.ts'
import { IMAGE_MODEL_API, PRESETS_API, PROMPT_ENHANCE_API, USAGE_API, type ModelMapping, type PresetProviderView } from '../protocol.ts'
import type { ImageGenKey } from './locales.ts'
import { tt, type TranslateValues } from './helpers.ts'
import { useImageGenLanguageTick } from './use-language.ts'
import css from './settings-card.module.css'

/** The global (non-channel) fields this card's staged form edits. */
export interface ImageGenSettings {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentImageGeneration?: boolean
  promptApiUrl?: string
  promptApiKey?: string
  promptModel?: string
}

/** What the card renders. */
export interface ImageGenSettingsCardState extends CardShell {
  /** Channel list staging (channels + per-channel key edits + default). */
  channels: ChannelsFormState
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  allowAgentImageGeneration: CardFieldState
  promptApiUrl: CardFieldState
  promptApiKey: CardFieldState
  promptModel: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  /** Channel staging actions (committed together with the card's save). */
  channels: ChannelsFormActions
  hooks: {
    /** Card snapshot bound by the renderer as useImageGenSettingsCard. */
    imageGenSettingsCard: SnapshotStore<ImageGenSettingsCardState>
  }
}

/** Bridges the imagegen scope onto the card's staged forms. */
export class ImageGenSettingsCardController {
  private readonly form: CardForm<ImageGenSettings>
  private readonly channelsForm: ChannelsForm

  /** @param scope - the bound bridge scope for the dsh-imagegen namespace. */
  constructor(private readonly scope: ImageGenScope) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      booleanField('allowAgentImageGeneration'),
      textField('promptApiUrl'),
      secretField('promptApiKey'),
      textField('promptModel'),
    ], {
      secretSettled: () => this.scope.getSecretSetSnapshot('promptApiKey'),
    })
    this.channelsForm = new ChannelsForm(scope)
  }

  private projection(): ImageGenSettingsCardState {
    const shell = this.form.shell()
    return {
      ...shell,
      dirty: shell.dirty || this.channelsForm.snapshot().dirty,
      channels: this.channelsForm.snapshot(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      allowAgentImageGeneration: this.form.field('allowAgentImageGeneration'),
      promptApiUrl: this.form.field('promptApiUrl'),
      promptApiKey: this.form.field('promptApiKey'),
      promptModel: this.form.field('promptModel'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and the form/channel actions.
   */
  inject(): ImageGenSettingsCardFace {
    const cardStore = this.form.bind(() => this.projection())
    this.channelsForm.subscribe(() => { cardStore.set(this.projection()) })
    return {
      hooks: {
        imageGenSettingsCard: cardStore,
      },
      channels: this.channelsForm.actions(),
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this card. */
export type ImageGenSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/** Host-computed usage counters (generation-count badges). */
interface UsageCounters {
  byChannel: Record<string, Record<string, number>>
  totals: Record<string, number>
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function ImageGenSettingsCard(props: ImageGenSettingsCardProps) {
  // The card renders through the plugin's own dictionary so the uiLanguage
  // override applies here too — the host-locale props.t would only follow the
  // DSH interface language.
  const t = tt
  useImageGenLanguageTick()
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  // Global-section local states (prompt enhancement etc.).
  const [promptModels, setPromptModels] = useState<string[]>([])
  const [loadingPromptModels, setLoadingPromptModels] = useState(false)
  const [promptModelsError, setPromptModelsError] = useState<string | null>(null)
  const [manualPromptModelOpen, setManualPromptModelOpen] = useState(false)
  const [manualPromptModel, setManualPromptModel] = useState('')
  const [enhancementOpen, setEnhancementOpen] = useState(false)
  const [promptApiOpen, setPromptApiOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // Channel list local states.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetPickerOpen, setPresetPickerOpen] = useState(false)
  const [presets, setPresets] = useState<PresetProviderView[]>([])
  const [presetError, setPresetError] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageCounters | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Usage counters: refreshed once per card open (and after a successful save).
  useEffect(() => {
    if (!state.exposed) return
    let alive = true
    void fetch(USAGE_API, { method: 'POST' })
      .then(async response => { const body = await response.json() as { ok?: boolean; usage?: UsageCounters }; if (alive && body.ok === true && body.usage !== undefined) setUsage(body.usage) })
      .catch(() => { /* counters are best-effort */ })
    return () => { alive = false }
  }, [state.exposed])

  if (!state.available) return null
  const title = t('settings.title')
  const blocked = !state.dirty || state.invalid || state.saving || state.channels.saving
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }

  if (!state.exposed) {
    return (
      <li className={css.card}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.headText}>
            <span className={css.name}>{title}</span>
            <span className={css.description}>{t('settings.description')}</span>
          </span>
          <span className={open ? css.chevronOpen : css.chevron}>▾</span>
        </button>
        {open
          ? (
            <div className={css.body}>
              <p className={css.notExposed} role="status">{t('settings.notExposed')}</p>
            </div>
          )
          : null}
      </li>
    )
  }

  const channels = state.channels.channels
  const editing = editingId === null ? undefined : channels.find(channel => channel.id === editingId)

  return (
    <li className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            <section className={css.channelSection} aria-label={t('channels.title')}>
              <div className={css.sectionHeader}>
                <div>
                  <h3 className={css.sectionTitle}>{t('channels.title')}</h3>
                  <p className={css.sectionHint}>{t('channels.hint')}</p>
                </div>
              </div>
              {channels.length === 0
                ? <p className={css.channelEmpty}>{t('channels.empty')}</p>
                : (
                  <ul className={css.channelList}>
                    {channels.map(channel => {
                      const keyHeld = state.channels.keySet[channel.id] === true
                      const ready = keyHeld && channel.models.length > 0
                      const isDefault = channel.id === state.channels.defaultChannelId
                      if (confirmDeleteId === channel.id) {
                        return (
                          <li key={channel.id} className={css.channelRow} data-action>
                            <span className={css.deleteConfirmText}>{t('channels.deleteConfirmTitle', { name: channel.name || t('channels.untitled') })}</span>
                            <button type="button" className={css.channelDanger} disabled={disabled} onClick={() => { props.channels.setChannels(channels.filter(candidate => candidate.id !== channel.id)); if (isDefault && channels.length > 1) { const next = channels.find(candidate => candidate.id !== channel.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setConfirmDeleteId(null); if (editingId === channel.id) setEditingId(null) }}>{t('channels.confirm')}</button>
                            <button type="button" className={css.channelAction} disabled={disabled} onClick={() => { setConfirmDeleteId(null) }}>{t('channels.cancel')}</button>
                          </li>
                        )
                      }
                      return (
                        <li key={channel.id} className={css.channelRow}>
                          <span className={ready ? css.channelDotReady : css.channelDotWarn} aria-hidden="true" title={t(ready ? 'channels.statusReady' : 'channels.statusIncomplete')} />
                          <button type="button" className={css.channelMain} disabled={disabled} onClick={() => { setEditingId(channel.id) }}>
                            <span className={css.channelName}>{isDefault ? `★ ${channel.name || t('channels.untitled')}` : (channel.name || t('channels.untitled'))}</span>
                            <span className={css.channelMeta}>
                              <span className={css.channelBadge} data-warn={!keyHeld || channel.models.length === 0 ? '' : undefined}>
                                {keyHeld ? t('channels.keySet') : t('channels.keyMissing')}
                                {' · '}
                                {channel.models.length > 0 ? t('channels.modelCount', { n: channel.models.length }) : t('channels.noModels')}
                              </span>
                            </span>
                          </button>
                          <button type="button" className={css.channelAction} onClick={() => { setEditingId(channel.id) }}>{t('channels.edit')}</button>
                          <button type="button" className={css.channelAction} data-danger onClick={() => { setConfirmDeleteId(channel.id) }}>{t('channels.delete')}</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              <div className={css.channelControls}>
              {open && presetPickerOpen ? (
                <PresetPicker
                  t={t}
                  presets={presets}
                  error={presetError}
                  disabled={state.writable === false}
                  onLoad={() => {
                    setPresetError(null)
                    void fetch(PRESETS_API, { method: 'POST' })
                      .then(async response => {
                        const body = await response.json() as { ok?: boolean; presets?: PresetProviderView[]; message?: string }
                        if (!response.ok || body.ok !== true || body.presets === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
                        setPresets(body.presets)
                      })
                      .catch(error => { setPresetError(error instanceof Error ? error.message : String(error)) })
                  }}
                  onPick={(preset) => {
                    const draft = newChannelDraft(preset)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onCustom={() => {
                    const draft = newChannelDraft(undefined)
                    props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                  }}
                  onClose={() => { setPresetPickerOpen(false) }}
                />
              ) : null}

              <div className={css.channelAddRow}>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { setPresetError(null); setPresetPickerOpen(true) }}>+ {t('channels.addProvider')}</button>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { addCustomChannel(channels, props.channels, setEditingId) }}>+ {t('channels.addCustom')}</button>
              </div>
              </div>
            </section>

            <button
              type="button"
              className={css.disclosure}
              aria-expanded={enhancementOpen}
              onClick={() => { setEnhancementOpen(open => !open) }}
            >
              <span>{t('settings.promptEnhanceTitle')}</span>
              <span>{t('settings.optional')}</span>
              <span aria-hidden="true">{enhancementOpen ? '⌃' : '⌄'}</span>
            </button>
            {enhancementOpen ? <section className={css.optionalContent} aria-label={t('settings.promptEnhanceTitle')}>
            <p className={css.sectionHint}>{t('settings.promptEnhanceHint')}</p>
            <div className={css.sectionHeader}>
              <div>
                <h3 className={css.sectionTitle}>{t('settings.promptModel')}</h3>
                <p className={css.sectionHint}>{t('settings.promptModelDetectionHint')}</p>
              </div>
              <button
                type="button"
                className={css.modelFetch}
                disabled={disabled || loadingPromptModels}
                onClick={() => {
                  setLoadingPromptModels(true)
                  setPromptModelsError(null)
                  void fetch(PROMPT_ENHANCE_API.models, { method: 'POST' })
                    .then(async response => {
                      const body = await response.json() as { ok?: boolean; models?: string[]; message?: string }
                      if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
                      setPromptModels(body.models ?? [])
                    })
                    .catch(error => { setPromptModelsError(error instanceof Error ? error.message : String(error)) })
                    .finally(() => { setLoadingPromptModels(false) })
                }}
              >
                {loadingPromptModels ? t('settings.promptModelsLoading') : t('settings.promptModelsFetch')}
              </button>
            </div>
            <div className={css.modelSummary}>
              {state.promptModel.text.trim() !== '' ? (
                <span className={css.modelChip}>
                  <span>{state.promptModel.text}</span>
                  <button type="button" disabled={disabled} aria-label={`${t('settings.removeModel')}: ${state.promptModel.text}`} onClick={() => { props.edit('promptModel', '') }}>×</button>
                </span>
              ) : null}
              <button type="button" className={css.addModel} disabled={disabled} onClick={() => { setManualPromptModelOpen(open => !open); setEnhancementOpen(true) }}>
                {manualPromptModelOpen ? t('settings.cancelAddModel') : t('settings.addModel')}
              </button>
            </div>
            {manualPromptModelOpen ? (
              <div className={css.manualModelRow}>
                <input className={css.input} value={manualPromptModel} placeholder={t('settings.addPromptModelPlaceholder')} disabled={disabled} onChange={event => { setManualPromptModel(event.target.value) }} />
                <button type="button" className={css.addModel} disabled={disabled || manualPromptModel.trim() === ''} onClick={() => { props.edit('promptModel', manualPromptModel); setManualPromptModel('') }}>{t('settings.addModelConfirm')}</button>
              </div>
            ) : null}
            {promptModels.length > 0 ? (
              <div className={css.modelCandidateList} role="radiogroup" aria-label={t('settings.promptModelsCandidates')}>
                <span className={css.modelCandidateLabel}>{t('settings.promptModelsCandidates')}</span>
                {promptModels.map(candidate => (
                  <button
                    key={candidate}
                    type="button"
                    role="radio"
                    className={css.modelCandidate}
                    aria-checked={state.promptModel.text === candidate}
                    data-selected={state.promptModel.text === candidate ? '' : undefined}
                    disabled={disabled}
                    onClick={() => { props.edit('promptModel', candidate) }}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            ) : null}
            {promptModelsError !== null ? <p className={css.failed} role="status">{promptModelsError}</p> : null}
            <button type="button" className={css.inlineDisclosure} aria-expanded={promptApiOpen} onClick={() => { setPromptApiOpen(open => !open) }}>
              <span>{t('settings.promptApiAdvanced')}</span>
              <span aria-hidden="true">{promptApiOpen ? '⌃' : '⌄'}</span>
            </button>
            {promptApiOpen ? <div className={css.optionalContent}>
            <ValueField
              id="dsh-imagegen-settings-prompt-apiurl"
              label={t('settings.promptApiUrl')}
              hint={t('settings.promptApiUrlHint')}
              placeholder="https://api.openai.com/v1"
              {...fieldProps}
              {...state.promptApiUrl}
              onEdit={(text) => { props.edit('promptApiUrl', text) }}
              onReset={() => { props.resetField('promptApiUrl') }}
            />
            <ValueField
              id="dsh-imagegen-settings-prompt-apikey"
              label={t('settings.promptApiKey')}
              hint={t('settings.promptApiKeyHint')}
              placeholder="sk-…"
              secret
              {...fieldProps}
              {...state.promptApiKey}
              overridden={false}
              onEdit={(text) => { props.edit('promptApiKey', text) }}
              onReset={() => { props.resetField('promptApiKey') }}
            />
            </div> : null}
            </section> : null}

            <button type="button" className={css.disclosure} aria-expanded={moreOpen} onClick={() => { setMoreOpen(open => !open) }}>
              <span>{t('settings.moreOptions')}</span>
              <span aria-hidden="true">{moreOpen ? '⌃' : '⌄'}</span>
            </button>
            {moreOpen ? <div className={css.optionalContent}>
            <BooleanField
              id="dsh-imagegen-settings-enabled"
              label={t('settings.enabled')}
              hint={t('settings.enabledHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.enabled}
              onEdit={(text) => { props.edit('enabled', text) }}
              onReset={() => { props.resetField('enabled') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-announce"
              label={t('settings.announceToAgent')}
              hint={t('settings.announceToAgentHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.announceToAgent}
              onEdit={(text) => { props.edit('announceToAgent', text) }}
              onReset={() => { props.resetField('announceToAgent') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-agent-generation"
              label={t('settings.allowAgentImageGeneration')}
              hint={t('settings.allowAgentImageGenerationHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.allowAgentImageGeneration}
              onEdit={(text) => { props.edit('enabled', text) }}
              onReset={() => { props.resetField('enabled') }}
            />
            </div> : null}
            <div className={css.footer}>
              {(state.failed || state.channels.failed) ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving || state.channels.saving}
                onClick={() => { props.discard(); props.channels.discard() }}
              >
                {t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={() => { void props.channels.commit(); void props.save() }}
              >
                {t(!state.saving && !state.channels.saving ? 'settings.save' : 'settings.saving')}
              </button>
            </div>
          </div>
        )
        : null}

      {open && editing !== undefined ? (
        <ChannelEditor
          key={editing.id}
          t={t}
          channel={editing}
          keyHeld={state.channels.keySet[editing.id] === true}
          usage={usage}
          otherChannels={channels.filter(channel => channel.id !== editing.id)}
          isDefault={editing.id === state.channels.defaultChannelId}
          writable={state.writable}
          onPatch={(patch) => { replaceChannel(channels, editing.id, patch, props.channels) }}
          onSetModels={(models) => { props.channels.setChannels(channels.map(channel => channel.id === editing.id ? { ...channel, models } : channel)) }}
          onSetKey={(value) => { props.channels.setChannelKey(editing.id, value) }}
          onSetDefault={() => { props.channels.setDefaultChannel(editing.id) }}
          onRemove={() => { props.channels.setChannels(channels.filter(channel => channel.id !== editing.id)); if (editing.id === state.channels.defaultChannelId && channels.length > 1) { const next = channels.find(channel => channel.id !== editing.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setEditingId(null) }}
          onClose={() => { setEditingId(null) }}
        />
      ) : null}

    </li>
  )
}

/** Channel row + dialog helpers -------------------------------------------------- */

function newChannelDraft(preset: PresetProviderView | undefined): ChannelDraft {
  return {
    id: clientId(),
    preset: preset?.id ?? '',
    name: preset?.name ?? '',
    apiUrl: preset?.apiUrl ?? '',
    models: (preset?.models ?? []).map(model => ({ ...model })),
  }
}

function addCustomChannel(channels: ChannelDraft[], form: ChannelsFormActions, openEditor: (id: string) => void): void {
  const draft = newChannelDraft(undefined)
  form.setChannels([...channels, draft])
  openEditor(draft.id)
}

/** Patch one field (or models) of one staged channel. */
function replaceChannel(channels: ChannelDraft[], id: string, patch: Partial<ChannelDraft>, form: ChannelsFormActions): void {
  form.setChannels(channels.map(channel => channel.id === id ? { ...channel, ...patch } : channel))
}

function clientId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : undefined
  return random ?? `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Built-in provider picker, expanded inside the settings card. */
function PresetPicker(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  presets: PresetProviderView[]
  error: string | null
  disabled: boolean
  onLoad: () => void
  onPick: (preset: PresetProviderView) => void
  onCustom: () => void
  onClose: () => void
}) {
  const { t } = props
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    props.onLoad()
  }, [])
  return (
    <section className={css.presetInline} aria-label={t('channels.presetPickerTitle')}>
      <header className={css.presetInlineHeader}>
        <div>
          <h3 className={css.sectionTitle}>{t('channels.presetPickerTitle')}</h3>
          <p className={css.sectionHint}>{t('channels.presetPickerHint')}</p>
        </div>
        <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
      </header>
      <div className={css.presetList}>
        {props.presets.map(preset => (
          <button key={preset.id} type="button" className={css.presetRow} disabled={props.disabled} onClick={() => { props.onPick(preset) }}>
            <span className={css.presetName}>{preset.name}</span>
            <span className={css.presetMeta}>{preset.models.map(model => model.alias).join(' · ')}</span>
          </button>
        ))}
        <button type="button" className={css.presetRow} data-custom disabled={props.disabled} onClick={props.onCustom}>
          <span className={css.presetName}>+ {t('channels.addCustom')}</span>
          <span className={css.presetHint}>{t('channels.presetCustomHint')}</span>
        </button>
        {props.error !== null ? <p className={css.failed} role="status">{t('channels.presetLoadFailed', { error: props.error })}</p> : null}
      </div>
    </section>
  )
}

/** Channel editor (modal): key, display name, API URL, model catalog. */
function ChannelEditor(props: {
  t: (key: ImageGenKey, params?: Record<string, string | number>) => string
  channel: ChannelDraft
  keyHeld: boolean
  usage: UsageCounters | null
  otherChannels: ChannelDraft[]
  isDefault: boolean
  writable: boolean
  onPatch: (patch: Partial<ChannelDraft>) => void
  onSetModels: (models: ModelMapping[]) => void
  onSetKey: (value: string | undefined) => void
  onSetDefault: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { t, channel } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [manualId, setManualId] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')

  const generatedCount = (alias: string): number => {
    if (props.usage === null) return 0
    const channelBucket = props.usage.byChannel[channel.id] ?? props.usage.byChannel[`name:${channel.name}`] ?? {}
    return channelBucket[alias] ?? props.usage.totals[alias] ?? 0
  }

  const detect = (): void => {
    setDetecting(true)
    setDetectError(null)
    const payload: Record<string, unknown> = { channelId: channel.id }
    if (channel.apiUrl.trim() !== '') payload.apiUrl = channel.apiUrl.trim()
    if (keyDraft.trim() !== '') payload.apiKey = keyDraft.trim()
    void fetch(IMAGE_MODEL_API.models, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(async response => {
        const body = await response.json() as { ok?: boolean; models?: string[]; message?: string }
        if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
        setCandidates(body.models ?? [])
      })
      .catch(error => { setDetectError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setDetecting(false) })
  }

  // Auto-detect once when the dialog opens with a complete endpoint.
  const autoDetected = useRef(false)
  useEffect(() => {
    if (autoDetected.current) return
    autoDetected.current = true
    if (channel.apiUrl.trim() !== '' && (props.keyHeld || keyDraft.trim() !== '')) detect()
  }, [])

  const addManual = (): void => {
    const id = manualId.trim()
    if (id === '') return
    const next = [...channel.models]
    const alias = id
    if (!next.some(model => model.alias === alias)) next.push({ alias, id })
    props.onSetModels(next)
    setManualId('')
  }

  const copyFromChannel = (): void => {
    const source = props.otherChannels.find(chance => chance.id === copyFrom)
    if (source === undefined) return
    const merged = [...channel.models]
    for (const model of source.models) {
      const alias = model.alias
      // Copy with a collision suffix so both sources stay selectable.
      let unique = alias
      let suffix = 2
      while (merged.some(entry => entry.alias === unique)) unique = `${alias} (${suffix++})`
      merged.push({ alias: unique, id: model.id })
    }
    props.onSetModels(merged)
    setCopyFrom('')
  }

  return (
    <div className={css.editorBackdrop} role="dialog" aria-modal="true" aria-label={`${t('channels.editorTitle')} · ${channel.name || t('channels.untitled')}`} onClick={props.onClose}>
      <div className={css.editorPanel} onClick={event => { event.stopPropagation() }}>
        <header className={css.editorHeader}>
          <div>
            <h3 className={css.sectionTitle}>{t('channels.editorTitle')} · {channel.name || t('channels.untitled')}</h3>
            <p className={css.sectionHint}>{t('channels.editorSaveNote')}</p>
          </div>
          <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
        </header>

        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-name">{t('channels.displayName')}</label>
          <input id="dsh-imagegen-channel-name" className={css.input} value={channel.name} placeholder={t('channels.untitled')} disabled={!props.writable} onChange={event => { props.onPatch({ name: event.target.value }) }} />
        </div>
        <div className={css.editorField}>
          <label className={css.label} htmlFor="dsh-imagegen-channel-url">{t('channels.apiUrl')}</label>
          <input id="dsh-imagegen-channel-url" className={css.input} value={channel.apiUrl} placeholder="https://api.example.com/v1" disabled={!props.writable} onChange={event => { props.onPatch({ apiUrl: event.target.value }) }} />
        </div>
        <div className={css.editorField}>
          <div className={css.head}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-key">{t('channels.apiKey')}</label>
            {props.keyHeld || keyDraft !== ''
              ? (
                <button type="button" className={css.reset} disabled={!props.writable} onClick={() => { setKeyDraft(''); props.onSetKey(undefined) }}>
                  {t('channels.keyClear')}
                </button>
              )
              : null}
          </div>
          <input
            id="dsh-imagegen-channel-key"
            className={css.input}
            type="password"
            autoComplete="off"
            value={keyDraft}
            placeholder={props.keyHeld ? t('channels.keyReplaceHint') : t('channels.keyMissingHint')}
            disabled={!props.writable}
            onChange={event => { const value = event.target.value; setKeyDraft(value); props.onSetKey(value === '' ? undefined : value) }}
          />
        </div>

        <div className={css.editorDivider} />

        <div className={css.editorSectionHeader}>
          <h4 className={css.label}>{t('channels.modelCatalogTitle')}</h4>
          <button type="button" className={css.modelFetch} disabled={!props.writable || detecting} onClick={detect}>
            {detecting ? t('channels.detecting') : t('channels.detect')}
          </button>
        </div>
        {detectError !== null ? <p className={css.failed} role="status">{t('channels.detectFailed', { error: detectError })}</p> : null}
        {candidates !== null && detectError === null ? <p className={css.detectOk} role="status">{t('channels.detectSuccess', { n: candidates.length })}</p> : null}

        {channel.models.length === 0
          ? <p className={css.sectionHint}>{t('channels.noModelsHint')}</p>
          : (
            <ul className={css.modelRows}>
              {channel.models.map((model, index) => {
                const entry = describeModel(model.id || model.alias)
                const generated = generatedCount(model.alias)
                return (
                  <li key={`${model.alias}-${index}`} className={css.modelRow}>
                    <div className={css.modelRowInputs}>
                      <input className={css.input} value={model.alias} aria-label={t('channels.modelAliasLabel')} disabled={!props.writable} onChange={event => {
                        const next = [...channel.models]
                        next[index] = { ...model, alias: event.target.value }
                        props.onSetModels(next)
                      }} />
                      <span className={css.modelArrow}>→</span>
                      <input className={css.input} value={model.id} aria-label={t('channels.modelIdLabel')} disabled={!props.writable} onChange={event => {
                        const next = [...channel.models]
                        next[index] = { ...model, id: event.target.value }
                        props.onSetModels(next)
                      }} />
                    </div>
                    <div className={css.modelRowBadges}>
                      <span className={css.modelBadge}>{entry.labelZh}{entry.known ? '' : ` · ${t('channels.unknownProtocol')}`}</span>
                      {generated > 0 ? <span className={css.modelBadge} data-verified>{t('channels.generated', { n: generated })}</span> : null}
                      <button type="button" className={css.modelRowRemove} disabled={!props.writable} aria-label={`${t('channels.removeModel')}: ${model.alias}`} onClick={() => { props.onSetModels(channel.models.filter((_, i) => i !== index)) }}>×</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

        <div className={css.editorTools}>
          <div className={css.manualModelRow}>
            <input className={css.input} value={manualId} placeholder={t('channels.manualAddPlaceholder')} disabled={!props.writable} onChange={event => { setManualId(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual() } }} />
            <button type="button" className={css.addModel} disabled={!props.writable || manualId.trim() === ''} onClick={addManual}>{t('channels.addModelConfirm')}</button>
          </div>
          {props.otherChannels.length > 0 ? (
            <div className={css.manualModelRow}>
              <select className={css.modelChoices} value={copyFrom} disabled={!props.writable} onChange={event => { setCopyFrom(event.target.value) }} aria-label={t('channels.copyFrom')}>
                <option value="">{t('channels.copyFrom')}</option>
                {props.otherChannels.map(other => (
                  <option key={other.id} value={other.id}>{other.name || t('channels.untitled')}</option>
                ))}
              </select>
              <button type="button" className={css.addModel} disabled={!props.writable || copyFrom === ''} onClick={copyFromChannel}>{t('channels.copyApply')}</button>
            </div>
          ) : null}
        </div>

        {candidates !== null && candidates.length > 0 ? (
          <div className={css.modelCandidateList}>
            <span className={css.modelCandidateLabel}>
              {t('channels.candidatesTitle')}
            </span>
            {candidates.map(candidate => {
              const selected = channel.models.some(model => model.alias === candidate)
              const entry = describeModel(candidate)
              return (
                <label key={candidate} className={css.modelCandidate} data-selected={selected ? '' : undefined}>
                  <input type="checkbox" checked={selected} disabled={!props.writable} onChange={() => {
                    const merged = selected
                      ? channel.models.filter(model => model.alias !== candidate)
                      : [...channel.models, { alias: candidate, id: candidate }]
                    props.onSetModels(merged)
                  }} />
                  <span>{candidate}</span>
                  {!entry.known ? <span className={css.modelBadge} data-warn>{t('channels.unknownProtocol')}</span> : <span className={css.modelBadge}>{entry.labelZh}</span>}
                </label>
              )
            })}
          </div>
        ) : null}

        <div className={css.editorDivider} />

        <div className={css.editorFooter}>
          {props.isDefault ? <span className={css.channelBadge} data-default>{t('channels.defaultLabel')}</span> : (
            <button type="button" className={css.inlineDisclosure} disabled={!props.writable} onClick={props.onSetDefault}>{t('channels.setDefault')}</button>
          )}
          <span className={css.spacer} />
          {removeOpen
            ? (
              <>
                <button type="button" className={css.channelDanger} disabled={!props.writable} onClick={props.onRemove}>{t('channels.confirm')}</button>
                <button type="button" className={css.channelAction} onClick={() => { setRemoveOpen(false) }}>{t('channels.cancel')}</button>
              </>
            )
            : (
              <button type="button" className={css.channelAction} data-danger onClick={() => { setRemoveOpen(true) }}>{t('channels.deleteThisChannel')}</button>
            )}
        </div>
      </div>
    </div>
  )
}

/** Props every field control needs regardless of its value type. */
interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/** A staged value field; `secret` renders a password control. */
function ValueField(props: FieldProps & {
  /** Render a password control. */
  secret?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
  /** Label of the dedicated clear control (secret fields). */
  clearLabel?: string
  /** Stage a clear of the stored secret. */
  onClear?: () => void
  /** Whether a stored secret exists (enables the clear control). */
  canClear?: boolean
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
        {props.secret === true && props.canClear === true
          ? (
            <button
              type="button"
              className={css.reset}
              disabled={props.disabled}
              onClick={props.onClear}
            >
              {props.clearLabel ?? props.resetLabel}
            </button>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type={props.secret === true ? 'password' : 'text'}
        autoComplete={props.secret === true ? 'off' : undefined}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** A staged boolean field: 继承 / 开 / 关. */
function BooleanField(props: FieldProps & {
  /** Copy for the inherit option. */
  inheritLabel: string
  /** Copy for the on option. */
  onLabel: string
  /** Copy for the off option. */
  offLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        className={css.select}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.inheritLabel}</option>
        <option value="true">{props.onLabel}</option>
        <option value="false">{props.offLabel}</option>
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

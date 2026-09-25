/**
 * The dsh-imagegen settings card: channel management (list rows with status
 * dots, an editor dialog with the model-catalog alias → upstream mapping, and
 * built-in provider presets), plus the prompt-enhancement model and the plugin
 * switches. Registers as the Image settings page in the Settings dialog's
 * left navigation, independent of the dsh-web-ui family group, and binds to
 * the plugin's own bridge settings scope.
 *
 * The interaction mirrors the host's model-provider page: one row per channel
 * (status dot + edit/delete), two add buttons (built-in provider / custom),
 * and an editor holding API key, display name, API URL, and the model catalog
 * with detection.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CardForm, booleanField, secretField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { ChannelsForm, type ChannelDraft, type ChannelsFormActions, type ChannelsFormState } from './channels-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { describeModel } from '../model-catalog.ts'
import { IMAGE_MODEL_API, PRESETS_API, PROMPT_ENHANCE_API, USAGE_API, CANVAS_SKILL_API, SUBSCRIPTION_API, SUBSCRIPTION_PROVIDERS, SUBSCRIPTION_PROVIDER_DISPLAY_NAMES, DEFAULT_SUBSCRIPTION_MODELS, EXPERIMENTAL_SUBSCRIPTION_PROVIDERS, isChatCompletionsUrl, isSubscriptionProvider, resolveChannelProtocol, type ModelMapping, type PresetProviderView, type SubscriptionProvider } from '../protocol.ts'
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
  localStoragePath?: string
  storageEnabled?: boolean
  storageEndpoint?: string
  storageRegion?: string
  storagePrefix?: string
  storageAccessKey?: string
  storageSecretKey?: string
  storageSyncGallery?: boolean
  storageSyncHistory?: boolean
  skillsEnabled?: boolean
  allowHeavySkills?: boolean
  skillAllowlist?: string
  skillOutputDir?: string
  skillHeavyTimeoutMinutes?: number
  skillAgentPreset?: string
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
  localStoragePath: CardFieldState
  storageEnabled: CardFieldState
  storageEndpoint: CardFieldState
  storageRegion: CardFieldState
  storagePrefix: CardFieldState
  storageAccessKey: CardFieldState
  storageSecretKey: CardFieldState
  storageSyncGallery: CardFieldState
  storageSyncHistory: CardFieldState
  skillsEnabled: CardFieldState
  allowHeavySkills: CardFieldState
  skillAllowlist: CardFieldState
  skillOutputDir: CardFieldState
  skillHeavyTimeoutMinutes: CardFieldState
  skillAgentPreset: CardFieldState
}

/** Result of probing the configured object storage from the card. */
export type SubscriptionStatus = { state: 'logged-in'; email?: string; error?: string } | { state: 'logged-out'; error?: string } | { state: 'unknown'; error?: string }
export type SubscriptionStatusMap = Record<SubscriptionProvider, SubscriptionStatus>

/** Result of probing the configured object storage from the card. */
export interface StorageTestOutcome {
  ok: boolean
  ms?: number
  message?: string
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  /** Channel staging actions (committed together with the card's save). */
  channels: ChannelsFormActions
  /** Save staged edits, then upload a probe object to the configured store. */
  storageTest: () => Promise<StorageTestOutcome>
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
      textField('localStoragePath'),
      booleanField('storageEnabled'),
      textField('storageEndpoint'),
      textField('storageRegion'),
      textField('storagePrefix'),
      textField('storageAccessKey'),
      secretField('storageSecretKey'),
      booleanField('storageSyncGallery'),
      booleanField('storageSyncHistory'),
      booleanField('skillsEnabled'),
      booleanField('allowHeavySkills'),
      textField('skillAllowlist'),
      textField('skillOutputDir'),
      textField('skillHeavyTimeoutMinutes'),
      textField('skillAgentPreset'),
    ], {
      secretSettled: (field) => this.scope.getSecretSetSnapshot(field),
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
      localStoragePath: this.form.field('localStoragePath'),
      storageEnabled: this.form.field('storageEnabled'),
      storageEndpoint: this.form.field('storageEndpoint'),
      storageRegion: this.form.field('storageRegion'),
      storagePrefix: this.form.field('storagePrefix'),
      storageAccessKey: this.form.field('storageAccessKey'),
      storageSecretKey: this.form.field('storageSecretKey'),
      storageSyncGallery: this.form.field('storageSyncGallery'),
      storageSyncHistory: this.form.field('storageSyncHistory'),
      skillsEnabled: this.form.field('skillsEnabled'),
      allowHeavySkills: this.form.field('allowHeavySkills'),
      skillAllowlist: this.form.field('skillAllowlist'),
      skillOutputDir: this.form.field('skillOutputDir'),
      skillHeavyTimeoutMinutes: this.form.field('skillHeavyTimeoutMinutes'),
      skillAgentPreset: this.form.field('skillAgentPreset'),
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
      // The probe needs the values the user is looking at, so staged edits are
      // committed first; the host route then resolves the saved config itself.
      storageTest: async (): Promise<StorageTestOutcome> => {
        await this.form.save()
        try {
          const response = await fetch('/api/dsh-imagegen/storage/test', { method: 'POST' })
          const body = await response.json() as { ok?: unknown; ms?: unknown; message?: unknown }
          if (body.ok === true) return { ok: true, ms: typeof body.ms === 'number' ? body.ms : undefined }
          return { ok: false, message: typeof body.message === 'string' ? body.message : `HTTP ${response.status}` }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this Settings navigation section. */
export type ImageGenSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/** Host-computed usage counters (generation-count badges). */
interface UsageCounters {
  byChannel: Record<string, Record<string, number>>
  totals: Record<string, number>
}

type SettingsSectionId = 'channels' | 'prompt' | 'storage' | 'skills' | 'general' | null

/** One mutually-exclusive settings group. */
function SettingsSection(props: {
  id: Exclude<SettingsSectionId, null>
  title: string
  hint: string
  summary: string
  tone?: 'neutral' | 'ready' | 'attention'
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const contentId = `dsh-imagegen-settings-${props.id}`
  return (
    <section className={css.settingsSection} data-open={props.expanded ? '' : undefined}>
      <button
        type="button"
        className={css.sectionToggle}
        aria-expanded={props.expanded}
        aria-controls={contentId}
        onClick={props.onToggle}
      >
        <span className={css.sectionToggleText}>
          <span className={css.sectionToggleTitle}>{props.title}</span>
          <span className={css.sectionToggleHint}>{props.hint}</span>
        </span>
        <span className={css.sectionSummary} data-tone={props.tone ?? 'neutral'}>{props.summary}</span>
        <span className={css.sectionChevron} aria-hidden="true">{props.expanded ? '⌃' : '⌄'}</span>
      </button>
      {props.expanded ? <div id={contentId} className={css.sectionContent}>{props.children}</div> : null}
    </section>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function ImageGenSettingsSection(props: ImageGenSettingsSectionProps) {
  // The card renders through the plugin's own dictionary so the uiLanguage
  // override applies here too — the host-locale props.t would only follow the
  // DSH interface language.
  const t = tt
  useImageGenLanguageTick()
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  const [open, setOpen] = useState(true)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('channels')
  // Global-section local states (prompt enhancement etc.).
  const [promptModels, setPromptModels] = useState<string[]>([])
  const [loadingPromptModels, setLoadingPromptModels] = useState(false)
  const [promptModelsError, setPromptModelsError] = useState<string | null>(null)
  const [manualPromptModelOpen, setManualPromptModelOpen] = useState(false)
  const [manualPromptModel, setManualPromptModel] = useState('')
  const [promptApiOpen, setPromptApiOpen] = useState(false)
  const [storageTesting, setStorageTesting] = useState(false)
  const [storageTestResult, setStorageTestResult] = useState<string | null>(null)
  const [skillProbing, setSkillProbing] = useState(false)
  const [skillProbeResult, setSkillProbeResult] = useState<string | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatusMap>(() => ({
    'chatgpt-sub': { state: 'unknown' },
    'grok-sub': { state: 'unknown' },
    'google-sub': { state: 'unknown' },
    'openrouter-sub': { state: 'unknown' },
  }))
  const [subscriptionBusy, setSubscriptionBusy] = useState<Partial<Record<SubscriptionProvider, 'login' | 'logout'>>>({})
  const [subscriptionPending, setSubscriptionPending] = useState<SubscriptionProvider[]>([])
  const [subscriptionMessage, setSubscriptionMessage] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  /** Browser OAuth/device tabs opened for each pending subscription login. */
  const subscriptionPopups = useRef<Partial<Record<SubscriptionProvider, Window>>>({})
  // Channel list local states.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetPickerOpen, setPresetPickerOpen] = useState(false)
  const [presets, setPresets] = useState<PresetProviderView[]>([])
  const [presetError, setPresetError] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageCounters | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => () => {
    for (const popup of Object.values(subscriptionPopups.current)) {
      try { popup?.close() } catch { /* ignore */ }
    }
    subscriptionPopups.current = {}
  }, [])

  const refreshSubscriptions = async (): Promise<SubscriptionStatusMap> => {
    const response = await fetch(SUBSCRIPTION_API.status, { method: 'POST', cache: 'no-store' })
    const body = await response.json() as { ok?: boolean; statuses?: Record<string, { state?: string; email?: string; error?: string }>; message?: string }
    if (!response.ok || body.ok !== true || body.statuses === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
    const next: SubscriptionStatusMap = {
      'chatgpt-sub': { state: 'unknown' },
      'grok-sub': { state: 'unknown' },
      'google-sub': { state: 'unknown' },
      'openrouter-sub': { state: 'unknown' },
    }
    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const row = body.statuses[provider]
      if (row?.state === 'logged-in') next[provider] = { state: 'logged-in', ...(typeof row.email === 'string' ? { email: row.email } : {}) }
      else if (row?.state === 'logged-out') next[provider] = { state: 'logged-out', ...(typeof row.error === 'string' ? { error: row.error } : {}) }
    }
    const errors = Object.fromEntries(Object.entries(next).flatMap(([provider, status]) => status.error === undefined ? [] : [[provider, status.error]]))
    if (Object.keys(errors).length > 0) setSubscriptionMessage(current => ({ ...current, ...errors }))
    setSubscriptionStatus(next)
    return next
  }

  useEffect(() => {
    if (!state.exposed || !open) return
    let active = true
    const load = (): void => {
      void refreshSubscriptions().catch(() => { /* badge is best-effort */ })
    }
    load()
    const onFocus = (): void => { if (active) load() }
    window.addEventListener('focus', onFocus)
    return () => { active = false; window.removeEventListener('focus', onFocus) }
  }, [state.exposed, open])

  useEffect(() => {
    const pending = subscriptionPending.filter(provider => subscriptionStatus[provider].state !== 'logged-in')
    if (!open || pending.length === 0) return
    const timer = window.setInterval(() => {
      void refreshSubscriptions().then(next => {
        const landed = pending.filter(provider => next[provider].state === 'logged-in')
        if (landed.length > 0) {
          for (const provider of landed) {
            const popup = subscriptionPopups.current[provider]
            if (popup !== undefined) {
              try { popup.close() } catch { /* cross-origin close is still best-effort */ }
              delete subscriptionPopups.current[provider]
            }
          }
          setSubscriptionPending(current => current.filter(provider => next[provider].state !== 'logged-in'))
          setSubscriptionMessage(current => ({ ...current, ...Object.fromEntries(landed.map(provider => [provider, t('settings.subscriptionLoginOk')])) }))
        }
      }).catch(() => { /* keep polling through transient failures */ })
    }, 2000)
    const timeout = window.setTimeout(() => { setSubscriptionPending([]) }, 10 * 60_000)
    return () => { window.clearInterval(timer); window.clearTimeout(timeout) }
  }, [open, subscriptionPending.join(','), subscriptionStatus])

  const subscriptionLogin = async (provider: SubscriptionProvider): Promise<void> => {
    const previous = subscriptionPopups.current[provider]
    if (previous !== undefined) { try { previous.close() } catch { /* ignore */ } }
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) {
      subscriptionPopups.current[provider] = popup
      try { popup.opener = null } catch { /* ignore */ }
    }
    setSubscriptionBusy(current => ({ ...current, [provider]: 'login' }))
    setSubscriptionMessage(current => ({ ...current, [provider]: '' }))
    try {
      const response = await fetch(SUBSCRIPTION_API.login, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const body = await response.json() as { ok?: boolean; url?: string; code?: string; expiresInSeconds?: number; message?: string }
      if (!response.ok || body.ok !== true || typeof body.url !== 'string') throw new Error(body.message ?? `HTTP ${response.status}`)
      if (popup !== null) popup.location.replace(body.url)
      else window.open(body.url, '_blank')
      if (typeof body.code === 'string' && body.code !== '') {
        setSubscriptionMessage(current => ({ ...current, [provider]: t('settings.subscriptionDeviceCode', { code: body.code ?? '' }) }))
      }
      setSubscriptionPending(current => current.includes(provider) ? current : [...current, provider])
    } catch (error) {
      popup?.close()
      delete subscriptionPopups.current[provider]
      setSubscriptionMessage(current => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSubscriptionBusy(current => { const next = { ...current }; delete next[provider]; return next })
    }
  }

  const subscriptionComplete = async (provider: SubscriptionProvider, input: string): Promise<void> => {
    setSubscriptionBusy(current => ({ ...current, [provider]: 'login' }))
    setSubscriptionMessage(current => ({ ...current, [provider]: '' }))
    try {
      const response = await fetch(SUBSCRIPTION_API.login, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, action: 'complete', input }),
      })
      const body = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
      await refreshSubscriptions()
      const popup = subscriptionPopups.current[provider]
      if (popup !== undefined) {
        try { popup.close() } catch { /* ignore */ }
        delete subscriptionPopups.current[provider]
      }
      setSubscriptionPending(current => current.filter(item => item !== provider))
      setSubscriptionMessage(current => ({ ...current, [provider]: t('settings.subscriptionLoginOk') }))
    } catch (error) {
      setSubscriptionMessage(current => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSubscriptionBusy(current => { const next = { ...current }; delete next[provider]; return next })
    }
  }

  const subscriptionLogout = async (provider: SubscriptionProvider): Promise<void> => {
    setSubscriptionBusy(current => ({ ...current, [provider]: 'logout' }))
    setSubscriptionMessage(current => ({ ...current, [provider]: '' }))
    try {
      const response = await fetch(SUBSCRIPTION_API.login, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, action: 'logout' }),
      })
      const body = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`)
      const popup = subscriptionPopups.current[provider]
      if (popup !== undefined) {
        try { popup.close() } catch { /* ignore */ }
        delete subscriptionPopups.current[provider]
      }
      setSubscriptionStatus(current => ({ ...current, [provider]: { state: 'logged-out' } }))
      setSubscriptionPending(current => current.filter(item => item !== provider))
    } catch (error) {
      setSubscriptionMessage(current => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSubscriptionBusy(current => { const next = { ...current }; delete next[provider]; return next })
    }
  }

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
      <section className={css.card} data-dsh-imagegen-settings-panel>
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
      </section>
    )
  }

  const channels = state.channels.channels
  const modelGroups = channels
    .map(channel => ({ id: channel.id, name: channel.name.trim() || channel.id, models: [...new Set(channel.models.map(model => model.alias).filter(alias => alias !== ''))] }))
    .filter(group => group.models.length > 0)
  const modelAliases = [...new Set(modelGroups.flatMap(group => group.models))]
  const editing = editingId === null ? undefined : channels.find(channel => channel.id === editingId)
  const readyChannels = channels.filter(channel => state.channels.keySet[channel.id] === true && channel.models.length > 0).length
  const totalModels = channels.reduce((total, channel) => total + channel.models.length, 0)
  const channelSummary = channels.length === 0
    ? t('settings.summaryNotConfigured')
    : t('settings.summaryChannels', { ready: readyChannels, total: channels.length })
  const promptSummary = state.promptModel.text.trim() || t('settings.summaryOptional')
  const storageSummary = state.storageEnabled.text === 'true' ? t('settings.summaryEnabled') : t('settings.summaryDisabled')
  const skillsSummary = state.skillsEnabled.text === 'false' ? t('settings.summaryDisabled') : t('settings.summaryEnabled')
  const generalSummary = state.enabled.text === 'false' ? t('settings.summaryDisabled') : t('settings.summaryEnabled')
  const overallReady = readyChannels > 0
  const headerDescription = channels.length === 0
    ? t('settings.headerNeedsChannel')
    : t('settings.headerSummary', { channels: channels.length, models: totalModels })
  const summaryItems: Array<{ id: Exclude<SettingsSectionId, null>; label: string; value: string; tone?: 'neutral' | 'ready' | 'attention' }> = [
    { id: 'channels', label: t('settings.summaryChannelsLabel'), value: channelSummary, tone: readyChannels > 0 ? 'ready' : 'attention' },
    { id: 'prompt', label: t('settings.summaryPromptLabel'), value: promptSummary },
    { id: 'storage', label: t('settings.summaryStorageLabel'), value: storageSummary, tone: state.storageEnabled.text === 'true' ? 'ready' : 'neutral' },
    { id: 'skills', label: t('settings.summarySkillsLabel'), value: skillsSummary, tone: state.skillsEnabled.text === 'false' ? 'neutral' : 'ready' },
    { id: 'general', label: t('settings.summaryGeneralLabel'), value: generalSummary, tone: state.enabled.text === 'false' ? 'attention' : 'ready' },
  ]

  return (
    <section className={css.card} data-dsh-imagegen-settings-panel>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{headerDescription}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            <section className={css.overview}>
              <div className={css.overviewHead}>
                <div>
                  <h3 className={css.overviewTitle}>{t('settings.summaryTitle')}</h3>
                  <p className={css.overviewHint}>{t('settings.summaryHint')}</p>
                </div>
                <span className={css.healthBadge} data-state={overallReady ? 'ready' : 'attention'}>
                  {overallReady ? t('settings.summaryReady') : t('settings.summaryNeedsSetup')}
                </span>
              </div>
              <div className={css.summaryGrid}>
                {summaryItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={css.summaryCard}
                    data-active={activeSection === item.id ? '' : undefined}
                    data-tone={item.tone ?? 'neutral'}
                    onClick={() => { setActiveSection(activeSection === item.id ? null : item.id) }}
                  >
                    <span className={css.summaryLabel}>{item.label}</span>
                    <strong className={css.summaryValue}>{item.value}</strong>
                  </button>
                ))}
              </div>
            </section>

            <SettingsSection
              id="channels"
              title={t('channels.title')}
              hint={t('channels.hint')}
              summary={channelSummary}
              tone={readyChannels > 0 ? 'ready' : 'attention'}
              expanded={activeSection === 'channels'}
              onToggle={() => { setActiveSection(activeSection === 'channels' ? null : 'channels') }}
            >
              {channels.length === 0
                ? <p className={css.channelEmpty}>{t('channels.empty')}</p>
                : (
                  <ul className={css.channelList}>
                    {channels.map(channel => {
                      const keyHeld = state.channels.keySet[channel.id] === true
                      const subscriptionProvider = isSubscriptionProvider(channel.subscription) ? channel.subscription : undefined
                      const subscriptionState = subscriptionProvider === undefined ? undefined : subscriptionStatus[subscriptionProvider]
                      const ready = subscriptionProvider === undefined ? keyHeld && channel.models.length > 0 : subscriptionState?.state === 'logged-in'
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
                              <span className={css.channelBadge} data-warn={!ready ? '' : undefined}>
                                {subscriptionProvider === undefined
                                  ? <>{keyHeld ? t('channels.keySet') : t('channels.keyMissing')}{' · '}{channel.models.length > 0 ? t('channels.modelCount', { n: channel.models.length }) : t('channels.noModels')}</>
                                  : <>{SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[subscriptionProvider]}{' · '}{subscriptionState?.state === 'logged-in' ? t('settings.subscriptionLoggedIn') : t('settings.subscriptionLoggedOut')}</>}
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
                    const existing = preset.subscription === undefined
                      ? undefined
                      : channels.find(channel => channel.subscription === preset.subscription)
                    const draft = existing ?? newChannelDraft(preset)
                    if (existing === undefined) props.channels.setChannels([...channels, draft])
                    setPresetPickerOpen(false)
                    setEditingId(draft.id)
                    if (preset.subscription !== undefined && subscriptionStatus[preset.subscription].state !== 'logged-in') {
                      void subscriptionLogin(preset.subscription)
                    }
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

              {modelAliases.length > 0 ? (
                <div className={css.defaultModelRow}>
                  <label htmlFor="dsh-imagegen-default-model">
                    <strong>{t('channels.defaultModel')}</strong>
                    <small>{t('channels.defaultModelHint')}</small>
                  </label>
                  <select
                    id="dsh-imagegen-default-model"
                    className={css.modelChoices}
                    value={state.channels.defaultModel}
                    disabled={disabled}
                    onChange={event => { props.channels.setDefaultModel(event.target.value) }}
                  >
                    {modelGroups.map(group => <optgroup key={group.id} label={group.name}>
                      {group.models.map(model => <option key={`${group.id}:${model}`} value={model}>{model}</option>)}
                    </optgroup>)}
                  </select>
                </div>
              ) : null}
              <div className={css.channelAddRow}>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { setPresetError(null); setPresetPickerOpen(true) }}>+ {t('channels.addProvider')}</button>
                <button type="button" className={css.channelAdd} disabled={disabled} onClick={() => { addCustomChannel(channels, props.channels, setEditingId) }}>+ {t('channels.addCustom')}</button>
              </div>
              </div>
            </SettingsSection>

            <SettingsSection
              id="prompt"
              title={t('settings.promptEnhanceTitle')}
              hint={t('settings.promptEnhanceHint')}
              summary={promptSummary}
              tone={state.promptModel.text.trim() === '' ? 'neutral' : 'ready'}
              expanded={activeSection === 'prompt'}
              onToggle={() => { setActiveSection(activeSection === 'prompt' ? null : 'prompt') }}
            >
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
              <button type="button" className={css.addModel} disabled={disabled} onClick={() => { setManualPromptModelOpen(open => !open); setActiveSection('prompt') }}>
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
            </SettingsSection>

            <SettingsSection
              id="storage"
              title={t('settings.storageTitle')}
              hint={t('settings.storageHint')}
              summary={storageSummary}
              tone={state.storageEnabled.text === 'true' ? 'ready' : 'neutral'}
              expanded={activeSection === 'storage'}
              onToggle={() => { setActiveSection(activeSection === 'storage' ? null : 'storage') }}
            >
            <ValueField
              id="dsh-imagegen-settings-local-storage-path"
              label={t('settings.localStoragePath')}
              hint={t('settings.localStoragePathHint')}
              placeholder="E:\\dsh-imagegen-data"
              {...fieldProps}
              {...state.localStoragePath}
              onEdit={(text) => { props.edit('localStoragePath', text) }}
              onReset={() => { props.resetField('localStoragePath') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-enabled"
              label={t('settings.storageEnabled')}
              hint={t('settings.storageHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageEnabled}
              onEdit={(text) => { props.edit('storageEnabled', text) }}
              onReset={() => { props.resetField('storageEnabled') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-endpoint"
              label={t('settings.storageEndpoint')}
              hint={t('settings.storageEndpointHint')}
              placeholder="https://bucket-appid.cos.ap-guangzhou.myqcloud.com"
              {...fieldProps}
              {...state.storageEndpoint}
              onEdit={(text) => { props.edit('storageEndpoint', text) }}
              onReset={() => { props.resetField('storageEndpoint') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-region"
              label={t('settings.storageRegion')}
              hint={t('settings.storageRegionHint')}
              placeholder="ap-guangzhou"
              {...fieldProps}
              {...state.storageRegion}
              onEdit={(text) => { props.edit('storageRegion', text) }}
              onReset={() => { props.resetField('storageRegion') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-prefix"
              label={t('settings.storagePrefix')}
              hint={t('settings.storagePrefixHint')}
              placeholder="dsh-imagegen"
              {...fieldProps}
              {...state.storagePrefix}
              onEdit={(text) => { props.edit('storagePrefix', text) }}
              onReset={() => { props.resetField('storagePrefix') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-accesskey"
              label={t('settings.storageAccessKey')}
              hint={t('settings.storageAccessKeyHint')}
              placeholder="AKID…"
              {...fieldProps}
              {...state.storageAccessKey}
              onEdit={(text) => { props.edit('storageAccessKey', text) }}
              onReset={() => { props.resetField('storageAccessKey') }}
            />
            <ValueField
              id="dsh-imagegen-settings-storage-secretkey"
              label={t('settings.storageSecretKey')}
              hint={t('settings.storageSecretKeyHint')}
              placeholder="…"
              secret
              {...fieldProps}
              {...state.storageSecretKey}
              overridden={false}
              onEdit={(text) => { props.edit('storageSecretKey', text) }}
              onReset={() => { props.resetField('storageSecretKey') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-gallery"
              label={t('settings.storageSyncGallery')}
              hint={t('settings.storageSyncGalleryHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageSyncGallery}
              onEdit={(text) => { props.edit('storageSyncGallery', text) }}
              onReset={() => { props.resetField('storageSyncGallery') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-storage-history"
              label={t('settings.storageSyncHistory')}
              hint={t('settings.storageSyncHistoryHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.storageSyncHistory}
              onEdit={(text) => { props.edit('storageSyncHistory', text) }}
              onReset={() => { props.resetField('storageSyncHistory') }}
            />
            <div className={css.modelSummary}>
              <button
                type="button"
                className={css.addModel}
                disabled={disabled || storageTesting}
                onClick={() => {
                  setStorageTesting(true)
                  setStorageTestResult(null)
                  void props.storageTest().then(outcome => {
                    setStorageTestResult(outcome.ok
                      ? t('settings.storageTestOk', { ms: outcome.ms ?? 0 })
                      : t('settings.storageTestFailed', { error: outcome.message ?? 'error' }))
                  }).finally(() => { setStorageTesting(false) })
                }}
              >
                {storageTesting ? t('settings.storageTesting') : t('settings.storageTest')}
              </button>
              {storageTestResult !== null ? <p className={css.failed} role="status">{storageTestResult}</p> : null}
            </div>
            <p className={css.hint}>{t('settings.storageKeyHint')}</p>
            </SettingsSection>

            <SettingsSection
              id="skills"
              title={t('settings.skillsTitle')}
              hint={t('settings.skillsHint')}
              summary={skillsSummary}
              tone={state.skillsEnabled.text === 'false' ? 'neutral' : 'ready'}
              expanded={activeSection === 'skills'}
              onToggle={() => { setActiveSection(activeSection === 'skills' ? null : 'skills') }}
            >
            <BooleanField
              id="dsh-imagegen-settings-skills-enabled"
              label={t('settings.skillsEnabled')}
              hint={t('settings.skillsEnabledHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.skillsEnabled}
              onEdit={(text) => { props.edit('skillsEnabled', text) }}
              onReset={() => { props.resetField('skillsEnabled') }}
            />
            <BooleanField
              id="dsh-imagegen-settings-skills-heavy"
              label={t('settings.allowHeavySkills')}
              hint={t('settings.allowHeavySkillsHint')}
              inheritLabel={t('settings.inherit')}
              onLabel={t('settings.on')}
              offLabel={t('settings.off')}
              {...fieldProps}
              {...state.allowHeavySkills}
              onEdit={(text) => { props.edit('allowHeavySkills', text) }}
              onReset={() => { props.resetField('allowHeavySkills') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-allowlist"
              label={t('settings.skillAllowlist')}
              hint={t('settings.skillAllowlistHint')}
              placeholder="extract-content, image-to-editable-ppt"
              {...fieldProps}
              {...state.skillAllowlist}
              onEdit={(text) => { props.edit('skillAllowlist', text) }}
              onReset={() => { props.resetField('skillAllowlist') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-output"
              label={t('settings.skillOutputDir')}
              hint={t('settings.skillOutputDirHint')}
              placeholder=""
              {...fieldProps}
              {...state.skillOutputDir}
              onEdit={(text) => { props.edit('skillOutputDir', text) }}
              onReset={() => { props.resetField('skillOutputDir') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-timeout"
              label={t('settings.skillHeavyTimeout')}
              hint={t('settings.skillHeavyTimeoutHint')}
              placeholder="20"
              {...fieldProps}
              {...state.skillHeavyTimeoutMinutes}
              onEdit={(text) => { props.edit('skillHeavyTimeoutMinutes', text) }}
              onReset={() => { props.resetField('skillHeavyTimeoutMinutes') }}
            />
            <ValueField
              id="dsh-imagegen-settings-skills-preset"
              label={t('settings.skillAgentPreset')}
              hint={t('settings.skillAgentPresetHint')}
              placeholder=""
              {...fieldProps}
              {...state.skillAgentPreset}
              onEdit={(text) => { props.edit('skillAgentPreset', text) }}
              onReset={() => { props.resetField('skillAgentPreset') }}
            />
            <div className={css.modelSummary}>
              <button
                type="button"
                className={css.addModel}
                disabled={disabled || skillProbing}
                onClick={() => {
                  setSkillProbing(true)
                  setSkillProbeResult(null)
                  void fetch(CANVAS_SKILL_API.list, { method: 'POST' })
                    .then(async response => await response.json() as { ok?: boolean; skills?: unknown[]; agentAvailable?: boolean; registryAvailable?: boolean })
                    .then(body => {
                      const total = Array.isArray(body.skills) ? body.skills.length : 0
                      setSkillProbeResult(t('settings.skillProbeOk', {
                        count: total,
                        agent: body.agentAvailable === true ? t('settings.skillProbeAgentOn') : t('settings.skillProbeAgentOff'),
                      }))
                    })
                    .catch(caught => { setSkillProbeResult(t('settings.storageTestFailed', { error: caught instanceof Error ? caught.message : String(caught) })) })
                    .finally(() => { setSkillProbing(false) })
                }}
              >
                {skillProbing ? t('settings.skillProbing') : t('settings.skillProbe')}
              </button>
              {skillProbeResult !== null ? <p className={css.hint} role="status">{skillProbeResult}</p> : null}
            </div>
            </SettingsSection>

            <SettingsSection
              id="general"
              title={t('settings.generalTitle')}
              hint={t('settings.generalHint')}
              summary={generalSummary}
              tone={state.enabled.text === 'false' ? 'attention' : 'ready'}
              expanded={activeSection === 'general'}
              onToggle={() => { setActiveSection(activeSection === 'general' ? null : 'general') }}
            >
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
              onEdit={(text) => { props.edit('allowAgentImageGeneration', text) }}
              onReset={() => { props.resetField('allowAgentImageGeneration') }}
            />
            </SettingsSection>
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
          subscriptionStatus={editing.subscription === undefined ? undefined : subscriptionStatus[editing.subscription]}
          subscriptionBusy={editing.subscription === undefined ? undefined : subscriptionBusy[editing.subscription]}
          subscriptionMessage={editing.subscription === undefined ? undefined : subscriptionMessage[editing.subscription]}
          onSubscriptionLogin={(provider) => { void subscriptionLogin(provider) }}
          onSubscriptionComplete={(provider, input) => { void subscriptionComplete(provider, input) }}
          onSubscriptionLogout={(provider) => { void subscriptionLogout(provider) }}
          onSetDefault={() => { props.channels.setDefaultChannel(editing.id) }}
          onRemove={() => { props.channels.setChannels(channels.filter(channel => channel.id !== editing.id)); if (editing.id === state.channels.defaultChannelId && channels.length > 1) { const next = channels.find(channel => channel.id !== editing.id); if (next !== undefined) props.channels.setDefaultChannel(next.id) } setEditingId(null) }}
          onClose={() => { setEditingId(null) }}
        />
      ) : null}

    </section>
  )
}

/** Channel row + dialog helpers -------------------------------------------------- */

function newChannelDraft(preset: PresetProviderView | undefined): ChannelDraft {
  return {
    id: clientId(),
    preset: preset?.id ?? '',
    name: preset?.name ?? '',
    apiUrl: preset?.apiUrl ?? '',
    apiUrlFull: false,
    protocol: 'auto',
    ...preset?.subscription === undefined ? {} : { auth: 'subscription' as const, subscription: preset.subscription },
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
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'api-key' | 'subscription'>('api-key')
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    props.onLoad()
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [props.onClose])
  const tabPresets = props.presets.filter(preset => tab === 'subscription' ? preset.subscription !== undefined : preset.subscription === undefined)
  const needle = query.trim().toLowerCase()
  const visiblePresets = needle === '' ? tabPresets : tabPresets.filter(preset =>
    preset.name.toLowerCase().includes(needle) || preset.models.some(model => model.alias.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)),
  )
  return (
    <div
      className={css.pickerOverlay}
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}
    >
      <section className={css.pickerDialog} role="dialog" aria-modal="true" aria-label={t('channels.presetPickerTitle')}>
        <header className={css.pickerHeader}>
          <div>
            <h3 className={css.pickerTitle}>{t('channels.presetPickerTitle')}</h3>
            <p className={css.pickerHint}>{t(tab === 'subscription' ? 'channels.presetPickerSubscriptionHint' : 'channels.presetPickerApiKeyHint')}</p>
          </div>
          <button type="button" className={css.editorClose} aria-label={t('preview.close')} onClick={props.onClose}>×</button>
        </header>
        <div className={css.pickerTabs} role="tablist" aria-label={t('channels.presetPickerTitle')}>
          <button type="button" role="tab" aria-selected={tab === 'api-key'} data-active={tab === 'api-key' ? '' : undefined} onClick={() => { setTab('api-key'); setQuery('') }}>{t('channels.presetTabApiKey')}</button>
          <button type="button" role="tab" aria-selected={tab === 'subscription'} data-active={tab === 'subscription' ? '' : undefined} onClick={() => { setTab('subscription'); setQuery('') }}>{t('channels.presetTabSubscription')}</button>
        </div>
        <input
          className={css.pickerSearch}
          type="search"
          value={query}
          placeholder={t('channels.presetSearch')}
          aria-label={t('channels.presetSearch')}
          onChange={event => { setQuery(event.target.value) }}
        />
        <div className={css.pickerList}>
          {visiblePresets.map(preset => (
            <button key={preset.id} type="button" className={css.presetRow} disabled={props.disabled} onClick={() => { props.onPick(preset) }}>
              <span className={css.presetName}>{preset.name}</span>
              <span className={css.presetMeta}>{preset.models.map(model => model.alias).join(' · ')}</span>
              {preset.subscription === undefined ? null : <span className={css.presetAction}>{t('channels.presetClickToLogin')}</span>}
            </button>
          ))}
          {visiblePresets.length === 0 && tabPresets.length > 0 ? <p className={css.pickerEmpty}>{t('channels.presetEmpty')}</p> : null}
          {tab === 'api-key' ? <button type="button" className={css.presetRow} data-custom disabled={props.disabled} onClick={props.onCustom}>
            <span className={css.presetName}>+ {t('channels.addCustom')}</span>
            <span className={css.presetHint}>{t('channels.presetCustomHint')}</span>
          </button> : null}
          {props.error !== null ? <p className={css.failed} role="status">{t('channels.presetLoadFailed', { error: props.error })}</p> : null}
        </div>
      </section>
    </div>
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
  subscriptionStatus?: SubscriptionStatus
  subscriptionBusy?: 'login' | 'logout'
  subscriptionMessage?: string
  onSubscriptionLogin: (provider: SubscriptionProvider) => void
  onSubscriptionComplete: (provider: SubscriptionProvider, input: string) => void
  onSubscriptionLogout: (provider: SubscriptionProvider) => void
  onSetDefault: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { t, channel } = props
  const subscription = isSubscriptionProvider(channel.subscription) ? channel.subscription : undefined
  const subscriptionMode = channel.auth === 'subscription' && subscription !== undefined
  const [keyDraft, setKeyDraft] = useState('')
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [manualId, setManualId] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')
  const [manualAuthInput, setManualAuthInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null)

  const generatedCount = (alias: string): number => {
    if (props.usage === null) return 0
    const channelBucket = props.usage.byChannel[channel.id] ?? props.usage.byChannel[`name:${channel.name}`] ?? {}
    return channelBucket[alias] ?? props.usage.totals[alias] ?? 0
  }

  const detect = (): void => {
    if (channel.apiUrlFull && resolveChannelProtocol(channel.apiUrl, channel.protocol) !== 'chat-completions') return
    setDetecting(true)
    setDetectError(null)
    const payload: Record<string, unknown> = {
      channelId: channel.id,
      apiUrlFull: channel.apiUrlFull,
      protocol: channel.protocol ?? 'auto',
    }
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
    if (!subscriptionMode && (!channel.apiUrlFull || resolveChannelProtocol(channel.apiUrl, channel.protocol) === 'chat-completions') && channel.apiUrl.trim() !== '' && (props.keyHeld || keyDraft.trim() !== '')) detect()
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

        <div className={css.editorGrid}>
          <div className={css.editorField}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-name">{t('channels.displayName')}</label>
            <input id="dsh-imagegen-channel-name" className={css.input} value={channel.name} placeholder={t('channels.untitled')} disabled={!props.writable} onChange={event => { props.onPatch({ name: event.target.value }) }} />
          </div>
          <div className={css.editorField}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-auth">{t('channels.authMode')}</label>
            <select
              id="dsh-imagegen-channel-auth"
              className={css.select}
              value={channel.auth ?? 'api-key'}
              disabled={!props.writable}
              onChange={event => {
                if (event.target.value === 'subscription') {
                  const provider = subscription ?? 'grok-sub'
                  const model = DEFAULT_SUBSCRIPTION_MODELS[provider]
                  props.onPatch({ auth: 'subscription', subscription: provider, apiUrl: '', apiUrlFull: false, models: [{ alias: model, id: model }] })
                } else {
                  props.onPatch({ auth: 'api-key', subscription: undefined })
                }
              }}
            >
              <option value="api-key">{t('channels.authModeApiKey')}</option>
              <option value="subscription">{t('channels.authModeSubscription')}</option>
            </select>
          </div>
        </div>

        {subscriptionMode ? (
          <div className={css.subscriptionBox}>
            <div className={css.subscriptionAccount}>
              <span className={css.subscriptionDot} data-state={props.subscriptionStatus?.state ?? 'unknown'} aria-hidden="true" />
              <div>
                <strong>{SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[subscription]}</strong>
                <small>{props.subscriptionStatus?.state === 'logged-in'
                  ? props.subscriptionStatus.email ?? t('settings.subscriptionLoggedIn')
                  : t('settings.subscriptionLoggedOut')}</small>
              </div>
            </div>
            {EXPERIMENTAL_SUBSCRIPTION_PROVIDERS.has(subscription) ? <p className={css.subscriptionWarning}>{t('settings.subscriptionExperimental')}</p> : null}
            <label className={css.editorField}>
              <span className={css.label}>{t('channels.subscriptionProvider')}</span>
              <select
                className={css.select}
                value={subscription}
                disabled={!props.writable || props.subscriptionStatus?.state === 'logged-in'}
                onChange={event => {
                  const provider = event.target.value as SubscriptionProvider
                  const model = DEFAULT_SUBSCRIPTION_MODELS[provider]
                  props.onPatch({ subscription: provider, models: [{ alias: model, id: model }] })
                }}
              >
                {SUBSCRIPTION_PROVIDERS.map(provider => <option key={provider} value={provider}>{SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[provider]}{EXPERIMENTAL_SUBSCRIPTION_PROVIDERS.has(provider) ? ' · ' + t('settings.subscriptionExperimentalTag') : ''}</option>)}
              </select>
            </label>
            <label className={css.editorField}>
              <span className={css.label}>{t('channels.modelCatalogTitle')}</span>
              <input className={css.input} value={DEFAULT_SUBSCRIPTION_MODELS[subscription]} readOnly disabled />
            </label>
            <div className={css.modelSummary}>
              {props.subscriptionStatus?.state === 'logged-in'
                ? <button type="button" className={css.addModel} disabled={!props.writable || props.subscriptionBusy !== undefined} onClick={() => { props.onSubscriptionLogout(subscription) }}>{props.subscriptionBusy === 'logout' ? t('settings.subscriptionLoggingOut') : t('settings.subscriptionLogout')}</button>
                : <button type="button" className={css.addModel} disabled={!props.writable || props.subscriptionBusy !== undefined} onClick={() => { props.onSubscriptionLogin(subscription) }}>{props.subscriptionBusy === 'login' ? t('settings.subscriptionLoggingIn') : t('settings.subscriptionLogin')}</button>}
            </div>
            {props.subscriptionMessage ? <p className={css.hint} role="status">{props.subscriptionMessage}</p> : null}
            {props.subscriptionStatus?.state !== 'logged-in' ? <div className={css.subscriptionManual}>
              <p className={css.fieldHint}>{t('settings.subscriptionManualHint')}</p>
              <div className={css.manualModelRow}>
                <input className={css.input} value={manualAuthInput} placeholder={t('settings.subscriptionManualPlaceholder')} disabled={!props.writable || props.subscriptionBusy !== undefined} onChange={event => { setManualAuthInput(event.target.value) }} />
                <button type="button" className={css.addModel} disabled={!props.writable || manualAuthInput.trim() === '' || props.subscriptionBusy !== undefined} onClick={() => { props.onSubscriptionComplete(subscription, manualAuthInput.trim()) }}>{t('settings.subscriptionManualComplete')}</button>
              </div>
            </div> : null}
            <p className={css.fieldHint}>{t('settings.subscriptionIsolationHint')}</p>
          </div>
        ) : <>
        <div className={css.editorGrid} data-connection>
          <div className={css.editorField}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-url">{t('channels.apiUrl')}</label>
            <input id="dsh-imagegen-channel-url" className={css.input} value={channel.apiUrl} placeholder={channel.apiUrlFull ? 'https://api.example.com/v1/wand/si-image/generation' : 'https://api.example.com/v1'} disabled={!props.writable} onChange={event => {
              const apiUrl = event.target.value
              props.onPatch({ apiUrl, ...isChatCompletionsUrl(apiUrl) ? { apiUrlFull: true } : {} })
            }} />
          </div>
          <div className={css.editorField}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-protocol">{t('channels.protocol')}</label>
            <select
              id="dsh-imagegen-channel-protocol"
              className={css.input}
              value={channel.protocol ?? 'auto'}
              disabled={!props.writable}
              onChange={event => { props.onPatch({ protocol: event.target.value as ChannelDraft['protocol'] }) }}
            >
              <option value="auto">{t('channels.protocolAuto')}</option>
              <option value="images">{t('channels.protocolImages')}</option>
              <option value="chat-completions">{t('channels.protocolChat')}</option>
            </select>
          </div>
        </div>
        <p className={css.fieldHint}>{t('channels.protocolHint')}</p>
        <label className={css.checkboxRow}>
          <input type="checkbox" checked={channel.apiUrlFull} disabled={!props.writable} onChange={event => { props.onPatch({ apiUrlFull: event.target.checked }) }} />
          <span>{t('channels.apiUrlFull')}</span>
        </label>
        {channel.apiUrlFull ? <p className={css.fieldHint}>{t('channels.apiUrlFullHint')}</p> : null}
        <div className={css.editorField}>
          <div className={css.head}>
            <label className={css.label} htmlFor="dsh-imagegen-channel-key">{t('channels.apiKey')}</label>
            <div className={css.keyActions}>
              <span className={css.keyState} data-set={props.keyHeld || keyDraft !== '' ? '' : undefined}>
                {props.keyHeld || keyDraft !== '' ? t('channels.keySet') : t('channels.keyMissing')}
              </span>
              {props.keyHeld || keyDraft !== '' ? (
                <button type="button" className={css.reset} disabled={!props.writable} onClick={() => { setKeyDraft(''); props.onSetKey(undefined) }}>
                  {t('channels.keyClear')}
                </button>
              ) : null}
            </div>
          </div>
          <div className={css.keyInputRow}>
            <input
              id="dsh-imagegen-channel-key"
              className={css.input}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={keyDraft}
              placeholder={props.keyHeld ? t('channels.keyReplaceHint') : t('channels.keyMissingHint')}
              disabled={!props.writable}
              onChange={event => { const value = event.target.value; setKeyDraft(value); props.onSetKey(value === '' ? undefined : value) }}
            />
            <button type="button" className={css.keyVisibility} disabled={!props.writable} onClick={() => { setShowKey(value => !value) }}>
              {showKey ? t('channels.hideKey') : t('channels.showKey')}
            </button>
          </div>
        </div>

        <div className={css.editorDivider} />

        <div className={css.modelCatalog}>
        <div className={css.editorSectionHeader}>
          <h4 className={css.label}>{t('channels.modelCatalogTitle')}</h4>
          <button type="button" className={css.modelFetch} disabled={!props.writable || detecting || (channel.apiUrlFull && resolveChannelProtocol(channel.apiUrl, channel.protocol) !== 'chat-completions')} onClick={detect}>
            {detecting ? t('channels.detecting') : candidates === null && channel.models.length === 0 ? t('channels.detectFirst') : t('channels.detect')}
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
                  <li key={`${model.alias}-${index}`} className={css.modelRow} data-editing={editingModelIndex === index ? '' : undefined}>
                    {editingModelIndex === index ? (
                      <div className={css.modelRowEditor}>
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
                        <button type="button" className={css.modelRowDone} onClick={() => { setEditingModelIndex(null) }}>{t('channels.done')}</button>
                      </div>
                    ) : (
                      <div className={css.modelRowSummary}>
                        <div className={css.modelRowTitle}>
                          <span className={css.modelRowName} title={model.alias}>{model.alias}</span>
                          <span className={css.modelBadge}>{entry.labelZh}{entry.known ? '' : ` · ${t('channels.unknownProtocol')}`}</span>
                          {generated > 0 ? <span className={css.modelBadge} data-verified>{t('channels.generated', { n: generated })}</span> : null}
                        </div>
                        {model.id !== model.alias ? <span className={css.modelRowUpstream} title={model.id}>→ {model.id}</span> : null}
                      </div>
                    )}
                    <div className={css.modelRowActions}>
                      {editingModelIndex === index ? null : (
                        <button type="button" className={css.modelRowEdit} disabled={!props.writable} onClick={() => { setEditingModelIndex(index) }}>{t('channels.edit')}</button>
                      )}
                      <button type="button" className={css.modelRowRemove} disabled={!props.writable} aria-label={`${t('channels.removeModel')}: ${model.alias}`} onClick={() => { setEditingModelIndex(null); props.onSetModels(channel.models.filter((_, i) => i !== index)) }}>×</button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

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
        </div>

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
        </>}

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

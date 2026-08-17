/**
 * The dsh-imagegen settings card: api_url, api_key (secret, display-only
 * "set" state), and the plugin switches. Registers into the official
 * `settings.plugin.item` slot (the Settings → Plugins → Configurable tab),
 * independent of the dsh-web-ui family group, bound to the plugin's own
 * bridge settings scope.
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, booleanField, secretField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import type { ImageGenScope } from './settings-scope.ts'
import { PLUGIN_VERSION } from '../protocol.ts'
import css from './settings-card.module.css'

/** The fields this card edits (the namespace's full schema). */
export interface ImageGenSettings {
  enabled?: boolean
  announceToAgent?: boolean
  apiUrl?: string
  apiKey?: string
}

/** What the card renders. */
export interface ImageGenSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** System-prompt announcement flag. */
  announceToAgent: CardFieldState
  /** API base URL. */
  apiUrl: CardFieldState
  /** API key draft (the stored value is never rendered). */
  apiKey: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface ImageGenSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useImageGenSettingsCard. */
    imageGenSettingsCard: SnapshotStore<ImageGenSettingsCardState>
    /** Whether a secret (apiKey) is currently stored. */
    imageGenKeySet: SnapshotStore<boolean>
  }
}

/** Bridges the imagegen scope onto the card's staged form. */
export class ImageGenSettingsCardController {
  private readonly form: CardForm<ImageGenSettings>

  /** @param scope - the bound bridge scope for the dsh-imagegen namespace. */
  constructor(private readonly scope: ImageGenScope) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      textField('apiUrl'),
      secretField('apiKey'),
    ], {
      // The redacted wire view never returns the key; a save's outcome is
      // judged by the namespace's secrets sidecar instead.
      secretSettled: () => this.scope.getKeySetSnapshot(),
    })
  }

  private projection(): ImageGenSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      apiUrl: this.form.field('apiUrl'),
      apiKey: this.form.field('apiKey'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, the key-set flag, and the form actions.
   */
  inject(): ImageGenSettingsCardFace {
    const cardStore = this.form.bind(() => this.projection())
    const keySetStore = createSnapshotStore(this.scope.getKeySetSnapshot())
    this.scope.subscribeKeySet(() => { keySetStore.set(this.scope.getKeySetSnapshot()) })
    return {
      hooks: {
        imageGenSettingsCard: cardStore,
        imageGenKeySet: keySetStore,
      },
      ...this.form.actions(),
    }
  }
}

/** Props the renderer binds for this card. */
export type ImageGenSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'dsh-imagegen'>
  & InjectFace<ImageGenSettingsCardFace>

/**
 * Render the card.
 * @param props - locale copy, the card snapshot, and the form actions.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function ImageGenSettingsCard(props: ImageGenSettingsCardProps) {
  const { t } = props
  const state = props.useImageGenSettingsCard(snapshot => snapshot)
  const keySet = props.useImageGenKeySet(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const title = t('settings.title')
  const blocked = !state.dirty || state.invalid || state.saving
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
            <div className={css.versionRow}>
              <span className={css.versionLabel}>{t('settings.currentVersion')}</span>
              <code className={css.versionValue}>v{PLUGIN_VERSION}</code>
            </div>
            <ValueField
              id="dsh-imagegen-settings-apikey"
              label={t('settings.apiKey')}
              hint={keySet ? t('settings.apiKeySet') : t('settings.apiKeyHint')}
              placeholder="sk-…"
              secret
              {...fieldProps}
              {...state.apiKey}
              overridden={false}
              onEdit={(text) => { props.edit('apiKey', text) }}
              onReset={() => { props.resetField('apiKey') }}
              clearLabel={t('settings.apiKeyClear')}
              onClear={() => { props.resetField('apiKey') }}
              canClear={keySet}
            />
            <ValueField
              id="dsh-imagegen-settings-apiurl"
              label={t('settings.apiUrl')}
              hint={t('settings.apiUrlHint')}
              placeholder="https://api.openai.com/v1"
              {...fieldProps}
              {...state.apiUrl}
              onEdit={(text) => { props.edit('apiUrl', text) }}
              onReset={() => { props.resetField('apiUrl') }}
            />
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
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={props.save}
              >
                {t(!state.saving ? 'settings.save' : 'settings.saving')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
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

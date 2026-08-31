/** Compatibility helpers for the dsh-settings API transition. */

import type { Context } from '@deepseek-ai/cordis'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import type z from 'schemastery'

type SettingsModuleCompat = {
  settingsNamespace?: (value: string) => SettingsNamespace
  installSettingsSection?: <T>(
    ctx: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
}

interface SettingsProviderCompat {
  installSection?: <T>(
    owner: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
}

const compatModule = settingsModule as unknown as SettingsModuleCompat

/** Brand namespaces where the installed settings package still exposes it. */
export function settingsNamespaceCompat(value: string): SettingsNamespace {
  return compatModule.settingsNamespace?.(value) ?? value as SettingsNamespace
}

/**
 * Register an optional settings section across the rc.7 and alpha.2 APIs.
 * rc.7 exposes a module helper; alpha.2 moves the helper onto the provider.
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacyInstaller = compatModule.installSettingsSection
  if (legacyInstaller !== undefined) {
    legacyInstaller(ctx, ns, schema, entry, hooks)
    return
  }

  ctx.inject(['settings'], (sctx) => {
    const provider = sctx.get('settings') as unknown as SettingsProviderCompat
    if (provider.installSection === undefined) {
      throw new TypeError('dsh-settings does not expose installSection')
    }
    provider.installSection(ctx, ns, schema, entry, hooks)
  })
}

import type { MoaConfigResponse, MoaModelSlot } from '~/lib/types'

/** Reasoning levels in ascending order — mirrors the backend's
 *  VALID_REASONING_EFFORTS. `none` is the Off state, not a level. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export const REASONING_EFFORT_VALUES = ['none', ...REASONING_EFFORTS] as const
export const DEFAULT_REASONING_EFFORT = 'medium'

/** Hermes stores "fast"/"priority"/"on" for the fast tier; anything else is
 *  normal (mirrors tui_gateway _load_service_tier). */
export const isFastTier = (tier: unknown): boolean =>
  ['fast', 'priority', 'on'].includes(String(tier ?? '').trim().toLowerCase())

/** Hand-written `reasoning_effort: false`/`off` reaches the config as boolean
 *  false ("false" once stringified) — show it as Off, not an empty select.
 *  Empty inherits the built-in default. */
export const normalizeEffort = (raw: unknown): string => {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return DEFAULT_REASONING_EFFORT
  if (value === 'false' || value === 'disabled' || value === 'none') return 'none'
  return value
}

export interface FallbackEntry {
  provider: string
  model: string
}

/** Normalize the raw `fallback_providers` config value (a list of {provider,
 *  model} dicts) into editor rows. Defensive against legacy string entries
 *  ("provider/model") so the editor never crashes on odd data. */
export function normalizeFallbackEntries(value: unknown): FallbackEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      return { provider: String(record.provider ?? ''), model: String(record.model ?? '') }
    }
    if (typeof item === 'string') {
      const slash = item.indexOf('/')
      return slash > 0 ? { provider: item.slice(0, slash), model: item.slice(slash + 1) } : { provider: '', model: item }
    }
    return { provider: '', model: '' }
  })
}

export const completeFallbackEntries = (rows: readonly FallbackEntry[]): FallbackEntry[] =>
  rows.filter(entry => entry.provider && entry.model)

export function fallbackEntriesEqual(a: readonly FallbackEntry[], b: readonly FallbackEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.provider === b[index]?.provider && entry.model === b[index]?.model)
}

/** Radix/native selects render a blank trigger when `value` matches no option.
 *  A custom model absent from the current catalog would vanish — surface the
 *  active value so it stays selectable. */
export const withActive = (models: readonly string[], active: string): readonly string[] =>
  active && !models.includes(active) ? [active, ...models] : models

/** A MoA slot is complete when both halves are chosen. Changing a slot's
 *  provider intentionally clears its model, so every provider change passes
 *  through an incomplete state while the user picks the new model. */
export const moaSlotComplete = (slot: MoaModelSlot): boolean => !!(slot.provider.trim() && slot.model.trim())

/** True when every slot in every preset is fully specified — the only state
 *  safe to persist. The backend rejects configs with half-filled slots
 *  (HTTP 422), so the autosave must wait for the edit to finish. */
export const moaConfigComplete = (config: MoaConfigResponse): boolean =>
  Object.values(config.presets).every(
    preset => preset.reference_models.length > 0 && preset.reference_models.every(moaSlotComplete) && moaSlotComplete(preset.aggregator)
  )

const POLLUTING_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype'])

/** Read a dot-separated config path without crashing on intermediate
 *  non-records. Returns undefined when any step is missing. */
export function getConfigValue(config: unknown, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (!part || POLLUTING_PATH_PARTS.has(part)) return undefined
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Immutable nested set for building partial config payloads. */
export function setConfigValue(config: unknown, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  if (parts.some(part => !part || POLLUTING_PATH_PARTS.has(part))) throw new Error(`Unsafe config path: ${path}`)
  const build = (node: unknown, index: number): Record<string, unknown> => {
    if (index === parts.length) return value as Record<string, unknown>
    const base = node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : {}
    return { ...base, [parts[index]]: build(base[parts[index]], index + 1) }
  }
  return build(config, 0)
}

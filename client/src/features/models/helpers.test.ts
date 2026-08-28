import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REASONING_EFFORT,
  getConfigValue,
  isFastTier,
  moaConfigComplete,
  moaSlotComplete,
  normalizeEffort,
  normalizeFallbackEntries,
  completeFallbackEntries,
  fallbackEntriesEqual,
  setConfigValue,
  withActive
} from '~/features/models/helpers'

describe('models helpers', () => {
  it('normalizes legacy string fallback entries into structured rows', () => {
    expect(normalizeFallbackEntries([
      'nous/Hermes-4-405B',
      { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
      'just-a-model',
      42,
      null
    ])).toEqual([
      { model: 'Hermes-4-405B', provider: 'nous' },
      { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
      { model: 'just-a-model', provider: '' },
      { model: '', provider: '' },
      { model: '', provider: '' }
    ])
    expect(normalizeFallbackEntries(undefined)).toEqual([])
    expect(normalizeFallbackEntries('nope')).toEqual([])
  })

  it('keeps only complete fallback pairs and compares chains', () => {
    const rows = [
      { model: 'm1', provider: 'p1' },
      { model: '', provider: 'p2' },
      { model: 'm3', provider: '' },
      { model: 'm4', provider: 'p4' }
    ]
    expect(completeFallbackEntries(rows)).toEqual([
      { model: 'm1', provider: 'p1' },
      { model: 'm4', provider: 'p4' }
    ])
    expect(fallbackEntriesEqual(rows.slice(0, 1), [{ model: 'm1', provider: 'p1' }])).toBe(true)
    expect(fallbackEntriesEqual(rows.slice(0, 1), [{ model: 'm1', provider: 'other' }])).toBe(false)
    expect(fallbackEntriesEqual([{ model: 'a', provider: 'p' }], [{ model: 'a', provider: 'p' }, { model: 'b', provider: 'p' }])).toBe(false)
  })

  it('keeps an active value selectable even when absent from the catalog', () => {
    expect(withActive(['a', 'b'], 'a')).toEqual(['a', 'b'])
    expect(withActive(['a', 'b'], 'custom-model')).toEqual(['custom-model', 'a', 'b'])
    expect(withActive(['a', 'b'], '')).toEqual(['a', 'b'])
  })

  it('treats a MoA slot as complete only when both halves are chosen', () => {
    expect(moaSlotComplete({ model: 'm', provider: 'p' })).toBe(true)
    expect(moaSlotComplete({ model: 'm', provider: '' })).toBe(false)
    expect(moaSlotComplete({ model: '', provider: 'p' })).toBe(false)
    expect(moaSlotComplete({ model: '  ', provider: 'p' })).toBe(false)
  })

  it('requires every preset slot complete before a MoA save is safe', () => {
    const complete = {
      presets: {
        a: { aggregator: { model: 'am', provider: 'ap' }, reference_models: [{ model: 'm', provider: 'p' }] }
      }
    }
    expect(moaConfigComplete(complete as never)).toBe(true)
    expect(moaConfigComplete({
      presets: { a: { aggregator: { model: '', provider: 'ap' }, reference_models: [{ model: 'm', provider: 'p' }] } }
    } as never)).toBe(false)
    expect(moaConfigComplete({
      presets: { a: { aggregator: { model: 'am', provider: 'ap' }, reference_models: [] } }
    } as never)).toBe(false)
  })

  it('maps service tier strings onto the fast tier', () => {
    expect(isFastTier('fast')).toBe(true)
    expect(isFastTier('PRIORITY')).toBe(true)
    expect(isFastTier('on')).toBe(true)
    expect(isFastTier('normal')).toBe(false)
    expect(isFastTier(undefined)).toBe(false)
    expect(isFastTier(null)).toBe(false)
  })

  it('maps hand-written off values to the Off state and empty to the default', () => {
    expect(normalizeEffort('none')).toBe('none')
    expect(normalizeEffort(false)).toBe('none')
    expect(normalizeEffort('FALSE')).toBe('none')
    expect(normalizeEffort('disabled')).toBe('none')
    expect(normalizeEffort('')).toBe(DEFAULT_REASONING_EFFORT)
    expect(normalizeEffort(undefined)).toBe(DEFAULT_REASONING_EFFORT)
    expect(normalizeEffort('ultra')).toBe('ultra')
  })

  it('round-trips nested config paths immutably', () => {
    const config = { agent: { reasoning_effort: 'high' }, display: { theme: 'dark' } }
    const next = setConfigValue(config, 'agent.reasoning_effort', 'ultra')
    expect(next).toEqual({ agent: { reasoning_effort: 'ultra' }, display: { theme: 'dark' } })
    // The source record is untouched.
    expect(config.agent.reasoning_effort).toBe('high')
    expect(getConfigValue(next, 'agent.reasoning_effort')).toBe('ultra')
    expect(getConfigValue(next, 'agent.missing.deeper')).toBeUndefined()
    expect(getConfigValue(undefined, 'agent.reasoning_effort')).toBeUndefined()
    // Building a partial payload from an empty record keeps the nesting.
    expect(setConfigValue({}, 'agent.service_tier', 'fast')).toEqual({ agent: { service_tier: 'fast' } })
  })

  it('refuses unsafe config paths', () => {
    expect(() => setConfigValue({}, '__proto__.polluted', true)).toThrow(/Unsafe config path/)
    expect(() => setConfigValue({}, 'constructor.x', 1)).toThrow(/Unsafe config path/)
    expect(() => setConfigValue({}, 'agent..x', 1)).toThrow(/Unsafe config path/)
    expect(getConfigValue({ constructor: { x: 1 } }, 'constructor.x')).toBeUndefined()
  })
})
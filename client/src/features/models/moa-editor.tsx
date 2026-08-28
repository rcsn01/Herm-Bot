import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button, Input, Switch } from '~/compat/primitives'
import { modelsApi } from '~/features/models/api'
import { moaConfigComplete, withActive } from '~/features/models/helpers'
import { ModelSelect, ensureOption, modelOptions, providerOptions } from '~/features/models/select'
import type { GatewayPort } from '~/gateway/gateway-port'
import type { ModelOptionProvider, MoaConfigResponse, MoaModelSlot } from '~/lib/types'

const MOA_SAVE_DEBOUNCE_MS = 600

export interface MoaEditorProps {
  gateway: GatewayPort
  moa: MoaConfigResponse
  /** Persisted-config callback so the parent cache stays the single source of truth. */
  onMoaChange(next: MoaConfigResponse): void
  onError(error: unknown): void
  /** Persisted-config callback with the profile the save targeted, so the
   *  parent can drop responses that raced a profile switch. */
  onSaved(next: MoaConfigResponse, profile: null | string): void
  profile: null | string
  providers: readonly ModelOptionProvider[]
}

/** Mobile editor for the Mixture-of-Agents provider — preset management plus
 *  reference-model and aggregator slots. Mirrors the desktop autosave:
 *  inline edits persist quietly after a 600 ms debounce, explicit preset ops
 *  (set default / add / delete) persist immediately and supersede any pending
 *  debounced save.
 *
 *  While any slot is half-filled the save is HELD, not sent: the previous
 *  complete config stays on disk and the next edit that completes the slot
 *  flushes the whole config (the backend rejects half-filled slots with 422
 *  instead of silently swapping in defaults). Every edit bumps a generation
 *  counter so an in-flight response from an older save can never repaint over
 *  the user's mid-edit state.
 *
 *  Fields mobile does not edit (temperatures, timeouts, fanout, token limits,
 *  per-slot reasoning effort) ride along untouched in the PUT body. */
export function MoaEditor({ gateway, moa, onMoaChange, onError, onSaved, profile, providers }: MoaEditorProps) {
  const [selectedPreset, setSelectedPreset] = useState(() => moa.default_preset)
  const [newPresetName, setNewPresetName] = useState('')
  const [applying, setApplying] = useState(false)

  // Mirror of `moa` so inline edits compute the next state purely (outside the
  // setState updater) and hand it straight to the debounced autosave.
  const moaRef = useRef(moa)
  useEffect(() => {
    moaRef.current = moa
  }, [moa])

  // Keep the preset selection honest when the config changes under us
  // (refresh, saved response): fall back to the config's default preset.
  useEffect(() => {
    if (!moa.presets[selectedPreset]) setSelectedPreset(moa.default_preset || Object.keys(moa.presets)[0] || '')
  }, [moa, selectedPreset])

  const saveTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    },
    []
  )
  const saveGeneration = useRef(0)

  const currentPreset = useMemo(
    () => moa.presets[selectedPreset] || moa.presets[moa.default_preset] || Object.values(moa.presets)[0] || null,
    [moa, selectedPreset]
  )
  const activePresetName = useMemo(
    () => (moa.presets[selectedPreset] ? selectedPreset : moa.default_preset || Object.keys(moa.presets)[0] || ''),
    [moa, selectedPreset]
  )

  const persist = useCallback(
    async (next: MoaConfigResponse) => {
      // The request path pins the profile this edit targeted. The parent
      // compares it against the profile it is currently showing and ignores a
      // response that raced a profile switch.
      const saved = await modelsApi.saveMoa(gateway, profile, next)
      onSaved(saved, profile)
    },
    [gateway, onSaved, profile]
  )

  // Quiet debounced persist for inline slot/aggregator edits. No applying
  // spinner, so selecting stays responsive. The generation counter drops
  // both errors and saved responses from superseded writes, so an older
  // save can never repaint over the user's newer edits.
  const scheduleMoaSave = useCallback(
    (next: MoaConfigResponse) => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      const generation = saveGeneration.current + 1
      saveGeneration.current = generation
      if (!moaConfigComplete(next)) return // hold the write; disk keeps the last complete config
      saveTimer.current = window.setTimeout(() => {
        void modelsApi.saveMoa(gateway, profile, next)
          .then(saved => {
            if (saveGeneration.current === generation) onSaved(saved, profile)
          })
          .catch(error => {
            if (saveGeneration.current === generation) onError(error)
          })
      }, MOA_SAVE_DEBOUNCE_MS)
    },
    [gateway, onError, onSaved, profile]
  )

  const updatePreset = useCallback(
    (updater: (preset: MoaModelSlotPreset) => MoaModelSlotPreset) => {
      const prev = moaRef.current
      if (!activePresetName || !prev.presets[activePresetName]) return
      const next: MoaConfigResponse = { ...prev, presets: { ...prev.presets, [activePresetName]: updater(prev.presets[activePresetName]) } }
      moaRef.current = next
      onMoaChange(next)
      scheduleMoaSave(next)
    },
    [activePresetName, onMoaChange, scheduleMoaSave]
  )

  // Explicit preset ops supersede any pending debounced autosave — cancel it
  // and invalidate in-flight responses so the two writers can't race.
  const saveNow = useCallback(
    async (next: MoaConfigResponse) => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      saveGeneration.current += 1
      setApplying(true)
      try {
        await persist(next)
      } catch (error) {
        onError(error)
      } finally {
        setApplying(false)
      }
    },
    [onError, persist]
  )

  const updateSlot = useCallback((slot: MoaModelSlot, patch: Partial<MoaModelSlot>): MoaModelSlot => {
    const next = { ...slot, ...patch }
    // Picking a new provider invalidates the model choice (models are
    // per-provider). A same-provider update must not wipe the model.
    if (patch.provider && patch.provider !== slot.provider) next.model = ''
    return next
  }, [])

  // MoA reference/aggregator slots must never be the moa virtual provider —
  // that would create a recursive MoA tree (the backend rejects it on save).
  const slotProviders = useMemo(
    () => providers.filter(provider => (provider.slug || '').toLowerCase() !== 'moa'),
    [providers]
  )
  const slotProviderOptions = useMemo(() => providerOptions(slotProviders), [slotProviders])
  const modelsForProvider = useCallback(
    (provider: string) => providers.find(row => row.slug === provider)?.models ?? [],
    [providers]
  )

  if (!currentPreset) {
    return (
      <div className="error-banner" role="alert">
        <strong>MoA presets are empty.</strong>
        <p>The gateway returned a Mixture of Agents config without presets.</p>
      </div>
    )
  }

  return (
    <section className="models-section" aria-label="Mixture of Agents">
      <h3>Mixture of Agents</h3>
      <p className="muted">Presets appear as models under the Mixture of Agents provider. The aggregator is the acting model.</p>

      <div className="models-card">
        <div className="models-controls">
          <ModelSelect
            ariaLabel="MoA preset"
            onChange={setSelectedPreset}
            options={Object.keys(moa.presets).map(name => ({ label: name, value: name }))}
            placeholder="Preset"
            value={activePresetName}
          />
          <label className="models-toggle">
            <span>Enabled</span>
            <Switch
              checked={currentPreset.enabled !== false}
              disabled={applying}
              onCheckedChange={checked => updatePreset(prev => ({ ...prev, enabled: checked === true }))}
            />
          </label>
        </div>
        <div className="models-controls">
          <Button
            disabled={applying || moa.default_preset === activePresetName}
            onClick={() => void saveNow({ ...moa, default_preset: activePresetName })}
            size="sm"
            variant="secondary"
          >
            Set default
          </Button>
          <Button
            disabled={Object.keys(moa.presets).length <= 1 || applying}
            onClick={() => {
              if (Object.keys(moa.presets).length <= 1) return
              const presets = { ...moa.presets }
              delete presets[activePresetName]
              const fallback = Object.keys(presets)[0]
              const next: MoaConfigResponse = {
                ...moa,
                presets,
                default_preset: moa.default_preset === activePresetName ? fallback : moa.default_preset,
                active_preset: moa.active_preset === activePresetName ? '' : moa.active_preset
              }
              setSelectedPreset(fallback)
              void saveNow(next)
            }}
            size="sm"
            variant="secondary"
          >
            Delete
          </Button>
        </div>
        <div className="models-controls">
          <Input
            aria-label="New preset name"
            className="models-input"
            onChange={event => setNewPresetName(event.target.value)}
            placeholder="New preset name"
            value={newPresetName}
          />
          <Button
            disabled={!newPresetName.trim() || !!moa.presets[newPresetName.trim()] || applying}
            onClick={() => {
              const name = newPresetName.trim()
              const next: MoaConfigResponse = {
                ...moa,
                presets: {
                  ...moa.presets,
                  [name]: { ...currentPreset, reference_models: [...currentPreset.reference_models] }
                }
              }
              setSelectedPreset(name)
              setNewPresetName('')
              void saveNow(next)
            }}
            size="sm"
            variant="secondary"
          >
            Add preset
          </Button>
        </div>
        <p className="models-meta">Default preset: {moa.default_preset}</p>
      </div>

      <div className="models-card">
        <h4>Reference models</h4>
        {currentPreset.reference_models.map((slot, index) => (
          <div className={slot.enabled === false ? 'models-slot models-slot-disabled' : 'models-slot'} key={index}>
            <div className="models-controls">
              <span className="models-slot-title">Reference {index + 1}</span>
              <label className="models-inline-toggle">
                <input
                  aria-label={`Toggle reference ${index + 1}`}
                  checked={slot.enabled !== false}
                  onChange={event =>
                    updatePreset(prev => ({
                      ...prev,
                      reference_models: prev.reference_models.map((s, i) => (i === index ? { ...s, enabled: event.target.checked } : s))
                    }))
                  }
                  type="checkbox"
                />
                {slot.enabled !== false ? 'Enabled' : 'Disabled'}
              </label>
              <Button
                aria-label={`Remove reference ${index + 1}`}
                disabled={currentPreset.reference_models.length <= 1 || applying}
                onClick={() =>
                  updatePreset(prev => ({ ...prev, reference_models: prev.reference_models.filter((_, i) => i !== index) }))
                }
                size="sm"
                variant="secondary"
              >
                Remove
              </Button>
            </div>
            <div className="models-controls">
              <ModelSelect
                ariaLabel={`Provider for reference ${index + 1}`}
                onChange={value =>
                  updatePreset(prev => ({
                    ...prev,
                    reference_models: prev.reference_models.map((s, i) => (i === index ? updateSlot(s, { provider: value }) : s))
                  }))
                }
                options={ensureOption(slotProviderOptions, slot.provider)}
                placeholder="Provider"
                value={slot.provider}
              />
              <ModelSelect
                ariaLabel={`Model for reference ${index + 1}`}
                onChange={value =>
                  updatePreset(prev => ({
                    ...prev,
                    reference_models: prev.reference_models.map((s, i) => (i === index ? updateSlot(s, { model: value }) : s))
                  }))
                }
                options={modelOptions(withActive(modelsForProvider(slot.provider), slot.model))}
                placeholder="Model"
                value={slot.model}
              />
            </div>
            <p className="models-meta">{slot.provider || 'No provider'} · {slot.model || 'No model'}</p>
          </div>
        ))}
        <Button
          disabled={applying}
          onClick={() =>
            updatePreset(prev => ({
              ...prev,
              reference_models: [...prev.reference_models, { ...prev.aggregator, enabled: true }]
            }))
          }
          size="sm"
          variant="secondary"
        >
          Add reference model
        </Button>
      </div>

      <div className="models-card">
        <h4>Aggregator</h4>
        <div className="models-controls">
          <ModelSelect
            ariaLabel="Aggregator provider"
            onChange={value => updatePreset(prev => ({ ...prev, aggregator: updateSlot(prev.aggregator, { provider: value }) }))}
            options={ensureOption(slotProviderOptions, currentPreset.aggregator.provider)}
            placeholder="Provider"
            value={currentPreset.aggregator.provider}
          />
          <ModelSelect
            ariaLabel="Aggregator model"
            onChange={value => updatePreset(prev => ({ ...prev, aggregator: updateSlot(prev.aggregator, { model: value }) }))}
            options={modelOptions(withActive(modelsForProvider(currentPreset.aggregator.provider), currentPreset.aggregator.model))}
            placeholder="Model"
            value={currentPreset.aggregator.model}
          />
        </div>
        <p className="models-meta">{currentPreset.aggregator.provider || 'No provider'} · {currentPreset.aggregator.model || 'No model'}</p>
      </div>
    </section>
  )
}

type MoaModelSlotPreset = MoaConfigResponse['presets'][string]
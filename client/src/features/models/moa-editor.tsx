import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { Button, Input, Switch } from '~/compat/primitives'
import { modelsApi } from '~/features/models/api'
import { moaConfigComplete, withActive } from '~/features/models/helpers'
import { ModelSelect, ensureOption, modelOptions, providerOptions } from '~/features/models/select'
import type { GatewayPort } from '~/gateway/gateway-port'
import { profileKey } from '~/gateway/profile-path'
import { currentGatewayScope, isCurrentGatewayScope } from '~/gateway/scope-guard'
import type { ModelOptionProvider, MoaConfigResponse, MoaModelSlot } from '~/lib/types'

type SavedMoaConfig = MoaConfigResponse & { ok: boolean }

// A PUT that has reached fetch may still be processed by the gateway after
// AbortController.abort(). Keep writes for the same gateway/profile ordered
// across component remounts so a later preset operation cannot be overwritten
// by an earlier debounced save.
const moaWriteTails = new Map<string, Promise<unknown>>()

function enqueueMoaWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = moaWriteTails.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  moaWriteTails.set(key, current)
  void current.then(
    () => { if (moaWriteTails.get(key) === current) moaWriteTails.delete(key) },
    () => { if (moaWriteTails.get(key) === current) moaWriteTails.delete(key) }
  )
  return current
}

const MOA_SAVE_DEBOUNCE_MS = 600

export interface MoaEditorProps {
  connectionKey: string
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
export function MoaEditor({ connectionKey, gateway, moa, onMoaChange, onError, onSaved, profile, providers }: MoaEditorProps) {
  const [selectedPreset, setSelectedPreset] = useState(() => moa.default_preset)
  const [newPresetName, setNewPresetName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<null | string>(null)
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
  const saveGeneration = useRef(0)
  const activeSave = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const writeKey = `${connectionKey}\u0000${profileKey(profile)}`
  useEffect(() => {
    // A profile or connection switch can leave this component mounted while a
    // request is in flight. Invalidate both timers and completions; the
    // generation in currentGatewayScope also catches switching away and back
    // to the same profile.
    saveGeneration.current += 1
    activeSave.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    activeRequest.current?.abort()
    activeRequest.current = null
    setApplying(false)
    setPendingDelete(null)
    return () => {
      saveGeneration.current += 1
      activeSave.current += 1
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [connectionKey, gateway, profile])

  const currentPreset = useMemo(
    () => moa.presets[selectedPreset] || moa.presets[moa.default_preset] || Object.values(moa.presets)[0] || null,
    [moa, selectedPreset]
  )
  const activePresetName = useMemo(
    () => (moa.presets[selectedPreset] ? selectedPreset : moa.default_preset || Object.keys(moa.presets)[0] || ''),
    [moa, selectedPreset]
  )

  const persist = useCallback(
    (next: MoaConfigResponse, signal?: AbortSignal) => modelsApi.saveMoa(gateway, profile, next, signal),
    [gateway, profile]
  )
  const enqueuePersist = useCallback(
    (next: MoaConfigResponse, generation: number, scope: ReturnType<typeof currentGatewayScope>) => enqueueMoaWrite<SavedMoaConfig | null>(writeKey, async () => {
      if (saveGeneration.current !== generation || !isCurrentGatewayScope(scope)) return null
      const controller = new AbortController()
      activeRequest.current = controller
      try {
        return await persist(next, controller.signal)
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
      }
    }),
    [persist, writeKey]
  )

  // Quiet debounced persist for inline slot/aggregator edits. No applying
  // spinner, so selecting stays responsive. The generation counter drops
  // both errors and saved responses from superseded writes, so an older
  // save can never repaint over the user's newer edits.
  const scheduleMoaSave = useCallback(
    (next: MoaConfigResponse) => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      const generation = saveGeneration.current + 1
      saveGeneration.current = generation
      const scope = currentGatewayScope()
      if (!moaConfigComplete(next)) return // hold the write; disk keeps the last complete config
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        if (saveGeneration.current !== generation || !isCurrentGatewayScope(scope)) return
        void enqueuePersist(next, generation, scope)
          .then(saved => {
            if (saved && saveGeneration.current === generation && isCurrentGatewayScope(scope)) onSaved(saved, profile)
          })
          .catch(error => {
            if (saveGeneration.current === generation && isCurrentGatewayScope(scope)) onError(error)
          })
      }, MOA_SAVE_DEBOUNCE_MS)
    },
    [enqueuePersist, onError, onSaved, profile]
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

  // Explicit preset ops supersede any pending debounced autosave. Started
  // writes stay ordered in enqueuePersist; generation checks discard their
  // stale callbacks before the newer operation is allowed to run.
  const saveNow = useCallback(
    async (next: MoaConfigResponse) => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      const generation = ++saveGeneration.current
      const scope = currentGatewayScope()
      const saveId = ++activeSave.current
      const previous = moaRef.current
      moaRef.current = next
      if (isCurrentGatewayScope(scope)) onMoaChange(next)
      setApplying(true)
      try {
        const saved = await enqueuePersist(next, generation, scope)
        if (saved && saveGeneration.current === generation && isCurrentGatewayScope(scope)) onSaved(saved, profile)
      } catch (error) {
        if (saveGeneration.current === generation && isCurrentGatewayScope(scope)) {
          moaRef.current = previous
          onMoaChange(previous)
          onError(error)
        }
      } finally {
        if (activeSave.current === saveId) setApplying(false)
      }
    },
    [enqueuePersist, onError, onMoaChange, onSaved, profile]
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
    <>
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
            onClick={() => {
              const current = moaRef.current
              if (!activePresetName || !current.presets[activePresetName]) return
              void saveNow({ ...current, default_preset: activePresetName })
            }}
            size="sm"
            variant="secondary"
          >
            Set default
          </Button>
          <Button
            disabled={Object.keys(moa.presets).length <= 1 || applying}
            onClick={() => {
              if (Object.keys(moaRef.current.presets).length <= 1 || !activePresetName) return
              setPendingDelete(activePresetName)
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
              const current = moaRef.current
              const source = current.presets[activePresetName] || current.presets[current.default_preset] || Object.values(current.presets)[0]
              if (!name || !source || current.presets[name]) return
              const next: MoaConfigResponse = {
                ...current,
                presets: {
                  ...current.presets,
                  [name]: { ...source, reference_models: [...source.reference_models] }
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
      {pendingDelete && (
        <ConfirmDialog
          confirmLabel="Delete preset"
          description={`Delete the MoA preset “${pendingDelete}”? This cannot be undone.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const name = pendingDelete
            setPendingDelete(null)
            const current = moaRef.current
            if (Object.keys(current.presets).length <= 1 || !current.presets[name]) return
            const presets = { ...current.presets }
            delete presets[name]
            const fallback = Object.keys(presets)[0]
            const next: MoaConfigResponse = {
              ...current,
              presets,
              default_preset: current.default_preset === name ? fallback : current.default_preset,
              active_preset: current.active_preset === name ? '' : current.active_preset
            }
            setSelectedPreset(fallback)
            void saveNow(next)
          }}
          title="Delete MoA preset?"
        />
      )}
    </>
  )
}

type MoaModelSlotPreset = MoaConfigResponse['presets'][string]
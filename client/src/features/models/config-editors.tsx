import { useCallback, useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { ModelSelect, ensureOption, modelOptions, providerOptions } from '~/features/models/select'
import {
  completeFallbackEntries,
  fallbackEntriesEqual,
  normalizeFallbackEntries,
  type FallbackEntry
} from '~/features/models/helpers'
import type { ModelOptionProvider } from '~/lib/types'

/** Debounced writer: collapses rapid edits into one call after `delayMs`.
 *  A generation counter drops error reports from superseded writes so an
 *  older save can never surface an error over newer edits. */
export function useDebouncedSave<Args extends unknown[]>(
  save: (...args: Args) => Promise<void>,
  delayMs: number,
  onError: (error: unknown) => void
): (...args: Args) => void {
  const timer = useRef<number | null>(null)
  const generation = useRef(0)
  const saveRef = useRef(save)
  const errorRef = useRef(onError)
  useEffect(() => {
    saveRef.current = save
    errorRef.current = onError
  })
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )
  return useCallback(
    (...args: Args) => {
      if (timer.current) window.clearTimeout(timer.current)
      const scheduled = ++generation.current
      timer.current = window.setTimeout(() => {
        void saveRef.current(...args).catch(error => {
          if (generation.current === scheduled) errorRef.current(error)
        })
      }, delayMs)
    },
    [delayMs]
  )
}

export const CONFIG_SAVE_DEBOUNCE_MS = 550

export function ContextWindowField({ autoDetected, effective, onWrite, value }: {
  autoDetected?: number
  effective?: number
  onWrite(contextLength: number): void
  value: number
}) {
  const [draft, setDraft] = useState(() => (value > 0 ? String(value) : ''))
  // Our own committed value echoes back after the save; skip that echo so the
  // user can keep typing. A genuinely different persisted value resyncs.
  const lastWritten = useRef(value)

  useEffect(() => {
    if (value === lastWritten.current) return
    lastWritten.current = value
    setDraft(value > 0 ? String(value) : '')
  }, [value])

  const commit = (raw: string) => {
    setDraft(raw)
    const parsed = raw.trim() === '' ? 0 : Number(raw)
    if (Number.isNaN(parsed) || parsed < 0 || !Number.isInteger(parsed)) return
    lastWritten.current = parsed
    onWrite(parsed)
  }

  return (
    <div className="models-card" aria-label="Context window">
      <h4>Context window</h4>
      <p className="muted">Leave blank to auto-detect from the model catalog. Applies to new sessions.</p>
      <div className="models-controls">
        <Input
          aria-label="Context window tokens"
          className="models-input"
          inputMode="numeric"
          onChange={event => commit(event.target.value)}
          placeholder="Auto"
          type="number"
          value={draft}
        />
      </div>
      <p className="models-meta">
        {effective ? `Effective: ${effective.toLocaleString()} tokens` : 'Effective: not resolved'}
        {autoDetected ? ` · auto-detected ${autoDetected.toLocaleString()}` : ''}
      </p>
    </div>
  )
}

/** Ordered fallback-model chain for the top-level `fallback_providers` config
 *  list — `{provider, model}` pairs tried in order when the default model
 *  fails. Half-filled rows stay in local draft state; only complete pairs are
 *  emitted upward, so the debounced autosave never persists a partial pair.
 *  Legacy string entries ("provider/model") are normalized for editing. */
export function FallbackField({ onWrite, providers, value }: {
  onWrite(entries: FallbackEntry[]): void
  providers: readonly ModelOptionProvider[]
  value: unknown
}) {
  const [rows, setRows] = useState<FallbackEntry[]>(() => normalizeFallbackEntries(value))
  // Last complete chain we emitted (or seeded). Autosave echoes the same
  // filtered list back through `value`; ignore that echo so draft rows stay.
  const lastEmitted = useRef<FallbackEntry[]>(completeFallbackEntries(normalizeFallbackEntries(value)))

  useEffect(() => {
    const persisted = normalizeFallbackEntries(value)
    if (fallbackEntriesEqual(persisted, lastEmitted.current)) return
    lastEmitted.current = completeFallbackEntries(persisted)
    setRows(persisted)
  }, [value])

  const commit = (next: FallbackEntry[]) => {
    const complete = completeFallbackEntries(next)
    setRows(next)
    lastEmitted.current = complete
    onWrite(complete)
  }

  const updateRow = (index: number, patch: Partial<FallbackEntry>) =>
    commit(rows.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))

  const providerSelectOptions = providerOptions(providers)

  return (
    <div className="models-card" aria-label="Fallback models">
      <h4>Fallback models</h4>
      <p className="muted">Tried in order when the main model fails. Blank entries are saved only once complete.</p>
      {rows.length === 0 && <p className="models-meta">No fallback models configured.</p>}
      {rows.map((entry, index) => {
        const catalog = providers.find(provider => provider.slug === entry.provider)?.models ?? []
        return (
          <div className="models-slot" key={index} aria-label={`Fallback ${index + 1}`}>
            <div className="models-controls">
              <span className="models-slot-title">Fallback {index + 1}</span>
              <Button aria-label={`Remove fallback ${index + 1}`} onClick={() => commit(rows.filter((_, i) => i !== index))} size="sm" variant="secondary">
                Remove
              </Button>
            </div>
            <div className="models-controls">
              <ModelSelect
                ariaLabel={`Provider for fallback ${index + 1}`}
                onChange={provider => updateRow(index, { provider, model: '' })}
                options={ensureOption(providerSelectOptions, entry.provider)}
                placeholder="Provider"
                value={entry.provider}
              />
              <ModelSelect
                ariaLabel={`Model for fallback ${index + 1}`}
                onChange={model => updateRow(index, { model })}
                options={ensureOption(modelOptions(catalog), entry.model)}
                placeholder="Model"
                value={entry.model}
              />
            </div>
          </div>
        )
      })}
      <Button onClick={() => commit([...rows, { provider: '', model: '' }])} size="sm" variant="secondary">
        Add fallback
      </Button>
    </div>
  )
}
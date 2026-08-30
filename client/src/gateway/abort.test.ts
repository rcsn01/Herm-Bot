import { describe, expect, it } from 'vitest'

import { abortError, combineSignals, throwIfAborted } from '~/gateway/abort'

describe('abort helpers', () => {
  it('propagates the first signal to the combined signal', () => {
    const primary = new AbortController()
    const secondary = new AbortController()
    const combined = combineSignals(primary.signal, secondary.signal)

    primary.abort(abortError('scope changed'))

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toMatchObject({ name: 'AbortError', message: 'scope changed' })
    combined.cleanup()
  })

  it('propagates caller cancellation and cleans up listeners', () => {
    const primary = new AbortController()
    const secondary = new AbortController()
    const combined = combineSignals(primary.signal, secondary.signal)

    combined.cleanup()
    secondary.abort(abortError('request cancelled'))

    expect(combined.signal.aborted).toBe(false)
  })

  it('uses an already-aborted signal without creating a live child', () => {
    const primary = new AbortController()
    primary.abort(abortError('already stopped'))
    const combined = combineSignals(primary.signal, new AbortController().signal)

    expect(() => throwIfAborted(combined.signal)).toThrow('already stopped')
    combined.cleanup()
  })
})

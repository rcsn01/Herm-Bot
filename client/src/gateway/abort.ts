export function abortError(message = 'Aborted.'): DOMException {
  return new DOMException(message, 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? abortError()
}

interface CombinedSignal {
  cleanup(): void
  signal: AbortSignal
}

/**
 * Compose a request signal without relying on AbortSignal.any(), which is not
 * available in every iOS version supported by the app.
 */
export function combineSignals(primary: AbortSignal, secondary?: AbortSignal): CombinedSignal {
  if (!secondary || secondary === primary) return { cleanup: () => undefined, signal: primary }
  if (primary.aborted) return { cleanup: () => undefined, signal: primary }
  if (secondary.aborted) return { cleanup: () => undefined, signal: secondary }

  const controller = new AbortController()
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    primary.removeEventListener('abort', onPrimary)
    secondary.removeEventListener('abort', onSecondary)
  }
  const abort = (signal: AbortSignal, message: string) => {
    if (controller.signal.aborted) return
    cleanup()
    controller.abort(signal.reason ?? abortError(message))
  }
  const onPrimary = () => abort(primary, 'Gateway scope changed.')
  const onSecondary = () => abort(secondary, 'Request aborted.')

  primary.addEventListener('abort', onPrimary, { once: true })
  secondary.addEventListener('abort', onSecondary, { once: true })
  return { cleanup, signal: controller.signal }
}

import { classifyGatewayError } from './gateway-error'

const DEFAULT_UNSUPPORTED_TEXT = 'This gateway does not provide this optional capability.'

export interface GatewayErrorBannerProps {
  /** Raw query error, GatewayError, or another unclassified value. */
  error: unknown
  /** Rich mode lead: "Could not load {subject}" or "{subject} unavailable". */
  subject?: string
  /** Copy shown when the classified kind is unsupported. */
  unsupportedText?: string
  /** Render every failure as an unavailable card with this phrase. */
  unavailablePhrase?: string
  role?: 'alert' | 'status'
}

export function GatewayErrorBanner({
  error,
  subject,
  role = 'alert',
  unsupportedText,
  unavailablePhrase
}: GatewayErrorBannerProps) {
  if (error == null || error === '') return null
  const classified = classifyGatewayError(error)
  if (unavailablePhrase) {
    return <div className="unsupported-card" role={role}>{unavailablePhrase}: {classified.message}</div>
  }
  if (classified.kind === 'unsupported') {
    const text = unsupportedText ?? DEFAULT_UNSUPPORTED_TEXT
    return subject
      ? <div className="unsupported-card" role={role}><strong>{subject} unavailable</strong><p>{text}</p></div>
      : <div className="unsupported-card" role={role}>{text}</div>
  }
  return subject
    ? <div className="error-banner" role={role}><strong>Could not load {subject}</strong><p>{classified.message}</p></div>
    : <div className="error-banner" role={role}>{classified.message}</div>
}

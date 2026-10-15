import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '~/compat/primitives'

interface CopyTextButtonProps {
  text: string
  label: string
  contextIdentity: string
}

type CopyState = { status: 'pending' | 'success' | 'failure'; snapshot: string }

// A different owner/session/reset retires both pending feedback and manual text.
export function CopyTextButton({ contextIdentity, ...props }: CopyTextButtonProps) {
  return <CopyOperation key={contextIdentity} {...props} />
}

function CopyOperation({ text, label }: Omit<CopyTextButtonProps, 'contextIdentity'>) {
  const [state, setState] = useState<CopyState | null>(null)
  const mounted = useRef(false)
  const pending = useRef(false)
  const fallback = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const copy = async () => {
    if (pending.current) return
    const snapshot = text
    pending.current = true
    setState({ status: 'pending', snapshot })
    try {
      await navigator.clipboard.writeText(snapshot)
      if (mounted.current) setState({ status: 'success', snapshot })
    } catch {
      if (mounted.current) setState({ status: 'failure', snapshot })
    } finally {
      pending.current = false
    }
  }

  return <div className="copy-text-control">
    <Button aria-disabled={state?.status === 'pending'} onClick={() => void copy()} size="sm" variant="text">{label}</Button>
    <span className="copy-feedback" role="status" aria-atomic="true">{state?.status === 'pending' ? 'Copying…' : state?.status === 'success' ? state.snapshot === text ? 'Copied.' : 'Copied snapshot.' : state?.status === 'failure' ? 'Could not copy. Select the text below and copy it manually.' : ''}</span>
    {state?.status === 'failure' && <div className="copy-fallback">
      <label>Text for manual copying<textarea aria-label={`${label}: text for manual copying`} readOnly ref={fallback} rows={4} value={state.snapshot} /></label>
      <Button onClick={() => { fallback.current?.focus(); fallback.current?.select() }} size="sm" variant="text">Select text</Button>
      <Button onClick={() => setState(null)} size="sm" variant="text">Dismiss copy feedback</Button>
    </div>}
  </div>
}

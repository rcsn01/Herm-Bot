import { useEffect, useId, useRef } from 'react'

import { Button } from '~/compat/primitives'

export function ConfirmDialog({ disabled = false, confirmLabel = 'Confirm', description, onCancel, onConfirm, title }: {
  disabled?: boolean
  confirmLabel?: string
  description: string
  onCancel(): void
  onConfirm(): void
  title: string
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const previous = document.activeElement
    cancelRef.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}><section onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    if (event.key === 'Tab') {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const first = buttons[0]
      const last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }} aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" className="mobile-dialog" role="alertdialog"><h3 id={titleId}>{title}</h3><p id={descriptionId}>{description}</p><div className="button-row"><Button onClick={onCancel} ref={cancelRef} variant="secondary">Cancel</Button><Button disabled={disabled} onClick={() => { if (!disabled) onConfirm() }} variant="destructive">{confirmLabel}</Button></div></section></div>
}

import { useEffect, useRef } from 'react'

import { Button } from '~/compat/primitives'

export function ConfirmDialog({ confirmLabel = 'Confirm', description, onCancel, onConfirm, title }: {
  confirmLabel?: string
  description: string
  onCancel(): void
  onConfirm(): void
  title: string
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}><section aria-describedby="confirm-description" aria-modal="true" className="mobile-dialog" role="alertdialog"><h3>{title}</h3><p id="confirm-description">{description}</p><div className="button-row"><Button onClick={onCancel} ref={cancelRef} variant="secondary">Cancel</Button><Button onClick={onConfirm} variant="destructive">{confirmLabel}</Button></div></section></div>
}

import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'

export function TextDialog({ initialValue = '', label, onCancel, onSubmit, title }: {
  initialValue?: string
  label: string
  onCancel(): void
  onSubmit(value: string): void
  title: string
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return <div className="dialog-backdrop" role="presentation"><form aria-modal="true" className="mobile-dialog" onSubmit={event => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()) }} role="dialog"><h3>{title}</h3><label>{label}<Input onChange={event => setValue(event.target.value)} ref={inputRef} value={value} /></label><div className="button-row"><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button><Button disabled={!value.trim()} type="submit">Save</Button></div></form></div>
}

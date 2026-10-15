import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyTextButton } from './copy-text-button'

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}
function deferred() {
  let resolve!: () => void
  let reject!: () => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const view = (text = '  **answer**\n\nλ\n', contextIdentity = 'account/session') => <CopyTextButton contextIdentity={contextIdentity} label="Copy answer" text={text} />
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }) })

describe('copy text control', () => {
  it('copies the exact text, confirms only after resolution, and guards duplicate clicks', async () => {
    const request = deferred()
    const write = clipboard(vi.fn(() => request.promise))
    render(view())
    const button = screen.getByRole('button', { name: 'Copy answer' })
    button.focus()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(write).toHaveBeenCalledExactlyOnceWith('  **answer**\n\nλ\n')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Copying…')
    await act(async () => request.resolve())
    expect(screen.getByRole('status').textContent).toBe('Copied.')
    expect(document.activeElement).toBe(button)
  })

  it('labels a successful older streaming snapshot honestly', async () => {
    const request = deferred()
    const write = clipboard(vi.fn(() => request.promise))
    const { rerender } = render(view('first'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    rerender(view('first second'))
    await act(async () => request.resolve())
    expect(write).toHaveBeenCalledWith('first')
    expect(screen.getByRole('status').textContent).toBe('Copied snapshot.')
  })

  it.each(['missing', 'denied', 'sync throw'])('offers the captured selectable fallback when clipboard is %s', async kind => {
    if (kind === 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    else clipboard(kind === 'denied' ? vi.fn().mockRejectedValue(new Error('Denied')) : vi.fn(() => { throw new Error('Blocked') }))
    const { rerender } = render(view('exact snapshot\n'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    await screen.findByRole('textbox')
    rerender(view('newer text'))
    const fallback = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(fallback.value).toBe('exact snapshot\n')
    expect(fallback.closest('[role="status"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select text' }))
    expect(document.activeElement).toBe(fallback)
    expect(fallback.selectionEnd).toBe(fallback.value.length)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss copy feedback' }))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('allows a fresh retry after failure', async () => {
    const write = clipboard(vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValue(undefined))
    const { rerender } = render(view('old'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    await screen.findByRole('textbox')
    rerender(view('new'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied.'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(write.mock.calls.map(call => call[0])).toEqual(['old', 'new'])
  })

  it.each(['resolve', 'reject'] as const)('retires pending %s and fallback across context changes', async outcome => {
    const request = deferred()
    clipboard(vi.fn(() => request.promise))
    const { rerender, unmount } = render(<StrictMode>{view('private A')}</StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    rerender(<StrictMode>{view('private B', 'new-owner/reset/session')}</StrictMode>)
    await act(async () => request[outcome]())
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(/private A/)).toBeNull()
    unmount()
  })

  it('drops manual fallback on a context reset', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('Denied')))
    const { rerender } = render(view('private A'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    await screen.findByRole('textbox')
    rerender(view('private B', 'privacy-reset'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

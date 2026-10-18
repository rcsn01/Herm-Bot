import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MessageBubble } from './message-bubble'

const view = (identity = 'session-1', enabled = true) => <MessageBubble aria-label="Your message" contextIdentity={identity}
  actions={enabled ? close => <button onClick={close}>Edit & retry</button> : undefined}>
  <p>Message text</p><a href="https://example.com">Link</a><pre>Code</pre><button>Read aloud</button>
</MessageBubble>
const bubble = () => screen.getByRole('article', { name: 'Your message' })
const pointer = (type: string, target: Element = bubble(), fields: Record<string, unknown> = {}) => {
  fireEvent(target, Object.assign(new Event(type, { bubbles: true }), {
    button: 0, clientX: 40, clientY: 40, pointerId: 1, isPrimary: true, pointerType: 'touch', ...fields
  }))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps actions hidden until a hold and closes after choosing an action', () => {
  render(view())
  expect(screen.queryByRole('button', { name: 'Edit & retry' })).toBeNull()
  pointer('pointerdown')
  act(() => vi.advanceTimersByTime(499))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.getByRole('dialog', { name: 'Message options' })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Edit & retry' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['pointerup', 'pointercancel', 'pointerleave', 'pointermove', 'scroll', 'multitouch'])('cancels a hold on %s', reason => {
  render(view())
  pointer('pointerdown')
  if (reason === 'scroll') fireEvent.scroll(window)
  else if (reason === 'pointerleave') fireEvent.pointerOut(bubble())
  else if (reason === 'multitouch') pointer('pointerdown', bubble(), { pointerId: 2, isPrimary: false })
  else pointer(reason, bubble(), reason === 'pointermove' ? { clientY: 80 } : {})
  act(() => vi.advanceTimersByTime(600))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['Link', 'Code', 'Read aloud'])('leaves %s gestures alone', text => {
  render(view())
  const target = screen.getByText(text)
  pointer('pointerdown', target)
  act(() => vi.advanceTimersByTime(600))
  expect(fireEvent.contextMenu(target)).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([{ key: 'Enter' }, { key: ' ' }, { key: 'ContextMenu' }, { key: 'F10', shiftKey: true }])('supports keyboard $key', keys => {
  render(view())
  fireEvent.keyDown(bubble(), keys)
  expect(screen.getByRole('dialog', { name: 'Message options' })).not.toBeNull()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('offers an explicit options button to assistive technology', () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Message options' }))
  expect(screen.getByRole('dialog', { name: 'Message options' })).not.toBeNull()
})

it('supports right click and retires an open menu on context changes', () => {
  const { rerender } = render(view())
  fireEvent.contextMenu(bubble())
  expect(screen.getByRole('dialog')).not.toBeNull()
  rerender(view('session-2'))
  expect(screen.queryByRole('dialog')).toBeNull()
  pointer('pointerdown')
  rerender(view('session-3'))
  act(() => vi.advanceTimersByTime(600))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('retires the menu when actions become unavailable', () => {
  const { rerender } = render(view())
  fireEvent.contextMenu(bubble())
  rerender(view('session-1', false))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(bubble().hasAttribute('tabindex')).toBe(false)
  pointer('pointerdown')
  act(() => vi.advanceTimersByTime(600))
  expect(screen.queryByRole('dialog')).toBeNull()
})

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ContextStatus } from './context-status'

const usage = { used: 25000, limit: 100000 }
const view = (lastResponseAt: number | null = null, active = true) => <ContextStatus active={active} lastResponseAt={lastResponseAt} usage={usage} />

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T12:00:00Z')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('shows occupancy and capacity with an accessible determinate progress bar', () => {
  render(view())
  expect(screen.getByText('Context 25%')).not.toBeNull()
  expect(screen.getByText('25,000 / 100,000')).not.toBeNull()
  const progress = screen.getByRole<HTMLProgressElement>('progressbar', { name: 'Context used' })
  expect(progress.value).toBe(25000)
  expect(progress.max).toBe(100000)
  expect(progress.getAttribute('aria-valuetext')).toBe('25,000 / 100,000 tokens')
  expect(screen.getByText('Est. cache: unknown').getAttribute('title')).toContain('one-hour')
  expect(vi.getTimerCount()).toBe(0)
})

it('identifies locally estimated occupancy', () => {
  render(<ContextStatus active lastResponseAt={null} usage={{ ...usage, estimated: true }} />)
  expect(screen.getByText('Context ~25%')).not.toBeNull()
  expect(screen.getByText('~25,000 / 100,000')).not.toBeNull()
})

it.each([null, { used: null, limit: 100000 }, { used: 25000, limit: null }])('does not invent a full or empty bar for partial usage %j', value => {
  render(<ContextStatus active lastResponseAt={null} usage={value} />)
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByText(/NaN|Infinity/)).toBeNull()
})

it('shows a reported empty context as zero rather than unknown', () => {
  render(<ContextStatus active lastResponseAt={null} usage={{ used: 0, limit: 100000 }} />)
  expect(screen.getByText('Context 0%')).not.toBeNull()
  expect(screen.getByRole<HTMLProgressElement>('progressbar').value).toBe(0)
})

it('counts down one hour without restarting on usage updates and stops at zero', () => {
  const anchor = Date.now()
  const { rerender } = render(view(anchor))
  expect(screen.getByText('Est. cache: 60:00 left')).not.toBeNull()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText('Est. cache: 59:59 left')).not.toBeNull()
  rerender(<ContextStatus active lastResponseAt={anchor} usage={{ used: 50000, limit: 100000 }} />)
  expect(screen.getByText('Est. cache: 59:59 left')).not.toBeNull()
  act(() => vi.advanceTimersByTime(3599000))
  expect(screen.getByText('Est. cache: window elapsed')).not.toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.queryByText(/not cached|uncached|guaranteed hit/i)).toBeNull()
})

it('uses wall-clock time after suspension and retires an anchor on a conversation change', () => {
  const anchor = Date.now()
  const { rerender } = render(view(anchor))
  act(() => { vi.setSystemTime(anchor + 30 * 60000); fireEvent(document, new Event('visibilitychange')) })
  expect(screen.getByText('Est. cache: 30:00 left')).not.toBeNull()
  rerender(view(anchor, false))
  expect(vi.getTimerCount()).toBe(0)
  vi.setSystemTime(anchor + 45 * 60000)
  rerender(view(anchor))
  expect(screen.getByText('Est. cache: 15:00 left')).not.toBeNull()
  rerender(view(null))
  expect(screen.getByText('Est. cache: unknown')).not.toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('starts a new window only when supplied a newly observed completion', () => {
  const { rerender } = render(view(Date.now() - 61 * 60000))
  expect(screen.getByText('Est. cache: window elapsed')).not.toBeNull()
  rerender(view(Date.now()))
  expect(screen.getByText('Est. cache: 60:00 left')).not.toBeNull()
})

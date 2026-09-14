import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { CronScheduleFields, type CronScheduleValue } from './cron-schedule-fields'

afterEach(() => cleanup())

describe('CronScheduleFields', () => {
  it('uses a native dropdown with concise schedule choices', () => {
    render(<CronScheduleFields onChange={() => undefined} value={{ expression: '30m', mode: 'duration' }} />)

    const select = screen.getByRole('combobox', { name: 'Schedule type' })
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      'Repeating interval', 'Natural language', 'Cron expression', 'One time'
    ])
  })

  it('converts a one-time local date selection to an ISO timestamp', () => {
    let next: CronScheduleValue | undefined
    render(<CronScheduleFields onChange={value => { next = value }} value={{ expression: '2026-08-28T09:00:00.000Z', mode: 'once' }} />)

    const input = screen.getByLabelText<HTMLInputElement>('Schedule value')
    expect(input.type).toBe('datetime-local')
    fireEvent.change(input, { target: { value: '2026-08-29T10:30' } })

    expect(next?.expression).toBe(new Date('2026-08-29T10:30').toISOString())
  })
})

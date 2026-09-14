import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/compat/primitives', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
  Input: (props: React.ComponentProps<'input'>) => <input {...props} />
}))

import { CronPickerDialog } from './cron-picker-dialog'

afterEach(() => cleanup())

describe('CronPickerDialog', () => {
  it('searches and saves multiple dynamic choices', () => {
    const onSave = vi.fn()
    const options = ['Browser', 'Calendar', 'Email', 'Files', 'Research', 'Terminal', 'Weather'].map(value => ({ label: value, value: value.toLowerCase() }))
    render(<CronPickerDialog multiple onCancel={() => undefined} onSave={onSave} options={options} selected={['browser']} title="Choose skills" />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search choose skills' }), { target: { value: 'Research' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Research' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(onSave).toHaveBeenCalledWith(['browser', 'research'])
  })

  it('can clear an optional single choice', () => {
    const onSave = vi.fn()
    render(<CronPickerDialog onCancel={() => undefined} onSave={onSave} options={[{ label: 'OpenAI', value: 'openai' }]} selected={['openai']} title="Choose provider" />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(onSave).toHaveBeenCalledWith([])
  })
})

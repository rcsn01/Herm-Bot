import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentActivity } from './agent-activity'
import type { AgentActivityStep } from '~/transcript/agent-activity'

const steps: AgentActivityStep[] = [
  { id: 'reason', kind: 'reasoning', content: 'Reasoning detail', streaming: false },
  { id: 'output', kind: 'tool-output', content: 'Full output' }
]

afterEach(cleanup)

describe('compact agent activity', () => {
  it('defaults to a collapsed card and expands each timeline step independently', () => {
    const { container } = render(<AgentActivity steps={steps} />)
    const card = container.querySelector<HTMLDetailsElement>('.agent-activity-card')!
    expect(card.open).toBe(false)
    expect(screen.getByText('1 reasoning block · 1 tool output')).not.toBeNull()
    fireEvent.click(screen.getByText('Agent activity'))
    expect(card.open).toBe(true)
    const reason = screen.getByText('Reasoning').closest('details')!
    const output = screen.getByText('Tool output').closest('details')!
    fireEvent.click(screen.getByText('Reasoning'))
    expect(reason.open).toBe(true)
    expect(output.open).toBe(false)
    expect(screen.getByText('Reasoning detail')).not.toBeNull()
    fireEvent.click(screen.getByText('Tool output'))
    expect(output.open).toBe(true)
    expect(screen.getByText('Full output')).not.toBeNull()
  })

  it('keeps manual expansion unchanged as streamed content grows and completes', () => {
    const { container, rerender } = render(<AgentActivity steps={[{ ...steps[0], streaming: true } as AgentActivityStep]} />)
    const card = container.querySelector<HTMLDetailsElement>('.agent-activity-card')!
    expect(screen.getAllByText('Thinking').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Agent activity'))
    fireEvent.click(screen.getByText('Reasoning'))
    rerender(<AgentActivity steps={[{ id: 'reason', kind: 'reasoning', content: 'More reasoning', streaming: false }, steps[1]]} />)
    expect(card.open).toBe(true)
    expect(screen.getByText('Reasoning').closest('details')!.open).toBe(true)
    expect(screen.getByText('More reasoning')).not.toBeNull()
    expect(screen.queryByText('Thinking')).toBeNull()
  })

  it('shows live tool status without opening long output and preserves the card after completion', () => {
    const tools = [{ id: 'terminal', name: 'Terminal', detail: 'Long output', status: 'running' as const }]
    const { container, rerender } = render(<AgentActivity tools={tools} running />)
    const card = container.querySelector<HTMLDetailsElement>('.agent-activity-card')!
    expect(card.open).toBe(false)
    expect(screen.getByText('Running: Terminal')).not.toBeNull()
    expect(screen.getByText('1 tool call')).not.toBeNull()
    fireEvent.click(screen.getByText('Session tool activity'))
    fireEvent.click(screen.getByText('Terminal'))
    rerender(<AgentActivity tools={[{ ...tools[0], status: 'complete' }]} running={false} />)
    expect(card.open).toBe(true)
    expect(screen.getByText('Terminal').closest('details')!.open).toBe(true)
    expect(screen.getByText('complete')).not.toBeNull()
    expect(screen.queryByText('Running: Terminal')).toBeNull()
  })

  it('exposes session errors and does not mislabel interrupted tools as completed', () => {
    render(<AgentActivity hasSessionError running={false} tools={[{ id: 't', name: 'Terminal', status: 'progress' }]} />)
    expect(screen.getByText('Session error')).not.toBeNull()
    expect(screen.getByText('Not finished: Terminal')).not.toBeNull()
    expect(screen.getByText('Not finished')).not.toBeNull()
    expect(screen.queryByText('complete')).toBeNull()
  })

  it('preserves empty output with an explicit placeholder', () => {
    render(<AgentActivity steps={[{ id: 'empty', kind: 'tool-output', content: '' }]} />)
    expect(screen.getByText('No output')).not.toBeNull()
  })
})

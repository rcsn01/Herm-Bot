import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const parse = vi.hoisted(() => vi.fn())
vi.mock('react-markdown', async importOriginal => {
  const { default: Markdown } = await importOriginal<typeof import('react-markdown')>()
  return { default: (props: React.ComponentProps<typeof Markdown>) => { parse(props.children); return <Markdown {...props} /> } }
})

import { MessageMarkdown } from './message-markdown'

afterEach(() => { cleanup(); parse.mockClear() })

describe('message Markdown rendering', () => {
  it('does not reparse unchanged messages but renders streamed content changes', () => {
    const { rerender } = render(<MessageMarkdown content="Hello **Hermes**" />)
    expect(parse).toHaveBeenCalledTimes(1)
    rerender(<MessageMarkdown content="Hello **Hermes**" />)
    expect(parse).toHaveBeenCalledTimes(1)
    rerender(<MessageMarkdown content="Hello **Hermes**, updated" />)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/updated/).textContent).toContain('updated')
  })

  it('preserves GFM and safe external links without rendering raw HTML', () => {
    const { container } = render(<MessageMarkdown content={'~~removed~~ [Docs](https://example.com)\n\n<script>alert(1)</script>'} />)
    expect(container.querySelector('del')?.textContent).toBe('removed')
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    expect(container.querySelector('script')).toBeNull()
  })
})

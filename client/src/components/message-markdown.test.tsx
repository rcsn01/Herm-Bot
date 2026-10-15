import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('copies parsed fenced and indented code without reparsing for feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const content = 'Prose `inline`\n\n```ts\n  const x = "λ"\n\n  run()\n```\n\n    indented\n\n```html\n<script>literal</script>\n```'
    const { rerender, container } = render(<MessageMarkdown content={content} copyContext="owner/session" />)
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(3)
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('  const x = "λ"\n\n  run()\n'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[1])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('indented\n'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[2])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('<script>literal</script>\n'))
    expect(container.querySelector('script')).toBeNull()
    expect(parse).toHaveBeenCalledTimes(1)
    rerender(<MessageMarkdown content={content} copyContext="owner/session" />)
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('supports open streamed fences, semantic tables and code scrolling without default copy controls', () => {
    const { container, rerender } = render(<MessageMarkdown content={'| Name | Value |\n| --- | --- |\n| A | B |\n\n```js\npartial'} />)
    expect(screen.getByRole('table').querySelectorAll('th')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Scrollable table' }).tabIndex).toBe(0)
    expect(screen.getByRole('region', { name: 'js code block' }).textContent).toBe('partial\n')
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull()
    rerender(<MessageMarkdown content={'```js\npartial completed\n```'} copyContext="scope" />)
    expect(screen.getByRole('button', { name: 'Copy code' })).not.toBeNull()
    expect(container.querySelector('pre code')?.textContent).toBe('partial completed\n')
  })

  it('scrolls focused wide regions with unmodified horizontal keys only', () => {
    render(<MessageMarkdown content={'```\nwide\n```'} />)
    const region = screen.getByRole('region', { name: 'Code block' })
    Object.defineProperties(region, { scrollWidth: { configurable: true, value: 800 }, clientWidth: { configurable: true, value: 200 } })
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(region.scrollLeft).toBe(40)
    fireEvent.keyDown(region, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(region, { key: 'ArrowDown' })
    fireEvent.keyDown(region.querySelector('code')!, { key: 'ArrowRight' })
    expect(region.scrollLeft).toBe(40)
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    expect(region.scrollLeft).toBe(0)
  })

  it('filters dangerous URLs and treats hostile language labels as text', () => {
    const { container } = render(<MessageMarkdown content={'[bad](javascript:alert)\n\n```<img/onerror=alert(1)>\ntext\n```'} copyContext="scope" />)
    expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
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

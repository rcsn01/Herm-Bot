import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PageShell } from '~/components/page-shell'

afterEach(cleanup)

describe('PageShell', () => {
  it('keeps title, navigation, actions, and content in one shared page contract', () => {
    const { container } = render(
      <PageShell
        actions={<button type="button">Refresh</button>}
        eyebrow="Remote gateway"
        leading={<button type="button">Back</button>}
        subtitle="A consistent page description."
        title="Models"
      >
        <div data-testid="content">Content</div>
      </PageShell>
    )

    expect(container.querySelector('.screen.page-screen')).toBeTruthy()
    expect(container.querySelector('.page-heading')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Models', level: 2 })).toBeTruthy()
    expect(screen.getByText('Remote gateway')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.getByTestId('content')).toBeTruthy()
  })

  it('keeps actions available when the app header owns the page heading', () => {
    const { container } = render(<PageShell actions={<button type="button">Refresh</button>} heading={false} title="Settings"><p>Content</p></PageShell>)

    expect(container.querySelector('.page-heading')).toBeNull()
    expect(container.querySelector('.page-actions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })
})

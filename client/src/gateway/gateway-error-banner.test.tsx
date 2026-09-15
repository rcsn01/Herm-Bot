import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { GatewayError } from './gateway-error'
import { GatewayErrorBanner } from './gateway-error-banner'

const unsupported = new GatewayError('Method not found', { kind: 'unsupported' })

afterEach(cleanup)

describe('GatewayErrorBanner', () => {
  it.each([null, undefined, ''])('renders nothing for %s', error => {
    const { container } = render(<GatewayErrorBanner error={error} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders classified string errors and honors the role', () => {
    const view = render(<GatewayErrorBanner error="Something failed" />)
    let banner = view.getByRole('alert')
    expect(banner.className).toBe('error-banner')
    expect(banner.textContent).toBe('Something failed')

    view.rerender(<GatewayErrorBanner error="Still loading" role="status" />)
    banner = view.getByRole('status')
    expect(banner.textContent).toBe('Still loading')
  })

  it('renders default and custom unsupported copy', () => {
    const view = render(<GatewayErrorBanner error={unsupported} />)
    let banner = view.getByRole('alert')
    expect(banner.className).toBe('unsupported-card')
    expect(banner.textContent).toBe('This gateway does not provide this optional capability.')

    view.rerender(<GatewayErrorBanner error={unsupported} unsupportedText="Cron is unavailable here." />)
    banner = view.getByRole('alert')
    expect(banner.textContent).toBe('Cron is unavailable here.')
  })

  it('renders a rich unsupported card for a subject', () => {
    const view = render(<GatewayErrorBanner error={unsupported} subject="Mixture of agents" unsupportedText="The rest of models still works." />)
    const banner = view.getByRole('alert')
    expect(banner.className).toBe('unsupported-card')
    expect(banner.querySelector('strong')?.textContent).toBe('Mixture of agents unavailable')
    expect(banner.querySelector('p')?.textContent).toBe('The rest of models still works.')
  })

  it('renders a rich error banner for a network failure', () => {
    const view = render(<GatewayErrorBanner error={new TypeError('Failed to fetch')} subject="Models" />)
    const banner = view.getByRole('alert')
    expect(banner.className).toBe('error-banner')
    expect(banner.querySelector('strong')?.textContent).toBe('Could not load Models')
    expect(banner.querySelector('p')?.textContent).toBe('Failed to fetch')
  })

  it('forces unavailable copy for every failure kind', () => {
    const view = render(<GatewayErrorBanner error={new Error('Denied')} unavailablePhrase="Billing is unavailable" />)
    const banner = view.getByRole('alert')
    expect(banner.className).toBe('unsupported-card')
    expect(banner.textContent).toBe('Billing is unavailable: Denied')
  })

  it('classifies a plain Error and displays its message', () => {
    const view = render(<GatewayErrorBanner error={new Error('Broken')} />)
    const banner = view.getByRole('alert')
    expect(banner.className).toBe('error-banner')
    expect(banner.textContent).toBe('Broken')
  })
})

import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { $gatewayReady } from '~/state/store'

export function GatewayActionRegion({ children }: { children: ReactNode }) {
  const ready = useStore($gatewayReady)
  return <>
    {!ready && <p className="muted" role="status">Reconnect to use these gateway controls. Your entered values are kept here.</p>}
    <div inert={!ready ? true : undefined}>{children}</div>
  </>
}

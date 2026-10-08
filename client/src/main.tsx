import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { App } from '~/app'
import { queryClient } from '~/gateway/query-client'
import { initializePwa } from '~/pwa/lifecycle'
import { initializePageZoomLock } from '~/pwa/page-zoom'
import { PwaStatus } from '~/pwa/PwaStatus'
import '~/styles.css'

const cleanupZoomLock = initializePageZoomLock()
const cleanupPwa = initializePwa()
if (import.meta.hot) import.meta.hot.dispose(() => {
  cleanupPwa()
  cleanupZoomLock()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><App /><PwaStatus /></QueryClientProvider>
  </React.StrictMode>
)

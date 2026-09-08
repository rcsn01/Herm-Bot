import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { App } from '~/app'
import { queryClient } from '~/gateway/query-client'
import { initializePwa } from '~/pwa/lifecycle'
import { PwaStatus } from '~/pwa/PwaStatus'
import '~/styles.css'

const cleanupPwa = initializePwa()
if (import.meta.hot) import.meta.hot.dispose(cleanupPwa)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><App /><PwaStatus /></QueryClientProvider>
  </React.StrictMode>
)

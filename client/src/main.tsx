import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { App } from '~/app'
import { queryClient } from '~/gateway/query-client'
import { localPrivacy } from '~/state/local-privacy'
import { initializeDraftProtection } from '~/features/chat/chat-drafts'
import { initializePwa } from '~/pwa/lifecycle'
import { initializePageZoomLock } from '~/pwa/page-zoom'
import { PwaStatus } from '~/pwa/PwaStatus'
import '~/styles.css'

const cleanupPrivacy = localPrivacy.initialize()
const cleanupDraftProtection = initializeDraftProtection()
const cleanupZoomLock = initializePageZoomLock()
const cleanupPwa = initializePwa()
if (import.meta.hot) import.meta.hot.dispose(() => {
  cleanupPrivacy()
  cleanupDraftProtection()
  cleanupPwa()
  cleanupZoomLock()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><App /><PwaStatus /></QueryClientProvider>
  </React.StrictMode>
)

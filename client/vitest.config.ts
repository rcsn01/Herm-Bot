import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({ injectRegister: false })],
  resolve: {
    alias: {
      '~': path.resolve(import.meta.dirname, 'src'),
      '@hermes/shared': path.resolve(import.meta.dirname, '../../shared/src/index.ts')
    }
  },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] }
})

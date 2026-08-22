import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: [
      { find: '~', replacement: path.resolve(import.meta.dirname, 'src') },
      {
        find: '@/lib/utils',
        replacement: path.resolve(import.meta.dirname, 'src/compat/desktop-utils.ts')
      },
      {
        find: '@hermes/shared',
        replacement: path.resolve(import.meta.dirname, '../../shared/src/index.ts')
      },
      { find: 'react', replacement: path.resolve(import.meta.dirname, 'node_modules/react') },
      { find: 'react-dom', replacement: path.resolve(import.meta.dirname, 'node_modules/react-dom') },
      { find: 'radix-ui', replacement: path.resolve(import.meta.dirname, 'node_modules/radix-ui/dist/index.mjs') },
      { find: 'class-variance-authority', replacement: path.resolve(import.meta.dirname, 'node_modules/class-variance-authority/dist/index.mjs') },
      { find: '@tabler/icons-react', replacement: path.resolve(import.meta.dirname, 'node_modules/@tabler/icons-react/dist/esm/tabler-icons-react.mjs') }
    ],
    dedupe: ['react', 'react-dom']
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, '../../..')] }
  }
})

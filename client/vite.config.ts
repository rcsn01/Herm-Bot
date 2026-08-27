import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

function devProxy(target: string, websocket = false): ProxyOptions {
  return {
    changeOrigin: true,
    cookieDomainRewrite: '127.0.0.1',
    cookiePathRewrite: '/',
    target,
    ws: websocket,
    configure(proxy) {
      proxy.on('proxyRes', response => {
        const cookies = response.headers['set-cookie']
        if (cookies) response.headers['set-cookie'] = cookies.map(cookie => cookie.replace(/;\s*Secure\b/gi, ''))
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devGateway = env.HERMES_MOBILE_DEV_GATEWAY?.replace(/\/$/, '') ?? ''
  const proxy = devGateway ? {
    '/api': devProxy(devGateway, true),
    '/auth': devProxy(devGateway)
  } : undefined

  return {
    base: './',
    plugins: [react(), tailwindcss()],
    css: { postcss: { plugins: [] } },
    define: { __HERMES_MOBILE_DEV_GATEWAY__: JSON.stringify(devGateway) },
    resolve: {
      alias: [
        { find: '~', replacement: path.resolve(import.meta.dirname, 'src') },
        { find: '@/lib/utils', replacement: path.resolve(import.meta.dirname, 'src/compat/desktop-utils.ts') },
        { find: '@hermes/shared', replacement: path.resolve(import.meta.dirname, '../../shared/src/index.ts') },
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
      fs: { allow: [path.resolve(import.meta.dirname, '../../..')] },
      proxy
    }
  }
})

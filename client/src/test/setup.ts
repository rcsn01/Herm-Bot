import '@testing-library/dom'

Object.defineProperty(window, 'matchMedia', {
  value: (query: string) => ({
    addEventListener: () => undefined,
    matches: false,
    media: query,
    removeEventListener: () => undefined
  })
})

let uuidCounter = 0
Object.defineProperty(globalThis, 'crypto', {
  value: { ...globalThis.crypto, randomUUID: () => `test-uuid-${++uuidCounter}` }
})

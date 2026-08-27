import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const host = '127.0.0.1'
const port = 5175
const url = `http://${host}:${port}`
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const capacitorBin = fileURLToPath(new URL('../node_modules/@capacitor/cli/bin/capacitor', import.meta.url))
let vite = null
let capacitor = null
let stopping = false

function runNode(script, args) {
  return spawn(process.execPath, [script, ...args], { env: process.env, stdio: 'inherit' })
}

async function isReachable() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForVite() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isReachable()) return
    if (vite?.exitCode !== null) throw new Error(`Vite exited before ${url} became reachable.`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Vite did not become reachable at ${url}.`)
}

function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  if (capacitor?.exitCode === null) capacitor.kill(signal)
  if (vite?.exitCode === null) vite.kill(signal)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(signal)
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  })
}

try {
  if (await isReachable()) {
    console.log(`[ios:live] Using the existing Vite server at ${url}.`)
  } else {
    console.log(`[ios:live] Starting Vite at ${url}.`)
    vite = runNode(viteBin, ['--host', host, '--port', String(port), '--strictPort'])
    await waitForVite()
  }

  capacitor = runNode(capacitorBin, [
    'run', 'ios', '--live-reload', '--host', host, '--port', String(port),
    ...process.argv.slice(2)
  ])
  const exitCode = await new Promise(resolve => capacitor.once('exit', code => resolve(code ?? 1)))
  process.exitCode = exitCode
} catch (error) {
  console.error(`[ios:live] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  stop()
}

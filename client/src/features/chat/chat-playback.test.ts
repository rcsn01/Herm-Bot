import { beforeEach, expect, it, vi } from 'vitest'
import { ChatPlayback } from './chat-playback'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = (data_url: string) => ({ body: { data_url }, headers: {}, status: 200 })
const wav = 'data:audio/wav;base64,AA=='
let players: FakeAudio[]
class FakeAudio {
  src: string
  ended = false
  paused = false
  onplay: (() => void) | null = null
  onpause: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(src: string) { this.src = src; players.push(this) }
  play = vi.fn(async () => { this.paused = false; this.onplay?.() })
  pause = vi.fn(() => { this.paused = true; this.onpause?.() })
}
beforeEach(() => { players = []; vi.stubGlobal('Audio', FakeAudio) })

it('guards duplicate generation, pauses/resumes the same player, and releases ended audio', async () => {
  const result = deferred<ReturnType<typeof response>>()
  const request = vi.fn().mockReturnValue(result.promise)
  const playback = new ChatPlayback({ request })
  const first = playback.speak('a', 'text', () => true)
  await playback.speak('a', 'text', () => true)
  expect(request).toHaveBeenCalledOnce()
  expect(playback.$state.get().status).toBe('generating')
  result.resolve(response(wav)); await first
  expect(playback.$state.get()).toMatchObject({ messageId: 'a', status: 'playing' })
  playback.pause(); expect(playback.$state.get().status).toBe('paused')
  await playback.resume(); expect(playback.$state.get().status).toBe('playing')
  expect(request).toHaveBeenCalledOnce()
  const player = players[0]
  player.ended = true; player.onended?.()
  expect(playback.$state.get().status).toBe('ended')
  expect(player.src).toBe('')
  expect(player.onended).toBeNull()
})

it('Stop aborts generation and makes a late response inert', async () => {
  const result = deferred<ReturnType<typeof response>>()
  const request = vi.fn().mockReturnValue(result.promise)
  const playback = new ChatPlayback({ request })
  const pending = playback.speak('a', 'old', () => true)
  const signal = request.mock.calls[0][0].signal as AbortSignal
  playback.stop(); expect(signal.aborted).toBe(true)
  result.resolve(response(wav)); await pending
  expect(players).toHaveLength(0)
  expect(playback.$state.get().status).toBe('idle')
})

it('a new message owns playback even when an earlier request finishes last', async () => {
  const old = deferred<ReturnType<typeof response>>()
  const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(wav))
  const playback = new ChatPlayback({ request })
  const pending = playback.speak('a', 'old', () => true)
  await playback.speak('b', 'new', () => true)
  old.resolve(response(wav)); await pending
  expect(players).toHaveLength(1)
  expect(playback.$state.get()).toMatchObject({ messageId: 'b', status: 'playing' })
  playback.stop(); expect(players[0].src).toBe('')
})

it.each(['https://untrusted.test/audio', 'data:text/html;base64,AA==', '', 'data:audio/wav;base64,!!!'])('rejects unsupported audio response %s', async url => {
  const playback = new ChatPlayback({ request: vi.fn().mockResolvedValue(response(url)) })
  await playback.speak('a', 'text', () => true)
  expect(players).toHaveLength(0)
  expect(playback.$state.get()).toMatchObject({ status: 'error', error: expect.stringContaining('supported format') })
})

it('does not turn an intentional Pause into an error when the initial play promise rejects late', async () => {
  const started = deferred<void>()
  const playback = new ChatPlayback({ request: vi.fn().mockResolvedValue(response(wav)) })
  class PendingAudio extends FakeAudio {
    override play = vi.fn(() => { this.onplay?.(); return started.promise })
  }
  vi.stubGlobal('Audio', PendingAudio)
  const speaking = playback.speak('a', 'text', () => true)
  await vi.waitFor(() => expect(playback.$state.get().status).toBe('playing'))
  playback.pause()
  started.reject(new DOMException('The operation was aborted.', 'AbortError'))
  await speaking
  expect(playback.$state.get()).toMatchObject({ status: 'paused', error: null })
})

it('reports blocked playback and media errors, then permits a new request', async () => {
  const playback = new ChatPlayback({ request: vi.fn().mockResolvedValue(response(wav)) })
  await playback.speak('a', 'text', () => true)
  playback.pause()
  players[0].play.mockRejectedValueOnce(new Error('Playback blocked'))
  await playback.resume()
  expect(playback.$state.get()).toMatchObject({ status: 'error', error: 'Playback blocked' })
  expect(players[0].src).toBe('')
  await playback.speak('a', 'text', () => true)
  players[1].onerror?.()
  expect(playback.$state.get()).toMatchObject({ status: 'error', error: expect.stringContaining('Audio playback failed') })
})

import { atom } from 'nanostores'
import { errorMessage } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'

export interface PlaybackState {
  messageId: string | null
  status: 'idle' | 'generating' | 'playing' | 'paused' | 'ended' | 'error'
  error: string | null
}
const idle = (): PlaybackState => ({ messageId: null, status: 'idle', error: null })

/** Owns one transient speech request/player, independently of text editing. */
export class ChatPlayback {
  readonly $state = atom<PlaybackState>(idle())
  private generation = 0
  private playAttempt = 0
  private request: AbortController | null = null
  private audio: HTMLAudioElement | null = null

  constructor(private readonly media: Pick<GatewayPort, 'request'>) {}

  stop() {
    ++this.generation
    this.request?.abort()
    this.request = null
    if (this.audio) {
      this.audio.onplay = this.audio.onpause = this.audio.onended = this.audio.onerror = null
      this.audio.pause()
      this.audio.src = ''
      this.audio = null
    }
    this.$state.set(idle())
  }

  async speak(messageId: string, text: string, isCurrent: () => boolean) {
    const previous = this.$state.get()
    if (previous.messageId === messageId && ['generating', 'playing', 'paused'].includes(previous.status)) return
    this.stop()
    const generation = this.generation
    const current = () => generation === this.generation && isCurrent()
    const request = new AbortController()
    this.request = request
    this.$state.set({ messageId, status: 'generating', error: null })
    let attempt: number | null = null
    try {
      const response = await this.media.request<{ data_url?: unknown }>({
        body: { text }, method: 'POST', path: '/api/audio/speak', signal: request.signal
      })
      if (!current()) return
      const url = response.body?.data_url
      if (typeof url !== 'string' || !/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(url)) {
        throw new Error('The speech response did not include audio in a supported format.')
      }
      const audio = new Audio(url)
      this.audio = audio
      audio.onplay = () => { if (current() && !audio.paused) this.setStatus('playing') }
      audio.onpause = () => { if (current() && audio.paused && !audio.ended) this.setStatus('paused') }
      audio.onended = () => { if (current()) { this.releaseAudio(); this.setStatus('ended') } }
      audio.onerror = () => { if (current()) this.fail('Audio playback failed. Try reading this message again.') }
      attempt = ++this.playAttempt
      await audio.play()
      if (current() && attempt === this.playAttempt && this.audio === audio && this.$state.get().status === 'generating') this.setStatus('playing')
    } catch (error) {
      if (current() && (attempt === null || attempt === this.playAttempt)) this.fail(errorMessage(error))
    } finally {
      if (this.request === request) this.request = null
    }
  }

  pause() {
    if (this.audio && this.$state.get().status === 'playing') { ++this.playAttempt; this.audio.pause(); this.setStatus('paused') }
  }

  async resume() {
    if (!this.audio || this.$state.get().status !== 'paused') return
    const generation = this.generation
    const audio = this.audio
    const attempt = ++this.playAttempt
    try {
      await audio.play()
      if (generation === this.generation && attempt === this.playAttempt && this.audio === audio && this.$state.get().status === 'paused') this.setStatus('playing')
    } catch (error) { if (generation === this.generation && attempt === this.playAttempt) this.fail(errorMessage(error)) }
  }

  private releaseAudio() {
    if (!this.audio) return
    this.audio.onplay = this.audio.onpause = this.audio.onended = this.audio.onerror = null
    this.audio.pause()
    this.audio.src = ''
    this.audio = null
  }
  private fail(error: string) { this.releaseAudio(); this.$state.set({ ...this.$state.get(), status: 'error', error }) }
  private setStatus(status: PlaybackState['status']) { this.$state.set({ ...this.$state.get(), status, error: null }) }
}

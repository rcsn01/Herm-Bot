import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatViewport, type ChatViewportOptions } from '~/components/chat-viewport'
import type { ToolActivity } from '~/lib/types'
import type { TranscriptEntry } from '~/transcript/transcript'

interface HarnessProps {
  active?: boolean
  entries?: readonly TranscriptEntry[]
  hasMore?: boolean
  loadingOlder?: boolean
  nextOffset?: number
  onLoadOlder: ChatViewportOptions['onLoadOlder']
  onLoadOlderError: ChatViewportOptions['onLoadOlderError']
  runtimeSessionId?: null | string
  scrollerKey?: string
  storedSessionId?: null | string
  tools?: readonly ToolActivity[]
  withScroller?: boolean
}

interface ObserverRecord {
  callback: IntersectionObserverCallback
  disconnect: ReturnType<typeof vi.fn<() => void>>
  observed: Element[]
  options?: IntersectionObserverInit
}

interface ResizeObserverRecord {
  callback: ResizeObserverCallback
  disconnect: ReturnType<typeof vi.fn<() => void>>
  observed: Element[]
}

const observers: ObserverRecord[] = []
const resizeObservers: ResizeObserverRecord[] = []

class TestResizeObserver implements ResizeObserver {
  private readonly record: ResizeObserverRecord

  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, disconnect: vi.fn<() => void>(), observed: [] }
    resizeObservers.push(this.record)
  }

  disconnect = () => {
    this.record.disconnect()
  }

  observe = (target: Element) => {
    this.record.observed.push(target)
  }

  unobserve = () => undefined
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds: number[] = []
  private readonly record: ObserverRecord

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, disconnect: vi.fn<() => void>(), observed: [], options }
    observers.push(this.record)
  }

  disconnect = () => {
    this.record.disconnect()
  }

  observe = (target: Element) => {
    this.record.observed.push(target)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  unobserve = () => undefined
}

function entry(content: string, id = content): TranscriptEntry {
  return { author: 'assistant', content, id, kind: 'message', streaming: false }
}

function Harness({
  active = true,
  entries = [entry('latest')],
  hasMore = false,
  loadingOlder = false,
  nextOffset = 0,
  onLoadOlder,
  onLoadOlderError,
  runtimeSessionId = 'runtime-1',
  scrollerKey = 'scroller-1',
  storedSessionId = null,
  tools = [],
  withScroller = true
}: HarnessProps) {
  const viewport = useChatViewport({
    active,
    content: { entries, tools },
    history: { hasMore, loadingOlder, nextOffset },
    onLoadOlder,
    onLoadOlderError,
    session: { runtimeSessionId, storedSessionId }
  })
  const transcript = (
    <div className="transcript" data-testid="transcript" ref={viewport.transcriptRef}>
      {hasMore && <button disabled={loadingOlder} onClick={() => void viewport.loadOlderMessages()} ref={viewport.olderMessagesRef}>Load earlier messages</button>}
      {entries.map((item, index) => <span data-testid={`entry-${index}`} key={item.id}>{item.content}</span>)}
      {tools.map(tool => <span data-testid={`tool-${tool.id}`} key={tool.id}>{tool.name}</span>)}
      <div data-testid="bottom" ref={viewport.bottomRef} />
    </div>
  )
  return (
    <>
      {withScroller ? <div className="view-container" data-testid="scroller" key={scrollerKey}>{transcript}</div> : transcript}
      <div data-testid="composer" ref={viewport.composerRef} />
      <button data-testid="load-trigger" onClick={() => void viewport.loadOlderMessages()}>Trigger older load</button>
      {viewport.hasNewMessages && <button onClick={viewport.jumpToLatest}>New messages. Jump to latest</button>}
    </>
  )
}

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const onLoadOlder = overrides.onLoadOlder ?? vi.fn().mockResolvedValue(false)
  const onLoadOlderError = overrides.onLoadOlderError ?? vi.fn()
  const result = render(<Harness {...overrides} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
  return { ...result, onLoadOlder, onLoadOlderError }
}

function setScrollerMetrics({ clientHeight = 500, scrollHeight = 1_000, scrollTop = 500 }: { clientHeight?: number; scrollHeight?: number; scrollTop?: number } = {}) {
  const scroller = screen.getByTestId('scroller') as HTMLElement
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight }
  })
  scroller.scrollTop = scrollTop
  return scroller
}

function changeScrollHeight(value: number) {
  Object.defineProperty(screen.getByTestId('scroller'), 'scrollHeight', { configurable: true, value })
}

function notify(record: ObserverRecord, isIntersecting: boolean) {
  act(() => {
    record.callback([{ isIntersecting } as IntersectionObserverEntry], record as unknown as IntersectionObserver)
  })
}

function notifyResize(record: ResizeObserverRecord, target: Element, height: number) {
  act(() => {
    record.callback([{ contentRect: { height }, target } as ResizeObserverEntry], record as unknown as ResizeObserver)
  })
}

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()

function flushFrames() {
  const queued = [...frames.entries()]
  frames.clear()
  act(() => {
    for (const [, callback] of queued) callback(0)
  })
}

beforeEach(() => {
  observers.length = 0
  resizeObservers.length = 0
  frames.clear()
  frameId = 0
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('initial positioning and following', () => {
  it('opens a resumed session at its latest message', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    renderHarness({ storedSessionId: 'stored-1' })

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('waits to position an inactive resumed screen until it becomes active', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const { rerender } = renderHarness({ active: false, storedSessionId: 'stored-1' })

    expect(scrollIntoView).not.toHaveBeenCalled()
    rerender(<Harness active onLoadOlder={vi.fn().mockResolvedValue(false)} onLoadOlderError={vi.fn()} storedSessionId="stored-1" />)

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('does not position an empty resumed session until its first entries arrive', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const tools = [{ id: 'tool-1', name: 'terminal', status: 'running' as const }]
    const { rerender } = renderHarness({ entries: [], onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })

    expect(scrollIntoView).not.toHaveBeenCalled()
    rerender(<Harness entries={[]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" tools={tools} />)
    expect(scrollIntoView).not.toHaveBeenCalled()

    rerender(<Harness entries={[entry('first')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" tools={tools} />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('keeps following streamed content without upward user intent', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    scrollIntoView.mockClear()

    rerender(<Harness entries={[entry('more', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('keeps the latest message anchored across composer and viewport resizes only while following', () => {
    renderHarness()
    const scroller = setScrollerMetrics()
    const composer = screen.getByTestId('composer')
    const bottom = screen.getByTestId('bottom')
    const resizeObserver = resizeObservers[0]!
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ height: 126, top: 420 } as DOMRect)
    vi.spyOn(bottom, 'getBoundingClientRect').mockReturnValue({ top: 582 } as DOMRect)

    notifyResize(resizeObserver, composer, 126)
    flushFrames()

    expect(scroller.style.getPropertyValue('--composer-occlusion')).toBe('126px')
    expect(scroller.scrollTop).toBe(680)

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 400 }] })
    fireEvent.touchEnd(scroller)
    vi.mocked(composer.getBoundingClientRect).mockReturnValue({ height: 126, top: 300 } as DOMRect)
    notifyResize(resizeObserver, scroller, 420)
    flushFrames()

    expect(scroller.scrollTop).toBe(680)
  })

  it('does not treat composer-style viewport movement without touchmove as scroll intent', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics()
    scrollIntoView.mockClear()

    fireEvent.touchStart(scroller, { touches: [{ clientY: 400 }] })
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    fireEvent.touchEnd(scroller)
    rerender(<Harness entries={[entry('more', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()
  })

  it('ignores a downward touch below the pause threshold', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics()
    scrollIntoView.mockClear()

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 347 }] })
    fireEvent.touchEnd(scroller)
    rerender(<Harness entries={[entry('more', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('stops following after a larger touch, jumps smoothly, and resumes near the bottom', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 500 })
    scrollIntoView.mockClear()

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 400 }] })
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    fireEvent.touchEnd(scroller)
    rerender(<Harness entries={[entry('more', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)

    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New messages. Jump to latest' }))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' })

    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    scrollIntoView.mockClear()
    rerender(<Harness entries={[entry('latest', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })
})

describe('input policy', () => {
  it('pauses at 48 normalized wheel pixels and accumulates across events', () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })
    scrollIntoView.mockClear()

    fireEvent.wheel(scroller, { deltaY: -47, deltaMode: WheelEvent.DOM_DELTA_PIXEL })
    rerender(<Harness entries={[entry('below', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(scrollIntoView).toHaveBeenCalled()

    scrollIntoView.mockClear()
    fireEvent.wheel(scroller, { deltaY: -47, deltaMode: WheelEvent.DOM_DELTA_PIXEL })
    fireEvent.wheel(scroller, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PIXEL })
    rerender(<Harness entries={[entry('paused', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it('uses line and page wheel scales and a nonnegative wheel resets without resuming', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ clientHeight: 500, scrollTop: 400 })

    fireEvent.wheel(scroller, { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE })
    rerender(<Harness entries={[entry('line', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()

    fireEvent.wheel(scroller, { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PIXEL })
    fireEvent.wheel(scroller, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE })
    rerender(<Harness entries={[entry('page', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it.each(['Home', 'PageUp'] as const)('pauses immediately for %s', key => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })

    fireEvent.keyDown(scroller, { key })
    rerender(<Harness entries={[entry('paused', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it('pauses for shift-space but ignores unrelated keys', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })

    fireEvent.keyDown(scroller, { key: 'Escape' })
    rerender(<Harness entries={[entry('following', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()

    fireEvent.keyDown(scroller, { key: ' ', shiftKey: true })
    rerender(<Harness entries={[entry('paused', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it('pauses after three ArrowUp events and clears partial intent after idle', () => {
    vi.useFakeTimers()
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })

    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    vi.advanceTimersByTime(200)
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    rerender(<Harness entries={[entry('following', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()

    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    fireEvent.keyDown(scroller, { key: 'ArrowUp' })
    rerender(<Harness entries={[entry('paused', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it('updates the touch baseline upward, ignores multi-touch, and cleans touch tracking', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 250 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 297 }] })
    fireEvent.touchEnd(scroller)
    rerender(<Harness entries={[entry('following', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }, { clientY: 301 }] })
    fireEvent.touchMove(scroller, { touches: [{ clientY: 400 }, { clientY: 401 }] })
    fireEvent.touchCancel(scroller)
  })

  it('tracks mouse pointer scroll distance but ignores non-mouse pointers', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 500 })

    fireEvent.pointerDown(scroller, { pointerType: 'touch' })
    scroller.scrollTop = 400
    fireEvent.pointerMove(scroller, { pointerType: 'touch' })
    rerender(<Harness entries={[entry('ignored', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()

    fireEvent.pointerDown(scroller, { pointerType: 'mouse' })
    scroller.scrollTop = 352
    fireEvent.pointerMove(scroller, { pointerType: 'mouse' })
    rerender(<Harness entries={[entry('paused', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
    fireEvent.pointerUp(scroller, { pointerType: 'mouse' })
  })

  it('resumes only for an intersecting bottom marker', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })
    fireEvent.keyDown(scroller, { key: 'Home' })
    rerender(<Harness entries={[entry('paused', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    const bottomObserver = observers.find(observer => observer.observed.includes(screen.getByTestId('bottom')))
    expect(bottomObserver).toBeDefined()

    notify(bottomObserver!, false)
    rerender(<Harness entries={[entry('still-paused', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
    notify(bottomObserver!, true)
    rerender(<Harness entries={[entry('following', 'entry-4')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.queryByRole('button', { name: 'New messages. Jump to latest' })).toBeNull()
  })
})

describe('older history loading', () => {
  it('preserves the visible anchor after a published prepend', async () => {
    let resolveLoad!: (applied: boolean) => void
    const onLoadOlder = vi.fn(() => new Promise<boolean>(resolve => { resolveLoad = resolve }))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({
      entries: [entry('latest')],
      hasMore: true,
      nextOffset: 80,
      onLoadOlder,
      onLoadOlderError,
      storedSessionId: 'stored-1'
    })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(onLoadOlder).toHaveBeenCalledOnce()

    await act(async () => {
      resolveLoad(true)
      await Promise.resolve()
    })
    changeScrollHeight(160)
    rerender(<Harness entries={[entry('older', 'entry-older'), entry('latest')]} hasMore nextOffset={160} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    flushFrames()

    await waitFor(() => expect(scroller.scrollTop).toBe(80))
  })

  it('invokes manual loading without a scroller and never compensates', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(true)
    const onLoadOlderError = vi.fn()
    renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1', withScroller: false })

    fireEvent.click(screen.getByTestId('load-trigger'))
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    expect(frames.size).toBe(0)
  })

  it('gates inactive, incomplete, exhausted, busy, and duplicate loads', async () => {
    const onLoadOlder = vi.fn(() => new Promise<boolean>(() => undefined))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ active: false, hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    fireEvent.click(screen.getByTestId('load-trigger'))
    expect(onLoadOlder).not.toHaveBeenCalled()

    rerender(<Harness hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} runtimeSessionId={null} storedSessionId="stored-1" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} runtimeSessionId="runtime-1" storedSessionId={null} />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} runtimeSessionId="runtime-1" storedSessionId="stored-1" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness hasMore loadingOlder onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    fireEvent.click(screen.getByTestId('load-trigger'))
    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('does not compensate a false result even when the offset changes', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByTestId('load-trigger'))
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    changeScrollHeight(160)
    rerender(<Harness entries={[entry('changed', 'entry-2')]} hasMore nextOffset={160} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    flushFrames()
    expect(scroller.scrollTop).toBe(20)
  })

  it('uses true as the prepend signal when reconciliation rewrites the offset', async () => {
    let resolveLoad!: (applied: boolean) => void
    const onLoadOlder = vi.fn(() => new Promise<boolean>(resolve => { resolveLoad = resolve }))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByTestId('load-trigger'))
    await act(async () => {
      resolveLoad(true)
      await Promise.resolve()
    })
    changeScrollHeight(160)
    rerender(<Harness entries={[entry('older', 'entry-older'), entry('latest')]} hasMore nextOffset={40} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    flushFrames()
    await waitFor(() => expect(scroller.scrollTop).toBe(80))
  })

  it('reports a current failure and leaves the anchor unchanged', async () => {
    let rejectLoad!: (error: unknown) => void
    const error = new Error('history failed')
    const onLoadOlder = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectLoad = reject }))
    const onLoadOlderError = vi.fn()
    renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByTestId('load-trigger'))
    await act(async () => {
      changeScrollHeight(160)
      rejectLoad(error)
      await Promise.resolve()
    })

    expect(onLoadOlderError).toHaveBeenCalledWith(error)
    expect(scroller.scrollTop).toBe(20)
    expect(frames.size).toBe(0)
  })

  it('reports a same-session failure after deactivation but discards it after unmount', async () => {
    let rejectLoad!: (error: unknown) => void
    const onLoadOlder = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectLoad = reject }))
    const onLoadOlderError = vi.fn()
    const { rerender, unmount } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness active={false} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    const inactiveError = new Error('inactive failure')
    await act(async () => {
      rejectLoad(inactiveError)
      await Promise.resolve()
    })
    expect(onLoadOlderError).toHaveBeenCalledWith(inactiveError)

    let rejectSecond!: (error: unknown) => void
    onLoadOlder.mockImplementation(() => new Promise<boolean>((_resolve, reject) => { rejectSecond = reject }))
    rerender(<Harness active hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    unmount()
    await act(async () => {
      rejectSecond(new Error('unmounted failure'))
      await Promise.resolve()
    })
    expect(onLoadOlderError).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['runtime', 'runtime-2', 'stored-1'],
    ['stored', 'runtime-1', 'stored-2']
  ] as const)('discards a pending request after a %s identity change', async (_kind, runtimeSessionId, storedSessionId) => {
    let rejectLoad!: (error: unknown) => void
    const error = new Error('stale history')
    const onLoadOlder = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectLoad = reject }))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} runtimeSessionId={runtimeSessionId} storedSessionId={storedSessionId} />)
    await act(async () => {
      rejectLoad(error)
      await Promise.resolve()
    })

    expect(onLoadOlderError).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(20)
    expect(frames.size).toBe(0)
  })

  it('lets a new active session load while the old request is pending', async () => {
    const releases: Array<(applied: boolean) => void> = []
    const onLoadOlder = vi.fn(() => new Promise<boolean>(resolve => { releases.push(resolve) }))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} runtimeSessionId="runtime-2" storedSessionId="stored-2" />)
    fireEvent.click(screen.getByTestId('load-trigger'))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    await act(async () => {
      releases[0]!(true)
      await Promise.resolve()
    })
    expect(frames.size).toBe(0)
    await act(async () => {
      releases[1]!(false)
      await Promise.resolve()
    })
    expect(onLoadOlderError).not.toHaveBeenCalled()
  })

  it('keeps button and observer triggers to one operation through compensation', async () => {
    let resolveLoad!: (applied: boolean) => void
    const onLoadOlder = vi.fn(() => new Promise<boolean>(resolve => { resolveLoad = resolve }))
    const onLoadOlderError = vi.fn()
    renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const observer = observers.find(item => item.observed.includes(screen.getByRole('button', { name: 'Load earlier messages' })))!
    notify(observer, true)
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    expect(onLoadOlder).toHaveBeenCalledOnce()

    await act(async () => {
      resolveLoad(false)
      await Promise.resolve()
    })
  })

  it('loads from an older sentinel only for intersections and re-arms after a non-intersecting delivery', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const target = screen.getByRole('button', { name: 'Load earlier messages' })
    const observer = observers.find(item => item.observed.includes(target))!

    notify(observer, false)
    expect(onLoadOlder).not.toHaveBeenCalled()
    notify(observer, true)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    notify(observer, true)
    expect(onLoadOlder).toHaveBeenCalledOnce()
    notify(observer, false)
    notify(observer, true)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2))
  })

  it('keeps a persistent observer single-flight through compensation and allows the next page after success', async () => {
    let resolveFirst!: (applied: boolean) => void
    const onLoadOlder = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(false)
    const onLoadOlderError = vi.fn()
    renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    const target = screen.getByRole('button', { name: 'Load earlier messages' })
    const observer = observers.find(item => item.observed.includes(target))!

    notify(observer, true)
    await act(async () => {
      resolveFirst(true)
      await Promise.resolve()
    })
    expect(frames.size).toBe(1)
    notify(observer, true)
    expect(onLoadOlder).toHaveBeenCalledOnce()

    changeScrollHeight(160)
    flushFrames()
    await waitFor(() => expect(scroller.scrollTop).toBe(80))
    notify(observer, true)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2))
  })

  it('blocks an observer retry after failure or false, then clears the block after a page', async () => {
    const results = [false, true]
    const onLoadOlder = vi.fn(() => Promise.resolve(results.shift() ?? false))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, nextOffset: 80, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    let observer = observers.find(item => item.observed.includes(screen.getByRole('button', { name: 'Load earlier messages' })))!

    notify(observer, true)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    notify(observer, true)
    expect(onLoadOlder).toHaveBeenCalledOnce()
    notify(observer, false)
    notify(observer, true)
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2))

    changeScrollHeight(160)
    rerender(<Harness entries={[entry('older', 'entry-older'), entry('latest')]} hasMore nextOffset={160} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    flushFrames()
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2))
    observer = observers.at(-1)!
    notify(observer, true)
    expect(onLoadOlder).toHaveBeenCalledTimes(3)
  })
})

describe('lifecycle and observer cleanup', () => {
  it('continues manual loading and following without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollTop: 500 })
    scrollIntoView.mockClear()

    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByTestId('load-trigger'))
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce())
    rerender(<Harness entries={[entry('new', 'entry-2')]} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('does not let old observer callbacks act after deactivation or unmount', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender, unmount } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const bottomObserver = observers.find(item => item.observed.includes(screen.getByTestId('bottom')))!
    const olderObserver = observers.find(item => item.observed.includes(screen.getByRole('button', { name: 'Load earlier messages' })))!
    rerender(<Harness active={false} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)

    notify(bottomObserver, true)
    notify(olderObserver, true)
    expect(onLoadOlder).not.toHaveBeenCalled()
    expect(bottomObserver.disconnect).toHaveBeenCalled()
    expect(olderObserver.disconnect).toHaveBeenCalled()

    unmount()
    notify(bottomObserver, true)
    notify(olderObserver, true)
    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it('clears transient intent on deactivation while retaining follow state and the new-message button', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ entries: [entry('start')], onLoadOlder, onLoadOlderError })
    const scroller = setScrollerMetrics({ scrollTop: 400 })
    fireEvent.keyDown(scroller, { key: 'Home' })
    rerender(<Harness entries={[entry('new', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()

    rerender(<Harness active={false} entries={[entry('new', 'entry-2')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    rerender(<Harness active entries={[entry('newer', 'entry-3')]} onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} />)
    expect(screen.getByRole('button', { name: 'New messages. Jump to latest' })).not.toBeNull()
  })

  it('restores an applied anchor after inactive completion and discards a replaced scroller', async () => {
    let resolveLoad!: (applied: boolean) => void
    const onLoadOlder = vi.fn(() => new Promise<boolean>(resolve => { resolveLoad = resolve }))
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    const scroller = setScrollerMetrics({ scrollHeight: 100, scrollTop: 20 })
    fireEvent.click(screen.getByTestId('load-trigger'))
    rerender(<Harness active={false} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    await act(async () => {
      resolveLoad(true)
      await Promise.resolve()
    })
    changeScrollHeight(160)
    rerender(<Harness active={false} entries={[entry('older', 'entry-older'), entry('latest')]} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    expect(scroller.scrollTop).toBe(20)

    rerender(<Harness active entries={[entry('older', 'entry-older'), entry('latest')]} hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    flushFrames()
    await waitFor(() => expect(scroller.scrollTop).toBe(80))

    let resolveSecond!: (applied: boolean) => void
    onLoadOlder.mockImplementation(() => new Promise<boolean>(resolve => { resolveSecond = resolve }))
    fireEvent.click(screen.getByTestId('load-trigger'))
    const oldScroller = screen.getByTestId('scroller')
    rerender(<Harness hasMore scrollerKey="scroller-2" onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    const newScroller = screen.getByTestId('scroller') as HTMLElement
    await act(async () => {
      resolveSecond(true)
      await Promise.resolve()
    })
    changeScrollHeight(200)
    flushFrames()
    expect(oldScroller).not.toBe(newScroller)
    expect(newScroller.scrollTop).toBe(0)
  })

  it('keeps inactive screens free of viewport observers until activated', () => {
    const onLoadOlder = vi.fn().mockResolvedValue(false)
    const onLoadOlderError = vi.fn()
    const { rerender } = renderHarness({ active: false, hasMore: true, onLoadOlder, onLoadOlderError, storedSessionId: 'stored-1' })
    expect(observers).toHaveLength(0)
    rerender(<Harness active hasMore onLoadOlder={onLoadOlder} onLoadOlderError={onLoadOlderError} storedSessionId="stored-1" />)
    expect(observers.length).toBeGreaterThan(0)
  })
})

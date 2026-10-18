import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '~/compat/primitives'

type MessageBubbleProps = ComponentProps<'article'> & {
  contextIdentity: string
  actions?: (close: () => void) => ReactNode
}

const interactive = 'a,button,input,textarea,select,summary,details,pre,code,table,[role="region"],[contenteditable="true"]'

// A context change also retires an open menu and any pending clipboard feedback.
export function MessageBubble({ contextIdentity, ...props }: MessageBubbleProps) {
  return <Bubble key={contextIdentity} {...props} />
}

function Bubble({ actions, children, className = '', ...props }: Omit<MessageBubbleProps, 'contextIdentity'>) {
  const [open, setOpen] = useState(false)
  const article = useRef<HTMLElement>(null)
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
    window.removeEventListener('scroll', cancelPress, true)
  }, [])
  const enabled = Boolean(actions)
  useEffect(() => cancelPress, [cancelPress])
  useEffect(() => { if (!enabled) { cancelPress(); setOpen(false) } }, [enabled, cancelPress])
  const openOptions = (focusMessage = true) => {
    cancelPress()
    if (focusMessage) article.current?.focus({ preventScroll: true })
    setOpen(true)
  }
  const isControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(interactive))

  return <>
    <article {...props} ref={article} className={`${className}${actions ? ' message-actionable' : ''}`}
      tabIndex={actions ? 0 : undefined} aria-haspopup={actions ? 'dialog' : undefined} aria-expanded={actions ? open : undefined}
      aria-description={actions ? 'Hold, right-click, or press Enter for message options.' : undefined}
      onPointerDown={event => {
        cancelPress()
        if (!actions || event.isPrimary === false || event.button !== 0 || isControl(event.target)) return
        press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(openOptions, 500) }
        window.addEventListener('scroll', cancelPress, true)
      }}
      onPointerMove={event => {
        const start = press.current
        if (start && (start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)) cancelPress()
      }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
      onContextMenu={event => {
        if (!actions || isControl(event.target)) return
        event.preventDefault()
        openOptions()
      }}
      onKeyDown={event => {
        if (!actions || event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault()
          openOptions()
        }
      }}>
      {children}
      {actions && <Button aria-haspopup="dialog" aria-expanded={open} className="message-options-trigger sr-only"
        onClick={() => openOptions(false)} size="sm" variant="secondary">Message options</Button>}
    </article>
    {open && actions && <MessageOptions onClose={() => setOpen(false)}>{actions(() => setOpen(false))}</MessageOptions>}
  </>
}

function MessageOptions({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => { dialog.close() }
  }, [])
  return createPortal(<dialog aria-label="Message options" className="message-options" ref={ref}
    onCancel={event => { event.preventDefault(); onClose() }}
    onPointerDown={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        event.preventDefault()
        onClose()
      }
    }}>
    <h3>Message options</h3>
    {children}
    <Button onClick={onClose} variant="secondary">Cancel</Button>
  </dialog>, document.body)
}

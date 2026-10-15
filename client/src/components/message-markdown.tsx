import { createContext, memo, useContext, type KeyboardEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CopyTextButton } from './copy-text-button'

const CopyContext = createContext<string | null>(null)

// WebKit does not reliably scroll focused overflow regions with horizontal keys.
// Handle only the region itself, never selection, child controls or vertical keys.
function scrollHorizontally(event: KeyboardEvent<HTMLElement>) {
  const region = event.currentTarget
  if (event.target !== region || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || !['ArrowLeft', 'ArrowRight'].includes(event.key) || region.scrollWidth <= region.clientWidth) return
  event.preventDefault()
  region.scrollLeft += event.key === 'ArrowRight' ? 40 : -40
}

const components: Components = {
  a: ({ children, node: _node, ...props }) => <a {...props} rel="noreferrer noopener" target="_blank">{children}</a>,
  pre: function CodeBlock({ children, node, ...props }) {
    const contextIdentity = useContext(CopyContext)
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
    const text = code?.type === 'element' ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : ''
    const classes = code?.type === 'element' ? code.properties.className : undefined
    const language = Array.isArray(classes) ? String(classes.find(value => String(value).startsWith('language-')) ?? '').slice(9) : ''
    return <div className="markdown-code-block">
      {(language || contextIdentity !== null) && <div className="markdown-code-header">
        {language && <span className="markdown-code-language">{language}</span>}
        {contextIdentity !== null && <CopyTextButton contextIdentity={contextIdentity} label="Copy code" text={text} />}
      </div>}
      <pre {...props} aria-label={language ? `${language} code block` : 'Code block'} role="region" tabIndex={0} onKeyDown={scrollHorizontally}>{children}</pre>
    </div>
  },
  table: ({ children, node: _node, ...props }) => <div aria-label="Scrollable table" className="markdown-table-scroll" role="region" tabIndex={0} onKeyDown={scrollHorizontally}><table {...props}>{children}</table></div>
}
const remarkPlugins = [remarkGfm]

// Clipboard feedback lives below the parser. Neither copying nor composer edits
// should reparse unchanged history. Context only changes at a scope transition.
export const MessageMarkdown = memo(function MessageMarkdown({ content, copyContext = null }: { content: string; copyContext?: string | null }) {
  return <CopyContext.Provider value={copyContext}><div className="message-markdown"><ReactMarkdown components={components} remarkPlugins={remarkPlugins} skipHtml>{content}</ReactMarkdown></div></CopyContext.Provider>
})

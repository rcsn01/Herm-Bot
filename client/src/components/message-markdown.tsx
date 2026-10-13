import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ children, ...props }) => <a {...props} rel="noreferrer noopener" target="_blank">{children}</a>
}
const remarkPlugins = [remarkGfm]

// Parsing grows with message length. Composer edits and other messages' deltas
// must not reparse unchanged history.
export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <ReactMarkdown components={components} remarkPlugins={remarkPlugins} skipHtml>{content}</ReactMarkdown>
})

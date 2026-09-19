import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkPlugins, rehypePlugins, resolveMarkdownPath } from '../lib/markdown.ts';

interface MarkdownViewerProps {
  content: string;
  /** Bundle-relative path of the file being rendered — relative links like
   *  (economics.md) resolve against its directory. Omitted = bundle root. */
  currentPath?: string;
  onNavigate: (relativePath: string) => void;
}

export function MarkdownViewer({ content, currentPath, onNavigate }: MarkdownViewerProps) {
  const components: Components = {
    a({ href, children }) {
      const internal = href ? resolveMarkdownPath(href, currentPath) : null;
      if (internal) {
        return (
          <a
            href="#"
            className="md-internal-link"
            onClick={(event) => {
              event.preventDefault();
              onNavigate(internal);
            }}
          >
            {children}
          </a>
        );
      }
      // In-page fragment anchors keep default behavior — no new tab.
      if (href && href.startsWith('#')) {
        return <a href={href}>{children}</a>;
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

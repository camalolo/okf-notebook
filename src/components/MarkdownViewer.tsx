import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkPlugins, rehypePlugins } from '../lib/markdown.ts';

interface MarkdownViewerProps {
  content: string;
  onNavigate: (relativePath: string) => void;
}

export function MarkdownViewer({ content, onNavigate }: MarkdownViewerProps) {
  const components: Components = {
    a({ href, children }) {
      if (href && href.startsWith('/') && href.endsWith('.md')) {
        const relativePath = href.replace(/^\/+/, '');
        return (
          <a
            href="#"
            className="md-internal-link"
            onClick={(event) => {
              event.preventDefault();
              onNavigate(relativePath);
            }}
          >
            {children}
          </a>
        );
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

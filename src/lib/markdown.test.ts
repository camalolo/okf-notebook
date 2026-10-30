import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins, resolveMarkdownPath } from './markdown.ts';
import { MarkdownViewer } from '../components/MarkdownViewer.tsx';

function render(md: string): string {
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, md),
  );
}

describe('shared markdown pipeline', () => {
  it('renders raw inline HTML like <small> as real elements', () => {
    const html = render('plain <small>small text</small> end');
    expect(html).toContain('<small>small text</small>');
  });

  it('strips dangerous raw HTML (script, event handlers, javascript: URLs)', () => {
    const html = render('<script>alert(1)</script><img src="x" onerror="alert(1)">');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('does not inject whitespace text nodes around GFM tables', () => {
    // rehype-raw re-parses the tree with parse5, which foster-parents text out
    // of <table>. Chat bubbles render white-space: pre-wrap, so those nodes
    // used to show up as a stack of blank lines between paragraph and table.
    const html = render('Intro:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro.\n');
    expect(html).toContain('<p>Intro:</p><table>');
    expect(html).toContain('</table><p>Outro.</p>');
    expect(html.match(/\n{2,}/g)).toBeNull();
  });

  it('does not inject whitespace text nodes around raw HTML tables', () => {
    const html = render('<table>\n<tr><td>x</td></tr>\n</table>');
    expect(html).toContain('<table><tbody><tr><td>x</td></tr></tbody></table>');
    expect(html.match(/\n{2,}/g)).toBeNull();
  });
});

describe('strikethrough tildes', () => {
  it('renders single tildes literally (approx notation must not strike through)', () => {
    // GFM's default also matches a single `~`, so one "approximately" tilde
    // opened a <del> that swallowed everything up to the next tilde in the
    // message — chat showed strikethrough from `($148.50~149)` onwards.
    const html = render(
      'below the last mark ($148.50~149) — so it is protective above $148',
    );
    expect(html).not.toContain('<del>');
    expect(html).toContain('$148.50~149');
  });

  it('still renders double-tilde strikethrough', () => {
    const html = render('a ~~struck~~ word');
    expect(html).toContain('<del>struck</del>');
  });
});

describe('resolveMarkdownPath', () => {
  const ctx = 'university/glossary/index.md';

  it('normalizes bundle-absolute paths', () => {
    expect(resolveMarkdownPath('/university/tunghai.md', ctx)).toBe('university/tunghai.md');
    expect(resolveMarkdownPath('/index.md')).toBe('index.md');
  });

  it('resolves sibling relative links against the current file directory', () => {
    expect(resolveMarkdownPath('economics.md', ctx)).toBe('university/glossary/economics.md');
    expect(resolveMarkdownPath('./economics.md', ctx)).toBe('university/glossary/economics.md');
  });

  it('resolves parent-relative links', () => {
    expect(resolveMarkdownPath('../credits/status.md', ctx)).toBe('university/credits/status.md');
    expect(resolveMarkdownPath('../../profile.md', ctx)).toBe('profile.md');
  });

  it('strips #fragments from internal links', () => {
    expect(resolveMarkdownPath('economics.md#supply', ctx)).toBe('university/glossary/economics.md');
    expect(resolveMarkdownPath('/university/tunghai.md#fees', ctx)).toBe('university/tunghai.md');
  });

  it('rejects external URLs and other schemes', () => {
    expect(resolveMarkdownPath('https://example.com/a.md', ctx)).toBeNull();
    expect(resolveMarkdownPath('//evil.example/a.md', ctx)).toBeNull();
    expect(resolveMarkdownPath('mailto:x@y.z', ctx)).toBeNull();
  });

  it('rejects fragment-only and non-markdown targets', () => {
    expect(resolveMarkdownPath('#section', ctx)).toBeNull();
    expect(resolveMarkdownPath('image.png', ctx)).toBeNull();
    expect(resolveMarkdownPath('doc.pdf', ctx)).toBeNull();
  });

  it('resolves relative links against the bundle root when no currentPath (chat)', () => {
    expect(resolveMarkdownPath('financials/laptop-purchase.md')).toBe('financials/laptop-purchase.md');
    expect(resolveMarkdownPath('economics.md')).toBe('economics.md');
  });

  it('collapses redundant parent segments', () => {
    expect(resolveMarkdownPath('./glossary/../economics.md', ctx)).toBe(
      'university/glossary/economics.md',
    );
    expect(resolveMarkdownPath('../glossary/../credits/status.md', ctx)).toBe(
      'university/credits/status.md',
    );
  });

  it('is case-insensitive about the .md suffix', () => {
    expect(resolveMarkdownPath('Notes.MD', ctx)).toBe('university/glossary/Notes.MD');
  });

  it('percent-decodes escapes to match raw filesystem names', () => {
    expect(resolveMarkdownPath('My%20Notes.md', ctx)).toBe('university/glossary/My Notes.md');
    expect(resolveMarkdownPath('economics%2Emd', ctx)).toBe('university/glossary/economics.md');
  });

  it('keeps malformed percent escapes as authored', () => {
    expect(resolveMarkdownPath('100%.md', ctx)).toBe('university/glossary/100%.md');
  });
});

describe('MarkdownViewer link handling', () => {
  function renderViewer(md: string, currentPath?: string): string {
    return renderToStaticMarkup(
      React.createElement(
        MarkdownViewer,
        { content: md, currentPath, onNavigate: () => {} },
      ),
    );
  }

  it('renders relative .md links as in-app navigation links', () => {
    const html = renderViewer('[Economics](economics.md)', 'university/glossary/index.md');
    expect(html).toContain('md-internal-link');
    expect(html).not.toContain('target="_blank"');
  });

  it('renders bundle-absolute .md links as in-app navigation links', () => {
    const html = renderViewer('[Tunghai](/university/tunghai.md)', 'university/glossary/index.md');
    expect(html).toContain('md-internal-link');
  });

  it('keeps external links in a new tab', () => {
    const html = renderViewer('[site](https://example.com)', 'index.md');
    expect(html).not.toContain('md-internal-link');
    expect(html).toContain('target="_blank"');
  });
});

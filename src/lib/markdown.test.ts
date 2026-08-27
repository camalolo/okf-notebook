import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins } from './markdown.ts';

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

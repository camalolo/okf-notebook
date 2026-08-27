import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { PluggableList } from 'unified';

/**
 * Shared react-markdown plugin set (MarkdownViewer + ChatPanel chat bubbles).
 *
 * react-markdown strips raw HTML by default, so `<small>x</small>` in a note
 * used to render as plain "x". `rehype-raw` parses the HTML into real
 * elements, and `rehype-sanitize` then strips anything dangerous
 * (<script>, event handlers, javascript: URLs, …) — order matters.
 *
 * The schema is GitHub's default plus the inline/blocks we explicitly want
 * authors to be able to use: <small> <span> <sub> <sup> <mark> <kbd>
 * <details>/<summary> (collapsible sections). Everything else raw still gets
 * dropped, and dangerous content never survives sanitization.
 */
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'small',
    'span',
    'sub',
    'sup',
    'mark',
    'kbd',
    'details',
    'summary',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Keep GFM table cell alignment (`align` attribute) through sanitization.
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
  },
};

export const remarkPlugins: PluggableList = [remarkGfm];

/**
 * Drop whitespace-only text nodes in table/list containers and at the tree
 * root. Browsers collapse those in normal flow, but chat bubbles render with
 * `white-space: pre-wrap`, and parse5 (rehype-raw's HTML re-parse) actually
 * *moves* text out of <table> ("foster parenting") — GFM tables carry a dozen
 * such nodes, which rendered as a stack of blank lines before every table.
 * Structural whitespace is always insignificant inside these containers, and
 * at the root it can only sit between block elements, so stripping is safe.
 * Run before rehypeRaw (prevents the foster parenting) and after (catches
 * whitespace in raw-authored tables/lists).
 */
interface LooseHastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: LooseHastNode[];
}

const WS_ONLY = /^\s*$/;
const STRUCTURAL = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol']);

function stripStructuralWhitespace(node: LooseHastNode, isRoot = false): void {
  const children = node.children;
  if (!children) return;
  const dropHere =
    isRoot || (node.type === 'element' && node.tagName != null && STRUCTURAL.has(node.tagName));
  let i = 0;
  while (i < children.length) {
    const child = children[i]!;
    if (dropHere && child.type === 'text' && WS_ONLY.test(child.value ?? '')) {
      children.splice(i, 1);
      continue;
    }
    stripStructuralWhitespace(child);
    i++;
  }
}

function rehypeTrimStructuralWhitespace() {
  return (tree: LooseHastNode) => {
    stripStructuralWhitespace(tree, tree.type === 'root');
  };
}

export const rehypePlugins: PluggableList = [
  rehypeTrimStructuralWhitespace,
  rehypeRaw,
  rehypeTrimStructuralWhitespace,
  [rehypeSanitize, schema],
];

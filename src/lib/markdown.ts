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
 * Resolve a markdown link target to a bundle-root-relative file path, or
 * null when the link is not an in-bundle `.md` link.
 *
 * Authored notes use several styles (all must navigate in-app, never open a
 * new tab):
 *   /university/tunghai.md      → bundle-absolute
 *   economics.md                → relative to the current file's directory
 *   ../credits/status.md        → relative with parent segments
 *   economics.md#section        → fragment stripped (headings aren't slugged,
 *                                 so opening the target file is the best move)
 *
 * Returns null for external URLs (`https:`, `mailto:`, `//host/…`),
 * fragment-only in-page links (`#section`), and anything not ending in `.md`
 * — those stay regular anchors (external ones keep target="_blank").
 * `currentPath` is the bundle-relative path of the file being rendered; pass
 * null/undefined (chat bubbles) to resolve relative links against the bundle
 * root.
 */
export function resolveMarkdownPath(
  href: string,
  currentPath?: string | null,
): string | null {
  if (!href) return null;
  const hash = href.indexOf('#');
  const raw = hash === -1 ? href : href.slice(0, hash);
  // Percent-decode explicit escapes (`My%20Notes.md` → `My Notes.md`) — the
  // app routes carry raw filesystem names. Malformed escapes (`100%.md`)
  // throw in decodeURIComponent; keep the authored form instead.
  const pathPart = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  if (!pathPart) return null; // fragment-only (#section) — in-page, not a file
  if (pathPart.startsWith('//')) return null; // protocol-relative URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart)) return null; // any scheme
  if (!/\.md$/i.test(pathPart)) return null;
  const base =
    pathPart.startsWith('/') || !currentPath
      ? ''
      : currentPath.slice(0, currentPath.lastIndexOf('/') + 1);
  const segments: string[] = [];
  for (const seg of (base + pathPart).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments.join('/') || null;
}

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

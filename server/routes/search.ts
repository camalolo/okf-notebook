import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { getBundle } from '../bundles.js';

const router = Router();

const SKIP_DIRS = new Set(['node_modules', '.git']);

interface SearchSection {
  path: string;
  title?: string;
  type?: string;
  heading: string;
  body: string;
}

interface SearchResult {
  path: string;
  title?: string;
  type?: string;
  heading: string;
  snippet: string;
  score: number;
}

async function listMdFiles(dir: string, prefix: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await listMdFiles(fullPath, relPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(relPath);
    }
  }
  files.sort();
  return files;
}

/** Split a markdown file into sections by ## headings. */
function chunkFile(raw: string, filePath: string, fileTitle?: string, fileType?: string): SearchSection[] {
  const parsed = matter(raw);
  const body = parsed.content;
  const sections: SearchSection[] = [];

  // Split on ## headings (but not # or ###)
  const lines = body.split('\n');
  let currentHeading = '';
  let currentBody: string[] = [];

  const flush = () => {
    const text = currentBody.join('\n').trim();
    if (text) {
      sections.push({
        path: filePath,
        title: fileTitle,
        type: fileType,
        heading: currentHeading || '(intro)',
        body: text,
      });
    }
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      flush();
      currentHeading = match[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();
  return sections;
}

/** Extract a snippet around the first match of `query` in `text`. */
function makeSnippet(text: string, query: string, maxLen = 150): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen).trim() + (text.length > maxLen ? '…' : '');
  const start = Math.max(0, idx - Math.floor(maxLen / 3));
  const end = Math.min(text.length, start + maxLen);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet += '…';
  return snippet;
}

router.post('/:bundleId/search', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.json({ results: [] });

    const limit = Math.min(Number(req.body?.limit) || 20, 50);

    const filePaths = await listMdFiles(bundle.path, '');
    const allSections: SearchSection[] = [];

    for (const fp of filePaths) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(bundle.path, fp), 'utf8');
      } catch {
        continue;
      }
      const fm = matter(raw).data ?? {};
      const title = typeof fm.title === 'string' ? fm.title : undefined;
      const type = typeof fm.type === 'string' ? fm.type : undefined;
      allSections.push(...chunkFile(raw, fp, title, type));
    }

    const qLower = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const section of allSections) {
      let score = 0;
      const titleMatch = section.title?.toLowerCase().includes(qLower);
      const headingMatch = section.heading.toLowerCase().includes(qLower);
      const bodyMatch = section.body.toLowerCase().includes(qLower);

      if (titleMatch) score += 5;
      if (headingMatch) score += 3;
      if (bodyMatch) score += 1;

      if (score > 0) {
        results.push({
          path: section.path,
          title: section.title,
          type: section.type,
          heading: section.heading,
          snippet: makeSnippet(section.body, query),
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    res.json({ results: results.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

export default router;

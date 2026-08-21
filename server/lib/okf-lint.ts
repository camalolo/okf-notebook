/**
 * Deterministic OKF conformance checks for a bundle's .md files.
 *
 * This is the machine half of the digest's cleanup pass: it computes a
 * grounded list of spec violations (OKF.md §9 conformance + recommended
 * frontmatter fields) and duplicate-title groups, which the cleanup agent
 * then fixes with its edit tools. Running the detection server-side keeps
 * the LLM from having to (re)discover structural problems itself and makes
 * the cleanup verifiable before/after.
 *
 * Rules implemented (concept files only — index.md/log.md are exempt from
 * frontmatter requirements by the spec):
 * - no_frontmatter / invalid_frontmatter — §9.1 (parseable YAML block required)
 * - missing_type / empty_type             — §9.2 (non-empty `type` required)
 * - missing_title / missing_description   — §4.1 (recommended fields)
 * - empty_body                            — candidate for deletion/merge
 * - duplicate_title                       — same normalized title in ≥2 files
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { listMdFiles } from '../routes/chat.js';
import type { BundleConfig } from '../config.js';

export type OkfRule =
  | 'no_frontmatter'
  | 'invalid_frontmatter'
  | 'missing_type'
  | 'empty_type'
  | 'missing_title'
  | 'missing_description'
  | 'empty_body';

export interface OkfViolation {
  path: string;
  rule: OkfRule;
  message: string;
}

export interface OkfDuplicateGroup {
  title: string;
  paths: string[];
}

export interface OkfLintReport {
  /** Number of concept files checked. */
  filesChecked: number;
  violations: OkfViolation[];
  duplicates: OkfDuplicateGroup[];
}

const RESERVED = new Set(['index.md', 'log.md']);

/** Normalize a title for duplicate grouping (case/whitespace-insensitive). */
function normTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Lint already-loaded file contents. Pure function (no I/O) so tests can
 * exercise every rule directly.
 */
export function lintOkfFiles(files: { path: string; content: string }[]): OkfLintReport {
  const violations: OkfViolation[] = [];
  const titles = new Map<string, string[]>();
  let filesChecked = 0;

  for (const file of files) {
    if (RESERVED.has(path.basename(file.path))) continue;
    filesChecked++;

    let data: Record<string, unknown> = {};
    let body = file.content;
    if (!file.content.startsWith('---')) {
      violations.push({ path: file.path, rule: 'no_frontmatter', message: 'no YAML frontmatter block' });
    } else {
      try {
        const parsed = matter(file.content);
        data = (parsed.data ?? {}) as Record<string, unknown>;
        body = parsed.content;
      } catch {
        violations.push({ path: file.path, rule: 'invalid_frontmatter', message: 'frontmatter YAML is unparseable' });
      }
    }

    if (data.type === undefined) {
      violations.push({ path: file.path, rule: 'missing_type', message: 'required `type` field is missing' });
    } else if (typeof data.type !== 'string' || data.type.trim() === '') {
      violations.push({ path: file.path, rule: 'empty_type', message: '`type` field is empty or not a string' });
    }

    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) {
      violations.push({ path: file.path, rule: 'missing_title', message: 'recommended `title` field is missing' });
    } else {
      const key = normTitle(title);
      titles.set(key, [...(titles.get(key) ?? []), file.path]);
    }

    if (typeof data.description !== 'string' || data.description.trim() === '') {
      violations.push({ path: file.path, rule: 'missing_description', message: 'recommended `description` field is missing' });
    }

    if (body.trim() === '') {
      violations.push({ path: file.path, rule: 'empty_body', message: 'empty body — candidate for deletion or merge' });
    }
  }

  const duplicates: OkfDuplicateGroup[] = [...titles.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([title, paths]) => ({ title, paths: paths.sort() }))
    .sort((a, b) => a.title.localeCompare(b.title));

  return { filesChecked, violations, duplicates };
}

/** Read every .md file in the bundle and lint it. */
export async function lintBundle(bundle: BundleConfig): Promise<OkfLintReport> {
  const paths = await listMdFiles(bundle.path, '');
  const files = await Promise.all(
    paths.map(async (p) => ({
      path: p,
      content: await fs.readFile(path.join(bundle.path, p), 'utf8'),
    })),
  );
  return lintOkfFiles(files);
}

/** Render a report as a compact markdown list for the cleanup agent's prompt. */
export function formatOkfReport(report: OkfLintReport): string {
  if (report.violations.length === 0 && report.duplicates.length === 0) {
    return `Lint result: all ${report.filesChecked} concept files pass the structural checks. Review the bundle content yourself for organizational issues the linter cannot see.`;
  }
  const lines: string[] = [`Lint found issues across ${report.filesChecked} concept files:`];
  const byPath = new Map<string, string[]>();
  for (const v of report.violations) {
    byPath.set(v.path, [...(byPath.get(v.path) ?? []), v.message]);
  }
  for (const [p, msgs] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${p}: ${msgs.join('; ')}`);
  }
  for (const d of report.duplicates) {
    lines.push(`- duplicate title "${d.title}" in: ${d.paths.join(', ')}`);
  }
  return lines.join('\n');
}

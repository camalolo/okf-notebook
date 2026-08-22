/**
 * Document upload route: receives a file via multipart/form-data, hashes it
 * for dedup, extracts its content to markdown, and writes the result to
 * `{bundlePath}/uploads/{slug}.md`.
 *
 * The extracted markdown includes YAML frontmatter with provenance metadata
 * (source name, SHA-256 hash, type, upload date, page/char count). Dedup
 * is done by scanning existing `uploads/*.md` frontmatter for a matching hash.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import matter from 'gray-matter';
import { getBundle } from '../bundles.js';
import { resolveBundlePath } from '../bundles.js';
import { requireFull } from '../auth.js';
import { extractDocument } from '../lib/doc-extract.js';
import { chatCompletion } from '../lib/llm.js';
import { chatLogger, newTraceId, type ChatLogger } from '../lib/logger.js';

const UPLOAD_DIR = 'uploads';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a buffer. */
export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Generate a filesystem-safe slug from a filename, preserving Unicode chars.
 *  Replaces path separators and control chars, collapses runs of non-word
 *  chars (excluding CJK and letters) into a single dash. */
export function slugifyFilename(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return base
    .replace(/[/\\:*?"<>|]+/g, '-')   // path-unsafe chars → dash
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/\s+/g, '-')             // whitespace → dash
    .replace(/-+/g, '-')              // collapse runs of dashes
    .replace(/^-+|-+$/g, '')          // trim leading/trailing dashes
    || 'untitled';
}

/**
 * Scan `uploads/*.md` for a file whose frontmatter `hash` matches.
 * Returns the match info or null.
 */
export async function findDuplicate(
  uploadsDir: string,
  hash: string,
): Promise<{ filename: string; source: string; chars: number; pages?: number } | null> {
  const fullHash = `sha256:${hash}`;
  let files: string[];
  try {
    files = await fs.readdir(uploadsDir);
  } catch {
    return null; // Directory doesn't exist yet — no duplicates possible.
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = await fs.readFile(path.join(uploadsDir, file), 'utf8');
      const parsed = matter(raw);
      if (parsed.data.hash === fullHash) {
        return {
          filename: file,
          source: String(parsed.data.source ?? file),
          chars: Number(parsed.data.chars ?? 0),
          pages: typeof parsed.data.pages === 'number' ? parsed.data.pages : undefined,
        };
      }
    } catch {
      // Skip unparseable files.
    }
  }
  return null;
}

/** Resolve a unique filename if `{slug}.md` already exists (append -2, -3, …). */
async function uniqueSlug(uploadsDir: string, slug: string): Promise<string> {
  const candidate = `${slug}.md`;
  try {
    await fs.access(path.join(uploadsDir, candidate));
  } catch {
    return candidate; // Doesn't exist — use it.
  }
  let n = 2;
  while (true) {
    const name = `${slug}-${n}.md`;
    try {
      await fs.access(path.join(uploadsDir, name));
      n++;
    } catch {
      return name;
    }
  }
}

// ---------------------------------------------------------------------------
// Content-based naming (LLM)
// ---------------------------------------------------------------------------

/** Sanitize an LLM-proposed slug into a safe kebab-case filename stem. */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
      .replace(/\.md(?=[^a-z0-9]|$)/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Ask the LLM for a descriptive English kebab-case slug for an uploaded
 * document, based on its content (and original filename for identifiers).
 * Works for any document type — the model translates/abstracts the topic.
 * Returns null on any failure (caller falls back to the original filename).
 */
export async function llmContentSlug(
  filename: string,
  text: string,
  log?: ChatLogger,
  thinking?: 'off',
): Promise<string | null> {
  const system = [
    'You name uploaded documents for a knowledge base.',
    'Given a document, reply with ONLY a filename stem: 2-5 lowercase English words',
    'in kebab-case describing the document\u2019s subject/type.',
    'Rules:',
    '- Translate non-English topics to concise English (e.g. 學生會費 → student-union-fees).',
    '- If the original filename or content contains a meaningful identifier (invoice/bill',
    '  number, receipt number, ID, date), keep it as the final dash-separated segment.',
    '- Do NOT include the file extension, quotes, or any explanation — just the slug.',
    'Example: rpt101-9815819154900256.pdf about 學生會費 → student-union-fees-9815819154900256',
  ].join('\n');

  const user = [
    `Filename: ${filename}`,
    '',
    'Document content (truncated):',
    text.slice(0, 1500),
  ].join('\n');

  try {
    const t0 = Date.now();
    const result = await chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      undefined,
      {
        ...(thinking ? { thinking } : {}),
        log,
      },
    );
    const slug = sanitizeSlug(result.content);
    if (!slug) return null;
    log?.info(`Upload naming: "${filename}" → "${slug}" (${Date.now() - t0}ms)`);
    return slug;
  } catch (err) {
    log?.warn(`Upload naming: LLM failed for "${filename}" — using original filename (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

export interface UploadResult {
  mdPath: string;
  sourceName: string;
  duplicate: boolean;
  hash: string;
  chars: number;
  pages?: number;
}

/**
 * Core upload processing: hash → dedup → extract → LLM content naming → write.
 * Exported for testing (bypasses the HTTP layer).
 */
export async function processUpload(
  buffer: Buffer,
  filename: string,
  uploadsDir: string,
  log?: ChatLogger,
  /** Inherit the bundle's thinking setting for the LLM naming pass. */
  thinking?: 'off',
): Promise<UploadResult> {
  const hash = sha256(buffer);

  // Dedup check.
  const existing = await findDuplicate(uploadsDir, hash);
  if (existing) {
    return {
      mdPath: `${UPLOAD_DIR}/${existing.filename}`,
      // Use the current upload's filename, not the stale stored one.
      sourceName: filename,
      duplicate: true,
      hash,
      chars: existing.chars,
      pages: existing.pages,
    };
  }

  // Extract content.
  const extracted = await extractDocument(buffer, filename);

  // Ensure uploads directory exists.
  await fs.mkdir(uploadsDir, { recursive: true });

  // Prefer an LLM-generated, content-descriptive English slug; fall back to
  // the slugified original filename if the LLM is unavailable.
  const fallbackSlug = slugifyFilename(filename);
  const llmSlug = await llmContentSlug(filename, extracted.text, log, thinking);
  const slug = await uniqueSlug(uploadsDir, llmSlug ?? fallbackSlug);
  const outPath = path.join(uploadsDir, slug);

  const frontmatter: Record<string, unknown> = {
    source: filename,
    source_type: extracted.type,
    hash: `sha256:${hash}`,
    uploaded: new Date().toISOString(),
    chars: extracted.meta.chars,
  };
  if (extracted.meta.pages !== undefined) {
    frontmatter.pages = extracted.meta.pages;
  }
  if (extracted.meta.unsupported) {
    frontmatter.unsupported = true;
  }

  const content = matter.stringify(extracted.text || '(No text content extracted)', frontmatter);
  await fs.writeFile(outPath, content, 'utf8');

  return {
    mdPath: `${UPLOAD_DIR}/${slug}`,
    sourceName: filename,
    duplicate: false,
    hash,
    chars: extracted.meta.chars,
    pages: extracted.meta.pages,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post('/:bundleId/upload', requireFull, upload.single('file'), async (req, res, next) => {
  const log = chatLogger(newTraceId());
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided. Use multipart/form-data with a "file" field.' });
    }

    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const uploadsDir = resolveBundlePath(bundle.path, UPLOAD_DIR);
    // Multer decodes filenames as latin1; re-encode to UTF-8 so CJK/Unicode
    // filenames are preserved.
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const result = await processUpload(
      req.file.buffer,
      originalName,
      uploadsDir,
      log,
      // Inherit the bundle's thinking setting for the naming pass.
      bundle.thinking === 'on' ? undefined : 'off',
    );

    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;

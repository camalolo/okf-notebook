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

/** Generate a URL-safe slug from a filename (without extension). */
export function slugifyFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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

export interface UploadResult {
  mdPath: string;
  sourceName: string;
  duplicate: boolean;
  hash: string;
  chars: number;
  pages?: number;
}

/**
 * Core upload processing: hash → dedup → extract → write markdown.
 * Exported for testing (bypasses the HTTP layer).
 */
export async function processUpload(
  buffer: Buffer,
  filename: string,
  uploadsDir: string,
): Promise<UploadResult> {
  const hash = sha256(buffer);

  // Dedup check.
  const existing = await findDuplicate(uploadsDir, hash);
  if (existing) {
    return {
      mdPath: `${UPLOAD_DIR}/${existing.filename}`,
      sourceName: existing.source,
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

  // Write the extracted markdown with frontmatter.
  const slug = await uniqueSlug(uploadsDir, slugifyFilename(filename));
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
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided. Use multipart/form-data with a "file" field.' });
    }

    const bundle = await getBundle(req.params.bundleId);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const uploadsDir = resolveBundlePath(bundle.path, UPLOAD_DIR);
    const result = await processUpload(req.file.buffer, req.file.originalname, uploadsDir);

    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;

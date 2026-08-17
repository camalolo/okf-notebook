import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

// Mock tesseract.js — OCR engine is heavy WASM, not suitable for unit tests.
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({
      data: { text: 'MOCK OCR TEXT' },
    })),
    terminate: vi.fn(async () => {}),
  })),
}));
// Mock the LLM client — upload naming must be deterministic in tests (the
// real inference server runs on this host at 127.0.0.1:3003).
const llmChatCompletion = vi.fn();
vi.mock('../lib/llm.js', () => ({
  chatCompletion: (...args: unknown[]) => llmChatCompletion(...args),
}));

import { sha256, slugifyFilename, findDuplicate, processUpload, sanitizeSlug } from './upload.js';

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'notebook-upload-test-'));
}

beforeEach(async () => {
  tmpDir = await makeTmpDir();
  // Default: LLM unavailable → processUpload falls back to original filename.
  llmChatCompletion.mockReset().mockRejectedValue(new Error('LLM unavailable in tests'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

describe('sha256', () => {
  it('produces a stable hex digest', () => {
    const buf = Buffer.from('hello');
    const hash = sha256(buf);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(hash).toHaveLength(64); // 32 bytes = 64 hex chars
  });

  it('produces different digests for different content', () => {
    expect(sha256(Buffer.from('a'))).not.toBe(sha256(Buffer.from('b')));
  });
});

// ---------------------------------------------------------------------------
// slugifyFilename
// ---------------------------------------------------------------------------

describe('slugifyFilename', () => {
  it('replaces spaces and path-unsafe chars with dashes', () => {
    expect(slugifyFilename('Quarterly Report (Final).pdf')).toBe('Quarterly-Report-(Final)');
  });

  it('handles underscores and spaces', () => {
    expect(slugifyFilename('my_data file.docx')).toBe('my_data-file');
  });

  it('collapses runs of dashes', () => {
    expect(slugifyFilename('---weird---name---.txt')).toBe('weird-name');
  });

  it('falls back to "untitled" for empty slugs', () => {
    expect(slugifyFilename('   .pdf')).toBe('untitled');
  });

  it('preserves CJK characters', () => {
    expect(slugifyFilename('學生申請學費減免緩繳申請書.pdf')).toBe('學生申請學費減免緩繳申請書');
  });

  it('preserves accented characters', () => {
    expect(slugifyFilename('café résumé.pdf')).toBe('café-résumé');
  });

  it('replaces path-unsafe chars with dashes', () => {
    expect(slugifyFilename('report:name?.pdf')).toBe('report-name');
  });
});

// ---------------------------------------------------------------------------
// findDuplicate
// ---------------------------------------------------------------------------

describe('findDuplicate', () => {
  it('returns null when uploads dir does not exist', async () => {
    const result = await findDuplicate(path.join(tmpDir, 'nonexistent'), 'abc123');
    expect(result).toBeNull();
  });

  it('returns null when no files match', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'other.md'),
      matter.stringify('text', { hash: 'sha256:different' }),
    );
    const result = await findDuplicate(tmpDir, 'abc123');
    expect(result).toBeNull();
  });

  it('finds a matching file by hash', async () => {
    const hash = 'abc123def';
    await fs.writeFile(
      path.join(tmpDir, 'report.md'),
      matter.stringify('extracted text', {
        source: 'report.pdf',
        hash: `sha256:${hash}`,
        chars: 100,
      }),
    );
    const result = await findDuplicate(tmpDir, hash);
    expect(result).toEqual({
      filename: 'report.md',
      source: 'report.pdf',
      chars: 100,
      pages: undefined,
    });
  });

  it('skips non-markdown files', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'just text');
    const result = await findDuplicate(tmpDir, 'anyhash');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processUpload
// ---------------------------------------------------------------------------

describe('processUpload', () => {
  it('writes a new markdown file with correct frontmatter', async () => {
    const content = 'Hello, world!';
    const buf = Buffer.from(content);
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(buf, 'greeting.txt', uploadsDir);

    expect(result.duplicate).toBe(false);
    expect(result.sourceName).toBe('greeting.txt');
    expect(result.mdPath).toBe('uploads/greeting.md');
    expect(result.hash).toBe(sha256(buf));
    expect(result.chars).toBe(content.length);

    // Verify the file on disk.
    const written = await fs.readFile(path.join(uploadsDir, 'greeting.md'), 'utf8');
    const parsed = matter(written);
    expect(parsed.data.source).toBe('greeting.txt');
    expect(parsed.data.source_type).toBe('txt');
    expect(parsed.data.hash).toBe(`sha256:${sha256(buf)}`);
    expect(parsed.data.chars).toBe(content.length);
    expect(parsed.content.trim()).toBe(content);
  });

  it('detects and returns existing file on duplicate upload', async () => {
    const content = 'Same content';
    const buf = Buffer.from(content);
    const uploadsDir = path.join(tmpDir, 'uploads');

    // First upload.
    const first = await processUpload(buf, 'original.txt', uploadsDir);
    expect(first.duplicate).toBe(false);

    // Second upload of the same content.
    const second = await processUpload(buf, 'different-name.txt', uploadsDir);
    expect(second.duplicate).toBe(true);
    expect(second.mdPath).toBe(first.mdPath);
    expect(second.sourceName).toBe('different-name.txt');
    expect(second.hash).toBe(first.hash);

    // Ensure only one file was written.
    const files = await fs.readdir(uploadsDir);
    expect(files).toHaveLength(1);
  });

  it('creates the uploads directory if it does not exist', async () => {
    const uploadsDir = path.join(tmpDir, 'nested', 'deep', 'uploads');
    const result = await processUpload(Buffer.from('test'), 'file.txt', uploadsDir);
    expect(result.duplicate).toBe(false);

    const stat = await fs.stat(uploadsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('handles name collisions with -2, -3 suffixes', async () => {
    const uploadsDir = path.join(tmpDir, 'uploads');

    // Two different files that slugify to the same name.
    const r1 = await processUpload(Buffer.from('content A'), 'report.txt', uploadsDir);
    const r2 = await processUpload(Buffer.from('content B'), 'report.txt', uploadsDir);

    expect(r1.mdPath).toBe('uploads/report.md');
    expect(r2.mdPath).toBe('uploads/report-2.md');
  });

  it('routes image uploads through OCR extraction', async () => {
    const uploadsDir = path.join(tmpDir, 'uploads');
    const binaryData = Buffer.alloc(256, 0xab);

    const result = await processUpload(binaryData, 'image.png', uploadsDir);

    expect(result.duplicate).toBe(false);
    expect(result.chars).toBe('MOCK OCR TEXT'.length);
    const written = await fs.readFile(path.join(uploadsDir, 'image.md'), 'utf8');
    const parsed = matter(written);
    expect(parsed.data.source_type).toBe('png');
    expect(parsed.content.trim()).toBe('MOCK OCR TEXT');
  });

  it('preserves CSV data as a markdown table', async () => {
    const csv = 'Name,Age\nAlice,30';
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(Buffer.from(csv), 'contacts.csv', uploadsDir);

    expect(result.duplicate).toBe(false);
    const written = await fs.readFile(path.join(uploadsDir, 'contacts.md'), 'utf8');
    const parsed = matter(written);
    expect(parsed.content).toContain('| Name | Age |');
    expect(parsed.content).toContain('| Alice | 30 |');
  });
});

// ---------------------------------------------------------------------------
// sanitizeSlug
// ---------------------------------------------------------------------------

describe('sanitizeSlug', () => {
  it('lowercases and kebab-cases a clean slug', () => {
    expect(sanitizeSlug('Student-Union-Fees')).toBe('student-union-fees');
  });

  it('strips junk, quotes, and surrounding prose', () => {
    expect(sanitizeSlug('"electricity-bill-2026.md"')).toBe('electricity-bill-2026');
  });

  it('collapses runs of invalid chars into single dashes', () => {
    // Non-ASCII is dropped entirely (LLM is told to answer in English);
    // leading/trailing dashes are trimmed.
    expect(sanitizeSlug('報名表!! & 健檢+++form')).toBe('form');
  });

  it('truncates to 60 chars without a trailing dash', () => {
    const out = sanitizeSlug('a'.repeat(80));
    expect(out).toHaveLength(60);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns empty string for pure junk', () => {
    expect(sanitizeSlug('===?!?')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// LLM content-based naming
// ---------------------------------------------------------------------------

describe('LLM content naming', () => {
  it('uses the LLM-provided slug for the output filename', async () => {
    llmChatCompletion.mockResolvedValue({
      content: 'student-union-fees-9815819154900256',
      tool_calls: undefined,
    });
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(
      Buffer.from('學生會費繳費單'),
      'rpt101-9815819154900256.txt',
      uploadsDir,
    );

    expect(result.mdPath).toBe('uploads/student-union-fees-9815819154900256.md');
    // Provenance preserved: original filename in frontmatter.
    const written = await fs.readFile(
      path.join(uploadsDir, 'student-union-fees-9815819154900256.md'),
      'utf8',
    );
    const parsed = matter(written);
    expect(parsed.data.source).toBe('rpt101-9815819154900256.txt');
  });

  it('sanitizes a messy LLM response', async () => {
    llmChatCompletion.mockResolvedValue({
      content: '  "Electricity Bill — August 2026"  ',
      tool_calls: undefined,
    });
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(Buffer.from(' August electricity '), 'bill.csv', uploadsDir);

    expect(result.mdPath).toBe('uploads/electricity-bill-august-2026.md');
  });

  it('falls back to the original filename when the LLM fails', async () => {
    llmChatCompletion.mockRejectedValue(new Error('upstream 429'));
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(Buffer.from('hello'), 'my-report.txt', uploadsDir);

    expect(result.mdPath).toBe('uploads/my-report.md');
  });

  it('falls back when the LLM returns only junk', async () => {
    llmChatCompletion.mockResolvedValue({ content: '###?!', tool_calls: undefined });
    const uploadsDir = path.join(tmpDir, 'uploads');

    const result = await processUpload(Buffer.from('hello'), 'my-report.txt', uploadsDir);

    expect(result.mdPath).toBe('uploads/my-report.md');
  });

  it('does not call the LLM for duplicate uploads (short-circuit)', async () => {
    const uploadsDir = path.join(tmpDir, 'uploads');
    await processUpload(Buffer.from('same content'), 'doc.txt', uploadsDir);
    llmChatCompletion.mockClear();

    const dup = await processUpload(Buffer.from('same content'), 'renamed-copy.txt', uploadsDir);

    expect(dup.duplicate).toBe(true);
    expect(llmChatCompletion).not.toHaveBeenCalled();
    // Points at the previously-written file, not a new one.
    expect(dup.mdPath).toBe('uploads/doc.md');
  });
});

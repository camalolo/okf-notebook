import { describe, it, expect, vi } from 'vitest';
import { extractDocument, detectType } from './doc-extract.js';

// Mock tesseract.js — OCR engine is heavy WASM, not suitable for unit tests.
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({
      data: { text: 'MOCK OCR TEXT' },
    })),
    terminate: vi.fn(async () => {}),
  })),
}));

// Mock word-extractor — binary .doc parsing needs real fixtures.
vi.mock('word-extractor', () => ({
  default: class MockExtractor {
    extract(_buf: Buffer) {
      return Promise.resolve({
        getBody: () => 'Mock DOC body text',
      });
    }
  },
}));

describe('detectType', () => {
  it('extracts lowercase extension without dot', () => {
    expect(detectType('report.pdf')).toBe('pdf');
    expect(detectType('data.CSV')).toBe('csv');
  });

  it('returns "unknown" for files without extension', () => {
    expect(detectType('README')).toBe('unknown');
  });
});

describe('extractDocument — plaintext', () => {
  it('extracts .txt files as-is', async () => {
    const buf = Buffer.from('Hello world\nLine 2');
    const result = await extractDocument(buf, 'notes.txt');
    expect(result.text).toBe('Hello world\nLine 2');
    expect(result.type).toBe('txt');
    expect(result.meta.chars).toBe(18);
    expect(result.meta.unsupported).toBeUndefined();
  });

  it('extracts .md files as-is', async () => {
    const buf = Buffer.from('# Title\n\nSome **bold** text.');
    const result = await extractDocument(buf, 'doc.md');
    expect(result.text).toBe('# Title\n\nSome **bold** text.');
    expect(result.type).toBe('md');
  });
});

describe('extractDocument — CSV', () => {
  it('converts simple CSV to a GFM table', async () => {
    const csv = 'Name,Age,City\nAlice,30,Taipei\nBob,25,Tokyo';
    const result = await extractDocument(Buffer.from(csv), 'data.csv');
    expect(result.type).toBe('csv');
    expect(result.text).toContain('| Name | Age | City |');
    expect(result.text).toContain('| --- | --- | --- |');
    expect(result.text).toContain('| Alice | 30 | Taipei |');
    expect(result.text).toContain('| Bob | 25 | Tokyo |');
  });

  it('handles quoted fields with commas', async () => {
    const csv = 'Name,Note\n"Smith, John","Hello, world"';
    const result = await extractDocument(Buffer.from(csv), 'quoted.csv');
    expect(result.text).toContain('| Smith, John | Hello, world |');
  });

  it('handles escaped double-quotes inside quoted fields', async () => {
    const csv = 'Text\n"He said ""hi"" loudly"';
    const result = await extractDocument(Buffer.from(csv), 'escaped.csv');
    expect(result.text).toContain('He said "hi" loudly');
  });
});

describe('extractDocument — HTML', () => {
  it('converts HTML headings and paragraphs to markdown', async () => {
    const html = '<h1>Title</h1><p>Hello <strong>world</strong>.</p>';
    const result = await extractDocument(Buffer.from(html), 'page.html');
    expect(result.type).toBe('html');
    expect(result.text).toContain('# Title');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('**world**');
  });

  it('converts HTML lists', async () => {
    const html = '<ul><li>One</li><li>Two</li></ul>';
    const result = await extractDocument(Buffer.from(html), 'list.html');
    // turndown uses "-   item" format
    expect(result.text).toMatch(/-\s+One/);
    expect(result.text).toMatch(/-\s+Two/);
  });
});

describe('extractDocument — JSON', () => {
  it('wraps valid JSON in a code block', async () => {
    const json = '{"key": "value", "n": 42}';
    const result = await extractDocument(Buffer.from(json), 'data.json');
    expect(result.type).toBe('json');
    expect(result.text).toContain('```json');
    expect(result.text).toContain('"key": "value"');
    expect(result.text).toContain('"n": 42');
  });

  it('wraps invalid JSON raw in a code block', async () => {
    const result = await extractDocument(Buffer.from('{broken'), 'bad.json');
    expect(result.text).toContain('```json');
    expect(result.text).toContain('{broken');
  });
});

describe('extractDocument — .doc (legacy Word)', () => {
  it('extracts text from binary .doc files', async () => {
    const fakeDoc = Buffer.alloc(256, 0);
    const result = await extractDocument(fakeDoc, 'report.doc');
    expect(result.type).toBe('doc');
    expect(result.text).toBe('Mock DOC body text');
    expect(result.meta.chars).toBe('Mock DOC body text'.length);
  });
});

describe('extractDocument — unsupported types', () => {
  it('returns a metadata stub for unknown extensions', async () => {
    const result = await extractDocument(Buffer.from('data'), 'archive.xyz');
    expect(result.type).toBe('xyz');
    expect(result.meta.unsupported).toBe(true);
  });

  it('handles files with no extension', async () => {
    const result = await extractDocument(Buffer.from('data'), 'Makefile');
    expect(result.type).toBe('unknown');
    expect(result.meta.unsupported).toBe(true);
  });
});

describe('extractDocument — images (OCR)', () => {
  // Generate a minimal 1x1 transparent PNG.
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  // tesseract.js is mocked (see top of file) — it always returns "MOCK OCR TEXT".
  // These tests verify routing, not actual OCR accuracy.

  it('routes .png through OCR and returns extracted text', async () => {
    const result = await extractDocument(TINY_PNG, 'photo.png');
    expect(result.type).toBe('png');
    expect(result.text).toBe('MOCK OCR TEXT');
    expect(result.meta.chars).toBe('MOCK OCR TEXT'.length);
    expect(result.meta.unsupported).toBe(false);
  });

  it('handles .jpg extension', async () => {
    const result = await extractDocument(TINY_PNG, 'scan.jpg');
    expect(result.type).toBe('jpg');
    expect(result.text).toBe('MOCK OCR TEXT');
  });

  it('handles .jpeg extension', async () => {
    const result = await extractDocument(TINY_PNG, 'photo.jpeg');
    expect(result.type).toBe('jpeg');
  });

  it('handles .gif extension', async () => {
    const result = await extractDocument(TINY_PNG, 'anim.gif');
    expect(result.type).toBe('gif');
  });

  it('handles .webp extension', async () => {
    const result = await extractDocument(TINY_PNG, 'img.webp');
    expect(result.type).toBe('webp');
  });

  it('handles .bmp extension', async () => {
    const result = await extractDocument(TINY_PNG, 'raw.bmp');
    expect(result.type).toBe('bmp');
  });

  it('gracefully handles OCR failure', async () => {
    // Temporarily make createWorker throw.
    const { createWorker } = await import('tesseract.js');
    vi.mocked(createWorker).mockRejectedValueOnce(new Error('WASM missing'));

    const result = await extractDocument(TINY_PNG, 'broken.png');
    expect(result.type).toBe('png');
    expect(result.meta.unsupported).toBe(true);
    expect(result.meta.chars).toBe(0);

    // Restore mock.
    vi.mocked(createWorker).mockResolvedValueOnce({
      recognize: vi.fn(async () => ({ data: { text: 'MOCK OCR TEXT' } })),
      terminate: vi.fn(async () => {}),
    });
  });
});

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
    extract() {
      return Promise.resolve({
        getBody: () => 'Mock DOC body text',
      });
    }
  },
}));

// Mock jszip for ODT — returns a fake content.xml.
vi.mock('jszip', () => ({
  default: {
    loadAsync: vi.fn(async () => ({
      file: (name: string) => name === 'content.xml'
        ? { async: () => Promise.resolve(
            '<text:h outline-level="2">Title</text:h>' +
            '<text:p>Hello <text:span>world</text:span>.</text:p>' +
            '<text:list-item><text:p>Item 1</text:p></text:list-item>' +
            '<text:list-item><text:p>Item 2</text:p></text:list-item>'
          ) }
        : null,
    })),
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

describe('extractDocument — .odt (OpenDocument)', () => {
  it('extracts headings, paragraphs, and list items', async () => {
    const result = await extractDocument(Buffer.from('fake-zip'), 'doc.odt');
    expect(result.type).toBe('odt');
    expect(result.text).toContain('## Title');
    expect(result.text).toContain('Hello world.');
    expect(result.text).toContain('- Item 1');
    expect(result.text).toContain('- Item 2');
    expect(result.meta.chars).toBeGreaterThan(0);
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

describe('extractDocument — MHTML', () => {
  // Minimal 1x1 transparent PNG, padded past the embedded-image OCR threshold
  // (real page images are large; tiny buffers are treated as icons and skipped).
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const BIG_PNG_A = Buffer.concat([TINY_PNG, Buffer.alloc(4200, 0)]);
  const BIG_PNG_B = Buffer.concat([TINY_PNG, Buffer.alloc(4200, 1)]);

  const BOUNDARY = '----MultipartBoundary--testboundary----';

  /** Quoted-printable encode a UTF-8 string (=XX for specials/non-ASCII). */
  const toQp = (s: string): string =>
    Array.from(Buffer.from(s, 'utf8'))
      .map((b) => (b > 126 || b === 61 ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b)))
      .join('');

  const b64 = (buf: Buffer): string => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

  /** Build an MHTML file from raw part strings (delimiter lines included). */
  function buildMhtml(topHeaders: string[], parts: string[]): Buffer {
    const body = parts.join(`\r\n--${BOUNDARY}\r\n`);
    const head = [
      'MIME-Version: 1.0',
      ...topHeaders,
      `Content-Type: multipart/related; type="text/html"; boundary="${BOUNDARY}"`,
      '',
      '',
    ].join('\r\n');
    return Buffer.from(`${head}--${BOUNDARY}\r\n${body}\r\n--${BOUNDARY}--\r\n`);
  }

  const htmlQp = toQp(
    '<html><head><title>Test Product 頁面</title><style>.a{color:red}</style>' +
      '<script>var tracked = "should-not-appear";</script></head><body>' +
      '<h1>Hello 價格</h1><img src="img/banner.png" alt="banner">' +
      '<table><tr><th>Spec</th><th>Value</th></tr><tr><td>CPU</td><td>Ryzen 7</td></tr></table>' +
      '</body></html>',
  );
  // Insert a soft line break between two encoded chars to verify QP joining.
  const htmlQpWithSoftBreak =
    htmlQp.slice(0, 20) + '=\r\n' + htmlQp.slice(20);
  // 前後 split across a soft break: if the break were left in place the text
  // would decode as `前=\r\n後` instead of the contiguous 前後.
  const softBreakQp = toQp('前') + '=\r\n' + toQp('後');
  const softBreakPart = [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    toQp('<html><body><p>') + softBreakQp + toQp('</p></body></html>'),
    '',
  ].join('\r\n');

  const htmlPart = [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://example.com/product/123',
    '',
    htmlQpWithSoftBreak,
    '',
  ].join('\r\n');

  const pngPart = (name: string, buf: Buffer): string =>
    [
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      `Content-Location: https://img.example.com/${encodeURIComponent(name)}`,
      '',
      b64(buf),
      '',
    ].join('\r\n');

  it('extracts the main HTML part: title, QP-decoded CJK, GFM table, noise stripped', async () => {
    const result = await extractDocument(
      buildMhtml(['Snapshot-Content-Location: https://example.com/product/123'], [htmlPart]),
      'page.mhtml',
    );
    expect(result.type).toBe('mhtml');
    expect(result.meta.unsupported).toBeUndefined();
    expect(result.text).toContain('# Test Product 頁面');
    expect(result.text).toContain('Hello 價格');
    expect(result.text).toContain('Source: https://example.com/product/123');
    // Soft line break joined, hex-encoded CJK decoded.
    expect(result.text).not.toContain('=E5=83=B9');
    expect(result.text).not.toContain('=3D');
    // GFM table conversion.
    expect(result.text).toMatch(/\|\s*Spec\s*\|\s*Value\s*\|/);
    expect(result.text).toMatch(/\|\s*CPU\s*\|\s*Ryzen 7\s*\|/);
    // Script/style/img noise removed (OCR of images is handled separately).
    expect(result.text).not.toContain('should-not-appear');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('![');
  });

  it('OCRs unique embedded images (deduped, icons skipped) with one shared worker', async () => {
    const parts = [
      htmlPart,
      pngPart('spec-chart.png', BIG_PNG_A),
      pngPart('spec-chart-copy.png', BIG_PNG_A), // duplicate content → skipped
      pngPart('banner.jpg', BIG_PNG_B),
      // Icon-sized image (below threshold) → skipped entirely.
      'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n' +
        `Content-Location: https://img.example.com/icon.png\r\n\r\n${b64(TINY_PNG)}\r\n`,
    ];
    const result = await extractDocument(buildMhtml([], parts), 'page.mhtml');

    expect(result.text).toContain('## Embedded images (OCR)');
    expect(result.text).toContain('### spec-chart.png');
    expect(result.text).toContain('### banner.jpg');
    expect(result.text).not.toContain('spec-chart-copy');
    expect(result.text).not.toContain('icon.png');
    // Exactly two unique images OCR'd.
    expect(result.text.match(/MOCK OCR TEXT/g)).toHaveLength(2);
    // No OCR section when there are no usable images.
    const noImages = await extractDocument(buildMhtml([], [htmlPart]), 'page.mhtml');
    expect(noImages.text).not.toContain('Embedded images');
  });

  it('routes .mht extension too', async () => {
    const result = await extractDocument(
      buildMhtml([], [htmlPart]),
      'page.mht',
    );
    expect(result.type).toBe('mhtml');
    expect(result.text).toContain('Hello 價格');
  });

  it('joins quoted-printable soft line breaks across a character', async () => {
    const result = await extractDocument(buildMhtml([], [softBreakPart]), 'soft.mhtml');
    expect(result.text).toContain('前後');
  });

  it('falls back to whole-file HTML when the file is not multipart', async () => {
    const result = await extractDocument(
      Buffer.from('<html><head><title>Solo</title></head><body><p>Plain body</p></body></html>'),
      'page.mhtml',
    );
    expect(result.type).toBe('mhtml');
    expect(result.text).toContain('# Solo');
    expect(result.text).toContain('Plain body');
  });

  it('keeps markdown-only output when OCR is unavailable', async () => {
    const { createWorker } = await import('tesseract.js');
    vi.mocked(createWorker).mockRejectedValueOnce(new Error('WASM missing'));

    const result = await extractDocument(
      buildMhtml([], [htmlPart, pngPart('spec-chart.png', BIG_PNG_A)]),
      'page.mhtml',
    );
    expect(result.text).toContain('Hello 價格');
    expect(result.text).not.toContain('Embedded images');
  });
});

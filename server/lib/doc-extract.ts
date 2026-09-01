/**
 * Document extraction: converts uploaded binary/text files into markdown text.
 *
 * Each extractor returns an {@link ExtractionResult} with the extracted text,
 * the detected source type label, and metadata (page count, char count).
 *
 * Supported types: .txt .md .csv .html .json .pdf .docx .odt .doc .png .jpg .jpeg
 * .gif .bmp .webp .mhtml/.mht (web page snapshots: main HTML → markdown, embedded
 * images OCR'd).
 * Unsupported types (binaries) get a metadata stub.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export interface ExtractionResult {
  /** Extracted markdown text (empty string for unsupported types). */
  text: string;
  /** Source file type label (e.g. 'pdf', 'docx', 'txt'). */
  type: string;
  /** Metadata about the extraction. */
  meta: {
    pages?: number;
    rows?: number;
    chars: number;
    /** True when no text could be extracted (binary/unknown type). */
    unsupported?: boolean;
  };
}

/** Detect the source file type from filename extension. */
export function detectType(filename: string): string {
  return path.extname(filename).toLowerCase().slice(1) || 'unknown';
}

/** Extract document content as markdown text. Dispatches by file extension. */
export async function extractDocument(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.txt':
    case '.md':
    case '.markdown':
      return extractPlaintext(buffer, ext.slice(1));

    case '.csv':
      return extractCsv(buffer);

    case '.html':
    case '.htm':
      return extractHtml(buffer);

    case '.mhtml':
    case '.mht':
      return extractMhtml(buffer);

    case '.json':
      return extractJson(buffer);

    case '.pdf':
      return extractPdf(buffer);

    case '.docx':
      return extractDocx(buffer);

    case '.doc':
      return extractDoc(buffer);

    case '.odt':
      return extractOdt(buffer);

    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.bmp':
    case '.webp':
      return extractImage(buffer, ext.slice(1));

    default:
      return {
        text: '',
        type: ext.slice(1) || 'unknown',
        meta: { chars: 0, unsupported: true },
      };
  }
}

// ---------------------------------------------------------------------------
// Individual extractors
// ---------------------------------------------------------------------------

function extractPlaintext(buffer: Buffer, type: string): ExtractionResult {
  const text = buffer.toString('utf8');
  return { text, type, meta: { chars: text.length } };
}

function extractCsv(buffer: Buffer): ExtractionResult {
  const text = buffer.toString('utf8');
  const rows = parseCsv(text);
  const markdown = rowsToMarkdownTable(rows);
  return {
    text: markdown,
    type: 'csv',
    meta: { chars: markdown.length, rows: rows.length },
  };
}

function extractHtml(buffer: Buffer): ExtractionResult {
  const html = buffer.toString('utf8');
  const markdown = htmlToMarkdown(html);
  return { text: markdown, type: 'html', meta: { chars: markdown.length } };
}

function extractJson(buffer: Buffer): ExtractionResult {
  const raw = buffer.toString('utf8');
  let text: string;
  try {
    const parsed = JSON.parse(raw);
    text = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
  } catch {
    // Not valid JSON — output raw in a code block.
    text = '```json\n' + raw + '\n```';
  }
  return { text, type: 'json', meta: { chars: text.length } };
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return {
    text: text.trim(),
    type: 'pdf',
    meta: { pages: totalPages, chars: text.length },
  };
}

async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer });
  const markdown = htmlToMarkdown(result.value);
  return {
    text: markdown,
    type: 'docx',
    meta: { chars: markdown.length },
  };
}

/** Extract text from legacy binary .doc files (Word 97-2003). */
async function extractDoc(buffer: Buffer): Promise<ExtractionResult> {
  const WordExtractor = (await import('word-extractor')).default;
  const we = new WordExtractor();
  const doc = await we.extract(buffer);
  const text = doc.getBody().trim();
  return {
    text,
    type: 'doc',
    meta: { chars: text.length },
  };
}

/**
 * Extract text from OpenDocument Text (.odt) files.
 * ODT is a ZIP archive; content.xml holds the document body as XML
 * with text nodes in <text:p> elements. We parse those out and
 * convert basic structure to markdown.
 */
async function extractOdt(buffer: Buffer): Promise<ExtractionResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    return { text: '', type: 'odt', meta: { chars: 0, unsupported: true } };
  }
  const xml = await contentFile.async('string');
  const text = odtXmlToText(xml);
  return {
    text: text.trim(),
    type: 'odt',
    meta: { chars: text.length },
  };
}

/**
 * Convert ODT content.xml to plain text with basic markdown structure.
 * Extracts text from <text:p> (paragraphs) and <text:h> (headings) nodes.
 */
function odtXmlToText(xml: string): string {
  // Insert newlines between block elements, then strip all tags.
  let out = xml;
  // Headings: <text:h> → "# " prefix based on outline-level
  out = out.replace(/<text:h[^>]*outline-level="(\d)"[^>]*>([\s\S]*?)<\/text:h>/g,
    (_, level, content) => `${'#'.repeat(Number(level))} ${stripTags(content)}\n`);
  out = out.replace(/<text:h[^>]*>([\s\S]*?)<\/text:h>/g, (_, content) => `# ${stripTags(content)}\n`);
  // Paragraphs → newline-separated
  out = out.replace(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g, (_, content) => `${stripTags(content)}\n`);
  // Tab stops
  out = out.replace(/<text:tab[^>]*\/>/g, '\t');
  // Line breaks
  out = out.replace(/<text:line-break[^>]*\/>/g, '\n');
  // List items
  out = out.replace(/<text:list-item[^>]*>([\s\S]*?)<\/text:list-item>/g, (_, content) => `- ${stripTags(content).trim()}\n`);
  // Remove all remaining tags
  out = stripTags(out);
  // Clean up excessive blank lines
  out = out.replace(/\n{3,}/g, '\n\n');
  // Decode XML entities
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return out.trim();
}

/** Remove all XML tags from a string. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/**
 * OCR extraction for images using tesseract.js (lazy-loaded WASM).
 * Loads English + Simplified Chinese + Traditional Chinese language data.
 * First call downloads the trained data (~30MB total) — cached afterward.
 * Falls back to a metadata stub if OCR finds no text or fails.
 */
async function extractImage(buffer: Buffer, type: string): Promise<ExtractionResult> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(['eng', 'chi_sim', 'chi_tra']);
    const { data } = await worker.recognize(buffer);
    await worker.terminate();
    const text = data.text.trim();
    return {
      text,
      type,
      meta: { chars: text.length, unsupported: text.length === 0 },
    };
  } catch {
    // OCR failed (e.g. WASM unavailable, corrupt image) — return stub.
    return {
      text: '',
      type,
      meta: { chars: 0, unsupported: true },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal CSV parser that handles quoted fields with embedded commas,
 * newlines, and escaped double-quotes.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        // Skip — handled by \n
      } else {
        field += ch;
      }
    }
  }
  // Flush the last field/row (if file doesn't end with newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Convert an array of string rows into a GFM markdown table. */
function rowsToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const headers = rows[0];
  const separator = headers.map(() => '---');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Convert an HTML string to Markdown using turndown (with GFM table rules). */
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(gfm);
  return td.turndown(html);
}

// ---------------------------------------------------------------------------
// MHTML (.mhtml/.mht) — multipart MIME web-page snapshots
// ---------------------------------------------------------------------------

/** A decoded leaf MIME part (non-multipart). */
interface MimePart {
  /** Lowercased media type, e.g. 'text/html', 'image/png'. */
  contentType: string;
  /** Charset from the Content-Type header, if any. */
  charset?: string;
  /** Transfer-decoded body bytes. */
  body: Buffer;
  /** Content-Location / Content-ID URL, if any. */
  location?: string;
}

/** Parse a header block into a Map (keys lowercased, folded lines joined). */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Unfold continuation lines (start with space/tab) into the previous header.
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return headers;
}

interface ParsedContentType {
  type: string;
  params: Map<string, string>;
}

/** Parse a Content-Type header value into media type + parameters. */
function parseContentType(value: string | undefined): ParsedContentType {
  const params = new Map<string, string>();
  if (!value) return { type: 'text/plain', params };
  const segments = value.split(';');
  const type = (segments.shift() ?? 'text/plain').trim().toLowerCase();
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    params.set(key, val);
  }
  return { type, params };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a multipart body into raw (still header-encoded) segment strings at
 * its boundary delimiter lines. Handles both CRLF and LF line endings; the
 * preamble and epilogue are dropped.
 */
export function splitMultipart(bodyText: string, boundary: string): string[] {
  const re = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*\\r?(?:\\n|$)`, 'g');
  const segments: string[] = [];
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bodyText)) !== null) {
    if (start >= 0) segments.push(bodyText.slice(start, match.index));
    start = match.index + match[0].length;
    if (match[1]) break; // closing `--boundary--` delimiter
  }
  return segments;
}

/** Decode a body per its Content-Transfer-Encoding (byte-preserving). */
function decodeTransferEncoding(bodyText: string, encoding: string): Buffer {
  switch (encoding) {
    case 'base64':
      return Buffer.from(bodyText.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable': {
      // Soft line breaks (`=` at end of line) join the surrounding lines.
      const cleaned = bodyText.replace(/=\r?\n/g, '');
      const bytes: number[] = [];
      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '=') {
          const hex = cleaned.slice(i + 1, i + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            i += 2;
            continue;
          }
        }
        bytes.push(cleaned.charCodeAt(i) & 0xff);
      }
      return Buffer.from(bytes);
    }
    default: // 7bit / 8bit / binary / unknown — bytes as-is.
      return Buffer.from(bodyText, 'latin1');
  }
}

/** Decode bytes to text using the part's charset (falls back to UTF-8). */
function decodeTextBytes(buf: Buffer, charset?: string): string {
  if (!charset) return buf.toString('utf8');
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Recursively collect leaf (non-multipart) MIME parts from a raw segment.
 * Nested multipart bodies (e.g. multipart/alternative inside related) are
 * flattened into `out` in document order.
 */
function collectLeafParts(raw: string, out: MimePart[]): void {
  const split = /(?:\r?\n){2}/.exec(raw);
  const headerBlock = split ? raw.slice(0, split.index) : raw;
  const bodyText = split ? raw.slice(split.index + split[0].length) : '';
  const headers = parseHeaders(headerBlock);
  const ct = parseContentType(headers.get('content-type'));

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.get('boundary');
    if (!boundary) return;
    for (const seg of splitMultipart(bodyText, boundary)) {
      collectLeafParts(seg, out);
    }
    return;
  }

  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  out.push({
    contentType: ct.type,
    charset: ct.params.get('charset'),
    body: decodeTransferEncoding(bodyText, encoding),
    location: headers.get('content-location') ?? headers.get('content-id') ?? undefined,
  });
}

/** Decode minimal HTML entities for title/label text. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Extract the page `<title>` text, or '' when absent.
 */
function extractHtmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return decodeHtmlEntities(m[1].replace(/\s+/g, ' ')).trim();
}

/** Strip elements whose content is noise for markdown extraction. */
function stripNoiseElements(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, '');
}

/** OCR tuning for embedded MHTML images. */
const MHTML_MAX_OCR_IMAGES = 20;
const MHTML_MIN_IMAGE_BYTES = 4096;

/**
 * Convert MHTML to markdown: the main HTML part becomes markdown (GFM tables),
 * preceded by the snapshot URL, and unique embedded images (deduped by content
 * hash, tiny icons skipped) are OCR'd and appended as labelled sections.
 */
async function extractMhtml(buffer: Buffer): Promise<ExtractionResult> {
  const raw = buffer.toString('latin1');
  const split = /(?:\r?\n){2}/.exec(raw);
  const topHeaders = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const bodyText = split ? raw.slice(split.index + split[0].length) : '';
  const topType = parseContentType(topHeaders.get('content-type'));

  const parts: MimePart[] = [];
  const boundary = topType.params.get('boundary');
  if (topType.type.startsWith('multipart/') && boundary) {
    for (const seg of splitMultipart(bodyText, boundary)) {
      collectLeafParts(seg, parts);
    }
  } else {
    // Not actually multipart — treat the whole file as one HTML document.
    parts.push({ contentType: 'text/html', charset: topType.params.get('charset'), body: buffer });
  }

  let markdown = '';

  const htmlPart = parts.find((p) => p.contentType === 'text/html');
  if (htmlPart) {
    const html = decodeTextBytes(htmlPart.body, htmlPart.charset);
    const title = extractHtmlTitle(html);
    const body = htmlToMarkdown(stripNoiseElements(html)).trim();
    if (title) markdown += `# ${title}\n\n`;
    markdown += body;
  } else {
    const plainPart = parts.find((p) => p.contentType === 'text/plain');
    if (plainPart) {
      markdown = decodeTextBytes(plainPart.body, plainPart.charset).trim();
    }
  }

  const snapshotUrl = topHeaders.get('snapshot-content-location');
  if (snapshotUrl) markdown = `Source: ${snapshotUrl}\n\n${markdown}`;

  const ocrSection = await ocrMhtmlImages(parts);
  if (ocrSection) markdown += `\n\n${ocrSection}`;

  return { text: markdown.trim(), type: 'mhtml', meta: { chars: markdown.length } };
}

/** Short human label for an embedded image section heading. */
function imagePartLabel(part: MimePart, index: number): string {
  if (part.location) {
    // Use the last path segment, stripped of query string, percent/ent-decoded.
    const base = part.location.split(/[?#]/)[0].split('/').pop() ?? '';
    if (base) {
      let decoded = base;
      try {
        decoded = decodeURIComponent(base);
      } catch {
        // Malformed percent-encoding — keep the raw segment.
      }
      decoded = decodeHtmlEntities(decoded).trim();
      if (decoded) return decoded.slice(0, 80);
    }
  }
  return `image-${index + 1}`;
}

/**
 * OCR unique embedded image parts with a single shared tesseract worker.
 * Skips duplicates (same content hash) and tiny icons; per-image failures are
 * skipped silently. Returns a markdown section, or '' when nothing usable.
 */
async function ocrMhtmlImages(parts: MimePart[]): Promise<string> {
  const seen = new Set<string>();
  const candidates: { part: MimePart; label: string }[] = [];
  for (const part of parts) {
    if (!part.contentType.startsWith('image/')) continue;
    if (part.body.length < MHTML_MIN_IMAGE_BYTES) continue;
    const hash = crypto.createHash('sha256').update(part.body).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (candidates.length >= MHTML_MAX_OCR_IMAGES) continue;
    candidates.push({ part, label: imagePartLabel(part, candidates.length) });
  }
  if (candidates.length === 0) return '';

  const lines: string[] = ['## Embedded images (OCR)', ''];
  let worker: { recognize: (b: Buffer) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(['eng', 'chi_sim', 'chi_tra']);
  } catch {
    return ''; // OCR unavailable — keep the markdown-only extraction.
  }
  try {
    for (const { part, label } of candidates) {
      try {
        const { data } = await worker.recognize(part.body);
        const text = data.text.trim();
        if (text.length < 2) continue; // Blank / decorative image.
        lines.push(`### ${label}`, '', text, '');
      } catch {
        // Undecodable image format — skip it.
      }
    }
  } finally {
    try {
      await worker.terminate();
    } catch {
      // Ignore termination errors.
    }
  }
  return lines.length > 2 ? lines.join('\n').trimEnd() : '';
}

/**
 * Document extraction: converts uploaded binary/text files into markdown text.
 *
 * Each extractor returns an {@link ExtractionResult} with the extracted text,
 * the detected source type label, and metadata (page count, char count).
 *
 * Supported types: .txt .md .csv .html .json .pdf .docx .png .jpg .jpeg .gif .bmp .webp
 * Unsupported types (binaries) get a metadata stub.
 */
import path from 'node:path';
import TurndownService from 'turndown';

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

/** Convert an HTML string to Markdown using turndown. */
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  return td.turndown(html);
}

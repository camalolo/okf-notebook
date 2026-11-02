/**
 * Vision-based text extraction: sends an image directly to a multimodal LLM
 * and asks for a faithful transcription — the high-quality alternative to
 * tesseract.js OCR for scans/photos of documents (receipts, forms, tables),
 * where tesseract historically garbles CJK spacing, mixes Simplified/
 * Traditional script, and drops whole table structures.
 *
 * Used only when the configured model advertises image input on /models
 * (`modelSupportsImageInput()`); otherwise callers fall back to tesseract.
 */

import { chatCompletion, modelSupportsImageInput, type ChatContentPart } from './llm.js';
import type { ChatLogger } from './logger.js';

/** File extensions doc-extract routes through the image extractor → MIME. */
export function imageMimeFromExt(ext: string): string | null {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * Transcription prompt. Deliberately strict: the failure modes we are fixing
 * (from the Tucson dealer-estimate upload, 2026-11) were dropped table
 * structures, script conversion, and numbers drifting away from their row
 * labels — so exactness beats fluency here.
 */
export const VISION_EXTRACT_PROMPT = [
  'You are a high-accuracy OCR engine. Transcribe ALL text visible in this image.',
  '',
  'Rules:',
  '- Transcribe exactly, in the original language and script. NEVER convert',
  '  between Simplified and Traditional Chinese, never translate, never',
  '  "correct" spelling or grammar.',
  '- Preserve the reading order and the document\u2019s structure: headings,',
  '  field labels with their values on one line ("Label: value").',
  '- Tables: transcribe as GitHub-flavored markdown tables, keeping every cell',
  '  in its own row/column. Each amount/number stays on the same row as its',
  '  label — never merge, split, or reorder rows or columns.',
  '- Numbers: copy exactly as printed (currency symbols, thousand separators,',
  '  decimals, leading zeros).',
  '- Text you cannot read confidently: write [illegible] in its place — never',
  '  guess. A short transcription beats an invented one.',
  '- Ignore pure image artifacts (watermarks, page stains) but keep stamps,',
  '  signatures annotations and handwritten notes, marked as such.',
  '- Output ONLY the transcription — no commentary, no preamble, no code fences.',
].join('\n');

export interface VisionExtractOptions {
  /** Disable extended thinking (fast extraction — this is not a reasoning task). */
  thinking?: 'off';
  log?: ChatLogger;
}

/**
 * Send an image to the configured multimodal model and return its
 * transcription, or null on any failure (caller falls back to tesseract OCR).
 */
export async function visionExtractText(
  buffer: Buffer,
  mime: string,
  opts?: VisionExtractOptions,
): Promise<string | null> {
  if (!(await modelSupportsImageInput())) return null;

  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const parts: ChatContentPart[] = [
    { type: 'text', text: VISION_EXTRACT_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];

  try {
    const t0 = Date.now();
    const result = await chatCompletion(
      [{ role: 'user', content: parts }],
      undefined,
      { thinking: opts?.thinking ?? 'off', log: opts?.log },
    );
    const text = result.content.trim();
    if (!text) {
      opts?.log?.warn(`Vision extract: model returned empty transcription (${Date.now() - t0}ms)`);
      return null;
    }
    opts?.log?.info(
      `Vision extract: ${Math.round(buffer.length / 1024)}KB ${mime} → ${text.length} chars ` +
      `(${Date.now() - t0}ms, ${result.usage?.promptTokens ?? '?'}p/${result.usage?.completionTokens ?? '?'}c)`,
    );
    return text;
  } catch (err) {
    opts?.log?.warn(
      `Vision extract failed — falling back to tesseract (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

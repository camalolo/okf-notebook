import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the LLM client — vision extraction must be deterministic in tests.
const llmChatCompletion = vi.fn();
const modelSupportsImageInputMock = vi.fn();
vi.mock('./llm.js', () => ({
  chatCompletion: (...args: unknown[]) => llmChatCompletion(...args),
  modelSupportsImageInput: (...args: unknown[]) => modelSupportsImageInputMock(...args),
}));

import { visionExtractText, imageMimeFromExt, VISION_EXTRACT_PROMPT } from './vision-ocr.js';

beforeEach(() => {
  llmChatCompletion.mockReset();
  modelSupportsImageInputMock.mockReset().mockResolvedValue(true);
});

describe('imageMimeFromExt', () => {
  it('maps upload image extensions to MIME types', () => {
    expect(imageMimeFromExt('png')).toBe('image/png');
    expect(imageMimeFromExt('jpg')).toBe('image/jpeg');
    expect(imageMimeFromExt('jpeg')).toBe('image/jpeg');
    expect(imageMimeFromExt('gif')).toBe('image/gif');
    expect(imageMimeFromExt('bmp')).toBe('image/bmp');
    expect(imageMimeFromExt('webp')).toBe('image/webp');
  });

  it('returns null for non-image extensions (with or without dot)', () => {
    expect(imageMimeFromExt('pdf')).toBeNull();
    expect(imageMimeFromExt('.txt')).toBeNull();
    expect(imageMimeFromExt('')).toBeNull();
  });
});

describe('visionExtractText', () => {
  it('returns null without calling the LLM when the model has no image input', async () => {
    modelSupportsImageInputMock.mockResolvedValue(false);
    const result = await visionExtractText(Buffer.from('img'), 'image/png');
    expect(result).toBeNull();
    expect(llmChatCompletion).not.toHaveBeenCalled();
  });

  it('sends the image as a base64 data URL plus the transcription prompt', async () => {
    llmChatCompletion.mockResolvedValue({ content: '  預約估價單  ' });
    const buf = Buffer.from('fake-image-bytes');
    const result = await visionExtractText(buf, 'image/jpeg');

    expect(result).toBe('預約估價單'); // trimmed
    expect(llmChatCompletion).toHaveBeenCalledTimes(1);
    const [messages, tools, opts] = llmChatCompletion.mock.calls[0];
    expect(tools).toBeUndefined();
    expect(opts.thinking).toBe('off');

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const parts = messages[0].content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: VISION_EXTRACT_PROMPT });
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].image_url.url).toBe(
      `data:image/jpeg;base64,${buf.toString('base64')}`,
    );
  });

  it('returns null when the LLM call fails (caller falls back to tesseract)', async () => {
    llmChatCompletion.mockRejectedValue(new Error('upstream 500'));
    const result = await visionExtractText(Buffer.from('img'), 'image/png');
    expect(result).toBeNull();
  });

  it('returns null on empty transcription', async () => {
    llmChatCompletion.mockResolvedValue({ content: '   \n  ' });
    const result = await visionExtractText(Buffer.from('img'), 'image/png');
    expect(result).toBeNull();
  });
});

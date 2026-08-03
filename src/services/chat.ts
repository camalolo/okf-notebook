import type { ChatMessage } from '../types.ts';

export interface ChatSSEEvent {
  event: string;
  data: unknown;
}

/**
 * Parse a single SSE event block (the text between two blank lines) into a
 * structured `{ event, data }` object. Returns `null` when the block carries
 * no data payload (e.g. keep-alive comments).
 */
function parseEvent(block: string): ChatSSEEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;

  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // Not JSON — keep the raw string.
  }

  return { event, data };
}

/**
 * Stream a chat conversation from the backend as Server-Sent Events.
 *
 * Sends the full message history via POST and yields parsed SSE events as they
 * arrive. The response body is consumed as a `ReadableStream` and buffered so
 * that events split across network chunks are reassembled correctly.
 */
export async function* streamChat(
  bundleId: string,
  messages: ChatMessage[],
  chatId?: string | null,
  signal?: AbortSignal,
): AsyncGenerator<ChatSSEEvent> {
  const res = await fetch(
    `/api/notebook/bundles/${encodeURIComponent(bundleId)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, chatId: chatId ?? undefined }),
      signal,
    },
  );

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'string') {
          message = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.error === 'string') message = obj.error;
          else if (typeof obj.message === 'string') message = obj.message;
        }
      } catch {
        message = text;
      }
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF line endings so `\r\n\r\n` terminators are handled.
      buffer = buffer.replace(/\r\n/g, '\n');

      const parts = buffer.split('\n\n');
      // The final element never had a trailing terminator — keep buffering it.
      buffer = parts.pop() ?? '';

      for (const block of parts) {
        const parsed = parseEvent(block);
        if (parsed) yield parsed;
      }
    }

    // Flush the decoder and any trailing event that lacked a final blank line.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.trim()) {
      const parsed = parseEvent(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

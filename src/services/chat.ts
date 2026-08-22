import type { ChatMessage } from '../types.ts';
import { redirectToLogin } from './api.ts';

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
 *
 * All SSE events are logged to the browser console for debugging (especially
 * when the LLM produces no visible response). Set `localStorage.debug = 'chat'`
 * for verbose per-event logging.
 */
const CHAT_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('debug')?.includes('chat');

function logChat(level: 'log' | 'warn' | 'error', msg: string, ...args: unknown[]) {
  const fn = level === 'log' ? console.log : level === 'warn' ? console.warn : console.error;
  fn(`%c[chat]`, 'color: #6b8cff; font-weight: bold', msg, ...args);
}

export async function* streamChat(
  bundleId: string,
  messages: ChatMessage[],
  chatId?: string | null,
  signal?: AbortSignal,
  opts?: { resume?: boolean },
): AsyncGenerator<ChatSSEEvent> {
  logChat('log', `→ POST /bundles/${bundleId}/chat (${messages.length} msgs, chatId=${chatId ?? 'none'}${opts?.resume ? ', resume' : ''})`);

  const res = await fetch(
    `/api/notebook/bundles/${encodeURIComponent(bundleId)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        chatId: chatId ?? undefined,
        ...(opts?.resume ? { resume: true } : {}),
      }),
      signal,
    },
  );

  if (!res.ok || !res.body) {
    if (res.status === 401) {
      redirectToLogin();
      throw new Error('Session expired');
    }
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
    logChat('error', `← HTTP ${res.status}: ${message}`);
    throw new Error(message);
  }

  logChat('log', `← SSE stream open (HTTP ${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  let sawDone = false;
  let sawError = false;

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
        if (parsed) {
          eventCount++;
          if (parsed.event === 'done') sawDone = true;
          if (parsed.event === 'error') sawError = true;
          if (CHAT_DEBUG) {
            const summary = typeof parsed.data === 'object' && parsed.data
              ? JSON.stringify(parsed.data).slice(0, 120)
              : String(parsed.data).slice(0, 120);
            logChat('log', `  event #${eventCount}: ${parsed.event} ${summary}`);
          }
          yield parsed;
        }
      }
    }

    // Flush the decoder and any trailing event that lacked a final blank line.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.trim()) {
      const parsed = parseEvent(buffer);
      if (parsed) {
        eventCount++;
        if (parsed.event === 'done') sawDone = true;
        if (parsed.event === 'error') sawError = true;
        if (CHAT_DEBUG) logChat('log', `  event #${eventCount} (flushed): ${parsed.event}`);
        yield parsed;
      }
    }

    // Log how the stream ended — critical for debugging "LLM didn't answer"
    if (sawError) {
      logChat('error', `← Stream ended with ERROR (${eventCount} events received)`);
    } else if (sawDone) {
      logChat('log', `← Stream ended normally (${eventCount} events)`);
    } else {
      logChat('warn', `← Stream ended WITHOUT done/error event (${eventCount} events) — possible server crash or connection drop`);
    }
  } finally {
    reader.releaseLock();
  }
}

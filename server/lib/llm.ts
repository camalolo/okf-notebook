/**
 * LLM client for the inference server's OpenRouter-style routed endpoint.
 *
 * All requests go to POST /api/v1/chat/completions with a logical model name
 * (e.g. glm-5.2); the inference server picks the provider (zai first, deepseek
 * as paid fallback) with automatic failover on 429/5xx and a circuit breaker.
 * Model lists come from /api/v1/models (everything routable).
 *
 * Authentication: client API key (`Authorization: Bearer ik-...`) from the
 * INFERENCE_API_KEY env var. The inference server is on the same host and LAN
 * requests bypass auth, but we send the key anyway so this also works the day
 * the LAN bypass is disabled, and so requests are attributed per-key in the
 * proxy's stats.
 *
 * Uses Node 22 native fetch (globalThis.fetch).
 */

import { Agent } from 'undici';
import type { ChatLogger } from './logger.js';
import { getSettings } from '../settings.js';

// --- Endpoints ---------------------------------------------------------------

const V1_URL = 'http://127.0.0.1:3003/api/v1/chat/completions';
const MODELS_URL = 'http://127.0.0.1:3003/api/v1/models';

/** Client API key for the inference server (see Admin → API Keys). */
const API_KEY = process.env.INFERENCE_API_KEY ?? '';

function authHeaders(): Record<string, string> {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

// undici's default bodyTimeout is 300s of *idle* time on the response body.
// GLM can "think" for longer than that between SSE chunks, which kills the
// stream mid-turn with `TypeError: terminated` (see chat route logs
// 2026-08-16: stream active ~3min, then exactly 300s of silence → abort).
// 0 disables the idle timeout entirely; user-initiated aborts still work via
// the AbortSignal, so there is no hang risk beyond the client's patience.
const llmAgent = new Agent({ bodyTimeout: 0 });

// --- Types ------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionResult {
  content: string;
  tool_calls?: ToolCall[];
}

// --- Model selection ---------------------------------------------------------

interface ZaiModelsResponse {
  data?: { id?: string }[];
}

let modelsCache: { at: number; models: string[] } | null = null;
const MODELS_TTL_MS = 5 * 60 * 1000;

/**
 * List the models officially available on the Z.ai API (via the inference
 * proxy's `/models` passthrough — free, consumes no tokens). Cached for 5
 * minutes; on a refresh failure the stale list is returned if one exists.
 *
 * The proxy's model list includes its whole routable catalog (e.g. OpenRouter
 * imports). This picker is curated to the GLM/DeepSeek families so the UI
 * stays usable and spend stays on the intended providers; any other routable
 * model can still be entered manually in Settings.
 */
export async function listModels(log?: ChatLogger): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.models;
  }
  const res = await fetch(MODELS_URL, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (modelsCache) {
      log?.warn(`Models list refresh failed (${res.status}) — serving stale cache`);
      return modelsCache.models;
    }
    throw new Error(`Models request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as ZaiModelsResponse;
  const models = (data.data ?? [])
    .map((m) => m.id ?? '')
    .filter(Boolean)
    // Curated: GLM family + the cheap DeepSeek tiers. Auto-imported entries
    // (e.g. deepseek-v4-*) are deliberately excluded until vetted/priced —
    // they stay routable by explicit request but aren't offered in the UI.
    .filter((id) => /^(glm-|deepseek-(chat|reasoner)$)/.test(id))
    .sort();
  if (models.length === 0) {
    if (modelsCache) return modelsCache.models;
    throw new Error('Models response contained no models');
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

// --- Chat completion --------------------------------------------------------

interface ZaiChoice {
  message: {
    role: string;
    content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface ZaiResponse {
  choices?: ZaiChoice[];
  error?: { message?: string } | string;
}

/**
 * Send a chat completion request to the Z.ai proxy and return the complete
 * result.
 *
 * NOTE: implemented on top of the streaming endpoint. The upstream rejects
 * non-streaming requests (`stream: false`) with HTTP 429 code 1305 — observed
 * 2026-08-17: 55/55 streaming calls succeeded while 0/4 non-streaming did.
 * Deltas are simply discarded; only the accumulated result is returned.
 *
 * @param messages  Conversation history (without a leading system prompt is
 *                  fine — caller may include it).
 * @param tools     Optional function-calling tool definitions.
 * @returns The assistant message's content and any tool calls.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  log?: ChatLogger,
): Promise<ChatCompletionResult> {
  return chatCompletionStream(messages, tools, () => {}, undefined, log);
}

// --- Retry / backoff --------------------------------------------------------

/** Transient upstream failures worth retrying: 429 rate limit + 5xx. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const MAX_RETRIES = 3; // 1 initial attempt + 3 retries
const RETRY_BASE_MS = 1_000; // backoff: ~1s, 2s, 4s (with jitter)
const RETRY_MAX_MS = 30_000;

/** Parse a `Retry-After` header (delta-seconds form), clamped to the cap. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs < 0) return null; // HTTP-date form → fall back to backoff
  return Math.min(secs * 1000, RETRY_MAX_MS);
}

/** Exponential backoff with ±30% jitter, so concurrent callers desync. */
function backoffMs(attempt: number): number {
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.min(Math.round(RETRY_BASE_MS * 2 ** attempt * jitter), RETRY_MAX_MS);
}

/** Sleep that rejects promptly if the signal aborts (STOP button). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// --- Streaming chat completion -----------------------------------------------

interface ZaiStreamDelta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface ZaiStreamChunk {
  choices?: { delta?: ZaiStreamDelta; finish_reason?: string }[];
  error?: { message?: string } | string;
}

/**
 * Streaming variant of {@link chatCompletion}.
 *
 * Calls the Z.ai proxy with `stream: true` and invokes `onDelta` for each
 * content token as it arrives. Tool-call fragments are accumulated across
 * chunks and returned in the final result. The caller decides what to do with
 * tool calls (execute them, feed results back, and call again).
 *
 * @param messages  Conversation history.
 * @param tools     Optional tool definitions.
 * @param onDelta   Called for each streamed content chunk.
 * @returns The full accumulated content and any tool calls.
 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  log?: ChatLogger,
): Promise<ChatCompletionResult> {
  const { model } = await getSettings();

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  log?.info(`Streaming request: ${messages.length} msgs, ${tools?.length ?? 0} tools, model ${model}`);
  const t0 = Date.now();

  // Transient failures (429 after all route candidates are exhausted, 5xx)
  // are retried with backoff. Safe point: nothing has been streamed to the
  // caller yet, so a retry can't duplicate content. Once the SSE body
  // starts, errors are NOT retried.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(V1_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
      dispatcher: llmAgent,
    } as unknown as RequestInit);

    if (res.ok) break;

    const text = await res.text().catch(() => '');

    if (attempt < MAX_RETRIES && isRetryableStatus(res.status) && !signal?.aborted) {
      const waitMs = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt);
      log?.warn(
        `Streaming: HTTP ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — ` +
        `retrying in ${waitMs}ms: ${text.slice(0, 200)}`,
      );
      await sleep(waitMs, signal); // abort during the wait rejects → AbortError propagates
      continue;
    }

    log?.error(`Streaming: HTTP ${res.status} (${Date.now() - t0}ms): ${text.slice(0, 300)}`);
    throw new Error(`Inference request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.body) {
    log?.error('Streaming: response has no body');
    throw new Error('Z.ai streaming response has no body');
  }

  log?.debug(`Streaming: connection open (${Date.now() - t0}ms), reading SSE stream`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let chunkCount = 0;
  let dataLineCount = 0;
  let parseFailCount = 0;
  let firstContentMs = 0;
  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      chunkCount++;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; lines within an event end with \n.
      // Each data line starts with "data: ".
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last partial line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // comment/keepalive
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        dataLineCount++;

        let chunk: ZaiStreamChunk;
        try {
          chunk = JSON.parse(payload) as ZaiStreamChunk;
        } catch {
          parseFailCount++;
          continue; // skip malformed
        }

        if (chunk.error) {
          const msg =
            typeof chunk.error === 'string'
              ? chunk.error
              : chunk.error.message ?? 'Unknown error';
          log?.error(`Streaming: API error in chunk: ${msg}`);
          throw new Error(`Z.ai API error: ${msg}`);
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          if (!firstContentMs) firstContentMs = Date.now() - t0;
          content += delta.content;
          onDelta(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing =
              toolCallMap.get(tc.index) ??
              { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments)
              existing.arguments += tc.function.arguments;
            toolCallMap.set(tc.index, existing);
          }
        }
      }
    }

    // Flush decoder.
    buffer += decoder.decode();
    if (buffer.trim().startsWith('data: ')) {
      const payload = buffer.trim().slice(6);
      if (payload !== '[DONE]') {
        dataLineCount++;
        try {
          const chunk = JSON.parse(payload) as ZaiStreamChunk;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onDelta(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing =
                toolCallMap.get(tc.index) ??
                { id: '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments)
                existing.arguments += tc.function.arguments;
              toolCallMap.set(tc.index, existing);
            }
          }
        } catch {
          parseFailCount++;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  let tool_calls: ToolCall[] | undefined;
  if (toolCallMap.size > 0) {
    tool_calls = Array.from(toolCallMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.arguments },
      }));
  }

  const elapsed = Date.now() - t0;

  if (content.trim() && !tool_calls) {
    log?.info(
      `Stream complete (${elapsed}ms): ${content.length} chars content` +
      ` | ${chunkCount} chunks, ${dataLineCount} data lines, ${parseFailCount} parse failures` +
      (firstContentMs ? `, first token ${firstContentMs}ms` : ''),
    );
  } else if (tool_calls) {
    log?.info(
      `Stream complete (${elapsed}ms): ${tool_calls.length} tool call(s): ${tool_calls.map(t => t.function.name).join(', ')}` +
      ` | ${chunkCount} chunks, ${dataLineCount} data lines, ${parseFailCount} parse failures`,
    );
  } else {
    // ⚠️ Empty response — no content, no tool calls. This is the most likely
    // cause of "the LLM didn't answer" — the upstream returned nothing useful.
    log?.warn(
      `Stream complete but EMPTY (${elapsed}ms): 0 chars, no tool calls` +
      ` | ${chunkCount} chunks, ${dataLineCount} data lines, ${parseFailCount} parse failures` +
      ' — possible proxy error or empty upstream response',
    );
  }

  return { content, tool_calls };
}

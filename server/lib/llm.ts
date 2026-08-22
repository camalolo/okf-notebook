/**
 * LLM client for any OpenAI-compatible chat-completions API.
 *
 * All requests go to POST {LLM_BASE_URL}/chat/completions with a model name;
 * the default endpoint is an OpenRouter-style routing proxy. Model lists come
 * from {LLM_BASE_URL}/models.
 *
 * Configuration (env vars):
 *   LLM_BASE_URL   Base URL up to (and including) the version segment, without
 *                  a trailing slash. Default: http://127.0.0.1:3003/api/v1
 *                  (a local inference proxy). Works with any OpenAI-compatible
 *                  server: Z.ai (…/api/paas/v4), OpenAI (https://api.openai.com/v1),
 *                  OpenRouter (https://openrouter.ai/api/v1), Ollama
 *                  (http://localhost:11434/v1), LM Studio, vLLM, etc.
 *   LLM_API_KEY    Bearer token (`Authorization: Bearer …`). Legacy alias:
 *                  INFERENCE_API_KEY (still honored).
 *   LLM_MODEL      Default model id until changed in Settings (default: glm-5.2).
 *   LLM_MODELS_FILTER  Optional regex; when set, the Settings model dropdown
 *                  only offers matching ids (e.g. `^(glm-|deepseek-(chat|reasoner)$)`
 *                  to stay on curated providers behind a routing proxy).
 *
 * Uses Node 22 native fetch (globalThis.fetch).
 */

import { Agent } from 'undici';
import type { ChatLogger } from './logger.js';
import { getSettings } from '../settings.js';

// --- Endpoints ---------------------------------------------------------------

/** Base URL of the OpenAI-compatible API (no trailing slash). */
const BASE_URL = (process.env.LLM_BASE_URL || 'http://127.0.0.1:3003/api/v1').replace(/\/+$/, '');

const V1_URL = `${BASE_URL}/chat/completions`;
const MODELS_URL = `${BASE_URL}/models`;

/** Bearer API key for the LLM endpoint (LLM_API_KEY; legacy: INFERENCE_API_KEY). */
const API_KEY = process.env.LLM_API_KEY || process.env.INFERENCE_API_KEY || '';

/** Optional regex filtering which model ids the Settings dropdown offers. */
const MODELS_FILTER = process.env.LLM_MODELS_FILTER
  ? new RegExp(process.env.LLM_MODELS_FILTER)
  : null;

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

/** Exact token usage from the API (final SSE chunk, include_usage). */
export interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  /** Thinking-model reasoning tokens (subset of completion). */
  reasoningTokens?: number;
  /** Prompt tokens served from the provider's cache, when reported. */
  cachedTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  tool_calls?: ToolCall[];
  /** Usage of this call, when the endpoint reported it (include_usage). */
  usage?: UsageStats;
}

// --- Model selection ---------------------------------------------------------

interface ModelsResponse {
  data?: { id?: string }[];
}

let modelsCache: { at: number; models: string[] } | null = null;
const MODELS_TTL_MS = 5 * 60 * 1000;

/**
 * List the models offered by the configured endpoint (`/models` — free,
 * consumes no tokens). Cached for 5 minutes; on a refresh failure the stale
 * list is returned if one exists.
 *
 * Behind a routing proxy the model list can include the proxy's whole
 * routable catalog. Set LLM_MODELS_FILTER (regex) to restrict the Settings
 * dropdown to the families you actually want to spend on; any other model id
 * can still be entered manually in Settings.
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
  const data = (await res.json()) as ModelsResponse;
  const models = (data.data ?? [])
    .map((m) => m.id ?? '')
    .filter(Boolean)
    .filter((id) => !MODELS_FILTER || MODELS_FILTER.test(id))
    .sort();
  if (models.length === 0) {
    if (modelsCache) return modelsCache.models;
    throw new Error('Models response contained no models');
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

// --- Chat completion --------------------------------------------------------

/**
 * Send a chat completion request to the LLM API and return the complete
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
  return chatCompletionStream(messages, tools, { onDelta: () => {}, log });
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

interface StreamDelta {
  content?: string;
  /** Chain-of-thought from thinking models (GLM) — distinct from content. */
  reasoning_content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string }[];
  error?: { message?: string } | string;
  /** Present on the final chunk when stream_options.include_usage is set. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * Streaming variant of {@link chatCompletion}.
 *
 * Calls the LLM API with `stream: true` and invokes `onDelta` for each
 * content token as it arrives. Thinking models additionally stream their
 * chain-of-thought as `reasoning_content` deltas — forwarded via
 * `onThinking` (never mixed into `content`, never resent to the API).
 * Tool-call fragments are accumulated across chunks and returned in the
 * final result. The caller decides what to do with tool calls (execute
 * them, feed results back, and call again).
 */
export interface StreamOptions {
  /** Called for each streamed content chunk. */
  onDelta: (text: string) => void;
  /**
   * Called for each reasoning/chain-of-thought chunk (`reasoning_content`
   * deltas, emitted by thinking models before the visible answer). Optional.
   */
  onThinking?: (text: string) => void;
  /** Abort signal (STOP button, upstream shutdown). */
  signal?: AbortSignal;
  /** Logger. */
  log?: ChatLogger;
}

export async function chatCompletionStream(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  opts: StreamOptions,
): Promise<ChatCompletionResult> {
  const { onDelta, onThinking, signal, log } = opts;
  const { model } = await getSettings();

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // Exact per-call usage in the final chunk (prompt/completion/reasoning).
    stream_options: { include_usage: true },
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
    throw new Error('LLM streaming response has no body');
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
  let reasoningChars = 0;
  let usage: UsageStats | undefined;
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

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
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
          throw new Error(`LLM API error: ${msg}`);
        }

        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          };
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          reasoningChars += delta.reasoning_content.length;
          onThinking?.(delta.reasoning_content);
        }

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
          const chunk = JSON.parse(payload) as StreamChunk;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            onThinking?.(delta.reasoning_content);
          }
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
  // Reasoning summary for the log line (empty for non-thinking models).
  const rs = reasoningChars > 0 ? `, ${reasoningChars} reasoning chars` : '';
  const us = usage
    ? `, usage p${usage.promptTokens ?? '?'}/c${usage.completionTokens ?? '?'}${usage.reasoningTokens ? ` (r${usage.reasoningTokens})` : ''}`
    : '';

  if (content.trim() && !tool_calls) {
    log?.info(
      `Stream complete (${elapsed}ms): ${content.length} chars content` +
      ` | ${chunkCount} chunks, ${dataLineCount} data lines, ${parseFailCount} parse failures` +
      (firstContentMs ? `, first token ${firstContentMs}ms` : '') + rs + us,
    );
  } else if (tool_calls) {
    log?.info(
      `Stream complete (${elapsed}ms): ${tool_calls.length} tool call(s): ${tool_calls.map(t => t.function.name).join(', ')}` +
      ` | ${chunkCount} chunks, ${dataLineCount} data lines, ${parseFailCount} parse failures` + rs + us,
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

  return { content, tool_calls, usage };
}

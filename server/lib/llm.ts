/**
 * LLM client for the Z.ai GLM API, accessed through a local PHP proxy.
 *
 * The proxy requires an `X-API-Token` header. Tokens are fetched from
 * `https://example.com/api/token` (IP-bound, expire in 5 min) and cached
 * until 30s before expiry. Uses Node 22 native fetch (globalThis.fetch).
 */

// --- Token management -------------------------------------------------------

const TOKEN_URL = 'https://example.com/api/token';
const ZAI_URL = 'https://example.com/api/zai';
const MODEL = 'glm-5.2';

const COMMON_HEADERS = {
  Origin: 'https://example.com',
  Referer: 'https://example.com/',
};

let cachedToken: string | null = null;
let tokenExpiry = 0;

interface TokenResponse {
  token: string;
  expires: number; // Unix timestamp (seconds)
}

/** Fetch a fresh token from the proxy, caching it until 30s before expiry. */
async function getToken(): Promise<string> {
  // Reuse cached token if it's still valid (with a 30s safety margin).
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiry - now > 30) {
    return cachedToken;
  }

  const res = await fetch(TOKEN_URL, { headers: COMMON_HEADERS });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as TokenResponse;
  cachedToken = data.token;
  tokenExpiry = data.expires;
  return cachedToken;
}

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
 * Send a chat completion request to the Z.ai proxy.
 *
 * @param messages  Conversation history (without a leading system prompt is
 *                  fine — caller may include it).
 * @param tools     Optional function-calling tool definitions.
 * @returns The assistant message's content and any tool calls.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<ChatCompletionResult> {
  const token = await getToken();

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(ZAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Token': token,
      ...COMMON_HEADERS,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Invalidate cached token on auth errors so the next call re-fetches.
    if (res.status === 401 || res.status === 403) {
      cachedToken = null;
    }
    throw new Error(`Z.ai request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as ZaiResponse;

  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message ?? 'Unknown error';
    throw new Error(`Z.ai API error: ${msg}`);
  }

  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error('Z.ai response missing choices[0].message');
  }

  return {
    content: message.content ?? '',
    tool_calls: message.tool_calls,
  };
}

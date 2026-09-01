import type { BundleConfig, TreeNode, FileContent, ChatSummary, ChatSession, ChatMessage, StoredEvent, DigestConfig } from '../types.ts';

const API_BASE = '/api/notebook';

/** Redirect to login on auth failure. Called from request() and streamChat(). */
export function redirectToLogin(): void {
  if (window.location.pathname !== '/') {
    window.location.href = '/?auth_expired=1';
  }
}

/** Read the response body once and try to surface a meaningful error message. */
async function extractError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.error === 'string') return obj.error;
        if (typeof obj.message === 'string') return obj.message;
      }
    } catch {
      return text;
    }
  }
  return `${res.status} ${res.statusText}`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(await extractError(res));
  }
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

function jsonOptions(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Encode a slash-delimited path while preserving the separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function getBundles(): Promise<BundleConfig[]> {
  return request<BundleConfig[]>(`${API_BASE}/bundles`);
}

export async function getBundleTree(id: string): Promise<TreeNode> {
  const nodes = await request<TreeNode[]>(`${API_BASE}/bundles/${encodeURIComponent(id)}/tree`);
  // Wrap the array in a synthetic root node so FileTree can use node.children.
  return { name: 'root', path: '', type: 'directory', children: nodes };
}

export function addBundle(data: {
  name: string;
  path: string;
  icon?: string;
  description?: string;
  allowedUsers?: string[];
}): Promise<BundleConfig> {
  return request<BundleConfig>(
    `${API_BASE}/bundles`,
    jsonOptions(data),
  );
}

export function updateBundle(
  id: string,
  data: {
    name?: string;
    icon?: string;
    description?: string;
    allowedUsers?: string[];
    mcps?: string[];
    thinking?: 'off' | 'on';
    digest?: DigestConfig;
  },
): Promise<BundleConfig> {
  return request<BundleConfig>(`${API_BASE}/bundles/${encodeURIComponent(id)}`, {
    ...jsonOptions(data),
    method: 'PATCH',
  });
}

export function removeBundle(id: string): Promise<void> {
  return request<void>(`${API_BASE}/bundles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function readFile(bundleId: string, filePath: string): Promise<FileContent> {
  return request<FileContent>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files/${encodePath(filePath)}`,
  );
}

/** Overwrite an existing file's raw contents. */
export function updateFileRaw(bundleId: string, filePath: string, raw: string): Promise<void> {
  return request<void>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files/${encodePath(filePath)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    },
  );
}

/** Create a new file with the given path and raw contents. */
export function createFileRaw(bundleId: string, filePath: string, raw: string): Promise<void> {
  return request<void>(`${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, raw }),
  });
}

/** Delete a file. */
export function deleteFileRaw(bundleId: string, filePath: string): Promise<void> {
  return request<void>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files/${encodePath(filePath)}`,
    { method: 'DELETE' },
  );
}

/* --- Chat persistence --- */

/**
 * Explicitly abort the active server-side turn for a chat (STOP button).
 * Aborting the SSE fetch alone no longer stops the turn — the server keeps
 * working through client disconnects, so stopping requires this call.
 * Resolves when the abort was delivered; 404 (no active turn) is tolerated.
 */
export async function abortChat(bundleId: string, chatId: string): Promise<void> {
  try {
    await request<void>(
      `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/chat/abort`,
      jsonOptions({ chatId }),
    );
  } catch (err) {
    // No active turn (already finished) or transient network failure —
    // either way the server-side turn will end on its own.
    if (err instanceof Error && err.message === 'Session expired') throw err;
  }
}

export function listChats(bundleId: string): Promise<ChatSummary[]> {
  return request<ChatSummary[]>(`${API_BASE}/chats/${encodeURIComponent(bundleId)}`);
}

export function createChat(bundleId: string): Promise<ChatSession> {
  return request<ChatSession>(`${API_BASE}/chats/${encodeURIComponent(bundleId)}`, jsonOptions({}));
}

export function loadChat(bundleId: string, chatId: string): Promise<ChatSession> {
  return request<ChatSession>(`${API_BASE}/chats/${encodeURIComponent(bundleId)}/${encodeURIComponent(chatId)}`);
}

export function saveChat(
  bundleId: string,
  chatId: string,
  data: { title?: string; events: StoredEvent[] },
): Promise<ChatSession> {
  return request<ChatSession>(
    `${API_BASE}/chats/${encodeURIComponent(bundleId)}/${encodeURIComponent(chatId)}`,
    {
      ...jsonOptions(data),
      method: 'PUT',
    },
  );
}

export function deleteChat(bundleId: string, chatId: string): Promise<void> {
  return request<void>(
    `${API_BASE}/chats/${encodeURIComponent(bundleId)}/${encodeURIComponent(chatId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Undo the last turn: server-side truncation of the timeline back to before
 * the final user message (reply, tool calls, and recorded edits included).
 * Returns the updated session so the client can rebuild its state from it.
 */
export function undoTurn(bundleId: string, chatId: string): Promise<ChatSession> {
  return request<ChatSession>(
    `${API_BASE}/chats/${encodeURIComponent(bundleId)}/${encodeURIComponent(chatId)}/undo-turn`,
    { method: 'POST' },
  );
}

/** Compact the conversation: ask the LLM to summarise, persist, return summary (+ refreshed title). */
export function compactChat(
  bundleId: string,
  messages: ChatMessage[],
  chatId?: string | null,
): Promise<{ summary: string; title?: string }> {
  return request<{ summary: string }>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/compact`,
    jsonOptions({ messages, chatId: chatId ?? undefined }),
  );
}

/** Ask the LLM for a meaningful chat title from the conversation. */
export function retitleChat(
  bundleId: string,
  messages: ChatMessage[],
  chatId?: string | null,
): Promise<{ title: string }> {
  return request<{ title: string }>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/retitle`,
    jsonOptions({ messages, chatId: chatId ?? undefined }),
  );
}

/* --- Global settings --- */

export interface AppSettingsInfo {
  model: string;
  defaultModel: string;
  /** Official model ids from the API, or null when the list is unavailable. */
  models: string[] | null;
  /** The active model's context window (tokens) — indicator colouring. */
  contextLimit: number;
}

export function getSettings(): Promise<AppSettingsInfo> {
  return request<AppSettingsInfo>(`${API_BASE}/settings`);
}

export function updateModel(model: string): Promise<AppSettingsInfo> {
  return request<AppSettingsInfo>(`${API_BASE}/settings`, {
    ...jsonOptions({ model }),
    method: 'PUT',
  });
}

/* --- MCP servers --- */

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  allowTools?: string[];
  perUser?: boolean;
}

export interface McpServerInfo {
  name: string;
  running: boolean;
  toolCount: number;
  config: McpServerConfig;
  /** Last startup/connect error, if any (cleared on a successful start). */
  error?: string;
}

export interface McpsInfo {
  servers: McpServerInfo[];
  /** Emails with Google Workspace tokens on disk (per-user MCP instances). */
  workspaceUsers: string[];
}

/** MCP server status + workspace-connected users (Settings UI). */
export function getMcps(): Promise<McpsInfo> {
  return request<McpsInfo>(`${API_BASE}/mcps`);
}

/** Add an MCP server (saved and started; a start failure still returns 201
 *  with the server listed as not running + its error). */
export function addMcpServer(config: McpServerConfig): Promise<McpsInfo> {
  return request<McpsInfo>(`${API_BASE}/mcps`, {
    ...jsonOptions(config),
    method: 'POST',
  });
}

/** Update an MCP server's config (name immutable) and restart it. */
export function updateMcpServer(name: string, config: McpServerConfig): Promise<McpsInfo> {
  return request<McpsInfo>(`${API_BASE}/mcps/${encodeURIComponent(name)}`, {
    ...jsonOptions(config),
    method: 'PUT',
  });
}

/** Stop and remove an MCP server. */
export function removeMcpServer(name: string): Promise<McpsInfo> {
  return request<McpsInfo>(`${API_BASE}/mcps/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

/** Restart a server (e.g. after an external change). */
export function restartMcpServer(name: string): Promise<McpsInfo> {
  return request<McpsInfo>(`${API_BASE}/mcps/${encodeURIComponent(name)}/restart`, {
    method: 'POST',
  });
}

/* --- Document upload --- */

export interface UploadResult {
  mdPath: string;
  sourceName: string;
  duplicate: boolean;
  hash: string;
  chars: number;
  pages?: number;
}

/** Upload a file to the bundle. The server extracts content and writes uploads/{slug}.md. */
export async function uploadFile(bundleId: string, file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/bundles/${encodeURIComponent(bundleId)}/upload`, {
    method: 'POST',
    body: formData,
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    throw new Error(await extractError(res));
  }
  return (await res.json()) as UploadResult;
}

/* --- Git status --- */

export interface GitStatusInfo {
  isClean: boolean;
  modified: { path: string; index: string; working_dir: string; staged: boolean }[];
  staged: { path: string; index: string; working_dir: string; staged: boolean }[];
  not_added: string[];
  created: string[];
  deleted: string[];
  modified_list: string[];
  renamed: string[];
  insertions: number;
  deletions: number;
}

export function getGitStatus(bundleId: string): Promise<GitStatusInfo> {
  return request<GitStatusInfo>(`${API_BASE}/bundles/${encodeURIComponent(bundleId)}/git/status`);
}

/* --- Full-text search --- */

export interface SearchResult {
  path: string;
  title?: string;
  type?: string;
  heading: string;
  snippet: string;
  score: number;
}

export function searchBundle(
  bundleId: string,
  query: string,
  limit?: number,
): Promise<{ results: SearchResult[] }> {
  return request<{ results: SearchResult[] }>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/search`,
    jsonOptions({ query, limit }),
  );
}

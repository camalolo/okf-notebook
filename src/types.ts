export type Role = 'readonly' | 'full';

export interface User {
  email: string;
  name: string;
  picture?: string;
  role: Role;
  workspace?: {
    connected: boolean;
    expiresAt?: number;
  };
}

export interface DigestConfig {
  /** Daily digest for this bundle. `undefined`/`true` = enabled (default). */
  enabled?: boolean;
  /**
   * OKF maintenance pass before the digest: the LLM organizes, deduplicates,
   * and validates the .md files against OKF.md, then commits the changes.
   * `undefined`/`false` = off (default).
   */
  cleanup?: boolean;
  /** Google account (email) whose Calendar/Gmail the digest may read. */
  googleUser?: string;
}

export interface BundleConfig {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
  /** Readonly users allowed to see this bundle. `full` users see everything. */
  allowedUsers?: string[];
  /** MCP server names enabled for this bundle. `undefined` = all servers. */
  mcps?: string[];
  /** Daily digest settings for this bundle. */
  digest?: DigestConfig;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  concept?: {
    type?: string;
    title?: string;
  };
}

export interface FileContent {
  path: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title?: string;
  type?: string;
}

/* -------------------------------------------------------------------------
   Chat
   ------------------------------------------------------------------------- */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ProposedChange {
  id: string;
  type: 'edit' | 'create' | 'delete';
  path: string;
  oldContent?: string;
  newContent: string;
  status: 'pending' | 'accepted' | 'rejected' | 'applied';
}

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/**
 * A single chronological event within the assistant's current turn. Events are
 * accumulated into a `TurnEvent[]` as SSE chunks arrive and rendered in order.
 * When the turn completes, the accumulated text becomes a permanent
 * {@link ChatMessage} and the timeline is cleared.
 */
export type TurnEvent =
  | { kind: 'tool'; toolCall: ToolCallInfo }
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'proposed'; change: ProposedChange }
  | { kind: 'error'; text: string }
  /** Transient informational notice (e.g. server is retrying an upstream failure). */
  | { kind: 'notice'; text: string };

/* -------------------------------------------------------------------------
   Chat persistence
   ------------------------------------------------------------------------- */

/** Metadata for a chat session (list view). */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

/** A single stored event in the chat timeline (persisted format). */
export interface StoredEvent {
  ts: string;
  seq?: number; // monotonic sequence number (for resumability)
  kind: 'user' | 'assistant' | 'tool' | 'proposed' | 'error' | 'compaction' | 'turn_end';
  content?: string;
  toolCall?: ToolCallInfo;
  change?: ProposedChange;
}

/** Full chat session (loaded from server). */
export interface ChatSession {
  id: string;
  bundleId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  events: StoredEvent[];
}

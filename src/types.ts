export type Role = 'readonly' | 'full';

export interface User {
  email: string;
  name: string;
  picture?: string;
  role: Role;
}

export interface BundleConfig {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
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
  type: 'edit' | 'create';
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
  | { kind: 'proposed'; change: ProposedChange }
  | { kind: 'error'; text: string };

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
  kind: 'user' | 'assistant' | 'tool' | 'proposed' | 'error';
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

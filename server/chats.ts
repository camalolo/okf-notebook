/**
 * Chat session persistence — stores one JSON file per chat under
 * `server/data/chats/{bundleId}/{chatId}.json`.
 *
 * Each session stores a flat chronological event list that captures
 * everything needed to restore the UI: user messages, assistant messages,
 * tool calls, and proposed changes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.NOTEBOOK_CHATS_DIR
  ? path.resolve(process.env.NOTEBOOK_CHATS_DIR)
  : path.resolve(import.meta.dirname, '..', 'data', 'chats');

/** A single stored event in the chat timeline. */

export interface StoredEvent {
  ts: string; // ISO timestamp
  seq?: number; // monotonic sequence number (for resumability)
  // 'turn_end' marks the definitive end of an assistant turn (completion,
  // error, or abort). Clients polling a background turn wait for it.
  // `interrupted: true` marks a synthetic turn_end written by the boot sweep
  // for a turn killed by a restart/crash — clients offer a Resume button.
  kind: 'user' | 'assistant' | 'tool' | 'proposed' | 'error' | 'compaction' | 'turn_end';
  interrupted?: boolean;
  content?: string; // for user/assistant/error
  toolCall?: { name: string; args: Record<string, unknown>; result?: unknown };
  change?: {
    id: string;
    type: 'edit' | 'create' | 'delete';
    path: string;
    oldContent?: string;
    newContent: string;
    status: 'pending' | 'accepted' | 'rejected' | 'applied';
  };
}

export interface ChatSession {
  id: string;
  bundleId: string;
  /** Email of the user who created this chat. */
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  events: StoredEvent[];
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

function bundleDir(bundleId: string): string {
  return path.join(DATA_DIR, bundleId);
}

function chatPath(bundleId: string, chatId: string): string {
  return path.join(bundleDir(bundleId), `${chatId}.json`);
}

/** Validate bundleId/chatId to prevent path traversal. */
function validateId(id: string): void {
  if (!id || /[^a-z0-9-]/i.test(id)) {
    throw new Error('Invalid id');
  }
}

/** Check whether a chat belongs to the given user (strict — no legacy fallback). */
function isOwnedBy(chat: Pick<ChatSession, 'userId'>, userId: string): boolean {
  return chat.userId === userId;
}

/** List chat sessions for a bundle that belong to the given user (metadata only). */
export async function listChats(bundleId: string, userId: string): Promise<ChatSummary[]> {
  validateId(bundleId);
  const dir = bundleDir(bundleId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const summaries: ChatSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf8');
      const chat = JSON.parse(raw) as ChatSession;
      if (!isOwnedBy(chat, userId)) continue;
      summaries.push({
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        eventCount: chat.events.length,
      });
    } catch {
      // skip corrupt files
    }
  }

  // Sort by updatedAt descending (most recent first).
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** Load a full chat session. Returns null if not found or not owned by user. */
export async function loadChat(
  bundleId: string,
  chatId: string,
  userId: string,
): Promise<ChatSession | null> {
  validateId(bundleId);
  validateId(chatId);
  try {
    const raw = await fs.readFile(chatPath(bundleId, chatId), 'utf8');
    const chat = JSON.parse(raw) as ChatSession;
    if (!isOwnedBy(chat, userId)) return null;
    return chat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Create a new empty chat session owned by the given user. */
export async function createChat(bundleId: string, userId: string): Promise<ChatSession> {
  validateId(bundleId);
  const now = new Date().toISOString();
  const chat: ChatSession = {
    id: crypto.randomUUID(),
    bundleId,
    userId,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  await fs.mkdir(bundleDir(bundleId), { recursive: true });
  await fs.writeFile(chatPath(bundleId, chat.id), JSON.stringify(chat, null, 2), 'utf8');
  return chat;
}

/** Save (replace) a full chat session. Caller must own the chat. */
export async function saveChat(
  bundleId: string,
  chatId: string,
  userId: string,
  data: { title?: string; events: StoredEvent[] },
): Promise<ChatSession> {
  validateId(bundleId);
  validateId(chatId);
  const existing = await loadChat(bundleId, chatId, userId);
  if (!existing) throw new Error('Chat not found');

  const updated: ChatSession = {
    ...existing,
    title: data.title ?? existing.title,
    events: data.events,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(chatPath(bundleId, chatId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Append a single event to an existing chat session. Assigns the next monotonic
 * `seq` number. Auto-titles the chat from the first user message.
 */
export async function appendEvent(
  bundleId: string,
  chatId: string,
  userId: string,
  event: Omit<StoredEvent, 'ts' | 'seq'>,
): Promise<void> {
  validateId(bundleId);
  validateId(chatId);
  const existing = await loadChat(bundleId, chatId, userId);
  if (!existing) throw new Error('Chat not found');

  const lastEvent = existing.events[existing.events.length - 1];
  const seq = lastEvent ? (lastEvent.seq ?? existing.events.length - 1) + 1 : 0;
  const now = new Date().toISOString();
  const newEvent: StoredEvent = { ...event, ts: now, seq };

  // Auto-title from first user message.
  let { title } = existing;
  if (title === 'New chat' && event.kind === 'user' && event.content) {
    title = event.content.slice(0, 60).trim() || 'New chat';
  }

  const updated: ChatSession = {
    ...existing,
    title,
    events: [...existing.events, newEvent],
    updatedAt: now,
  };
  await fs.writeFile(chatPath(bundleId, chatId), JSON.stringify(updated, null, 2), 'utf8');
}

/** Rename a chat session (title only). */
export async function renameChat(
  bundleId: string,
  chatId: string,
  userId: string,
  title: string,
): Promise<void> {
  validateId(bundleId);
  validateId(chatId);
  const existing = await loadChat(bundleId, chatId, userId);
  if (!existing) return;
  const updated: ChatSession = {
    ...existing,
    title,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(chatPath(bundleId, chatId), JSON.stringify(updated, null, 2), 'utf8');
}

/** Delete a chat session. No-op if not found or not owned by user. */
export async function deleteChat(
  bundleId: string,
  chatId: string,
  userId: string,
): Promise<void> {
  validateId(bundleId);
  validateId(chatId);
  const existing = await loadChat(bundleId, chatId, userId);
  if (!existing) return; // not found or not owned
  try {
    await fs.unlink(chatPath(bundleId, chatId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Whether the last turn of a timeline is terminated — mirrors the client's
 * `isLastTurnComplete`: new-format timelines need a `turn_end` after the
 * last user message; legacy ones accept a closing assistant message.
 */
export function isLastTurnTerminated(events: StoredEvent[]): boolean {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return true; // no turn open
  const after = events.slice(lastUserIdx + 1);
  if (events.some((e) => e.kind === 'turn_end')) {
    return after.some((e) => e.kind === 'turn_end');
  }
  return after.some((e) => e.kind === 'assistant'); // legacy timeline
}

/**
 * Boot-time sweep: append a `turn_end` to every chat whose last turn never
 * terminated. A restart/crash mid-turn kills the chat loop before it can
 * persist the terminal event, leaving reconnecting clients polling forever
 * ("stuck after server disconnect"). At startup there are, by definition, no
 * active loops — any unterminated last turn is dead, so closing it is always
 * correct. The orphaned tool calls before it restore client-side as an
 * interrupted turn ("⚠️ This response was interrupted."), same as an abort.
 *
 * @returns number of chats repaired.
 */
export async function finalizeOrphanedTurns(): Promise<number> {
  let repaired = 0;
  let bundleDirs: string[];
  try {
    bundleDirs = await fs.readdir(DATA_DIR);
  } catch {
    return 0; // no chats yet
  }
  for (const bundleId of bundleDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(DATA_DIR, bundleId));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(DATA_DIR, bundleId, entry);
      try {
        const chat = JSON.parse(await fs.readFile(file, 'utf8')) as ChatSession;
        if (!Array.isArray(chat.events) || isLastTurnTerminated(chat.events)) continue;
        const lastEvent = chat.events[chat.events.length - 1];
        const seq = lastEvent ? (lastEvent.seq ?? chat.events.length - 1) + 1 : 0;
        chat.events.push({ ts: new Date().toISOString(), seq, kind: 'turn_end', interrupted: true });
        chat.updatedAt = new Date().toISOString();
        await fs.writeFile(file, JSON.stringify(chat, null, 2) + '\n', 'utf8');
        repaired++;
        console.warn(
          `[chats] Finalized orphaned turn in ${bundleId}/${chat.id} ` +
            '(server restarted mid-turn)',
        );
      } catch (err) {
        console.error(
          `[chats] Sweep failed for ${file}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return repaired;
}

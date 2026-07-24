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

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data', 'chats');

/** A single stored event in the chat timeline. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StoredEvent {
  ts: string; // ISO timestamp
  kind: 'user' | 'assistant' | 'tool' | 'proposed';
  content?: string; // for user/assistant
  toolCall?: { name: string; args: Record<string, unknown>; result?: unknown };
  change?: {
    id: string;
    type: 'edit' | 'create';
    path: string;
    oldContent?: string;
    newContent: string;
    status: 'pending' | 'accepted' | 'rejected' | 'applied';
  };
}

export interface ChatSession {
  id: string;
  bundleId: string;
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

/** List all chat sessions for a bundle (metadata only). */
export async function listChats(bundleId: string): Promise<ChatSummary[]> {
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

/** Load a full chat session. Returns null if not found. */
export async function loadChat(
  bundleId: string,
  chatId: string,
): Promise<ChatSession | null> {
  validateId(bundleId);
  validateId(chatId);
  try {
    const raw = await fs.readFile(chatPath(bundleId, chatId), 'utf8');
    return JSON.parse(raw) as ChatSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Create a new empty chat session. */
export async function createChat(bundleId: string): Promise<ChatSession> {
  validateId(bundleId);
  const now = new Date().toISOString();
  const chat: ChatSession = {
    id: crypto.randomUUID(),
    bundleId,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  await fs.mkdir(bundleDir(bundleId), { recursive: true });
  await fs.writeFile(chatPath(bundleId, chat.id), JSON.stringify(chat, null, 2), 'utf8');
  return chat;
}

/** Save (replace) a full chat session. */
export async function saveChat(
  bundleId: string,
  chatId: string,
  data: { title?: string; events: StoredEvent[] },
): Promise<ChatSession> {
  validateId(bundleId);
  validateId(chatId);
  const existing = await loadChat(bundleId, chatId);
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

/** Delete a chat session. */
export async function deleteChat(
  bundleId: string,
  chatId: string,
): Promise<void> {
  validateId(bundleId);
  validateId(chatId);
  try {
    await fs.unlink(chatPath(bundleId, chatId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

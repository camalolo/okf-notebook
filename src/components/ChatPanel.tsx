import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { KeyboardEvent } from 'react';
import type {
  ChatMessage,
  ChatSummary,
  ProposedChange,
  StoredEvent,
  ToolCallInfo,
  TurnEvent,
} from '../types.ts';
import { streamChat } from '../services/chat.ts';
import {
  createChat,
  deleteChat,
  getGitStatus,
  listChats,
  loadChat,
  saveChat,
} from '../services/api.ts';
import { ProposedChangeCard } from './ProposedChangeCard.tsx';

interface ChatPanelProps {
  bundleId: string;
  /** Bundle display name shown in the header. */
  bundleName?: string;
  /** Bundle emoji icon shown in the header. */
  bundleIcon?: string;
  /** Called when a file is created or modified via the chat, so the parent can refresh its file tree. */
  onFilesChanged?: () => void;
}

interface ToolCallLabel {
  icon: string;
  text: string;
}

type ProposedEvent = Extract<TurnEvent, { kind: 'proposed' }>;

/** Renders markdown content inside chat bubbles (GFM tables, code, etc.). */
const chatMarkdownComponents: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return <div className="chat-table-wrap"><table>{children}</table></div>;
  },
};

function ChatMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

function trunc(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatToolCall(tc: ToolCallInfo): ToolCallLabel {
  const args = tc.args ?? {};
  const path = typeof args.path === 'string' ? args.path : '';
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (tc.name) {
    // --- Bundle tools ---
    case 'read_file':
    case 'readFile':
      return { icon: '📖', text: path ? `Read ${path}` : 'Read file' };
    case 'list_files':
    case 'listFiles':
    case 'glob':
      return { icon: '📁', text: 'List files' };
    case 'edit_file':
      return { icon: '✏️', text: path ? `Edit ${path}` : 'Edit file' };
    case 'create_file':
      return { icon: '📄', text: path ? `Create ${path}` : 'Create file' };
    case 'git_status':
      return { icon: '🌿', text: 'Git status' };
    case 'git_diff':
      return { icon: '🌿', text: path ? `Git diff: ${path}` : 'Git diff' };
    case 'git_log':
      return { icon: '🌿', text: 'Git log' };

    // --- Browser MCP tools ---
    case 'browser_navigate':
      return { icon: '🔗', text: `Navigate to ${trunc(str('url'), 50) || 'URL'}` };
    case 'browser_snapshot':
      return { icon: '📸', text: 'Page snapshot' };
    case 'browser_screenshot':
      return { icon: '📸', text: 'Screenshot' };
    case 'browser_click':
      return { icon: '🖱️', text: `Click ${trunc(str('element') || str('text'), 40) || 'element'}` };
    case 'browser_double_click':
      return { icon: '🖱️', text: `Double-click ${trunc(str('element') || str('text'), 40) || 'element'}` };
    case 'browser_hover':
      return { icon: '🖱️', text: `Hover ${trunc(str('element') || str('text'), 40) || 'element'}` };
    case 'browser_type':
      return { icon: '⌨️', text: `Type "${trunc(str('text'), 40)}"` };
    case 'browser_press_key':
      return { icon: '⌨️', text: `Press ${str('key') || 'key'}` };
    case 'browser_select_option':
      return { icon: '📋', text: `Select ${str('values') || 'option'}` };
    case 'browser_resize':
      return { icon: '🔄', text: `Resize ${args.width ?? ''}×${args.height ?? ''}` };
    case 'browser_close':
      return { icon: '🚪', text: 'Close browser' };
    case 'browser_wait_for':
      return { icon: '⏳', text: str('text') ? `Wait for "${trunc(str('text'), 40)}"` : 'Wait' };
    case 'browser_tabs':
      return { icon: '📑', text: 'Tab management' };
    case 'browser_fill_form':
      return { icon: '📝', text: 'Fill form' };
    case 'browser_evaluate':
      return { icon: '🔧', text: 'Run JavaScript' };

    // --- Google Workspace MCP tools ---
    case 'gw_search_emails':
      return { icon: '📧', text: `Search emails: "${trunc(str('query'), 40)}"` };
    case 'gw_read_email':
      return { icon: '📧', text: `Read email ${trunc(str('messageId'), 20)}` };
    case 'gw_list_calendars':
      return { icon: '📅', text: 'List calendars' };
    case 'gw_list_events':
      return { icon: '📅', text: str('calendarId') ? `List events (${str('calendarId')})` : 'List events' };
    case 'gw_get_event':
      return { icon: '📅', text: `Get event ${trunc(str('eventId'), 20)}` };
    case 'gw_create_event':
      return { icon: '📅', text: `Create event: ${trunc(str('summary'), 40) || '(untitled)'}` };
    case 'gw_update_event':
      return { icon: '📅', text: `Update event: ${trunc(str('summary'), 40) || str('eventId')}` };
    case 'gw_delete_event':
      return { icon: '📅', text: `Delete event ${trunc(str('eventId'), 20)}` };
    case 'gw_find_free_time':
      return { icon: '📅', text: 'Find free time' };
    case 'gw_quick_add_event':
      return { icon: '📅', text: `Add event: "${trunc(str('text'), 40)}"` };

    default: {
      if (tc.name.startsWith('browser_')) {
        return { icon: '🌐', text: tc.name.replace('browser_', '').replace(/_/g, ' ') };
      }
      if (tc.name.startsWith('gw_')) {
        return { icon: '📧', text: tc.name.replace('gw_', '').replace(/_/g, ' ') };
      }
      return { icon: '🔧', text: tc.name.replace(/_/g, ' ') };
    }
  }
}

/** Generate a stable id for a proposed change, falling back when.randomUUID is unavailable. */
function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Relative-ish date label for chat history items. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Flatten the in-memory conversation state into the persisted `StoredEvent[]`
 * timeline. Tool calls and proposed changes are emitted before the assistant
 * message they belong to (matching the order produced by {@link restoreFromEvents}).
 */
function buildEventsFrom(
  messages: ChatMessage[],
  pastTurns: TurnEvent[][],
  proposedChanges: ProposedChange[],
  extraEvents?: StoredEvent[],
): StoredEvent[] {
  const events: StoredEvent[] = [];
  const now = new Date().toISOString();
  let assistantIdx = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      events.push({ ts: now, kind: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      // Push tool calls, proposed changes, and errors from this turn first.
      const turnEvents = pastTurns[assistantIdx] ?? [];
      for (const ev of turnEvents) {
        if (ev.kind === 'tool') {
          events.push({ ts: now, kind: 'tool', toolCall: ev.toolCall });
        } else if (ev.kind === 'proposed') {
          // Look up the latest status from the persistent proposedChanges list.
          const latest = proposedChanges.find((c) => c.id === ev.change.id) ?? ev.change;
          events.push({ ts: now, kind: 'proposed', change: latest });
        } else if (ev.kind === 'error') {
          events.push({ ts: now, kind: 'error', content: ev.text });
        }
      }
      events.push({ ts: now, kind: 'assistant', content: m.content });
      assistantIdx++;
    }
  }
  // Append extra events (used for mid-stream saves of incomplete turns).
  if (extraEvents) events.push(...extraEvents);
  return events;
}

/**
 * Reconstruct in-memory chat state (messages, past turns, proposed changes)
 * from a persisted `StoredEvent[]` timeline.
 */
function restoreFromEvents(events: StoredEvent[]): {
  messages: ChatMessage[];
  pastTurns: TurnEvent[][];
  proposedChanges: ProposedChange[];
} {
  const messages: ChatMessage[] = [];
  const pastTurns: TurnEvent[][] = [];
  const proposedChanges: ProposedChange[] = [];
  let currentTurn: TurnEvent[] = [];

  for (const ev of events) {
    if (ev.kind === 'user') {
      messages.push({ role: 'user', content: ev.content ?? '' });
      currentTurn = [];
    } else if (ev.kind === 'tool') {
      if (ev.toolCall) currentTurn.push({ kind: 'tool', toolCall: ev.toolCall });
    } else if (ev.kind === 'proposed') {
      if (ev.change) {
        proposedChanges.push(ev.change);
        currentTurn.push({ kind: 'proposed', change: ev.change });
      }
    } else if (ev.kind === 'error') {
      currentTurn.push({ kind: 'error', text: ev.content ?? 'Unknown error' });
    } else if (ev.kind === 'assistant') {
      // The current turn's events belong to this assistant message.
      pastTurns.push(currentTurn);
      messages.push({ role: 'assistant', content: ev.content ?? '' });
      currentTurn = [];
    }
  }

  // If there are orphaned events (incomplete turn — e.g. interrupted by
  // error), attach them as a synthetic turn with a placeholder assistant
  // message so they're visible in the timeline.
  if (currentTurn.length > 0) {
    pastTurns.push(currentTurn);
    messages.push({
      role: 'assistant',
      content: '⚠️ This response was interrupted.',
    });
  }

  return { messages, pastTurns, proposedChanges };
}

export function ChatPanel({ bundleId, bundleName, bundleIcon, onFilesChanged }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  /** Chronological events for the in-flight assistant turn. */
  const [turnEvents, setTurnEvents] = useState<TurnEvent[]>([]);
  /** Completed turns — preserves tool calls + proposed changes in order. */
  const [pastTurns, setPastTurns] = useState<TurnEvent[][]>([]);
  /** Persistent proposed changes — survives across turns so the user can
   *  accept/reject after the turn completes. */
  const [proposedChanges, setProposedChanges] = useState<ProposedChange[]>([]);

  /** Active chat session id (null until a session is created/loaded). */
  const [chatId, setChatId] = useState<string | null>(null);
  /** Active chat title. */
  const [chatTitle, setChatTitle] = useState<string>('New chat');
  /** Past chats for this bundle (newest first). */
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  /** Whether the history dropdown is open. */
  const [showHistory, setShowHistory] = useState(false);

  /** Count of uncommitted changes from git status (0 when clean/unknown). */
  const [gitChanges, setGitChanges] = useState(0);

  // Mirror the latest message history so the async send handler can build the
  // request payload without reading stale state.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Ref mirrors for the persistence logic, which runs inside async handlers.
  const pastTurnsRef = useRef<TurnEvent[][]>([]);
  useEffect(() => {
    pastTurnsRef.current = pastTurns;
  }, [pastTurns]);
  const proposedChangesRef = useRef<ProposedChange[]>([]);
  useEffect(() => {
    proposedChangesRef.current = proposedChanges;
  }, [proposedChanges]);
  const chatIdRef = useRef<string | null>(null);
  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);
  const chatTitleRef = useRef<string>('New chat');
  useEffect(() => {
    chatTitleRef.current = chatTitle;
  }, [chatTitle]);

  // Auto-scroll to the bottom whenever new content arrives.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, turnEvents, pastTurns, proposedChanges, loading]);

  /**
   * Persist the given conversation snapshot to the active chat session.
   * Auto-titles the chat from the first user message if the title is still the
   * default. Best-effort: failures are swallowed so chat keeps working offline.
   */
  const doSave = useCallback(
    async (
      msgs: ChatMessage[],
      turns: TurnEvent[][],
      changes: ProposedChange[],
      extraEvents?: StoredEvent[],
    ): Promise<void> => {
      const id = chatIdRef.current;
      if (!id) return;
      const events = buildEventsFrom(msgs, turns, changes, extraEvents);
      let title = chatTitleRef.current;
      const firstUser = msgs.find((m) => m.role === 'user');
      if (title === 'New chat' && firstUser) {
        title = firstUser.content.slice(0, 60).trim() || 'New chat';
      }
      try {
        const saved = await saveChat(bundleId, id, { title, events });
        if (saved.title !== chatTitleRef.current) {
          chatTitleRef.current = saved.title;
          setChatTitle(saved.title);
        }
        const refreshed = await listChats(bundleId);
        setChatList(refreshed);
      } catch {
        // Persistence is best-effort.
      }
    },
    [bundleId],
  );

  /**
   * Append a content chunk to the current turn's timeline. Consecutive chunks
   * coalesce into a single growing bubble; a chunk that follows a tool call or
   * proposed change starts a new bubble so chronology is preserved.
   */
  const appendContent = useCallback((chunk: string) => {
    setTurnEvents((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === 'content') {
        return [
          ...prev.slice(0, -1),
          { kind: 'content', text: last.text + chunk },
        ];
      }
      return [...prev, { kind: 'content', text: chunk }];
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    // Auto-create a chat session on first message (if none active).
    if (chatIdRef.current === null) {
      try {
        const session = await createChat(bundleId);
        setChatId(session.id);
        chatIdRef.current = session.id;
      } catch {
        // Non-fatal: continue with an ephemeral chat.
      }
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    // Capture the pre-turn state so we can compute the final snapshot for both
    // the UI and persistence without relying on state updated mid-stream.
    const history = [...messagesRef.current, userMsg];
    const preTurnPastTurns = pastTurnsRef.current;
    const preTurnProposed = proposedChangesRef.current;

    setInput('');
    setTurnEvents([]);
    setLoading(true);
    setMessages(history);

    // Local tracking for this turn (mirrors the setTurnEvents/setProposedChanges
    // calls so we can persist the final snapshot accurately).
    const turnEventsLocal: TurnEvent[] = [];
    const proposedLocal: ProposedChange[] = [];
    let acc = '';
    let chatError: string | null = null;

    /** Build StoredEvents for the current in-progress turn (tool calls only,
     *  no assistant message yet — used for mid-stream saves). */
    const buildMidStreamExtras = (): StoredEvent[] => {
      const now = new Date().toISOString();
      const extras: StoredEvent[] = [];
      for (const ev of turnEventsLocal) {
        if (ev.kind === 'tool') {
          extras.push({ ts: now, kind: 'tool', toolCall: ev.toolCall });
        } else if (ev.kind === 'proposed') {
          const latest = [...preTurnProposed, ...proposedLocal].find(
            (c) => c.id === ev.change.id,
          ) ?? ev.change;
          extras.push({ ts: now, kind: 'proposed', change: latest });
        }
      }
      return extras;
    };

    try {
      for await (const ev of streamChat(bundleId, history)) {
        const data = ev.data;

        if (ev.event === 'content') {
          const obj = data as { text?: unknown };
          if (typeof obj.text === 'string') {
            acc += obj.text;
            appendContent(obj.text);
          }
        } else if (ev.event === 'tool_call') {
          const obj = data as Partial<ToolCallInfo>;
          const toolCall: ToolCallInfo = {
            name: typeof obj.name === 'string' ? obj.name : 'tool',
            args: obj.args ?? {},
            result: obj.result,
          };
          const te: TurnEvent = { kind: 'tool', toolCall };
          setTurnEvents((prev) => [...prev, te]);
          turnEventsLocal.push(te);

          // Incremental save after each tool call so progress survives
          // connection drops / server restarts.
          await doSave(
            history,
            preTurnPastTurns,
            [...preTurnProposed, ...proposedLocal],
            buildMidStreamExtras(),
          );
        } else if (ev.event === 'proposed_change') {
          const obj = data as {
            type?: unknown;
            path?: unknown;
            oldContent?: unknown;
            newContent?: unknown;
          };
          const change: ProposedChange = {
            id: makeId(),
            type: obj.type === 'create' ? 'create' : 'edit',
            path: typeof obj.path === 'string' ? obj.path : '',
            oldContent:
              typeof obj.oldContent === 'string' ? obj.oldContent : undefined,
            newContent: typeof obj.newContent === 'string' ? obj.newContent : '',
            status: 'applied',
          };
          setProposedChanges((prev) => [...prev, change]);
          const te: TurnEvent = { kind: 'proposed', change };
          setTurnEvents((prev) => [...prev, te]);
          proposedLocal.push(change);
          turnEventsLocal.push(te);
          onFilesChanged?.();
        } else if (ev.event === 'commit_proposed') {
          const obj = data as { message?: unknown };
          const te: TurnEvent = {
            kind: 'tool',
            toolCall: {
              name: 'commit',
              args: {
                message: typeof obj.message === 'string' ? obj.message : '',
              },
            },
          };
          setTurnEvents((prev) => [...prev, te]);
          turnEventsLocal.push(te);
        } else if (ev.event === 'done') {
          break;
        } else if (ev.event === 'error') {
          const obj = data as { message?: unknown };
          throw new Error(
            typeof obj.message === 'string' ? obj.message : 'Chat error',
          );
        }
      }
    } catch (err) {
      chatError = err instanceof Error ? err.message : 'Chat request failed';
      // Add the error as a visible event in the timeline.
      const errEvent: TurnEvent = { kind: 'error', text: chatError };
      turnEventsLocal.push(errEvent);
      setTurnEvents((prev) => [...prev, errEvent]);
    }

    // Compute the final snapshot from the captured pre-turn state + this turn.
    const assistantMsg: ChatMessage | null = acc.trim()
      ? { role: 'assistant', content: acc }
      : null;
    const finalMessages = assistantMsg ? [...history, assistantMsg] : history;
    const finalPastTurns =
      turnEventsLocal.length > 0
        ? [...preTurnPastTurns, turnEventsLocal]
        : preTurnPastTurns;
    const finalProposedChanges = [...preTurnProposed, ...proposedLocal];

    // Commit to state.
    setMessages(finalMessages);
    setPastTurns(finalPastTurns);
    setTurnEvents([]);
    setLoading(false);

    // Persist the completed turn (including any error event).
    await doSave(finalMessages, finalPastTurns, finalProposedChanges);
  }, [bundleId, input, loading, appendContent, doSave, onFilesChanged]);

  /** Fetch the current git status and update the badge count. Best-effort. */
  const refreshGitStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await getGitStatus(bundleId);
      setGitChanges(status.isClean ? 0 : status.modified.length + status.staged.length);
    } catch {
      // Git status is best-effort — leave the previous count in place.
    }
  }, [bundleId]);

  /** Start a fresh, empty chat (clears state; a session is created on first send). */
  const handleNewChat = useCallback(() => {
    setMessages([]);
    setPastTurns([]);
    setProposedChanges([]);
    setTurnEvents([]);
    setChatId(null);
    setChatTitle('New chat');
    setShowHistory(false);
    chatIdRef.current = null;
    chatTitleRef.current = 'New chat';
  }, []);

  /** Load a past chat and restore its conversation state. */
  const handleSelectChat = useCallback(
    async (id: string): Promise<void> => {
      try {
        const session = await loadChat(bundleId, id);
        const { messages: msgs, pastTurns: turns, proposedChanges: changes } =
          restoreFromEvents(session.events);
        setMessages(msgs);
        setPastTurns(turns);
        setProposedChanges(changes);
        setTurnEvents([]);
        setChatId(session.id);
        setChatTitle(session.title);
        setShowHistory(false);
        chatIdRef.current = session.id;
        chatTitleRef.current = session.title;
      } catch {
        // Best-effort: leave current chat in place.
      }
    },
    [bundleId],
  );

  /** Delete a chat from the server and update the list. */
  const handleDeleteChat = useCallback(
    async (id: string): Promise<void> => {
      try {
        await deleteChat(bundleId, id);
        const refreshed = await listChats(bundleId);
        setChatList(refreshed);
        // If we deleted the active chat, load the next available or go empty.
        if (id === chatIdRef.current) {
          if (refreshed.length > 0) {
            await handleSelectChat(refreshed[0].id);
          } else {
            setMessages([]);
            setPastTurns([]);
            setProposedChanges([]);
            setTurnEvents([]);
            setChatId(null);
            setChatTitle('New chat');
            chatIdRef.current = null;
            chatTitleRef.current = 'New chat';
          }
        }
      } catch {
        // Best-effort.
      }
    },
    [bundleId, handleSelectChat],
  );

  // On mount / bundle change: fetch the chat list and auto-load the most recent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chats = await listChats(bundleId);
        if (cancelled) return;
        setChatList(chats);
        if (chats.length > 0) {
          await handleSelectChat(chats[0].id);
        } else {
          setChatId(null);
          setChatTitle('New chat');
          chatIdRef.current = null;
          chatTitleRef.current = 'New chat';
        }
      } catch {
        // Persistence is best-effort.
      }
    })();
    void refreshGitStatus();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId]);

  // Poll git status every 30 seconds so the badge stays current.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshGitStatus();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshGitStatus]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasContent = turnEvents.some((e) => e.kind === 'content');
  const showTyping = loading && !hasContent;

  // Proposed changes already rendered inline within a turn timeline —
  // either the current streaming turn or committed past turns — are
  // excluded here to avoid duplication.
  const inlineProposedIds = new Set<string>([
    ...turnEvents
      .filter((e): e is ProposedEvent => e.kind === 'proposed')
      .map((e) => e.change.id),
    ...pastTurns
      .flat()
      .filter((e): e is ProposedEvent => e.kind === 'proposed')
      .map((e) => e.change.id),
  ]);
  const pastProposed = proposedChanges.filter(
    (c) => !inlineProposedIds.has(c.id),
  );

  const isEmpty =
    messages.length === 0 && turnEvents.length === 0 && pastTurns.length === 0 && !loading;

  return (
    <div
      className="chat-panel"
      role="log"
      aria-label={`Chat about ${bundleName ?? 'this bundle'}`}
    >
      <header className="chat-header">
        <div className="chat-header-left">
          <span className="chat-header-avatar" aria-hidden="true">
            {bundleIcon ?? '🤖'}
          </span>
          <div className="chat-header-info">
            <span className="chat-header-bundle">{bundleName ?? 'GLM'}</span>
            <button
              type="button"
              className="chat-history-toggle"
              onClick={() => setShowHistory((v) => !v)}
            >
              {chatTitle}
              <span className="chat-history-caret" aria-hidden="true">▾</span>
            </button>
          </div>
        </div>
        {gitChanges > 0 && (
          <button
            type="button"
            className="chat-git-badge"
            title={`${gitChanges} uncommitted change${gitChanges > 1 ? 's' : ''}`}
            onClick={() => {
              setInput('Show me the git status');
              void handleSend();
            }}
          >
            🔴 {gitChanges}
          </button>
        )}
        <button
          type="button"
          className="chat-new-btn"
          onClick={handleNewChat}
          title="New chat"
        >
          + New
        </button>

        {showHistory && (
          <>
            <div
              className="chat-history-backdrop"
              onClick={() => setShowHistory(false)}
              aria-hidden="true"
            />
            <div className="chat-history-dropdown">
              <div className="chat-history-header">Chat history</div>
              {chatList.length === 0 && (
                <div className="chat-history-empty">No past chats</div>
              )}
              {chatList.map((c) => (
                <div
                  key={c.id}
                  className={`chat-history-item ${c.id === chatId ? 'active' : ''}`}
                  onClick={() => void handleSelectChat(c.id)}
                >
                  <span className="chat-history-item-title">{c.title}</span>
                  <span className="chat-history-item-meta">
                    <span className="chat-history-item-date">
                      {formatDate(c.updatedAt)}
                    </span>
                    <button
                      type="button"
                      className="chat-history-item-delete"
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${c.title}"?`)) {
                          void handleDeleteChat(c.id);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {isEmpty && (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">💬</div>
            <h3>Ask GLM about this bundle</h3>
            <p>
              GLM can read files, propose edits, and commit changes. Try
              “Summarize the current credits status.”
            </p>
          </div>
        )}

        {/* Permanent history — messages interleaved with past turn events. */}
        {(() => {
          let assistantIdx = -1;
          return messages.map((m, i) => {
            if (m.role === 'assistant') {
              assistantIdx++;
            }
            const turnEventsForMsg: TurnEvent[] =
              m.role === 'assistant' && assistantIdx >= 0 && assistantIdx < pastTurns.length
                ? pastTurns[assistantIdx]
                : [];
            return (
              <Fragment key={`m${i}`}>
                {turnEventsForMsg.map((ev, j) => {
                  if (ev.kind === 'tool') {
                    const label = formatToolCall(ev.toolCall);
                    return (
                      <div className="chat-tool-call" key={`pt${i}-${j}`}>
                        <span className="chat-tool-icon" aria-hidden="true">
                          {label.icon}
                        </span>
                        <span className="chat-tool-text">{label.text}</span>
                      </div>
                    );
                  }
                  if (ev.kind === 'error') {
                    return (
                      <div className="chat-error-event" key={`pe${i}-${j}`}>
                        ⚠️ {ev.text}
                      </div>
                    );
                  }
                  if (ev.kind === 'proposed') {
                    const latest =
                      proposedChanges.find((c) => c.id === ev.change.id) ?? ev.change;
                    return (
                      <ProposedChangeCard
                        key={`pp${i}-${j}`}
                        change={latest}
                      />
                    );
                  }
                  return null;
                })}
                <div
                  className={`chat-message chat-message-${m.role === 'user' ? 'user' : 'assistant'}`}
                >
                  {m.role !== 'user' && <span className="chat-author">GLM</span>}
                  <div className="chat-bubble"><ChatMarkdown content={m.content} /></div>
                </div>
              </Fragment>
            );
          });
        })()}

        {/* Current turn — events rendered in arrival order. */}
        {turnEvents.map((ev, i) => {
          if (ev.kind === 'tool') {
            const label = formatToolCall(ev.toolCall);
            return (
              <div className="chat-tool-call" key={`t${i}`}>
                <span className="chat-tool-icon" aria-hidden="true">
                  {label.icon}
                </span>
                <span className="chat-tool-text">{label.text}</span>
              </div>
            );
          }
          if (ev.kind === 'error') {
            return (
              <div className="chat-error-event" key={`e${i}`}>
                ⚠️ {ev.text}
              </div>
            );
          }
          if (ev.kind === 'content') {
            return (
              <div className="chat-message chat-message-assistant" key={`c${i}`}>
                <span className="chat-author">GLM</span>
                <div className="chat-bubble"><ChatMarkdown content={ev.text} /></div>
              </div>
            );
          }
          // Look up the latest status from persistent state so accept/reject
          // is reflected even while the card lives in the turn timeline.
          const latest =
            proposedChanges.find((c) => c.id === ev.change.id) ?? ev.change;
          return (
            <ProposedChangeCard
              key={`p${i}`}
              change={latest}
            />
          );
        })}

        {/* Proposed changes from previous turns. */}
        {pastProposed.map((change) => (
          <ProposedChangeCard
            key={change.id}
            change={change}
          />
        ))}

        {showTyping && (
          <div className="chat-message chat-message-assistant">
            <span className="chat-author">GLM</span>
            <div className="chat-typing" aria-label="GLM is typing">
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          placeholder="Message GLM…  (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary chat-send-btn"
          onClick={() => void handleSend()}
          disabled={loading || !input.trim()}
          aria-label="Send message"
        >
          {loading ? (
            <span className="spinner spinner-sm" />
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3.4 20.4 21 12 3.4 3.6 3.39 10l12 2-12 2z"
              />
            </svg>
          )}
          <span>Send</span>
        </button>
      </div>
    </div>
  );
}

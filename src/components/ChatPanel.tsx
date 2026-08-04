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
} from '../services/api.ts';
import { ProposedChangeCard } from './ProposedChangeCard.tsx';
import { reconnectWithGoogle } from '../services/auth.ts';

interface ChatPanelProps {
  bundleId: string;
  /** Bundle display name shown in the header. */
  bundleName?: string;
  /** Bundle emoji icon shown in the header. */
  bundleIcon?: string;
  /** Called when a file is created or modified via the chat, so the parent can refresh its file tree. */
  onFilesChanged?: () => void;
  /** Called when the user clicks an internal .md link in chat output. */
  onNavigate?: (path: string) => void;
}

interface ToolCallLabel {
  icon: string;
  text: string;
}

type ProposedEvent = Extract<TurnEvent, { kind: 'proposed' }>;

/** Renders markdown content inside chat bubbles (GFM tables, code, etc.). */
function ChatMarkdown({ content, onNavigate }: { content: string; onNavigate?: (path: string) => void }) {
  const components: Components = {
    a({ href, children }) {
      if (href && onNavigate && !href.startsWith('http') && href.endsWith('.md')) {
        const relativePath = href.replace(/^\/+/, '');
        return (
          <a
            href="#"
            className="md-internal-link"
            onClick={(e) => {
              e.preventDefault();
              onNavigate(relativePath);
            }}
          >
            {children}
          </a>
        );
      }
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
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}

function trunc(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Detect the sentinel error that signals missing Google Workspace auth. */
function isWorkspaceAuthRequired(tc: ToolCallInfo): boolean {
  return (
    tc.name.startsWith('gw_') &&
    tc.result != null &&
    typeof tc.result === 'object' &&
    (tc.result as Record<string, unknown>).error === '__WORKSPACE_AUTH_REQUIRED__'
  );
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
    case 'undo_edit':
      return { icon: '↶', text: path ? `Undo edit: ${path}` : 'Undo edit' };
    case 'create_file':
      return { icon: '📄', text: path ? `Create ${path}` : 'Create file' };
    case 'git_status':
      return { icon: '🌿', text: 'Git status' };
    case 'git_diff':
      return { icon: '🌿', text: path ? `Git diff: ${path}` : 'Git diff' };
    case 'git_log':
      return { icon: '🌿', text: 'Git log' };
    case 'git_commit':
    case 'commit':
      return { icon: '🌿', text: str('message') ? `Commit: ${trunc(str('message'), 50)}` : 'Commit' };
    case 'web_search':
      return { icon: '🔍', text: `Search: "${trunc(str('query'), 50)}"` };

    // --- Browser MCP tools ---
    case 'browser_navigate':
      return { icon: '🔗', text: `Navigate to ${trunc(str('url'), 50) || 'URL'}` };
    case 'browser_snapshot':
      return { icon: '📸', text: 'Page snapshot' };
    case 'browser_click':
      return { icon: '🖱️', text: `Click ${trunc(str('element') || str('text'), 40) || 'element'}` };
    case 'browser_type':
      return { icon: '⌨️', text: `Type "${trunc(str('text'), 40)}"` };
    case 'browser_press_key':
      return { icon: '⌨️', text: `Press ${str('key') || 'key'}` };

    // --- Google Workspace MCP tools ---
    case 'gw_search_emails':
      return { icon: '📧', text: `Search emails: "${trunc(str('query'), 40)}"` };
    case 'gw_read_email':
      return { icon: '📧', text: `Read email ${trunc(str('messageId'), 20)}` };
    case 'gw_list_calendars':
      return { icon: '📅', text: 'List calendars' };
    case 'gw_list_events':
      return { icon: '📅', text: 'List events' };
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
 * Merge consecutive assistant messages into one. The UI may split a single
 * LLM turn into multiple assistant bubbles (text before/after tool calls),
 * but the LLM API expects alternating user/assistant roles.
 */
export function mergeConsecutiveAssistants(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const m of messages) {
    const last = result[result.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content += (last.content && m.content ? '\n' : '') + m.content;
    } else {
      result.push({ ...m });
    }
  }
  return result;
}

/**
 * Reconstruct in-memory chat state (messages, past turns, proposed changes)
 * from a persisted `StoredEvent[]` timeline.
 */
export function restoreFromEvents(events: StoredEvent[]): {
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

/**
 * Check whether a turn has completed in the stored event timeline.
 * Returns true if there's an assistant message after the last user message
 * matching `userContent`.
 */
function isTurnComplete(events: StoredEvent[], userContent: string): boolean {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'user' && events[i].content === userContent) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  for (let i = lastUserIdx + 1; i < events.length; i++) {
    if (events[i].kind === 'assistant') return true;
  }
  return false;
}

export function ChatPanel({ bundleId, bundleName, bundleIcon, onFilesChanged, onNavigate }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  /** True while reconnecting after a stream drop (shows badge, keeps loading state). */
  const [reconnecting, setReconnecting] = useState(false);
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

  /** Set when a gw_ tool returns the auth sentinel — triggers redirect to login. */
  const [workspaceExpired, setWorkspaceExpired] = useState(false);

  /** Count of uncommitted changes from git status (0 when clean/unknown). */
  const [gitInsertions, setGitInsertions] = useState(0);
  const [gitDeletions, setGitDeletions] = useState(0);

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

  /** AbortController for the in-flight chat stream (null when idle). */
  const abortRef = useRef<AbortController | null>(null);
  /** True when the user explicitly pressed STOP (vs. a network drop). */
  const stoppedRef = useRef(false);

  // When a gw_ tool reports expired auth, redirect to Google login with
  // ?reconnect=1 to obtain a fresh refresh token.
  useEffect(() => {
    if (workspaceExpired) reconnectWithGoogle();
  }, [workspaceExpired]);

  // Smart auto-scroll: only follow new content if the user is already at
  // (or near) the bottom. Scrolling up pauses auto-follow; scrolling back to
  // the bottom resumes it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, turnEvents, pastTurns, proposedChanges, loading, stickToBottom]);

  /**
   * Refresh the chat list from the server and sync the active chat title.
   * Called after each turn since the server is now the source of truth for
   * persistence (including auto-titling).
   */
  const refreshChatList = useCallback(async (): Promise<void> => {
    try {
      const refreshed = await listChats(bundleId);
      setChatList(refreshed);
      const current = refreshed.find((c) => c.id === chatIdRef.current);
      if (current && current.title !== chatTitleRef.current) {
        chatTitleRef.current = current.title;
        setChatTitle(current.title);
      }
    } catch {
      // best-effort
    }
  }, [bundleId]);

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

  /** Fetch the current git status and update the badge. Best-effort. */
  const refreshGitStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await getGitStatus(bundleId);
      setGitInsertions(status.isClean ? 0 : status.insertions);
      setGitDeletions(status.isClean ? 0 : status.deletions);
    } catch {
      // Git status is best-effort — leave the previous count in place.
    }
  }, [bundleId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    stoppedRef.current = false;

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
    // The UI may have consecutive assistant messages (split at tool-call
    // boundaries). Merge them for the API call to keep alternating roles.
    const apiHistory = mergeConsecutiveAssistants(history);
    const preTurnPastTurns = pastTurnsRef.current;

    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setTurnEvents([]);
    setLoading(true);
    setMessages(history);

    const controller = new AbortController();
    abortRef.current = controller;

    // Local tracking for this turn (mirrors the setTurnEvents/setProposedChanges
    // calls so we can compute the final snapshot accurately).
    const turnEventsLocal: TurnEvent[] = [];
    let acc = '';

    try {
      for await (const ev of streamChat(bundleId, apiHistory, chatIdRef.current, controller.signal)) {
        const data = ev.data;

        if (ev.event === 'content') {
          const obj = data as { text?: unknown };
          if (typeof obj.text === 'string') {
            acc += obj.text;
            appendContent(obj.text);
            // Also track in local for finalization ordering (preserves
            // the correct content-to-tool interleaving).
            const last = turnEventsLocal[turnEventsLocal.length - 1];
            if (last && last.kind === 'content') {
              turnEventsLocal[turnEventsLocal.length - 1] = { kind: 'content', text: last.text + obj.text };
            } else {
              turnEventsLocal.push({ kind: 'content', text: obj.text });
            }
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

          // Detect expired Workspace auth — trigger redirect to login.
          if (isWorkspaceAuthRequired(toolCall)) {
            setWorkspaceExpired(true);
          }

          // Refresh git badge after commits and file edits.
          if (toolCall.name === 'git_commit' || toolCall.name === 'edit_file' || toolCall.name === 'undo_edit' || toolCall.name === 'create_file') {
            void refreshGitStatus();
          }
        } else if (ev.event === 'edit_applied') {
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
          turnEventsLocal.push(te);
          onFilesChanged?.();
          void refreshGitStatus();
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
      // If the user pressed STOP, do a one-shot sync with the server to
      // pick up any tool results or content that were persisted after we
      // aborted the SSE stream. The server breaks out of its loop quickly
      // but may have completed in-flight tool calls.
      if (stoppedRef.current) {
        const id = chatIdRef.current;
        if (id) {
          // Brief delay to let the server finish persisting.
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const session = await loadChat(bundleId, id);
            const restored = restoreFromEvents(session.events);
            setMessages(restored.messages);
            setPastTurns(restored.pastTurns);
            setProposedChanges(restored.proposedChanges);
            setTurnEvents([]);
            setLoading(false);
            abortRef.current = null;
            void refreshChatList();
            void refreshGitStatus();
            return;
          } catch {
            // Sync failed — fall through to client-side finalization below.
          }
        }
        // Fall through to finalization below.
      } else {
        // Attempt to recover by polling the server. The server keeps running the
        // agentic loop after the client disconnects, persisting each event. We poll
        // until the turn completes (assistant message appears after our user msg),
        // then rebuild state from the server timeline.
        const id = chatIdRef.current;
        if (id) {
          setReconnecting(true);
          let recovered = false;
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const session = await loadChat(bundleId, id);
              if (isTurnComplete(session.events, text)) {
                const restored = restoreFromEvents(session.events);
                setMessages(restored.messages);
                setPastTurns(restored.pastTurns);
                setProposedChanges(restored.proposedChanges);
                setTurnEvents([]);
                setLoading(false);
                setReconnecting(false);
                void refreshChatList();
                void refreshGitStatus();
                recovered = true;
                break;
              }
            } catch {
              // keep polling
            }
          }
          setReconnecting(false);
          if (recovered) return;
        }
        // Reconnection failed — show the error
        const chatError = err instanceof Error ? err.message : 'Chat request failed';
        const errEvent: TurnEvent = { kind: 'error', text: chatError };
        turnEventsLocal.push(errEvent);
        setTurnEvents((prev) => [...prev, errEvent]);
      }
    }

    abortRef.current = null;

    // Split turnEventsLocal into segments at content/non-content boundaries.
    // Each content segment becomes an assistant message; non-content events
    // (tool calls, proposed changes, errors) become the pastTurns entry for
    // the FOLLOWING assistant message. This preserves the correct visual
    // ordering (text before tools, more text after, etc.).
    const segMessages: ChatMessage[] = [];
    const segTurns: TurnEvent[][] = [];
    let pendingEvents: TurnEvent[] = [];

    for (const ev of turnEventsLocal) {
      if (ev.kind === 'content') {
        // Content arrives — flush pending tools as the pastTurns for this
        // content's assistant message.
        segMessages.push({ role: 'assistant', content: ev.text });
        segTurns.push(pendingEvents);
        pendingEvents = [];
      } else {
        pendingEvents.push(ev);
      }
    }

    // Handle trailing tools with no content after them — anchor with an
    // empty-content assistant message (the rendering skips empty bubbles).
    if (pendingEvents.length > 0) {
      segMessages.push({ role: 'assistant', content: '' });
      segTurns.push(pendingEvents);
    }

    // If there were no events at all, keep history unchanged.
    const finalMessages = segMessages.length > 0 ? [...history, ...segMessages] : history;
    const finalPastTurns = segMessages.length > 0 ? [...preTurnPastTurns, ...segTurns] : preTurnPastTurns;

    // Commit to state.
    setMessages(finalMessages);
    setPastTurns(finalPastTurns);
    setTurnEvents([]);
    setLoading(false);

    // Refresh chat list (server is now source of truth for persistence + title).
    void refreshChatList();
  }, [bundleId, input, loading, appendContent, onFilesChanged, refreshGitStatus, refreshChatList]);

  /** Stop the in-flight chat stream immediately (user pressed STOP). */
  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  }, []);

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

  /**
   * Jump to bottom on End key (anywhere in the chat panel) and resume
   * auto-scroll. Home jumps to the top.
   */
  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = scrollRef.current;
    if (!el) return;
    if (e.key === 'End') {
      e.preventDefault();
      el.scrollTop = el.scrollHeight;
      setStickToBottom(true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      el.scrollTop = 0;
      setStickToBottom(false);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      el.scrollTop -= el.clientHeight * 0.85;
      setStickToBottom(false);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      el.scrollTop += el.clientHeight * 0.85;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      setStickToBottom(atBottom);
    }
  };

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
      onKeyDown={handlePanelKeyDown}
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
        {(gitInsertions > 0 || gitDeletions > 0) && (
          <button
            type="button"
            className="chat-git-badge"
            title={`${gitInsertions} insertion(s), ${gitDeletions} deletion(s) uncommitted`}
            onClick={() => {
              setInput('Show me the git status');
              void handleSend();
            }}
          >
            <span className="git-ins">+{gitInsertions}</span>
            <span className="git-del">−{gitDeletions}</span>
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

      <div className="chat-messages" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
      }}>
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
                  if (ev.kind === 'content') {
                    // Render inline content (between tool calls) as a bubble.
                    return (
                      <div className="chat-message chat-message-assistant" key={`pc${i}-${j}`}>
                        <span className="chat-author">GLM</span>
                        <div className="chat-bubble"><ChatMarkdown content={ev.text} onNavigate={onNavigate} /></div>
                      </div>
                    );
                  }
                  if (ev.kind === 'tool') {
                    if (isWorkspaceAuthRequired(ev.toolCall)) {
                      return (
                        <div className="chat-error-event" key={`pt${i}-${j}`}>
                          ⚠️ Google Workspace session expired — redirecting to login…
                        </div>
                      );
                    }
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
                {(m.role === 'user' || m.content.trim()) && (
                  <div
                    className={`chat-message chat-message-${m.role === 'user' ? 'user' : 'assistant'}`}
                  >
                    {m.role !== 'user' && <span className="chat-author">GLM</span>}
                    <div className="chat-bubble"><ChatMarkdown content={m.content} onNavigate={onNavigate} /></div>
                  </div>
                )}
              </Fragment>
            );
          });
        })()}

        {/* Current turn — events rendered in arrival order. */}
        {turnEvents.map((ev, i) => {
          if (ev.kind === 'tool') {
            if (isWorkspaceAuthRequired(ev.toolCall)) {
              return (
                <div className="chat-error-event" key={`t${i}`}>
                  ⚠️ Google Workspace session expired — redirecting to login…
                </div>
              );
            }
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
                <div className="chat-bubble"><ChatMarkdown content={ev.text} onNavigate={onNavigate} /></div>
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

        {reconnecting && (
          <div className="chat-reconnecting">
            <span className="spinner spinner-sm" />
            <span>Connection lost — reconnecting…</span>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          placeholder="Message GLM…  (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={loading}
          onChange={(e) => {
            setInput(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
          }}
          onKeyDown={handleKeyDown}
        />
        {loading ? (
          <button
            type="button"
            className="btn btn-danger chat-send-btn"
            onClick={handleStop}
            aria-label="Stop generation"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary chat-send-btn"
            onClick={() => void handleSend()}
            disabled={!input.trim()}
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3.4 20.4 21 12 3.4 3.6 3.39 10l12 2-12 2z"
              />
            </svg>
            <span>Send</span>
          </button>
        )}
      </div>
    </div>
  );
}

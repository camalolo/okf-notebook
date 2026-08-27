import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkPlugins, rehypePlugins } from '../lib/markdown.ts';
import type { KeyboardEvent } from 'react';
import type {
  ChatMessage,
  ChatSession,
  ChatSummary,
  ProposedChange,
  StoredEvent,
  ToolCallInfo,
  TurnEvent,
} from '../types.ts';
import { streamChat, attachChatStream, TurnGoneError } from '../services/chat.ts';
import type { ChatSSEEvent } from '../services/chat.ts';
import {
  abortChat,
  compactChat,
  createChat,
  deleteChat,
  getGitStatus,
  getSettings,
  listChats,
  loadChat,
  retitleChat,
  uploadFile,
} from '../services/api.ts';
import type { UploadResult } from '../services/api.ts';
import { ProposedChangeCard } from './ProposedChangeCard.tsx';
import {
  isLastTurnComplete,
  isTurnComplete,
  mergeConsecutiveAssistants,
  restoreFromEvents,
} from './chat-restore.ts';
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

/** Per-turn mutable state shared by the stream event processor. */
interface TurnSink {
  /** Same role as the old turnEventsLocal — drives rendering + finalization. */
  events: TurnEvent[];
  /** Set when the terminal `done` SSE event arrives. */
  gotDone: boolean;
  /** Last server stream id seen — the reconnect cursor. */
  lastId: number;
}

// --- Stream-position persistence (reconnect across page reloads) -------------
//
// The last seen SSE event id is stored per chat so a page reload mid-turn can
// re-attach to the server's buffered stream (true reconnect) instead of
// falling back to timeline polling.

function streamPosKey(bundleId: string, chatId: string): string {
  return `nb-str:${bundleId}:${chatId}`;
}

function readStreamPos(bundleId: string, chatId: string): number | null {
  try {
    const raw = localStorage.getItem(streamPosKey(bundleId, chatId));
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function storeStreamPos(bundleId: string, chatId: string | null, sink: TurnSink): void {
  if (!chatId || sink.lastId < 0) return;
  try {
    localStorage.setItem(streamPosKey(bundleId, chatId), String(sink.lastId));
  } catch {
    // storage unavailable — reconnect after reload degrades to polling
  }
}

function clearStreamPos(bundleId: string, chatId: string | null): void {
  if (!chatId) return;
  try {
    localStorage.removeItem(streamPosKey(bundleId, chatId));
  } catch {
    // ignore
  }
}

/**
 * Live/collapsed display of a thinking model's chain-of-thought.
 * Auto-expanded while it is the streaming frontier ("live"); collapses to a
 * compact chip once content or tool calls take over. The user's click
 * overrides the automatic behavior for the component's lifetime.
 */
const ThinkingBlock = memo(function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const bodyRef = useRef<HTMLPreElement>(null);

  // Keep the newest reasoning in view while streaming.
  useEffect(() => {
    if (open && live && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, open, live]);

  const chars = text.length;
  // Collapsed = a chip sibling of the tool chips (💭 · same pill styling);
  // expanded = the streaming box. `live` only while it's the frontier.
  const label = live ? 'Thinking…' : `${chars.toLocaleString()} chars reasoning`;

  return (
    <div
      className={`chat-thinking${live ? ' chat-thinking-live' : ''}${open ? ' chat-thinking-open' : ''}`}
    >
      <button
        type="button"
        className="chat-thinking-header"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
      >
        <span className="chat-thinking-icon" aria-hidden="true">💭</span>
        <span className="chat-thinking-label">{label}</span>
        <span className="chat-thinking-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="chat-thinking-body" ref={bodyRef}>{text}</pre>
      )}
    </div>
  );
});

/** Renders markdown content inside chat bubbles (GFM tables, code, etc.).
 *  Memoized: the composer's `input` state re-renders the whole history on
 *  every keystroke — without memo, remark re-parses every settled message
 *  each keystroke and typing feels sluggish. */
const ChatMarkdown = memo(function ChatMarkdown({
  content,
  onNavigate,
}: {
  content: string;
  onNavigate?: (path: string) => void;
}) {
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
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});

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
    case 'erc20_balances': {
      const addr = str('address');
      const short = addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : 'address';
      return { icon: '🪙', text: `ERC-20 balances: ${short} on ${str('chain') || 'chain'}` };
    }

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
 * Rough token estimate (~4 chars/token) for the conversation context.
 * Excludes the server-side system prompt (AGENTS.md, OKF.md, file list).
 */
/**
 * Rough context-size estimate used until the first exact usage report of a
 * turn arrives (the API's final-chunk prompt_tokens replaces it).
 *
 * What is actually sent per turn: the system prompt + tool definitions
 * (server-side; approximated by a constant), the user/assistant messages
 * since the last compaction, and — only while the turn is running — its
 * own tool results (each round re-sends them). PAST turns' tool results
 * are dropped by the next request and must NOT be counted (they once
 * inflated the estimate to ~10× reality, nagging "compact" at 254K for a
 * ~10K context). Their visible text is already in `messages`.
 */
const CTX_SERVER_OVERHEAD = 4_000; // system prompt (AGENTS/OKF/file list) + tool defs

function estimateContextTokens(
  messages: ChatMessage[],
  _pastTurns: TurnEvent[][], // deliberately ignored — see above
  turnEvents: TurnEvent[],
): number {
  let chars = CTX_SERVER_OVERHEAD * 4;
  for (const m of messages) {
    chars += m.content.length + 8; // role + formatting overhead
  }
  const addTurnEvent = (ev: TurnEvent) => {
    // 'thinking' is display-only — reasoning is never resent to the LLM, so
    // it contributes nothing to the context estimate (nor do 'notice's).
    if (ev.kind === 'content') {
      chars += ev.text.length;
    } else if (ev.kind === 'tool') {
      chars += ev.toolCall.name.length + 16;
      chars += JSON.stringify(ev.toolCall.args).length;
      chars += JSON.stringify(ev.toolCall.result ?? '').length;
    } else if (ev.kind === 'proposed') {
      chars += (ev.change.oldContent?.length ?? 0) + ev.change.newContent.length;
    } else if (ev.kind === 'error') {
      chars += ev.text.length;
    }
  };
  for (const ev of turnEvents) addTurnEvent(ev);
  return Math.ceil(chars / 4);
}

/** Fallback context window for colouring until the server reports the
 *  active model's limit (glm → 1M; conservative default otherwise). */
const CTX_LIMIT_DEFAULT = 128_000;

function formatCtxTokens(tokens: number, limit: number): { label: string; level: string } {
  const label =
    tokens >= 10_000
      ? `${Math.round(tokens / 1000)}K`
      : tokens >= 1000
        ? `${(tokens / 1000).toFixed(1)}K`
        : String(tokens);
  const pct = limit > 0 ? tokens / limit : 0;
  const level = pct > 0.8 ? 'high' : pct > 0.5 ? 'mid' : 'low';
  return { label, level };
}

export function ChatPanel({ bundleId, bundleName, bundleIcon, onFilesChanged, onNavigate }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  /** True while reconnecting after a stream drop (shows badge, keeps loading state). */
  const [reconnecting, setReconnecting] = useState(false);
  /** True while following a still-running turn after a page reload (not an
   *  error state — the banner dismisses once progress renders). */
  const [following, setFollowing] = useState(false);
  /** The last turn was interrupted (server restart) and can be resumed. */
  const [resumable, setResumable] = useState(false);
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
  const [gitUntracked, setGitUntracked] = useState(0);

  /** Pending files selected but not yet uploaded (uploaded on Send). */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  /** True while files are being uploaded/extracted during send. */
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  /** Drag-over visual state for the input area. */
  const [dragOver, setDragOver] = useState(false);

  /** Index of the last compaction summary in `messages` (null if none). */
  const [compactionIndex, setCompactionIndex] = useState<number | null>(null);
  const compactionIndexRef = useRef<number | null>(null);
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  useEffect(() => {
    compactionIndexRef.current = compactionIndex;
  }, [compactionIndex]);

  /** Estimated conversation context tokens (only active context after last compaction). */
  const estimatedCtxTokens = useMemo(() => {
    const start = compactionIndex ?? 0;
    const activeMessages = messages.slice(start);
    // Count how many assistant messages are before the compaction point so
    // we can offset the pastTurns array accordingly.
    let assistantOffset = 0;
    for (let i = 0; i < start; i++) {
      if (messages[i].role === 'assistant') assistantOffset++;
    }
    const activePastTurns = pastTurns.slice(assistantOffset);
    return estimateContextTokens(activeMessages, activePastTurns, turnEvents);
  }, [messages, pastTurns, turnEvents, compactionIndex]);

  /**
   * Exact context size reported by the API (final-chunk usage of the last
   * LLM call) — replaces the estimate while streaming, since the estimate
   * over-counts tool results that are not resent to the model. Falls back
   * to the estimate before the first usage event of a turn.
   */
  const [exactPromptTokens, setExactPromptTokens] = useState<number | null>(null);
  const ctxTokens = exactPromptTokens ?? estimatedCtxTokens;

  /** The active model's context window — colours the indicator. Sourced
   *  from Settings on mount and from each usage event afterwards. */
  const [ctxLimit, setCtxLimit] = useState(CTX_LIMIT_DEFAULT);
  useEffect(() => {
    getSettings()
      .then((info) => {
        if (typeof info.contextLimit === 'number' && info.contextLimit > 0) {
          setCtxLimit(info.contextLimit);
        }
      })
      .catch(() => {});
  }, []);

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
  /**
   * Generation counter for the background-turn watcher. Bumping it cancels
   * any running watcher (switching chats, new chat, unmount, sending).
   */
  const watchGenRef = useRef(0);

  // Cancel any background watcher on unmount.
  useEffect(() => () => { watchGenRef.current++; }, []);

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

  /**
   * Replace the whole chat state from a server session (used by STOP-sync,
   * reconnect recovery, and the background-turn watcher).
   */
  const applySession = useCallback((session: ChatSession) => {
    const restored = restoreFromEvents(session.events);
    setMessages(restored.messages);
    setPastTurns(restored.pastTurns);
    setProposedChanges(restored.proposedChanges);
    setCompactionIndex(restored.compactionIndex);
    compactionIndexRef.current = restored.compactionIndex;
    setTurnEvents([]);
    setResumable(restored.lastTurnInterrupted);
    // Exact context of the last completed round — persisted server-side, so
    // a reloaded chat keeps the real number instead of the estimate.
    setExactPromptTokens(
      typeof session.lastUsage?.promptTokens === 'number'
        ? session.lastUsage.promptTokens
        : null,
    );
  }, []);

  /**
   * Apply an in-progress timeline during recovery (stream drop / page reload
   * while the server keeps running the turn). Renders the open turn's events
   * as the live turn timeline — tool calls surface as they are persisted
   * instead of the UI freezing until the turn completes.
   */
  const applyPartialSession = useCallback((session: ChatSession) => {
    const restored = restoreFromEvents(session.events, { openTurnLive: true });
    setMessages(restored.messages);
    setPastTurns(restored.pastTurns);
    setProposedChanges(restored.proposedChanges);
    setCompactionIndex(restored.compactionIndex);
    compactionIndexRef.current = restored.compactionIndex;
    setTurnEvents(restored.liveTurnEvents);
    setResumable(restored.lastTurnInterrupted);
    if (typeof session.lastUsage?.promptTokens === 'number') {
      setExactPromptTokens(session.lastUsage.promptTokens);
    }
  }, []);

  /** Fetch the current git status and update the badge. Best-effort. */
  const refreshGitStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await getGitStatus(bundleId);
      setGitInsertions(status.isClean ? 0 : status.insertions);
      setGitDeletions(status.isClean ? 0 : status.deletions);
      setGitUntracked(status.isClean ? 0 : (status.not_added?.length ?? 0));
    } catch {
      // Git status is best-effort — leave the previous count in place.
    }
  }, [bundleId]);

  /**
   * Watch a chat whose turn is still running server-side (page reloaded or
   * recovery polling gave up mid-turn). Polls the persisted timeline until
   * the server records the turn's end, then restores the full state.
   * Cancelled by bumping watchGenRef (selecting/creating a chat, unmount).
   */
  const watchBackgroundTurn = useCallback(
    (id: string) => {
      const gen = ++watchGenRef.current;
      setLoading(true);
      setFollowing(true);
      void (async () => {
        // TRUE reconnect after a reload: when a stream position was stored
        // for this chat (a tab of this browser was streaming the turn), skip
        // polling — re-attach with a FULL replay and drive the same live
        // pipeline (thinking cards included). Falls through to polling when
        // there is nothing to attach to.
        if (readStreamPos(bundleId, id) !== null) {
          const sink: TurnSink = { events: [], gotDone: false, lastId: -1 };
          try {
            setTurnEvents([]);
            let errored = false;
            for await (const ev of attachChatStream(bundleId, id, -1)) {
              if (watchGenRef.current !== gen) return;
              try {
                processStreamEvent(ev, sink);
                storeStreamPos(bundleId, id, sink);
              } catch {
                errored = true; // terminal error event — sync from the timeline
                break;
              }
              if (sink.gotDone) break;
            }
            if (watchGenRef.current !== gen) return;
            if (sink.gotDone || errored) {
              clearStreamPos(bundleId, id);
              try {
                const session = await loadChat(bundleId, id);
                if (session) applySession(session);
              } catch {
                // best-effort — polling below would also settle it
              }
              setLoading(false);
              setFollowing(false);
              void refreshChatList();
              void refreshGitStatus();
              return;
            }
            // The attach stream dropped without `done` — everything replayed
            // so far is rendered; keep following via polling below.
          } catch {
            // gone (turn ended >60s ago / restarted) or network — polling.
          }
        }

        // Polling fallback — the open turn's events render live as the
        // server persists them. 2.5s × 120 = up to 5 minutes; long LLM turns
        // with tool loops can run for minutes, and the server keeps going
        // after disconnects.
        for (let attempt = 0; attempt < 120; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
          if (watchGenRef.current !== gen) return;
          try {
            const session = await loadChat(bundleId, id);
            if (watchGenRef.current !== gen) return;
            if (isLastTurnComplete(session.events)) {
              applySession(session);
              setLoading(false);
              setFollowing(false);
              clearStreamPos(bundleId, id);
              void refreshChatList();
              void refreshGitStatus();
              return;
            }
            applyPartialSession(session);
            // Progress is rendering in the chat itself — the "still
            // running" banner has done its job; dismiss it.
            setFollowing(false);
          } catch {
            // network hiccup — keep polling
          }
        }
        // Gave up (e.g. server restarted mid-turn) — stop the indicators.
        if (watchGenRef.current === gen) {
          setLoading(false);
          setFollowing(false);
        }
      })();
    },
    [bundleId, applySession, applyPartialSession, refreshChatList, refreshGitStatus],
  );

  /** Queue selected files for upload on next Send (no upload yet). */
  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setPendingFiles((prev) => [...prev, ...Array.from(fileList)]);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const closeCamera = useCallback(() => {
    stopCamera();
    setCameraOpen(false);
    setCameraError(null);
  }, [stopCamera]);

  const openCamera = useCallback(async () => {
    setCameraError(null);
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCameraError(
        msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Camera access was denied. Allow camera permission in your browser.'
          : msg.includes('NotFound') || msg.includes('Devices')
            ? 'No camera found on this device.'
            : `Camera error: ${msg}`,
      );
    }
  }, []);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
        handleFiles({ 0: file, length: 1 } as unknown as FileList);
      }
      closeCamera();
    }, 'image/jpeg', 0.92);
  }, [handleFiles, closeCamera]);

  // Cleanup camera on unmount
  useEffect(() => stopCamera, [stopCamera]);

  /**
   * Shared turn runner: streams one chat turn to completion and owns the
   * event switch, drop recovery, STOP sync, and finalization. Used by both
   * handleSend (new user message) and handleResume (continue an interrupted
   * turn — the server rebuilds the history from the timeline in that case,
   * so apiHistory is empty).
   */
  /**
   * Shared SSE event processor — the single event→UI switch used by every
   * stream consumer: the live POST stream, drop-reconnect attaches, and the
   * reload re-attach (watchBackgroundTurn). Mutates the caller's sink.
   * Throws on `error` events (callers treat as stream failure).
   */
  const processStreamEvent = (ev: ChatSSEEvent, sink: TurnSink): void => {
    if (typeof ev.id === 'number') sink.lastId = ev.id;
    const data = ev.data;

    if (ev.event === 'usage') {
      // Exact per-call token usage from the API's final chunk. The
      // prompt size is the true context of the last LLM call.
      const obj = data as { promptTokens?: unknown; contextLimit?: unknown };
      if (typeof obj.promptTokens === 'number') {
        setExactPromptTokens(obj.promptTokens);
      }
      if (typeof obj.contextLimit === 'number' && obj.contextLimit > 0) {
        setCtxLimit(obj.contextLimit);
      }
    } else if (ev.event === 'thinking') {
      // Chain-of-thought from a thinking model, streamed before the
      // visible answer. Transient display only — coalesced into the
      // trailing thinking event, never resent to the LLM, not persisted.
      const obj = data as { text?: unknown };
      if (typeof obj.text === 'string') {
        setTurnEvents((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'thinking') {
            return [...prev.slice(0, -1), { kind: 'thinking', text: last.text + obj.text }];
          }
          return [...prev, { kind: 'thinking', text: obj.text as string }];
        });
        const last = sink.events[sink.events.length - 1];
        if (last && last.kind === 'thinking') {
          sink.events[sink.events.length - 1] = { kind: 'thinking', text: last.text + obj.text };
        } else {
          sink.events.push({ kind: 'thinking', text: obj.text });
        }
      }
    } else if (ev.event === 'content') {
      const obj = data as { text?: unknown };
      if (typeof obj.text === 'string') {
        appendContent(obj.text);
        // Also track in local for finalization ordering (preserves
        // the correct content-to-tool interleaving).
        const last = sink.events[sink.events.length - 1];
        if (last && last.kind === 'content') {
          sink.events[sink.events.length - 1] = { kind: 'content', text: last.text + obj.text };
        } else {
          sink.events.push({ kind: 'content', text: obj.text });
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
      sink.events.push(te);

      // Detect expired Workspace auth — trigger redirect to login.
      if (isWorkspaceAuthRequired(toolCall)) {
        setWorkspaceExpired(true);
      }

      // Refresh git badge after commits and file edits.
      if (toolCall.name === 'git_commit' || toolCall.name === 'edit_file' || toolCall.name === 'undo_edit' || toolCall.name === 'create_file' || toolCall.name === 'delete_file') {
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
        type:
          obj.type === 'create' ? 'create'
          : obj.type === 'delete' ? 'delete'
          : 'edit',
        path: typeof obj.path === 'string' ? obj.path : '',
        oldContent:
          typeof obj.oldContent === 'string' ? obj.oldContent : undefined,
        newContent: typeof obj.newContent === 'string' ? obj.newContent : '',
        status: 'applied',
      };
      setProposedChanges((prev) => [...prev, change]);
      const te: TurnEvent = { kind: 'proposed', change };
      setTurnEvents((prev) => [...prev, te]);
      sink.events.push(te);
      onFilesChanged?.();
      void refreshGitStatus();
    } else if (ev.event === 'retry') {
      // The server hit a transient upstream failure and is retrying.
      // Partial content from the failed attempt is discarded (the full
      // answer is re-streamed), so drop trailing content and show a
      // transient notice while the retry is in flight.
      const obj = data as { attempt?: unknown; maxAttempts?: unknown; reason?: unknown };
      const attempt = typeof obj.attempt === 'number' ? obj.attempt : '?';
      const maxAttempts = typeof obj.maxAttempts === 'number' ? obj.maxAttempts : '?';
      const reason = typeof obj.reason === 'string' ? `: ${trunc(obj.reason, 80)}` : '';
      while (
        sink.events.length > 0 &&
        (sink.events[sink.events.length - 1].kind === 'content' ||
          sink.events[sink.events.length - 1].kind === 'thinking')
      ) {
        sink.events.pop();
      }
      setTurnEvents((prev) => {
        const p = [...prev];
        while (
          p.length > 0 &&
          (p[p.length - 1].kind === 'content' || p[p.length - 1].kind === 'thinking')
        ) p.pop();
        return p;
      });
      const te: TurnEvent = {
        kind: 'notice',
        text: `Upstream hiccup${reason} — retrying (attempt ${attempt}/${maxAttempts})…`,
      };
      setTurnEvents((prev) => [...prev, te]);
      sink.events.push(te);
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
      sink.events.push(te);
    } else if (ev.event === 'done') {
      sink.gotDone = true;
    } else if (ev.event === 'error') {
      const obj = data as { message?: unknown };
      throw new Error(
        typeof obj.message === 'string' ? obj.message : 'Chat error',
      );
    }
  };

  const runTurn = useCallback(async (opts: {
    /** Messages for the API (empty in resume mode — server-side reconstruction). */
    apiHistory: ChatMessage[];
    /** History the turn's output is appended to (finalization base). */
    baseMessages: ChatMessage[];
    basePastTurns: TurnEvent[][];
    resume?: boolean;
    /** Recovery-poll completion predicate over the server timeline. */
    isComplete: (events: StoredEvent[]) => boolean;
  }) => {
    const controller = new AbortController();
    abortRef.current = controller;
    // New turn: the exact-context override from the previous turn no longer
    // applies (history grew) until the first usage event of this turn.
    setExactPromptTokens(null);
    const { resume = false, isComplete } = opts;

    // Local tracking for this turn (mirrors the setTurnEvents/setProposedChanges
    // calls so we can compute the final snapshot accurately) + the reconnect
    // cursor (lastId). A stream that ends cleanly *without* `done` means an
    // intermediary (e.g. nginx proxy_read_timeout) closed the connection
    // mid-turn — true reconnect is attempted before polling recovery.
    const sink: TurnSink = { events: [], gotDone: false, lastId: readStreamPos(bundleId, chatIdRef.current ?? '') ?? -1 };
    let streamErr: unknown = null;

    try {
      for await (const ev of streamChat(bundleId, opts.apiHistory, chatIdRef.current, controller.signal, resume ? { resume: true } : undefined)) {
        processStreamEvent(ev, sink);
        storeStreamPos(bundleId, chatIdRef.current, sink);
        if (sink.gotDone) break;
      }

      // TRUE reconnect: the primary stream ended without `done` — the server
      // is still running the turn (disconnects are tolerated server-side).
      // Re-attach to the buffered stream and continue live; the old polling
      // recovery below only runs when re-attaching is impossible.
      if (!sink.gotDone && !stoppedRef.current && chatIdRef.current) {
        for (let attempt = 0; attempt < 6 && !sink.gotDone && !stoppedRef.current; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (stoppedRef.current) break;
          try {
            for await (const ev of attachChatStream(bundleId, chatIdRef.current, sink.lastId, controller.signal)) {
              processStreamEvent(ev, sink);
              storeStreamPos(bundleId, chatIdRef.current, sink);
              if (sink.gotDone) break;
            }
          } catch (attachErr) {
            if (attachErr instanceof TurnGoneError) break; // turn ended — sync below
            // transient attach failure — retry
          }
        }
      }
    } catch (err) {
      streamErr = err;
    }

    if (streamErr || !sink.gotDone) {
      // If the user pressed STOP, poll the server timeline briefly until the
      // aborted turn's end is persisted, then sync from it. The server breaks
      // out of its loop quickly but may have completed in-flight tool calls.
      if (stoppedRef.current) {
        const id = chatIdRef.current;
        if (id) {
          for (let i = 0; i < 10; i++) {
            // First wait lets the server finish persisting the abort.
            await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 1000));
            try {
              const session = await loadChat(bundleId, id);
              if (isComplete(session.events)) {
                applySession(session);
                setLoading(false);
                abortRef.current = null;
                void refreshChatList();
                void refreshGitStatus();
                return;
              }
            } catch {
              // keep trying
            }
          }
          // Sync failed — fall through to client-side finalization below.
        }
        // Fall through to finalization below.
      } else {
        // Attempt to recover by polling the server. The server keeps running
        // the agentic loop after the client disconnects (mobile network drop,
        // proxy timeout, …), persisting each event. We poll until the turn
        // completes (turn_end recorded after our user message), then rebuild
        // state from the server timeline. LLM turns can take minutes, so this
        // polls for up to 5 minutes; a page reload mid-turn also resumes via
        // the background watcher on chat load.
        const id = chatIdRef.current;
        if (id) {
          setReconnecting(true);
          let recovered = false;
          for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 2500));
            if (stoppedRef.current) {
              // User pressed STOP while reconnecting — cancel the
              // server-side turn and do a final sync below.
              void abortChat(bundleId, id);
              break;
            }
            try {
              const session = await loadChat(bundleId, id);
              if (isComplete(session.events)) {
                applySession(session);
                setLoading(false);
                setReconnecting(false);
                void refreshChatList();
                void refreshGitStatus();
                recovered = true;
                break;
              }
              // Turn still running server-side — surface its progress so far
              // (tool calls etc. render live instead of a frozen banner).
              if (!isLastTurnComplete(session.events)) {
                applyPartialSession(session);
                // Progress is rendering — drop the alarming banner while
                // polling continues.
                setReconnecting(false);
              }
            } catch (pollErr) {
              // Session expired — stop polling, redirect is already triggered.
              if (pollErr instanceof Error && pollErr.message === 'Session expired') {
                break;
              }
              // other errors (network) — keep polling
            }
          }
          setReconnecting(false);
          if (recovered) return;
          // Stopped mid-recovery: give the server a moment to persist the
          // aborted turn's end, then sync from the timeline if it's there.
          if (stoppedRef.current) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const session = await loadChat(bundleId, id);
              if (isComplete(session.events)) {
                applySession(session);
                setLoading(false);
                abortRef.current = null;
                void refreshChatList();
                void refreshGitStatus();
                return;
              }
            } catch {
              // fall through
            }
          }
        }
        // Reconnection failed — show the error. For a clean stream end
        // without `done` there is no Error object; surface a clear message.
        const chatError = stoppedRef.current
          ? 'Generation stopped.'
          : streamErr instanceof Error && streamErr.message
            ? streamErr.message
            : streamErr
              ? 'Chat request failed'
              : 'Connection lost before the response finished.';
        const errEvent: TurnEvent = { kind: 'error', text: chatError };
        sink.events.push(errEvent);
        setTurnEvents((prev) => [...prev, errEvent]);
      }
    }

    abortRef.current = null;

    // Turn finished and finalized — the reconnect cursor is obsolete.
    clearStreamPos(bundleId, chatIdRef.current);

    // Split sink.events into segments at content/non-content boundaries.
    // Each content segment becomes an assistant message; non-content events
    // (tool calls, proposed changes, errors) become the pastTurns entry for
    // the FOLLOWING assistant message. This preserves the correct visual
    // ordering (text before tools, more text after, etc.).
    const segMessages: ChatMessage[] = [];
    const segTurns: TurnEvent[][] = [];
    let pendingEvents: TurnEvent[] = [];

    for (const ev of sink.events) {
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
    const finalMessages = segMessages.length > 0 ? [...opts.baseMessages, ...segMessages] : opts.baseMessages;
    const finalPastTurns = segMessages.length > 0 ? [...opts.basePastTurns, ...segTurns] : opts.basePastTurns;

    // Commit to state.
    setMessages(finalMessages);
    setPastTurns(finalPastTurns);
    setTurnEvents([]);
    setLoading(false);

    // Refresh chat list (server is now source of truth for persistence + title).
    void refreshChatList();
  }, [bundleId, appendContent, applySession, applyPartialSession, onFilesChanged, refreshGitStatus, refreshChatList]);

  /**
   * Resume the last interrupted turn (killed by a server restart, closed by
   * the boot sweep): the server reconstructs the full working state —
   * including the interrupted turn's tool results — and the model continues
   * from there. No new user message is created.
   */
  const handleResume = useCallback(async () => {
    const id = chatIdRef.current;
    if (!id || loading) return;
    try {
      const session = await loadChat(bundleId, id);
      if (!session) return;
      const snapshotLen = session.events.length;
      watchGenRef.current++; // cancel any background watcher
      stoppedRef.current = false;
      setResumable(false);
      setLoading(true);
      await runTurn({
        apiHistory: [],
        baseMessages: messagesRef.current,
        basePastTurns: pastTurnsRef.current,
        resume: true,
        // The resumed turn adds NO user event, so completion = new events
        // landed after our snapshot AND the last turn closed.
        isComplete: (events) => events.length > snapshotLen && isLastTurnComplete(events),
      });
    } catch {
      // Server-side resume rejected or network failed before the stream
      // opened — restore the button.
      setResumable(true);
      setLoading(false);
    }
  }, [bundleId, loading, runTurn]);



  const handleSend = useCallback(async () => {
    const rawText = input.trim();
    if ((!rawText && pendingFiles.length === 0) || loading || uploading) return;
    stoppedRef.current = false;
    watchGenRef.current++; // cancel any background-turn watcher

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

    // Upload pending files (all in parallel) and build the attachment note.
    let attachmentNote = '';
    if (pendingFiles.length > 0) {
      setUploading(true);
      const results = await Promise.allSettled(
        pendingFiles.map((f) => uploadFile(bundleId, f)),
      );
      setUploading(false);

      const ok = results
        .filter((r): r is PromiseFulfilledResult<UploadResult> => r.status === 'fulfilled')
        .map((r) => r.value);
      const failures = results.filter((r) => r.status === 'rejected');

      if (ok.length > 0) {
        attachmentNote = ok
          .map((a) =>
            a.duplicate
              ? `📎 Duplicate upload: "${a.sourceName}" is already in this bundle at ${a.mdPath} (unchanged, not re-imported). Inform the user and reference the existing file.`
              : `📎 Attached: ${a.sourceName} → ${a.mdPath}`,
          )
          .join('\n') + '\n\n';
      }
      if (failures.length > 0) {
        const failedNames = pendingFiles
          .filter((_, i) => results[i].status === 'rejected')
          .map((f) => f.name)
          .join(', ');
        attachmentNote += `[Upload failed for: ${failedNames}]\n\n`;
      }
      onFilesChanged?.();
    }

    // Build final message text.
    const userText = rawText || (attachmentNote ? 'Please refer to this contents:' : '');
    const text = attachmentNote + userText;

    const userMsg: ChatMessage = { role: 'user', content: text };
    // Capture the pre-turn state so we can compute the final snapshot for both
    // the UI and persistence without relying on state updated mid-stream.
    const history = [...messagesRef.current, userMsg];
    // For the API call, only send messages from the last compaction summary
    // onwards — earlier messages have been summarised.
    const startIdx = compactionIndexRef.current ?? 0;
    const apiMessages = [...messagesRef.current.slice(startIdx), userMsg];
    // The UI may have consecutive assistant messages (split at tool-call
    // boundaries). Merge them for the API call to keep alternating roles.
    const apiHistory = mergeConsecutiveAssistants(apiMessages);
    const preTurnPastTurns = pastTurnsRef.current;

    setInput('');
    setPendingFiles([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setTurnEvents([]);
    setLoading(true);
    setMessages(history);

    await runTurn({
      apiHistory,
      baseMessages: history,
      basePastTurns: preTurnPastTurns,
      isComplete: (events) => isTurnComplete(events, text),
    });
  }, [bundleId, input, loading, uploading, pendingFiles, appendContent, onFilesChanged, refreshGitStatus, refreshChatList, runTurn]);

  /**
   * Stop the in-flight chat turn. Aborting the local SSE fetch alone no
   * longer stops the server (disconnects are deliberately tolerated), so
   * this also POSTs to /chat/abort to cancel the server-side loop.
   */
  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    const id = chatIdRef.current;
    if (id) void abortChat(bundleId, id);
    abortRef.current?.abort();
  }, [bundleId]);

  /**
   * Compact the conversation: send all active messages to the LLM for a
   * detailed summary. The summary replaces the prior context — only messages
   * from the summary onwards are sent to the LLM in future turns. A divider
   * is shown in the chat; the summary text itself is not rendered as a bubble.
   */
  const handleCompact = useCallback(async () => {
    if (loading || messages.length === 0) return;

    // Auto-create a chat session if none active yet.
    if (chatIdRef.current === null) {
      try {
        const session = await createChat(bundleId);
        setChatId(session.id);
        chatIdRef.current = session.id;
      } catch {
        // Non-fatal — proceed without persistence.
      }
    }

    setLoading(true);
    try {
      const startIdx = compactionIndexRef.current ?? 0;
      const activeMessages = messagesRef.current.slice(startIdx);
      const { summary, title } = await compactChat(bundleId, activeMessages, chatIdRef.current);

      // The summary becomes a new assistant message in the display history.
      // It is NOT rendered as a bubble — the divider takes its place.
      const summaryMsg: ChatMessage = { role: 'assistant', content: summary };
      const newMessages = [...messagesRef.current, summaryMsg];
      const newIndex = newMessages.length - 1;

      setMessages(newMessages);
      messagesRef.current = newMessages;
      setPastTurns((prev) => [...prev, []]); // empty turn events for the summary
      setCompactionIndex(newIndex);
      compactionIndexRef.current = newIndex;

      // The same query refreshed the title via the set_title tool — just
      // apply it (the server already persisted it).
      if (title) {
        setChatTitle(title);
        chatTitleRef.current = title;
      }

      void refreshChatList();
    } catch (err) {
      // Compaction failed — surface the reason instead of failing silently
      // (e.g. upstream 429 "temporarily overloaded").
      const reason = err instanceof Error ? err.message : 'Unknown error';
      setTurnEvents((prev) => [...prev, { kind: 'error', text: `Compaction failed: ${reason}` }]);
    } finally {
      setLoading(false);
    }
  }, [bundleId, loading, messages.length, refreshChatList]);

  /** Ask the LLM to generate a meaningful title for the current conversation. */
  const handleRetitle = useCallback(async () => {
    if (loading || messages.length === 0) return;
    setLoading(true);
    try {
      const { title } = await retitleChat(bundleId, messagesRef.current, chatIdRef.current);
      if (title) {
        setChatTitle(title);
        chatTitleRef.current = title;
        void refreshChatList();
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [bundleId, loading, messages.length, refreshChatList]);

  /** Start a fresh, empty chat (clears state; a session is created on first send). */
  const handleNewChat = useCallback(() => {
    watchGenRef.current++; // cancel any background-turn watcher
    setMessages([]);
    setPastTurns([]);
    setProposedChanges([]);
    setTurnEvents([]);
    setChatId(null);
    setChatTitle('New chat');
    setShowHistory(false);
    setCompactionIndex(null);
    chatIdRef.current = null;
    chatTitleRef.current = 'New chat';
    compactionIndexRef.current = null;
  }, []);

  /** Load a past chat and restore its conversation state. */
  const handleSelectChat = useCallback(
    async (id: string): Promise<void> => {
      watchGenRef.current++; // cancel any background-turn watcher
      try {
        const session = await loadChat(bundleId, id);
        applySession(session);
        setChatId(session.id);
        setChatTitle(session.title);
        setShowHistory(false);
        chatIdRef.current = session.id;
        chatTitleRef.current = session.title;

        // If the selected chat has a turn still running server-side (the
        // page was reloaded mid-turn), watch the timeline in the background
        // until the server persists the turn's end. The recency guard avoids
        // spinning up a watcher for long-dead chats (e.g. a server crash
        // before turn_end existed).
        const evs = session.events;
        if (evs.length > 0 && !isLastTurnComplete(evs)) {
          const lastTs = Date.parse(evs[evs.length - 1].ts);
          if (Number.isFinite(lastTs) && Date.now() - lastTs < 30 * 60_000) {
            watchBackgroundTurn(id);
          }
        }
      } catch {
        // Best-effort: leave current chat in place.
      }
    },
    [bundleId, applySession, watchBackgroundTurn],
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
            setCompactionIndex(null);
            chatIdRef.current = null;
            chatTitleRef.current = 'New chat';
            compactionIndexRef.current = null;
          }
        }
      } catch {
        // Best-effort.
      }
    },
    [bundleId, handleSelectChat],
  );

  /**
   * Delete confirmation: the header Delete button arms on the first click
   * ("Confirm delete?") and only deletes on a second click within a 3s
   * window — no native confirm() dialog. The armed state is keyed by chat
   * id, so switching chats disarms it automatically.
   */
  const [armedChatId, setArmedChatId] = useState<string | null>(null);
  const deleteArmTimer = useRef<number | null>(null);
  const deleteArmed = armedChatId !== null && armedChatId === chatId;

  useEffect(() => () => {
    if (deleteArmTimer.current !== null) window.clearTimeout(deleteArmTimer.current);
  }, []);

  const handleDeleteClick = useCallback(() => {
    const id = chatIdRef.current;
    if (id === null || loading) return;
    if (deleteArmTimer.current !== null) {
      window.clearTimeout(deleteArmTimer.current);
      deleteArmTimer.current = null;
    }
    if (armedChatId !== id) {
      setArmedChatId(id);
      deleteArmTimer.current = window.setTimeout(() => setArmedChatId(null), 3000);
      return;
    }
    setArmedChatId(null);
    void handleDeleteChat(id);
  }, [armedChatId, loading, handleDeleteChat]);

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
   * Home/End/PageUp/PageDown scroll the chat transcript — from anywhere,
   * including when focus is on <body> (a disabled textarea or a plain
   * message div is not focusable, so a panel-level onKeyDown never sees
   * those events — they bubble UP from body, not through the panel).
   *
   * Guards: ignored when the target is outside the chat panel (file tree,
   * other pages) or is an editable field other than the chat input (history
   * search box, modals) so normal text editing keeps working.
   */
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = scrollRef.current;
      const target = e.target as HTMLElement | null;
      if (!el || !target) return;

      const panel = panelRef.current;
      const inPanel = panel?.contains(target) ?? false;
      const onBody = target === document.body || target === document.documentElement;
      if (!inPanel && !onBody) return;

      const isEditable =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isEditable && target !== inputRef.current) return;

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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasContent = turnEvents.some((e) => e.kind === 'content' || e.kind === 'thinking');
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
      ref={panelRef}
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
              <span className="chat-history-title">{chatTitle}</span>
              <span className="chat-history-caret" aria-hidden="true">▾</span>
            </button>
          </div>
        </div>
        <div className="chat-header-right">
          {(gitInsertions > 0 || gitDeletions > 0 || gitUntracked > 0) && (
            <button
              type="button"
              className="chat-git-badge"
              title={`${gitInsertions} insertion(s), ${gitDeletions} deletion(s), ${gitUntracked} untracked file(s)`}
              onClick={() => {
                setInput('Show me the git status');
                void handleSend();
              }}
            >
              {gitInsertions > 0 && <span className="git-ins">+{gitInsertions}</span>}
              {gitDeletions > 0 && <span className="git-del">−{gitDeletions}</span>}
              {gitUntracked > 0 && <span className="git-untracked">?{gitUntracked}</span>}
            </button>
          )}
          <button
            type="button"
            className="chat-new-btn"
            onClick={handleNewChat}
            title="New chat"
            disabled={loading}
          >
            + New
          </button>
          {messages.length > 0 && !loading ? (
            <button
              type="button"
              className={`chat-compact-btn ctx-${formatCtxTokens(ctxTokens, ctxLimit).level}`}
              onClick={() => void handleCompact()}
              title={
                exactPromptTokens !== null
                  ? `Summarise conversation to free up context (${ctxTokens.toLocaleString()} tokens active — exact, last LLM call)`
                  : `Summarise conversation to free up context (≈${ctxTokens.toLocaleString()} tokens active)`
              }
            >
              Compact{ctxTokens > 0 && (() => {
                const { label } = formatCtxTokens(ctxTokens, ctxLimit);
                return <span className="chat-compact-ctx">{label}</span>;
              })()}
            </button>
          ) : ctxTokens > 0 && (() => {
            const { label, level } = formatCtxTokens(ctxTokens, ctxLimit);
            return (
              <span
                className={`chat-ctx-badge ctx-${level}`}
                title={`≈${ctxTokens.toLocaleString()} tokens of conversation context`}
              >
                {label}
              </span>
            );
          })()}
          {messages.length > 0 && !loading && (
            <button
              type="button"
              className="chat-new-btn"
              onClick={() => void handleRetitle()}
              title="Generate a meaningful title from the conversation"
            >
              Retitle
            </button>
          )}
          {chatId !== null && (
            <button
              type="button"
              className={`chat-new-btn chat-delete-btn ${deleteArmed ? 'armed' : ''}`.trim()}
              onClick={handleDeleteClick}
              disabled={loading}
              title={deleteArmed ? 'Click again to confirm deletion' : 'Delete this chat'}
            >
              {deleteArmed ? 'Confirm delete?' : 'Delete'}
            </button>
          )}
        </div>

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
                  // In-session reasoning from a finished turn — collapsed
                  // chip, clickable. (Not persisted; gone after a reload.)
                  if (ev.kind === 'thinking') {
                    return <ThinkingBlock key={`pth${i}-${j}`} text={ev.text} live={false} />;
                  }
                  if (ev.kind === 'notice') {
                    return (
                      <div className="chat-notice-event" key={`pn${i}-${j}`}>
                        🔄 {ev.text}
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
                {i === compactionIndex ? (
                  <div className="chat-compaction-wrapper">
                    <div
                      className="chat-compaction-divider"
                      role="button"
                      tabIndex={0}
                      aria-expanded={compactionExpanded}
                      aria-label="Conversation compacted — click to toggle summary"
                      onClick={() => setCompactionExpanded((v) => !v)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCompactionExpanded((v) => !v); } }}
                    >
                      <span className="chat-compaction-line" />
                      <span className="chat-compaction-chevron">{compactionExpanded ? '▾' : '▸'}</span>
                      <span className="chat-compaction-label">compaction</span>
                      <span className="chat-compaction-line" />
                    </div>
                    {compactionExpanded && (
                      <div className="chat-message chat-message-assistant chat-compaction-summary">
                        <div className="chat-bubble"><ChatMarkdown content={m.content} onNavigate={onNavigate} /></div>
                      </div>
                    )}
                  </div>
                ) : (m.role === 'user' || m.content.trim()) && (
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
          if (ev.kind === 'thinking') {
            // Frontier: expanded streaming box. Settled: collapsed 💭 chip
            // styled like the tool chips (click to re-expand). Never a
            // wide muted bar — that read as a stray separator line.
            return (
              <ThinkingBlock
                key={`th${i}`}
                text={ev.text}
                live={loading && i === turnEvents.length - 1}
              />
            );
          }
          if (ev.kind === 'notice') {
            return (
              <div className="chat-notice-event" key={`n${i}`}>
                🔄 {ev.text}
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
          if (ev.kind !== 'proposed') return null; // unreachable — all kinds handled
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

        {resumable && !loading && (
          <div className="chat-resume-row">
            <button
              type="button"
              className="btn btn-ghost chat-resume-btn"
              onClick={() => void handleResume()}
            >
              ↻ Resume interrupted response
            </button>
            <span className="chat-resume-hint">
              The server restarted mid-turn — continue exactly where the model left off (its tool results are kept).
            </span>
          </div>
        )}

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

        {(reconnecting || following) && (
          <div className="chat-reconnecting">
            <span className="spinner spinner-sm" />
            <span>
              {reconnecting
                ? 'Connection lost — your response is still running; following its progress…'
                : 'Your previous response is still running — following its progress…'}
            </span>
          </div>
        )}
      </div>

      <div
        className={`chat-input-area${dragOver ? ' chat-input-area--dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!loading && !uploading) {
            void handleFiles(e.dataTransfer.files);
          }
        }}
      >
        {(pendingFiles.length > 0 || uploading) && (
          <div className="chat-attachments">
            {pendingFiles.map((file, i) => (
              <span key={i} className="chat-attachment-chip">
                📎 {file.name}
                <button
                  type="button"
                  className="chat-attachment-remove"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label={`Remove ${file.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {uploading && (
              <span className="chat-attachment-chip chat-attachment-chip--uploading">
                <span className="spinner spinner-sm" /> Extracting…
              </span>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = ''; // reset so the same file can be selected again
          }}
        />
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || uploading}
          aria-label="Attach file"
          title="Attach file"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6z"
            />
          </svg>
        </button>
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => void openCamera()}
          disabled={loading || uploading}
          aria-label="Take photo"
          title="Take photo"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M9 3l-1.5 2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2.5L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
            />
          </svg>
        </button>
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          placeholder={pendingFiles.length > 0 ? 'Ask about the attached files (optional)…' : 'Message GLM…  (Enter to send, Shift+Enter for newline)'}
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
            className="btn btn-danger chat-send-btn chat-stop-btn"
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
            disabled={!input.trim() && pendingFiles.length === 0}
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
      {cameraOpen && (
        <div className="camera-overlay" onClick={closeCamera}>
          <div className="camera-modal" onClick={(e) => e.stopPropagation()}>
            {cameraError ? (
              <div className="camera-error">
                <p>{cameraError}</p>
                <button type="button" className="btn" onClick={closeCamera}>Close</button>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="camera-video"
                />
                <div className="camera-controls">
                  <button
                    type="button"
                    className="camera-close-btn"
                    onClick={closeCamera}
                    aria-label="Close camera"
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    className="camera-capture-btn"
                    onClick={capturePhoto}
                    aria-label="Capture photo"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

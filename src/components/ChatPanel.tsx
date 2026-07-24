import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  ChatMessage,
  ProposedChange,
  ToolCallInfo,
  TurnEvent,
} from '../types.ts';
import { streamChat } from '../services/chat.ts';
import { createFileRaw, updateFileRaw } from '../services/api.ts';
import { ProposedChangeCard } from './ProposedChangeCard.tsx';

interface ChatPanelProps {
  bundleId: string;
  /** Bundle display name shown in the header. */
  bundleName?: string;
  /** Bundle emoji icon shown in the header. */
  bundleIcon?: string;
}

interface ToolCallLabel {
  icon: string;
  text: string;
}

type ProposedEvent = Extract<TurnEvent, { kind: 'proposed' }>;

function formatToolCall(tc: ToolCallInfo): ToolCallLabel {
  const args = tc.args ?? {};
  const path = typeof args.path === 'string' ? args.path : '';
  switch (tc.name) {
    case 'read_file':
    case 'readFile':
      return { icon: '📖', text: path ? `Read ${path}` : 'Read file' };
    case 'list_files':
    case 'listFiles':
    case 'glob':
      return { icon: '📁', text: 'List files' };
    case 'write_file':
    case 'writeFile':
      return { icon: '✏️', text: path ? `Write ${path}` : 'Write file' };
    case 'edit_file':
    case 'editFile':
      return { icon: '✏️', text: path ? `Edit ${path}` : 'Edit file' };
    case 'create_file':
    case 'createFile':
      return { icon: '📄', text: path ? `Create ${path}` : 'Create file' };
    case 'commit':
    case 'commit_proposed':
      return {
        icon: '✅',
        text:
          typeof args.message === 'string'
            ? `Commit: “${args.message}”`
            : 'Commit changes',
      };
    default:
      return { icon: '🔧', text: tc.name };
  }
}

/** Generate a stable id for a proposed change, falling back when.randomUUID is unavailable. */
function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ChatPanel({ bundleId, bundleName, bundleIcon }: ChatPanelProps) {
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
  const [error, setError] = useState<string | null>(null);

  // Mirror the latest message history so the async send handler can build the
  // request payload without reading stale state.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auto-scroll to the bottom whenever new content arrives.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, turnEvents, pastTurns, proposedChanges, loading]);

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

    const userMsg: ChatMessage = { role: 'user', content: text };
    const history = [...messagesRef.current, userMsg];

    setInput('');
    setError(null);
    setTurnEvents([]);
    setLoading(true);
    setMessages((prev) => [...prev, userMsg]);

    let acc = '';
    let chatError: string | null = null;

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
          setTurnEvents((prev) => [
            ...prev,
            {
              kind: 'tool',
              toolCall: {
                name: typeof obj.name === 'string' ? obj.name : 'tool',
                args: obj.args ?? {},
                result: obj.result,
              },
            },
          ]);
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
            status: 'pending',
          };
          setProposedChanges((prev) => [...prev, change]);
          setTurnEvents((prev) => [...prev, { kind: 'proposed', change }]);
        } else if (ev.event === 'commit_proposed') {
          const obj = data as { message?: unknown };
          setTurnEvents((prev) => [
            ...prev,
            {
              kind: 'tool',
              toolCall: {
                name: 'commit',
                args: {
                  message: typeof obj.message === 'string' ? obj.message : '',
                },
              },
            },
          ]);
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
    }

    // Commit the accumulated assistant text to the permanent history.
    if (acc.trim()) {
      setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
    }
    // Preserve the turn's events (tool calls, content) in past turns so they
    // stay visible in chronological order.
    setTurnEvents((prev) => {
      if (prev.length > 0) setPastTurns((tp) => [...tp, prev]);
      return [];
    });
    if (chatError) setError(chatError);
    setLoading(false);
  }, [bundleId, input, loading, appendContent]);

  const handleAccept = useCallback(
    async (id: string): Promise<void> => {
      const change = proposedChanges.find((c) => c.id === id);
      if (!change) return;
      if (change.type === 'edit') {
        await updateFileRaw(bundleId, change.path, change.newContent);
      } else {
        await createFileRaw(bundleId, change.path, change.newContent);
      }
      setProposedChanges((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: 'applied' } : c)),
      );
    },
    [bundleId, proposedChanges],
  );

  const handleReject = useCallback((id: string) => {
    setProposedChanges((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'rejected' } : c)),
    );
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasContent = turnEvents.some((e) => e.kind === 'content');
  const showTyping = loading && !hasContent;

  // Proposed changes belonging to the current turn are rendered inline within
  // the timeline; the rest (from previous turns) render afterwards so they
  // remain visible/actionable.
  const currentTurnProposedIds = new Set(
    turnEvents
      .filter((e): e is ProposedEvent => e.kind === 'proposed')
      .map((e) => e.change.id),
  );
  const pastProposed = proposedChanges.filter(
    (c) => !currentTurnProposedIds.has(c.id),
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
        <div className="chat-header-title">
          <span className="chat-header-avatar" aria-hidden="true">
            {bundleIcon ?? '🤖'}
          </span>
          <span>{bundleName ?? 'GLM'}</span>
        </div>
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
                  if (ev.kind === 'proposed') {
                    const latest =
                      proposedChanges.find((c) => c.id === ev.change.id) ?? ev.change;
                    return (
                      <ProposedChangeCard
                        key={`pp${i}-${j}`}
                        change={latest}
                        onAccept={handleAccept}
                        onReject={handleReject}
                      />
                    );
                  }
                  return null;
                })}
                <div
                  className={`chat-message chat-message-${m.role === 'user' ? 'user' : 'assistant'}`}
                >
                  {m.role !== 'user' && <span className="chat-author">GLM</span>}
                  <div className="chat-bubble">{m.content}</div>
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
          if (ev.kind === 'content') {
            return (
              <div className="chat-message chat-message-assistant" key={`c${i}`}>
                <span className="chat-author">GLM</span>
                <div className="chat-bubble">{ev.text}</div>
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
              onAccept={handleAccept}
              onReject={handleReject}
            />
          );
        })}

        {/* Proposed changes from previous turns. */}
        {pastProposed.map((change) => (
          <ProposedChangeCard
            key={change.id}
            change={change}
            onAccept={handleAccept}
            onReject={handleReject}
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

      {error && <div className="chat-error">{error}</div>}

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

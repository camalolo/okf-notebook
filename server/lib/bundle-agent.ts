/**
 * Reusable, request-independent agent runner for background LLM tasks.
 *
 * This is a strict subset of the agentic loop in `server/routes/chat.ts`:
 * it shares the same tool definitions and dispatcher, but strips out all
 * Express/SSE/persistence concerns. By default the model can call
 * `read_file`, `list_files`, and `web_search` to gather information.
 *
 * Trusted server-side tasks (e.g. the digest's OKF cleanup pass) may also
 * pass write tools (edit_file / create_file / delete_file / git_commit —
 * see WRITE_TOOLS in routes/chat.ts) via `extraTools`; those dispatch
 * through the same executeTool path as interactive chats. Set `user` to
 * attribute git commits made during the run.
 */

import type { BundleConfig } from '../config.js';
import type { ChatLogger } from './logger.js';
import type { ChatMessage, ToolDefinition } from './llm.js';
import { chatCompletionStream } from './llm.js';
import { mcpManager } from './mcp-manager.js';
import { validateWorkspaceAuth } from './workspace-auth.js';
import {
  READONLY_TOOLS,
  executeTool,
  buildSystemPrompt,
  type ToolContext,
} from '../routes/chat.js';

/** A single recorded tool invocation (name, args, and the result returned). */
export interface ToolCallRecord {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

export interface RunReadOnlyTaskResult {
  /** Final assistant text (the last turn with no tool calls). */
  content: string;
  /** Every tool call the model made, in order. */
  toolCalls: ToolCallRecord[];
  /** Number of loop iterations that ran. */
  iterations: number;
  /** True if the loop hit the iteration cap instead of terminating naturally. */
  capped: boolean;
  /**
   * The terminal tool call that ended the run, if any. Terminal tools
   * (declared via `RunReadOnlyTaskOptions.terminalTools`) are NOT dispatched
   * through executeTool — they're signals from the model that it has reached
   * a decision. The caller inspects this to extract structured output.
   */
  terminalToolCall?: ToolCallRecord;
}

export interface RunReadOnlyTaskOptions {
  /** Optional abort signal; when aborted the loop exits after the current tool. */
  signal?: AbortSignal;
  /** Logger; if absent a fresh trace-scoped logger is created. */
  log?: ChatLogger;
  /** Max loop iterations (default 20). Guards against runaway tool loops. */
  maxIterations?: number;
  /**
   * Acting user for tool execution. Only used for git_commit authorship
   * (background tasks pass a synthetic service identity). Omit for commits
   * to fall back to the repo's default author.
   */
  user?: Express.User;
  /**
   * Extra system-prompt text appended after buildSystemPrompt() output.
   * Use this to give the task its own instructions (e.g. digest rules).
   */
  systemPromptSuffix?: string;
  /**
   * Additional tool definitions advertised to the LLM alongside the read-only
   * bundle tools (read_file, list_files, web_search). Use for task-specific
   * decision tools (e.g. skip_digest / send_digest).
   */
  extraTools?: ToolDefinition[];
  /**
   * MCP tool definitions to advertise and dispatch (e.g. the gw_ Google
   * subset for the digest). Calls route through the MCP manager; gw_ tools
   * additionally get a per-user auth pre-check against `mcpUserEmail`.
   */
  mcpTools?: ToolDefinition[];
  /** Workspace account whose MCP instance handles gw_ calls (token pre-check). */
  mcpUserEmail?: string;
  /**
   * Names of tools that, when called by the model, terminate the run.
   * Terminal tool calls are recorded in `result.terminalToolCall` (and in
   * `result.toolCalls`) but NOT dispatched through executeTool — the caller
   * interprets them. The loop exits as soon as the model invokes one.
   */
  terminalTools?: Set<string>;
}

/**
 * Run an LLM task against a bundle with read-only tools, until the model
 * produces a turn with no tool calls or invokes a terminal tool.
 *
 * @param bundle    Bundle to operate on.
 * @param userPrompt The task instruction (role: 'user').
 * @param opts      See RunReadOnlyTaskOptions.
 */
export async function runReadOnlyTask(
  bundle: BundleConfig,
  userPrompt: string,
  opts: RunReadOnlyTaskOptions = {},
): Promise<RunReadOnlyTaskResult> {
  const maxIterations = opts.maxIterations ?? 20;
  const ctx: ToolContext = { bundle, ...(opts.user ? { user: opts.user } : {}) };
  const terminalTools = opts.terminalTools ?? new Set<string>();
  const advertisedTools = [
    ...READONLY_TOOLS,
    ...(opts.extraTools ?? []),
    ...(opts.mcpTools ?? []),
  ];
  const mcpToolNames = new Set((opts.mcpTools ?? []).map((t) => t.function.name));

  const baseSystem = await buildSystemPrompt(
    bundle,
    [],
    advertisedTools.map((t) => t.function.name),
  );
  const systemPrompt = opts.systemPromptSuffix
    ? `${baseSystem}\n\n${opts.systemPromptSuffix}`
    : baseSystem;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let content = '';
  let iterations = 0;
  let capped = false;
  let terminalToolCall: ToolCallRecord | undefined;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    if (opts.signal?.aborted) break;

    // Stream-accumulate; we don't forward deltas anywhere (no SSE consumer),
    // but onDelta is required so the content builds up turn-by-turn.
    let turnContent = '';
    const response = await chatCompletionStream(
      messages,
      advertisedTools,
      (delta) => { turnContent += delta; },
      opts.signal,
      opts.log,
    );

    if (!response.tool_calls || response.tool_calls.length === 0) {
      // Terminal turn: final answer (no tool calls).
      content = turnContent || response.content || '';
      break;
    }

    // The model issued tool calls — record the assistant turn, then dispatch.
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: response.tool_calls,
    });

    let terminalHit = false;
    for (const tc of response.tool_calls) {
      if (opts.signal?.aborted) break;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsedArgs: any;
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }

      // Terminal tool: capture and stop (do NOT dispatch through executeTool).
      if (terminalTools.has(tc.function.name)) {
        const record: ToolCallRecord = { name: tc.function.name, args: parsedArgs, result: { captured: true } };
        toolCalls.push(record);
        terminalToolCall = record;
        opts.log?.debug(`Terminal tool: ${tc.function.name}`);
        terminalHit = true;
        break;
      }

      let result: unknown;
      try {
        if (mcpToolNames.has(tc.function.name) && mcpManager.hasTool(tc.function.name)) {
          if (
            tc.function.name.startsWith('gw_') &&
            !(await validateWorkspaceAuth(opts.mcpUserEmail ?? ''))
          ) {
            result = { error: 'Workspace auth expired — Google tools unavailable in this run.' };
          } else {
            result = await mcpManager.callTool(tc.function.name, parsedArgs, {
              userEmail: opts.mcpUserEmail,
            });
          }
        } else {
          result = await executeTool(tc.function.name, parsedArgs, ctx);
        }
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }

      toolCalls.push({ name: tc.function.name, args: parsedArgs, result });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    if (terminalHit) break;
    if (opts.signal?.aborted) break;

    // If this was the last allowed iteration, mark capped and stop without
    // calling the LLM again — content from any partial turn is preserved.
    if (iterations >= maxIterations) {
      capped = true;
      break;
    }
  }

  return { content, toolCalls, iterations, capped, terminalToolCall };
}

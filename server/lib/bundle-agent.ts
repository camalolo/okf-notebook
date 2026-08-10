/**
 * Reusable, request-independent agent runner for read-only LLM tasks.
 *
 * This is a strict subset of the agentic loop in `server/routes/chat.ts`:
 * it shares the same tool definitions and dispatcher, but strips out all
 * Express/SSE/persistence concerns. The model can call `read_file`,
 * `list_files`, and `web_search` to gather information; it cannot mutate
 * the bundle (no `edit_file`/`create_file`/`git_commit` are advertised).
 *
 * Use this for server-side scheduled tasks (daily digest) or any future
 * background job that needs to "ask the LLM to read this bundle and answer".
 */

import type { BundleConfig } from '../config.js';
import type { ChatLogger } from './logger.js';
import type { ChatMessage } from './llm.js';
import { chatCompletionStream } from './llm.js';
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
}

export interface RunReadOnlyTaskOptions {
  /** Optional abort signal; when aborted the loop exits after the current tool. */
  signal?: AbortSignal;
  /** Logger; if absent a fresh trace-scoped logger is created. */
  log?: ChatLogger;
  /** Max loop iterations (default 20). Guards against runaway tool loops. */
  maxIterations?: number;
  /**
   * Extra system-prompt text appended after buildSystemPrompt() output.
   * Use this to give the task its own instructions (e.g. digest rules).
   */
  systemPromptSuffix?: string;
}

/**
 * Run an LLM task against a bundle with read-only tools, until the model
 * produces a turn with no tool calls.
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
  const ctx: ToolContext = { bundle };

  const baseSystem = await buildSystemPrompt(bundle);
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

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    if (opts.signal?.aborted) break;

    // Stream-accumulate; we don't forward deltas anywhere (no SSE consumer),
    // but onDelta is required so the content builds up turn-by-turn.
    let turnContent = '';
    const response = await chatCompletionStream(
      messages,
      READONLY_TOOLS,
      (delta) => { turnContent += delta; },
      opts.signal,
      opts.log,
    );

    if (!response.tool_calls || response.tool_calls.length === 0) {
      // Terminal turn: final answer.
      content = turnContent || response.content || '';
      break;
    }

    // The model issued tool calls — record the assistant turn, then dispatch.
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: response.tool_calls,
    });

    for (const tc of response.tool_calls) {
      if (opts.signal?.aborted) break;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsedArgs: any;
      try {
        parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsedArgs = {};
      }

      let result: unknown;
      try {
        result = await executeTool(tc.function.name, parsedArgs, ctx);
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

    if (opts.signal?.aborted) break;

    // If this was the last allowed iteration, mark capped and stop without
    // calling the LLM again — content from any partial turn is preserved.
    if (iterations >= maxIterations) {
      capped = true;
      break;
    }
  }

  return { content, toolCalls, iterations, capped };
}

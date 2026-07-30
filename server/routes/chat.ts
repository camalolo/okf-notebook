import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import simpleGit from 'simple-git';
import { createPatch, applyPatch } from 'diff';
import { getBundle, resolveBundlePath } from '../bundles.js';
import {
  chatCompletionStream,
} from '../lib/llm.js';
import { webSearch } from '../lib/web-search.js';
import { mcpManager } from '../lib/mcp-manager.js';
import { appendEvent } from '../chats.js';
import type {
  ToolDefinition,
  ChatMessage,
} from '../lib/llm.js';
import type { BundleConfig } from '../config.js';

const router = Router();

const SKIP_DIRS = new Set(['node_modules', '.git']);

// --- Tool definitions -------------------------------------------------------

const READ_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a markdown file from the bundle. Returns { path, content, frontmatter }.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the .md file within the bundle.' },
      },
      required: ['path'],
    },
  },
};

const LIST_FILES_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'List all .md files in the bundle. Returns { files: [{ path, title, type }] }.',
    parameters: { type: 'object', properties: {} },
  },
};

const GIT_STATUS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_status',
    description: 'Get the git working-tree status. Returns { modified, staged, clean }.',
    parameters: { type: 'object', properties: {} },
  },
};

const GIT_DIFF_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_diff',
    description: 'Get the git diff of changes. Returns { diff }.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional relative path to diff a single file.',
        },
      },
    },
  },
};

const GIT_LOG_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_log',
    description: 'Get recent git commits. Returns { commits }.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of commits (default 10).' },
      },
    },
  },
};

// Per-file edit history for undo support. Keyed by absolute resolved path.
const editHistory = new Map<string, { oldContent: string; newContent: string }[]>();

const EDIT_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Edit an existing file by applying a unified diff. The diff MUST follow standard unified diff format: ' +
      'lines starting with " " (space) are context, "-" are removed lines, "+" are added lines, ' +
      'and each hunk starts with a "@@ -start,count +start,count @@" header. ' +
      'Include enough unchanged context lines (2-3) around each change so the diff applies unambiguously. ' +
      'Always read the file first to get the exact current content. Writes to disk immediately. ' +
      'Use undo_edit to revert. Returns { applied: true, path, diff } or { error } if the diff fails to apply.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to edit.' },
        diff: {
          type: 'string',
          description:
            'Unified diff to apply to the file. Example:\n' +
            '--- a/example.md\n+++ b/example.md\n' +
            '@@ -1,3 +1,3 @@\n line one\n-old line\n+new line\n line three',
        },
      },
      required: ['path', 'diff'],
    },
  },
};

const CREATE_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_file',
    description:
      'Create a new file (any type — .md, .gitignore, .json, etc.). Writes to disk immediately. Returns { applied: true, path }.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path for the new file.' },
        content: { type: 'string', description: 'The full content for the new file.' },
      },
      required: ['path', 'content'],
    },
  },
};

const UNDO_EDIT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'undo_edit',
    description:
      'Undo the most recent edit_file operation on a file, restoring its previous content. ' +
      'Only undoes edits made via edit_file in the current server session. ' +
      'Returns { undone: true, path, diff } or { error } if no edit history exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file whose last edit should be undone.' },
      },
      required: ['path'],
    },
  },
};

const GIT_COMMIT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_commit',
    description: 'Stage and commit changes. Returns { committed: true, hash }.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The commit message.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of relative paths to stage. Defaults to all changes.',
        },
      },
      required: ['message'],
    },
  },
};

const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web. Returns { query, provider, results: [{ title, url, snippet, content? }] }. ' +
      'Uses whichever search API is configured (exa, tavily, tinyfish, or serper).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        num_results: { type: 'number', description: 'Number of results (default 5, max 10).' },
      },
      required: ['query'],
    },
  },
};

const READONLY_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  LIST_FILES_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,
  WEB_SEARCH_TOOL,
];

const FULL_TOOLS: ToolDefinition[] = [
  ...READONLY_TOOLS,
  EDIT_FILE_TOOL,
  UNDO_EDIT_TOOL,
  CREATE_FILE_TOOL,
  GIT_COMMIT_TOOL,
];

// --- Helpers ----------------------------------------------------------------

/** Recursively list all .md file paths (relative) in a directory. */
async function listMdFiles(dir: string, prefix: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hidden
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await listMdFiles(fullPath, relPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(relPath);
    }
  }
  files.sort();
  return files;
}

/** Produce a unified diff between two file contents. */
function makeDiff(relPath: string, oldContent: string, newContent: string): string {
  try {
    return createPatch(relPath, oldContent, newContent, 'current', 'proposed', { context: 3 });
  } catch {
    return `--- ${relPath} (current)\n+++ ${relPath} (proposed)\n`;
  }
}

interface ToolContext {
  bundle: BundleConfig;
  user?: Express.User;
}

/** Execute a single tool call, returning a JSON-serializable result object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(name: string, args: any, ctx: ToolContext): Promise<any> {
  const { bundle } = ctx;
  const bundlePath = bundle.path;

  switch (name) {
    case 'read_file': {
      const rel = String(args?.path ?? '');
      const resolved = resolveBundlePath(bundlePath, rel);
      if (path.extname(resolved).toLowerCase() !== '.md') {
        return { error: 'Only .md files are readable' };
      }
      let raw: string;
      try {
        raw = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { error: `File not found: ${rel}` };
        }
        throw err;
      }
      const parsed = matter(raw);
      return { path: rel, content: raw, frontmatter: parsed.data ?? {} };
    }

    case 'list_files': {
      const filePaths = await listMdFiles(bundlePath, '');
      const files = await Promise.all(
        filePaths.map(async (p) => {
          let title: string | undefined;
          let type: string | undefined;
          try {
            const raw = await fs.readFile(path.join(bundlePath, p), 'utf8');
            const fm = matter(raw).data ?? {};
            title = typeof fm.title === 'string' ? fm.title : undefined;
            type = typeof fm.type === 'string' ? fm.type : undefined;
          } catch {
            // skip metadata on read error
          }
          return { path: p, title, type };
        }),
      );
      return { files };
    }

    case 'web_search': {
      const query = String(args?.query ?? '');
      if (!query) return { error: 'query is required' };
      const numResults = Number(args?.num_results) || 5;
      return webSearch(query, numResults);
    }

    case 'git_status': {
      const status = await simpleGit(bundlePath).status();
      return {
        modified: status.files
          .filter((f) => f.working_dir !== ' ' || f.index !== ' ')
          .map((f) => f.path),
        staged: status.files
          .filter((f) => f.index !== ' ' && f.index !== '?')
          .map((f) => f.path),
        not_added: status.not_added,
        clean: status.isClean(),
      };
    }

    case 'git_diff': {
      const filePath = args?.path ? String(args.path) : undefined;
      const diff = filePath
        ? await simpleGit(bundlePath).diff(['--', filePath])
        : await simpleGit(bundlePath).diff();
      return { diff };
    }

    case 'git_log': {
      const limit = Number(args?.limit) || 10;
      const log = await simpleGit(bundlePath).log({ maxCount: limit });
      return {
        commits: log.all.map((c) => ({
          hash: c.hash,
          date: c.date,
          message: c.message,
          author: c.author_name,
        })),
      };
    }

    case 'edit_file': {
      const rel = String(args?.path ?? '');
      const diffInput = String(args?.diff ?? '');
      const resolved = resolveBundlePath(bundlePath, rel);
      let oldContent: string;
      try {
        oldContent = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { error: `File not found: ${rel}. Use create_file for new files.` };
        }
        throw err;
      }
      if (!diffInput.trim()) {
        return { error: 'diff is required and must not be empty.' };
      }
      const newContent = applyPatch(oldContent, diffInput);
      if (newContent === false) {
        return {
          error:
            'The diff could not be applied — context lines do not match the current file content. ' +
            'Read the file first and ensure your diff context (space-prefixed lines) matches the exact current content.',
        };
      }
      // Record edit history for undo.
      let history = editHistory.get(resolved);
      if (!history) {
        history = [];
        editHistory.set(resolved, history);
      }
      history.push({ oldContent, newContent });
      // Write to disk immediately.
      await fs.writeFile(resolved, newContent, 'utf8');
      const displayDiff = makeDiff(rel, oldContent, newContent);
      return { applied: true, path: rel, oldContent, newContent, diff: displayDiff };
    }

    case 'undo_edit': {
      const rel = String(args?.path ?? '');
      const resolved = resolveBundlePath(bundlePath, rel);
      const history = editHistory.get(resolved);
      if (!history || history.length === 0) {
        return { error: `No edit history for ${rel}. Nothing to undo.` };
      }
      const last = history.pop()!;
      let currentContent: string;
      try {
        currentContent = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrNoException).code === 'ENOENT') {
          // File was deleted since the edit — recreate from history.
          await fs.writeFile(resolved, last.oldContent, 'utf8');
          const diff = makeDiff(rel, '', last.oldContent);
          return { undone: true, path: rel, oldContent: '', newContent: last.oldContent, diff };
        }
        throw err;
      }
      await fs.writeFile(resolved, last.oldContent, 'utf8');
      const diff = makeDiff(rel, currentContent, last.oldContent);
      return { undone: true, path: rel, oldContent: currentContent, newContent: last.oldContent, diff };
    }

    case 'create_file': {
      const rel = String(args?.path ?? '');
      const content = String(args?.content ?? '');
      const resolved = resolveBundlePath(bundlePath, rel);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf8');
      return { applied: true, path: rel, content };
    }

    case 'git_commit': {
      const message = String(args?.message ?? '');
      if (!message) return { error: 'message is required' };
      const g = simpleGit(bundlePath);
      const paths = Array.isArray(args?.paths) ? args.paths : undefined;
      if (paths && paths.length > 0) {
        await g.add(paths);
      } else {
        await g.add('-A');
      }
      const author = ctx.user ? `${ctx.user.name} <${ctx.user.email}>` : undefined;
      const result = author
        ? await g.commit(message, undefined, { '--author': author })
        : await g.commit(message);
      return { committed: true, hash: result.commit };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Build the system prompt for a bundle. */
async function buildSystemPrompt(bundle: BundleConfig): Promise<string> {
  const bundlePath = bundle.path;

  // Read AGENTS.md (if present).
  let agentsContent = '(none)';
  try {
    agentsContent = await fs.readFile(path.join(bundlePath, 'AGENTS.md'), 'utf8');
  } catch {
    // optional file
  }

  // Read OKF.md (if present).
  let okfContent = '(none)';
  try {
    okfContent = await fs.readFile(path.join(bundlePath, 'OKF.md'), 'utf8');
  } catch {
    // optional file
  }

  // List all files.
  const filePaths = await listMdFiles(bundlePath, '');
  const fileList = filePaths.length > 0 ? filePaths.map((p) => `- ${p}`).join('\n') : '(no files)';

  return [
    `You are an AI assistant helping manage an OKF knowledge bundle called "${bundle.name}".`,
    '',
    `Current date/time: ${new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Taipei',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })}`,
    '',
    'You can read files, check git status, and edit files directly. When the user asks you to',
    'make changes, use the edit_file or create_file tools. Changes are applied immediately.',
    '',
    'After making edits, use git_commit to commit the changes if appropriate.',
    '',
    '## Formatting your responses',
    'Your responses are rendered as GitHub-Flavored Markdown. Use markdown formatting',
    'for clarity:',
    '- Use **bold**, *italic*, ~~strikethrough~~, and `inline code`.',
    '- Use GFM tables (| col | col |) instead of ASCII tables for tabular data.',
    '- Use ```fenced code blocks``` for code or ASCII art.',
    '- Use headings (#, ##, ###), bullet lists (-), and numbered lists (1.) to structure',
    '  longer responses.',
    '- Use > blockquotes for quoting.',
    'Avoid raw HTML — use markdown equivalents instead.',
    '',
    '## Linking to files in the bundle',
    'When referencing a file in the bundle, use a markdown link with the file\'s',
    "relative path (no leading slash). Example: [car-log](vehicles/car-log.md).",
    'These links are clickable and will open the file in the built-in reader.',
    'Do NOT use raw HTML <a> tags or absolute paths starting with /. Use the',
    'relative path exactly as it appears in list_files output.',
    '',
    'You also have access to a web_search tool for quick web searches, browser tools',
    '(browser_navigate, browser_snapshot, browser_click, browser_type, browser_press_key)',
    'for reading and interacting with specific web pages, and Google Workspace tools for',
    'email and full calendar management (gw_search_emails, gw_read_email, and gw_ calendar',
    "tools). Use web_search for general questions, browser_ tools to read a specific page,",
    "and gw_ tools for the user's email or calendar.",
    '',
    'Always read relevant files before editing to understand the current content.',
    '',
    `## Bundle: ${bundle.name}`,
    bundle.description || '(no description)',
    '',
    '## AGENTS.md',
    agentsContent,
    '',
    '## OKF Format',
    okfContent,
    '',
    '## Files in this bundle',
    fileList,
  ].join('\n');
}

// --- SSE helper -------------------------------------------------------------

type SSEEmit = (event: string, data: unknown) => void;

/** Create an SSE emit function bound to a response (already headered). */
function makeEmitter(res: import('express').Response): SSEEmit {
  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

// --- Route ------------------------------------------------------------------

/**
 * POST /:bundleId/chat — agentic chat with server-side tool use, streamed as
 * Server-Sent Events.
 *
 * Request body: `{ messages: ChatMessage[], chatId?: string }`.
 * When `chatId` is provided, the server persists each event to the chat
 * timeline as it happens (user message, tool calls, assistant response).
 *
 * SSE events: `tool_call`, `content`, `edit_applied`, `done`, `error`.
 */
router.post('/:bundleId/chat', async (req, res, next) => {
  const bundleId = req.params.bundleId as string;
  try {
    const bundle = await getBundle(bundleId);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages (ChatMessage[]) is required' });
    }

    const chatId: string | null =
      typeof req.body?.chatId === 'string' ? req.body.chatId : null;

    // Sequential persistence — chains promises to avoid read-modify-write
    // races between concurrent appendEvent calls.
    let persistChain: Promise<void> = Promise.resolve();
    const persist = (event: Parameters<typeof appendEvent>[3]) => {
      if (!chatId) return;
      persistChain = persistChain
        .then(() => appendEvent(bundleId, chatId, req.user!.email, event))
        .catch(() => { /* best-effort */ });
    };

    // Select tools based on the user's role.
    const role = req.user?.role;
    const bundleTools = role === 'full' ? FULL_TOOLS : READONLY_TOOLS;
    const allTools = [...bundleTools, ...mcpManager.getToolDefinitions()];

    const ctx: ToolContext = { bundle, user: req.user };

    // --- SSE headers ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.flushHeaders?.();

    // Track client connection state so the loop can keep running (and persisting)
    // even after the client disconnects. SSE writes are silently skipped.
    let clientConnected = true;
    req.on('close', () => { clientConnected = false; });

    const rawEmit = makeEmitter(res);
    const emit: SSEEmit = (event, data) => {
      if (!clientConnected) return;
      try {
        rawEmit(event, data);
      } catch {
        clientConnected = false;
      }
    };

    // Build conversation: system prompt + user-supplied history.
    const systemPrompt = await buildSystemPrompt(bundle);
    const callMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // Persist the new user message at the start of the turn.
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      persist({ kind: 'user', content: lastUserMsg.content });
    }

    // Accumulate streamed content so we can persist the full assistant message.
    let turnContent = '';

    try {
      for (;;) {
        // Stream content deltas to the client as they arrive.
        const response = await chatCompletionStream(
          callMessages,
          allTools,
          (delta) => {
            turnContent += delta;
            emit('content', { text: delta });
          },
        );

        if (response.tool_calls && response.tool_calls.length > 0) {
          // Append the assistant turn carrying all tool calls (once).
          callMessages.push({
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: response.tool_calls,
          });

          // Execute each tool call and feed results back.
          for (const tc of response.tool_calls) {
            const toolName = tc.function.name;
            let parsedArgs: unknown = {};
            try {
              parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              parsedArgs = {};
            }

            let result: unknown;
            try {
              if (mcpManager.hasTool(toolName)) {
                result = await mcpManager.callTool(toolName, parsedArgs);
              } else {
                result = await executeTool(toolName, parsedArgs, ctx);
              }
            } catch (err) {
              result = {
                error: err instanceof Error ? err.message : String(err),
              };
            }

            // Emit the tool-call event.
            emit('tool_call', { name: toolName, args: parsedArgs, result });

            // Persist tool event.
            persist({ kind: 'tool', toolCall: { name: toolName, args: parsedArgs as Record<string, unknown>, result } });

            // For edit_file / create_file, emit an edit_applied event
            // with the diff so the frontend can render a collapsible diff card.
            if (toolName === 'edit_file' || toolName === 'undo_edit') {
              const r = result as {
                path?: string;
                oldContent?: string;
                newContent?: string;
                diff?: string;
                error?: string;
              };
              if (!r.error) {
                emit('edit_applied', {
                  type: 'edit',
                  path: r.path,
                  oldContent: r.oldContent,
                  newContent: r.newContent,
                  diff: r.diff,
                });
                persist({
                  kind: 'proposed',
                  change: {
                    id: tc.id,
                    type: 'edit',
                    path: r.path ?? '',
                    oldContent: r.oldContent,
                    newContent: r.newContent ?? '',
                    status: 'applied',
                  },
                });
              }
            } else if (toolName === 'create_file') {
              const r = result as { path?: string; content?: string; error?: string };
              if (!r.error) {
                emit('edit_applied', {
                  type: 'create',
                  path: r.path,
                  newContent: r.content,
                });
                persist({
                  kind: 'proposed',
                  change: {
                    id: tc.id,
                    type: 'create',
                    path: r.path ?? '',
                    newContent: r.content ?? '',
                    status: 'applied',
                  },
                });
              }
            }

            // Append the tool result message.
            callMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }
          // Continue the loop — the model may issue more calls or answer.
          continue;
        }

        // No tool calls: content was already streamed via the callback.
        // Persist the final assistant message.
        persist({ kind: 'assistant', content: turnContent });
        emit('done', {});
        if (clientConnected) res.end();
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Persist error + whatever content was accumulated.
      persist({ kind: 'error', content: errMsg });
      persist({ kind: 'assistant', content: turnContent || '⚠️ This response was interrupted.' });
      emit('error', { message: errMsg });
      if (clientConnected) res.end();
    }
  } catch (err) {
    // If headers weren't sent yet (early failure), fall through to error handler.
    if (!res.headersSent) {
      return next(err);
    }
    // Already streaming — best-effort error event then close.
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
    } catch {
      // ignore
    }
    res.end();
  }
});

export default router;

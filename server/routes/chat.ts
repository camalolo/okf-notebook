import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import simpleGit from 'simple-git';
import { createPatch } from 'diff';
import { getBundle, resolveBundlePath } from '../bundles.js';
import {
  chatCompletionStream,
} from '../lib/llm.js';
import { mcpManager } from '../lib/mcp-manager.js';
import type {
  ToolDefinition,
  ToolCall,
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

const EDIT_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Edit an existing file. Writes to disk immediately. Returns { applied: true, path, diff }.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to edit.' },
        content: { type: 'string', description: 'The full new content for the file.' },
      },
      required: ['path', 'content'],
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

const READONLY_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  LIST_FILES_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,
];

const FULL_TOOLS: ToolDefinition[] = [
  ...READONLY_TOOLS,
  EDIT_FILE_TOOL,
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
      const content = String(args?.content ?? '');
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
      const diff = makeDiff(rel, oldContent, content);
      // Write to disk immediately.
      await fs.writeFile(resolved, content, 'utf8');
      return { applied: true, path: rel, oldContent, newContent: content, diff };
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
    'You also have access to Google Workspace tools (prefixed gw_) for reading emails',
    'and managing calendar events, and browser tools (prefixed browser_) for web',
    'search and scraping. Use these when the user asks about their email, calendar,',
    'or needs information from the web.',
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
 * Request body: `{ messages: ChatMessage[] }`.
 *
 * SSE events: `tool_call`, `content`, `proposed_change`, `done`, `error`.
 */
router.post('/:bundleId/chat', async (req, res, next) => {
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages (ChatMessage[]) is required' });
    }

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

    const emit = makeEmitter(res);

    // Build conversation: system prompt + user-supplied history.
    const systemPrompt = await buildSystemPrompt(bundle);
    const callMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const lastError: string | null = null;

    try {
      for (;;) {
        // Stream content deltas to the client as they arrive.
        const response = await chatCompletionStream(
          callMessages,
          allTools,
          (delta) => emit('content', { text: delta }),
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

            // For edit_file / create_file, emit a proposed_change event
            // with the diff so the frontend can render a collapsible diff card.
            if (toolName === 'edit_file') {
              const r = result as {
                path?: string;
                oldContent?: string;
                newContent?: string;
                diff?: string;
                error?: string;
              };
              if (!r.error) {
                emit('proposed_change', {
                  type: 'edit',
                  path: r.path,
                  oldContent: r.oldContent,
                  newContent: r.newContent,
                  diff: r.diff,
                });
              }
            } else if (toolName === 'create_file') {
              const r = result as { path?: string; content?: string; error?: string };
              if (!r.error) {
                emit('proposed_change', {
                  type: 'create',
                  path: r.path,
                  newContent: r.content,
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
        emit('done', {});
        res.end();
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      emit('error', { message: lastError });
      res.end();
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

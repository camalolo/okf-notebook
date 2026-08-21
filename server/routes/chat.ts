import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const simpleGit = require('simple-git') as (cwd: string) => import('simple-git').SimpleGit;
import { createPatch } from 'diff';
import { getBundle, resolveBundlePath } from '../bundles.js';
import {
  chatCompletion,
  chatCompletionStream,
  sleep,
} from '../lib/llm.js';
import { chatLogger, newTraceId } from '../lib/logger.js';
import { webSearch } from '../lib/web-search.js';
import { mcpManager } from '../lib/mcp-manager.js';
import { validateWorkspaceAuth } from '../lib/workspace-auth.js';
import { ensureGitRepo, isNoCommitsError } from '../lib/git-repo.js';
import { appendEvent, renameChat } from '../chats.js';
import { sendMail } from '../lib/mailer.js';
import type {
  ToolDefinition,
  ChatMessage,
  ChatCompletionResult,
  ToolCall,
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
      'Edit an existing file using search-and-replace. Provide old_string (the exact text to find) ' +
      'and new_string (the replacement). old_string must appear exactly once in the file — ' +
      'include enough surrounding context lines to make it unique. Matching is whitespace-tolerant ' +
      '(trailing spaces and tab/space differences are ignored). Always read the file first to get ' +
      'the exact current content. Writes to disk immediately. Use undo_edit to revert. ' +
      'Returns { applied: true, path, diff } or { error }.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to edit.' },
        old_string: {
          type: 'string',
          description: 'The exact text to find in the file. Must be unique — include context lines if needed.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
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

const DELETE_FILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delete_file',
    description:
      'Delete a file from the bundle. Writes to disk immediately (recoverable via git ' +
      'history if the file was committed). Use for removing duplicate or obsolete files ' +
      'after merging their content elsewhere. To move a file, create_file the new path ' +
      'then delete_file the old one. Returns { deleted: true, path } or { error }.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete.' },
      },
      required: ['path'],
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

const SEND_EMAIL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'send_email',
    description:
      'Send a plain-text email via the local SMTP relay. ' +
      'Returns { messageId, response } on success. Useful for sending summaries, reminders, or notifications.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address. If omitted, sends to the default configured recipient (DIGEST_TO).',
        },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
      },
      required: ['subject', 'body'],
    },
  },
};

export const READONLY_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  LIST_FILES_TOOL,
  WEB_SEARCH_TOOL,
];

/**
 * Write-capable tools (no send_email — background tasks route mail decisions
 * through their own runner, like the digest's send_digest terminal tool).
 * Used by full-role chat users and by trusted server-side agents (digest
 * cleanup) via bundle-agent's extraTools.
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  EDIT_FILE_TOOL,
  UNDO_EDIT_TOOL,
  CREATE_FILE_TOOL,
  DELETE_FILE_TOOL,
  GIT_COMMIT_TOOL,
];

const FULL_TOOLS: ToolDefinition[] = [
  ...READONLY_TOOLS,
  ...WRITE_TOOLS,
  SEND_EMAIL_TOOL,
];

// --- Helpers ----------------------------------------------------------------

/** Recursively list all .md file paths (relative) in a directory. */
export async function listMdFiles(dir: string, prefix: string): Promise<string[]> {
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

/**
 * Whitespace-tolerant search-and-replace.
 *
 * Tries exact character match first. If that fails, falls back to line-based
 * matching where each line is compared with relaxed whitespace: leading
 * whitespace runs (tabs/spaces) are collapsed to a single space and trailing
 * whitespace is stripped.
 *
 * Returns the full new content, or null if oldStr was not found, matched zero
 * times, or matched more than once (ambiguous).
 */
function searchReplace(content: string, oldStr: string, newStr: string): string | null {
  // Fast path: exact match.
  const exactIdx = content.indexOf(oldStr);
  if (exactIdx !== -1) {
    if (content.indexOf(oldStr, exactIdx + 1) !== -1) return null; // ambiguous
    return content.slice(0, exactIdx) + newStr + content.slice(exactIdx + oldStr.length);
  }

  // Relaxed path: line-based matching.
  const normLine = (l: string): string => {
    const m = l.match(/^([ \t]*)(.*)$/);
    const indent = m![1].replace(/[ \t]+/g, ' ');
    return indent + m![2].replace(/[ \t]+$/g, '');
  };

  const contentLines = content.replace(/\r\n/g, '\n').split('\n');
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
  const normOld = oldLines.map(normLine);

  let matchCount = 0;
  let matchStart = -1;

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(contentLines[i + j]) !== normOld[j]) { ok = false; break; }
    }
    if (ok) {
      matchCount++;
      matchStart = i;
      if (matchCount > 1) return null; // ambiguous
    }
  }

  if (matchCount === 0) return null;

  const before = contentLines.slice(0, matchStart);
  const after = contentLines.slice(matchStart + oldLines.length);
  return [...before, newStr, ...after].join('\n');
}

export interface ToolContext {
  bundle: BundleConfig;
  user?: Express.User;
}

/** Execute a single tool call, returning a JSON-serializable result object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<any> {
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
      await ensureGitRepo(bundlePath);
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
      await ensureGitRepo(bundlePath);
      const filePath = args?.path ? String(args.path) : undefined;
      const diff = filePath
        ? await simpleGit(bundlePath).diff(['--', filePath])
        : await simpleGit(bundlePath).diff();
      return { diff };
    }

    case 'git_log': {
      await ensureGitRepo(bundlePath);
      const limit = Number(args?.limit) || 10;
      try {
        const log = await simpleGit(bundlePath).log({ maxCount: limit });
        return {
          commits: log.all.map((c) => ({
            hash: c.hash,
            date: c.date,
            message: c.message,
            author: c.author_name,
          })),
        };
      } catch (err) {
        // Freshly-initialized repo — no commits yet.
        if (isNoCommitsError(err)) return { commits: [] };
        throw err;
      }
    }

    case 'edit_file': {
      const rel = String(args?.path ?? '');
      const oldStr = String(args?.old_string ?? '');
      const newStr = String(args?.new_string ?? '');
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
      if (!oldStr) {
        return { error: 'old_string is required and must not be empty.' };
      }
      const newContent = searchReplace(oldContent, oldStr, newStr);
      if (newContent === null) {
        return {
          error:
            'old_string was not found in the file (or matched more than once). ' +
            'Read the file first and ensure old_string exactly matches a unique snippet of the current content.',
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
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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

    case 'delete_file': {
      const rel = String(args?.path ?? '');
      const resolved = resolveBundlePath(bundlePath, rel);
      let oldContent: string;
      try {
        oldContent = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { error: `File not found: ${rel}` };
        }
        throw err;
      }
      await fs.rm(resolved);
      const displayDiff = makeDiff(rel, oldContent, '');
      return { deleted: true, path: rel, oldContent, newContent: '', diff: displayDiff };
    }

    case 'git_commit': {
      const message = String(args?.message ?? '');
      if (!message) return { error: 'message is required' };
      await ensureGitRepo(bundlePath);
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

    case 'send_email': {
      const subject = String(args?.subject ?? '');
      const body = String(args?.body ?? '');
      if (!subject) return { error: 'subject is required' };
      if (!body) return { error: 'body is required' };
      const to = args?.to ? String(args.to) : undefined;
      try {
        const result = await sendMail({ to, subject, body });
        return { messageId: result.messageId, response: result.response };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Build the system prompt for a bundle. `mcpToolNames` are the MCP tool
 * names actually exposed for this bundle (per bundle.mcps) — kept dynamic so
 * the prompt never advertises tools the request doesn't have.
 */
export async function buildSystemPrompt(
  bundle: BundleConfig,
  mcpToolNames: string[] = [],
): Promise<string> {
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
    'You also have access to a web_search tool for quick web searches.',
    ...(mcpToolNames.length > 0
      ? [
          '',
          `Additional tools are available in this notebook: ${mcpToolNames.join(', ')}.`,
          'Their exact capabilities are described in the tool definitions — use them',
          'whenever the user\'s request matches what they offer (e.g. gw_ tools for the',
          'user\'s email/calendar, browser_ tools to read specific web pages, flex_ tools',
          'for IBKR account data).',
        ]
      : []),
    '',
    '## Uploaded documents',
    'Documents the user uploads (PDF, DOCX, images, CSV, …) are extracted to markdown',
    'under uploads/ with descriptive English filenames; the original filename is kept in',
    "the frontmatter `source` field, and the content follows the frontmatter. Read a file's",
    'uploads/*.md when the user refers to an attached document.',
    'When a message marks an attachment as a **duplicate**, the exact same document is',
    'already in the bundle: tell the user which existing file it is (link it) and do NOT',
    're-import or re-analyze its content unless they explicitly ask.',
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

// --- Active turn registry -----------------------------------------------------

/**
 * AbortControllers for live chat turns, keyed by `${bundleId}/${chatId}`.
 *
 * Client disconnects (mobile network drops, tab closes) do NOT abort a turn
 * anymore — the loop keeps running and persisting so the client can recover
 * by reloading the timeline. The only way to stop a turn is the explicit
 * `POST /:bundleId/chat/abort` endpoint (the UI's STOP button).
 */
const activeAborts = new Map<string, { controller: AbortController; userId: string }>();

// --- Route ------------------------------------------------------------------

/**
 * POST /:bundleId/chat/abort — explicitly abort the active turn of a chat
 * (the UI's STOP button). Client disconnects alone no longer cancel turns,
 * so stopping requires this call. Returns 404 when no turn is active.
 */
router.post('/:bundleId/chat/abort', async (req, res, next) => {
  try {
    const bundleId = req.params.bundleId as string;
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : '';
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    const entry = activeAborts.get(`${bundleId}/${chatId}`);
    if (!entry) {
      return res.status(404).json({ error: 'No active turn for this chat' });
    }
    if (entry.userId !== req.user?.email) {
      return res.status(403).json({ error: 'Not your chat' });
    }
    chatLogger(newTraceId()).info(`Explicit abort: bundle=${bundleId} chatId=${chatId}`);
    entry.controller.abort();
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:bundleId/chat — agentic chat with server-side tool use, streamed as
 * Server-Sent Events.
 *
 * Request body: `{ messages: ChatMessage[], chatId?: string }`.
 * When `chatId` is provided, the server persists each event to the chat
 * timeline as it happens (user message, tool calls, assistant response).
 *
 * SSE events: `tool_call`, `content`, `edit_applied`, `retry`, `done`, `error`.
 *
 * A `retry` event is emitted when a transient LLM failure (mid-stream drop,
 * rate limit, empty response) is being retried. It carries
 * `{ attempt, maxAttempts, reason, waitMs }`; any partial content streamed
 * for the failed attempt is discarded and fully re-streamed after the retry,
 * so clients should drop trailing content on receipt.
 *
 * Client disconnects do NOT stop the turn — the loop keeps running and
 * persisting to the timeline (ended by a `turn_end` event) so a reconnecting
 * client can catch up. Only POST /chat/abort (STOP button) cancels work.
 */
router.post('/:bundleId/chat', async (req, res, next) => {
  const bundleId = req.params.bundleId as string;
  const traceId = newTraceId();
  const log = chatLogger(traceId);
  const tStart = Date.now();
  // Registry key for the explicit-abort endpoint — declared here so the
  // outer finally can always unregister the turn.
  let abortKey: string | null = null;

  try {
    const bundle = await getBundle(bundleId);
    if (!bundle) {
      log.warn('Bundle not found');
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      log.warn('Bad request: messages missing or empty');
      return res.status(400).json({ error: 'messages (ChatMessage[]) is required' });
    }

    const chatId: string | null =
      typeof req.body?.chatId === 'string' ? req.body.chatId : null;

    log.info(
      `Request: bundle=${bundleId}, chatId=${chatId ?? 'none'}, ` +
      `${messages.length} msgs, role=${req.user?.role ?? 'unknown'}`,
    );

    // Sequential persistence — chains promises to avoid read-modify-write
    // races between concurrent appendEvent calls.
    let persistChain: Promise<void> = Promise.resolve();
    const persist = (event: Parameters<typeof appendEvent>[3]) => {
      if (!chatId) return;
      persistChain = persistChain
        .then(() => appendEvent(bundleId, chatId, req.user!.email, event))
        .catch(() => { /* best-effort */ });
    };

    // Select tools based on the user's role, and filter MCP tools to the
    // servers enabled for this bundle (`mcps` undefined → all servers).
    const role = req.user?.role;
    const bundleTools = role === 'full' ? FULL_TOOLS : READONLY_TOOLS;
    const mcpTools = mcpManager.getToolDefinitions(bundle.mcps);
    const exposedMcpTools = new Set(mcpTools.map((t) => t.function.name));
    const allTools = [...bundleTools, ...mcpTools];

    const ctx: ToolContext = { bundle, user: req.user };

    // --- SSE headers ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.flushHeaders?.();

    // Track client connection state. A disconnect (mobile network drop, tab
    // close, STOP-button fetch abort) does NOT abort the turn — the loop
    // keeps running below and persists every event, so a reconnecting client
    // can catch up from the timeline. Only POST /chat/abort cancels work.
    let clientConnected = true;
    const abortController = new AbortController();
    abortKey = chatId ? `${bundleId}/${chatId}` : null;
    if (abortKey) {
      activeAborts.set(abortKey, { controller: abortController, userId: req.user!.email });
    }
    req.on('close', () => {
      if (clientConnected) {
        log.info(
          `Client disconnected (after ${Date.now() - tStart}ms) — ` +
          'continuing the turn in the background (persists to the timeline)',
        );
      }
      clientConnected = false;
    });

    // SSE heartbeat: the LLM can "think" for minutes before emitting its
    // first token (observed: 182s). During that silence nothing is written
    // to the client, and intermediaries with idle read timeouts close the
    // connection — nginx's `proxy_read_timeout 180s` did exactly that
    // ("upstream timed out while reading upstream", 2026-08-17). A comment
    // line every 25s keeps the connection alive; SSE clients ignore it.
    const heartbeat = setInterval(() => {
      if (!clientConnected) return;
      try {
        res.write(': ping\n\n');
      } catch {
        clientConnected = false;
      }
    }, 25_000);
    res.on('close', () => clearInterval(heartbeat));

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
    const systemPrompt = await buildSystemPrompt(
      bundle,
      [...exposedMcpTools],
    );
    const callMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // Stamp the current date/time onto the newest user message so the LLM
    // always knows "now" (day of week, date, time, timezone) even in long
    // sessions — e.g. for market-hours reasoning. Only the copy sent to the
    // LLM is stamped; the persisted message and older history stay untouched.
    const now = new Date();
    const taipei = now.toLocaleString('en-US', {
      timeZone: 'Asia/Taipei',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    const utc = now.toISOString().slice(11, 16);
    const stamp = `[Current date/time: ${taipei} (UTC ${utc})]`;
    for (let i = callMessages.length - 1; i >= 0; i--) {
      const m = callMessages[i];
      if (m?.role === 'user') {
        callMessages[i] = { ...m, content: `${stamp}\n\n${m.content}` };
        break;
      }
    }

    // Persist the new user message at the start of the turn.
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      persist({ kind: 'user', content: lastUserMsg.content });
    }

    // Accumulate streamed content so we can persist the full assistant message.
    let turnContent = '';
    let loopIteration = 0;

    try {
      for (;;) {
        loopIteration++;

        // NOTE: no clientConnected check here — a disconnected client must
        // not stop the turn. The loop runs to completion (or an explicit
        // abort), persisting everything to the timeline.

        // Stream content deltas to the client as they arrive.
        log.debug(`Loop iter ${loopIteration}: calling LLM (${callMessages.length} messages in context)`);

        // LLM call with turn-level retry. `chatCompletionStream` already
        // retries pre-stream HTTP failures (429/5xx); this layer additionally
        // recovers mid-stream drops ("TypeError: terminated"), API errors
        // surfaced inside SSE chunks, and completely empty responses. On a
        // retry, any partial content streamed for the failed attempt is
        // discarded (server-side via turnContent reset, client-side via the
        // `retry` event) and the same request is re-issued — content can
        // never be duplicated.
        const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
        let response: ChatCompletionResult;
        for (let attempt = 1; ; attempt++) {
          try {
            response = await chatCompletionStream(
              callMessages,
              allTools,
              (delta) => {
                turnContent += delta;
                emit('content', { text: delta });
              },
              abortController.signal,
              log,
            );
            if (response.content.trim() === '' && !response.tool_calls?.length) {
              throw new Error('empty response (no content, no tool calls)');
            }
            break;
          } catch (err) {
            // Explicit abort (STOP) — never retried.
            if (
              abortController.signal.aborted ||
              (err instanceof Error && err.name === 'AbortError')
            ) {
              throw err;
            }
            if (attempt >= MAX_ATTEMPTS) throw err;
            const reason = err instanceof Error ? err.message : String(err);
            const waitMs = Math.min(2_000 * 2 ** (attempt - 1), 15_000);
            log.warn(
              `LLM call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${reason} — ` +
              `retrying in ${waitMs}ms (discarding ${turnContent.length} partial chars)`,
            );
            // Discard partial content from the failed attempt and tell the
            // client to do the same before the retry re-streams the answer.
            turnContent = '';
            emit('retry', { attempt, maxAttempts: MAX_ATTEMPTS, reason, waitMs });
            await sleep(waitMs, abortController.signal); // abort during wait throws
          }
        }

        if (response.tool_calls && response.tool_calls.length > 0) {
          // Persist any content accumulated before the tool calls so the
          // timeline preserves the correct text-to-tool ordering.
          if (turnContent.trim()) {
            persist({ kind: 'assistant', content: turnContent });
          }
          turnContent = '';

          // Append the assistant turn carrying all tool calls (once).
          callMessages.push({
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: response.tool_calls,
          });

          // Execute each tool call and feed results back.
          for (const tc of response.tool_calls) {
            // NOTE: no clientConnected check — tools run to completion even
            // after a disconnect so the persisted timeline stays complete.
            const toolName = tc.function.name;
            let parsedArgs: unknown = {};
            try {
              parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              parsedArgs = {};
            }

            log.debug(`Tool: ${toolName}`, JSON.stringify(parsedArgs).slice(0, 200));
            const tTool = Date.now();
            let result: unknown;
            try {
              if (mcpManager.hasTool(toolName)) {
                if (!exposedMcpTools.has(toolName)) {
                  // Known MCP tool but not enabled for this bundle — refuse
                  // instead of silently executing a hidden capability.
                  result = { error: `Tool "${toolName}" is not enabled for this bundle` };
                } else {
                  // Pre-check: if this is a Google Workspace tool, validate auth
                  // for THE LOGGED-IN USER (refreshing if needed). If the token
                  // can't be refreshed (e.g. 7-day test expiry), short-circuit
                  // so the MCP doesn't hang trying its own browser-based OAuth.
                  if (toolName.startsWith('gw_')) {
                    const ok = await validateWorkspaceAuth(ctx.user?.email ?? '');
                    if (!ok) {
                      result = { error: '__WORKSPACE_AUTH_REQUIRED__' };
                    }
                  }
                  if (result === undefined) {
                    result = await mcpManager.callTool(toolName, parsedArgs, {
                      userEmail: ctx.user?.email,
                    });
                  }
                }
              } else {
                result = await executeTool(toolName, parsedArgs, ctx);
              }
            } catch (err) {
              log.errorTrace(`Tool error: ${toolName}`, err);
              result = {
                error: err instanceof Error ? err.message : String(err),
              };
            }
            log.debug(`Tool done: ${toolName} (${Date.now() - tTool}ms)`);

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
            } else if (toolName === 'delete_file') {
              const r = result as {
                path?: string;
                oldContent?: string;
                diff?: string;
                error?: string;
              };
              if (!r.error) {
                emit('edit_applied', {
                  type: 'delete',
                  path: r.path,
                  oldContent: r.oldContent,
                  diff: r.diff,
                });
                persist({
                  kind: 'proposed',
                  change: {
                    id: tc.id,
                    type: 'delete',
                    path: r.path ?? '',
                    oldContent: r.oldContent,
                    newContent: '',
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
        if (!turnContent.trim()) {
          log.warn(`LLM returned empty content — no tool calls, no text (iter=${loopIteration}). User will see an empty response.`);
        } else {
          log.info(`Turn complete (${Date.now() - tStart}ms, ${loopIteration} iter, ${turnContent.length} chars)`);
        }
        persist({ kind: 'assistant', content: turnContent });
        persist({ kind: 'turn_end' });
        emit('done', {});
        if (clientConnected) res.end();
        return;
      }
    } catch (err) {
      // If the abort signal fired (explicit STOP via /chat/abort), persist
      // what we have without surfacing an error.
      if (abortController.signal.aborted) {
        log.info(`Turn aborted by explicit stop (after ${Date.now() - tStart}ms, ${turnContent.length} chars accumulated)`);
        if (turnContent.trim()) {
          persist({ kind: 'assistant', content: turnContent });
        }
        persist({ kind: 'turn_end' });
        if (clientConnected) res.end();
        return;
      }
      log.errorTrace(`Turn failed (bundle=${bundleId} chatId=${chatId}, iter=${loopIteration})`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      // Persist error + whatever content was accumulated.
      persist({ kind: 'error', content: errMsg });
      persist({ kind: 'assistant', content: turnContent || '⚠️ This response was interrupted.' });
      persist({ kind: 'turn_end' });
      emit('error', { message: errMsg });
      if (clientConnected) res.end();
    }
  } catch (err) {
    log.errorTrace('Fatal error', err);
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
  } finally {
    if (abortKey) activeAborts.delete(abortKey);
  }
});

// --- Compaction -------------------------------------------------------------

/**
 * Tool that lets the LLM name the chat session. Used by /compact and /retitle
 * so the title comes out of the same query instead of a separate round-trip.
 */
const SET_TITLE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'set_title',
    description:
      'Set the chat session title. Call exactly once with a concise title for the conversation.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Concise conversation title: 4-8 words, max 60 characters, Title Case.',
        },
      },
      required: ['title'],
    },
  },
};

/** Extract the title from a `set_title` tool call in a completion result. */
function extractSetTitle(result: {
  content: string;
  tool_calls?: ToolCall[];
}): string | null {
  for (const tc of result.tool_calls ?? []) {
    if (tc.function.name !== 'set_title') continue;
    try {
      const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      const t = typeof args?.title === 'string' ? args.title.trim() : '';
      if (t) return t.replace(/^["']|["']$/g, '').slice(0, 60);
    } catch {
      // malformed arguments — ignore this call
    }
  }
  return null;
}

/**
 * POST /:bundleId/compact — summarise the conversation so far into a compact
 * context block. The summary replaces all prior messages as the starting point
 * for future LLM calls. The summary text is persisted as a `compaction` event
 * and returned to the client (which renders a divider, not the summary text).
 * The same query also refreshes the chat title via the set_title tool.
 */
router.post('/:bundleId/compact', async (req, res, next) => {
  const log = chatLogger(newTraceId());
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages (ChatMessage[]) is required' });
    }

    const chatId: string | null =
      typeof req.body?.chatId === 'string' ? req.body.chatId : null;

    const summaryRequest: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are a conversation summarizer. The messages below are a conversation',
          `between a user and an AI assistant working with a knowledge bundle called "${bundle.name}".`,
          '',
          'Summarize the conversation in comprehensive detail. You MUST preserve:',
          '- Every fact, decision, and conclusion reached',
          '- All file names, paths, and content discussed or edited',
          '- Code snippets, commands, and technical details',
          '- User preferences, instructions, and constraints',
          '- The current state of any tasks, proposals, or pending actions',
          '- Any URLs, dates, amounts, or other specific data',
          '- Questions that were asked but not yet answered',
          '',
          'Write the summary as a direct reference document. Do NOT use phrases like',
          '"the user asked" or "the assistant replied" — state the information directly.',
          'The summary will replace the conversation history as context for future exchanges,',
          'so it must contain everything needed to continue seamlessly.',
          '',
          'Additionally, call the set_title tool exactly once with a concise title for the',
          'whole conversation: 4-8 words, max 60 characters, Title Case, specific nouns',
          '(file names, features, entities) over vague words, no quotes, period, or emoji.',
          'Write the full summary as your message content FIRST, then call set_title.',
        ].join('\n'),
      },
      ...messages,
      {
        role: 'user',
        content:
          'Summarize the entire conversation above in comprehensive detail, preserving every fact, decision, file reference, and technical detail.',
      },
    ];

    log.info(`Compact: ${messages.length} msgs, chatId=${chatId ?? 'none'}`);

    // Models often emit a tool call with empty content, intending to write the
    // text after seeing the tool result — but a single completion never gets
    // that far. Run a tiny follow-up loop: acknowledge set_title, ask again,
    // until we have summary text (max 3 rounds).
    let result = await chatCompletion(summaryRequest, [SET_TITLE_TOOL], log);
    let summary = result.content.trim();
    for (let round = 0; round < 3 && !summary && result.tool_calls?.length; round++) {
      log.info(`Compact round ${round + 1}: content empty after tool call — requesting summary`);
      summaryRequest.push({
        role: 'assistant',
        content: result.content ?? '',
        tool_calls: result.tool_calls,
      });
      for (const tc of result.tool_calls) {
        summaryRequest.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(
            tc.function.name === 'set_title'
              ? { ok: true, note: 'Title set. Now write the full summary as your reply.' }
              : { error: 'Unexpected tool — reply with the summary text instead.' },
          ),
        });
      }
      result = await chatCompletion(summaryRequest, [SET_TITLE_TOOL], log);
      summary = result.content.trim();
    }

    // No summary text means the compaction would silently wipe context —
    // refuse instead of persisting an empty event.
    if (!summary) {
      return res
        .status(502)
        .json({ error: 'The model returned no summary text — compaction aborted, history untouched.' });
    }

    // Persist the compaction event to the chat timeline.
    if (chatId) {
      try {
        await appendEvent(bundle.id, chatId, req.user!.email, {
          kind: 'compaction',
          content: summary,
        });
      } catch {
        // best-effort
      }
    }

    // Refresh the title in the same query — no separate retitle round-trip.
    const title = extractSetTitle(result);
    if (chatId && title) {
      try {
        await renameChat(bundle.id, chatId, req.user!.email, title);
      } catch {
        // best-effort
      }
    }

    res.json({ summary, title: title ?? undefined });
  } catch (err) {
    log.errorTrace('Compact failed', err);
    next(err);
  }
});

// --- Retitle ----------------------------------------------------------------

/**
 * POST /:bundleId/retitle — ask the LLM for a concise, meaningful chat title
 * derived from the conversation. Updates the persisted session title.
 */
router.post('/:bundleId/retitle', async (req, res, next) => {
  const log = chatLogger(newTraceId());
  try {
    const bundle = await getBundle(req.params.bundleId as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages (ChatMessage[]) is required' });
    }

    const chatId: string | null =
      typeof req.body?.chatId === 'string' ? req.body.chatId : null;

    const titleRequest: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You generate concise, highly identifiable chat titles.',
          'The title must help the user instantly recall what this conversation was about.',
          'Rules:',
          '- 4 to 8 words, never more than 60 characters',
          '- Focus on the core topic, task, or outcome — not greetings or small talk',
          '- Use specific nouns (file names, feature names, entities) over vague words',
          '- No quotes, no trailing period, no emoji',
          '- Title case',
          'Analyze the conversation, then call the set_title tool with the title.',
          'Do not reply with any other content.',
        ].join('\n'),
      },
      ...messages,
      {
        role: 'user',
        content: 'Generate a concise title for this conversation.',
      },
    ];

    log.info(`Retitle: ${messages.length} msgs, chatId=${chatId ?? 'none'}`);
    const result = await chatCompletion(titleRequest, [SET_TITLE_TOOL], log);
    // Prefer the tool call; fall back to plain content if the model answered
    // in text instead of calling the tool.
    const title =
      extractSetTitle(result) ??
      result.content.trim().replace(/^["']|["']$/g, '').slice(0, 60);

    if (chatId && title) {
      try {
        await renameChat(bundle.id, chatId, req.user!.email, title);
      } catch {
        // best-effort
      }
    }

    res.json({ title });
  } catch (err) {
    log.errorTrace('Retitle failed', err);
    next(err);
  }
});

export default router;

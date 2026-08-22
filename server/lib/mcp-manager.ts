/**
 * MCP (Model Context Protocol) client manager.
 *
 * Spawns MCP servers as child processes (stdio transport), discovers their
 * tools, and routes tool calls from the LLM chat loop to the appropriate server.
 *
 * Tools are optionally namespaced with a prefix to avoid collisions between
 * MCP servers and the built-in bundle tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from './llm.js';
import {
  hasWorkspaceTokens,
  listWorkspaceUsers,
  workspaceHomeDir,
} from './workspace-auth.js';

export interface McpServerConfig {
  /** Identifier for this MCP server (used in logs). */
  name: string;
  /** Executable command (e.g. 'npx'). */
  command: string;
  /** Arguments for the command. */
  args: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Prefix added to all tool names exposed to the LLM (e.g. 'gw'). */
  toolPrefix?: string;
  /** Only expose these original tool names (before prefix). If omitted, expose all. */
  allowTools?: string[];
  /**
   * Run one child instance per workspace-connected user, each with its own
   * $HOME (token isolation). Tool calls are routed to the caller's instance
   * via `callTool(name, args, { userEmail })`. If no user has tokens yet, a
   * single tokenless instance is started for tool discovery only.
   */
  perUser?: boolean;
}

interface ToolMapping {
  serverName: string;
  originalName: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpContent = { type: string; text?: string } | Record<string, any>;

class McpManager {
  private clients = new Map<string, Client>();
  /** Per-user instances for `perUser` servers, keyed `${serverName}|${email}`. */
  private userClients = new Map<string, Client>();
  private toolMap = new Map<string, ToolMapping>();
  private toolDefs: ToolDefinition[] = [];
  private configs: McpServerConfig[] = [];
  private started = false;
  /** Last startup/connect error per server name (surfaced in the Settings UI). */
  private lastErrors = new Map<string, string>();

  /** Start all configured MCP servers and discover their tools. */
  async start(configs: McpServerConfig[]): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.configs = configs;

    const jobs: Promise<unknown>[] = [];
    for (const cfg of configs) {
      jobs.push(
        this.startConfigured(cfg).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastErrors.set(cfg.name, msg);

          console.error(`[mcp] Failed to start "${cfg.name}": ${msg}`);
        }),
      );
    }
    await Promise.allSettled(jobs);

    const total = this.toolDefs.length;

    console.log(`[mcp] Ready — ${total} tools discovered`);
  }

  /** Start one config (perUser-aware: an instance per workspace user, or a
   *  tokenless shared instance for discovery when nobody has tokens). */
  private async startConfigured(cfg: McpServerConfig): Promise<void> {
    if (cfg.perUser) {
      const users = await listWorkspaceUsers();
      if (users.length > 0) {
        const results = await Promise.allSettled(users.map((u) => this.startUserServer(cfg.name, u)));
        const failure = results.find((r) => r.status === 'rejected');
        if (failure) throw (failure as PromiseRejectedResult).reason;
        return;
      }
    }
    await this.startServer(cfg);
  }

  private async startServer(config: McpServerConfig, userEmail?: string): Promise<void> {
    const who = userEmail ? ` (user ${userEmail})` : '';

    console.log(`[mcp] Starting "${config.name}"${who}...`);

    let env: Record<string, string> | undefined;
    if (config.env) {
      env = { ...process.env, ...config.env } as Record<string, string>;
    }
    if (userEmail) {
      // Token isolation: the child resolves its token dir as
      // $HOME/.google-workspace-mcp (os.homedir() follows $HOME on Linux).
      // Keep the npm cache on the real home so npx doesn't re-download the
      // package once per user.
      env = {
        ...(env ?? (process.env as Record<string, string>)),
        HOME: workspaceHomeDir(userEmail),
        npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
      };
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(env ? { env } : {}),
    });

    const client = new Client(
      { name: 'notebook', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    if (userEmail) {
      this.userClients.set(`${config.name}|${userEmail}`, client);
    } else {
      this.clients.set(config.name, client);
    }

    const { tools } = await client.listTools();
    let count = 0;

    for (const tool of tools) {
      if (config.allowTools && !config.allowTools.includes(tool.name)) continue;

      const exposedName = config.toolPrefix
        ? `${config.toolPrefix}_${tool.name}`
        : tool.name;

      // Tool names are identical across instances of the same server —
      // register definitions/mappings only once.
      if (this.toolMap.has(exposedName)) continue;

      this.toolMap.set(exposedName, {
        serverName: config.name,
        originalName: tool.name,
      });

      this.toolDefs.push({
        type: 'function',
        function: {
          name: exposedName,
          description: tool.description ?? tool.name,
          parameters: (tool.inputSchema as object) ?? {
            type: 'object',
            properties: {},
          },
        },
      });
      count++;
    }

    this.lastErrors.delete(config.name);
    console.log(`[mcp] "${config.name}"${who} ready — ${count} new tools exposed`);
  }

  /** Names of all configured MCP servers (started or not). */
  getServerNames(): string[] {
    return this.configs.map((c) => c.name);
  }

  /** Status of every configured server, for the Settings UI. */
  listServers(): Array<{
    name: string;
    running: boolean;
    toolCount: number;
    /** Full config (incl. env secrets) — management UI, full role only. */
    config: McpServerConfig;
    /** Last startup/connect error, if any (cleared on a successful start). */
    error?: string;
  }> {
    return this.configs.map((c) => {
      const hasUserInstance = Array.from(this.userClients.keys()).some(
        (k) => k.startsWith(`${c.name}|`),
      );
      return {
        name: c.name,
        config: c,
        running: this.clients.has(c.name) || hasUserInstance,
        toolCount: this.toolDefs.filter(
          (td) => this.toolMap.get(td.function.name)?.serverName === c.name,
        ).length,
        ...(this.lastErrors.has(c.name) ? { error: this.lastErrors.get(c.name) } : {}),
      };
    });
  }

  /**
   * Discovered tool definitions (namespaced), ready for the LLM.
   * Pass `allowedServers` (bundle.mcps) to restrict to tools from those
   * servers; omitted/undefined → all servers (the default).
   */
  getToolDefinitions(allowedServers?: string[]): ToolDefinition[] {
    if (!allowedServers) return this.toolDefs;
    const allowed = new Set(allowedServers);
    return this.toolDefs.filter((td) => {
      const mapping = this.toolMap.get(td.function.name);
      return mapping !== undefined && allowed.has(mapping.serverName);
    });
  }

  /** Whether a tool name (as the LLM sees it) belongs to an MCP server. */
  hasTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  /** Execute an MCP tool by its namespaced name.
   *
   * For `perUser` servers, pass `opts.userEmail` — the call routes to that
   * user's instance (started on demand if they have tokens on disk). Without
   * a user (or without tokens), a tokenless shared instance is attempted.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(name: string, args: unknown, opts?: { userEmail?: string }): Promise<any> {
    const mapping = this.toolMap.get(name);
    if (!mapping) throw new Error(`Unknown MCP tool: ${name}`);

    const config = this.configs.find((c) => c.name === mapping.serverName);
    let client: Client | undefined;

    if (config?.perUser) {
      const email = opts?.userEmail;
      if (email) {
        const key = `${mapping.serverName}|${email}`;
        client = this.userClients.get(key);
        if (!client) {
          if (await hasWorkspaceTokens(email)) {
            await this.startUserServer(mapping.serverName, email);
            client = this.userClients.get(key);
          }
        }
      }
      if (!client) client = this.clients.get(mapping.serverName); // tokenless fallback
    } else {
      client = this.clients.get(mapping.serverName);
    }

    if (!client) throw new Error(`MCP server not connected: ${mapping.serverName}`);

    const result = await client.callTool({
      name: mapping.originalName,
      arguments: (args as Record<string, unknown>) ?? {},
    });

    if (result.isError) {
      const text = this.extractText(result.content);
      return { error: text || 'MCP tool call failed' };
    }

    const text = this.extractText(result.content);
    if (!text) return result;

    // The MCP server JSON-stringifies results, so try to parse back.
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  private extractText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    return (content as McpContent[])
      .filter((c) => typeof c === 'object' && c !== null && c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  }

  /** Close the shared instance and every per-user instance of a server,
   *  forgetting its tool registrations. Used by restart/update/remove. */
  private async closeServer(name: string): Promise<void> {
    const oldClient = this.clients.get(name);
    if (oldClient) {
      await oldClient.close().catch(() => {});
      this.clients.delete(name);
    }
    for (const key of Array.from(this.userClients.keys())) {
      if (key.startsWith(`${name}|`)) {
        await this.userClients.get(key)!.close().catch(() => {});
        this.userClients.delete(key);
      }
    }
    this.forgetServerTools(name);
  }

  /**
   * Restart (or start with a new config) a single MCP server — used by the
   * Settings management UI and after workspace tokens are rewritten. For
   * `perUser` servers, every per-user instance is restarted too.
   *
   * @param config When given, replaces the stored config first (update flow).
   */
  async restartServer(name: string, config?: McpServerConfig): Promise<void> {
    const idx = this.configs.findIndex((c) => c.name === name);
    if (idx === -1 && !config) throw new Error(`Unknown MCP server: ${name}`);
    if (config) {
      if (idx === -1) this.configs.push(config);
      else this.configs[idx] = config;
    }
    const cfg = this.configs.find((c) => c.name === name)!;
    await this.closeServer(name);
    try {
      await this.startConfigured(cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrors.set(name, msg);
      throw err;
    }
  }

  /** Stop a server, forget its config and tools (Settings remove flow). */
  async stopServer(name: string): Promise<void> {
    await this.closeServer(name);
    this.lastErrors.delete(name);
    this.configs = this.configs.filter((c) => c.name !== name);
  }

  /**
   * Start the per-user instance of a `perUser` server if it isn't already
   * running (no-op otherwise). Safe to call repeatedly, e.g. lazily before a
   * tool call once the user's tokens land on disk.
   */
  async startUserServer(name: string, email: string): Promise<void> {
    if (this.userClients.has(`${name}|${email}`)) return;
    const config = this.configs.find((c) => c.name === name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    await this.startServer(config, email);
  }

  /**
   * Start (or restart) the per-user instance of a `perUser` server — e.g.
   * right after that user's workspace tokens were (re)written on login.
   */
  async restartUserServer(name: string, email: string): Promise<void> {
    const config = this.configs.find((c) => c.name === name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);

    const key = `${name}|${email}`;
    const oldClient = this.userClients.get(key);
    if (oldClient) {
      await oldClient.close().catch(() => {});
      this.userClients.delete(key);
    }
    await this.startServer(config, email);
  }

  /** Remove tool mappings/definitions belonging to a server (shared instance). */
  private forgetServerTools(name: string): void {
    const toolsToRemove: string[] = [];
    for (const [toolName, mapping] of this.toolMap) {
      if (mapping.serverName === name) {
        toolsToRemove.push(toolName);
        this.toolMap.delete(toolName);
      }
    }
    this.toolDefs = this.toolDefs.filter(
      (td) => !toolsToRemove.includes(td.function.name),
    );
  }

  /** Gracefully shut down all MCP child processes. */
  async stop(): Promise<void> {
    await Promise.allSettled(
      [...Array.from(this.clients.values()), ...Array.from(this.userClients.values())].map((c) =>
        c.close(),
      ),
    );
    this.clients.clear();
    this.userClients.clear();
    this.toolMap.clear();
    this.toolDefs = [];
    this.lastErrors.clear();
    this.started = false;
  }
}

export const mcpManager = new McpManager();

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
import type { ToolDefinition } from './llm.js';

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
}

interface ToolMapping {
  serverName: string;
  originalName: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpContent = { type: string; text?: string } | Record<string, any>;

class McpManager {
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, ToolMapping>();
  private toolDefs: ToolDefinition[] = [];
  private configs: McpServerConfig[] = [];
  private started = false;

  /** Start all configured MCP servers and discover their tools. */
  async start(configs: McpServerConfig[]): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.configs = configs;

    await Promise.allSettled(
      configs.map((cfg) =>
        this.startServer(cfg).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[mcp] Failed to start "${cfg.name}": ${msg}`);
        }),
      ),
    );

    const total = this.toolDefs.length;
    // eslint-disable-next-line no-console
    console.log(`[mcp] Ready — ${total} tools discovered`);
  }

  private async startServer(config: McpServerConfig): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[mcp] Starting "${config.name}"...`);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env ? { env: { ...process.env, ...config.env } as Record<string, string> } : {}),
    });

    const client = new Client(
      { name: 'notebook', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    this.clients.set(config.name, client);

    const { tools } = await client.listTools();
    let count = 0;

    for (const tool of tools) {
      if (config.allowTools && !config.allowTools.includes(tool.name)) continue;

      const exposedName = config.toolPrefix
        ? `${config.toolPrefix}_${tool.name}`
        : tool.name;

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

    // eslint-disable-next-line no-console
    console.log(`[mcp] "${config.name}" ready — ${count} tools exposed`);
  }

  /** Names of all configured MCP servers (started or not). */
  getServerNames(): string[] {
    return this.configs.map((c) => c.name);
  }

  /** Status of every configured server, for the Settings UI. */
  listServers(): Array<{ name: string; running: boolean; toolCount: number }> {
    return this.configs.map((c) => ({
      name: c.name,
      running: this.clients.has(c.name),
      toolCount: this.toolDefs.filter(
        (td) => this.toolMap.get(td.function.name)?.serverName === c.name,
      ).length,
    }));
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

  /** Execute an MCP tool by its namespaced name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(name: string, args: unknown): Promise<any> {
    const mapping = this.toolMap.get(name);
    if (!mapping) throw new Error(`Unknown MCP tool: ${name}`);

    const client = this.clients.get(mapping.serverName);
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

  /** Restart a single MCP server by name (e.g. after updating its auth tokens). */
  async restartServer(name: string): Promise<void> {
    const config = this.configs.find((c) => c.name === name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);

    // Close old client
    const oldClient = this.clients.get(name);
    if (oldClient) {
      await oldClient.close().catch(() => {});
      this.clients.delete(name);
    }

    // Remove tool mappings for this server
    const toolsToRemove: string[] = [];
    for (const [toolName, mapping] of this.toolMap) {
      if (mapping.serverName === name) {
        toolsToRemove.push(toolName);
        this.toolMap.delete(toolName);
      }
    }
    // Remove tool definitions belonging to this server
    this.toolDefs = this.toolDefs.filter(
      (td) => !toolsToRemove.includes(td.function.name),
    );

    // Restart
    await this.startServer(config);
  }

  /** Gracefully shut down all MCP child processes. */
  async stop(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.values()).map((c) => c.close()),
    );
    this.clients.clear();
    this.toolMap.clear();
    this.toolDefs = [];
    this.started = false;
  }
}

export const mcpManager = new McpManager();

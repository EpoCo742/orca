import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig } from '@orca/shared';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  content: unknown[];
  structured?: unknown;
}

/** One-shot MCP client: connect, act, disconnect. Config must already have secrets resolved. */
export class McpConnection {
  private client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

  constructor(
    private readonly config: McpServerConfig,
    private readonly cwd?: string,
  ) {
    this.client = new Client({ name: 'orca', version: '0.1.0' });
    if (config.type === 'stdio') {
      const isWin = process.platform === 'win32';
      // On Windows, `npx`/`npm` are .cmd shims and must run through a shell.
      const needsShell = isWin && /^(npx|npm|pnpm|yarn|node_modules)/i.test(config.command);
      this.transport = new StdioClientTransport({
        command: needsShell ? 'cmd' : config.command,
        args: needsShell ? ['/d', '/s', '/c', [config.command, ...config.args].join(' ')] : config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
        cwd,
        stderr: 'pipe',
      });
    } else if (config.type === 'http') {
      this.transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    } else {
      this.transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    }
  }

  async connect(timeoutMs = 30_000): Promise<void> {
    await withTimeout(this.client.connect(this.transport), timeoutMs, 'MCP connect');
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations as Record<string, unknown> | undefined }));
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpCallResult> {
    const res = (await withTimeout(this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }), timeoutMs + 1000, `MCP tool ${name}`)) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    const content = res.content ?? [];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    return { isError: Boolean(res.isError), text, content, structured: res.structuredContent };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function withMcp<T>(config: McpServerConfig, cwd: string | undefined, fn: (c: McpConnection) => Promise<T>): Promise<T> {
  const c = new McpConnection(config, cwd);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

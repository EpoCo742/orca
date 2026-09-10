import type { McpServerConfig } from '@orca/shared';

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  config: McpServerConfig;
  requiredSecrets: string[];
  notes?: string;
}

/** Placeholders `${SECRET:NAME}` and `${CWD}` are resolved at connection time. */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'github',
    name: 'GitHub (remote)',
    description: 'Official GitHub MCP server: issues, pull requests, repositories, code search.',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${SECRET:GITHUB_TOKEN}' } },
    requiredSecrets: ['GITHUB_TOKEN'],
    notes: 'GITHUB_TOKEN: a personal access token (fine-grained or classic) with access to the repositories you want. Copilot agent sessions also have GitHub tools built in without this server.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira, Confluence)',
    description: 'Official Atlassian remote MCP server via the mcp-remote OAuth bridge (browser sign-in on first use).',
    config: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'], env: {} },
    requiredSecrets: [],
    notes: 'The first connection opens a browser for Atlassian OAuth; tokens are cached by mcp-remote. Not exercised yet (no Jira site available during M3).',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files under the node working directory.',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${CWD}'], env: {} },
    requiredSecrets: [],
  },
  {
    id: 'playwright',
    name: 'Playwright (browser)',
    description: 'Drive a browser: navigate, click, read pages, take screenshots.',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
    requiredSecrets: [],
  },
];

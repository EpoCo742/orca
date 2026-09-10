import { z } from 'zod';

/** Author-facing stable identifier, usable inside expressions as `nodes.<id>`. */
export const NodeId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'node ids are lowercase snake_case, start with a letter');
export type NodeId = z.infer<typeof NodeId>;
export const PortId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export type PortId = z.infer<typeof PortId>;

export const PortType = z.enum(['trigger', 'string', 'number', 'boolean', 'json', 'any']);
export type PortType = z.infer<typeof PortType>;

export interface PortDecl {
  id: PortId;
  type: PortType;
  label?: string;
  description?: string;
  /** For inputs: whether an incoming edge is required for the node to run. */
  required?: boolean;
}

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs: z.number().int().min(0).default(2000),
  retryOn: z.array(z.enum(['error', 'timeout', 'budget', 'nonzero_exit', 'schema_invalid'])).default(['error', 'timeout']),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const NodeBase = z.object({
  id: NodeId,
  type: z.string(),
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ w: z.number(), h: z.number() }).optional(),
  /** Containing Loop/Map node id. */
  parent: NodeId.optional(),
  disabled: z.boolean().default(false),
  retry: RetryPolicy.prefault({}),
  timeoutMs: z.number().int().positive().optional(),
  config: z.unknown().optional(),
});
export type NodeBase = z.infer<typeof NodeBase>;

export const Edge = z.object({
  id: z.string().min(1),
  from: z.object({ node: NodeId, port: PortId }),
  to: z.object({ node: NodeId, port: PortId }),
  /** Optional guard expression; the edge only carries a signal when truthy. */
  when: z.string().optional(),
});
export type Edge = z.infer<typeof Edge>;

export const WorkflowInput = z.object({
  name: PortId,
  type: z.enum(['string', 'number', 'boolean', 'json']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInput>;

/** MCP server configuration. String values may contain `${SECRET:NAME}` and `${CWD}` placeholders. */
export const McpServerConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }),
  z.object({ type: z.literal('http'), url: z.string().min(1), headers: z.record(z.string(), z.string()).default({}) }),
  z.object({ type: z.literal('sse'), url: z.string().min(1), headers: z.record(z.string(), z.string()).default({}) }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const WorkflowSettings = z.object({
  /** Repository the workflow acts on. Relative paths resolve against the workflow file's directory. */
  repoPath: z.string().optional(),
  defaultModel: z.string().default('claude-sonnet-5'),
  defaultEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  runBudgetPremiumRequests: z.number().int().positive().default(200),
  runBudgetUsd: z.number().positive().default(25),
  maxConcurrentAgents: z.number().int().min(1).max(16).default(4),
  unattended: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  secrets: z.array(z.string()).default([]),
  /** Named MCP servers available to agent nodes (by name) and MCP tool nodes. */
  mcpServers: z.record(z.string(), McpServerConfig).default({}),
  retention: z.object({ worktreesDays: z.number().positive().default(7) }).prefault({}),
  worktree: z
    .object({
      /** `head`: branch from the current HEAD of the main checkout; `default-branch`: from origin's default branch. */
      baseRef: z.enum(['head', 'default-branch']).default('head'),
      /** Directory for worktrees, relative to the repo root. */
      dir: z.string().default('.orca/worktrees'),
      /** Directories to link (junction/symlink) from the main checkout into each worktree, e.g. node_modules. */
      linkDirs: z.array(z.string()).default([]),
      /** Command to run inside a fresh worktree (dependency install). */
      setupCommand: z.string().optional(),
    })
    .prefault({}),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettings>;

export const WorkflowDocument = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(WorkflowInput).default([]),
  settings: WorkflowSettings.prefault({}),
  nodes: z.array(NodeBase),
  edges: z.array(Edge),
  ui: z
    .object({
      viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
      notes: z.string().optional(),
    })
    .prefault({}),
});
export type WorkflowDocument = z.infer<typeof WorkflowDocument>;
export type WorkflowDocumentInput = z.input<typeof WorkflowDocument>;

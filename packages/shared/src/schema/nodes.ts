import { z } from 'zod';
import { NodeId, PortId, type PortDecl } from './workflow.js';

/** Implicit ports every node has. */
export const IMPLICIT_INPUTS: PortDecl[] = [{ id: 'trigger', type: 'trigger', label: 'Trigger' }];
export const IMPLICIT_OUTPUTS: PortDecl[] = [
  { id: 'done', type: 'trigger', label: 'Done' },
  { id: 'error', type: 'json', label: 'Error' },
];

export type NodeCategory = 'trigger' | 'agent' | 'action' | 'control' | 'data';

export interface NodeTypeDef<TConfig = unknown> {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: PortDecl[];
  outputs: PortDecl[];
  config: z.ZodType<TConfig>;
  /** Container nodes own a child subgraph (children carry `parent = this node id`). */
  container?: 'loop' | 'map';
  /** Fields whose string values are rendered as `{{ }}` templates before execution. */
  templateFields?: string[];
}

// ---------------------------------------------------------------- trigger.manual
export const ManualTriggerConfig = z.object({
  inputsForm: z.array(PortId).default([]),
});
export type ManualTriggerConfig = z.infer<typeof ManualTriggerConfig>;

// ---------------------------------------------------------------- action.shell
export const ShellConfig = z.object({
  command: z.string().min(1),
  shell: z.enum(['auto', 'bash', 'powershell', 'cmd', 'sh']).default('auto'),
  cwdRelative: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(600_000),
  failOnNonZero: z.boolean().default(false),
  captureLimitBytes: z.number().int().positive().default(1_000_000),
});
export type ShellConfig = z.infer<typeof ShellConfig>;

// ---------------------------------------------------------------- control.condition
export const ConditionConfig = z.object({
  expression: z.string().min(1),
});
export type ConditionConfig = z.infer<typeof ConditionConfig>;

// ---------------------------------------------------------------- control.loop
export const LoopConfig = z.object({
  /** Expression over the body's outputs, evaluated after each iteration. Loop exits when truthy. */
  until: z.string().min(1),
  maxIterations: z.number().int().min(1).max(100),
  budgetPremiumRequests: z.number().int().positive().optional(),
});
export type LoopConfig = z.infer<typeof LoopConfig>;

// ---------------------------------------------------------------- data.transform
export const TransformConfig = z.object({
  /** JavaScript function body. Receives `ctx` ({ inputs, nodes, item, index, iteration, run, env }). Must return a value. */
  code: z.string().min(1),
});
export type TransformConfig = z.infer<typeof TransformConfig>;

// ---------------------------------------------------------------- agent.copilot
export const ApprovalPolicy = z.object({
  onUnresolved: z.enum(['ask', 'deny']).default('ask'),
  timeoutSec: z.number().int().positive().default(1800),
  onTimeout: z.enum(['deny', 'allow']).default('deny'),
  autoAllowReadOnly: z.boolean().default(true),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const AgentSystemConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preset'), append: z.string().optional() }),
  z.object({ mode: z.literal('custom'), text: z.string() }),
]);

export const AgentCopilotConfig = z.object({
  adapter: z.enum(['copilot', 'fake']).default('copilot'),
  prompt: z.string().min(1),
  system: AgentSystemConfig.prefault({ mode: 'preset' }),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /**
   * Orca permission rules. Forms: `Read`, `Write`, `Shell(<glob>)`, `Mcp(<server>/<tool-glob>)`, `Url(<glob>)`.
   * A bare `Shell` allows every shell command. Rules are matched against Copilot permission requests.
   */
  allowedTools: z.array(z.string()).default(['Read', 'Write', 'Shell(git status*)', 'Shell(git diff*)', 'Shell(npm test*)', 'Shell(npx vitest*)']),
  disallowedTools: z.array(z.string()).default([]),
  approval: ApprovalPolicy.prefault({}),
  maxPremiumRequests: z.number().int().positive().default(30),
  maxToolCalls: z.number().int().positive().default(400),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  cwdRelative: z.string().optional(),
  isolation: z.enum(['none', 'worktree']).default('none'),
  env: z.record(z.string(), z.string()).default({}),
});
export type AgentCopilotConfig = z.infer<typeof AgentCopilotConfig>;

// ---------------------------------------------------------------- registry
export const NODE_TYPES: Record<string, NodeTypeDef> = {
  'trigger.manual': {
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Manual trigger',
    description: 'Starts a run when a person clicks Run.',
    inputs: [],
    outputs: [{ id: 'inputs', type: 'json', label: 'Inputs' }],
    config: ManualTriggerConfig,
  },
  'agent.copilot': {
    type: 'agent.copilot',
    category: 'agent',
    label: 'Copilot agent',
    description: 'Runs a GitHub Copilot agent session with a templated prompt.',
    inputs: [{ id: 'context', type: 'any', label: 'Context' }],
    outputs: [
      { id: 'text', type: 'string', label: 'Final message' },
      { id: 'cost', type: 'json', label: 'Cost' },
      { id: 'session_id', type: 'string', label: 'Session id' },
      { id: 'num_turns', type: 'number', label: 'Model calls' },
      { id: 'tool_calls', type: 'number', label: 'Tool calls' },
      { id: 'result_subtype', type: 'string', label: 'Result' },
    ],
    config: AgentCopilotConfig,
    templateFields: ['prompt', 'system.append', 'system.text'],
  },
  'action.shell': {
    type: 'action.shell',
    category: 'action',
    label: 'Shell',
    description: 'Runs a shell command in the repository and captures its output.',
    inputs: [],
    outputs: [
      { id: 'exit_code', type: 'number', label: 'Exit code' },
      { id: 'stdout', type: 'string', label: 'stdout' },
      { id: 'stderr', type: 'string', label: 'stderr' },
      { id: 'duration_ms', type: 'number', label: 'Duration (ms)' },
    ],
    config: ShellConfig,
    templateFields: ['command'],
  },
  'control.condition': {
    type: 'control.condition',
    category: 'control',
    label: 'Condition',
    description: 'Routes to true or false based on an expression.',
    inputs: [],
    outputs: [
      { id: 'true', type: 'trigger', label: 'True' },
      { id: 'false', type: 'trigger', label: 'False' },
      { id: 'value', type: 'boolean', label: 'Value' },
    ],
    config: ConditionConfig,
  },
  'control.loop': {
    type: 'control.loop',
    category: 'control',
    label: 'Loop',
    description: 'Runs its body until a condition is true or the iteration cap is reached.',
    inputs: [],
    outputs: [
      { id: 'last', type: 'json', label: 'Last iteration outputs' },
      { id: 'iterations', type: 'number', label: 'Iterations' },
      { id: 'exited_by', type: 'string', label: 'Exited by' },
    ],
    config: LoopConfig,
    container: 'loop',
  },
  'data.transform': {
    type: 'data.transform',
    category: 'data',
    label: 'Transform',
    description: 'Computes a value with sandboxed JavaScript.',
    inputs: [],
    outputs: [{ id: 'value', type: 'any', label: 'Value' }],
    config: TransformConfig,
  },
};

export function getNodeType(type: string): NodeTypeDef | undefined {
  return NODE_TYPES[type];
}

export function nodeInputs(def: NodeTypeDef): PortDecl[] {
  return [...IMPLICIT_INPUTS, ...def.inputs];
}
export function nodeOutputs(def: NodeTypeDef): PortDecl[] {
  return [...def.outputs, ...IMPLICIT_OUTPUTS];
}

export { NodeId };

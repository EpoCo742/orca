import type { NodeExecutor } from '../context.js';
import { agentExecutor } from './agent.js';
import { conditionExecutor, manualTriggerExecutor, shellExecutor, transformExecutor } from './basic.js';
import { gitExecutor } from './git.js';
import { gateExecutor } from './gate.js';
import { notifyExecutor } from './notify.js';
import { joinExecutor } from './join.js';
import { subWorkflowExecutor } from './sub.js';
import { mcpToolExecutor } from './mcp_tool.js';

export function defaultExecutors(): Map<string, NodeExecutor> {
  const list: NodeExecutor[] = [
    manualTriggerExecutor,
    conditionExecutor,
    transformExecutor,
    shellExecutor as NodeExecutor,
    agentExecutor as NodeExecutor,
    gitExecutor as NodeExecutor,
    gateExecutor as NodeExecutor,
    notifyExecutor as NodeExecutor,
    joinExecutor as NodeExecutor,
    subWorkflowExecutor as NodeExecutor,
    mcpToolExecutor as NodeExecutor,
  ];
  return new Map(list.map((e) => [e.type, e]));
}

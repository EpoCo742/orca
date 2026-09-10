import type { NodeExecutor } from '../context.js';
import { agentExecutor } from './agent.js';
import { conditionExecutor, manualTriggerExecutor, shellExecutor, transformExecutor } from './basic.js';
import { gitExecutor } from './git.js';
import { gateExecutor } from './gate.js';
import { notifyExecutor } from './notify.js';

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
  ];
  return new Map(list.map((e) => [e.type, e]));
}

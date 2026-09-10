import { z } from 'zod';

export const ORCA_VERSION = '0.1.0';
export const API_PREFIX = '/api/v1';

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeMs: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const AuthStatusResponse = z.object({
  provider: z.literal('copilot'),
  isAuthenticated: z.boolean(),
  authType: z.string().optional(),
  login: z.string().optional(),
  host: z.string().optional(),
  statusMessage: z.string().optional(),
  error: z.string().optional(),
});
export type AuthStatusResponse = z.infer<typeof AuthStatusResponse>;

export const ModelSummary = z.object({
  id: z.string(),
  name: z.string(),
  multiplier: z.number().optional(),
  supportedReasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

export const ModelsResponse = z.object({
  models: z.array(ModelSummary),
  error: z.string().optional(),
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

export * from './schema/workflow.js';
export * from './schema/nodes.js';
export * from './events.js';
export * from './api.js';
export * from './template.js';

export * from './projection.js';

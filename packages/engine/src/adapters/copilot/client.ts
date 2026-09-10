import { CopilotClient, type CopilotClientOptions, type ModelInfo } from '@github/copilot-sdk';
import type { AuthStatusResponse, ModelSummary } from '@orca/shared';

/**
 * Process-wide Copilot client. The SDK spawns the bundled Copilot runtime in server mode and
 * talks JSON-RPC to it; one client per engine process is enough, sessions are per agent run.
 */
let client: CopilotClient | undefined;
let starting: Promise<CopilotClient> | undefined;

export interface CopilotClientConfig {
  workingDirectory?: string;
  logLevel?: CopilotClientOptions['logLevel'];
  gitHubToken?: string;
}

export async function getCopilotClient(config: CopilotClientConfig = {}): Promise<CopilotClient> {
  if (client) return client;
  if (!starting) {
    starting = (async () => {
      const c = new CopilotClient({
        useLoggedInUser: config.gitHubToken ? false : true,
        gitHubToken: config.gitHubToken,
        logLevel: config.logLevel ?? 'warning',
        workingDirectory: config.workingDirectory ?? process.cwd(),
        clientInfo: { applicationName: 'orca', applicationVersion: '0.0.0' },
      });
      await c.start();
      client = c;
      return c;
    })();
  }
  return starting;
}

export async function stopCopilotClient(): Promise<void> {
  const c = client;
  client = undefined;
  starting = undefined;
  if (c) await c.stop();
}

export async function copilotAuthStatus(config: CopilotClientConfig = {}): Promise<AuthStatusResponse> {
  try {
    const c = await getCopilotClient(config);
    const s = await c.getAuthStatus();
    return {
      provider: 'copilot',
      isAuthenticated: s.isAuthenticated,
      authType: s.authType,
      login: s.login,
      host: s.host,
      statusMessage: s.statusMessage,
    };
  } catch (err) {
    return { provider: 'copilot', isAuthenticated: false, error: errorMessage(err) };
  }
}

export function summarizeModel(m: ModelInfo): ModelSummary {
  return {
    id: m.id,
    name: m.name,
    multiplier: m.billing?.multiplier,
    supportedReasoningEfforts: m.supportedReasoningEfforts as string[] | undefined,
    defaultReasoningEffort: m.defaultReasoningEffort as string | undefined,
  };
}

export async function copilotListModels(config: CopilotClientConfig = {}): Promise<ModelSummary[]> {
  const c = await getCopilotClient(config);
  const models = await c.listModels();
  return models.map(summarizeModel);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * M0 spike: prove the Copilot SDK works end to end on this machine with the owner's Copilot seat.
 * Run with: pnpm --filter @orca/engine spike [model]
 *
 * Records: auth status, model list, every session event type seen, permission requests, final message.
 */
import { CopilotClient, type PermissionHandler, type SessionEvent } from '@github/copilot-sdk';

const requestedModel = process.argv[2];

async function main() {
  const client = new CopilotClient({ useLoggedInUser: true, logLevel: 'warning', clientInfo: { applicationName: 'orca-spike', applicationVersion: '0.0.0' } });
  const t0 = Date.now();
  await client.start();
  console.log(`[spike] client started in ${Date.now() - t0} ms`);

  const auth = await client.getAuthStatus();
  console.log('[spike] auth:', JSON.stringify(auth));
  if (!auth.isAuthenticated) {
    console.error('[spike] not authenticated. Run: pnpm orca auth login');
    await client.stop();
    process.exit(2);
  }

  const models = await client.listModels();
  console.log(`[spike] ${models.length} models:`);
  for (const m of models) {
    console.log(`  - ${m.id}  (${m.name})  x${m.billing?.multiplier ?? '?'}  efforts=${(m.supportedReasoningEfforts ?? []).join('/') || '-'}`);
  }
  const model = requestedModel ?? models.find((m) => /claude/i.test(m.id))?.id ?? models[0]?.id;
  console.log(`[spike] using model: ${model}`);

  const seen = new Map<string, number>();
  const permissions: unknown[] = [];

  const onPermissionRequest: PermissionHandler = (request) => {
    permissions.push(request);
    console.log('[spike] permission request:', JSON.stringify(request).slice(0, 400));
    return { kind: 'approve-once' };
  };

  const session = await client.createSession({
    model,
    streaming: true,
    workingDirectory: process.cwd(),
    onPermissionRequest,
    hooks: {
      onPreToolUse: (input) => {
        console.log('[spike] onPreToolUse:', input.toolName, JSON.stringify(input.toolArgs).slice(0, 200));
        return undefined;
      },
      onAgentStop: (input) => {
        console.log('[spike] onAgentStop:', JSON.stringify(input).slice(0, 200));
        return undefined;
      },
    },
  });
  console.log('[spike] session id:', session.sessionId);

  session.on((event: SessionEvent) => {
    seen.set(event.type, (seen.get(event.type) ?? 0) + 1);
    if (event.type === 'assistant.message_delta') process.stdout.write((event.data as { deltaContent?: string }).deltaContent ?? '');
    if (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete') {
      console.log(`\n[spike] ${event.type}:`, JSON.stringify(event.data).slice(0, 300));
    }
    if (event.type === 'assistant.usage' || event.type === 'session.usage_info') {
      console.log(`\n[spike] ${event.type}:`, JSON.stringify(event.data).slice(0, 300));
    }
  });

  const prompt = 'List the files in the current directory using a shell command, then reply with exactly one line: "hello from orca" followed by the number of files you saw.';
  const t1 = Date.now();
  const final = await session.sendAndWait({ prompt }, 120_000);
  console.log(`\n[spike] final message (${Date.now() - t1} ms):`, JSON.stringify(final?.data ?? null).slice(0, 600));

  console.log('[spike] event type counts:', JSON.stringify(Object.fromEntries(seen)));
  console.log(`[spike] permission requests: ${permissions.length}`);

  await session.disconnect();
  const errors = await client.stop();
  if (errors.length) console.log('[spike] stop errors:', errors.map((e) => e.message));
}

main().catch((err) => {
  console.error('[spike] failed:', err);
  process.exit(1);
});

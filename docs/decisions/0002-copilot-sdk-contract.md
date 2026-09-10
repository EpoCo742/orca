# ADR 0002: GitHub Copilot SDK contract (as observed)

Date: 2026-09-10
Status: Accepted, partially verified (spike pending owner login)

Pinned: `@github/copilot-sdk` 1.0.13 (bundles Copilot runtime 1.0.83 via `@github/copilot-sdk-win32-x64`); `@github/copilot` CLI 1.0.83 installed in `@orca/cli` for the login flow.

## Verified from the installed type definitions (`dist/*.d.ts`)

Client
- `new CopilotClient(options)`; options include `connection`, `workingDirectory`, `baseDirectory` (COPILOT_HOME), `logLevel`, `env`, `gitHubToken`, `useLoggedInUser`, `clientInfo: { applicationName, applicationVersion }`, `sessionIdleTimeoutSeconds`.
- Methods: `start()`, `stop(): Promise<Error[]>`, `forceStop()`, `createSession(config)`, `resumeSession(sessionId, config)`, `getAuthStatus(): { isAuthenticated, authType?: 'user'|'env'|'gh-cli'|'hmac'|'api-key'|'token', host?, login?, statusMessage? }`, `listModels(): ModelInfo[]`, `listSessions()`, `getSessionMetadata()`, `deleteSession()`, `onLifecycle()`.
- `ModelInfo = { id, name, capabilities, policy?, billing?: { multiplier?, tokenPrices? }, supportedReasoningEfforts?, defaultReasoningEffort? }`.

Session config (`SessionConfigBase`), fields we will use
- `model`, `reasoningEffort`, `streaming`, `workingDirectory`, `additionalDirectories`, `systemMessage` (`{ mode: 'append', content }` | replace | customize), `tools: Tool[]`, `availableTools` / `excludedTools` (string[] or ToolSet), `mcpServers: Record<string, MCPServerConfig>` where stdio is `{ type?: 'local'|'stdio', command, args?, env?, workingDirectory? }` and remote is `{ type: 'http'|'sse', url, headers? }`, `customAgents: CustomAgentConfig[]` (`{ name, description?, prompt, tools?, mcpServers?, skills?, model?, reasoningEffort?, infer? }`), `agent` (default custom agent name), `skillDirectories`, `pluginDirectories`, `instructionDirectories`, `githubMcpToolConfig: { enableAllTools?, additionalToolsets?, additionalTools? }`, `infiniteSessions`, `enableFileChangeTracking`, `sessionLimits`, `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`, `hooks`, `gitHubToken`, `gitHubTokenProvider`, `provider` (BYOK: `{ type: 'openai'|'azure'|'anthropic', baseUrl, apiKey?, ... }`), `skipCustomInstructions`, `customAgentsLocalOnly`.
- `MessageOptions = { prompt, attachments?, mode?: 'enqueue'|'immediate', agentMode?: 'interactive'|'plan'|'autopilot'|'shell', displayPrompt? }`.

Session
- `readonly sessionId`, `send(prompt | options): Promise<messageId>`, `sendAndWait(prompt | options, timeoutMs?): Promise<AssistantMessageEvent | undefined>`, `on(type, handler)` / `on(handler)`, `getEvents()`, `abort()`, `disconnect()`, `setModel()`, `factory` (Copilot's scripted fan-out API, analogous to Claude dynamic workflows).

Hooks (`SessionHooks`)
- `onPreToolUse(input: { sessionId, timestamp, workingDirectory, toolName, toolArgs }) => { permissionDecision?: 'allow'|'deny'|'ask', permissionDecisionReason?, modifiedArgs?, additionalContext? }`.
- `onPreMcpToolCall`, `onPostToolUse({ toolName, toolArgs, toolResult: { textResultForLlm, resultType, error? } })`, `onPostToolUseFailure`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred => { errorHandling?: 'retry'|'skip'|'abort' }`, `onAgentStop({ stopReason? }) => { decision?: 'block', reason? }`.

Permissions
- `PermissionHandler = (request, { sessionId }) => PermissionRequestResult`; results `approve-once | approve-for-session | approve-for-location | approve-permanently | reject | user-not-available | no-result` (exact union is `PermissionDecisionRequest['result']` in `generated/rpc.d.ts`).
- Request kinds observed in types: `shell` (with `fullCommandText`, parsed `commands`, `canOfferSessionApproval`), `write`, `read`, `mcp`, `custom-tool`, `url`, `memory`, `hook`; `permission.requested` events carry `requestId`, `permissionRequest`, `riskAssessment`, `resolvedByHook`.

Tools
- `defineTool(name, { description, parameters (zod or JSON schema), handler(args, invocation) })`; `Tool` also supports `skipPermission`, `isTerminal`, `overridesBuiltInTool`. `invocation` has `sessionId`, `toolCallId`, `signal`.

Events (subset relevant to Orca): `assistant.turn_start/turn_end`, `assistant.message_start/message_delta/message`, `assistant.reasoning(_delta)`, `assistant.usage`, `assistant.tool_call_delta`, `tool.execution_start/progress/partial_result/complete`, `permission.requested/completed`, `subagent.started/completed/failed`, `session.start/idle/error/warning/info/usage_info/usage_checkpoint/compaction_start/compaction_complete/model_change/session_limits_changed/workspace_file_changed/snapshot_rewind/task_complete`, `mcp.oauth_required/oauth_completed`, `mcp.tools.list_changed`, `model.call_failure/call_finished`, `hook.start/progress/end`, `skill.invoked`, `factory.run_*`.

Login
- The bundled runtime (`prebuilds/win32-x64/copilot-runtime.exe`) has no `login` subcommand. Login is done with the official CLI: `copilot login` (browser loopback flow by default, `--device-code` for headless). Credentials are stored in the system credential store and reused by the SDK (`useLoggedInUser: true`). `orca auth login` wraps this.

## Implications for the adapter (spec section 7B)

- Budget enforcement via `sessionLimits` (verify shape in the spike) plus engine-side turn and tool-call counters; `session.abort()` exists for hard stops.
- `enableFileChangeTracking` and `session.workspace_file_changed` events can feed `files_changed` without diffing, in addition to worktree diffs.
- `agentMode: 'plan'` gives a native planning mode for planner nodes.
- `onPreToolUse` returning `permissionDecision: 'deny'` is the hard-deny hook; `ask` routes to `onPermissionRequest`.
- The Copilot `factory` API is a potential future "scale-out" node (Copilot-native fan-out), to be evaluated after M3.

## Observed in the spike (2026-09-10, account EpoCo742, Windows 11)

- `getAuthStatus()` after `copilot login`: `{ isAuthenticated: true, authType: 'user', host: 'https://github.com', login: 'EpoCo742', statusMessage: 'EpoCo742' }`. Before login: `{ isAuthenticated: false, statusMessage: 'Not authenticated' }`. Client start takes ~30 ms; the runtime is spawned once per process.
- Login: the SDK runtime has no login; `copilot login` (official CLI) runs a browser loopback OAuth flow. GitHub's authorize page requires **sudo mode** (2FA: authenticator code, passkey, GitHub Mobile push, or emailed code) and the CLI's loopback listener times out after roughly 5 minutes. Orca's `orca auth login` must therefore be an attended step; document it and detect the timeout.
- `listModels()` returned 15 models under this account's policy: `auto`, `claude-sonnet-5` (efforts low/medium/high/xhigh/max), `claude-haiku-4.5`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5-mini`, `mai-code-1.1-flash`, `mai-code-1-flash-picker`, `grok-4.5`, `grok-4.6`, `kimi-k3`, `kimi-k2.7-code`. **No Claude Opus under this policy.** `billing.multiplier` was undefined for every model, so the multiplier cannot be read from `listModels()` here.
- **Premium-request accounting**: each model call emits `assistant.usage` with `{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, cost, duration, timeToFirstTokenMs, cacheExpiresAt, ... }`. `cost` was `1` per model call on `claude-sonnet-5`; treat it as premium-request units and sum it per node and run. The spike's single prompt made 2 model calls (tool call + final answer), so cost 2.
- `session.usage_info`: `{ tokenLimit: 200000, currentTokens, messagesLength, systemTokens, conversationTokens, toolDefinitionsTokens, isInitial }`, emitted per turn; use for a context meter in the UI.
- Shell tool on Windows is named **`powershell`** (not `bash`/`shell`). `tool.execution_start` data: `{ toolCallId, toolName, arguments: { command, description }, turnId, model, shellToolInfo }`. `tool.execution_complete` data: `{ toolCallId, success, result: { content, detailedContent, ... }, turnId, model, interactionId }`; the shell result content ends with `<shellId: N completed with exit code C>`.
- `onPreToolUse` input: `{ toolName: 'powershell', toolArgs: { command, description }, sessionId, timestamp, workingDirectory }`. Hooks fire as `hook.start`/`hook.end` events (7 each in a 2-turn session).
- Permission request for shell: `{ kind: 'shell', toolCallId, fullCommandText, intention, commands: [{ identifier, readOnly }], commandSegments: [...], canOfferSessionApproval }`. Returning `{ kind: 'approve-once' }` ran the command; `permission.requested` and `permission.completed` events bracket it, plus a `sandbox.decision` event.
- `onAgentStop` input: `{ sessionId, stopReason: 'end_turn', transcriptPath: '~/.copilot/session-state/<sessionId>/events.jsonl', timestamp }`. Session transcripts live under `~/.copilot/session-state/`.
- `sendAndWait(options, timeoutMs)` resolved in ~4.6 s with `AssistantMessageEvent.data = { messageId, model, content, toolRequests: [], interactionId, turnId, apiCallId }`.
- Event types actually seen in one small session (43 distinct), including undocumented `model.*` internals: `session.start`, `session.title_changed`, `session.skills_loaded`, `session.mcp_servers_loaded`, `session.tools_updated`, `user.message`, `assistant.turn_start/turn_end`, `assistant.streaming_delta`, `assistant.reasoning_delta`, `assistant.reasoning`, `assistant.tool_call_delta`, `assistant.message_start/message_delta/message`, `assistant.usage`, `tool.execution_start/partial_result/complete`, `permission.requested/completed`, `session.usage_info`, `session.usage_checkpoint`, `session.background_tasks_changed`, `assistant.idle`, `session.idle`. The adapter should persist all events but drive state only from the documented ones.

Still to verify (M1): `sessionLimits` shape and behavior at the limit; whether policy-denied models fail at `createSession` or at first `send`; `enableFileChangeTracking` event payloads.

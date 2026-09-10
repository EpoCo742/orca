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

## Still to verify in the spike (needs a signed-in account)

- Exact payload fields of `tool.execution_start/complete` and `assistant.usage`; whether premium-request counts are exposed.
- `sessionLimits` shape and behavior at the limit.
- Whether `getAuthStatus()` reflects org policy errors distinctly from "not signed in".

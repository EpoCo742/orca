# ADR 0001: Naming and stack

Date: 2026-09-10
Status: Accepted

## Decision

- Product name **Orca**. CLI `orca`, npm scope `@orca/*`, per-repo config directory `.orca/`, environment prefix `ORCA_`.
- TypeScript monorepo managed by pnpm 10 workspaces; Node >= 22.12 (developed on Node 24). ESM only, `verbatimModuleSyntax`, strict TypeScript.
- Packages: `@orca/shared` (zod schemas and types), `@orca/engine` (Hono HTTP API, scheduler, adapters), `@orca/ui` (React + Vite; React Flow from M1), `@orca/cli` (commander). `packages/desktop` (Electron) arrives in M5.
- Primary agent runtime: GitHub Copilot SDK (`@github/copilot-sdk`), see ADR 0002. Claude Agent SDK adapter is optional (M4).
- Browser UI plus local engine for v1; the CLI `orca dev` starts both and opens the browser with the engine URL and a random bearer token in the URL hash.
- zod 4 (installed as latest); schemas in the technical spec were written against zod 3 syntax and are adapted as implemented.

## Consequences

- One language end to end; the engine runs identically under the CLI, the dev server, and later Electron or a container.
- The bearer token is required on every API call even on localhost, so a stray local process cannot drive the engine.
- `pnpm-workspace.yaml` allow-lists build scripts for `esbuild` and `koffi` (the Copilot SDK's FFI runtime) because pnpm 10 blocks postinstall scripts by default.

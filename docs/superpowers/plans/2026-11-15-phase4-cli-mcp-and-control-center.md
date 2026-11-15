# MyBrain Phase 4: CLI, MCP Server, Local Daemon & Web Control Center (`apps/cli-mcp` + `apps/control-center`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every step declares the exact skill(s) governing its execution.

**Goal:** Expose MyBrain through a single-owner local daemon broker, unified `mybrain` CLI, GBrain-compatible stdio MCP server, and local Web Control Center UI showing live Factory Kitchen swim-lanes, Knowledge Graph + REA Evidence Ledger explorer, and the Iteration Spiral Requirements Backlog.

**Architecture:** One local HTTP/WebSocket daemon (`DaemonServer`) owns embedded PGLite (`VaultStore` + `FactoryRunner`) exclusively to eliminate multi-process file-lock contention on Windows. `mybrain` CLI subcommands and `mybrain mcp serve` connect automatically to an active daemon via `.mybrain/daemon.json` (or run embedded directly when idle). A clean Web UI consumes REST + WebSocket events.

**Tech Stack:** Bun `>=1.4.4` (`Bun.serve` HTTP + WebSocket), TypeScript, `@modelcontextprotocol/sdk`, `zod`, `@mybrain/{shared,knowledge,intelligence,factory}`, `bun:test`, browser verification subagent.

**Spec:** [docs/superpowers/specs/2026-11-15-mybrain-design.md](../specs/2026-11-15-mybrain-design.md) *(Phase 4 of 4; depends on Phases 1–3).*

---

## Global Constraints

1. **Single-Owner PGLite Daemon Routing:** Concurrent `ui`, `mcp serve`, and CLI invocations must never open `<vault>/.mybrain/pgdata` simultaneously; active daemon owns DB, clients forward RPC over localhost HTTP using a per-launch bearer token stored in `.mybrain/daemon.json`.
2. **Clean MCP Stdio Stream:** `mybrain mcp serve` must reserve `process.stdout` strictly for JSON-RPC frames; all logs go to `process.stderr` or trace files.
3. **XSS-Safe UI Rendering:** Ingested Markdown/frontmatter displayed in `apps/control-center` must be safely escaped/sanitized; no raw unescaped HTML injection.
4. **Windows Path & Process Safety:** Daemon start/stop and CLI repo/vault path arguments must normalize Windows paths cleanly.
5. **Visual UI Verification:** Control Center Web UI must be verified live against the running local server before claiming completion.

---

## Skill-to-Step Binding Matrix (Phase 4)

| Step Type | Required Skill | Concrete Rule Enforced |
|---|---|---|
| GBrain MCP tool parity (Task 2) | `reverse-engineer-anything` (REA) | Match `OBS-04` MCP verb semantics cleanly (`recall`, `search`, `remember`, `relate`, `ledger_add`, `ledger_list`, `factory_status`, `backlog_list`) with strict Zod input/output contracts. |
| Backend/CLI TDD implementation (Tasks 1–4) | `superpowers:test-driven-development` | Strict RED -> GREEN -> REFACTOR per task. |
| Failure & lock/port debugging | `superpowers:systematic-debugging` | Diagnose Windows port binding, daemon cleanup, or stdio MCP framing faults from exact logs. |
| Live Control Center UI inspection (Task 5) | `browser` subagent verification (`browse` workflow) | Boot `mybrain ui` and inspect live rendered swim-lanes, graph explorer, and backlog spiral in real browser before shipping. |
| Task verification, review & branch completion | `superpowers:verification-before-completion` + `superpowers:requesting-code-review` + `superpowers:finishing-a-development-branch` | Run full monorepo `bun test` + `bun run typecheck` + E2E smoke test with zero skipped checks before merging. |

---

## Review Focus

1. **Concurrent CLI call while `mybrain ui` holds PGLite:** Running `mybrain search` while `DaemonServer` is active must transparently route through `.mybrain/daemon.json` instead of throwing `VaultLockError` — pinned in Task 1 & Task 3.
2. **MCP stdout corruption:** Writing logs to stdout during `mybrain mcp serve` breaks MCP clients; integration test spawning `mcp serve` must parse strict line-delimited JSON-RPC from stdout without stray log bytes — pinned in Task 2.
3. **Unauthorized local HTTP calls:** `DaemonServer` control endpoints (`POST /api/runs/:id/approve`) must reject requests missing the local `.mybrain/daemon.json` token (for CLI/MCP) or local origin checks — pinned in Task 1 & Task 4.
4. **Idempotent `mybrain init`:** Running `mybrain init` on an existing populated vault must not overwrite existing `vault/` pages or user `mybrain.config.json` — pinned in Task 3.
5. **XSS in Control Center Knowledge Viewer:** Page bodies containing `<script>alert(1)</script>` must render as inert text in the Control Center UI — pinned in Task 5.

---

## File Structure

- `apps/cli-mcp/{package.json,tsconfig.json}`
- `apps/cli-mcp/src/daemon/{server,client}.ts` — `DaemonServer` (HTTP + WS + token auth + `.mybrain/daemon.json` discovery) & `BrainClient` (auto-routes to daemon or direct local `VaultStore`).
- `apps/cli-mcp/src/mcp/server.ts` — `createMyBrainMcpServer(client)` exposing 8 Zod-validated MCP tools over stdio.
- `apps/cli-mcp/src/cli.ts` — `runCli(argv)` supporting `init`, `ingest`, `search`, `query`, `entity`, `ledger`, `run`, `backlog`, `dream`, `mcp serve`, `ui`.
- `apps/control-center/{package.json,tsconfig.json}`
- `apps/control-center/src/api.ts` — REST + WebSocket route handlers mounted onto `DaemonServer` for live UI data and approve/reject/promote actions.
- `apps/control-center/web/{index.html,app.ts,styles.css}` — Lightweight browser UI (Station Swim-lanes, Knowledge Graph & REA Ledger Explorer, Requirements Backlog Spiral).

---

### Task 1: Single-Owner `DaemonServer` & Auto-Routing `BrainClient`

**Files:**
- Create: `apps/cli-mcp/{package.json,tsconfig.json}`
- Create: `apps/cli-mcp/src/daemon/{server,client}.ts`
- Test: `apps/cli-mcp/tests/daemon.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `HybridSearchEngine`, `GraphService`, `LedgerAndBacklogService`, `FactoryRunner`
- Produces: `DaemonServer.start({ vaultRoot, port? })`, `connectBrainClient(vaultRoot): Promise<BrainClient>` (auto-uses `.mybrain/daemon.json` HTTP RPC when live, else opens `VaultStore` directly).

- [ ] **Step 1: Initialize `apps/cli-mcp` and write failing concurrent-daemon tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Test: starting `DaemonServer` binds `127.0.0.1:0`, writes `.mybrain/daemon.json` with `{ port, pid, token }`; calling `connectBrainClient` from a second client instance performs `rememberPage` & `search` cleanly over HTTP without `VaultLockError` (Review Focus #1), and rejects missing/wrong bearer tokens with HTTP `401` (Review Focus #3).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test apps/cli-mcp/tests/daemon.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `daemon/server.ts` and `daemon/client.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement `Bun.serve` daemon with bearer-token middleware, stale `daemon.json` cleanup when PID is dead, and transparent `BrainClient` adapter.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test apps/cli-mcp/tests/daemon.test.ts && bun run typecheck` -> PASS. Commit `apps/cli-mcp`.

---

### Task 2: Stdio MCP Server (`apps/cli-mcp/src/mcp/server.ts`)

**Files:**
- Create: `apps/cli-mcp/src/mcp/server.ts`
- Test: `apps/cli-mcp/tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk`, `BrainClient`
- Produces: `createMyBrainMcpServer(client)` registering `mybrain_recall`, `mybrain_search`, `mybrain_remember`, `mybrain_relate`, `mybrain_ledger_add`, `mybrain_ledger_list`, `mybrain_factory_status`, `mybrain_backlog_list`.

- [ ] **Step 1: Verify GBrain MCP verb contracts (`OBS-04`) via REA ledger & write failing MCP integration test (RED)**
  **Skill:** `reverse-engineer-anything` (`OBS-04` tool surface parity) + `superpowers:test-driven-development`
  Install `@modelcontextprotocol/sdk` in `apps/cli-mcp` and write test sending JSON-RPC `initialize`, `tools/list`, `tools/call` (`mybrain_remember` + `mybrain_search` + `mybrain_ledger_add`) verifying valid JSON-RPC frames and zero stray stdout text (Review Focus #2).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test apps/cli-mcp/tests/mcp-server.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `apps/cli-mcp/src/mcp/server.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Register all 8 tools with Zod schemas, redirect any internal logger to `console.error`, and bind stdio transport cleanly.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test apps/cli-mcp/tests/mcp-server.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 3: Unified `mybrain` CLI (`apps/cli-mcp/src/cli.ts`)

**Files:**
- Create: `apps/cli-mcp/src/cli.ts`
- Modify: `apps/cli-mcp/package.json` (add `"bin": { "mybrain": "./src/cli.ts" }`)
- Test: `apps/cli-mcp/tests/cli.test.ts`

**Interfaces:**
- Consumes: `DaemonServer`, `connectBrainClient`, `createMyBrainMcpServer`
- Produces: `runCli(argv: string[]): Promise<number>` covering `init`, `ingest`, `search`, `query`, `entity`, `ledger`, `run start|status|approve|resume`, `backlog list|promote`, `dream`, `mcp serve`, `ui`.

- [ ] **Step 1: Write failing CLI integration tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Test: `mybrain init --vault <dir>` creates scaffold + `skills/RESOLVER.md` link and stays idempotent on second run without overwriting existing pages (Review Focus #4); `ingest`, `search`, `ledger add`, `backlog list`, and `run status` emit deterministic exit codes and structured output (`--json`).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test apps/cli-mcp/tests/cli.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `apps/cli-mcp/src/cli.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Parse flags cleanly without brittle shell assumptions on Windows paths, delegate all stateful operations through `connectBrainClient`.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test apps/cli-mcp/tests/cli.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 4: Control Center REST + WebSocket API (`apps/control-center/src/api.ts`)

**Files:**
- Create: `apps/control-center/{package.json,tsconfig.json}`
- Create: `apps/control-center/src/api.ts`
- Test: `apps/control-center/tests/api.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `GraphService`, `LedgerAndBacklogService`, `TraceStore`, `FactoryRunner`
- Produces: `createControlCenterRoutes(deps)` exposing `/api/graph`, `/api/ledger`, `/api/backlog`, `/api/runs`, `/api/runs/:id/approve`, `/api/backlog/:id/promote`, and `/ws` live event stream.

- [ ] **Step 1: Write failing Control Center API & WebSocket tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Test JSON responses for graph nodes/edges, REA evidence filtering (`OBS`/`INF`/`UNK`), Light Factory run approval endpoints, backlog promotion, and live WebSocket broadcast on `TraceStore` updates.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test apps/control-center/tests/api.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `apps/control-center/src/api.ts` and mount into `mybrain ui` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement clean JSON/WebSocket endpoints with Zod request body validation and local-origin safety checks.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test apps/control-center/tests/api.test.ts && bun run typecheck` -> PASS. Commit `apps/control-center`.

---

### Task 5: Control Center Web UI & Live Browser Verification

**Files:**
- Create: `apps/control-center/web/{index.html,styles.css,app.ts}`
- Modify: `apps/cli-mcp/src/cli.ts` (`mybrain ui` serves bundled UI + opens port)
- Test: `apps/control-center/tests/ui-xss.test.ts`

**Interfaces:**
- Consumes: `apps/control-center/src/api.ts` endpoints & WebSocket
- Produces: Single-page local cockpit displaying (1) Factory Kitchen Station Swim-lanes & Gate logs w/ Light Factory Approve/Reject controls, (2) Knowledge Graph & REA Evidence Ledger (`OBS`/`INF`/`UNK`) inspector, (3) Iteration Spiral & Requirements Backlog promoter.

- [ ] **Step 1: Write failing XSS-safety & HTML bundle smoke test (RED)**
  **Skill:** `superpowers:test-driven-development`
  Assert Markdown/evidence render helpers escape `<script>alert(1)</script>` cleanly (`textContent` / HTML escaping) rather than injecting raw HTML (Review Focus #5).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test apps/control-center/tests/ui-xss.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Build Web UI assets & wire into `mybrain ui` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Bundle `web/app.ts` via `Bun.build`, build clean 3-tab Control Center UI with strict DOM `textContent` escaping and WebSocket auto-reconnect.

- [ ] **Step 4: Live browser inspection, full monorepo proof, review & finish branch**
  **Skill:** `browser` subagent verification + `superpowers:verification-before-completion` + `superpowers:requesting-code-review` + `superpowers:finishing-a-development-branch`
  1. Launch `mybrain ui --vault <temp-seeded-vault>` and dispatch the `browser` subagent to open `http://127.0.0.1:<port>`, verify all 3 views render seeded Knowledge Graph pages, REA ledger entries, Requirements Backlog items, and Station Swim-lane states with zero console errors.
  2. Run full workspace test suite + typecheck: `bun test && bun run typecheck` -> verify all tests pass, exit 0.
  3. Complete review and branch wrap-up.

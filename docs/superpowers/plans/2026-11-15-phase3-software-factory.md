# MyBrain Phase 3: Deterministic Software Factory (`@mybrain/factory`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every step declares the exact skill(s) governing its execution.

**Goal:** Build `@mybrain/factory`, MyBrain's deterministic Agentic Software Development state machine implementing SSSF principles (*"Agent proposes, code disposes"*), per-task git worktree isolation merged into run integration branches, `WriteGuard` boundary rollback, `kind: "code"` verification gates, SQL/JSONL trace logging, and the closed-loop Reviewer/QA Requirement Spiral.

**Architecture:** `FactoryRunner` owns every state transition (`SCOUT -> PLAN -> [HUMAN_APPROVE_PLAN] -> BUILD -> MERGE_TASKS -> VERIFY_CODE -> REVIEW_QA -> [HUMAN_APPROVE_SHIP] -> DREAM -> DONE`) and calls an abstract `StationExecutor` adapter (allowing pluggable LLM/agent backends + deterministic mock executors in tests). Code owns branches, path enforcement, and command exit codes.

**Tech Stack:** Bun `>=1.4.4`, TypeScript (`strict`, `noUncheckedIndexedAccess`), Git CLI (`git worktree`), `zod`, `@mybrain/shared`, `@mybrain/knowledge`, `@mybrain/intelligence`, `bun:test`.

**Spec:** [docs/superpowers/specs/2026-11-15-mybrain-design.md](../specs/2026-11-15-mybrain-design.md) *(Phase 3 of 4; depends on Phases 1 & 2).*

---

## Global Constraints

1. **Deterministic Orchestration (`sssf` Rule):** Agents propose structured JSON envelopes (`ScoutEnvelope`, `PlanEnvelope`, `BuildEnvelope`, `ReviewEnvelope`); deterministic TypeScript code validates schemas, owns retries (`maxFixCycles`), and decides state advancement.
2. **A Known Command Is Code, Not an Agent:** Tests, typechecks, linters, and builds execute via `GateRunner` (`kind: "code"`) — never delegated to an LLM.
3. **Write-Boundary & Protected-File Enforcement:** Every station runs inside a `WriteGuard` snapshot checking modified/untracked files against `writes:` allowlists and `protectedFiles` (`skills/**`, `RESOLVER.md`, `.mybrain/gates.json`), automatically reverting unauthorized writes.
4. **Worktree Isolation:** Target code mutations occur inside `<repo>/.mybrain-worktrees/<run-id>/task-<n>` branches and merge into `factory/<run-id>` before `VERIFY_CODE`.
5. **Light Factory Checkpoints:** State machine pauses deterministically at `AWAITING_PLAN_APPROVAL` and `AWAITING_SHIP_APPROVAL` until explicit human decision (`approve` / `reject`).

---

## Skill-to-Step Binding Matrix (Phase 3)

| Step Type | Required Skill | Concrete Rule Enforced |
|---|---|---|
| Factory state machine, `writes:` guard & envelopes (Tasks 1, 3, 4, 5) | `sssf` | Enforce `"Agent proposes, code disposes"`, `kind: "code"` deterministic verification, path-level `writes:` + `protected_files` rollback, and SQL + trace telemetry. |
| Git worktree isolation & merge management (Task 2) | `superpowers:using-git-worktrees` | Isolate build tasks per worktree, clean teardown, conflict detection before integration. |
| Test-first implementation (Tasks 1–5) | `superpowers:test-driven-development` | Strict RED -> GREEN -> REFACTOR per task. |
| Failure root-cause diagnosis | `superpowers:systematic-debugging` | Diagnose git/process/rollback edge cases from fresh stderr before changing code. |
| Gate proof & phase review | `superpowers:verification-before-completion` + `superpowers:requesting-code-review` | Run full test & typecheck suite cleanly before committing. |

---

## Review Focus

1. **Unauthorized untracked file + protected-file mutation on Windows:** When a station creates an untracked file outside `writes:` or edits `skills/RESOLVER.md`, `WriteGuard` must both delete the untracked file and restore the tracked file, then fail the station with `WriteBoundaryError` — pinned in Task 3.
2. **Per-task worktree merge conflict:** If `task-1` and `task-2` modify the same line in parallel task worktrees, `mergeTaskBranchesIntoIntegration` must abort cleanly, preserve worktrees for inspection, and fail into `FAILED`/`CHANGES_REQUESTED` instead of leaving `<<<<<<<` conflict markers — pinned in Task 2.
3. **Non-zero `kind: "code"` command disguised by agent success:** Even if a mocked `REVIEW_QA` executor returns `verdict: "approved"`, if `GateRunner` reports exit code `!== 0`, `FactoryRunner` must reject ship approval — pinned in Task 4 & Task 5.
4. **Infinite fix-cycle loop guard:** Repeated `REVIEW_QA -> BUILD` rejections must terminate cleanly once `fixCycle >= maxFixCycles`, converting remaining issues into `open` rows in `requirements_backlog` for Iteration N+1 — pinned in Task 5.
5. **Resumability across Light Factory pauses:** Stopping the process at `AWAITING_PLAN_APPROVAL`, reopening `FactoryRunner` from DB/trace store, and calling `approvePlan()` must resume cleanly into `BUILD` without losing `PlanEnvelope` or `ScoutEnvelope` — pinned in Task 5.

---

## File Structure

- `packages/factory/{package.json,tsconfig.json}` — Workspace setup depending on `shared`, `knowledge`, `intelligence`.
- `packages/factory/src/trace/store.ts` — SQL DDL + `TraceStore` (`factory_runs`, `station_executions`, `gate_results`) & JSONL event emitter.
- `packages/factory/src/worktree/manager.ts` — `WorktreeManager` (`createIntegrationWorktree`, `createTaskWorktree`, `mergeTaskBranchesIntoIntegration`, `finalizeShip`, `cleanupRunWorktrees`).
- `packages/factory/src/guard/write-guard.ts` — `WriteGuard` pre/post tree snapshot, glob matcher, `protectedFiles` blocklist, automated rollback.
- `packages/factory/src/gate/runner.ts` — `GateRunner` (`kind: "code"` shell verifier capturing exit code, duration, stdout/stderr hash).
- `packages/factory/src/runner/factory-runner.ts` — `StationExecutor` interface, `FactoryRunner` state machine, checkpoint pause/resume, Reviewer -> Backlog N+1 spiral wiring.
- `packages/factory/src/index.ts` — Package exports.

---

### Task 1: Factory Trace Schema & Telemetry Store

**Files:**
- Create: `packages/factory/{package.json,tsconfig.json}`
- Create: `packages/factory/src/trace/store.ts`
- Test: `packages/factory/tests/trace-store.test.ts`

**Interfaces:**
- Consumes: `DbClient` from `@mybrain/knowledge`
- Produces: `applyFactorySchema(db)`, `TraceStore` (`createRun`, `updateRunState`, `recordStationExecution`, `recordGateResult`, `getRun(runId)`, `listRuns(projectId?)`, `subscribe(listener)`).

- [ ] **Step 1: Initialize `@mybrain/factory` & write failing `TraceStore` tests (RED)**
  **Skill:** `sssf` (observability trace design) + `superpowers:test-driven-development`
  Test creating a run (`SCOUT`), appending station execution & gate result rows, persisting JSON envelopes, and emitting live subscriber events for UI/CLI streaming.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/factory/tests/trace-store.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/factory/src/trace/store.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement idempotent DDL (`factory_runs`, `station_executions`, `gate_results`) and `TraceStore` methods with optional `.mybrain/traces/<run-id>.jsonl` append log.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/factory/tests/trace-store.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 2: Git `WorktreeManager` (Per-Task Worktrees & Integration Branch)

**Files:**
- Create: `packages/factory/src/worktree/manager.ts`
- Test: `packages/factory/tests/worktree-manager.test.ts`

**Interfaces:**
- Produces: `WorktreeManager` (`createIntegrationWorktree(repoRoot, runId, baseBranch)`, `createTaskWorktree(repoRoot, runId, taskId, integrationBranch)`, `mergeTaskBranchesIntoIntegration(...)`, `finalizeShip(repoRoot, runId, strategy: "merge_to_base" | "keep_branch_for_pr")`, `cleanupRunWorktrees(...)`), `MergeConflictError`.

- [ ] **Step 1: Write failing git worktree & merge-conflict tests (RED)**
  **Skill:** `superpowers:using-git-worktrees` + `superpowers:test-driven-development`
  In a temp `git init` repo: (a) create integration worktree + 2 task worktrees (`task-1`, `task-2`), commit distinct files in each, merge both cleanly into `factory/<run-id>`, (b) commit conflicting edits to the same line in `task-1` & `task-2` and assert `mergeTaskBranchesIntoIntegration` aborts cleanly (`git merge --abort`) and throws `MergeConflictError` (Review Focus #2), (c) verify `finalizeShip(..., "merge_to_base")` lands changes on `main` and removes worktrees.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/factory/tests/worktree-manager.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/factory/src/worktree/manager.ts` (GREEN)**
  **Skill:** `superpowers:using-git-worktrees` + `superpowers:test-driven-development` (plus `superpowers:systematic-debugging` if Windows path/lock handles block worktree removal)
  Execute git CLI subprocesses via `Bun.spawn` with explicit `cwd` and non-zero exit checks.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/factory/tests/worktree-manager.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 3: `WriteGuard` Snapshot, Allowlist & Protected-File Rollback

**Files:**
- Create: `packages/factory/src/guard/write-guard.ts`
- Test: `packages/factory/tests/write-guard.test.ts`

**Interfaces:**
- Produces: `WriteBoundaryError`, `WriteGuardOptions { workdir: string; allowWrites: string[]; protectedFiles: string[] }`, `WriteGuard` (`captureBaseline()`, `verifyAndEnforce(): Promise<WriteAuditResult>`).

- [ ] **Step 1: Write failing `WriteGuard` rollback tests (RED)**
  **Skill:** `sssf` (`writes:` + `protected_files` invariant) + `superpowers:test-driven-development`
  In a temp git repo: (a) permit modifying `src/allowed.ts` when `allowWrites: ["src/**"]`, (b) revert modified tracked `skills/RESOLVER.md` (`protectedFiles: ["skills/**", "RESOLVER.md"]`) AND delete unauthorized untracked `rogue/file.ts`, throwing `WriteBoundaryError` with exact violation list (Review Focus #1).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/factory/tests/write-guard.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/factory/src/guard/write-guard.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Diff `git status --porcelain` before/after station execution, evaluate POSIX-normalized globs (`Bun.Glob`), restore violated tracked files via `git checkout --`, delete unauthorized untracked files, and throw `WriteBoundaryError`.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/factory/tests/write-guard.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 4: Deterministic `GateRunner` (`kind: "code"` Verifier)

**Files:**
- Create: `packages/factory/src/gate/runner.ts`
- Test: `packages/factory/tests/gate-runner.test.ts`

**Interfaces:**
- Produces: `GateCommandSpec { name: string; command: string[]; cwd: string; timeoutMs?: number }`, `GateExecutionResult { name: string; passed: boolean; exitCode: number; durationMs: number; outputDigest: string; stdoutTail: string; stderrTail: string }`, `GateRunner` (`runAll(specs)`).

- [ ] **Step 1: Write failing `GateRunner` tests (RED)**
  **Skill:** `sssf` ("A known command is code, not an agent") + `superpowers:verification-before-completion` + `superpowers:test-driven-development`
  Assert passing command returns `{ passed: true, exitCode: 0 }`, failing command returns `{ passed: false, exitCode: 1 }` with captured `stderrTail`, and timed-out command kills subprocess cleanly with timeout error result.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/factory/tests/gate-runner.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/factory/src/gate/runner.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Spawn commands directly without shell interpolation (`Bun.spawn`), enforce timeouts, compute SHA-256 digest of full output, and retain bounded stdout/stderr tails.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/factory/tests/gate-runner.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 5: `FactoryRunner` State Machine & Closed-Loop Requirement Spiral

**Files:**
- Create: `packages/factory/src/runner/factory-runner.ts`
- Create: `packages/factory/src/index.ts`
- Test: `packages/factory/tests/factory-runner.test.ts`

**Interfaces:**
- Consumes: `ResolverEngine`, `validateStationTransition`, `persistStationOutputs`, `DreamAndGardeningPlanner` (`@mybrain/intelligence`), `VaultStore`, `LedgerAndBacklogService` (`@mybrain/knowledge`), `TraceStore`, `WorktreeManager`, `WriteGuard`, `GateRunner`
- Produces: `StationExecutor` interface, `FactoryRunConfig`, `FactoryRunner` (`startRun(goal, opts)`, `approvePlan(runId)`, `approveShip(runId, strategy)`, `rejectRun(runId, reason)`, `promoteBacklogRequirement(reqId)`).

- [ ] **Step 1: Write failing end-to-end Factory state machine & Requirement Spiral tests (RED)**
  **Skill:** `sssf` + `superpowers:test-driven-development`
  Using a deterministic mock `StationExecutor` on a temp git repo + temp vault:
  1. Happy path pauses cleanly at `AWAITING_PLAN_APPROVAL`; recreating `FactoryRunner` from DB and calling `approvePlan(runId)` runs `BUILD` -> `MERGE_TASKS` -> `VERIFY_CODE` -> `REVIEW_QA`, pauses at `AWAITING_SHIP_APPROVAL`, and `approveShip(runId, "merge_to_base")` triggers `DREAM` and reaches `DONE` (Review Focus #5).
  2. Verification failure overrides mock `REVIEW_QA` approval (`GateRunner` exit `!== 0`) and rejects transition (Review Focus #3).
  3. Bounded `fixCycle` (`maxFixCycles: 1`) terminates loop cleanly and persists Reviewer/QA `generatedRequirements[]` into `requirements_backlog` + `vault/backlog/*.md` so `promoteBacklogRequirement(reqId)` launches Iteration N+1 (Review Focus #4).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/factory/tests/factory-runner.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `factory-runner.ts` and `index.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development` + `sssf`
  Wire `ResolverEngine.dispatch` -> `StationExecutor.execute` wrapped in `WriteGuard` -> `validateStationTransition` -> `TraceStore` -> `GateRunner` -> `DreamAndGardeningPlanner` cleanly.

- [ ] **Step 4: Run full Phase 3 verification, review & commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test && bun run typecheck` -> PASS. Commit `packages/factory`.

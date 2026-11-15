# MyBrain Phase 2: Intelligence, Skill Registry & Station Contracts (`@mybrain/intelligence`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every step declares the exact skill(s) governing its execution.

**Goal:** Build `@mybrain/intelligence` and MyBrain's clean-room `skills/` library (`RESOLVER.md` dispatcher, multi-mount `SkillRegistry`, typed Station Envelopes with Scout Understanding & Reviewer/QA Requirement-Generation gates, plus the post-Ship `DreamAndGardeningPlanner`).

**Architecture:** Follows *"Thin Harness, Fat Skills"* (`garrytan/gbrain` parity) combined with Lauren Tan's Michelin Kitchen specialization and Trust Engineering. Code owns Zod envelope validation, trigger matching (`RESOLVER.md`), blocking-unknown checks, and safe staging of skill upgrades (`vault/proposals/`), while `SKILL.md` documents govern agent behavior.

**Tech Stack:** Bun `>=1.4.4`, TypeScript (`strict`, `noUncheckedIndexedAccess`), `zod`, `yaml`, `@mybrain/shared`, `@mybrain/knowledge`, `bun:test`.

**Spec:** [docs/superpowers/specs/2026-11-15-mybrain-design.md](../specs/2026-11-15-mybrain-design.md) *(Phase 2 of 4; depends on Phase 1).*

---

## Global Constraints

1. **Thin Harness, Fat Skills:** Trigger parsing and envelope validation live in deterministic TypeScript; domain instructions live in Markdown `SKILL.md` + `skills/RESOLVER.md`.
2. **Skill Sourcing & Read-Only Safety:** `SkillRegistry` searches bundled `skills/` first, then optional configured host mounts (Superpowers, REA); external mounted skills are read-only.
3. **Scout Understanding Gate:** Scout transitions must fail validation if any `openUnknown` has `blocking: true` and `status === "open"`.
4. **Reviewer Requirement-Generation Contract:** `ReviewEnvelope` must require non-empty `verificationResults[]` for `approved` verdicts and persist every `generatedRequirements[]` item cleanly to `@mybrain/knowledge` backlog.
5. **Light Factory Skill Staging:** `DreamAndGardeningPlanner` never mutates live `skills/` or `RESOLVER.md`; it writes staged proposals under `vault/proposals/` for explicit human approval.

---

## Skill-to-Step Binding Matrix (Phase 2)

| Step Type | Required Skill | Concrete Rule Enforced |
|---|---|---|
| GBrain `RESOLVER.md` & `dream` parity checks (Tasks 2, 4, 5) | `reverse-engineer-anything` (REA) | Ground `RESOLVER.md` routing (`OBS-02`) and `dream` phases (`OBS-03`) in evidence ledger entries; encode REA routing/ledger rules directly into `skills/understanding/rea-evidence.md`. |
| Creating & testing MyBrain `SKILL.md` files (Task 4) | `superpowers:writing-skills` | Follow skill-TDD: RED baseline failure scenario without skill -> GREEN minimal `SKILL.md` addressing observed gaps -> REFACTOR trigger descriptions (`Use when...`) and anti-loophole rules. |
| TypeScript tests & implementation (Tasks 1–5) | `superpowers:test-driven-development` | Strict RED -> GREEN -> REFACTOR per task. |
| Failure investigation | `superpowers:systematic-debugging` | Diagnose root causes before patching envelope schemas or parser logic. |
| Task verification & review | `superpowers:verification-before-completion` + `superpowers:requesting-code-review` | Fresh `bun test` + `bun run typecheck` exit-0 evidence before commit. |

---

## Review Focus

1. **Host skill mount missing on clean machine:** If configured host paths (Superpowers/REA plugin dirs) do not exist on disk, `SkillRegistry` must gracefully fall back to bundled clean-room skills rather than crashing startup — pinned in Task 1.
2. **Ambiguous or malformed `RESOLVER.md` rules:** Malformed YAML/Markdown rows or duplicate rule IDs must throw a descriptive `ResolverParseError` instead of silently routing to zero skills — pinned in Task 2.
3. **Scout passing with unresolved blocking Unknowns (`UNK-*`):** `validateStationTransition("SCOUT", envelope)` must reject `ScoutEnvelope` when `openUnknowns.some(u => u.blocking)` unless resolved in `EvidenceLedgerService` — pinned in Task 3.
4. **Reviewer approving with failed or missing verification commands:** `ReviewEnvelope` must reject `verdict: "approved"` if `verificationResults` is empty or any entry has `exitCode !== 0` — pinned in Task 3.
5. **Dream overwriting live skills:** `DreamAndGardeningPlanner` writing outside `vault/proposals/` into protected `skills/` paths must be impossible by construction — pinned in Task 5.

---

## File Structure

- `packages/intelligence/{package.json,tsconfig.json}` — `@mybrain/intelligence` workspace config depending on `@mybrain/shared`, `@mybrain/knowledge`.
- `packages/intelligence/src/skills/registry.ts` — `SkillRegistry` (prioritized multi-mount discovery, frontmatter parsing, read-only metadata).
- `packages/intelligence/src/resolver/dispatcher.ts` — `parseResolverMarkdown`, `ResolverEngine.dispatch(context)`.
- `packages/intelligence/src/envelopes/contracts.ts` — `ScoutEnvelopeSchema`, `PlanEnvelopeSchema`, `BuildEnvelopeSchema`, `ReviewEnvelopeSchema`, `DreamEnvelopeSchema`, `validateStationTransition`.
- `packages/intelligence/src/dream/planner.ts` — `DreamAndGardeningPlanner` (backlink audit, orphan check, root-cause page builder, staged `vault/proposals/*.md` writer).
- `packages/intelligence/src/index.ts` — Package exports.
- `skills/RESOLVER.md` & `skills/{understanding,qa-requirements,lauren-tan,gbrain}/*.md` — Bundled clean-room skills.

---

### Task 1: Multi-Mount `SkillRegistry`

**Files:**
- Create: `packages/intelligence/{package.json,tsconfig.json}`
- Create: `packages/intelligence/src/skills/registry.ts`
- Test: `packages/intelligence/tests/skill-registry.test.ts`

**Interfaces:**
- Produces: `SkillMount { rootDir: string; priority: number; readonly: boolean }`, `LoadedSkill { id: string; name: string; description: string; path: string; body: string; readonly: boolean }`, `SkillRegistry` (`scan()`, `get(id)`, `list()`).

- [ ] **Step 1: Initialize `@mybrain/intelligence` and write failing `SkillRegistry` tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Test: (a) bundled skill overrides lower-priority host mount skill with same `name`, (b) nonexistent optional host mount directory logs warning and skips cleanly without throwing (Review Focus #1), (c) skills missing `description` frontmatter throw `SkillFormatError`.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/intelligence/tests/skill-registry.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `SkillRegistry` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Walk `SKILL.md` files under configured mounts sorted by priority ascending, parse YAML frontmatter safely (reusing `parseMarkdownDocument` or `yaml`), tag `readonly` flags.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/intelligence/tests/skill-registry.test.ts && bun run typecheck` -> PASS. Commit `packages/intelligence`.

---

### Task 2: `RESOLVER.md` Parser & Deterministic Intent Dispatcher

**Files:**
- Create: `packages/intelligence/src/resolver/dispatcher.ts`
- Test: `packages/intelligence/tests/resolver.test.ts`

**Interfaces:**
- Consumes: `SkillRegistry`
- Produces: `ResolverRuleSchema`, `DispatchContext { intent: string; phase: FactoryPhase; targetType: "repo" | "binary" | "web_bundle" | "knowledge"; constraints?: string[] }`, `DispatchPlan { matchedRuleIds: string[]; skills: LoadedSkill[]; writesAllowlist: string[] }`, `ResolverEngine` (`fromMarkdown(src, registry)`, `dispatch(ctx)`).

- [ ] **Step 1: Ground GBrain `RESOLVER.md` mechanics via REA (`OBS-02`) & write failing tests (RED)**
  **Skill:** `reverse-engineer-anything` (`OBS-02` dispatcher model) + `superpowers:test-driven-development`
  Test: (a) `phase: "SCOUT", targetType: "repo"` resolves `understanding/codebase-map` + `understanding/invariant-extractor`, whereas `targetType: "binary"` injects `understanding/rea-evidence`, (b) duplicate rule IDs or invalid YAML trigger table throws `ResolverParseError` (Review Focus #2), (c) unresolved skill ID fails loudly during `dispatch()`.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/intelligence/tests/resolver.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/intelligence/src/resolver/dispatcher.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Parse fenced YAML dispatch block inside `RESOLVER.md` with Zod, validate unique rule IDs, evaluate priority-ordered predicate matching `(phase, targetType, intentKeywords)`, and resolve `LoadedSkill[]` via `SkillRegistry`.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/intelligence/tests/resolver.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 3: Zod Station Envelopes & Trust Transition Gates

**Files:**
- Create: `packages/intelligence/src/envelopes/contracts.ts`
- Test: `packages/intelligence/tests/envelopes.test.ts`

**Interfaces:**
- Consumes: `LedgerAndBacklogService`, `EvidenceEntrySchema`, `RequirementBacklogSchema`
- Produces: `ScoutEnvelopeSchema`, `PlanEnvelopeSchema`, `BuildEnvelopeSchema`, `ReviewEnvelopeSchema`, `DreamEnvelopeSchema`, `TransitionError`, `validateStationTransition(station, envelope, ledgerService?)`, `persistStationOutputs(station, envelope, ledgerService)`.

- [ ] **Step 1: Write failing envelope & Trust Engineering gate tests (RED)**
  **Skill:** `superpowers:test-driven-development` + `reverse-engineer-anything` (verifying Scout `OBS`/`INF`/`UNK` schema)
  Test:
  - `ScoutEnvelope` with `{ blocking: true, status: "open" }` in `openUnknowns` fails `validateStationTransition("SCOUT", env)` with `TransitionError` (Review Focus #3).
  - `ReviewEnvelope` with `verdict: "approved"` and empty `verificationResults` or `exitCode: 1` fails with `TransitionError` (Review Focus #4).
  - `persistStationOutputs("REVIEW_QA", env, ledger)` saves all `generatedRequirements[]` into `@mybrain/knowledge`'s `requirements_backlog` + `vault/backlog/*.md` cleanly.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/intelligence/tests/envelopes.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/intelligence/src/envelopes/contracts.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Define all 5 Zod envelope contracts matching Spec Section 6.3 and implement deterministic transition validation + backlog/ledger persistence helpers.

- [ ] **Step 4: Verify passing output & review before commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test packages/intelligence/tests/envelopes.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 4: Author Bundled Skills Library & `skills/RESOLVER.md` via Skill-TDD

**Files:**
- Create: `skills/RESOLVER.md`
- Create: `skills/understanding/{codebase-map,invariant-extractor,rea-evidence}/SKILL.md`
- Create: `skills/qa-requirements/requirement-generator/SKILL.md`
- Create: `skills/lauren-tan/{trust-audit,gardening}/SKILL.md`
- Create: `skills/gbrain/dream/SKILL.md`
- Test: `packages/intelligence/tests/bundled-skills.test.ts`

**Interfaces:**
- Consumes: `SkillRegistry`, `ResolverEngine`
- Produces: Validated, loadable skill pack loaded by `SkillRegistry` & `ResolverEngine`.

- [ ] **Step 1: Define RED baseline pressure scenarios & failing skill-bundle validation test**
  **Skill:** `superpowers:writing-skills` + `reverse-engineer-anything` + `superpowers:test-driven-development`
  Document baseline failure modes in `packages/intelligence/tests/bundled-skills.test.ts` (why Scout skips invariant extraction, why Reviewer omits structured `NewRequirement[]`, why black-box targets get guessed instead of REA-triaged) and assert `ResolverEngine.fromMarkdown(skills/RESOLVER.md)` resolves valid skill sets for every `(phase, targetType)` matrix cell.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:writing-skills` + `superpowers:test-driven-development`
  Run: `bun test packages/intelligence/tests/bundled-skills.test.ts` -> Expected: FAIL (missing `skills/RESOLVER.md` & `SKILL.md` files).

- [ ] **Step 3: Author clean-room `SKILL.md` files & `skills/RESOLVER.md` (GREEN)**
  **Skill:** `superpowers:writing-skills` + `reverse-engineer-anything` (for `rea-evidence/SKILL.md` routing)
  Write concise, trigger-compliant (`description: "Use when..."`) `SKILL.md` files covering:
  - `understanding/codebase-map` & `understanding/invariant-extractor` (comprehension-debt elimination before planning),
  - `understanding/rea-evidence` (routing binary/APK/bundle/runtime targets to REA + `OBS`/`INF`/`UNK` ledger),
  - `qa-requirements/requirement-generator` (emitting typed `NewRequirement` objects into backlog for Iteration N+1),
  - `lauren-tan/trust-audit` & `lauren-tan/gardening` (verification > generation; harness hardening & pruning),
  - `gbrain/dream` (backlinking, stale-node linting, staged skill synthesis).

- [ ] **Step 4: Refactor loopholes, verify full matrix test & commit**
  **Skill:** `superpowers:writing-skills` (REFACTOR check) + `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test packages/intelligence/tests/bundled-skills.test.ts && bun run typecheck` -> PASS. Commit `skills/` and tests.

---

### Task 5: `DreamAndGardeningPlanner` (Post-Ship Synthesis & Safe Proposal Staging)

**Files:**
- Create: `packages/intelligence/src/dream/planner.ts`
- Create: `packages/intelligence/src/index.ts`
- Test: `packages/intelligence/tests/dream-planner.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `GraphService`, `LedgerAndBacklogService`
- Produces: `DreamReport { brokenWikilinks: string[]; orphanSlugs: string[]; stagedProposals: string[]; archivedRunPageSlug: string }`, `DreamAndGardeningPlanner` (`runCycle(input)`).

- [ ] **Step 1: Write failing `DreamAndGardeningPlanner` tests (RED)**
  **Skill:** `reverse-engineer-anything` (`OBS-03` dream cycle parity) + `superpowers:test-driven-development`
  Test: (a) detects broken wikilinks & orphan pages via `GraphService`, (b) archives iteration summary + root-cause learnings as `vault/pages/station_run/<run-id>.md`, (c) writes proposed skill/rule upgrades ONLY under `vault/proposals/<id>.md` (`status: "pending_approval"`), never touching live `skills/` or `RESOLVER.md` (Review Focus #5).

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/intelligence/tests/dream-planner.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `planner.ts` and `index.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement deterministic graph health scan, vault run archival, and path-enforced proposal writer using `resolveSafeVaultPath(vaultRoot, "proposals", ...)`.

- [ ] **Step 4: Verify full Phase 2 suite, review & commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test && bun run typecheck` -> PASS. Commit `packages/intelligence`.

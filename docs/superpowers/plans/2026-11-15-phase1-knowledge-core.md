# MyBrain Phase 1: Knowledge Core (`@mybrain/shared` + `@mybrain/knowledge`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking, and **every step explicitly declares the skill(s) governing that step**.

**Goal:** Build MyBrain's foundational TypeScript/Bun monorepo packages (`@mybrain/shared` and `@mybrain/knowledge`) providing a Git-backed Markdown Knowledge Vault synchronized deterministically with embedded PGLite (`pgvector` + FTS), RRF hybrid search, Schema Packs, typed Knowledge Graph relations, REA Evidence Ledger (`OBS`/`INF`/`UNK`), and Requirements Backlog persistence.

**Architecture:** Canonical truth lives in Git-tracked Markdown/YAML files under `vault/` (`pages/`, `ledger/`, `backlog/`, `schemas/`), while embedded `@electric-sql/pglite` serves as a fast, completely rebuildable index and hybrid query engine isolated per `--vault` root. Every write mutates disk atomically first and updates PGLite inside an async mutex guarded by an advisory PID lockfile; `reindexVault()` reconstructs the database deterministically from disk.

**Tech Stack:** Bun `>=1.4.4`, TypeScript (`strict`, `noUncheckedIndexedAccess`), `@electric-sql/pglite` (+ `vector` extension), `zod`, `yaml`, `bun:test`.

**Spec:** [docs/superpowers/specs/2026-11-15-mybrain-design.md](../specs/2026-11-15-mybrain-design.md) *(Phase 1 of 4: Phase 2 Intelligence, Phase 3 Factory, Phase 4 CLI/MCP/UI).*

---

## Global Constraints

1. **Runtime & Toolchain:** Bun `>=1.4.4`, Node.js `>=24.x`, Git `>=2.50` on Windows; all file paths must use `node:path` normalization (`resolveSafeVaultPath`) and normalize `\r\n` -> `\n` before hashing/parsing.
2. **Type Safety & Runtime Validation:** `"strict": true` and `"noUncheckedIndexedAccess": true` in TypeScript; all domain entities, Schema Packs, and ledger/backlog frontmatter validated at runtime with Zod.
3. **Database Dual-Mode & Zero-Docker Default:** Default storage uses embedded `@electric-sql/pglite` with `pgvector` inside `<vault>/.mybrain/pgdata` behind a thin `DbClient` interface supporting external Postgres later.
4. **Offline Embedding Optionality:** Must run with zero external API keys (`embeddingMode: "none"` -> FTS/BM25 + Graph 1-hop RRF without failing on `NULL` embedding columns) while supporting pluggable `EmbeddingProvider` adapters (`VECTOR(768)`).
5. **Single-Owner Concurrency:** Embedded PGLite enforces single-process ownership via `<vault>/.mybrain/daemon.lock` (advisory PID lockfile) plus an in-process async write mutex.
6. **Canonical Disk-Wins Sync:** `vault/` Markdown files are canonical; SHA-256 `content_hash` reconciles external disk edits/deletions cleanly on sync/reindex.

---

## Skill-to-Step Binding Matrix (Phase 1)

| Step Type | Required Skill | Concrete Rule Enforced |
|---|---|---|
| Workspace isolation & branch setup | `superpowers:using-git-worktrees` | Isolate feature work before touching source files when executing in an existing repo. |
| GBrain clean-room parity checks (Tasks 1, 3, 6, 7) | `reverse-engineer-anything` (REA) | Record `OBS`/`INF`/`UNK` ledger before coding GBrain-inspired schema, Schema Packs, RRF, and `evidence_ledger`; invoke `analyze_javascript_application` / `inspect_artifact` *only* if a compiled/packaged GBrain artifact is supplied (skip binary tools for plain source per REA routing rules). |
| Test-first / minimal implementation | `superpowers:test-driven-development` | Strict RED (write failing test & observe fail) -> GREEN (minimal code) -> REFACTOR loop. |
| Unexpected failure recovery | `superpowers:systematic-debugging` | Root-cause diagnosis before changing code if any test or PGLite extension load fails. |
| Task completion proof | `superpowers:verification-before-completion` | Run fresh `bun test` + `bun run typecheck`, read full output & exit 0 before committing. |
| Per-task / whole-phase review | `superpowers:requesting-code-review` | Subagent/reviewer verifies spec parity, edge cases, and Review Focus tests before advancing. |
| Branch wrap-up (end of Phase 1) | `superpowers:finishing-a-development-branch` | Confirm clean full suite & present merge/PR options. |

---

## Review Focus

1. **Windows CRLF (`\r\n`) vs LF (`\n`) hash & frontmatter drift:** Editing `vault/*.md` in Windows editors must not cause spurious dirty-page re-indexing on subsequent `syncVault()` calls — pinned in Task 2 (`hashStringNormalized`) and Task 4 (`parseMarkdownDocument`).
2. **Vault path traversal / malicious slugs:** Slugs or entity types containing `..`, drive letters, backslashes, or colons must throw `VaultPathError` before touching disk — pinned in Task 2 (`resolveSafeVaultPath`) and Task 5 (`VaultStore`).
3. **Offline `embeddingMode: "none"` / mixed NULL embeddings:** `HybridSearchEngine.search()` must rank FTS + 1-hop Graph matches without throwing SQL vector operator errors when no embeddings exist or only partial chunks are embedded — pinned in Task 6 (`hybrid-search`).
4. **External manual edit & deletion reconciliation:** Manual edits or `git pull` deletions in `vault/` must override stale PGLite rows (disk wins) and delete orphaned DB pages/chunks/relations — pinned in Task 5 (`syncVault`).
5. **Advisory lock contention & crashed-PID recovery:** Opening a second `VaultStore` while a live PID holds `daemon.lock` must reject with `VaultLockError`, whereas a stale lockfile from a dead PID must be safely reclaimed — pinned in Task 2 (`acquireVaultLock`).

---

## File Structure

- `package.json`, `tsconfig.base.json`, `.gitignore` — Bun workspaces root (`packages/*`, `apps/*`) & strict TypeScript config.
- `packages/shared/src/{paths,hash,lockfile,schemas,index}.ts` — Safe path resolver, normalized SHA-256 hashing, advisory PID lockfile, core Zod contracts.
- `packages/knowledge/src/db/{client,schema}.ts` — `DbClient` interface, `PgliteClient` w/ async write mutex & `vector` extension, DDL for 5 core tables + GIN/vector indexes.
- `packages/knowledge/src/schema-pack/loader.ts` — Built-in `gbrain-base` & `software-factory` Schema Packs, YAML parser, entity/relation validators.
- `packages/knowledge/src/markdown/{frontmatter,chunker}.ts` — Canonical YAML frontmatter serializer/parser, wikilink extractor, heading-aware word chunker.
- `packages/knowledge/src/vault/store.ts` — `VaultStore` atomic temp+rename disk writes, SHA-256 disk-wins sync, and `reindexVault()`.
- `packages/knowledge/src/search/rrf.ts` — Deterministic Reciprocal Rank Fusion (`k = 60`) across FTS, optional Vector, and 1-hop Graph lanes.
- `packages/knowledge/src/graph/queries.ts` — Cycle-safe BFS neighbor traversal, typed edge mutations, broken wikilink detector.
- `packages/knowledge/src/ledger/service.ts` — REA Evidence Ledger (`OBS`/`INF`/`UNK`) & Reviewer/QA Requirements Backlog service.

---

### Task 1: Workspace Bootstrap & PGLite (`pgvector`) Database Layer

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/knowledge/package.json`, `packages/knowledge/tsconfig.json`
- Create: `packages/knowledge/src/db/client.ts`, `packages/knowledge/src/db/schema.ts`
- Test: `packages/knowledge/tests/db-schema.test.ts`

**Interfaces:**
- Produces:
  - `DbQueryResult<T>` & `DbClient` (`query<T>(sql, params?)`, `exec(sql)`, `transaction<T>(fn)`, `close()`) in `packages/knowledge/src/db/client.ts`
  - `createPgliteClient(dataDir?: string): Promise<DbClient>` in `packages/knowledge/src/db/client.ts`
  - `applyKnowledgeSchema(db: DbClient, vectorDims?: number): Promise<void>` in `packages/knowledge/src/db/schema.ts`

- [ ] **Step 1: Initialize workspace, install dependencies & record GBrain DB parity ledger**
  **Skill:** `superpowers:using-git-worktrees` (if running inside an existing repo branch) + `reverse-engineer-anything` (clean-room evidence discipline)
  Run `git init` (since `d:\Project\MyBrain` has no `.git` yet), create root `package.json` (`workspaces: ["packages/*", "apps/*"]`, scripts `test`, `typecheck`), `tsconfig.base.json` (`strict: true`, `noUncheckedIndexedAccess: true`), `.gitignore`, and `packages/knowledge/{package.json,tsconfig.json}`. Install deps:
  `bun add --cwd packages/knowledge @electric-sql/pglite zod yaml && bun add -D typescript @types/bun`
  Confirm against Spec Section 3 (`OBS-01`, `INF-01`, `UNK-01`) which PGLite vector subpath resolves in installed `@electric-sql/pglite` (use `analyze_javascript_application` only if an opaque compiled GBrain bundle is supplied; otherwise record resolved `@electric-sql/pglite/vector` API observation).

- [ ] **Step 2: Write the failing DB schema & `pgvector` test (RED)**
  **Skill:** `superpowers:test-driven-development`
  Create `packages/knowledge/tests/db-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createPgliteClient } from "../src/db/client";
import { applyKnowledgeSchema } from "../src/db/schema";

describe("PGLite knowledge schema", () => {
  test("creates all 5 core tables, FTS tsvector, and pgvector cosine search", async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        ["p1", "concept/trust-engineering", "default", "Trust Engineering", "concept", "gbrain-base", "{}", "h1", "Verification exceeds generation", "Trust Engineering Verification exceeds generation"]
      );
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $4))`,
        ["c1", "p1", 0, "Verification exceeds generation", 3, "[1,0,0]"]
      );

      const vecRes = await db.query<{ id: string; distance: number }>(
        `SELECT id, (embedding <=> '[0.9,0.1,0]'::vector) AS distance FROM chunks ORDER BY distance ASC LIMIT 1`
      );
      expect(vecRes.rows[0]?.id).toBe("c1");
      expect(vecRes.rows[0]?.distance).toBeLessThan(0.1);

      const tables = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
      );
      expect(tables.rows.map((r) => r.tablename).sort()).toEqual([
        "chunks", "evidence_ledger", "pages", "relations", "requirements_backlog"
      ]);
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/db-schema.test.ts` -> Expected: FAIL (module not found).

- [ ] **Step 4: Implement `DbClient` and `applyKnowledgeSchema` (GREEN)**
  **Skill:** `superpowers:test-driven-development` (plus `superpowers:systematic-debugging` if `@electric-sql/pglite` WASM/vector extension fails to load on Windows Bun)
  Implement `createPgliteClient(dataDir?)` wrapping `PGlite` + `vector` extension behind an async promise-chain write mutex (`enqueue`), and idempotent `applyKnowledgeSchema(db, vectorDims = 768)` creating `pages`, `chunks`, `relations`, `evidence_ledger`, `requirements_backlog`, and GIN/B-tree indexes. Validate `vectorDims` as positive integer.

- [ ] **Step 5: Verify passing output & review before commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test packages/knowledge/tests/db-schema.test.ts` and `bun run typecheck` -> verify 1 pass, 0 fail, exit 0. Commit:
  `git add package.json tsconfig.base.json .gitignore packages/knowledge && git commit -m "chore: bootstrap bun monorepo and pglite pgvector schema"`

---

### Task 2: `@mybrain/shared` — Safe Paths, Normalized Hashing, Advisory Lockfile & Zod Contracts

**Files:**
- Create: `packages/shared/{package.json,tsconfig.json}`
- Create: `packages/shared/src/{paths,hash,lockfile,schemas,index}.ts`
- Test: `packages/shared/tests/{paths-hash-lock,schemas}.test.ts`

**Interfaces:**
- Produces: `VaultPathError`, `sanitizeSlug`, `resolveSafeVaultPath`; `normalizeLineEndings`, `sha256Hex`; `VaultLockError`, `VaultLockHandle`, `acquireVaultLock`, `isPidAlive`; `PageFrontmatterSchema`, `RelationEdgeSchema`, `EvidenceEntrySchema`, `RequirementBacklogSchema`, `SchemaPackSchema`, `EmbeddingProvider`.

- [ ] **Step 1: Write failing tests for CRLF hashing, traversal blocking, lock contention & Zod schemas (RED)**
  **Skill:** `superpowers:test-driven-development`
  Create `packages/shared/package.json` & `tsconfig.json`, and write `packages/shared/tests/paths-hash-lock.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireVaultLock, VaultLockError } from "../src/lockfile";
import { sha256Hex } from "../src/hash";
import { resolveSafeVaultPath, sanitizeSlug, VaultPathError } from "../src/paths";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("paths, hashing, and lockfile", () => {
  test("sha256Hex treats CRLF and LF identically", () => {
    expect(sha256Hex("a\r\nb\r\nc")).toBe(sha256Hex("a\nb\nc"));
  });

  test("resolveSafeVaultPath blocks traversal and drive injection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-path-"));
    dirs.push(root);
    expect(() => resolveSafeVaultPath(root, "..", "secrets.md")).toThrow(VaultPathError);
    expect(() => resolveSafeVaultPath(root, "pages", "C:\\Windows\\win.ini")).toThrow(VaultPathError);
    expect(sanitizeSlug("Concept / Trust & Verify!")).toBe("concept-trust-and-verify");
  });

  test("acquireVaultLock blocks live PID and reclaims dead PID lock", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-lock-"));
    dirs.push(root);
    const lockPath = path.join(root, "daemon.lock");
    const handle = await acquireVaultLock(lockPath);
    await expect(acquireVaultLock(lockPath)).rejects.toThrow(VaultLockError);
    await handle.release();

    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const reclaimed = await acquireVaultLock(lockPath);
    await reclaimed.release();
  });
});
```

Also write `packages/shared/tests/schemas.test.ts` validating `EvidenceEntrySchema` (`observation | inference | unknown`) and `RequirementBacklogSchema` (`blocking_bug | edge_case | tech_debt | hardening_rule | skill_gap`).

- [ ] **Step 2: Run tests to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/shared/tests` -> Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `paths.ts`, `hash.ts`, `lockfile.ts`, `schemas.ts`, and `index.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement Windows-safe `resolveSafeVaultPath`, CRLF-normalizing `sha256Hex`, `O_EXCL` (`flag: "wx"`) `acquireVaultLock` with `process.kill(pid, 0)` stale-PID reclaim, and all Zod schemas matching Spec Section 6.2/6.3.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test packages/shared/tests && bun run typecheck` -> Expected: PASS, exit 0. Commit `packages/shared`.

---

### Task 3: Schema Pack Loader & Entity/Relation Validation

**Files:**
- Create: `packages/knowledge/src/schema-pack/loader.ts`
- Modify: `packages/knowledge/package.json` (depend on `@mybrain/shared: workspace:*`)
- Test: `packages/knowledge/tests/schema-pack.test.ts`

**Interfaces:**
- Consumes: `SchemaPackSchema`, `PageFrontmatter` from `@mybrain/shared`
- Produces: `BUILTIN_PACKS`, `SchemaValidationError`, `loadSchemaPackYaml(src)`, `validateEntityAgainstPack(fm, pack)`, `validateRelationAgainstPack(relType, pack)`

- [ ] **Step 1: Verify GBrain Schema Pack invariants via REA ledger & write failing tests (RED)**
  **Skill:** `reverse-engineer-anything` (grounding `OBS-03` Schema Packs) + `superpowers:test-driven-development`
  Verify YAML schema pack fields (`entityTypes`, `relationTypes`, `requiredFrontmatter`) in Spec `OBS-03`, link `@mybrain/shared`, run `bun install`, and write `packages/knowledge/tests/schema-pack.test.ts`:
  - Assert `loadSchemaPackYaml` parses valid YAML into `SchemaPack`.
  - Assert `validateEntityAgainstPack` accepts `concept` under `gbrain-base` and throws `SchemaValidationError` for unknown `entity_type`.
  - Assert `software-factory` built-in pack accepts `spec`, `plan`, `bug`, `requirement`, `skill`, `incident` and relations `blocks`, `implements`, `generated_by`, `evidenced_by`, rejecting invalid relation names.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/schema-pack.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/knowledge/src/schema-pack/loader.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement YAML parsing via `yaml` + `SchemaPackSchema`, `BUILTIN_PACKS["gbrain-base"]` & `BUILTIN_PACKS["software-factory"]`, and `SchemaValidationError` validators.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/knowledge/tests/schema-pack.test.ts && bun run typecheck` -> PASS. Commit `packages/knowledge`.

---

### Task 4: Canonical Markdown Frontmatter Serializer, Wikilink Extractor & Heading Chunker

**Files:**
- Create: `packages/knowledge/src/markdown/{frontmatter,chunker}.ts`
- Test: `packages/knowledge/tests/frontmatter-chunker.test.ts`

**Interfaces:**
- Consumes: `normalizeLineEndings`, `sha256Hex` from `@mybrain/shared`
- Produces: `parseMarkdownDocument<T>(raw, schema)`, `serializeMarkdownDocument<T>(fm, body)`, `extractWikilinks(body)`, `chunkMarkdown(body, opts?)`

- [ ] **Step 1: Write failing frontmatter, CRLF-invariant, wikilink & chunker tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Create `packages/knowledge/tests/frontmatter-chunker.test.ts`:
  - Assert `serializeMarkdownDocument` -> `parseMarkdownDocument` round-trip equality and identical `contentHash` across `\r\n` vs `\n` (Review Focus #1).
  - Assert `extractWikilinks` extracts `["architecture/trust-engineering", "concept/pglite"]` from `"See [[architecture/trust-engineering|Trust]] and [[concept/pglite]]"`, dedupes, and ignores fenced code blocks.
  - Assert `chunkMarkdown(body, { maxWords: 50, overlapWords: 10 })` preserves `headingPath` (`# Top > ## Sub`) and emits `[]` for whitespace-only bodies.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/frontmatter-chunker.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `frontmatter.ts` and `chunker.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement CRLF-safe YAML `---` parsing/serialization, fence-stripping wikilink extraction, and sliding-window heading-aware chunker (defaults: `maxWords: 450`, `overlapWords: 60`).

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/knowledge/tests/frontmatter-chunker.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 5: Atomic `VaultStore`, Disk-Wins Sync & Full `reindexVault()`

**Files:**
- Create: `packages/knowledge/src/vault/store.ts`
- Test: `packages/knowledge/tests/vault-sync.test.ts`

**Interfaces:**
- Consumes: `DbClient`, `acquireVaultLock`, `resolveSafeVaultPath`, `parseMarkdownDocument`, `serializeMarkdownDocument`, `chunkMarkdown`, `validateEntityAgainstPack`, optional `EmbeddingProvider`
- Produces: `VaultStore` (`open`, `rememberPage`, `getPageBySlug`, `syncVault`, `reindexVault`, `close`), `SyncReport`

- [ ] **Step 1: Write failing `VaultStore` disk-wins sync & rebuild tests (RED)**
  **Skill:** `superpowers:test-driven-development`
  Create `packages/knowledge/tests/vault-sync.test.ts` testing:
  - `rememberPage` writes `vault/pages/<type>/<slug>.md` atomically and indexes `pages` + `chunks`.
  - Direct external disk edit + `syncVault()` overrides PGLite (`indexed: 1`, `body_md` updated) — Review Focus #4.
  - Deleting a `.md` file + `syncVault()` deletes DB row (`deleted: 1`) — Review Focus #4.
  - `TRUNCATE pages CASCADE` + `reindexVault()` restores full DB from disk.
  - `rememberPage` with `slug: "../../escape"` rejects with `VaultPathError` — Review Focus #2.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/vault-sync.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/knowledge/src/vault/store.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development` (and `superpowers:systematic-debugging` if Windows atomic rename or lock cleanup hits EBUSY)
  Implement temp+rename writes, advisory `.mybrain/daemon.lock`, SHA-256 `content_hash` diffing inside DB transactions, and `reindexVault()`.

- [ ] **Step 4: Verify passing output & review before commit**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review`
  Run: `bun test packages/knowledge/tests/vault-sync.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 6: Deterministic RRF Fusion & Hybrid Search (`FTS + Vector + 1-Hop Graph`)

**Files:**
- Create: `packages/knowledge/src/search/rrf.ts`
- Test: `packages/knowledge/tests/rrf-search.test.ts`

**Interfaces:**
- Consumes: `DbClient`, `EmbeddingProvider`
- Produces: `fuseRrfRankings(lists, k = 60)`, `HybridSearchEngine` (`search(opts)`)

- [ ] **Step 1: Check GBrain RRF constraints via REA ledger & write failing tests (RED)**
  **Skill:** `reverse-engineer-anything` (`OBS-03` RRF, `UNK-01` clean-room `k = 60`) + `superpowers:test-driven-development`
  Create `packages/knowledge/tests/rrf-search.test.ts`:
  - Assert `fuseRrfRankings` (`k = 60`) scores multi-lane overlap (`rank 2` in two lanes) above single-lane `rank 1`.
  - Assert `embeddingMode: "none"` (`embeddingProvider: undefined`) ranks FTS `ts_rank_cd` + 1-hop graph neighbors cleanly with zero SQL NULL vector errors (Review Focus #3).
  - Assert mock `EmbeddingProvider` (3-dim) merges semantic vector cosine distance (`<=>`) with FTS matches.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/rrf-search.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `packages/knowledge/src/search/rrf.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement FTS lane (`plainto_tsquery`), conditional Vector lane (`WHERE embedding IS NOT NULL`), and 1-hop Graph neighbor lane (`weight = 0.5`), fused with `fuseRrfRankings(..., 60)`.

- [ ] **Step 4: Verify passing output & commit**
  **Skill:** `superpowers:verification-before-completion`
  Run: `bun test packages/knowledge/tests/rrf-search.test.ts && bun run typecheck` -> PASS. Commit.

---

### Task 7: Knowledge Graph Queries, REA Evidence Ledger & Requirements Backlog Service

**Files:**
- Create: `packages/knowledge/src/graph/queries.ts`
- Create: `packages/knowledge/src/ledger/service.ts`
- Create: `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/tests/graph-ledger.test.ts`

**Interfaces:**
- Consumes: `VaultStore`, `DbClient`, `SchemaPack`, `EvidenceEntrySchema`, `RequirementBacklogSchema`
- Produces: `GraphService`, `LedgerAndBacklogService`, and package exports in `packages/knowledge/src/index.ts`

- [ ] **Step 1: Write failing Graph traversal, REA Evidence Ledger & Backlog tests (RED)**
  **Skill:** `reverse-engineer-anything` (verifying `OBS`/`INF`/`UNK` schema fidelity) + `superpowers:test-driven-development`
  Create `packages/knowledge/tests/graph-ledger.test.ts`:
  - Assert `GraphService.addRelation` validates relation type, updates canonical `.md` frontmatter + DB edge, and `getNeighbors(slug, 2)` handles `A <-> B` cycles without looping.
  - Assert `findBrokenWikilinks()` reports unresolved `[[missing/target]]` references.
  - Assert `LedgerAndBacklogService.addEvidence` writes `vault/ledger/<subject>/<id>.md` + PGLite, and `getBlockingUnknowns(subject)` returns only unresolved blocking `unknown` claims.
  - Assert `addRequirement` writes `vault/backlog/<id>.md` + `requirements_backlog`, and `VaultStore.reindexVault()` after `TRUNCATE` restores `relations`, `evidence_ledger`, and `requirements_backlog`.

- [ ] **Step 2: Run test to verify RED failure**
  **Skill:** `superpowers:test-driven-development`
  Run: `bun test packages/knowledge/tests/graph-ledger.test.ts` -> Expected: FAIL.

- [ ] **Step 3: Implement `queries.ts`, `service.ts`, extend `syncVault()` for `ledger/` & `backlog/`, export `index.ts` (GREEN)**
  **Skill:** `superpowers:test-driven-development`
  Implement cycle-safe BFS traversal, ledger & backlog Markdown round-trips, and wire `syncVault()` / `reindexVault()` to reconstruct all 5 tables from disk.

- [ ] **Step 4: Run full Phase 1 verification, code review & branch check**
  **Skill:** `superpowers:verification-before-completion` + `superpowers:requesting-code-review` + `superpowers:finishing-a-development-branch`
  Run full workspace proof: `bun test && bun run typecheck` -> verify ALL tests pass, 0 skipped, exit 0 before claiming Phase 1 complete and committing.

---

## Self-Review Check

- **Spec coverage:** Covers Spec Section 6.2 completely (`@mybrain/shared` + `@mybrain/knowledge`).
- **Skill bindings:** Every task step specifies exact execution skill (`using-git-worktrees`, `reverse-engineer-anything`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `finishing-a-development-branch`).
- **Review Focus tests:** All 5 Review Focus edge cases are explicitly pinned into Tasks 2, 4, 5, and 6.

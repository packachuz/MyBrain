import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VaultPathError } from "@mybrain/shared";
import {
  createPgliteClient,
  GraphService,
  LedgerAndBacklogService,
  parseMarkdownDocument,
  SchemaValidationError,
  VaultStore,
} from "../src/index";

const tempDirs: string[] = [];

function createTempVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mybrain-graph-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GraphService (relations, cycle-safe BFS, broken wikilinks)", () => {
  test("addRelation validates relationType against source SchemaPack, updates source .md frontmatter + DB edge", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const graph = new GraphService(store);

    try {
      const specPage = await store.rememberPage({
        type: "spec",
        slug: "knowledge-core",
        title: "Knowledge Core Spec",
        schema: "software-factory",
        body: "# Knowledge Core\n\nCanonical vault specification.",
      });
      const planPage = await store.rememberPage({
        type: "plan",
        slug: "phase-1-plan",
        title: "Phase 1 Plan",
        schema: "software-factory",
        body: "# Phase 1 Plan\n\nImplementation steps.",
      });

      // Invalid relationType under software-factory must throw SchemaValidationError
      await expect(
        graph.addRelation("plan/phase-1-plan", "spec/knowledge-core", "loves"),
      ).rejects.toThrow(SchemaValidationError);

      // Missing target page must throw
      await expect(
        graph.addRelation("plan/phase-1-plan", "spec/does-not-exist", "implements"),
      ).rejects.toThrow();

      const added = await graph.addRelation(
        "plan/phase-1-plan",
        "spec/knowledge-core",
        "implements",
        { weight: 0.95, evidenceRef: "OBS-001" },
      );

      expect(added.sourceId).toBe(planPage.id);
      expect(added.targetId).toBe(specPage.id);
      expect(added.relationType).toBe("implements");
      expect(added.weight).toBeCloseTo(0.95);
      expect(added.evidenceRef).toBe("OBS-001");

      // Source .md frontmatter must contain updated relations[] and preserve body
      const rawDisk = readFileSync(planPage.filePath, "utf8");
      const parsed = parseMarkdownDocument(rawDisk);
      expect(parsed.body).toContain("Implementation steps.");
      const fmRelations = parsed.frontmatter.relations as Array<Record<string, unknown>>;
      expect(fmRelations).toHaveLength(1);
      expect(fmRelations[0]?.relationType).toBe("implements");
      expect(fmRelations[0]?.targetId).toBe(specPage.id);
      expect(fmRelations[0]?.evidenceRef).toBe("OBS-001");

      // DB relations row exists
      const relRows = await store.db.query<{
        source_id: string;
        target_id: string;
        relation_type: string;
        weight: number;
        evidence_ref: string | null;
      }>(`SELECT source_id, target_id, relation_type, weight, evidence_ref FROM relations`);
      expect(relRows.rows).toHaveLength(1);
      expect(relRows.rows[0]?.source_id).toBe(planPage.id);
      expect(relRows.rows[0]?.target_id).toBe(specPage.id);
      expect(relRows.rows[0]?.relation_type).toBe("implements");

      // Immediate syncVault() must see source page content_hash as unchanged
      const syncReport = await store.syncVault();
      expect(syncReport.indexed).toBe(0);
      expect(syncReport.unchanged).toBe(2);
    } finally {
      await store.close();
    }
  });

  test("getNeighbors handles A <-> B cycles and multi-hop BFS depth bounds without infinite looping", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const graph = new GraphService(store);

    try {
      await store.rememberPage({
        type: "concept",
        slug: "node-a",
        title: "Node A",
        body: "Start node A.",
      });
      await store.rememberPage({
        type: "concept",
        slug: "node-b",
        title: "Node B",
        body: "Middle node B.",
      });
      await store.rememberPage({
        type: "concept",
        slug: "node-c",
        title: "Node C",
        body: "Hop 2 node C.",
      });
      await store.rememberPage({
        type: "concept",
        slug: "node-d",
        title: "Node D",
        body: "Hop 3 node D.",
      });

      // Cycle A <-> B, plus chain B -> C -> D and C -> A
      await graph.addRelation("concept/node-a", "concept/node-b", "relates_to");
      await graph.addRelation("concept/node-b", "concept/node-a", "depends_on");
      await graph.addRelation("concept/node-b", "concept/node-c", "relates_to");
      await graph.addRelation("concept/node-c", "concept/node-d", "relates_to");

      const depth1 = await graph.getNeighbors("concept/node-a", 1);
      expect(depth1.map((n) => n.slug)).toEqual(["concept/node-b"]);
      expect(depth1[0]?.depth).toBe(1);

      const depth2 = await graph.getNeighbors("concept/node-a", 2);
      const slugs = depth2.map((n) => n.slug);
      expect(slugs).toEqual(["concept/node-b", "concept/node-c"]);
      expect(depth2.find((n) => n.slug === "concept/node-c")?.depth).toBe(2);
      expect(slugs).not.toContain("concept/node-a");
      expect(slugs).not.toContain("concept/node-d");

      // Incoming direction check from node-d
      const incomingFromD = await graph.getNeighbors("concept/node-d", 1);
      expect(incomingFromD).toHaveLength(1);
      expect(incomingFromD[0]?.slug).toBe("concept/node-c");
      expect(incomingFromD[0]?.direction).toBe("incoming");

      // Non-existent slug or depth <= 0 returns empty
      expect(await graph.getNeighbors("concept/nonexistent", 2)).toEqual([]);
      expect(await graph.getNeighbors("concept/node-a", 0)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("findBrokenWikilinks reports unresolved [[missing/target]] while ignoring valid slugs and fenced code", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const graph = new GraphService(store);

    try {
      await store.rememberPage({
        type: "concept",
        slug: "trust-engineering",
        title: "Trust Engineering",
        body: "Core trust principles.",
      });

      await store.rememberPage({
        type: "note",
        slug: "linker-note",
        title: "Linker Note",
        body: [
          "Valid full slug: [[concept/trust-engineering]].",
          "Valid leaf slug with alias: [[trust-engineering|Trust]].",
          "Valid heading link: [[concept/trust-engineering#Section]].",
          "Intra-page anchor: [[#local-heading]].",
          "Broken canonical link: [[missing/target]].",
          "Broken leaf link: [[ghost-page]].",
          "",
          "Inline code ignored: `[[ignored/inline]]`.",
          "",
          "```markdown",
          "[[ignored/in-fence]]",
          "```",
        ].join("\n"),
      });

      const broken = await graph.findBrokenWikilinks();
      expect(broken).toHaveLength(2);
      expect(broken.every((b) => b.sourceSlug === "note/linker-note")).toBe(true);
      expect(broken.map((b) => b.target)).toEqual([
        "missing/target",
        "ghost-page",
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("LedgerAndBacklogService (REA Evidence Ledger & Requirements Backlog)", () => {
  test("addEvidence writes vault/ledger/<subject>/<id>.md + DB, updateEvidenceStatus/resolveEvidence updates both, getBlockingUnknowns filters correctly", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const ledger = new LedgerAndBacklogService(store);

    try {
      // Path traversal and invalid claimKind must be rejected before disk write
      await expect(
        ledger.addEvidence({
          id: "OBS-BAD",
          targetSubject: "../../escape",
          claimKind: "observation",
          statement: "Should fail traversal",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        ledger.addEvidence({
          id: "../OBS-BAD",
          targetSubject: "pglite",
          claimKind: "observation",
          statement: "Should fail id traversal",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        ledger.addEvidence({
          id: "BAD-KIND",
          targetSubject: "pglite",
          claimKind: "guess" as "observation",
          statement: "Invalid claimKind",
        }),
      ).rejects.toThrow();

      // Write OBS, INF, open blocking UNK, open non-blocking UNK, and resolved blocking UNK
      const obs = await ledger.addEvidence({
        id: "OBS-001",
        projectId: "proj-1",
        targetSubject: "auth-service",
        claimKind: "observation",
        statement: "Login endpoint returns 401 on expired JWT.",
        artifactRef: "src/auth.ts:42",
        verifiedBy: "unit-test",
        status: "verified",
      });

      const obsFile = path.join(
        vaultRoot,
        "vault",
        "ledger",
        "auth-service",
        "OBS-001.md",
      );
      expect(existsSync(obsFile)).toBe(true);
      expect(obs.contentHash).toBeTruthy();

      await ledger.addEvidence({
        id: "INF-001",
        projectId: "proj-1",
        targetSubject: "auth-service",
        claimKind: "inference",
        statement: "Refresh tokens are stored in HttpOnly cookies.",
        blocking: true,
        status: "open",
      });

      await ledger.addEvidence({
        id: "UNK-001",
        projectId: "proj-1",
        targetSubject: "auth-service",
        claimKind: "unknown",
        statement: "Does token rotation invalidate concurrent sessions?",
        blocking: true,
        status: "open",
      });

      await ledger.addEvidence({
        id: "UNK-002",
        projectId: "proj-1",
        targetSubject: "auth-service",
        claimKind: "unknown",
        statement: "Non-blocking question about logging format.",
        blocking: false,
        status: "open",
      });

      await ledger.addEvidence({
        id: "UNK-003",
        projectId: "proj-1",
        targetSubject: "auth-service",
        claimKind: "unknown",
        statement: "Already resolved blocking unknown.",
        blocking: true,
        status: "resolved",
      });

      const blockingUnknowns = await ledger.getBlockingUnknowns("auth-service");
      expect(blockingUnknowns.map((u) => u.id)).toEqual(["UNK-001"]);

      const allAuth = await ledger.listEvidence({ targetSubject: "auth-service" });
      expect(allAuth).toHaveLength(5);

      // Resolving UNK-001 updates disk .md + DB so getBlockingUnknowns becomes empty
      const resolvedUnk = await ledger.resolveEvidence("UNK-001", {
        verifiedBy: "security-audit",
        artifactRef: "tests/auth-rotation.test.ts",
      });
      expect(resolvedUnk.status).toBe("resolved");
      expect(resolvedUnk.verifiedBy).toBe("security-audit");

      const unkFile = path.join(
        vaultRoot,
        "vault",
        "ledger",
        "auth-service",
        "UNK-001.md",
      );
      const unkDisk = parseMarkdownDocument(readFileSync(unkFile, "utf8"));
      expect(unkDisk.frontmatter.status).toBe("resolved");
      expect(unkDisk.frontmatter.verifiedBy).toBe("security-audit");

      expect(await ledger.getBlockingUnknowns("auth-service")).toEqual([]);

      // Update status explicitly via updateEvidenceStatus
      await ledger.updateEvidenceStatus("UNK-002", { status: "verified" });
      const verifiedList = await ledger.listEvidence({
        targetSubject: "auth-service",
        status: "verified",
      });
      expect(verifiedList.map((e) => e.id).sort()).toEqual(["OBS-001", "UNK-002"]);

      // syncVault sees zero changes because disk & DB hashes match
      const syncReport = await store.syncVault();
      expect(syncReport.indexed).toBe(0);
      expect(syncReport.unchanged).toBe(5);
    } finally {
      await store.close();
    }
  });

  test("addRequirement writes vault/backlog/<id>.md + DB, listRequirements & updateRequirementStatus work", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const service = new LedgerAndBacklogService(store);

    try {
      await expect(
        service.addRequirement({
          id: "../../REQ-BAD",
          sourceStation: "qa",
          category: "blocking_bug",
          title: "Bad path",
          description: "Must fail path check",
        }),
      ).rejects.toThrow(VaultPathError);

      const req1 = await service.addRequirement({
        id: "REQ-001",
        projectId: "proj-1",
        parentRunId: "run-42",
        sourceStation: "reviewer",
        severity: "high",
        category: "edge_case",
        title: "Handle cyclic graph traversal",
        description: "Ensure BFS stops when encountering visited nodes.",
        acceptanceCriteria: ["A <-> B terminates cleanly", "Returns unique neighbors"],
      });

      const reqFile = path.join(vaultRoot, "vault", "backlog", "REQ-001.md");
      expect(existsSync(reqFile)).toBe(true);
      expect(req1.status).toBe("open");

      const req2 = await service.addRequirement({
        id: "REQ-002",
        projectId: "proj-1",
        sourceStation: "qa",
        severity: "low",
        category: "tech_debt",
        title: "Clean unused imports",
        description: "Minor cleanup.",
      });
      expect(req2.status).toBe("open");

      const openReqs = await service.listRequirements({ status: "open" });
      expect(openReqs.map((r) => r.id)).toEqual(["REQ-001", "REQ-002"]);

      const promoted = await service.updateRequirementStatus("REQ-001", "promoted");
      expect(promoted.status).toBe("promoted");

      const reqDisk = parseMarkdownDocument(readFileSync(reqFile, "utf8"));
      expect(reqDisk.frontmatter.status).toBe("promoted");

      const promotedList = await service.listRequirements({ status: "promoted" });
      expect(promotedList.map((r) => r.id)).toEqual(["REQ-001"]);
    } finally {
      await store.close();
    }
  });

  test("VaultStore.syncVault() and reindexVault() reconstruct pages, chunks, relations, evidence_ledger, and requirements_backlog from disk", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });
    const graph = new GraphService(store);
    const service = new LedgerAndBacklogService(store);

    try {
      await store.rememberPage({
        type: "spec",
        slug: "core-arch",
        title: "Core Architecture",
        schema: "software-factory",
        body: "# Core Architecture\n\nDisk-first canonical state.",
      });
      await store.rememberPage({
        type: "plan",
        slug: "build-core",
        title: "Build Core",
        schema: "software-factory",
        body: "# Build Core\n\nExecution plan.",
      });
      await graph.addRelation("plan/build-core", "spec/core-arch", "implements", {
        weight: 0.9,
        evidenceRef: "OBS-100",
      });

      await service.addEvidence({
        id: "OBS-100",
        targetSubject: "core-arch",
        claimKind: "observation",
        statement: "All tables derive from vault markdown.",
        status: "verified",
      });
      await service.addEvidence({
        id: "UNK-100",
        targetSubject: "core-arch",
        claimKind: "unknown",
        statement: "Verify backup retention policy.",
        blocking: true,
        status: "open",
      });

      await service.addRequirement({
        id: "REQ-100",
        sourceStation: "audit",
        severity: "critical",
        category: "hardening_rule",
        title: "Enforce disk-wins recovery",
        description: "Reindex must rebuild all 5 tables.",
        acceptanceCriteria: ["TRUNCATE + reindexVault restores 100% of rows"],
      });

      // Truncate all 5 tables completely
      await store.db.exec(
        "TRUNCATE TABLE pages, chunks, relations, evidence_ledger, requirements_backlog CASCADE;",
      );

      const reindexReport = await store.reindexVault();
      expect(reindexReport.scanned).toBe(5);
      expect(reindexReport.indexed).toBe(5);
      expect(reindexReport.deleted).toBe(0);

      // Verify all 5 tables restored
      const counts = await Promise.all([
        store.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM pages`),
        store.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM chunks`),
        store.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM relations`),
        store.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM evidence_ledger`),
        store.db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM requirements_backlog`),
      ]);
      expect(counts.map((c) => c.rows[0]?.cnt)).toEqual(["2", "2", "1", "2", "1"]);

      // Graph traversal works immediately after reindex
      const neighbors = await graph.getNeighbors("plan/build-core", 1);
      expect(neighbors.map((n) => n.slug)).toEqual(["spec/core-arch"]);

      // Blocking unknowns work immediately after reindex
      const unknowns = await service.getBlockingUnknowns("core-arch");
      expect(unknowns.map((u) => u.id)).toEqual(["UNK-100"]);

      // External edit on disk + delete on disk -> syncVault() reconciles disk-wins
      const reqFile = path.join(vaultRoot, "vault", "backlog", "REQ-100.md");
      const editedReq = readFileSync(reqFile, "utf8").replace(
        "status: open",
        "status: resolved",
      );
      writeFileSync(reqFile, editedReq, "utf8");

      const obsFile = path.join(
        vaultRoot,
        "vault",
        "ledger",
        "core-arch",
        "OBS-100.md",
      );
      unlinkSync(obsFile);

      const syncReport = await store.syncVault();
      expect(syncReport.indexed).toBe(1);
      expect(syncReport.deleted).toBe(1);

      const reqsAfter = await service.listRequirements({ status: "resolved" });
      expect(reqsAfter.map((r) => r.id)).toEqual(["REQ-100"]);

      const evidenceAfter = await service.listEvidence({ targetSubject: "core-arch" });
      expect(evidenceAfter.map((e) => e.id)).toEqual(["UNK-100"]);
    } finally {
      await store.close();
    }
  });
});

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
import {
  VaultLockError,
  VaultPathError,
  type EmbeddingProvider,
} from "@mybrain/shared";
import { createPgliteClient, type DbClient } from "../src/db/client";
import { SchemaValidationError } from "../src/schema-pack/loader";
import { VaultStore } from "../src/vault/store";

const tempDirs: string[] = [];

function createTempVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mybrain-vault-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("VaultStore atomic writes, disk-wins sync, and reindexVault", () => {
  test("rememberPage writes vault/pages/<type>/<slug>.md atomically and indexes pages + chunks", async () => {
    const vaultRoot = createTempVault();
    const store = await VaultStore.open({ vaultRoot });

    try {
      expect(existsSync(path.join(vaultRoot, ".mybrain", "pgdata"))).toBe(true);

      const body = [
        "# Trust Engineering",
        "",
        "Verification exceeds generation.",
        "",
        "## Core Principle",
        "",
        "Deterministic checks gate probabilistic output.",
      ].join("\n");

      const page = await store.rememberPage({
        type: "concept",
        slug: "trust-engineering",
        title: "Trust Engineering",
        body,
        tags: ["trust", "verification"],
      });

      const expectedFile = path.join(
        vaultRoot,
        "vault",
        "pages",
        "concept",
        "trust-engineering.md",
      );
      expect(existsSync(expectedFile)).toBe(true);
      expect(page.slug).toBe("concept/trust-engineering");
      expect(page.type).toBe("concept");
      expect(page.title).toBe("Trust Engineering");

      const diskRaw = readFileSync(expectedFile, "utf8");
      expect(diskRaw).toContain("title: Trust Engineering");
      expect(diskRaw).toContain("Verification exceeds generation.");

      const fetched = await store.getPageBySlug("concept/trust-engineering");
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(page.id);
      expect(fetched?.bodyMd).toContain("Deterministic checks gate probabilistic output.");

      // Also resolves leaf slug when unambiguous
      const fetchedLeaf = await store.getPageBySlug("trust-engineering");
      expect(fetchedLeaf?.id).toBe(page.id);

      const pageRows = await store.db.query<{
        id: string;
        slug: string;
        entity_type: string;
        content_hash: string;
        body_md: string;
      }>(`SELECT id, slug, entity_type, content_hash, body_md FROM pages`);
      expect(pageRows.rows).toHaveLength(1);
      expect(pageRows.rows[0]?.slug).toBe("concept/trust-engineering");
      expect(pageRows.rows[0]?.entity_type).toBe("concept");
      expect(pageRows.rows[0]?.content_hash).toBe(page.contentHash);

      const chunkRows = await store.db.query<{
        chunk_index: number;
        content: string;
      }>(
        `SELECT chunk_index, content FROM chunks WHERE page_id = $1 ORDER BY chunk_index ASC`,
        [page.id],
      );
      expect(chunkRows.rows.length).toBe(2);
      expect(chunkRows.rows[0]?.content).toContain("Verification exceeds generation.");
      expect(chunkRows.rows[1]?.content).toContain(
        "Deterministic checks gate probabilistic output.",
      );

      // Overwriting an existing page via rememberPage preserves id and replaces chunks atomically
      const updated = await store.rememberPage({
        type: "concept",
        slug: "trust-engineering",
        title: "Trust Engineering v2",
        body: "# Trust Engineering\n\nSingle updated section.",
      });
      expect(updated.id).toBe(page.id);

      const updatedChunks = await store.db.query<{ chunk_index: number }>(
        `SELECT chunk_index FROM chunks WHERE page_id = $1`,
        [page.id],
      );
      expect(updatedChunks.rows).toHaveLength(1);
    } finally {
      await store.close();
    }
  }, 20_000);

  test("direct external disk edit + syncVault() overrides PGLite (indexed: 1, body_md updated) (Review Focus #4)", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      const page = await store.rememberPage({
        type: "concept",
        slug: "disk-wins",
        title: "Disk Wins",
        body: "# Disk Wins\n\nInitial version stored via rememberPage.\n",
      });

      // Immediately syncing unchanged vault is a no-op
      const cleanSync = await store.syncVault();
      expect(cleanSync.scanned).toBe(1);
      expect(cleanSync.indexed).toBe(0);
      expect(cleanSync.unchanged).toBe(1);
      expect(cleanSync.deleted).toBe(0);

      // Simulate external edit (e.g. git pull or user editor)
      const filePath = path.join(
        vaultRoot,
        "vault",
        "pages",
        "concept",
        "disk-wins.md",
      );
      const original = readFileSync(filePath, "utf8");
      const externallyEdited = original.replace(
        "Initial version stored via rememberPage.",
        "Externally edited content from git pull.",
      );
      writeFileSync(filePath, externallyEdited, "utf8");

      const report = await store.syncVault();
      expect(report.scanned).toBe(1);
      expect(report.indexed).toBe(1);
      expect(report.unchanged).toBe(0);
      expect(report.deleted).toBe(0);

      const dbRow = await store.db.query<{ body_md: string }>(
        `SELECT body_md FROM pages WHERE id = $1`,
        [page.id],
      );
      expect(dbRow.rows[0]?.body_md).toContain(
        "Externally edited content from git pull.",
      );
      expect(dbRow.rows[0]?.body_md).not.toContain(
        "Initial version stored via rememberPage.",
      );
    } finally {
      await store.close();
    }
  });

  test("deleting a .md file + syncVault() deletes DB row and cascaded chunks (deleted: 1) (Review Focus #4)", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      const pageA = await store.rememberPage({
        type: "note",
        slug: "keep-me",
        title: "Keep Me",
        body: "This note stays on disk.",
      });
      const pageB = await store.rememberPage({
        type: "note",
        slug: "delete-me",
        title: "Delete Me",
        body: "This note will be deleted from disk.",
      });

      const deletedFile = path.join(
        vaultRoot,
        "vault",
        "pages",
        "note",
        "delete-me.md",
      );
      unlinkSync(deletedFile);

      const report = await store.syncVault();
      expect(report.scanned).toBe(1);
      expect(report.deleted).toBe(1);
      expect(report.indexed).toBe(0);
      expect(report.unchanged).toBe(1);

      expect(await store.getPageBySlug("note/keep-me")).not.toBeNull();
      expect(await store.getPageBySlug("note/delete-me")).toBeNull();

      const remainingChunks = await store.db.query<{ id: string }>(
        `SELECT id FROM chunks WHERE page_id = $1`,
        [pageB.id],
      );
      expect(remainingChunks.rows).toEqual([]);

      const keptChunks = await store.db.query<{ id: string }>(
        `SELECT id FROM chunks WHERE page_id = $1`,
        [pageA.id],
      );
      expect(keptChunks.rows.length).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("TRUNCATE pages CASCADE + reindexVault() restores full DB from disk", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      const p1 = await store.rememberPage({
        type: "concept",
        slug: "pglite",
        title: "PGLite",
        body: "# PGLite\n\nEmbedded WASM Postgres.",
      });
      const p2 = await store.rememberPage({
        type: "spec",
        slug: "phase-1",
        title: "Phase 1 Spec",
        schema: "software-factory",
        body: "# Phase 1\n\nKnowledge Core specification.",
      });

      await store.db.exec("TRUNCATE pages CASCADE");

      const emptyPages = await store.db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM pages`,
      );
      expect(emptyPages.rows[0]?.cnt).toBe("0");

      const report = await store.reindexVault();
      expect(report.scanned).toBe(2);
      expect(report.indexed).toBe(2);
      expect(report.deleted).toBe(0);

      const restored1 = await store.getPageBySlug("concept/pglite");
      const restored2 = await store.getPageBySlug("spec/phase-1");
      expect(restored1?.id).toBe(p1.id);
      expect(restored1?.bodyMd).toContain("Embedded WASM Postgres.");
      expect(restored2?.id).toBe(p2.id);
      expect(restored2?.schema).toBe("software-factory");

      const restoredChunks = await store.db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM chunks`,
      );
      expect(restoredChunks.rows[0]?.cnt).toBe("2");
    } finally {
      await store.close();
    }
  });

  test("rememberPage rejects traversal, drive letters, backslashes, and colons with VaultPathError (Review Focus #2)", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      await expect(
        store.rememberPage({
          type: "concept",
          slug: "../../escape",
          title: "Escape",
          body: "Should fail",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        store.rememberPage({
          type: "../x",
          slug: "escape",
          title: "Type Escape",
          body: "Should fail",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        store.rememberPage({
          type: "concept",
          slug: "C:\\Windows\\win.ini",
          title: "Drive Escape",
          body: "Should fail",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        store.rememberPage({
          type: "concept",
          slug: "..\\..\\escape",
          title: "Backslash Escape",
          body: "Should fail",
        }),
      ).rejects.toThrow(VaultPathError);

      await expect(
        store.rememberPage({
          type: "concept",
          slug: "bad:colon",
          title: "Colon Escape",
          body: "Should fail",
        }),
      ).rejects.toThrow(VaultPathError);

      expect(existsSync(path.join(vaultRoot, "escape.md"))).toBe(false);
      expect(existsSync(path.join(vaultRoot, "vault", "x"))).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("rememberPage validates entity type against schema pack before writing to disk", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      await expect(
        store.rememberPage({
          type: "nonexistent_entity",
          slug: "bad-entity",
          title: "Bad Entity",
          body: "Should fail schema validation",
        }),
      ).rejects.toThrow(SchemaValidationError);

      const badPath = path.join(
        vaultRoot,
        "vault",
        "pages",
        "nonexistent_entity",
        "bad-entity.md",
      );
      expect(existsSync(badPath)).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("CRLF conversion on disk does not trigger spurious reindex on syncVault (Review Focus #1)", async () => {
    const vaultRoot = createTempVault();
    const db = await createPgliteClient();
    const store = await VaultStore.open({ vaultRoot, db });

    try {
      await store.rememberPage({
        type: "concept",
        slug: "crlf-test",
        title: "CRLF Test",
        body: "# Heading\n\nLine one.\nLine two.\n",
      });

      const filePath = path.join(
        vaultRoot,
        "vault",
        "pages",
        "concept",
        "crlf-test.md",
      );
      const lfContent = readFileSync(filePath, "utf8");
      writeFileSync(filePath, lfContent.replace(/\n/g, "\r\n"), "utf8");

      const report = await store.syncVault();
      expect(report.scanned).toBe(1);
      expect(report.indexed).toBe(0);
      expect(report.unchanged).toBe(1);
    } finally {
      await store.close();
    }
  });

  test("advisory daemon.lock blocks concurrent VaultStore.open, cleans up on open failure, and releases on close failure", async () => {
    const vaultRoot = createTempVault();
    const store1 = await VaultStore.open({ vaultRoot });

    try {
      expect(existsSync(path.join(vaultRoot, ".mybrain", "daemon.lock"))).toBe(true);
      await expect(VaultStore.open({ vaultRoot })).rejects.toThrow(VaultLockError);
    } finally {
      await store1.close();
    }

    expect(existsSync(path.join(vaultRoot, ".mybrain", "daemon.lock"))).toBe(false);

    // Failed open (e.g. invalid vectorDims) must release lock and close DB cleanly
    const db = await createPgliteClient();
    await expect(
      VaultStore.open({ vaultRoot, db, vectorDims: 0 }),
    ).rejects.toThrow(RangeError);
    expect(existsSync(path.join(vaultRoot, ".mybrain", "daemon.lock"))).toBe(false);

    // close() must still release daemon.lock even if db.close() rejects
    const realDb = await createPgliteClient();
    const failingCloseDb: DbClient = {
      query: (sql, params) => realDb.query(sql, params),
      exec: (sql) => realDb.exec(sql),
      transaction: (fn) => realDb.transaction(fn),
      async close() {
        await realDb.close();
        throw new Error("simulated close failure");
      },
    };
    const store2 = await VaultStore.open({ vaultRoot, db: failingCloseDb });
    expect(existsSync(path.join(vaultRoot, ".mybrain", "daemon.lock"))).toBe(true);
    await expect(store2.close()).rejects.toThrow("simulated close failure");
    expect(existsSync(path.join(vaultRoot, ".mybrain", "daemon.lock"))).toBe(false);
  }, 20_000);

  test("supports optional EmbeddingProvider for chunks during rememberPage and reindexVault", async () => {
    const vaultRoot = createTempVault();
    const embedCalls: string[][] = [];
    const provider: EmbeddingProvider = {
      dims: 3,
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls.push(texts);
        return texts.map((_, idx) => [1, idx * 0.1, 0]);
      },
    };

    const db = await createPgliteClient();
    const store = await VaultStore.open({
      vaultRoot,
      db,
      embeddingProvider: provider,
    });

    try {
      const page = await store.rememberPage({
        type: "concept",
        slug: "vectors",
        title: "Vectors",
        body: "# Vectors\n\nCosine similarity chunk.",
      });
      expect(embedCalls.length).toBe(1);

      const vecRows = await store.db.query<{
        id: string;
        distance: number;
      }>(
        `SELECT id, (embedding <=> '[1,0,0]'::vector) AS distance FROM chunks WHERE page_id = $1`,
        [page.id],
      );
      expect(vecRows.rows).toHaveLength(1);
      expect(vecRows.rows[0]?.distance).toBeLessThan(0.01);

      await store.reindexVault();
      expect(embedCalls.length).toBe(2);
    } finally {
      await store.close();
    }
  });
});

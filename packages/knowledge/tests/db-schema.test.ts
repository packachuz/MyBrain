import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("applyKnowledgeSchema is idempotent and validates vectorDims", async () => {
    const db = await createPgliteClient();
    try {
      await expect(applyKnowledgeSchema(db, 0)).rejects.toThrow();
      await expect(applyKnowledgeSchema(db, -4)).rejects.toThrow();
      await expect(applyKnowledgeSchema(db, 3.5)).rejects.toThrow();

      await applyKnowledgeSchema(db, 3);
      await applyKnowledgeSchema(db, 3);

      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      );
      const names = indexes.rows.map((r) => r.indexname);
      expect(names).toContain("idx_pages_search_tsv");
      expect(names).toContain("idx_chunks_search_tsv");
      expect(names).toContain("idx_pages_project_id");
      expect(names).toContain("idx_relations_source_id");
      expect(names).toContain("idx_relations_target_id");
    } finally {
      await db.close();
    }
  });

  test("enforces evidence_ledger and requirements_backlog columns, constraints, and transactions", async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);

      await db.query(
        `INSERT INTO evidence_ledger (id, project_id, target_subject, claim_kind, statement, artifact_ref, verified_by, status, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        ["obs-1", "proj-a", "pglite", "observation", "Uses @electric-sql/pglite-pgvector", "package.json", "test", "verified", "hash-obs-1"]
      );

      const ledgerRow = await db.query<{ blocking: boolean; content_hash: string; project_id: string }>(
        `SELECT blocking, content_hash, project_id FROM evidence_ledger WHERE id = $1`,
        ["obs-1"]
      );
      expect(ledgerRow.rows[0]).toEqual({
        blocking: false,
        content_hash: "hash-obs-1",
        project_id: "proj-a",
      });

      await expect(
        db.query(
          `INSERT INTO evidence_ledger (id, project_id, target_subject, claim_kind, statement)
           VALUES ($1, $2, $3, $4, $5)`,
          ["bad-1", "proj-a", "pglite", "invalid_kind", "Nope"]
        )
      ).rejects.toThrow();

      await expect(
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO requirements_backlog (id, project_id, parent_run_id, source_station, severity, category, title, description, acceptance_criteria, status, content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
            ["req-1", "proj-a", "run-1", "reviewer", "high", "edge_case", "Add retry", "Retry on lock", "[\"Retries 3 times\"]", "open", "hash-req-1"]
          );
          throw new Error("force rollback");
        })
      ).rejects.toThrow("force rollback");

      const afterRollback = await db.query<{ id: string }>(
        `SELECT id FROM requirements_backlog WHERE id = $1`,
        ["req-1"]
      );
      expect(afterRollback.rows).toEqual([]);

      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO requirements_backlog (id, project_id, parent_run_id, source_station, severity, category, title, description, acceptance_criteria, status, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
          ["req-2", "proj-a", "run-1", "reviewer", "medium", "tech_debt", "Index chunks", "Add index", "[]", "open", "hash-req-2"]
        );
      });

      const committed = await db.query<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM requirements_backlog WHERE id = $1`,
        ["req-2"]
      );
      expect(committed.rows[0]).toEqual({ id: "req-2", content_hash: "hash-req-2" });
    } finally {
      await db.close();
    }
  });

  test("creates nested dataDir recursively, persists data across reopen, and serializes concurrent writes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "mybrain-pglite-"));
    const nestedDataDir = join(tempRoot, ".mybrain", "pgdata");

    try {
      const db1 = await createPgliteClient(nestedDataDir);
      try {
        await applyKnowledgeSchema(db1, 3);
        await Promise.all(
          Array.from({ length: 5 }, (_, idx) =>
            db1.query(
              `INSERT INTO pages (id, slug, project_id, title, entity_type)
               VALUES ($1, $2, $3, $4, $5)`,
              [`p-${idx}`, `note/p-${idx}`, "default", `Page ${idx}`, "note"]
            )
          )
        );
      } finally {
        await db1.close();
      }

      const db2 = await createPgliteClient(nestedDataDir);
      try {
        const countRes = await db2.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM pages`
        );
        expect(countRes.rows[0]?.cnt).toBe("5");
      } finally {
        await db2.close();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

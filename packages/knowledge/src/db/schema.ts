import type { DbClient } from "./client";

/**
 * Apply the idempotent Knowledge Core schema (tables, pgvector extension,
 * FTS GIN indexes, and relational B-tree indexes) to a `DbClient`.
 */
export async function applyKnowledgeSchema(
  db: DbClient,
  vectorDims = 768,
): Promise<void> {
  if (!Number.isInteger(vectorDims) || vectorDims <= 0) {
    throw new RangeError(
      `vectorDims must be a positive integer, received ${String(vectorDims)}`,
    );
  }

  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      project_id TEXT NOT NULL DEFAULT 'default',
      title TEXT,
      entity_type TEXT,
      schema_pack TEXT,
      frontmatter JSONB,
      content_hash TEXT,
      body_md TEXT,
      search_tsv TSVECTOR,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      token_count INT,
      embedding VECTOR(${vectorDims}),
      search_tsv TSVECTOR
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      weight REAL,
      evidence_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS evidence_ledger (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      target_subject TEXT,
      claim_kind TEXT CHECK (claim_kind IN ('observation', 'inference', 'unknown')),
      statement TEXT,
      artifact_ref TEXT,
      verified_by TEXT,
      status TEXT,
      blocking BOOLEAN NOT NULL DEFAULT FALSE,
      content_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS requirements_backlog (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_run_id TEXT,
      source_station TEXT,
      severity TEXT,
      category TEXT,
      title TEXT,
      description TEXT,
      acceptance_criteria JSONB,
      status TEXT,
      content_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pages_search_tsv ON pages USING GIN (search_tsv);
    CREATE INDEX IF NOT EXISTS idx_chunks_search_tsv ON chunks USING GIN (search_tsv);
    CREATE INDEX IF NOT EXISTS idx_pages_project_id ON pages (project_id);
    CREATE INDEX IF NOT EXISTS idx_pages_entity_type ON pages (entity_type);
    CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks (page_id);
    CREATE INDEX IF NOT EXISTS idx_relations_source_id ON relations (source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target_id ON relations (target_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_ledger_project_subject ON evidence_ledger (project_id, target_subject);
    CREATE INDEX IF NOT EXISTS idx_requirements_backlog_project_status ON requirements_backlog (project_id, status);
  `);
}

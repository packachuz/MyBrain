import { describe, expect, test } from "bun:test";
import type { EmbeddingProvider } from "@mybrain/shared";
import { createPgliteClient, type DbClient } from "../src/db/client";
import { applyKnowledgeSchema } from "../src/db/schema";
import {
  fuseRrfRankings,
  HybridSearchEngine,
  type RrfLane,
  type SearchHit,
} from "../src/search/rrf";

describe("Deterministic RRF Fusion (fuseRrfRankings)", () => {
  test("scores multi-lane overlap (rank 2 in two lanes) above single-lane rank 1 (k = 60)", () => {
    // Lane 1: item-a (rank 1), item-b (rank 2)
    // Lane 2: item-c (rank 1), item-b (rank 2)
    // item-a score: 1 / (60 + 1) = 1/61 = ~0.0163934
    // item-c score: 1 / (60 + 1) = 1/61 = ~0.0163934
    // item-b score: 1 / (60 + 2) + 1 / (60 + 2) = 2/62 = 1/31 = ~0.0322581
    // item-b clearly beats item-a and item-c
    const lane1: RrfLane = {
      name: "fts",
      weight: 1.0,
      items: ["item-a", "item-b"],
    };
    const lane2: RrfLane = {
      name: "vector",
      weight: 1.0,
      items: ["item-c", "item-b"],
    };

    const fused = fuseRrfRankings([lane1, lane2], 60);

    expect(fused.length).toBe(3);
    expect(fused[0]?.id).toBe("item-b");
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
    expect(fused[0]?.sources).toEqual(expect.arrayContaining(["fts", "vector"]));

    const scoreB = 1 / 62 + 1 / 62;
    const scoreA = 1 / 61;
    expect(Math.abs((fused[0]?.score ?? 0) - scoreB)).toBeLessThan(1e-6);
    expect(Math.abs((fused[1]?.score ?? 0) - scoreA)).toBeLessThan(1e-6);
  });

  test("breaks ties deterministically by ascending item ID", () => {
    const lane1: RrfLane = {
      name: "lane1",
      weight: 1.0,
      items: ["gamma", "beta", "alpha"],
    };
    const lane2: RrfLane = {
      name: "lane2",
      weight: 1.0,
      items: ["alpha", "beta", "gamma"],
    };

    // Both alpha and gamma appear at rank 1 in one lane and rank 3 in the other:
    // score = 1/(60+1) + 1/(60+3) = 1/61 + 1/63 = ~0.0322664
    // beta has rank 2 in both lanes: 2/62 = ~0.0322581
    // alpha and gamma tie with identical top scores, beating beta!
    // Deterministic tie-break by ascending ID places alpha before gamma.
    const fused = fuseRrfRankings([lane1, lane2], 60);
    expect(fused[0]?.id).toBe("alpha");
    expect(fused[1]?.id).toBe("gamma");
    expect(fused[2]?.id).toBe("beta");
    const tiedAlpha = fused.find((x) => x.id === "alpha");
    const tiedGamma = fused.find((x) => x.id === "gamma");
    expect(tiedAlpha?.score).toBe(tiedGamma?.score);
    const alphaIndex = fused.findIndex((x) => x.id === "alpha");
    const gammaIndex = fused.findIndex((x) => x.id === "gamma");
    expect(alphaIndex).toBeLessThan(gammaIndex);
  });

  test("handles empty lanes and accepts raw item arrays with default weight 1.0", () => {
    const emptyResult = fuseRrfRankings([]);
    expect(emptyResult).toEqual([]);

    const arrayResult = fuseRrfRankings([["p1", "p2"], []]);
    expect(arrayResult.length).toBe(2);
    expect(arrayResult[0]?.id).toBe("p1");
    expect(arrayResult[1]?.id).toBe("p2");
  });
});

describe("HybridSearchEngine (FTS + Vector + 1-Hop Graph)", () => {
  test("returns empty array immediately without DB queries when query is empty or whitespace", async () => {
    let queried = false;
    const fakeDb: DbClient = {
      async query() {
        queried = true;
        return { rows: [] };
      },
      async exec() {
        queried = true;
      },
      async transaction(fn) {
        return fn(fakeDb);
      },
      async close() {},
    };

    const engine = new HybridSearchEngine(fakeDb);
    expect(await engine.search({ query: "" })).toEqual([]);
    expect(await engine.search({ query: "   \n\t " })).toEqual([]);
    expect(queried).toBe(false);
  });

  test('embeddingMode: "none" (embeddingProvider: undefined) ranks FTS + 1-hop graph neighbors cleanly with zero SQL NULL vector errors (Review Focus #3)', async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);

      // Seed Page 1: "trust-engineering" (matches FTS "verification")
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-trust",
          "concept/trust-engineering",
          "default",
          "Trust Engineering",
          "concept",
          "gbrain-base",
          JSON.stringify({ tags: ["verification", "trust"] }),
          "hash-1",
          "Verification exceeds generation. Deterministic checks gate probabilistic output.",
          "Trust Engineering verification trust Verification exceeds generation Deterministic checks gate probabilistic output",
        ],
      );

      // Chunk for Page 1 with explicit NULL embedding
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, NULL, to_tsvector('english', $6))`,
        [
          "c-trust-1",
          "p-trust",
          0,
          "Verification exceeds generation.",
          3,
          "Verification exceeds generation",
        ],
      );

      // Seed Page 2: "audit-station" (no keyword "verification", but connected 1-hop from p-trust)
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-audit",
          "station/audit-station",
          "default",
          "Audit Station",
          "station",
          "gbrain-base",
          JSON.stringify({ tags: ["review", "qa"] }),
          "hash-2",
          "Closed-loop requirements generator and trust auditor.",
          "Audit Station review qa Closed-loop requirements generator and trust auditor",
        ],
      );

      // Seed Page 3: "unrelated-page" (neither matches FTS nor connected)
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-unrelated",
          "note/recipe",
          "default",
          "Pasta Recipe",
          "note",
          "gbrain-base",
          "{}",
          "hash-3",
          "Boil water, add salt and pasta, cook 9 minutes.",
          "Pasta Recipe Boil water, add salt and pasta, cook 9 minutes",
        ],
      );

      // Connect p-trust -> p-audit via relations
      await db.query(
        `INSERT INTO relations (id, source_id, target_id, relation_type, weight)
         VALUES ($1, $2, $3, $4, $5)`,
        ["rel-1", "p-trust", "p-audit", "implements", 0.9],
      );

      // Construct engine with embeddingProvider: undefined (embeddingMode: "none")
      const engine = new HybridSearchEngine(db);

      const hits = await engine.search({ query: "verification" });

      expect(hits.length).toBe(2);

      // Hit 1 is direct FTS match on p-trust
      expect(hits[0]?.pageId).toBe("p-trust");
      expect(hits[0]?.slug).toBe("concept/trust-engineering");
      expect(hits[0]?.title).toBe("Trust Engineering");
      expect(hits[0]?.entityType).toBe("concept");
      expect(hits[0]?.sources).toContain("fts");
      expect(hits[0]?.score).toBeGreaterThan(0);

      // Hit 2 is 1-hop neighbor p-audit pulled in via Lane 3 (Graph)
      expect(hits[1]?.pageId).toBe("p-audit");
      expect(hits[1]?.slug).toBe("station/audit-station");
      expect(hits[1]?.title).toBe("Audit Station");
      expect(hits[1]?.sources).toContain("graph");
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);

      // p-unrelated should not appear
      expect(hits.map((h) => h.pageId)).not.toContain("p-unrelated");
    } finally {
      await db.close();
    }
  });

  test("filters WHERE c.embedding IS NOT NULL so mixed NULL embeddings never trigger vector distance errors", async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);

      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-vec1",
          "concept/vec1",
          "default",
          "Vector Page 1",
          "concept",
          "gbrain-base",
          "{}",
          "h1",
          "Content with valid embedding",
          "Vector Page 1 Content with valid embedding",
        ],
      );

      // Chunk 1 has a valid vector [1, 0, 0]
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7))`,
        ["c1", "p-vec1", 0, "Chunk with valid vector", 4, "[1, 0, 0]", "Chunk with valid vector"],
      );

      // Chunk 2 has a NULL embedding (e.g. from partial indexing)
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, NULL, to_tsvector('english', $6))`,
        ["c2", "p-vec1", 1, "Chunk with null vector", 4, "Chunk with null vector"],
      );

      const mockProvider: EmbeddingProvider = {
        dims: 3,
        async embed() {
          return [[1, 0, 0]];
        },
      };

      const engine = new HybridSearchEngine(db, mockProvider);
      const hits = await engine.search({ query: "valid vector" });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.pageId).toBe("p-vec1");
      expect(hits[0]?.sources).toContain("vector");
    } finally {
      await db.close();
    }
  });

  test("mock EmbeddingProvider (3-dim) merges semantic vector cosine distance (<=>) with FTS matches and 1-hop graph", async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);

      // Page 1: Keyword match for "distributed consensus" + vector [1, 0, 0]
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-raft",
          "concept/raft",
          "project-alpha",
          "Raft Consensus",
          "concept",
          "gbrain-base",
          "{}",
          "h-raft",
          "Distributed consensus protocol with leader election.",
          "Raft Consensus Distributed consensus protocol with leader election",
        ],
      );
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7))`,
        [
          "c-raft-1",
          "p-raft",
          0,
          "Distributed consensus protocol with leader election.",
          6,
          "[1, 0, 0]",
          "Distributed consensus protocol with leader election",
        ],
      );

      // Page 2: No exact keyword for "distributed", but semantic vector near [1, 0, 0] -> [0.95, 0.05, 0]
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-paxos",
          "concept/paxos",
          "project-alpha",
          "Paxos Protocol",
          "concept",
          "gbrain-base",
          "{}",
          "h-paxos",
          "State machine replication algorithm quorum agreement.",
          "Paxos Protocol State machine replication algorithm quorum agreement",
        ],
      );
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7))`,
        [
          "c-paxos-1",
          "p-paxos",
          0,
          "State machine replication algorithm quorum agreement.",
          6,
          "[0.95, 0.05, 0]",
          "State machine replication algorithm quorum agreement",
        ],
      );

      // Page 3: Connected to p-raft via graph relation, orthogonal vector [0, 1, 0]
      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, to_tsvector('english', $10))`,
        [
          "p-etcd",
          "tool/etcd",
          "project-alpha",
          "etcd Store",
          "tool",
          "gbrain-base",
          "{}",
          "h-etcd",
          "Key-value store backing modern orchestrators.",
          "etcd Store Key-value store backing modern orchestrators",
        ],
      );
      await db.query(
        `INSERT INTO chunks (id, page_id, chunk_index, content, token_count, embedding, search_tsv)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7))`,
        [
          "c-etcd-1",
          "p-etcd",
          0,
          "Key-value store backing modern orchestrators.",
          5,
          "[0, 1, 0]",
          "Key-value store backing modern orchestrators",
        ],
      );

      await db.query(
        `INSERT INTO relations (id, source_id, target_id, relation_type, weight)
         VALUES ($1, $2, $3, $4, $5)`,
        ["rel-etcd-raft", "p-etcd", "p-raft", "uses_protocol", 1.0],
      );

      const mockProvider: EmbeddingProvider = {
        dims: 3,
        async embed() {
          return [[1, 0, 0]];
        },
      };

      const engine = new HybridSearchEngine(db, mockProvider);

      const hits = await engine.search({
        query: "distributed consensus",
        projectId: "project-alpha",
        limit: 10,
      });

      expect(hits.length).toBe(3);

      // p-raft is rank 1 because it matches both FTS and Vector (multi-lane overlap)
      expect(hits[0]?.pageId).toBe("p-raft");
      expect(hits[0]?.sources).toContain("fts");
      expect(hits[0]?.sources).toContain("vector");

      // p-paxos matches via semantic Vector lane
      const paxosHit = hits.find((h) => h.pageId === "p-paxos");
      expect(paxosHit).toBeDefined();
      expect(paxosHit?.sources).toContain("vector");

      // p-etcd is pulled in via Graph lane (1-hop neighbor of p-raft)
      const etcdHit = hits.find((h) => h.pageId === "p-etcd");
      expect(etcdHit).toBeDefined();
      expect(etcdHit?.sources).toContain("graph");

      // Hydration fields check
      for (const hit of hits) {
        expect(hit.pageId).toBeDefined();
        expect(hit.slug).toBeDefined();
        expect(hit.title).toBeDefined();
        expect(hit.entityType).toBeDefined();
        expect(hit.projectId).toBe("project-alpha");
        expect(hit.score).toBeGreaterThan(0);
        expect(hit.sources.length).toBeGreaterThan(0);
        expect(typeof hit.snippet === "string" || typeof hit.bodyMd === "string").toBe(true);
      }
    } finally {
      await db.close();
    }
  });

  test("honors projectId and entityType filters and limit option", async () => {
    const db = await createPgliteClient();
    try {
      await applyKnowledgeSchema(db, 3);

      await db.query(
        `INSERT INTO pages (id, slug, project_id, title, entity_type, schema_pack, frontmatter, content_hash, body_md, search_tsv)
         VALUES
         ('p1', 'concept/c1', 'proj-a', 'Alpha Concept', 'concept', 'gbrain-base', '{}', 'h1', 'Alpha test term', to_tsvector('english', 'Alpha Concept Alpha test term')),
         ('p2', 'task/t1', 'proj-a', 'Alpha Task', 'task', 'gbrain-base', '{}', 'h2', 'Alpha test term', to_tsvector('english', 'Alpha Task Alpha test term')),
         ('p3', 'concept/c2', 'proj-b', 'Beta Concept', 'concept', 'gbrain-base', '{}', 'h3', 'Alpha test term in Beta project', to_tsvector('english', 'Beta Concept Alpha test term in Beta project'))`,
      );

      const engine = new HybridSearchEngine(db);

      // Filter by projectId = 'proj-a'
      const projAHits = await engine.search({
        query: "test term",
        projectId: "proj-a",
      });
      expect(projAHits.every((h) => h.projectId === "proj-a")).toBe(true);
      expect(projAHits.map((h) => h.pageId).sort()).toEqual(["p1", "p2"]);

      // Filter by entityType = 'concept' within proj-a
      const conceptHits = await engine.search({
        query: "test term",
        projectId: "proj-a",
        entityType: "concept",
      });
      expect(conceptHits.length).toBe(1);
      expect(conceptHits[0]?.pageId).toBe("p1");

      // Limit = 1
      const limitedHits = await engine.search({
        query: "test term",
        limit: 1,
      });
      expect(limitedHits.length).toBe(1);
    } finally {
      await db.close();
    }
  });
});

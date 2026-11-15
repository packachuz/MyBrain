import type { EmbeddingProvider } from "@mybrain/shared";
import type { DbClient } from "../db/client";

/**
 * Item in an RRF lane, which can be an entity ID string or an object containing an `id` field.
 */
export type RrfItem = string | { id: string; [key: string]: unknown };

/**
 * A ranked retrieval lane feeding into Reciprocal Rank Fusion.
 */
export interface RrfLane<T extends RrfItem = RrfItem> {
  name?: string;
  weight?: number;
  items: T[];
}

/**
 * Unified scored result from Reciprocal Rank Fusion.
 */
export interface FusedRrfItem {
  id: string;
  score: number;
  sources: string[];
  ranks: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion (RRF) algorithm combining ranked lists from heterogeneous lanes.
 * Formula: score(d) = sum_{m in M} (weight_m / (k + rank_m(d)))
 * Ties are broken deterministically by ascending item ID.
 *
 * @param lists Array of lanes or raw item arrays
 * @param k Smoothing constant (default 60 per clean-room specification)
 */
export function fuseRrfRankings(
  lists: (RrfLane | RrfItem[])[],
  k = 60,
): FusedRrfItem[] {
  if (!Number.isFinite(k) || k < 0) {
    throw new RangeError(`RRF constant k must be non-negative, received ${k}`);
  }

  const accumulator = new Map<
    string,
    { score: number; sources: Set<string>; ranks: Record<string, number> }
  >();

  for (let laneIdx = 0; laneIdx < lists.length; laneIdx++) {
    const entry = lists[laneIdx];
    if (!entry) continue;

    const isLaneObj = !Array.isArray(entry) && typeof entry === "object" && "items" in entry;
    const laneName = isLaneObj && entry.name ? entry.name : `lane-${laneIdx + 1}`;
    const laneWeight = isLaneObj && typeof entry.weight === "number" ? entry.weight : 1.0;
    const items = isLaneObj ? entry.items : (entry as RrfItem[]);

    const seenInLane = new Set<string>();

    for (let rankIdx = 0; rankIdx < items.length; rankIdx++) {
      const raw = items[rankIdx];
      if (!raw) continue;
      const itemId = typeof raw === "string" ? raw : raw.id;
      if (!itemId || seenInLane.has(itemId)) continue;

      seenInLane.add(itemId);
      const rank = rankIdx + 1; // 1-based rank
      const contribution = laneWeight / (k + rank);

      let record = accumulator.get(itemId);
      if (!record) {
        record = { score: 0, sources: new Set(), ranks: {} };
        accumulator.set(itemId, record);
      }

      record.score += contribution;
      record.sources.add(laneName);
      record.ranks[laneName] = rank;
    }
  }

  const results: FusedRrfItem[] = [];
  for (const [id, record] of accumulator.entries()) {
    results.push({
      id,
      score: record.score,
      sources: Array.from(record.sources),
      ranks: record.ranks,
    });
  }

  // Sort descending by RRF score; break ties deterministically by ascending ID
  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id.localeCompare(b.id);
  });

  return results;
}

/**
 * Weights assigned to retrieval lanes in hybrid search.
 */
export interface HybridSearchWeights {
  fts?: number;
  vector?: number;
  graph?: number;
}

/**
 * Query options for `HybridSearchEngine.search`.
 */
export interface HybridSearchOptions {
  query: string;
  projectId?: string;
  entityType?: string;
  limit?: number;
  k?: number;
  weights?: HybridSearchWeights;
}

/**
 * Search hit returned by `HybridSearchEngine`.
 */
export interface SearchHit {
  pageId: string;
  slug: string;
  title: string;
  entityType: string;
  projectId: string;
  score: number;
  sources: string[];
  snippet?: string;
  bodyMd?: string;
}

/**
 * Generates an excerpt snippet centered on query terms.
 */
function generateSnippet(
  bodyMd: string | null | undefined,
  query: string,
  maxLength = 160,
): string {
  if (!bodyMd || bodyMd.trim().length === 0) {
    return "";
  }
  const clean = bodyMd.replace(/[#*`_>~\[\]]/g, " ").replace(/\s+/g, " ").trim();
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let bestIdx = -1;

  for (const term of queryTerms) {
    const idx = clean.toLowerCase().indexOf(term);
    if (idx !== -1) {
      bestIdx = idx;
      break;
    }
  }

  if (bestIdx === -1) {
    return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}...`;
  }

  const start = Math.max(0, bestIdx - 40);
  const end = Math.min(clean.length, bestIdx + maxLength - 40);
  let snippet = clean.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < clean.length) snippet = `${snippet}...`;
  return snippet;
}

/**
 * Deterministic Hybrid Search Engine combining:
 * - Lane 1 (FTS): Full-text search across pages + chunks via `plainto_tsquery` and `ts_rank_cd`
 * - Lane 2 (Vector): Cosine distance `<=>` over non-null chunk embeddings (conditional)
 * - Lane 3 (1-Hop Graph): Relational expansion from top seeds via `relations`
 * - Fusion: Reciprocal Rank Fusion (RRF) with configurable k (default 60)
 */
export class HybridSearchEngine {
  private readonly db: DbClient;
  private readonly embeddingProvider?: EmbeddingProvider;

  constructor(
    dbOrOptions:
      | DbClient
      | { db: DbClient; embeddingProvider?: EmbeddingProvider },
    embeddingProvider?: EmbeddingProvider,
  ) {
    if ("query" in dbOrOptions && typeof dbOrOptions.query === "function") {
      this.db = dbOrOptions as DbClient;
      this.embeddingProvider = embeddingProvider;
    } else {
      const opts = dbOrOptions as {
        db: DbClient;
        embeddingProvider?: EmbeddingProvider;
      };
      this.db = opts.db;
      this.embeddingProvider = opts.embeddingProvider;
    }
  }

  /**
   * Execute hybrid search across FTS, Vector, and Graph lanes.
   */
  public async search(opts: HybridSearchOptions): Promise<SearchHit[]> {
    const trimmedQuery = opts.query?.trim() ?? "";
    if (trimmedQuery.length === 0) {
      return [];
    }

    const k = opts.k ?? 60;
    const limit = opts.limit ?? 10;
    const wFts = opts.weights?.fts ?? 1.0;
    const wVec = opts.weights?.vector ?? 1.0;
    const wGraph = opts.weights?.graph ?? 0.5;

    // --- Lane 1: FTS (pages + chunks) ---
    const ftsRes = await this.db.query<{ page_id: string; best_score: number }>(
      `WITH matched_pages AS (
         SELECT p.id AS page_id, ts_rank_cd(p.search_tsv, plainto_tsquery('english', $1)) AS rank_score
         FROM pages p
         WHERE p.search_tsv @@ plainto_tsquery('english', $1)
           AND ($2::text IS NULL OR p.project_id = $2)
           AND ($3::text IS NULL OR p.entity_type = $3)
       ),
       matched_chunks AS (
         SELECT c.page_id AS page_id, ts_rank_cd(c.search_tsv, plainto_tsquery('english', $1)) AS rank_score
         FROM chunks c
         JOIN pages p ON p.id = c.page_id
         WHERE c.search_tsv @@ plainto_tsquery('english', $1)
           AND ($2::text IS NULL OR p.project_id = $2)
           AND ($3::text IS NULL OR p.entity_type = $3)
       ),
       all_matches AS (
         SELECT page_id, rank_score FROM matched_pages
         UNION ALL
         SELECT page_id, rank_score FROM matched_chunks
       )
       SELECT page_id, MAX(rank_score) AS best_score
       FROM all_matches
       WHERE rank_score > 0
       GROUP BY page_id
       ORDER BY best_score DESC, page_id ASC`,
      [trimmedQuery, opts.projectId ?? null, opts.entityType ?? null],
    );
    const ftsLaneItems = ftsRes.rows.map((r) => r.page_id);

    // --- Lane 2: Vector (Conditional on embeddingProvider) ---
    let vectorLaneItems: string[] = [];
    if (this.embeddingProvider) {
      try {
        const embeddings = await this.embeddingProvider.embed([trimmedQuery]);
        const queryVec = embeddings[0];
        if (queryVec && queryVec.length > 0) {
          const vecLiteral = `[${queryVec.join(",")}]`;
          const vecRes = await this.db.query<{ page_id: string; distance: number }>(
            `SELECT c.page_id, MIN(c.embedding <=> $1::vector) AS distance
             FROM chunks c
             JOIN pages p ON p.id = c.page_id
             WHERE c.embedding IS NOT NULL
               AND ($2::text IS NULL OR p.project_id = $2)
               AND ($3::text IS NULL OR p.entity_type = $3)
             GROUP BY c.page_id
             HAVING MIN(c.embedding <=> $1::vector) < 0.9999
             ORDER BY distance ASC, c.page_id ASC`,
            [vecLiteral, opts.projectId ?? null, opts.entityType ?? null],
          );
          vectorLaneItems = vecRes.rows.map((r) => r.page_id);
        }
      } catch {
        vectorLaneItems = [];
      }
    }

    // --- Lane 3: 1-Hop Graph Neighbor ---
    let graphLaneItems: string[] = [];
    const seedSet = new Set<string>();
    for (const id of ftsLaneItems.slice(0, 10)) seedSet.add(id);
    for (const id of vectorLaneItems.slice(0, 10)) seedSet.add(id);
    const seeds = Array.from(seedSet);

    if (seeds.length > 0) {
      const seedPlaceholders = seeds.map((_, i) => `$${i + 1}`).join(", ");
      const pIdIdx = seeds.length + 1;
      const eTypeIdx = seeds.length + 2;

      const graphRes = await this.db.query<{
        neighbor_id: string;
        max_weight: number;
        edge_count: number;
      }>(
        `SELECT
           CASE WHEN r.source_id IN (${seedPlaceholders}) THEN r.target_id ELSE r.source_id END AS neighbor_id,
           MAX(COALESCE(r.weight, 1.0)) AS max_weight,
           COUNT(*) AS edge_count
         FROM relations r
         JOIN pages p_neighbor ON p_neighbor.id = (
           CASE WHEN r.source_id IN (${seedPlaceholders}) THEN r.target_id ELSE r.source_id END
         )
         WHERE (r.source_id IN (${seedPlaceholders}) OR r.target_id IN (${seedPlaceholders}))
           AND p_neighbor.id NOT IN (${seedPlaceholders})
           AND ($${pIdIdx}::text IS NULL OR p_neighbor.project_id = $${pIdIdx})
           AND ($${eTypeIdx}::text IS NULL OR p_neighbor.entity_type = $${eTypeIdx})
         GROUP BY neighbor_id
         ORDER BY max_weight DESC, edge_count DESC, neighbor_id ASC`,
        [...seeds, opts.projectId ?? null, opts.entityType ?? null],
      );
      graphLaneItems = graphRes.rows.map((r) => r.neighbor_id);
    }

    // --- RRF Fusion ---
    const lanes: RrfLane[] = [];
    if (ftsLaneItems.length > 0) {
      lanes.push({ name: "fts", weight: wFts, items: ftsLaneItems });
    }
    if (vectorLaneItems.length > 0) {
      lanes.push({ name: "vector", weight: wVec, items: vectorLaneItems });
    }
    if (graphLaneItems.length > 0) {
      lanes.push({ name: "graph", weight: wGraph, items: graphLaneItems });
    }

    if (lanes.length === 0) {
      return [];
    }

    const fused = fuseRrfRankings(lanes, k);
    const topFused = fused.slice(0, limit);
    if (topFused.length === 0) {
      return [];
    }

    // --- Hydration ---
    const topIds = topFused.map((f) => f.id);
    const idPlaceholders = topIds.map((_, i) => `$${i + 1}`).join(", ");
    const pageRes = await this.db.query<{
      id: string;
      slug: string;
      project_id: string;
      title: string;
      entity_type: string;
      body_md: string;
    }>(
      `SELECT id, slug, project_id, title, entity_type, body_md
       FROM pages
       WHERE id IN (${idPlaceholders})`,
      topIds,
    );

    const pageMap = new Map(pageRes.rows.map((row) => [row.id, row]));

    const hits: SearchHit[] = [];
    for (const fusedItem of topFused) {
      const row = pageMap.get(fusedItem.id);
      if (!row) continue;

      const snippet = generateSnippet(row.body_md, trimmedQuery);

      hits.push({
        pageId: row.id,
        slug: row.slug,
        title: row.title ?? "",
        entityType: row.entity_type ?? "",
        projectId: row.project_id,
        score: fusedItem.score,
        sources: fusedItem.sources,
        snippet,
        bodyMd: row.body_md,
      });
    }

    return hits;
  }
}

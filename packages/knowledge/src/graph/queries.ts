import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PageFrontmatterSchema,
  type PageFrontmatter,
  type RelationEdge,
} from "@mybrain/shared";
import {
  extractWikilinks,
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from "../markdown/frontmatter";
import {
  SchemaValidationError,
  validateEntityAgainstPack,
  validateRelationAgainstPack,
} from "../schema-pack/loader";
import {
  atomicWriteFile,
  deterministicRelationId,
  resolvePageFilePath,
  upsertRelationRow,
  type VaultStore,
} from "../vault/store";

/** Options when creating or updating a typed edge via `GraphService.addRelation`. */
export interface AddRelationOptions {
  weight?: number;
  evidenceRef?: string;
}

/** Result returned by `GraphService.addRelation`. */
export interface AddedRelation {
  id: string;
  sourceId: string;
  sourceSlug: string;
  targetId: string;
  targetSlug: string;
  relationType: string;
  weight: number;
  evidenceRef?: string;
  createdAt: string;
}

/** Neighbor node returned by `GraphService.getNeighbors`. */
export interface GraphNeighbor {
  id: string;
  pageId: string;
  slug: string;
  title: string;
  entityType: string;
  projectId: string;
  depth: number;
  relationType: string;
  direction: "outgoing" | "incoming";
  weight: number;
  evidenceRef?: string;
}

/** Broken wikilink reference reported by `GraphService.findBrokenWikilinks`. */
export interface BrokenWikilink {
  sourcePageId: string;
  sourceSlug: string;
  sourceTitle: string;
  target: string;
  normalizedTarget: string;
}

interface BfsEdgeRow {
  relation_id: string;
  relation_type: string;
  weight: number;
  evidence_ref: string | null;
  direction: "outgoing" | "incoming";
  neighbor_id: string;
  neighbor_slug: string;
  neighbor_title: string | null;
  neighbor_entity_type: string | null;
  neighbor_project_id: string;
}

function normalizeWikilinkTarget(rawTarget: string): string {
  const withoutAnchor = (rawTarget.split("#")[0] ?? "").trim();
  if (!withoutAnchor) {
    return "";
  }
  const withoutExt = withoutAnchor.endsWith(".md")
    ? withoutAnchor.slice(0, -3)
    : withoutAnchor;
  return withoutExt.replace(/^\/+/, "");
}

/**
 * Knowledge Graph service providing schema-validated relation mutations,
 * cycle-safe BFS traversal, and broken wikilink diagnostics.
 */
export class GraphService {
  private readonly store: VaultStore;

  constructor(store: VaultStore) {
    this.store = store;
  }

  /**
   * Validates `relationType` against the source page's active `SchemaPack`,
   * atomically updates the source page's `.md` frontmatter `relations[]`,
   * updates `pages` (`frontmatter`, `content_hash`), and upserts the `relations` row.
   */
  public async addRelation(
    sourceSlug: string,
    targetSlug: string,
    relationType: string,
    opts?: AddRelationOptions,
  ): Promise<AddedRelation> {
    if (opts?.weight !== undefined && !Number.isFinite(opts.weight)) {
      throw new RangeError(
        `Relation weight must be a finite number, received ${String(opts.weight)}`,
      );
    }

    return this.store.enqueueOp(async () => {
      const source = await this.store.getPageBySlug(sourceSlug);
      if (!source) {
        throw new Error(`Source page not found: ${sourceSlug}`);
      }

      const target = await this.store.getPageBySlug(targetSlug);
      if (!target) {
        throw new Error(`Target page not found: ${targetSlug}`);
      }

      const pack = this.store.getSchemaPack(source.schema);
      if (!pack) {
        throw new SchemaValidationError(
          `Unknown schema pack "${source.schema}" on page "${source.slug}"`,
        );
      }

      validateRelationAgainstPack(relationType, pack);
      const trimmedRelType = relationType.trim();

      const sourceFilePath = resolvePageFilePath(
        this.store.pagesDir,
        source.slug,
      );

      let currentFm: PageFrontmatter = source.frontmatter;
      let currentBody = source.bodyMd;
      try {
        const diskRaw = await fs.readFile(sourceFilePath, "utf8");
        const parsedDisk = parseMarkdownDocument(
          diskRaw,
          PageFrontmatterSchema,
        );
        currentFm = parsedDisk.frontmatter;
        currentBody = parsedDisk.body;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== "ENOENT") {
          throw err;
        }
      }

      const weight = opts?.weight ?? 1.0;
      const evidenceRef =
        typeof opts?.evidenceRef === "string" && opts.evidenceRef.trim() !== ""
          ? opts.evidenceRef.trim()
          : undefined;
      const nowIso = new Date().toISOString();
      const defaultEdgeId = deterministicRelationId(
        source.id,
        target.id,
        trimmedRelType,
      );

      const existingEdges: RelationEdge[] = Array.isArray(currentFm.relations)
        ? [...currentFm.relations]
        : [];

      const matchIdx = existingEdges.findIndex((edge) => {
        const edgeRel = (edge.relationType ?? edge.type ?? "").trim();
        const edgeTargetMatches =
          edge.targetId === target.id || edge.target === target.slug;
        return edgeTargetMatches && edgeRel === trimmedRelType;
      });

      const resolvedEdgeId =
        matchIdx >= 0 &&
        typeof existingEdges[matchIdx]?.id === "string" &&
        existingEdges[matchIdx]!.id!.trim() !== ""
          ? existingEdges[matchIdx]!.id!.trim()
          : defaultEdgeId;

      const createdAt =
        matchIdx >= 0 && typeof existingEdges[matchIdx]?.createdAt === "string"
          ? existingEdges[matchIdx]!.createdAt!
          : nowIso;

      const updatedEdge: RelationEdge = {
        id: resolvedEdgeId,
        sourceId: source.id,
        targetId: target.id,
        target: target.slug,
        relationType: trimmedRelType,
        weight,
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
        createdAt,
      };

      if (matchIdx >= 0) {
        existingEdges[matchIdx] = updatedEdge;
      } else {
        existingEdges.push(updatedEdge);
      }

      const candidateFm: Record<string, unknown> = {
        ...currentFm,
        relations: existingEdges,
        updatedAt: nowIso,
      };

      const validatedFm = validateEntityAgainstPack(candidateFm, pack);
      const serialized = serializeMarkdownDocument(
        validatedFm as Record<string, unknown>,
        currentBody,
      );
      const parsedWritten = parseMarkdownDocument(
        serialized,
        PageFrontmatterSchema,
      );

      await atomicWriteFile(sourceFilePath, serialized);

      await this.store.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE pages
           SET frontmatter = $1::jsonb,
               content_hash = $2,
               updated_at = $3::timestamptz
           WHERE id = $4`,
          [
            JSON.stringify(parsedWritten.frontmatter),
            parsedWritten.contentHash,
            nowIso,
            source.id,
          ],
        );

        await upsertRelationRow(tx, {
          id: resolvedEdgeId,
          sourceId: source.id,
          targetId: target.id,
          relationType: trimmedRelType,
          weight,
          evidenceRef: evidenceRef ?? null,
          createdAt,
        });
      });

      return {
        id: resolvedEdgeId,
        sourceId: source.id,
        sourceSlug: source.slug,
        targetId: target.id,
        targetSlug: target.slug,
        relationType: trimmedRelType,
        weight,
        evidenceRef,
        createdAt,
      };
    });
  }

  /**
   * Cycle-safe breadth-first traversal over `relations` (both outgoing and incoming)
   * up to `depth` hops from `slug`.
   */
  public async getNeighbors(
    slug: string,
    depth = 1,
  ): Promise<GraphNeighbor[]> {
    if (!Number.isFinite(depth) || depth < 1) {
      return [];
    }

    const maxDepth = Math.floor(depth);
    const startPage = await this.store.getPageBySlug(slug);
    if (!startPage) {
      return [];
    }

    const visited = new Set<string>([startPage.id]);
    let frontier: string[] = [startPage.id];
    const neighbors: GraphNeighbor[] = [];

    for (
      let hop = 1;
      hop <= maxDepth && frontier.length > 0;
      hop++
    ) {
      const placeholders = frontier.map((_, i) => `$${i + 1}`).join(", ");
      const res = await this.store.db.query<BfsEdgeRow>(
        `SELECT
           r.id AS relation_id,
           r.relation_type,
           COALESCE(r.weight, 1.0) AS weight,
           r.evidence_ref,
           CASE WHEN r.source_id IN (${placeholders}) THEN 'outgoing' ELSE 'incoming' END AS direction,
           p.id AS neighbor_id,
           p.slug AS neighbor_slug,
           p.title AS neighbor_title,
           p.entity_type AS neighbor_entity_type,
           p.project_id AS neighbor_project_id
         FROM relations r
         JOIN pages p ON p.id = (
           CASE WHEN r.source_id IN (${placeholders}) THEN r.target_id ELSE r.source_id END
         )
         WHERE r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders})
         ORDER BY p.slug ASC, r.relation_type ASC`,
        frontier,
      );

      const nextFrontier: string[] = [];
      for (const row of res.rows) {
        if (visited.has(row.neighbor_id)) {
          continue;
        }
        visited.add(row.neighbor_id);
        nextFrontier.push(row.neighbor_id);

        neighbors.push({
          id: row.neighbor_id,
          pageId: row.neighbor_id,
          slug: row.neighbor_slug,
          title: row.neighbor_title ?? "",
          entityType: row.neighbor_entity_type ?? "",
          projectId: row.neighbor_project_id,
          depth: hop,
          relationType: row.relation_type,
          direction: row.direction,
          weight: Number(row.weight ?? 1.0),
          ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}),
        });
      }

      frontier = nextFrontier;
    }

    return neighbors;
  }

  /**
   * Scans `pages.body_md`, extracts `[[wikilinks]]`, and returns broken references
   * whose normalized target slug matches neither an existing page slug nor a leaf slug.
   */
  public async findBrokenWikilinks(): Promise<BrokenWikilink[]> {
    const pagesRes = await this.store.db.query<{
      id: string;
      slug: string;
      title: string | null;
      body_md: string | null;
    }>(`SELECT id, slug, title, body_md FROM pages ORDER BY slug ASC`);

    const exactSlugs = new Set<string>();
    const leafSlugs = new Set<string>();
    for (const row of pagesRes.rows) {
      exactSlugs.add(row.slug);
      leafSlugs.add(path.posix.basename(row.slug));
    }

    const broken: BrokenWikilink[] = [];
    for (const row of pagesRes.rows) {
      const links = extractWikilinks(row.body_md ?? "");
      for (const target of links) {
        const normalized = normalizeWikilinkTarget(target);
        if (!normalized) {
          continue;
        }
        if (!exactSlugs.has(normalized) && !leafSlugs.has(normalized)) {
          broken.push({
            sourcePageId: row.id,
            sourceSlug: row.slug,
            sourceTitle: row.title ?? "",
            target,
            normalizedTarget: normalized,
          });
        }
      }
    }

    return broken;
  }
}

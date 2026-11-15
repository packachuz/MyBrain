import { z } from "zod";

/**
 * Schema for an entry in the REA Evidence Ledger (OBS-*, INF-*, UNK-*).
 */
export const EvidenceEntrySchema = z
  .object({
    id: z.string(),
    projectId: z.string().default("default"),
    targetSubject: z.string(),
    claimKind: z.enum(["observation", "inference", "unknown"]),
    statement: z.string(),
    artifactRef: z.string().optional(),
    verifiedBy: z.string().optional(),
    blocking: z.boolean().default(false),
    status: z.enum(["open", "verified", "resolved"]).default("open"),
    contentHash: z.string().optional(),
    createdAt: z.string().default(() => new Date().toISOString()),
  })
  .passthrough();

export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

/**
 * Schema for a QA/Reviewer-generated item in the Requirements Backlog.
 */
export const RequirementBacklogSchema = z
  .object({
    id: z.string(),
    projectId: z.string().default("default"),
    parentRunId: z.string().nullable().optional(),
    sourceStation: z.string(),
    severity: z.string().default("medium"),
    category: z.enum([
      "blocking_bug",
      "edge_case",
      "tech_debt",
      "hardening_rule",
      "skill_gap",
    ]),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()).default([]),
    status: z
      .enum(["open", "promoted", "resolved", "wontfix"])
      .default("open"),
    contentHash: z.string().optional(),
    createdAt: z.string().default(() => new Date().toISOString()),
  })
  .passthrough();

export type RequirementBacklog = z.infer<typeof RequirementBacklogSchema>;

/**
 * Schema for a typed edge in the Knowledge Graph.
 * Must specify at least one target identifier (targetId or target)
 * and one relation type (relationType or type).
 */
export const RelationEdgeSchema = z
  .object({
    id: z.string().optional(),
    sourceId: z.string().optional(),
    targetId: z.string().optional(),
    target: z.string().optional(),
    relationType: z.string().optional(),
    type: z.string().optional(),
    weight: z.number().optional().default(1.0),
    evidenceRef: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough()
  .refine(
    (e) => Boolean(e.targetId || e.target) && Boolean(e.relationType || e.type),
    {
      message:
        "Relation edge must specify a target (targetId or target) and a relation type (relationType or type)",
    },
  );

export type RelationEdge = z.infer<typeof RelationEdgeSchema>;

/**
 * Schema for Page YAML frontmatter in `vault/pages/<type>/<slug>.md`.
 */
export const PageFrontmatterSchema = z
  .object({
    id: z.string(),
    slug: z.string().optional(),
    projectId: z.string().default("default"),
    title: z.string(),
    type: z.string(),
    schema: z.string().default("gbrain-base"),
    tags: z.array(z.string()).default([]),
    confidence: z.number().optional(),
    relations: z.array(RelationEdgeSchema).default([]),
    sources: z.array(z.string()).default([]),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type PageFrontmatter = z.infer<typeof PageFrontmatterSchema>;

/**
 * Definition of an entity type inside a Schema Pack.
 */
export const EntityTypeDefinitionSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    requiredFrontmatter: z.array(z.string()).default([]),
  })
  .passthrough();

export type EntityTypeDefinition = z.infer<typeof EntityTypeDefinitionSchema>;

/**
 * Schema for a MyBrain / GBrain Schema Pack manifest.
 */
export const SchemaPackSchema = z
  .object({
    name: z.string(),
    version: z.string().default("0.1.0"),
    entityTypes: z.union([
      z.array(z.string()),
      z.record(
        z.string(),
        z.union([
          EntityTypeDefinitionSchema,
          z.record(z.string(), z.any()),
          z.null(),
        ]),
      ),
      z.array(EntityTypeDefinitionSchema),
    ]),
    relationTypes: z.array(z.string()).default([]),
    requiredFrontmatter: z.array(z.string()).optional(),
  })
  .passthrough();

export type SchemaPack = z.infer<typeof SchemaPackSchema>;

/**
 * Interface for pluggable vector embedding models (local ONNX/Ollama or cloud API).
 */
export interface EmbeddingProvider {
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

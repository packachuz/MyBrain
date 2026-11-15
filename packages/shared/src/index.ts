export {
  resolveSafeVaultPath,
  sanitizeSlug,
  VaultPathError,
} from "./paths";

export {
  normalizeLineEndings,
  sha256Hex,
} from "./hash";

export {
  acquireVaultLock,
  isPidAlive,
  VaultLockError,
  type VaultLockHandle,
} from "./lockfile";

export {
  EntityTypeDefinitionSchema,
  EvidenceEntrySchema,
  PageFrontmatterSchema,
  RelationEdgeSchema,
  RequirementBacklogSchema,
  SchemaPackSchema,
  type EmbeddingProvider,
  type EntityTypeDefinition,
  type EvidenceEntry,
  type PageFrontmatter,
  type RelationEdge,
  type RequirementBacklog,
  type SchemaPack,
} from "./schemas";

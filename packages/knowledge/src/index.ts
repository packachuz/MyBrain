export {
  createPgliteClient,
  type DbClient,
  type DbQueryResult,
  type DbTransactionClient,
} from "./db/client";

export { applyKnowledgeSchema } from "./db/schema";

export {
  BUILTIN_PACKS,
  getPackEntityTypeMap,
  loadSchemaPackYaml,
  SchemaValidationError,
  validateEntityAgainstPack,
  validateRelationAgainstPack,
} from "./schema-pack/loader";

export {
  extractWikilinks,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  type ParsedMarkdownDocument,
} from "./markdown/frontmatter";

export {
  chunkMarkdown,
  type ChunkMarkdownOptions,
  type MarkdownChunk,
} from "./markdown/chunker";

export {
  atomicWriteFile,
  collectMarkdownFiles,
  deterministicRelationId,
  resolveNestedFilePath,
  resolvePageFilePath,
  resolveSingleSegmentFilePath,
  upsertEvidenceRow,
  upsertRelationRow,
  upsertRequirementRow,
  VaultStore,
  type RelationDbRowInput,
  type RememberPageInput,
  type StoredPage,
  type SyncReport,
  type VaultStoreOptions,
} from "./vault/store";

export {
  fuseRrfRankings,
  HybridSearchEngine,
  type FusedRrfItem,
  type HybridSearchOptions,
  type HybridSearchWeights,
  type RrfItem,
  type RrfLane,
  type SearchHit,
} from "./search/rrf";

export {
  GraphService,
  type AddedRelation,
  type AddRelationOptions,
  type BrokenWikilink,
  type GraphNeighbor,
} from "./graph/queries";

export {
  LedgerAndBacklogService,
  type EvidenceFilter,
  type EvidenceInput,
  type EvidenceUpdateInput,
  type RequirementFilter,
  type RequirementInput,
  type StoredEvidenceEntry,
  type StoredRequirementBacklog,
} from "./ledger/service";

import { randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import {
  acquireVaultLock,
  EvidenceEntrySchema,
  normalizeLineEndings,
  PageFrontmatterSchema,
  RequirementBacklogSchema,
  resolveSafeVaultPath,
  sha256Hex,
  VaultPathError,
  type EmbeddingProvider,
  type EvidenceEntry,
  type PageFrontmatter,
  type RelationEdge,
  type RequirementBacklog,
  type SchemaPack,
  type VaultLockHandle,
} from "@mybrain/shared";
import {
  createPgliteClient,
  type DbClient,
  type DbTransactionClient,
} from "../db/client";
import { applyKnowledgeSchema } from "../db/schema";
import { chunkMarkdown, type MarkdownChunk } from "../markdown/chunker";
import {
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from "../markdown/frontmatter";
import {
  BUILTIN_PACKS,
  loadSchemaPackYaml,
  SchemaValidationError,
  validateEntityAgainstPack,
} from "../schema-pack/loader";

/** Options for opening a `VaultStore` instance. */
export interface VaultStoreOptions {
  vaultRoot: string;
  db?: DbClient;
  embeddingProvider?: EmbeddingProvider;
  vectorDims?: number;
  schemaPacks?: Record<string, SchemaPack>;
}

/** Input payload for creating or updating a Markdown knowledge page via `VaultStore.rememberPage`. */
export interface RememberPageInput {
  id?: string;
  slug: string;
  type: string;
  title: string;
  body: string;
  projectId?: string;
  schema?: string;
  tags?: string[];
  confidence?: number;
  relations?: RelationEdge[];
  sources?: string[];
  updatedAt?: string;
  extraFrontmatter?: Record<string, unknown>;
}

/** Indexed page record stored on disk and synchronized into PGLite. */
export interface StoredPage {
  id: string;
  slug: string;
  projectId: string;
  title: string;
  type: string;
  schema: string;
  frontmatter: PageFrontmatter;
  contentHash: string;
  bodyMd: string;
  updatedAt: string;
  filePath: string;
}

/** Summary report returned by `syncVault()` and `reindexVault()`. */
export interface SyncReport {
  scanned: number;
  indexed: number;
  unchanged: number;
  deleted: number;
}

interface ExistingPageRow {
  id: string;
  slug: string;
  content_hash: string | null;
}

interface PageDbRow {
  id: string;
  slug: string;
  project_id: string;
  title: string;
  entity_type: string;
  schema_pack: string;
  frontmatter: PageFrontmatter | string;
  content_hash: string;
  body_md: string;
  updated_at: Date | string;
}

interface PreparedPageIndex {
  page: StoredPage;
  chunks: MarkdownChunk[];
  embeddings: (number[] | null)[];
}

const WINDOWS_RESERVED_CHARS = /[<>"|?*]/;

export function assertCleanSegment(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VaultPathError(`Invalid ${label}: must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new VaultPathError(`Invalid null byte in ${label}: ${value}`);
  }
  if (value.includes(":")) {
    throw new VaultPathError(`Colon is not allowed in ${label}: ${value}`);
  }
  if (value.includes("\\")) {
    throw new VaultPathError(`Backslash is not allowed in ${label}: ${value}`);
  }
  if (WINDOWS_RESERVED_CHARS.test(value)) {
    throw new VaultPathError(`Invalid filename character in ${label}: ${value}`);
  }
}

/**
 * Validates and resolves a single `.md` file directly under `baseDir` (e.g. `vault/backlog/<id>.md`).
 */
export function resolveSingleSegmentFilePath(
  baseDir: string,
  id: string,
  label = "id",
): string {
  assertCleanSegment(id, label);
  if (id.includes("/") || id === "." || id === "..") {
    resolveSafeVaultPath(baseDir, ...id.split("/"));
    throw new VaultPathError(`Invalid ${label} path segment: ${id}`);
  }
  const filename = id.endsWith(".md") ? id : `${id}.md`;
  return resolveSafeVaultPath(baseDir, filename);
}

/**
 * Validates and resolves a nested `<subpath>/<id>.md` path under `baseDir` (e.g. `vault/ledger/<subject>/<id>.md`).
 */
export function resolveNestedFilePath(
  baseDir: string,
  subpath: string,
  id: string,
  subpathLabel = "subject",
  idLabel = "id",
): string {
  assertCleanSegment(subpath, subpathLabel);
  assertCleanSegment(id, idLabel);

  const rawSegments = subpath.split("/");
  if (rawSegments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    resolveSafeVaultPath(baseDir, ...rawSegments);
    throw new VaultPathError(`Invalid ${subpathLabel} path segments: ${subpath}`);
  }

  const subjectDir = resolveSafeVaultPath(baseDir, ...rawSegments);
  return resolveSingleSegmentFilePath(subjectDir, id, idLabel);
}

/**
 * Validates and resolves an existing canonical page slug (`<type>/<slug>`) to its `.md` path under `pagesDir`.
 */
export function resolvePageFilePath(
  pagesDir: string,
  canonicalSlug: string,
): string {
  assertCleanSegment(canonicalSlug, "slug");
  const segments = canonicalSlug.split("/");
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    resolveSafeVaultPath(pagesDir, ...segments);
    throw new VaultPathError(`Invalid page slug: ${canonicalSlug}`);
  }
  const last = segments[segments.length - 1]!;
  const filename = last.endsWith(".md") ? last : `${last}.md`;
  return resolveSafeVaultPath(pagesDir, ...segments.slice(0, -1), filename);
}

/**
 * Validates `type` and `slug` path segments against `pagesDir` using `resolveSafeVaultPath`
 * before any file creation or write occurs.
 */
function resolvePagePathAndSlug(
  pagesDir: string,
  type: string,
  slug: string,
): { filePath: string; canonicalSlug: string } {
  assertCleanSegment(type, "entity type");
  assertCleanSegment(slug, "slug");

  if (type.includes("/") || type === "." || type === "..") {
    throw new VaultPathError(`Invalid entity type path segment: ${type}`);
  }

  const typeDir = resolveSafeVaultPath(pagesDir, type);

  const rawSegments = slug.split("/");
  if (
    rawSegments.some(
      (seg) => seg === "" || seg === "." || seg === "..",
    )
  ) {
    // Pass raw segments directly to resolveSafeVaultPath so traversal errors surface uniformly.
    resolveSafeVaultPath(typeDir, ...rawSegments);
    throw new VaultPathError(`Invalid slug path segments: ${slug}`);
  }

  // Validate full raw slug segments directly under typeDir before prefix normalization.
  resolveSafeVaultPath(typeDir, ...rawSegments);

  const leafSegments =
    rawSegments.length > 1 && rawSegments[0] === type
      ? rawSegments.slice(1)
      : rawSegments;

  if (leafSegments.length === 0) {
    throw new VaultPathError(`Invalid slug: ${slug}`);
  }

  const lastSegment = leafSegments[leafSegments.length - 1]!;
  const leafWithoutExt = lastSegment.endsWith(".md")
    ? lastSegment.slice(0, -3)
    : lastSegment;
  if (!leafWithoutExt) {
    throw new VaultPathError(`Invalid empty slug filename: ${slug}`);
  }

  const normalizedLeafSegments = [
    ...leafSegments.slice(0, -1),
    leafWithoutExt,
  ];
  const fileSegments = [
    ...leafSegments.slice(0, -1),
    `${leafWithoutExt}.md`,
  ];

  const filePath = resolveSafeVaultPath(typeDir, ...fileSegments);
  const canonicalSlug = `${type}/${normalizedLeafSegments.join("/")}`;

  return { filePath, canonicalSlug };
}

/** Atomically writes content to `filePath` via a unique temporary file in the same directory + rename. */
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore temp cleanup failure
    }
    throw err;
  }
}

/** Recursively collects all `.md` files under `rootDir` in deterministic sorted order. */
export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of sorted) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function toIsoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? new Date().toISOString()
      : value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function formatVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function mapDbRowToStoredPage(row: PageDbRow, pagesDir: string): StoredPage {
  const parsedFm =
    typeof row.frontmatter === "string"
      ? (JSON.parse(row.frontmatter) as PageFrontmatter)
      : row.frontmatter;

  const slugParts = row.slug.split("/").filter(Boolean);
  const filePath =
    slugParts.length > 0
      ? path.join(
          pagesDir,
          ...slugParts.slice(0, -1),
          `${slugParts[slugParts.length - 1]}.md`,
        )
      : pagesDir;

  return {
    id: row.id,
    slug: row.slug,
    projectId: row.project_id,
    title: row.title,
    type: row.entity_type,
    schema: row.schema_pack,
    frontmatter: parsedFm,
    contentHash: row.content_hash,
    bodyMd: row.body_md,
    updatedAt: toIsoTimestamp(row.updated_at),
    filePath,
  };
}

async function loadVaultSchemaPacks(
  vaultRoot: string,
  extraPacks?: Record<string, SchemaPack>,
): Promise<Map<string, SchemaPack>> {
  const packs = new Map<string, SchemaPack>(Object.entries(BUILTIN_PACKS));

  const schemasDir = path.join(vaultRoot, "vault", "schemas");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(schemasDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      throw err;
    }
    entries = [];
  }

  for (const entry of entries) {
    if (
      entry.isFile() &&
      (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))
    ) {
      const yamlSrc = await fs.readFile(
        path.join(schemasDir, entry.name),
        "utf8",
      );
      const pack = loadSchemaPackYaml(yamlSrc);
      packs.set(pack.name, pack);
    }
  }

  if (extraPacks) {
    for (const [name, pack] of Object.entries(extraPacks)) {
      packs.set(name, pack);
    }
  }

  return packs;
}

export interface RelationDbRowInput {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  weight: number;
  evidenceRef: string | null;
  createdAt: string;
}

/** Upserts a relation edge into PGLite inside an active transaction. */
export async function upsertRelationRow(
  tx: DbTransactionClient,
  rel: RelationDbRowInput,
): Promise<void> {
  await tx.query(
    `INSERT INTO relations (
       id, source_id, target_id, relation_type, weight, evidence_ref, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       target_id = EXCLUDED.target_id,
       relation_type = EXCLUDED.relation_type,
       weight = EXCLUDED.weight,
       evidence_ref = EXCLUDED.evidence_ref`,
    [
      rel.id,
      rel.sourceId,
      rel.targetId,
      rel.relationType,
      rel.weight,
      rel.evidenceRef,
      rel.createdAt,
    ],
  );
}

/** Upserts an evidence ledger entry into PGLite inside an active transaction. */
export async function upsertEvidenceRow(
  tx: DbTransactionClient,
  entry: EvidenceEntry,
  contentHash: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO evidence_ledger (
       id, project_id, target_subject, claim_kind, statement,
       artifact_ref, verified_by, status, blocking, content_hash, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       target_subject = EXCLUDED.target_subject,
       claim_kind = EXCLUDED.claim_kind,
       statement = EXCLUDED.statement,
       artifact_ref = EXCLUDED.artifact_ref,
       verified_by = EXCLUDED.verified_by,
       status = EXCLUDED.status,
       blocking = EXCLUDED.blocking,
       content_hash = EXCLUDED.content_hash,
       created_at = EXCLUDED.created_at`,
    [
      entry.id,
      entry.projectId,
      entry.targetSubject,
      entry.claimKind,
      entry.statement,
      entry.artifactRef ?? null,
      entry.verifiedBy ?? null,
      entry.status,
      entry.blocking,
      contentHash,
      toIsoTimestamp(entry.createdAt),
    ],
  );
}

/** Upserts a requirements backlog entry into PGLite inside an active transaction. */
export async function upsertRequirementRow(
  tx: DbTransactionClient,
  req: RequirementBacklog,
  contentHash: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO requirements_backlog (
       id, project_id, parent_run_id, source_station, severity, category,
       title, description, acceptance_criteria, status, content_hash, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       parent_run_id = EXCLUDED.parent_run_id,
       source_station = EXCLUDED.source_station,
       severity = EXCLUDED.severity,
       category = EXCLUDED.category,
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       acceptance_criteria = EXCLUDED.acceptance_criteria,
       status = EXCLUDED.status,
       content_hash = EXCLUDED.content_hash,
       created_at = EXCLUDED.created_at`,
    [
      req.id,
      req.projectId,
      req.parentRunId ?? null,
      req.sourceStation,
      req.severity,
      req.category,
      req.title,
      req.description,
      JSON.stringify(req.acceptanceCriteria ?? []),
      req.status,
      contentHash,
      toIsoTimestamp(req.createdAt),
    ],
  );
}

/** Computes a deterministic relation edge ID when an edge does not explicitly supply one. */
export function deterministicRelationId(
  sourceId: string,
  targetId: string,
  relationType: string,
): string {
  return `rel-${sha256Hex(`${sourceId}|${targetId}|${relationType}`).slice(0, 20)}`;
}

/**
 * Canonical disk-first knowledge vault store backed by Git-tracked Markdown files
 * under `vault/` and an embedded or external PGLite/PostgreSQL index.
 */
export class VaultStore {
  public readonly vaultRoot: string;
  public readonly db: DbClient;
  public readonly pagesDir: string;
  public readonly ledgerDir: string;
  public readonly backlogDir: string;
  public readonly vectorDims: number;

  private readonly lockHandle: VaultLockHandle;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly packs: Map<string, SchemaPack>;
  private opQueue: Promise<void> = Promise.resolve();

  private constructor(params: {
    vaultRoot: string;
    db: DbClient;
    lockHandle: VaultLockHandle;
    vectorDims: number;
    embeddingProvider?: EmbeddingProvider;
    packs: Map<string, SchemaPack>;
  }) {
    this.vaultRoot = params.vaultRoot;
    this.db = params.db;
    this.lockHandle = params.lockHandle;
    this.vectorDims = params.vectorDims;
    this.embeddingProvider = params.embeddingProvider;
    this.packs = params.packs;
    this.pagesDir = resolveSafeVaultPath(this.vaultRoot, "vault", "pages");
    this.ledgerDir = resolveSafeVaultPath(this.vaultRoot, "vault", "ledger");
    this.backlogDir = resolveSafeVaultPath(this.vaultRoot, "vault", "backlog");
  }

  /**
   * Opens a `VaultStore` for `vaultRoot`, acquiring `<vaultRoot>/.mybrain/daemon.lock`,
   * initializing PGLite at `<vaultRoot>/.mybrain/pgdata` (unless `db` is provided),
   * and applying the Knowledge Core schema.
   */
  public static async open(options: VaultStoreOptions): Promise<VaultStore> {
    const resolvedRoot = path.resolve(options.vaultRoot);
    const metaDir = resolveSafeVaultPath(resolvedRoot, ".mybrain");
    await fs.mkdir(metaDir, { recursive: true });

    const lockPath = resolveSafeVaultPath(metaDir, "daemon.lock");
    const lockHandle = await acquireVaultLock(lockPath);

    let db: DbClient | undefined;
    try {
      const pgDataDir = resolveSafeVaultPath(metaDir, "pgdata");
      db = options.db ?? (await createPgliteClient(pgDataDir));
      const vectorDims =
        options.embeddingProvider?.dims ?? options.vectorDims ?? 768;

      await applyKnowledgeSchema(db, vectorDims);
      const packs = await loadVaultSchemaPacks(
        resolvedRoot,
        options.schemaPacks,
      );

      return new VaultStore({
        vaultRoot: resolvedRoot,
        db,
        lockHandle,
        vectorDims,
        embeddingProvider: options.embeddingProvider,
        packs,
      });
    } catch (err) {
      if (db) {
        try {
          await db.close();
        } catch {
          // Preserve original open error
        }
      }
      await lockHandle.release();
      throw err;
    }
  }

  /** Returns a loaded schema pack by name if registered on this vault. */
  public getSchemaPack(name: string): SchemaPack | undefined {
    return this.packs.get(name);
  }

  /** Serializes disk+DB mutations in-process so concurrent calls never interleave. */
  public enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Validates path safety and schema pack rules, writes `vault/pages/<type>/<slug>.md`
   * atomically via temp+rename, chunks (and optionally embeds) the body, and upserts PGLite.
   */
  public async rememberPage(input: RememberPageInput): Promise<StoredPage> {
    return this.enqueueOp(async () => {
      const { filePath, canonicalSlug } = resolvePagePathAndSlug(
        this.pagesDir,
        input.type,
        input.slug,
      );

      const packName = input.schema ?? "gbrain-base";
      const pack = this.packs.get(packName);
      if (!pack) {
        throw new SchemaValidationError(`Unknown schema pack "${packName}"`);
      }

      const existing = await this.findExistingBySlug(canonicalSlug);
      const pageId = input.id ?? existing?.id ?? randomUUID();
      const updatedAt = toIsoTimestamp(input.updatedAt);

      const candidateFm: Record<string, unknown> = {
        ...(input.extraFrontmatter ?? {}),
        id: pageId,
        slug: canonicalSlug,
        projectId: input.projectId ?? "default",
        title: input.title,
        type: input.type,
        schema: packName,
        tags: input.tags ?? [],
        relations: input.relations ?? [],
        sources: input.sources ?? [],
        updatedAt,
      };
      if (input.confidence !== undefined) {
        candidateFm.confidence = input.confidence;
      }

      const validatedFm = validateEntityAgainstPack(candidateFm, pack);
      const serialized = serializeMarkdownDocument(
        validatedFm as Record<string, unknown>,
        input.body,
      );
      const parsed = parseMarkdownDocument(serialized, PageFrontmatterSchema);

      const prepared = await this.preparePageIndex({
        frontmatter: parsed.frontmatter,
        bodyMd: parsed.body,
        contentHash: parsed.contentHash,
        canonicalSlug,
        filePath,
        updatedAt,
      });

      await atomicWriteFile(filePath, serialized);

      await this.db.transaction(async (tx) => {
        await this.upsertPageAndChunks(tx, prepared);
      });

      if (prepared.page.frontmatter.relations.length > 0 || existing !== null) {
        await this.syncRelationsFromPages();
      }

      return prepared.page;
    });
  }

  /** Looks up an indexed page by its canonical `<type>/<slug>` or unambiguous leaf slug. */
  public async getPageBySlug(slug: string): Promise<StoredPage | null> {
    const exact = await this.db.query<PageDbRow>(
      `SELECT id, slug, project_id, title, entity_type, schema_pack,
              frontmatter, content_hash, body_md, updated_at
       FROM pages
       WHERE slug = $1
       LIMIT 1`,
      [slug],
    );
    if (exact.rows[0]) {
      return mapDbRowToStoredPage(exact.rows[0], this.pagesDir);
    }

    if (!slug.includes("/")) {
      const suffixRes = await this.db.query<PageDbRow>(
        `SELECT id, slug, project_id, title, entity_type, schema_pack,
                frontmatter, content_hash, body_md, updated_at
         FROM pages
         WHERE right(slug, length($1) + 1) = '/' || $1
         ORDER BY slug ASC
         LIMIT 1`,
        [slug],
      );
      if (suffixRes.rows[0]) {
        return mapDbRowToStoredPage(suffixRes.rows[0], this.pagesDir);
      }
    }

    return null;
  }

  /**
   * Reconciles PGLite with canonical Markdown files on disk (disk wins).
   * Re-indexes modified/new files, skips unchanged hashes, and deletes orphaned DB rows.
   */
  public async syncVault(): Promise<SyncReport> {
    return this.enqueueOp(() => this.syncVaultUnlocked());
  }

  /**
   * Truncates all indexed tables and deterministically rebuilds PGLite from disk.
   */
  public async reindexVault(): Promise<SyncReport> {
    return this.enqueueOp(async () => {
      await this.db.exec(
        "TRUNCATE TABLE pages, chunks, relations, evidence_ledger, requirements_backlog CASCADE;",
      );
      return this.syncVaultUnlocked();
    });
  }

  /** Closes the underlying database client and always releases the advisory vault lock. */
  public async close(): Promise<void> {
    try {
      await this.db.close();
    } finally {
      await this.lockHandle.release();
    }
  }

  /** Composes disk-wins sync across pages, relations, evidence ledger, and requirements backlog. */
  protected async syncVaultUnlocked(): Promise<SyncReport> {
    const pagesReport = await this.syncPages();
    await this.syncRelationsFromPages();
    const ledgerReport = await this.syncEvidenceLedger();
    const backlogReport = await this.syncRequirementsBacklog();

    return {
      scanned:
        pagesReport.scanned + ledgerReport.scanned + backlogReport.scanned,
      indexed:
        pagesReport.indexed + ledgerReport.indexed + backlogReport.indexed,
      unchanged:
        pagesReport.unchanged +
        ledgerReport.unchanged +
        backlogReport.unchanged,
      deleted:
        pagesReport.deleted + ledgerReport.deleted + backlogReport.deleted,
    };
  }

  /**
   * Reconciles `relations` table from `frontmatter.relations` across all indexed `pages`.
   * Runs after `syncPages()` so all target page foreign keys already exist in `pages`.
   */
  protected async syncRelationsFromPages(): Promise<void> {
    const pageRows = await this.db.query<{
      id: string;
      slug: string;
      frontmatter: PageFrontmatter | string;
    }>(`SELECT id, slug, frontmatter FROM pages ORDER BY slug ASC`);

    const idSet = new Set<string>();
    const slugToId = new Map<string, string>();
    const leafToIds = new Map<string, string[]>();

    for (const row of pageRows.rows) {
      idSet.add(row.id);
      slugToId.set(row.slug, row.id);
      const leaf = path.posix.basename(row.slug);
      const list = leafToIds.get(leaf);
      if (list) {
        list.push(row.id);
      } else {
        leafToIds.set(leaf, [row.id]);
      }
    }

    const resolveTargetId = (ref: string): string | null => {
      if (idSet.has(ref)) return ref;
      const bySlug = slugToId.get(ref);
      if (bySlug) return bySlug;
      if (!ref.includes("/")) {
        const matches = leafToIds.get(ref);
        if (matches && matches.length === 1) {
          return matches[0]!;
        }
      }
      return null;
    };

    const desiredById = new Map<string, RelationDbRowInput>();

    for (const row of pageRows.rows) {
      const fm =
        typeof row.frontmatter === "string"
          ? (JSON.parse(row.frontmatter) as PageFrontmatter)
          : row.frontmatter;
      const edges = Array.isArray(fm?.relations) ? fm.relations : [];

      for (const edge of edges) {
        const relType = (
          (typeof edge.relationType === "string" ? edge.relationType : "") ||
          (typeof edge.type === "string" ? edge.type : "")
        ).trim();
        if (!relType) continue;

        const targetRef = (
          (typeof edge.targetId === "string" ? edge.targetId : "") ||
          (typeof edge.target === "string" ? edge.target : "")
        ).trim();
        if (!targetRef) continue;

        const targetId = resolveTargetId(targetRef);
        if (!targetId) continue;

        const edgeId =
          typeof edge.id === "string" && edge.id.trim() !== ""
            ? edge.id.trim()
            : deterministicRelationId(row.id, targetId, relType);

        const weight =
          typeof edge.weight === "number" && Number.isFinite(edge.weight)
            ? edge.weight
            : 1.0;
        const evidenceRef =
          typeof edge.evidenceRef === "string" && edge.evidenceRef.trim() !== ""
            ? edge.evidenceRef.trim()
            : null;
        const createdAt = toIsoTimestamp(
          typeof edge.createdAt === "string" ? edge.createdAt : undefined,
        );

        desiredById.set(edgeId, {
          id: edgeId,
          sourceId: row.id,
          targetId,
          relationType: relType,
          weight,
          evidenceRef,
          createdAt,
        });
      }
    }

    const existingRows = await this.db.query<{ id: string }>(
      `SELECT id FROM relations`,
    );
    const staleIds = existingRows.rows
      .map((r) => r.id)
      .filter((id) => !desiredById.has(id));

    if (staleIds.length === 0 && desiredById.size === 0) {
      return;
    }

    await this.db.transaction(async (tx) => {
      for (const staleId of staleIds) {
        await tx.query(`DELETE FROM relations WHERE id = $1`, [staleId]);
      }
      for (const rel of desiredById.values()) {
        await upsertRelationRow(tx, rel);
      }
    });
  }

  /**
   * Scans `vault/ledger/<subject>/<id>.md`, applies disk-wins sync by `content_hash`,
   * and prunes deleted rows from `evidence_ledger`.
   */
  protected async syncEvidenceLedger(): Promise<SyncReport> {
    return this.syncMarkdownCollection<EvidenceEntry>({
      dir: this.ledgerDir,
      table: "evidence_ledger",
      parseEntry: (rawFm, id, filePath) => {
        const relDir = path
          .dirname(path.relative(this.ledgerDir, filePath))
          .split(path.sep)
          .join("/");
        const fallbackSubject = relDir === "." ? "" : relDir;
        return EvidenceEntrySchema.parse({
          ...rawFm,
          id,
          ...(rawFm.targetSubject === undefined && fallbackSubject
            ? { targetSubject: fallbackSubject }
            : {}),
        });
      },
      upsert: upsertEvidenceRow,
    });
  }

  /**
   * Scans `vault/backlog/<id>.md`, applies disk-wins sync by `content_hash`,
   * and prunes deleted rows from `requirements_backlog`.
   */
  protected async syncRequirementsBacklog(): Promise<SyncReport> {
    return this.syncMarkdownCollection<RequirementBacklog>({
      dir: this.backlogDir,
      table: "requirements_backlog",
      parseEntry: (rawFm, id) =>
        RequirementBacklogSchema.parse({
          ...rawFm,
          id,
        }),
      upsert: upsertRequirementRow,
    });
  }

  private async syncMarkdownCollection<T>(opts: {
    dir: string;
    table: "evidence_ledger" | "requirements_backlog";
    parseEntry: (
      rawFm: Record<string, unknown>,
      id: string,
      filePath: string,
    ) => T;
    upsert: (
      tx: DbTransactionClient,
      entry: T,
      contentHash: string,
    ) => Promise<void>;
  }): Promise<SyncReport> {
    const diskFiles = await collectMarkdownFiles(opts.dir);
    const dbRowsRes = await this.db.query<{
      id: string;
      content_hash: string | null;
    }>(`SELECT id, content_hash FROM ${opts.table}`);

    const existingById = new Map<string, string | null>();
    for (const row of dbRowsRes.rows) {
      existingById.set(row.id, row.content_hash);
    }

    const diskPathsById = new Map<string, string>();
    const toIndex: Array<{ entry: T; contentHash: string }> = [];
    let unchanged = 0;

    for (const filePath of diskFiles) {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = parseMarkdownDocument(raw);
      const rawFm = parsed.frontmatter;
      const id =
        typeof rawFm.id === "string" && rawFm.id.trim() !== ""
          ? rawFm.id.trim()
          : path.basename(filePath, ".md");
      const conflictingPath = diskPathsById.get(id);
      if (conflictingPath !== undefined) {
        throw new Error(
          `Duplicate ${opts.table} id "${id}" detected across "${conflictingPath}" and "${filePath}"`,
        );
      }
      diskPathsById.set(id, filePath);

      const existingHash = existingById.get(id);
      if (existingHash !== undefined && existingHash === parsed.contentHash) {
        unchanged++;
        continue;
      }

      const entry = opts.parseEntry(rawFm, id, filePath);
      toIndex.push({ entry, contentHash: parsed.contentHash });
    }

    const deletedIds: string[] = [];
    for (const id of existingById.keys()) {
      if (!diskPathsById.has(id)) {
        deletedIds.push(id);
      }
    }

    if (deletedIds.length > 0 || toIndex.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const id of deletedIds) {
          await tx.query(`DELETE FROM ${opts.table} WHERE id = $1`, [id]);
        }
        for (const item of toIndex) {
          await opts.upsert(tx, item.entry, item.contentHash);
        }
      });
    }

    return {
      scanned: diskFiles.length,
      indexed: toIndex.length,
      unchanged,
      deleted: deletedIds.length,
    };
  }

  /**
   * Scans `vault/pages/*.md`, compares normalized SHA-256 `content_hash` against PGLite,
   * re-indexes new/changed pages, and removes deleted pages inside a transaction.
   */
  protected async syncPages(): Promise<SyncReport> {
    const diskFiles = await collectMarkdownFiles(this.pagesDir);
    const dbRowsRes = await this.db.query<ExistingPageRow>(
      `SELECT id, slug, content_hash FROM pages`,
    );

    const existingBySlug = new Map<string, ExistingPageRow>();
    for (const row of dbRowsRes.rows) {
      existingBySlug.set(row.slug, row);
    }

    const diskSlugs = new Set<string>();
    const toIndex: PreparedPageIndex[] = [];
    let unchanged = 0;

    for (const filePath of diskFiles) {
      const relPath = path.relative(this.pagesDir, filePath);
      const posixRel = relPath.split(path.sep).join("/");
      const canonicalSlug = posixRel.slice(0, -3); // strip ".md"
      diskSlugs.add(canonicalSlug);

      const raw = await fs.readFile(filePath, "utf8");
      const parsedRaw = parseMarkdownDocument(raw);
      const existing = existingBySlug.get(canonicalSlug);

      if (existing && existing.content_hash === parsedRaw.contentHash) {
        unchanged++;
        continue;
      }

      const rawFm = parsedRaw.frontmatter;
      const fallbackType = canonicalSlug.split("/")[0] || "note";
      const fallbackTitle = path.posix.basename(canonicalSlug);
      const resolvedType =
        typeof rawFm.type === "string" && rawFm.type.trim() !== ""
          ? rawFm.type
          : typeof rawFm.entity_type === "string" &&
              rawFm.entity_type.trim() !== ""
            ? rawFm.entity_type
            : fallbackType;
      const resolvedId =
        typeof rawFm.id === "string" && rawFm.id.trim() !== ""
          ? rawFm.id
          : (existing?.id ?? sha256Hex(canonicalSlug).slice(0, 16));
      const resolvedTitle =
        typeof rawFm.title === "string" && rawFm.title.trim() !== ""
          ? rawFm.title
          : fallbackTitle;

      const validatedFm = PageFrontmatterSchema.parse({
        ...rawFm,
        id: resolvedId,
        slug: canonicalSlug,
        title: resolvedTitle,
        type: resolvedType,
      });

      const prepared = await this.preparePageIndex({
        frontmatter: validatedFm,
        bodyMd: normalizeLineEndings(parsedRaw.body),
        contentHash: parsedRaw.contentHash,
        canonicalSlug,
        filePath,
        updatedAt: toIsoTimestamp(validatedFm.updatedAt),
      });
      toIndex.push(prepared);
    }

    const deletedSlugs: string[] = [];
    for (const slug of existingBySlug.keys()) {
      if (!diskSlugs.has(slug)) {
        deletedSlugs.push(slug);
      }
    }

    if (deletedSlugs.length > 0 || toIndex.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const slug of deletedSlugs) {
          await tx.query(`DELETE FROM pages WHERE slug = $1`, [slug]);
        }
        for (const item of toIndex) {
          await this.upsertPageAndChunks(tx, item);
        }
      });
    }

    return {
      scanned: diskFiles.length,
      indexed: toIndex.length,
      unchanged,
      deleted: deletedSlugs.length,
    };
  }

  private async findExistingBySlug(
    slug: string,
  ): Promise<ExistingPageRow | null> {
    const res = await this.db.query<ExistingPageRow>(
      `SELECT id, slug, content_hash FROM pages WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    return res.rows[0] ?? null;
  }

  private async preparePageIndex(params: {
    frontmatter: PageFrontmatter;
    bodyMd: string;
    contentHash: string;
    canonicalSlug: string;
    filePath: string;
    updatedAt: string;
  }): Promise<PreparedPageIndex> {
    const chunks = chunkMarkdown(params.bodyMd);
    let embeddings: (number[] | null)[] = chunks.map(() => null);

    if (this.embeddingProvider && chunks.length > 0) {
      const vectors = await this.embeddingProvider.embed(
        chunks.map((c) => c.content),
      );
      if (vectors.length !== chunks.length) {
        throw new Error(
          `EmbeddingProvider returned ${vectors.length} vectors for ${chunks.length} chunks`,
        );
      }
      for (const vec of vectors) {
        if (vec.length !== this.vectorDims) {
          throw new Error(
            `Embedding dimension mismatch: expected ${this.vectorDims}, got ${vec.length}`,
          );
        }
      }
      embeddings = vectors;
    }

    const page: StoredPage = {
      id: params.frontmatter.id,
      slug: params.canonicalSlug,
      projectId: params.frontmatter.projectId,
      title: params.frontmatter.title,
      type: params.frontmatter.type,
      schema: params.frontmatter.schema,
      frontmatter: params.frontmatter,
      contentHash: params.contentHash,
      bodyMd: params.bodyMd,
      updatedAt: params.updatedAt,
      filePath: params.filePath,
    };

    return { page, chunks, embeddings };
  }

  private async upsertPageAndChunks(
    tx: DbTransactionClient,
    prepared: PreparedPageIndex,
  ): Promise<void> {
    const { page, chunks, embeddings } = prepared;

    // Remove any stale row claiming the same slug under a different id
    await tx.query(`DELETE FROM pages WHERE slug = $1 AND id <> $2`, [
      page.slug,
      page.id,
    ]);

    const tsvText = [
      page.title,
      ...(page.frontmatter.tags ?? []),
      page.bodyMd,
    ]
      .filter((part) => part.trim() !== "")
      .join("\n");

    await tx.query(
      `INSERT INTO pages (
         id, slug, project_id, title, entity_type, schema_pack,
         frontmatter, content_hash, body_md, search_tsv, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8, $9, to_tsvector('english', $10), $11::timestamptz
       )
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         project_id = EXCLUDED.project_id,
         title = EXCLUDED.title,
         entity_type = EXCLUDED.entity_type,
         schema_pack = EXCLUDED.schema_pack,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         body_md = EXCLUDED.body_md,
         search_tsv = EXCLUDED.search_tsv,
         updated_at = EXCLUDED.updated_at`,
      [
        page.id,
        page.slug,
        page.projectId,
        page.title,
        page.type,
        page.schema,
        JSON.stringify(page.frontmatter),
        page.contentHash,
        page.bodyMd,
        tsvText,
        page.updatedAt,
      ],
    );

    await tx.query(`DELETE FROM chunks WHERE page_id = $1`, [page.id]);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vec = embeddings[i] ?? null;
      const vecLiteral = vec ? formatVectorLiteral(vec) : null;
      const chunkTsv = chunk.headingPath
        ? `${chunk.headingPath}\n${chunk.content}`
        : chunk.content;

      await tx.query(
        `INSERT INTO chunks (
           id, page_id, chunk_index, content, token_count, embedding, search_tsv
         )
         VALUES (
           $1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $7)
         )`,
        [
          `${page.id}#${chunk.chunkIndex}`,
          page.id,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          vecLiteral,
          chunkTsv,
        ],
      );
    }
  }
}

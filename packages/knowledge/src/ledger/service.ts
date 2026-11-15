import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  EvidenceEntrySchema,
  RequirementBacklogSchema,
  type EvidenceEntry,
  type RequirementBacklog,
} from "@mybrain/shared";
import {
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from "../markdown/frontmatter";
import {
  atomicWriteFile,
  collectMarkdownFiles,
  resolveNestedFilePath,
  resolveSingleSegmentFilePath,
  upsertEvidenceRow,
  upsertRequirementRow,
  type VaultStore,
} from "../vault/store";

/** Input payload accepted by `LedgerAndBacklogService.addEvidence`. */
export type EvidenceInput = z.input<typeof EvidenceEntrySchema>;

/** Partial update payload accepted by `updateEvidenceStatus` and `resolveEvidence`. */
export interface EvidenceUpdateInput {
  status?: EvidenceEntry["status"];
  verifiedBy?: string;
  blocking?: boolean;
  artifactRef?: string;
  statement?: string;
}

/** Filter options for `LedgerAndBacklogService.listEvidence`. */
export interface EvidenceFilter {
  projectId?: string;
  targetSubject?: string;
  claimKind?: EvidenceEntry["claimKind"];
  status?: EvidenceEntry["status"];
  blocking?: boolean;
}

/** Persisted REA evidence ledger entry with disk metadata. */
export interface StoredEvidenceEntry extends EvidenceEntry {
  contentHash: string;
  bodyMd: string;
  filePath: string;
}

/** Input payload accepted by `LedgerAndBacklogService.addRequirement`. */
export type RequirementInput = z.input<typeof RequirementBacklogSchema>;

/** Filter options for `LedgerAndBacklogService.listRequirements`. */
export interface RequirementFilter {
  projectId?: string;
  status?: RequirementBacklog["status"];
  category?: RequirementBacklog["category"];
  severity?: string;
  sourceStation?: string;
}

/** Persisted requirements backlog entry with disk metadata. */
export interface StoredRequirementBacklog extends RequirementBacklog {
  contentHash: string;
  bodyMd: string;
  filePath: string;
}

interface EvidenceDbRow {
  id: string;
  project_id: string | null;
  target_subject: string | null;
  claim_kind: EvidenceEntry["claimKind"];
  statement: string | null;
  artifact_ref: string | null;
  verified_by: string | null;
  status: EvidenceEntry["status"] | null;
  blocking: boolean;
  content_hash: string | null;
  created_at: Date | string;
}

interface RequirementDbRow {
  id: string;
  project_id: string | null;
  parent_run_id: string | null;
  source_station: string | null;
  severity: string | null;
  category: RequirementBacklog["category"];
  title: string | null;
  description: string | null;
  acceptance_criteria: string[] | string | null;
  status: RequirementBacklog["status"] | null;
  content_hash: string | null;
  created_at: Date | string;
}

function toIsoString(val: Date | string): string {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime())
      ? new Date().toISOString()
      : val.toISOString();
  }
  const parsed = Date.parse(val);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function mapEvidenceRow(row: EvidenceDbRow): EvidenceEntry {
  return {
    id: row.id,
    projectId: row.project_id ?? "default",
    targetSubject: row.target_subject ?? "",
    claimKind: row.claim_kind,
    statement: row.statement ?? "",
    ...(row.artifact_ref !== null ? { artifactRef: row.artifact_ref } : {}),
    ...(row.verified_by !== null ? { verifiedBy: row.verified_by } : {}),
    blocking: Boolean(row.blocking),
    status: row.status ?? "open",
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    createdAt: toIsoString(row.created_at),
  };
}

function mapRequirementRow(row: RequirementDbRow): RequirementBacklog {
  const criteria =
    typeof row.acceptance_criteria === "string"
      ? (JSON.parse(row.acceptance_criteria) as string[])
      : Array.isArray(row.acceptance_criteria)
        ? row.acceptance_criteria
        : [];

  return {
    id: row.id,
    projectId: row.project_id ?? "default",
    parentRunId: row.parent_run_id,
    sourceStation: row.source_station ?? "",
    severity: row.severity ?? "medium",
    category: row.category,
    title: row.title ?? "",
    description: row.description ?? "",
    acceptanceCriteria: criteria,
    status: row.status ?? "open",
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    createdAt: toIsoString(row.created_at),
  };
}

function omitContentHash<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const copy = { ...obj };
  delete copy.contentHash;
  return copy;
}

async function findMarkdownFileById(
  rootDir: string,
  expectedPath: string | null,
  id: string,
): Promise<string | null> {
  if (expectedPath) {
    try {
      await fs.access(expectedPath);
      return expectedPath;
    } catch {
      // Fall back to recursive scan below
    }
  }

  const files = await collectMarkdownFiles(rootDir);
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseMarkdownDocument(raw);
    const fmId =
      typeof parsed.frontmatter.id === "string" &&
      parsed.frontmatter.id.trim() !== ""
        ? parsed.frontmatter.id.trim()
        : path.basename(filePath, ".md");
    if (fmId === id) {
      return filePath;
    }
  }

  return null;
}

/**
 * Vault-canonical service for the REA Evidence Ledger (`vault/ledger/`)
 * and Requirements Backlog (`vault/backlog/`).
 */
export class LedgerAndBacklogService {
  private readonly store: VaultStore;

  constructor(store: VaultStore) {
    this.store = store;
  }

  /**
   * Validates an `EvidenceEntry` via `EvidenceEntrySchema`, validates safe vault path,
   * writes `vault/ledger/<safeSubject>/<safeId>.md` atomically, and upserts `evidence_ledger`.
   */
  public async addEvidence(
    entry: EvidenceInput,
    body?: string,
  ): Promise<StoredEvidenceEntry> {
    return this.store.enqueueOp(async () => {
      const validated = EvidenceEntrySchema.parse(entry);
      const filePath = resolveNestedFilePath(
        this.store.ledgerDir,
        validated.targetSubject,
        validated.id,
        "targetSubject",
        "evidence id",
      );

      const bodyText =
        body ?? `# ${validated.id} (${validated.claimKind})\n\n${validated.statement}\n`;
      const serialized = serializeMarkdownDocument(
        omitContentHash(validated),
        bodyText,
      );
      const parsed = parseMarkdownDocument(serialized, EvidenceEntrySchema);

      await atomicWriteFile(filePath, serialized);

      await this.store.db.transaction(async (tx) => {
        await upsertEvidenceRow(tx, parsed.frontmatter, parsed.contentHash);
      });

      return {
        ...parsed.frontmatter,
        contentHash: parsed.contentHash,
        bodyMd: parsed.body,
        filePath,
      };
    });
  }

  /**
   * Updates status/verification fields of an existing evidence ledger entry on disk
   * and synchronizes `evidence_ledger` in PGLite.
   */
  public async updateEvidenceStatus(
    id: string,
    updates: EvidenceUpdateInput,
  ): Promise<StoredEvidenceEntry> {
    return this.store.enqueueOp(async () => {
      const dbRow = await this.store.db.query<{ target_subject: string | null }>(
        `SELECT target_subject FROM evidence_ledger WHERE id = $1 LIMIT 1`,
        [id],
      );
      const expectedSubject = dbRow.rows[0]?.target_subject;
      const expectedPath = expectedSubject
        ? resolveNestedFilePath(
            this.store.ledgerDir,
            expectedSubject,
            id,
            "targetSubject",
            "evidence id",
          )
        : null;

      const filePath = await findMarkdownFileById(
        this.store.ledgerDir,
        expectedPath,
        id,
      );
      if (!filePath) {
        throw new Error(`Evidence entry not found: ${id}`);
      }

      const raw = await fs.readFile(filePath, "utf8");
      const existing = parseMarkdownDocument(raw, EvidenceEntrySchema);

      const merged: Record<string, unknown> = {
        ...existing.frontmatter,
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.verifiedBy !== undefined
          ? { verifiedBy: updates.verifiedBy }
          : {}),
        ...(updates.blocking !== undefined
          ? { blocking: updates.blocking }
          : {}),
        ...(updates.artifactRef !== undefined
          ? { artifactRef: updates.artifactRef }
          : {}),
        ...(updates.statement !== undefined
          ? { statement: updates.statement }
          : {}),
      };

      const validated = EvidenceEntrySchema.parse(merged);
      const serialized = serializeMarkdownDocument(
        omitContentHash(validated),
        existing.body,
      );
      const parsedWritten = parseMarkdownDocument(
        serialized,
        EvidenceEntrySchema,
      );

      await atomicWriteFile(filePath, serialized);

      await this.store.db.transaction(async (tx) => {
        await upsertEvidenceRow(
          tx,
          parsedWritten.frontmatter,
          parsedWritten.contentHash,
        );
      });

      return {
        ...parsedWritten.frontmatter,
        contentHash: parsedWritten.contentHash,
        bodyMd: parsedWritten.body,
        filePath,
      };
    });
  }

  /**
   * Convenience wrapper that resolves an evidence entry (defaulting `status` to `"resolved"`).
   */
  public async resolveEvidence(
    id: string,
    updates: Omit<EvidenceUpdateInput, "status"> & {
      status?: EvidenceEntry["status"];
    } = {},
  ): Promise<StoredEvidenceEntry> {
    return this.updateEvidenceStatus(id, {
      ...updates,
      status: updates.status ?? "resolved",
    });
  }

  /**
   * Lists evidence ledger entries filtered by optional project, subject, claimKind, status, or blocking flag.
   */
  public async listEvidence(
    filter: EvidenceFilter = {},
  ): Promise<EvidenceEntry[]> {
    const res = await this.store.db.query<EvidenceDbRow>(
      `SELECT id, project_id, target_subject, claim_kind, statement,
              artifact_ref, verified_by, status, blocking, content_hash, created_at
       FROM evidence_ledger
       WHERE ($1::text IS NULL OR project_id = $1)
         AND ($2::text IS NULL OR target_subject = $2)
         AND ($3::text IS NULL OR claim_kind = $3)
         AND ($4::text IS NULL OR status = $4)
         AND ($5::boolean IS NULL OR blocking = $5)
       ORDER BY created_at ASC, id ASC`,
      [
        filter.projectId ?? null,
        filter.targetSubject ?? null,
        filter.claimKind ?? null,
        filter.status ?? null,
        filter.blocking ?? null,
      ],
    );

    return res.rows.map(mapEvidenceRow);
  }

  /**
   * Returns all open, blocking `unknown` claims for `subject`
   * (`target_subject = $1 AND claim_kind = 'unknown' AND blocking = TRUE AND status = 'open'`).
   */
  public async getBlockingUnknowns(
    subject: string,
    projectId?: string,
  ): Promise<EvidenceEntry[]> {
    const res = await this.store.db.query<EvidenceDbRow>(
      `SELECT id, project_id, target_subject, claim_kind, statement,
              artifact_ref, verified_by, status, blocking, content_hash, created_at
       FROM evidence_ledger
       WHERE target_subject = $1
         AND claim_kind = 'unknown'
         AND blocking = TRUE
         AND status = 'open'
         AND ($2::text IS NULL OR project_id = $2)
       ORDER BY created_at ASC, id ASC`,
      [subject, projectId ?? null],
    );

    return res.rows.map(mapEvidenceRow);
  }

  /**
   * Validates a requirement via `RequirementBacklogSchema`, writes `vault/backlog/<safeId>.md`
   * atomically, and upserts `requirements_backlog` in PGLite.
   */
  public async addRequirement(
    req: RequirementInput,
    body?: string,
  ): Promise<StoredRequirementBacklog> {
    return this.store.enqueueOp(async () => {
      const validated = RequirementBacklogSchema.parse(req);
      const filePath = resolveSingleSegmentFilePath(
        this.store.backlogDir,
        validated.id,
        "requirement id",
      );

      const bodyText =
        body ?? `# ${validated.title}\n\n${validated.description}\n`;
      const serialized = serializeMarkdownDocument(
        omitContentHash(validated),
        bodyText,
      );
      const parsed = parseMarkdownDocument(
        serialized,
        RequirementBacklogSchema,
      );

      await atomicWriteFile(filePath, serialized);

      await this.store.db.transaction(async (tx) => {
        await upsertRequirementRow(tx, parsed.frontmatter, parsed.contentHash);
      });

      return {
        ...parsed.frontmatter,
        contentHash: parsed.contentHash,
        bodyMd: parsed.body,
        filePath,
      };
    });
  }

  /**
   * Lists requirements backlog entries filtered by optional project, status, category, severity, or station.
   */
  public async listRequirements(
    filter: RequirementFilter = {},
  ): Promise<RequirementBacklog[]> {
    const res = await this.store.db.query<RequirementDbRow>(
      `SELECT id, project_id, parent_run_id, source_station, severity, category,
              title, description, acceptance_criteria, status, content_hash, created_at
       FROM requirements_backlog
       WHERE ($1::text IS NULL OR project_id = $1)
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR category = $3)
         AND ($4::text IS NULL OR severity = $4)
         AND ($5::text IS NULL OR source_station = $5)
       ORDER BY created_at ASC, id ASC`,
      [
        filter.projectId ?? null,
        filter.status ?? null,
        filter.category ?? null,
        filter.severity ?? null,
        filter.sourceStation ?? null,
      ],
    );

    return res.rows.map(mapRequirementRow);
  }

  /**
   * Updates the status of an existing requirement in `vault/backlog/<id>.md`
   * and synchronizes `requirements_backlog` in PGLite.
   */
  public async updateRequirementStatus(
    id: string,
    status: RequirementBacklog["status"],
  ): Promise<StoredRequirementBacklog> {
    const validatedStatus = RequirementBacklogSchema.shape.status.parse(status);

    return this.store.enqueueOp(async () => {
      const expectedPath = resolveSingleSegmentFilePath(
        this.store.backlogDir,
        id,
        "requirement id",
      );
      const filePath = await findMarkdownFileById(
        this.store.backlogDir,
        expectedPath,
        id,
      );
      if (!filePath) {
        throw new Error(`Requirement not found: ${id}`);
      }

      const raw = await fs.readFile(filePath, "utf8");
      const existing = parseMarkdownDocument(raw, RequirementBacklogSchema);
      const validated = RequirementBacklogSchema.parse({
        ...existing.frontmatter,
        status: validatedStatus,
      });

      const serialized = serializeMarkdownDocument(
        omitContentHash(validated),
        existing.body,
      );
      const parsedWritten = parseMarkdownDocument(
        serialized,
        RequirementBacklogSchema,
      );

      await atomicWriteFile(filePath, serialized);

      await this.store.db.transaction(async (tx) => {
        await upsertRequirementRow(
          tx,
          parsedWritten.frontmatter,
          parsedWritten.contentHash,
        );
      });

      return {
        ...parsedWritten.frontmatter,
        contentHash: parsedWritten.contentHash,
        bodyMd: parsedWritten.body,
        filePath,
      };
    });
  }
}

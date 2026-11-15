import { describe, expect, test } from "bun:test";
import {
  EvidenceEntrySchema,
  PageFrontmatterSchema,
  RelationEdgeSchema,
  RequirementBacklogSchema,
  SchemaPackSchema,
  type EmbeddingProvider,
} from "../src/schemas";

describe("Zod Contracts & Schemas", () => {
  describe("EvidenceEntrySchema", () => {
    test("validates valid observation entry with defaults", () => {
      const entry = EvidenceEntrySchema.parse({
        id: "OBS-01",
        targetSubject: "gbrain",
        claimKind: "observation",
        statement: "Uses Bun and PGLite",
        createdAt: "2026-11-15T00:00:00.000Z",
      });

      expect(entry.id).toBe("OBS-01");
      expect(entry.projectId).toBe("default");
      expect(entry.claimKind).toBe("observation");
      expect(entry.blocking).toBe(false);
      expect(entry.status).toBe("open");
      expect(entry.statement).toBe("Uses Bun and PGLite");
    });

    test("accepts valid claimKind: observation | inference | unknown", () => {
      for (const kind of ["observation", "inference", "unknown"] as const) {
        const parsed = EvidenceEntrySchema.parse({
          id: `test-${kind}`,
          targetSubject: "test",
          claimKind: kind,
          statement: "test statement",
          createdAt: "2026-11-15T00:00:00.000Z",
        });
        expect(parsed.claimKind).toBe(kind);
      }
    });

    test("rejects invalid claimKind", () => {
      expect(() =>
        EvidenceEntrySchema.parse({
          id: "INV-01",
          targetSubject: "test",
          claimKind: "speculation",
          statement: "not allowed",
          createdAt: "2026-11-15T00:00:00.000Z",
        }),
      ).toThrow();
    });

    test("accepts valid status: open | verified | resolved, rejects invalid", () => {
      for (const st of ["open", "verified", "resolved"] as const) {
        const parsed = EvidenceEntrySchema.parse({
          id: `test-${st}`,
          targetSubject: "test",
          claimKind: "observation",
          statement: "test",
          status: st,
          createdAt: "2026-11-15T00:00:00.000Z",
        });
        expect(parsed.status).toBe(st);
      }

      expect(() =>
        EvidenceEntrySchema.parse({
          id: "test-bad",
          targetSubject: "test",
          claimKind: "observation",
          statement: "test",
          status: "closed",
          createdAt: "2026-11-15T00:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("RequirementBacklogSchema", () => {
    test("validates valid requirement backlog entry with defaults", () => {
      const entry = RequirementBacklogSchema.parse({
        id: "REQ-01",
        sourceStation: "review",
        severity: "high",
        category: "blocking_bug",
        title: "Fix advisory lock release race",
        description: "Advisory lockfile must unlink atomically",
        acceptanceCriteria: ["Tests verify contention", "Release reclaims stale PID"],
        createdAt: "2026-11-15T00:00:00.000Z",
      });

      expect(entry.id).toBe("REQ-01");
      expect(entry.projectId).toBe("default");
      expect(entry.status).toBe("open");
      expect(entry.category).toBe("blocking_bug");
      expect(entry.acceptanceCriteria.length).toBe(2);
    });

    test("accepts valid categories: blocking_bug | edge_case | tech_debt | hardening_rule | skill_gap", () => {
      const categories = [
        "blocking_bug",
        "edge_case",
        "tech_debt",
        "hardening_rule",
        "skill_gap",
      ] as const;

      for (const cat of categories) {
        const parsed = RequirementBacklogSchema.parse({
          id: `req-${cat}`,
          sourceStation: "scout",
          severity: "medium",
          category: cat,
          title: `Category test ${cat}`,
          description: "description",
          acceptanceCriteria: ["criterion 1"],
          createdAt: "2026-11-15T00:00:00.000Z",
        });
        expect(parsed.category).toBe(cat);
      }
    });

    test("rejects invalid category", () => {
      expect(() =>
        RequirementBacklogSchema.parse({
          id: "req-invalid",
          sourceStation: "scout",
          severity: "low",
          category: "feature_request",
          title: "Invalid category",
          description: "description",
          acceptanceCriteria: ["criterion 1"],
          createdAt: "2026-11-15T00:00:00.000Z",
        }),
      ).toThrow();
    });

    test("accepts valid status: open | promoted | resolved | wontfix, rejects invalid", () => {
      for (const st of ["open", "promoted", "resolved", "wontfix"] as const) {
        const parsed = RequirementBacklogSchema.parse({
          id: `req-${st}`,
          sourceStation: "scout",
          severity: "low",
          category: "edge_case",
          title: `Status test ${st}`,
          description: "description",
          acceptanceCriteria: ["criterion 1"],
          status: st,
          createdAt: "2026-11-15T00:00:00.000Z",
        });
        expect(parsed.status).toBe(st);
      }

      expect(() =>
        RequirementBacklogSchema.parse({
          id: "req-bad-status",
          sourceStation: "scout",
          severity: "low",
          category: "edge_case",
          title: "Bad status",
          description: "description",
          acceptanceCriteria: ["criterion 1"],
          status: "abandoned",
          createdAt: "2026-11-15T00:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("PageFrontmatterSchema & RelationEdgeSchema", () => {
    test("validates minimal frontmatter with default values", () => {
      const fm = PageFrontmatterSchema.parse({
        id: "p1",
        title: "Trust Engineering",
        type: "concept",
      });

      expect(fm.id).toBe("p1");
      expect(fm.title).toBe("Trust Engineering");
      expect(fm.type).toBe("concept");
      expect(fm.projectId).toBe("default");
      expect(fm.schema).toBe("gbrain-base");
      expect(fm.tags).toEqual([]);
      expect(fm.relations).toEqual([]);
      expect(fm.sources).toEqual([]);
    });

    test("validates relations using RelationEdgeSchema", () => {
      const edge = RelationEdgeSchema.parse({
        targetId: "p2",
        relationType: "implements",
        weight: 0.9,
      });

      expect(edge.targetId).toBe("p2");
      expect(edge.relationType).toBe("implements");
      expect(edge.weight).toBe(0.9);

      const fm = PageFrontmatterSchema.parse({
        id: "p1",
        title: "Architecture",
        type: "concept",
        relations: [edge, { target: "p3", type: "relates_to" }],
      });
      expect(fm.relations.length).toBe(2);
    });
  });

  describe("SchemaPackSchema", () => {
    test("validates schema pack with list entityTypes", () => {
      const pack = SchemaPackSchema.parse({
        name: "gbrain-base",
        version: "0.1.0",
        entityTypes: ["concept", "pattern", "reference"],
        relationTypes: ["relates_to", "depends_on"],
      });
      expect(pack.name).toBe("gbrain-base");
      expect(pack.version).toBe("0.1.0");
    });

    test("validates schema pack with map entityTypes", () => {
      const pack = SchemaPackSchema.parse({
        name: "software-factory",
        version: "0.1.0",
        entityTypes: {
          spec: { requiredFrontmatter: ["title", "type"] },
          plan: { requiredFrontmatter: ["title", "type"] },
          bug: { requiredFrontmatter: ["title", "type", "severity"] },
        },
        relationTypes: ["blocks", "implements", "generated_by", "evidenced_by"],
      });
      expect(pack.name).toBe("software-factory");
    });
  });

  describe("EmbeddingProvider interface", () => {
    test("implements EmbeddingProvider contract cleanly", async () => {
      const provider: EmbeddingProvider = {
        dims: 3,
        async embed(texts: string[]) {
          return texts.map(() => [0.1, 0.2, 0.3]);
        },
      };

      expect(provider.dims).toBe(3);
      const vectors = await provider.embed(["hello", "world"]);
      expect(vectors).toEqual([
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3],
      ]);
    });
  });
});

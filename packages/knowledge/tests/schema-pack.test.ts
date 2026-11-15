import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PACKS,
  SchemaValidationError,
  loadSchemaPackYaml,
  validateEntityAgainstPack,
  validateRelationAgainstPack,
} from "../src/schema-pack/loader";

describe("Schema Pack Loader & Entity/Relation Validation", () => {
  describe("loadSchemaPackYaml", () => {
    test("parses valid YAML with array entityTypes into SchemaPack", () => {
      const yaml = `
name: custom-pack
version: 1.0.0
entityTypes:
  - doc
  - guide
relationTypes:
  - references
  - extends
`;
      const pack = loadSchemaPackYaml(yaml);
      expect(pack.name).toBe("custom-pack");
      expect(pack.version).toBe("1.0.0");
      expect(pack.entityTypes).toEqual(["doc", "guide"]);
      expect(pack.relationTypes).toEqual(["references", "extends"]);
    });

    test("parses valid YAML with map entityTypes and requiredFrontmatter", () => {
      const yaml = `
name: domain-pack
version: 0.2.0
entityTypes:
  service:
    description: "Microservice definition"
    requiredFrontmatter:
      - owner
      - tier
relationTypes:
  - calls
requiredFrontmatter:
  - domain
`;
      const pack = loadSchemaPackYaml(yaml);
      expect(pack.name).toBe("domain-pack");
      expect(pack.relationTypes).toEqual(["calls"]);
      expect(pack.requiredFrontmatter).toEqual(["domain"]);
      expect(typeof pack.entityTypes).toBe("object");
    });

    test("throws SchemaValidationError for invalid YAML syntax", () => {
      const invalidYaml = `
name: bad-syntax
  entityTypes: [
`;
      expect(() => loadSchemaPackYaml(invalidYaml)).toThrow(SchemaValidationError);
    });

    test("throws SchemaValidationError for YAML failing SchemaPackSchema validation", () => {
      const missingName = `
version: 1.0.0
entityTypes:
  - concept
`;
      expect(() => loadSchemaPackYaml(missingName)).toThrow(SchemaValidationError);
    });
  });

  describe("BUILTIN_PACKS", () => {
    test("contains gbrain-base pack with required entity and relation types", () => {
      const base = BUILTIN_PACKS["gbrain-base"];
      expect(base).toBeDefined();
      expect(base?.name).toBe("gbrain-base");

      // Verify gbrain-base entity types: concept, entity, note, project
      const entityTypes = Array.isArray(base?.entityTypes)
        ? (base.entityTypes as string[])
        : Object.keys(base?.entityTypes ?? {});
      expect(entityTypes).toContain("concept");
      expect(entityTypes).toContain("entity");
      expect(entityTypes).toContain("note");
      expect(entityTypes).toContain("project");

      // Verify gbrain-base relation types
      expect(base?.relationTypes).toContain("depends_on");
      expect(base?.relationTypes).toContain("relates_to");
      expect(base?.relationTypes).toContain("supersedes");
    });

    test("contains software-factory pack with required entity and relation types", () => {
      const factory = BUILTIN_PACKS["software-factory"];
      expect(factory).toBeDefined();
      expect(factory?.name).toBe("software-factory");

      const entityTypes = Array.isArray(factory?.entityTypes)
        ? (factory.entityTypes as string[])
        : Object.keys(factory?.entityTypes ?? {});
      expect(entityTypes).toContain("spec");
      expect(entityTypes).toContain("plan");
      expect(entityTypes).toContain("bug");
      expect(entityTypes).toContain("requirement");
      expect(entityTypes).toContain("skill");
      expect(entityTypes).toContain("incident");
      expect(entityTypes).toContain("station_run");

      expect(factory?.relationTypes).toContain("blocks");
      expect(factory?.relationTypes).toContain("implements");
      expect(factory?.relationTypes).toContain("generated_by");
      expect(factory?.relationTypes).toContain("evidenced_by");
      expect(factory?.relationTypes).toContain("depends_on");
      expect(factory?.relationTypes).toContain("relates_to");
      expect(factory?.relationTypes).toContain("supersedes");
    });
  });

  describe("validateEntityAgainstPack", () => {
    test("accepts concept entity under gbrain-base pack", () => {
      const base = BUILTIN_PACKS["gbrain-base"]!;
      const fm = {
        id: "concept-trust",
        title: "Trust Engineering",
        type: "concept",
      };
      const validated = validateEntityAgainstPack(fm, base);
      expect(validated.id).toBe("concept-trust");
      expect(validated.type).toBe("concept");
      expect(validated.projectId).toBe("default");
    });

    test("accepts entity with entity_type alias under gbrain-base pack", () => {
      const base = BUILTIN_PACKS["gbrain-base"]!;
      const fm = {
        id: "entity-pglite",
        title: "PGLite Embedded",
        entity_type: "entity",
      };
      const validated = validateEntityAgainstPack(fm, base);
      expect(validated.type).toBe("entity");
    });

    test("throws SchemaValidationError for unknown entity type under gbrain-base", () => {
      const base = BUILTIN_PACKS["gbrain-base"]!;
      const fm = {
        id: "unknown-1",
        title: "Unknown Entity",
        type: "unknown_entity_type",
      };
      expect(() => validateEntityAgainstPack(fm, base)).toThrow(SchemaValidationError);
    });

    test("accepts all software-factory entities under software-factory pack", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      const types = ["spec", "plan", "bug", "requirement", "skill", "incident", "station_run"];
      for (const t of types) {
        const validated = validateEntityAgainstPack(
          { id: `id-${t}`, title: `Title ${t}`, type: t },
          factory,
        );
        expect(validated.type).toBe(t);
      }
    });

    test("enforces pack-level and entity-level requiredFrontmatter", () => {
      const yaml = `
name: strict-pack
version: 1.0.0
entityTypes:
  service:
    requiredFrontmatter:
      - owner
relationTypes:
  - calls
requiredFrontmatter:
  - domain
`;
      const pack = loadSchemaPackYaml(yaml);

      // Missing domain (pack-level)
      expect(() =>
        validateEntityAgainstPack(
          { id: "s1", title: "Service", type: "service", owner: "infra" },
          pack,
        ),
      ).toThrow(SchemaValidationError);

      // Missing owner (entity-level)
      expect(() =>
        validateEntityAgainstPack(
          { id: "s1", title: "Service", type: "service", domain: "billing" },
          pack,
        ),
      ).toThrow(SchemaValidationError);

      // Both present -> valid
      const valid = validateEntityAgainstPack(
        { id: "s1", title: "Service", type: "service", domain: "billing", owner: "infra" },
        pack,
      );
      expect(valid.type).toBe("service");
      expect((valid as any).owner).toBe("infra");
    });

    test("validates relation edges inside frontmatter against pack relationTypes", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      // Valid relation
      const valid = validateEntityAgainstPack(
        {
          id: "plan-1",
          title: "Plan",
          type: "plan",
          relations: [{ targetId: "spec-1", relationType: "implements" }],
        },
        factory,
      );
      expect(valid.relations).toHaveLength(1);

      // Invalid relation type
      expect(() =>
        validateEntityAgainstPack(
          {
            id: "plan-1",
            title: "Plan",
            type: "plan",
            relations: [{ targetId: "spec-1", relationType: "invalid_rel" }],
          },
          factory,
        ),
      ).toThrow(SchemaValidationError);
    });

    test("throws SchemaValidationError for malformed non-object frontmatter", () => {
      const base = BUILTIN_PACKS["gbrain-base"]!;
      expect(() => validateEntityAgainstPack(null, base)).toThrow(SchemaValidationError);
      expect(() => validateEntityAgainstPack("not an object", base)).toThrow(SchemaValidationError);
    });

    test("Finding 1: defaults schema to pack.name when omitted and rejects schema mismatch", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      // When schema is omitted, schema must not drift to "gbrain-base"
      const validated = validateEntityAgainstPack(
        { id: "spec-1", title: "Specification", type: "spec" },
        factory,
      );
      expect(validated.schema).toBe("software-factory");

      // When matching schema is explicitly provided
      const explicit = validateEntityAgainstPack(
        { id: "spec-2", title: "Spec 2", type: "spec", schema: "software-factory" },
        factory,
      );
      expect(explicit.schema).toBe("software-factory");

      // When conflicting schema is provided, reject
      expect(() =>
        validateEntityAgainstPack(
          { id: "spec-3", title: "Spec 3", type: "spec", schema: "gbrain-base" },
          factory,
        ),
      ).toThrow(SchemaValidationError);
    });

    test("Finding 2: handles empty relationType fallback to type and delegates relation validation", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      // Empty relationType should fall back to type: "implements" and succeed
      const valid = validateEntityAgainstPack(
        {
          id: "plan-1",
          title: "Plan",
          type: "plan",
          relations: [{ targetId: "spec-1", relationType: "", type: "implements" }],
        },
        factory,
      );
      expect(valid.relations).toHaveLength(1);

      // Empty relationType falling back to invalid type should throw
      expect(() =>
        validateEntityAgainstPack(
          {
            id: "plan-2",
            title: "Plan 2",
            type: "plan",
            relations: [{ targetId: "spec-1", relationType: "", type: "invalid_rel" }],
          },
          factory,
        ),
      ).toThrow(SchemaValidationError);

      // Edge with whitespace-only relation should throw
      expect(() =>
        validateEntityAgainstPack(
          {
            id: "plan-3",
            title: "Plan 3",
            type: "plan",
            relations: [{ targetId: "spec-1", relationType: "   ", type: "   " }],
          },
          factory,
        ),
      ).toThrow(SchemaValidationError);
    });
  });

  describe("validateRelationAgainstPack", () => {
    test("accepts valid relations under software-factory pack", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      const validRelations = [
        "blocks",
        "implements",
        "generated_by",
        "evidenced_by",
        "depends_on",
        "relates_to",
        "supersedes",
      ];
      for (const rel of validRelations) {
        expect(validateRelationAgainstPack(rel, factory)).toBe(true);
      }
    });

    test("rejects invalid relation names under software-factory pack", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      expect(() => validateRelationAgainstPack("loves", factory)).toThrow(SchemaValidationError);
      expect(() => validateRelationAgainstPack("owns", factory)).toThrow(SchemaValidationError);
      expect(() => validateRelationAgainstPack("random_relation", factory)).toThrow(
        SchemaValidationError,
      );
    });

    test("rejects empty or whitespace-only relation types", () => {
      const factory = BUILTIN_PACKS["software-factory"]!;
      expect(() => validateRelationAgainstPack("", factory)).toThrow(SchemaValidationError);
      expect(() => validateRelationAgainstPack("   ", factory)).toThrow(SchemaValidationError);
      expect(() => validateRelationAgainstPack(null as any, factory)).toThrow(SchemaValidationError);
    });
  });
});

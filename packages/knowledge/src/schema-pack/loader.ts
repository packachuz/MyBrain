import yaml from "yaml";
import {
  PageFrontmatterSchema,
  SchemaPackSchema,
  type EntityTypeDefinition,
  type PageFrontmatter,
  type SchemaPack,
} from "@mybrain/shared";

/**
 * Custom error thrown when schema pack or entity/relation validation fails.
 */
export class SchemaValidationError extends Error {
  public readonly issues?: unknown[];

  constructor(message: string, issues?: unknown[]) {
    super(message);
    this.name = "SchemaValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, SchemaValidationError.prototype);
  }
}

/**
 * Extract map of allowed entity types and their definitions from a SchemaPack.
 */
export function getPackEntityTypeMap(
  pack: SchemaPack,
): Map<string, EntityTypeDefinition | null> {
  const map = new Map<string, EntityTypeDefinition | null>();
  if (Array.isArray(pack.entityTypes)) {
    for (const item of pack.entityTypes) {
      if (typeof item === "string") {
        map.set(item, null);
      } else if (
        item &&
        typeof item === "object" &&
        typeof item.name === "string"
      ) {
        map.set(item.name, item);
      }
    }
  } else if (pack.entityTypes && typeof pack.entityTypes === "object") {
    for (const [key, value] of Object.entries(pack.entityTypes)) {
      map.set(key, value as EntityTypeDefinition | null);
    }
  }
  return map;
}

/**
 * Built-in schema packs for MyBrain knowledge vault and software factory.
 */
export const BUILTIN_PACKS: Readonly<Record<string, SchemaPack>> = Object.freeze(
  {
    "gbrain-base": SchemaPackSchema.parse({
      name: "gbrain-base",
      version: "0.1.0",
      entityTypes: [
        "concept",
        "entity",
        "note",
        "project",
        "guide",
        "pattern",
        "topic",
      ],
      relationTypes: [
        "depends_on",
        "relates_to",
        "supersedes",
        "implements",
        "evidenced_by",
        "blocks",
        "generated_by",
      ],
      requiredFrontmatter: ["title", "type"],
    }),
    "software-factory": SchemaPackSchema.parse({
      name: "software-factory",
      version: "0.1.0",
      entityTypes: [
        "spec",
        "plan",
        "bug",
        "requirement",
        "skill",
        "incident",
        "station_run",
      ],
      relationTypes: [
        "blocks",
        "implements",
        "generated_by",
        "evidenced_by",
        "depends_on",
        "relates_to",
        "supersedes",
      ],
      requiredFrontmatter: ["title", "type"],
    }),
  },
);

/**
 * Parses raw YAML source string into a validated SchemaPack.
 *
 * @param src YAML content of the schema pack manifest
 * @returns Validated SchemaPack
 * @throws SchemaValidationError if YAML parsing or SchemaPackSchema validation fails
 */
export function loadSchemaPackYaml(src: string): SchemaPack {
  let parsed: unknown;
  try {
    parsed = yaml.parse(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaValidationError(`Failed to parse schema pack YAML: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new SchemaValidationError(
      "Schema pack YAML must parse to a non-empty object",
    );
  }

  const result = SchemaPackSchema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(
      `Schema pack validation failed: ${result.error.message}`,
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * Validates page frontmatter against a SchemaPack's entity types, required fields, and relation types.
 *
 * @param fm Frontmatter object or PageFrontmatter candidate
 * @param pack SchemaPack to validate against
 * @returns Fully validated and normalized PageFrontmatter
 * @throws SchemaValidationError if validation fails
 */
export function validateEntityAgainstPack(
  fm: unknown,
  pack: SchemaPack,
): PageFrontmatter {
  if (!fm || typeof fm !== "object") {
    throw new SchemaValidationError("Frontmatter must be a non-null object");
  }

  const raw = fm as Record<string, unknown>;
  const effectiveType = (raw.type ?? raw.entity_type) as string | undefined;

  if (!effectiveType || typeof effectiveType !== "string") {
    throw new SchemaValidationError(
      "Entity frontmatter must specify a string 'type' or 'entity_type'",
    );
  }

  const entityTypeMap = getPackEntityTypeMap(pack);
  if (!entityTypeMap.has(effectiveType)) {
    throw new SchemaValidationError(
      `Unknown entity type "${effectiveType}" in schema pack "${pack.name}"`,
    );
  }

  const candidate = {
    ...raw,
    type: effectiveType,
  };

  const parseResult = PageFrontmatterSchema.safeParse(candidate);
  if (!parseResult.success) {
    throw new SchemaValidationError(
      `Page frontmatter validation failed: ${parseResult.error.message}`,
      parseResult.error.issues,
    );
  }

  const validated = parseResult.data;

  // Check pack-level required frontmatter
  if (pack.requiredFrontmatter && Array.isArray(pack.requiredFrontmatter)) {
    for (const field of pack.requiredFrontmatter) {
      const val = (candidate as Record<string, unknown>)[field];
      if (val === undefined || val === null) {
        throw new SchemaValidationError(
          `Missing required frontmatter field "${field}" for schema pack "${pack.name}"`,
        );
      }
    }
  }

  // Check entity-level required frontmatter
  const entityDef = entityTypeMap.get(effectiveType);
  if (
    entityDef &&
    typeof entityDef === "object" &&
    Array.isArray(entityDef.requiredFrontmatter)
  ) {
    for (const field of entityDef.requiredFrontmatter) {
      const val = (candidate as Record<string, unknown>)[field];
      if (val === undefined || val === null) {
        throw new SchemaValidationError(
          `Missing required frontmatter field "${field}" for entity type "${effectiveType}" in schema pack "${pack.name}"`,
        );
      }
    }
  }

  // Validate relation edges if specified
  if (
    validated.relations &&
    validated.relations.length > 0 &&
    pack.relationTypes &&
    pack.relationTypes.length > 0
  ) {
    for (const edge of validated.relations) {
      const relType = edge.relationType ?? edge.type;
      if (relType && !pack.relationTypes.includes(relType)) {
        throw new SchemaValidationError(
          `Unknown relation type "${relType}" on entity in schema pack "${pack.name}"`,
        );
      }
    }
  }

  return validated;
}

/**
 * Validates whether a relation type name is allowed under a SchemaPack.
 *
 * @param relType Relation type name (e.g. 'blocks', 'implements')
 * @param pack SchemaPack to check against
 * @returns true if valid
 * @throws SchemaValidationError if invalid or disallowed
 */
export function validateRelationAgainstPack(
  relType: unknown,
  pack: SchemaPack,
): boolean {
  if (typeof relType !== "string" || relType.trim() === "") {
    throw new SchemaValidationError("Relation type must be a non-empty string");
  }

  const trimmed = relType.trim();
  if (pack.relationTypes && pack.relationTypes.length > 0) {
    if (!pack.relationTypes.includes(trimmed)) {
      throw new SchemaValidationError(
        `Unknown relation type "${trimmed}" in schema pack "${pack.name}"`,
      );
    }
  }

  return true;
}

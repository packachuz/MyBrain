import { parse, stringify } from "yaml";
import type { ZodType } from "zod";
import { normalizeLineEndings, sha256Hex } from "@mybrain/shared";
import { FenceTracker } from "./fence";

/**
 * Result of parsing a Markdown document containing optional YAML frontmatter.
 */
export interface ParsedMarkdownDocument<T = Record<string, unknown>> {
  frontmatter: T;
  body: string;
  contentHash: string;
}

/**
 * Parses a Markdown document with optional YAML frontmatter delimiter (`---`),
 * normalizing line endings to LF, validating frontmatter against an optional
 * Zod schema, and computing a platform-invariant SHA-256 digest of the full normalized document.
 */
export function parseMarkdownDocument<T = Record<string, unknown>>(
  raw: string,
  schema?: ZodType<T>,
): ParsedMarkdownDocument<T> {
  const normalized = normalizeLineEndings(raw);
  const contentHash = sha256Hex(normalized);

  const match = normalized.match(
    /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/,
  );

  let parsedYaml: unknown = {};
  let body = normalized;

  if (match) {
    const rawYaml = match[1] ?? "";
    const rawBody = match[2] ?? "";

    if (rawYaml.trim() === "") {
      parsedYaml = {};
    } else {
      try {
        parsedYaml = parse(rawYaml);
      } catch (err) {
        throw new Error(
          `Failed to parse frontmatter YAML: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;
  }

  let frontmatter: T;
  if (schema) {
    frontmatter = schema.parse(parsedYaml ?? {});
  } else {
    frontmatter = (
      parsedYaml && typeof parsedYaml === "object" && !Array.isArray(parsedYaml)
        ? parsedYaml
        : {}
    ) as T;
  }

  return {
    frontmatter,
    body,
    contentHash,
  };
}

/**
 * Serializes frontmatter and body into canonical Markdown with deterministic YAML formatting,
 * LF line endings, and sorted map keys to prevent platform or order drift.
 */
export function serializeMarkdownDocument<T extends Record<string, unknown>>(
  frontmatter: T,
  body: string = "",
): string {
  const normalizedBody = normalizeLineEndings(body);
  const yamlText =
    Object.keys(frontmatter).length === 0
      ? ""
      : stringify(frontmatter, { sortMapEntries: true }).trimEnd();

  const header = yamlText ? `---\n${yamlText}\n---\n` : `---\n---\n`;

  if (!normalizedBody) {
    return header;
  }

  return `${header}\n${normalizedBody.replace(/^\n+/, "")}`;
}

/**
 * Strips CommonMark fenced code blocks using shared FenceTracker.
 */
function stripFencedCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  const tracker = new FenceTracker();

  for (const line of lines) {
    const { insideFence } = tracker.processLine(line);
    if (!insideFence) {
      result.push(line);
    }
  }
  return result.join("\n");
}

/**
 * Strips inline code spans strictly within individual lines so orphan backticks
 * never match across newlines or paragraphs.
 */
function stripInlineCodeLineByLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(`+)(.*?)\1/g, ""))
    .join("\n");
}

/**
 * Extracts unique wikilinks (`[[target]]` or `[[target|alias]]`) from Markdown body text.
 * Ignores fenced code blocks (both ``` and ~~~) and inline code spans (`...`), trims target slugs,
 * and preserves first-seen order without duplicates.
 */
export function extractWikilinks(body: string): string[] {
  if (!body) {
    return [];
  }

  const normalized = normalizeLineEndings(body);
  const withoutFences = stripFencedCodeBlocks(normalized);
  const withoutInline = stripInlineCodeLineByLine(withoutFences);

  const matches = withoutInline.matchAll(/\[\[([^[\]|]+?)(?:\|[^[\]]*?)?\]\]/g);
  const result = new Set<string>();

  for (const m of matches) {
    const targetGroup = m[1];
    if (targetGroup) {
      const target = targetGroup.trim();
      if (target) {
        result.add(target);
      }
    }
  }

  return Array.from(result);
}

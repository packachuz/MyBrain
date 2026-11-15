import { describe, expect, it } from "bun:test";
import {
  PageFrontmatterSchema,
  sha256Hex,
  type PageFrontmatter,
} from "@mybrain/shared";
import {
  extractWikilinks,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  type ParsedMarkdownDocument,
} from "../src/markdown/frontmatter";
import {
  chunkMarkdown,
  type MarkdownChunk,
} from "../src/markdown/chunker";

describe("Markdown Frontmatter Serializer & Parser", () => {
  it("round-trips frontmatter and body with exact equality", () => {
    const frontmatter: PageFrontmatter = {
      id: "concept-pglite",
      slug: "concept/pglite",
      projectId: "default",
      title: "PGLite Embedded Postgres",
      type: "concept",
      schema: "gbrain-base",
      tags: ["database", "embedded", "postgres"],
      relations: [
        {
          target: "architecture/trust-engineering",
          type: "depends_on",
          weight: 1.0,
        },
      ],
      sources: ["https://pglite.dev"],
    };
    const body = `# PGLite Embedded Postgres\n\nPGLite is a WASM-compiled PostgreSQL engine running locally in-process.\n`;

    const serialized = serializeMarkdownDocument(frontmatter, body);
    expect(serialized).toContain("---\n");
    expect(serialized).toContain("id: concept-pglite\n");
    expect(serialized).toContain("title: PGLite Embedded Postgres\n");

    const parsed = parseMarkdownDocument(serialized, PageFrontmatterSchema);
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe(body);
    expect(parsed.contentHash).toBe(sha256Hex(serialized));

    // Idempotent re-serialization check (zero drift)
    const reSerialized = serializeMarkdownDocument(parsed.frontmatter, parsed.body);
    expect(reSerialized).toBe(serialized);
  });

  it("produces identical frontmatter, body, and contentHash across CRLF and LF (Review Focus #1)", () => {
    const lfDoc = [
      "---",
      "id: page-123",
      "title: Review Focus Spec",
      "type: concept",
      "tags:",
      "  - focus1",
      "  - crlf",
      "---",
      "",
      "# Review Focus Spec",
      "",
      "This document tests CRLF vs LF invariant hashing.",
      "",
    ].join("\n");

    const crlfDoc = lfDoc.replace(/\n/g, "\r\n");

    const parsedLf = parseMarkdownDocument(lfDoc);
    const parsedCrlf = parseMarkdownDocument(crlfDoc);

    // Frontmatter must be deeply equal
    expect(parsedCrlf.frontmatter).toEqual(parsedLf.frontmatter);

    // Body must be strictly equal (normalized to LF)
    expect(parsedCrlf.body).toBe(parsedLf.body);

    // contentHash must be identical
    expect(parsedCrlf.contentHash).toBe(parsedLf.contentHash);
    expect(parsedLf.contentHash).toBe(sha256Hex(lfDoc));
    expect(parsedCrlf.contentHash).toBe(sha256Hex(crlfDoc));

    // Serializing both parsed results produces identical canonical LF output
    const serializedLf = serializeMarkdownDocument(parsedLf.frontmatter, parsedLf.body);
    const serializedCrlf = serializeMarkdownDocument(
      parsedCrlf.frontmatter,
      parsedCrlf.body,
    );
    expect(serializedCrlf).toBe(serializedLf);
    expect(serializedLf.includes("\r")).toBe(false);
  });

  it("sorts keys deterministically in canonical YAML frontmatter serialization", () => {
    const unsortedFm1 = {
      zebra: "z",
      alpha: "a",
      nested: { beta: 2, alpha: 1 },
      middle: "m",
    };
    const unsortedFm2 = {
      alpha: "a",
      middle: "m",
      zebra: "z",
      nested: { alpha: 1, beta: 2 },
    };

    const s1 = serializeMarkdownDocument(unsortedFm1, "body");
    const s2 = serializeMarkdownDocument(unsortedFm2, "body");

    expect(s1).toBe(s2);
    // Keys in s1 should appear in deterministic alphabetical order
    const alphaIndex = s1.indexOf("alpha: a");
    const middleIndex = s1.indexOf("middle: m");
    const zebraIndex = s1.indexOf("zebra: z");
    expect(alphaIndex).toBeLessThan(middleIndex);
    expect(middleIndex).toBeLessThan(zebraIndex);
  });

  it("parses document without frontmatter cleanly", () => {
    const raw = "# Just Heading\n\nNo frontmatter in this file.\n";
    const parsed = parseMarkdownDocument(raw);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw);
    expect(parsed.contentHash).toBe(sha256Hex(raw));
  });

  it("parses document with empty frontmatter delimiter", () => {
    const raw = "---\n---\n\nBody after empty frontmatter.\n";
    const parsed = parseMarkdownDocument(raw);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Body after empty frontmatter.\n");
    expect(parsed.contentHash).toBe(sha256Hex(raw));
  });

  it("throws descriptive error on malformed YAML frontmatter", () => {
    const malformed = "---\n[malformed yaml: : invalid\n---\nBody";
    expect(() => parseMarkdownDocument(malformed)).toThrow(/YAML|frontmatter/i);
  });

  it("enforces Zod schema validation when schema is provided", () => {
    const invalidFmDoc = [
      "---",
      "id: 12345", // schema requires string, but even if string, missing required 'title' or 'type'
      "slug: test",
      "---",
      "body",
    ].join("\n");

    expect(() =>
      parseMarkdownDocument(invalidFmDoc, PageFrontmatterSchema),
    ).toThrow();
  });
});

describe("Wikilink Extractor", () => {
  it("extracts wikilinks with aliases, dedupes, and preserves first-seen order", () => {
    const body =
      "See [[architecture/trust-engineering|Trust]] and [[concept/pglite]] for details. " +
      "Also check [[architecture/trust-engineering|Trust Engineering]] again.";

    const links = extractWikilinks(body);
    expect(links).toEqual([
      "architecture/trust-engineering",
      "concept/pglite",
    ]);
  });

  it("trims whitespace from targets in wikilinks", () => {
    const body = "Read [[  concept/pglite  | PGLite DB ]] and [[  tools/sqlite  ]].";
    const links = extractWikilinks(body);
    expect(links).toEqual(["concept/pglite", "tools/sqlite"]);
  });

  it("ignores wikilinks inside backtick fenced code blocks", () => {
    const body = [
      "Here is a valid link [[valid/one]].",
      "```typescript",
      "// [[ignored/inside-code]]",
      "const link = '[[ignored/inside-code-2|Alias]]';",
      "```",
      "And another valid link [[valid/two|Two]].",
    ].join("\n");

    const links = extractWikilinks(body);
    expect(links).toEqual(["valid/one", "valid/two"]);
  });

  it("ignores wikilinks inside tilde fenced code blocks of varying lengths", () => {
    const body = [
      "~~~~markdown",
      "This is a nested markdown example with [[ignored/nested]].",
      "~~~~",
      "Outside tildes: [[outside/link]].",
    ].join("\n");

    const links = extractWikilinks(body);
    expect(links).toEqual(["outside/link"]);
  });

  it("ignores wikilinks inside inline code spans", () => {
    const body =
      "Normal [[target/valid]] link, but `[[ignored/inline]]` and " +
      "``[[ignored/double-backtick|Alias]]`` should be ignored.";

    const links = extractWikilinks(body);
    expect(links).toEqual(["target/valid"]);
  });

  it("ignores empty wikilink brackets and returns empty array when none found", () => {
    expect(extractWikilinks("[[]] and [[   ]] and [[|only-alias]]")).toEqual([]);
    expect(extractWikilinks("No links in this text.")).toEqual([]);
    expect(extractWikilinks("")).toEqual([]);
  });
});

describe("Heading-Aware Chunker", () => {
  it("preserves headingPath (# Top > ## Sub) for nested sections", () => {
    const body = [
      "# Top",
      "",
      "## Sub",
      "",
      "Some text under sub.",
    ].join("\n");

    const chunks = chunkMarkdown(body, { maxWords: 50, overlapWords: 10 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headingPath).toBe("# Top > ## Sub");
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.content).toContain("Some text under sub.");
  });

  it("emits [] for empty or whitespace-only bodies", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\t  \r\n  ")).toEqual([]);
  });

  it("validates maxWords and overlapWords options", () => {
    expect(() =>
      chunkMarkdown("Some text", { maxWords: 0, overlapWords: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkMarkdown("Some text", { maxWords: 50, overlapWords: -5 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkMarkdown("Some text", { maxWords: 50, overlapWords: 50 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkMarkdown("Some text", { maxWords: 50, overlapWords: 60 }),
    ).toThrow(RangeError);
  });

  it("tracks heading stack popping correctly across hierarchy levels", () => {
    const body = [
      "# Heading 1",
      "Content under H1.",
      "",
      "## Heading 2A",
      "Content under H2A.",
      "",
      "### Heading 3A",
      "Content under H3A.",
      "",
      "## Heading 2B",
      "Content under H2B (should pop H3A).",
      "",
      "# Heading 1B",
      "Content under H1B (should pop everything prior).",
    ].join("\n");

    const chunks = chunkMarkdown(body, { maxWords: 100, overlapWords: 10 });

    expect(chunks.length).toBe(5);
    expect(chunks[0]!.headingPath).toBe("# Heading 1");
    expect(chunks[1]!.headingPath).toBe("# Heading 1 > ## Heading 2A");
    expect(chunks[2]!.headingPath).toBe("# Heading 1 > ## Heading 2A > ### Heading 3A");
    expect(chunks[3]!.headingPath).toBe("# Heading 1 > ## Heading 2B");
    expect(chunks[4]!.headingPath).toBe("# Heading 1B");

    // Indexes are strictly ascending from 0
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i);
    }
  });

  it("ignores # characters inside fenced code blocks without corrupting headingPath", () => {
    const body = [
      "# Real Heading",
      "Leading text.",
      "```bash",
      "# this is a shell comment, NOT an H1",
      "echo '## not an H2 either'",
      "```",
      "Trailing text under real heading.",
    ].join("\n");

    const chunks = chunkMarkdown(body, { maxWords: 100, overlapWords: 10 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headingPath).toBe("# Real Heading");
    expect(chunks[0]!.content).toContain("# this is a shell comment");
  });

  it("performs sliding-window chunking with exact overlap when section exceeds maxWords", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    const body = `# Long Section\n\n${words.join(" ")}`;

    const chunks = chunkMarkdown(body, { maxWords: 50, overlapWords: 10 });

    // Step size = 50 - 10 = 40 words
    // Total words = 3 words in header ("# Long Section") + 120 words = 123 words
    // Chunk 0: words 0..50
    // Chunk 1: words 40..90
    // Chunk 2: words 80..123
    expect(chunks.length).toBe(3);

    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe("# Long Section");
      expect(chunk.wordCount).toBeGreaterThan(0);
      expect(chunk.wordCount).toBeLessThanOrEqual(50);
      expect(chunk.tokenCount).toBe(chunk.wordCount);
    }

    expect(chunks[0]!.wordCount).toBe(50);
    expect(chunks[1]!.wordCount).toBe(50);
    expect(chunks[2]!.wordCount).toBe(123 - 80); // 43 words

    // Check overlap between Chunk 0 and Chunk 1:
    // Words 40..49 must appear in both chunks
    const chunk0Words = chunks[0]!.content.split(/\s+/);
    const chunk1Words = chunks[1]!.content.split(/\s+/);
    const overlap0to1 = chunk0Words.slice(40, 50).join(" ");
    const startOfChunk1 = chunk1Words.slice(0, 10).join(" ");
    expect(startOfChunk1).toBe(overlap0to1);
  });

  it("assigns empty headingPath to documents without headings", () => {
    const body = "Just a standalone paragraph with no headings anywhere.\n";
    const chunks = chunkMarkdown(body);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headingPath).toBe("");
    expect(chunks[0]!.content).toBe(body.trim());
    expect(chunks[0]!.chunkIndex).toBe(0);
  });

  it("normalizes CRLF line endings before chunking", () => {
    const crlfBody = "# Windows File\r\n\r\nContent with CRLF line endings.\r\n";
    const chunks = chunkMarkdown(crlfBody);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headingPath).toBe("# Windows File");
    expect(chunks[0]!.content.includes("\r")).toBe(false);
  });
});

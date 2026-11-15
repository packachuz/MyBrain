import { normalizeLineEndings } from "@mybrain/shared";
import { FenceTracker } from "./fence";

/**
 * A discrete chunk of Markdown content indexed for full-text and vector search.
 */
export interface MarkdownChunk {
  chunkIndex: number;
  content: string;
  headingPath: string;
  wordCount: number;
  tokenCount: number;
}

/**
 * Options controlling sliding window size and overlap for Markdown chunking.
 */
export interface ChunkMarkdownOptions {
  maxWords?: number;
  overlapWords?: number;
}

/**
 * Splits Markdown body into heading-aware chunks with sliding window overlap.
 * Preserves the active heading hierarchy stack (`# H1 > ## H2 > ### H3`),
 * ignores `#` inside fenced code blocks, and emits `[]` for whitespace-only bodies.
 */
export function chunkMarkdown(
  body: string,
  opts?: ChunkMarkdownOptions,
): MarkdownChunk[] {
  if (!body || body.trim() === "") {
    return [];
  }

  const maxWords = opts?.maxWords ?? 450;
  if (maxWords <= 0) {
    throw new RangeError(
      `maxWords must be a positive integer, received ${maxWords}`,
    );
  }

  const overlapWords =
    opts?.overlapWords !== undefined
      ? opts.overlapWords
      : Math.min(60, Math.floor(maxWords / 4));

  if (overlapWords < 0) {
    throw new RangeError(
      `overlapWords cannot be negative, received ${overlapWords}`,
    );
  }
  if (overlapWords >= maxWords) {
    throw new RangeError(
      `overlapWords (${overlapWords}) must be strictly less than maxWords (${maxWords})`,
    );
  }

  const normalized = normalizeLineEndings(body);
  const lines = normalized.split("\n");

  const headingStack: { level: number; token: string }[] = [];
  const sections: { headingPath: string; lines: string[] }[] = [];

  const tracker = new FenceTracker();

  let currentHeadingPath = "";
  let currentLines: string[] = [];
  let sectionHasContent = false;

  for (const line of lines) {
    const { insideFence } = tracker.processLine(line);

    if (insideFence) {
      currentLines.push(line);
      sectionHasContent = true;
      continue;
    }

    // Check for heading outside code fence: # Title
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length;
      const cleanTitle = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
      const headingToken = `${headingMatch[1]} ${cleanTitle}`;

      if (sectionHasContent && currentLines.some((l) => l.trim() !== "")) {
        sections.push({
          headingPath: currentHeadingPath,
          lines: currentLines,
        });
        currentLines = [];
        sectionHasContent = false;
      }

      // Pop headings with level >= new heading level
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, token: headingToken });
      currentHeadingPath = headingStack.map((h) => h.token).join(" > ");

      currentLines.push(line);
      continue;
    }

    // Normal line outside code fence
    currentLines.push(line);
    if (line.trim() !== "") {
      sectionHasContent = true;
    }
  }

  if (currentLines.some((l) => l.trim() !== "")) {
    sections.push({
      headingPath: currentHeadingPath,
      lines: currentLines,
    });
  }

  const chunks: MarkdownChunk[] = [];
  let chunkIndex = 0;
  const step = maxWords - overlapWords;

  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    if (!text) continue;

    const wordMatches = Array.from(text.matchAll(/\S+/g));
    if (wordMatches.length === 0) continue;

    if (wordMatches.length <= maxWords) {
      chunks.push({
        chunkIndex: chunkIndex++,
        content: text,
        headingPath: sec.headingPath,
        wordCount: wordMatches.length,
        tokenCount: wordMatches.length,
      });
      continue;
    }

    // Sliding window over words in this section
    for (let i = 0; i < wordMatches.length; i += step) {
      const startWord = i;
      const endWordIndex = Math.min(i + maxWords, wordMatches.length);
      const startWordMatch = wordMatches[startWord];
      const lastWord = wordMatches[endWordIndex - 1];
      if (!startWordMatch || !lastWord) {
        break;
      }
      const startIndex = startWordMatch.index;
      const endIndex = lastWord.index + lastWord[0].length;

      const chunkContent = text.slice(startIndex, endIndex);
      const count = endWordIndex - startWord;

      chunks.push({
        chunkIndex: chunkIndex++,
        content: chunkContent,
        headingPath: sec.headingPath,
        wordCount: count,
        tokenCount: count,
      });

      if (endWordIndex >= wordMatches.length) {
        break;
      }
    }
  }

  return chunks;
}

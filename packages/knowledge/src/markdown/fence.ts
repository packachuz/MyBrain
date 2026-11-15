/**
 * Information extracted from a candidate fenced code block delimiter line.
 */
export interface FenceLineInfo {
  isFence: boolean;
  char: string;
  length: number;
  hasTrailingText: boolean;
}

/**
 * Parses a line according to CommonMark code fence rules:
 * - Up to 3 leading spaces of indentation
 * - At least 3 backticks (```) or 3 tildes (~~~)
 * - Captures the fence character, count, and any trailing content (info string)
 */
export function parseFenceLine(line: string): FenceLineInfo | null {
  const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || !match[1]) {
    return null;
  }
  const fenceStr = match[1];
  const rest = match[2] ?? "";
  return {
    isFence: true,
    char: fenceStr[0] ?? "",
    length: fenceStr.length,
    hasTrailingText: rest.trim().length > 0,
  };
}

/**
 * Stateful tracker that monitors line-by-line whether Markdown content is inside
 * a CommonMark fenced code block.
 *
 * CommonMark rules enforced:
 * - Opening fence can have an optional info string (e.g. ```typescript).
 * - Closing fence must use the same character (backtick or tilde), must be at least
 *   as long as the opening fence, and must NOT contain any trailing non-whitespace
 *   characters (rest.trim().length === 0).
 */
export class FenceTracker {
  private inFence = false;
  private fenceChar = "";
  private fenceLen = 0;

  public isInFence(): boolean {
    return this.inFence;
  }

  /**
   * Processes a line, updates internal fence state, and returns whether
   * the line is inside a fenced block.
   */
  public processLine(line: string): {
    insideFence: boolean;
    isOpeningFence: boolean;
    isClosingFence: boolean;
  } {
    const fence = parseFenceLine(line);

    if (!this.inFence) {
      if (fence) {
        this.inFence = true;
        this.fenceChar = fence.char;
        this.fenceLen = fence.length;
        return {
          insideFence: true,
          isOpeningFence: true,
          isClosingFence: false,
        };
      }
      return {
        insideFence: false,
        isOpeningFence: false,
        isClosingFence: false,
      };
    }

    // Inside an active fence
    if (
      fence &&
      fence.char === this.fenceChar &&
      fence.length >= this.fenceLen &&
      !fence.hasTrailingText
    ) {
      // Closing fence matches character, minimum length, and has ZERO trailing non-whitespace text
      this.inFence = false;
      this.fenceChar = "";
      this.fenceLen = 0;
      return {
        insideFence: true,
        isOpeningFence: false,
        isClosingFence: true,
      };
    }

    // Still inside fence (including lines with ```foo which cannot close a fence in CommonMark)
    return {
      insideFence: true,
      isOpeningFence: false,
      isClosingFence: false,
    };
  }
}

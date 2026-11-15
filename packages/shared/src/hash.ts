import { createHash } from "node:crypto";

/**
 * Normalizes line endings across platforms by converting CRLF (\r\n) and CR (\r) into LF (\n).
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Computes a deterministic SHA-256 hex digest after normalizing all line endings to LF.
 * Ensures consistent content hashing across Windows (CRLF) and POSIX (LF).
 */
export function sha256Hex(content: string): string {
  const normalized = normalizeLineEndings(content);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

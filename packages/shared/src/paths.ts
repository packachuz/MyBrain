import path from "node:path";

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

/**
 * Sanitize an arbitrary title, label or concept string into a clean URL-safe slug.
 * E.g. "Concept / Trust & Verify!" -> "concept-trust-and-verify"
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Safely resolves path segments within a designated vault root.
 * Blocks directory traversal (e.g. `..`), absolute paths, and Windows drive injection.
 *
 * @throws {VaultPathError} If any segment attempts to escape or inject paths outside `vaultRoot`.
 */
export function resolveSafeVaultPath(
  vaultRoot: string,
  ...segments: string[]
): string {
  if (!vaultRoot || typeof vaultRoot !== "string") {
    throw new VaultPathError("Invalid vaultRoot: must be a non-empty string");
  }

  const normalizedRoot = path.resolve(vaultRoot);

  for (const seg of segments) {
    if (typeof seg !== "string") {
      throw new VaultPathError(`Invalid path segment: expected string, received ${typeof seg}`);
    }
    if (seg.includes("\0")) {
      throw new VaultPathError(`Invalid null byte detected in path segment: ${seg}`);
    }
    // Block drive letter injection (e.g. C:\Windows or C:foo)
    if (/^[a-zA-Z]:/.test(seg)) {
      throw new VaultPathError(`Absolute drive path not allowed in segment: ${seg}`);
    }
    // Block leading slash / backslash indicating root-relative or absolute path
    if (seg.startsWith("/") || seg.startsWith("\\") || path.isAbsolute(seg)) {
      throw new VaultPathError(`Absolute path not allowed in segment: ${seg}`);
    }
  }

  const resolved = path.resolve(normalizedRoot, ...segments);
  const relative = path.relative(normalizedRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VaultPathError(
      `Resolved path '${resolved}' escapes vault root '${normalizedRoot}'`,
    );
  }

  return resolved;
}

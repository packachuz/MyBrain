import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireVaultLock, isPidAlive, VaultLockError } from "../src/lockfile";
import { normalizeLineEndings, sha256Hex } from "../src/hash";
import { resolveSafeVaultPath, sanitizeSlug, VaultPathError } from "../src/paths";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe("paths, hashing, and lockfile", () => {
  test("sha256Hex treats CRLF and LF identically", () => {
    expect(sha256Hex("a\r\nb\r\nc")).toBe(sha256Hex("a\nb\nc"));
    expect(normalizeLineEndings("line1\r\nline2\rline3\n")).toBe("line1\nline2\nline3\n");
  });

  test("resolveSafeVaultPath blocks traversal and drive injection", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-path-"));
    dirs.push(root);
    expect(() => resolveSafeVaultPath(root, "..", "secrets.md")).toThrow(VaultPathError);
    expect(() => resolveSafeVaultPath(root, "pages", "C:\\Windows\\win.ini")).toThrow(VaultPathError);
    expect(() => resolveSafeVaultPath(root, "pages", "/etc/passwd")).toThrow(VaultPathError);
    expect(sanitizeSlug("Concept / Trust & Verify!")).toBe("concept-trust-and-verify");

    const valid = resolveSafeVaultPath(root, "pages", "concept", "intro.md");
    expect(valid.startsWith(path.resolve(root))).toBe(true);
  });

  test("isPidAlive correctly identifies live and dead PIDs", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(99999999)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  test("acquireVaultLock blocks live PID and reclaims dead PID lock", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-lock-"));
    dirs.push(root);
    const lockPath = path.join(root, "daemon.lock");
    const handle = await acquireVaultLock(lockPath);
    expect(handle.pid).toBe(process.pid);
    await expect(acquireVaultLock(lockPath)).rejects.toThrow(VaultLockError);
    await handle.release();

    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const reclaimed = await acquireVaultLock(lockPath);
    await reclaimed.release();
  });
});

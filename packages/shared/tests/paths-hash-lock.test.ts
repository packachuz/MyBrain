import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(typeof handle.lockId).toBe("string");
    await expect(acquireVaultLock(lockPath)).rejects.toThrow(VaultLockError);
    await handle.release();

    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, lockId: "stale-1", acquiredAt: new Date().toISOString() }));
    const reclaimed = await acquireVaultLock(lockPath);
    await reclaimed.release();
  });

  test("Finding 1: reclaims abandoned empty lockfile after retry confirmation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-lock-empty-"));
    dirs.push(root);
    const lockPath = path.join(root, "daemon.lock");
    // Write an empty lockfile (simulating crash during unbuffered create)
    writeFileSync(lockPath, "");

    const handle = await acquireVaultLock(lockPath);
    expect(handle.pid).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(true);
    await handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("Finding 1: concurrent contenders on stale dead-PID lock - exactly one wins, winner lock not unlinked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-lock-concurrent-"));
    dirs.push(root);
    const lockPath = path.join(root, "daemon.lock");

    // Pre-populate with dead PID
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, lockId: "dead-token", acquiredAt: new Date().toISOString() }),
    );

    // Concurrently attempt to acquire
    const results = await Promise.allSettled([
      acquireVaultLock(lockPath),
      acquireVaultLock(lockPath),
      acquireVaultLock(lockPath),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(VaultLockError);
    }

    // Verify winner still has exclusive ownership
    const winnerHandle = fulfilled[0]!.value;
    expect(existsSync(lockPath)).toBe(true);
    const currentOnDisk = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(currentOnDisk.lockId).toBe(winnerHandle.lockId);
    expect(currentOnDisk.pid).toBe(process.pid);

    await winnerHandle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("Finding 2: release() only unlinks when handle lockId and PID match on disk", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mb-lock-release-safe-"));
    dirs.push(root);
    const lockPath = path.join(root, "daemon.lock");

    const handle = await acquireVaultLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // Simulate foreign lockfile replacement (different lockId or PID)
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 88888888, lockId: "foreign-lock-id", acquiredAt: new Date().toISOString() }),
    );

    // Call release on our handle: MUST NOT unlink the foreign lockfile
    await handle.release();
    expect(existsSync(lockPath)).toBe(true);
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(content.lockId).toBe("foreign-lock-id");

    // Also verify corrupt/unparseable lockfile is not unlinked by release()
    writeFileSync(lockPath, "unparseable garbage content");
    await handle.release();
    expect(existsSync(lockPath)).toBe(true);
  });
});

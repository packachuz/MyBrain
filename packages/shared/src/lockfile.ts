import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class VaultLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultLockError";
  }
}

export interface VaultLockHandle {
  lockPath: string;
  pid: number;
  lockId: string;
  acquiredAt: string;
  release(): Promise<void>;
}

interface LockPayload {
  lockId: string;
  pid: number;
  acquiredAt: string;
}

/**
 * Checks whether a process with the given PID is currently alive.
 * On Windows & POSIX, `process.kill(pid, 0)` checks for process existence without sending a signal.
 * Throws ESRCH if process is dead; returns normally or throws EPERM if process is alive.
 */
export function isPidAlive(pid: number): boolean {
  if (
    typeof pid !== "number" ||
    Number.isNaN(pid) ||
    pid <= 0 ||
    !Number.isInteger(pid)
  ) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Attempts to read and parse the lock payload.
 * If the file is empty or unparseable, retries briefly before returning null
 * so that concurrent writers are given a brief window to finish writing their payload.
 */
async function readLockPayload(
  resolvedPath: string,
  readRetries = 5,
  delayMs = 25,
): Promise<LockPayload | null> {
  for (let attempt = 0; attempt < readRetries; attempt++) {
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      if (raw.trim().length === 0) {
        if (attempt < readRetries - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<LockPayload>;
      if (typeof parsed.pid === "number") {
        return {
          lockId: typeof parsed.lockId === "string" ? parsed.lockId : "",
          pid: parsed.pid,
          acquiredAt:
            typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
        };
      }
      return null;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") {
        return null;
      }
      if (attempt < readRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Atomically creates the lockfile with payload already written.
 * Uses a temp file + hard link (fs.link) in the same directory so the target lockfile
 * is never exposed with 0 bytes or partial content to concurrent readers.
 * Falls back to writeFile with flag "wx" if fs.link is not supported by the filesystem.
 */
async function createLockfileAtomically(
  resolvedPath: string,
  payload: LockPayload,
): Promise<void> {
  const dir = path.dirname(resolvedPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const data = JSON.stringify(payload, null, 2);

  try {
    await fs.writeFile(tempPath, data, "utf8");
    try {
      await fs.link(tempPath, resolvedPath);
    } catch (linkErr: unknown) {
      const code = (linkErr as { code?: string })?.code;
      if (code === "EEXIST") {
        throw linkErr;
      }
      // Filesystem fallback if hardlinks not supported
      await fs.writeFile(resolvedPath, data, { flag: "wx" });
    }
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {}
  }
}

/**
 * Reclaims a stale lockfile by atomically renaming it away to a unique temporary name.
 * If another contender already renamed or removed it, fs.rename fails with ENOENT safely.
 */
async function reclaimStaleLock(resolvedPath: string): Promise<boolean> {
  const dir = path.dirname(resolvedPath);
  const staleTmpPath = path.join(
    dir,
    `.${path.basename(resolvedPath)}.stale.${process.pid}.${Date.now()}.${randomUUID()}`,
  );

  try {
    await fs.rename(resolvedPath, staleTmpPath);
  } catch (renameErr: unknown) {
    const code = (renameErr as { code?: string })?.code;
    if (code === "ENOENT") {
      return true;
    }
    return false;
  }

  try {
    await fs.unlink(staleTmpPath);
  } catch {}

  return true;
}

/**
 * Acquires an advisory vault lockfile.
 * Uses atomic hardlink creation (O_CREAT | O_EXCL equivalent with pre-written payload).
 * If the lockfile already exists, inspects the recording PID:
 * - If the PID is still alive, rejects with VaultLockError.
 * - If the PID is dead or file is permanently stale, safely reclaims by renaming away.
 */
export async function acquireVaultLock(
  lockPath: string,
  maxRetries = 10,
  retryDelayMs = 25,
): Promise<VaultLockHandle> {
  const resolvedPath = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  const lockId = randomUUID();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquiredAt = new Date().toISOString();
    const payload: LockPayload = {
      lockId,
      pid: process.pid,
      acquiredAt,
    };

    try {
      await createLockfileAtomically(resolvedPath, payload);

      let released = false;
      const handle: VaultLockHandle = {
        lockPath: resolvedPath,
        pid: process.pid,
        lockId,
        acquiredAt,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const raw = await fs.readFile(resolvedPath, "utf8");
            const parsed = JSON.parse(raw) as Partial<LockPayload>;
            // Only unlink when confirmed to belong to this exact handle token and PID
            if (parsed.pid === process.pid && parsed.lockId === lockId) {
              await fs.unlink(resolvedPath);
            }
          } catch {
            // NEVER unlink on read/parse error or foreign lockfile ownership
          }
        },
      };

      return handle;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      // Lockfile exists: read payload with retries to handle any in-flight writers
      const existing = await readLockPayload(resolvedPath);

      if (existing !== null && isPidAlive(existing.pid)) {
        throw new VaultLockError(
          `Vault lock at '${resolvedPath}' is already held by live PID ${existing.pid} (acquired at ${existing.acquiredAt || "unknown"})`,
        );
      }

      // Re-verify that existing lock is STILL dead before attempting to rename away
      const recheck = await readLockPayload(resolvedPath, 2, 10);
      if (recheck !== null && isPidAlive(recheck.pid)) {
        throw new VaultLockError(
          `Vault lock at '${resolvedPath}' is already held by live PID ${recheck.pid} (acquired at ${recheck.acquiredAt || "unknown"})`,
        );
      }

      // Reclaim stale lock by atomically renaming it away
      await reclaimStaleLock(resolvedPath);

      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  throw new VaultLockError(
    `Failed to acquire vault lock at '${resolvedPath}' after ${maxRetries} attempts`,
  );
}

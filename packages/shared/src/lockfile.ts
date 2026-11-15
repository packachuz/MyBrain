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
  acquiredAt: string;
  release(): Promise<void>;
}

interface LockPayload {
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
 * Acquires an advisory lockfile using O_EXCL (flag "wx").
 * If the lockfile already exists, inspects the recording PID:
 * - If the PID is still alive, rejects with VaultLockError.
 * - If the PID is dead or file is stale/corrupt, unlinks and reclaims the lock.
 */
export async function acquireVaultLock(
  lockPath: string,
  maxRetries = 5,
): Promise<VaultLockHandle> {
  const resolvedPath = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquiredAt = new Date().toISOString();
    const payload: LockPayload = {
      pid: process.pid,
      acquiredAt,
    };

    try {
      await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2), {
        flag: "wx",
      });

      let released = false;
      const handle: VaultLockHandle = {
        lockPath: resolvedPath,
        pid: process.pid,
        acquiredAt,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const raw = await fs.readFile(resolvedPath, "utf8");
            const parsed = JSON.parse(raw) as LockPayload;
            if (parsed.pid === process.pid) {
              await fs.unlink(resolvedPath);
            }
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code !== "ENOENT") {
              try {
                await fs.unlink(resolvedPath);
              } catch {}
            }
          }
        },
      };

      return handle;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      // Lockfile exists: read existing PID
      let stale = false;
      let existingPid: number | undefined;
      let existingAcquiredAt: string | undefined;

      try {
        const raw = await fs.readFile(resolvedPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<LockPayload>;
        existingPid = parsed.pid;
        existingAcquiredAt = parsed.acquiredAt;

        if (typeof existingPid === "number" && isPidAlive(existingPid)) {
          throw new VaultLockError(
            `Vault lock at '${resolvedPath}' is already held by live PID ${existingPid} (acquired at ${existingAcquiredAt ?? "unknown"})`,
          );
        } else {
          stale = true;
        }
      } catch (readErr: unknown) {
        if (readErr instanceof VaultLockError) {
          throw readErr;
        }
        // If file disappeared or is corrupt JSON, treat as stale
        stale = true;
      }

      if (stale) {
        try {
          await fs.unlink(resolvedPath);
        } catch (unlinkErr: unknown) {
          const uCode = (unlinkErr as { code?: string })?.code;
          if (uCode !== "ENOENT") {
            // Wait briefly before retrying
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      }
    }
  }

  throw new VaultLockError(
    `Failed to acquire vault lock at '${resolvedPath}' after ${maxRetries} attempts`,
  );
}

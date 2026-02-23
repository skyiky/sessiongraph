import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";

/**
 * Simple filesystem lock using O_EXCL for atomic creation.
 * Stores the current PID inside so stale locks from dead processes
 * can be detected and cleaned up.
 */

export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileError";
  }
}

/**
 * Acquire a lockfile. Returns a release function.
 * Throws LockfileError if the lock is held by a live process.
 */
export function acquireLock(lockPath: string): () => void {
  const pid = process.pid.toString();

  if (existsSync(lockPath)) {
    const existingPid = readLockPid(lockPath);
    if (existingPid !== null && isProcessAlive(existingPid)) {
      throw new LockfileError(
        `Another SessionGraph process (PID ${existingPid}) is using the database. ` +
        `If this is wrong, delete ${lockPath} and try again.`
      );
    }
    // Stale lock from dead process — remove it
    try { unlinkSync(lockPath); } catch {}
  }

  try {
    writeFileSync(lockPath, pid, { flag: "wx" }); // wx = O_CREAT | O_EXCL
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockfileError(
        "Another SessionGraph process just acquired the database lock. " +
        `If this is wrong, delete ${lockPath} and try again.`
      );
    }
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(lockPath); } catch {}
  };
}

function readLockPid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
